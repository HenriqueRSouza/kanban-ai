# Experimentos — roteiro e resultados observados

Roteiro para reproduzir cada comportamento exigido no enunciado, com o que foi
observado nas execuções de 27/11/2026 (MacBook Apple Silicon, Docker Desktop com
10 CPUs e 8 GB, minikube com driver docker). A arquitetura está em
[`ARQUITETURA.md`](ARQUITETURA.md).

**Dica para a demonstração:** todo pedido aceita o cabeçalho `X-Request-Id`. Usar
um valor conhecido (ex.: `demo-1`) facilita seguir a operação nos logs.

Variáveis usadas nos comandos abaixo (a coluna padrão do quadro de exemplo):

```bash
COL=00000000-0000-4000-8000-000000000002
pedido() {  # pedido <X-Request-Id> <porta>
  curl -s -X POST "localhost:${2:-8080}/api/ai/jobs" -H 'Content-Type: application/json' -H "X-Request-Id: $1" \
    -d "{\"input\":\"Como usuário quero imprimir o quadro ($1)\",\"targetColumnId\":\"$COL\",\"idempotencyKey\":\"$(uuidgen | tr A-Z a-z)\",\"maxCards\":3}"
}
```

---

## Etapa 1 — Docker Compose

```bash
cp .env.example .env
docker compose up --build -d        # http://localhost:8080
```

### 1.1 Entrada única e isolamento da rede

```bash
docker compose ps --format '{{.Service}}: {{.Ports}}'
curl localhost:8080/api/health      # pelo NGINX: funciona
curl -m3 localhost:3000/api/health  # direto na API: não conecta
```

Observado:

```
api: 3000/tcp                         ← porta só interna
db: 5432/tcp
nginx: 0.0.0.0:8080->80/tcp           ← única porta publicada
ollama: 11434/tcp
rabbitmq: 5671-5672/tcp, 15671-15672/tcp, …
worker: 8080/tcp
nginx localhost:8080/api/health → {"ok":true}
api direto localhost:3000       → sem conexão
rabbitmq direto localhost:5672  → fechado
redes: nginx=edge | api=edge internal | worker=internal
```

A e B não se conhecem: `docker compose config` não tem nenhuma variável do
worker apontando para a API nem o contrário (o worker só tem `RABBITMQ_URL` e as
variáveis do LLM).

### 1.2 Fluxo de uma operação seguido pelo correlationId

```bash
pedido demo-1
docker compose logs --no-log-prefix nginx api worker | grep '"demo-1"'
```

Observado (job concluído em ~2 s):

```
03:58:33       nginx   http.received        ← chegada ao ponto de entrada
03:58:33.996Z  api     http.received        ← Serviço A recebe
03:58:33.998Z  api     job.created          ← grava o job (pending_publish)
03:58:34.002Z  api     msg.published        ← publica no RabbitMQ (confirmado)
03:58:34.001Z  worker  msg.consumed         ← Serviço B recebe pela fila
03:58:34.004Z  api     result.consumed      ← evento "generation_started" → processing
03:58:36.195Z  worker  llm.done             ← modelo respondeu
03:58:36.199Z  worker  result.published     ← resultado publicado na fila
03:58:36.207Z  api     result.consumed      ← A grava os cartões → succeeded
```

### 1.3 Falha controlada: Serviço B parado

```bash
docker compose stop worker
pedido parado-1; pedido parado-2; pedido parado-3        # A continua respondendo 202
docker compose exec rabbitmq rabbitmqctl list_queues name messages
docker compose start worker
docker compose exec rabbitmq rabbitmqctl list_queues name messages
```

Observado:

```
[01:02:46] worker: exited
[01:02:49] 3 pedidos aceitos (HTTP 202) | fila ai.generate = 3
[01:02:50] worker iniciado
04:02:52  compose-parado-1  durationMs=1034
04:02:53  compose-parado-2  durationMs=1463
04:02:55  compose-parado-3  durationMs=1498
          fila ai.generate = 0, os 3 jobs succeeded
```

**Explicação.** Com B parado, A não percebe nada: ele só depende do broker, então
continua aceitando pedidos e publicando. As mensagens ficam na fila `ai.generate`
porque ela é **durável** (quorum, gravada em disco) e as mensagens são
**persistentes**; ninguém as consome porque não há consumidor. Quando B volta, ele
se registra como consumidor e o RabbitMQ entrega as pendentes, uma por vez
(`prefetch=1`). Como B só dá **ack** depois de publicar o resultado (e o broker
confirmar), uma queda de B no meio de um job faz a mensagem voltar para a fila em
vez de se perder.

### 1.4 Desligamento gracioso

`docker compose stop worker api` levou 0,37 s; os dois serviços registraram
`{"event":"shutdown","signal":"SIGTERM"}`. O `node` é o processo principal do
container (sem `npm`/`tsx watch` no meio), então recebe o sinal direto, termina
o job em andamento e fecha as conexões.

---

## Etapa 2 — Kubernetes

```bash
docker compose down                 # libera memória para o minikube
./scripts/k8s-up.sh                 # do zero: ~8,5 min (inclui o build das imagens)
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 8090:80   # outro terminal
```

### 2.1 Recursos e entrada única

```bash
kubectl -n taskflow get deploy,sts,svc,ingress
```

Observado:

```
deployment.apps/api      2/2     kanban-ai/api:local
deployment.apps/web      1/1     kanban-ai/web:local
deployment.apps/worker   2/2     kanban-ai/worker:local
statefulset.apps/postgres   1/1
statefulset.apps/rabbitmq   1/1
service/api        ClusterIP   3000/TCP
service/postgres   ClusterIP   None        (headless)
service/rabbitmq   ClusterIP   5672/TCP,15672/TCP
service/web        ClusterIP   80/TCP
ingress.networking.k8s.io/taskflow   nginx   *   80
```

Nenhum Service da aplicação é `NodePort` ou `LoadBalancer`: a única entrada é o
Ingress (`/` → web, `/api` → api). No sidecar do worker:
`modelo qwen3:1.7b configurado com 2 threads`.

### 2.2 Fluxo pelo Ingress

`pedido demo-2 8090` → `202`, job `succeeded` em 19 s. O mesmo id aparece no log
do Ingress Controller, em `http.received / job.created / msg.published /
result.consumed` de uma réplica da API e em `msg.consumed / llm.done /
result.published` do pod `worker-57d65dc446-k4qn2`. A API que publicou e a que
consumiu o resultado foram réplicas diferentes: qualquer uma atende.

### 2.3 Consumidor parado + restart do RabbitMQ (persistência)

```bash
kubectl -n taskflow scale deploy/worker --replicas=0
pedido falha-1 8090; pedido falha-2 8090; pedido falha-3 8090
kubectl -n taskflow exec rabbitmq-0 -- rabbitmqctl list_queues name messages
kubectl -n taskflow delete pod rabbitmq-0          # o StatefulSet recria com o mesmo volume
kubectl -n taskflow exec rabbitmq-0 -- rabbitmqctl list_queues name messages
kubectl -n taskflow scale deploy/worker --replicas=2
```

Observado:

```
[00:03:58] workers: 0 pods; 3 pedidos → HTTP 202
[00:04:02] fila ai.generate = 3
[00:04:02] apagando o pod do RabbitMQ
[00:04:15] RabbitMQ de volta; fila ai.generate = 3     ← mensagens sobreviveram (PVC)
[00:04:30] as 2 réplicas da API reconectaram sozinhas (broker.connected)
[00:04:31] workers religados (2)
[00:05:11] fila = 0; jobs succeeded=4
           falha-1 e falha-3 → worker-…-sjnnj, falha-2 → worker-…-zrp26
```

Um teste adicional derrubou o RabbitMQ **antes** de enviar os pedidos: a API
respondeu `202` mesmo sem broker (jobs `pending_publish`), reconectou quando ele
voltou e o *outbox* publicou os 3.

### 2.4 Self-healing

```bash
kubectl -n taskflow get pods -l app=worker
kubectl -n taskflow delete pod <um-pod-worker>
kubectl -n taskflow get pods -l app=worker -w
```

Observado:

```
[00:05:16] kubectl delete pod/worker-57d65dc446-sjnnj
[00:05:19] READY=1/2 | worker-…-mr7pm (0/2, Init) worker-…-sjnnj (Terminating) worker-…-zrp26 (Running)
[00:05:29] READY=1/2 | worker-…-mr7pm (1/2, Running)    ← Ollama pronto, worker subindo
[00:05:36] READY=2/2 | worker-…-mr7pm (2/2) worker-…-zrp26 (2/2)
evento: replicaset/worker-57d65dc446  SuccessfulCreate  Created pod: worker-57d65dc446-mr7pm
```

O Deployment declara 2 réplicas; o controlador do ReplicaSet percebe que o estado
observado (1) difere do desejado (2) e cria um pod novo em ~20 s. Ninguém
precisou intervir, e o Service/Ingress nunca dependeu daquele pod específico.

### 2.5 Escala manual (escalabilidade horizontal)

```bash
kubectl -n taskflow scale deploy/worker --replicas=1    # envie alguns pedidos
kubectl -n taskflow scale deploy/worker --replicas=2    # envie mais pedidos
kubectl -n taskflow logs -l app=worker -c worker | grep llm.done
```

Observado: com 1 réplica, todos os pedidos da fase 1 foram processados por
`worker-57d65dc446-d8rps`; depois de escalar para 2, a fase 2 foi dividida entre
`worker-57d65dc446-d8rps` e o pod novo `worker-57d65dc446-bt676`. Os consumidores
competem pela mesma fila (*work queue*): cada mensagem vai para um só worker.

> **Limite de memória.** Cada réplica do worker usa ~2 GB (o modelo fica carregado
> na memória). Num teste com **3** réplicas em um Docker de 8 GB, o nó ficou sem
> memória (swap cheio), o servidor da API do Kubernetes parou de responder e os
> pods reiniciaram. Por isso o roteiro usa 1 ↔ 2 réplicas e o HPA tem máximo 2.
> Com 12 GB ou mais para o Docker, dá para usar 3.

Efeito colateral desse teste: um job cujo worker morreu em todas as entregas foi
parar na DLQ pelo próprio RabbitMQ (`x-delivery-limit`) sem nenhum evento de
falha, e ficava "Processando" para sempre. A API passou a consumir a
`ai.generate.dlq` e marcar esses jobs como `failed` (log `job.dead_lettered`).

---

## Etapa 3 — Elasticidade (HPA)

```bash
kubectl apply -f k8s/autoscaling/hpa.yaml
kubectl -n taskflow get hpa worker -w          # outro terminal
./scripts/load.sh 20                           # Windows: .\scripts\load.ps1 20
```

O `load.sh` cria um Job dentro do cluster que envia os pedidos **pelo Ingress**,
como um cliente externo. O HPA usa a CPU do pod em relação ao `requests` (1 CPU
do Ollama + 50m do worker), alvo 60 %, mínimo 1 e máximo 2.

Observado (eventos do HPA, `kubectl -n taskflow describe hpa worker`):

```
00:29:52  HPA criado com 2 réplicas em execução, CPU 0 %
~00:30:53 New size: 1; reason: All metrics below target            ← ocioso: reduz ao mínimo
00:30:58  load.done: 20 pedidos enviados, 20 aceitos; fila = 20
~00:31:53 New size: 2; reason: cpu resource utilization (percentage of request) above target
00:31:22 → 00:33:28  fila 17 → 12 → 10 → 6 → 1 → 0 (com 2 pods a partir de ~00:32:10)
00:35:40  New size: 1; reason: All metrics below target            ← sem carga: volta ao mínimo
jobs: todos succeeded
```

**Por que funciona.** A inferência roda no sidecar Ollama, dentro do pod do
worker. Fila cheia = o pod gerando texto sem parar = CPU alta de verdade (bem
acima de 60 % do `requests`), e o HPA cria réplicas; os pods novos se registram
como consumidores e passam a dividir a fila. Fila vazia = CPU perto de zero, e
depois da janela de estabilização (60 s) o HPA remove réplicas, uma a cada 30 s.

**Escalabilidade × elasticidade.** Na etapa 2.5 a quantidade de réplicas mudou
porque alguém executou `kubectl scale` (escalabilidade horizontal: a arquitetura
*permite* mais instâncias). Aqui ela mudou sozinha em função da demanda, para
cima e para baixo (elasticidade: o ambiente *provisiona e libera* recursos
automaticamente, uma das características essenciais da nuvem segundo o NIST
SP 800-145).

**Limitação.** A métrica é indireta: CPU, não tamanho da fila. Ela funciona porque
o trabalho do Serviço B é CPU-bound dentro do pod. Com o LLM fora do cluster (LM
Studio/OpenRouter), o worker só esperaria HTTP e o HPA não reagiria; o caminho
seria escalar pela fila (KEDA com o *scaler* de RabbitMQ), a atividade avançada
do enunciado.

---

## Problemas encontrados durante os testes (e corrigidos)

| Sintoma | Causa | Correção |
|---|---|---|
| Após o restart do RabbitMQ, a API nunca mais publicava (jobs `pending_publish` para sempre) | O `connect()` do amqplib não tinha timeout; a primeira reconexão pegava o broker desligando e ficava pendurada | `timeout: 10_000` na conexão da API e do worker |
| Job com timeout do LLM em laço infinito (sempre "tentativa 1") | No RabbitMQ 4, `nack` com requeue não incrementa o `x-delivery-count` das filas quorum | O worker republica com o cabeçalho `x-taskflow-attempt` e desiste na 3ª tentativa |
| Geração a ~0,1–0,4 token/s (timeout de 120 s) | O Ollama abre uma thread por núcleo visível: estrangulado pelo limite de CPU no Kubernetes e lento nos núcleos de eficiência do Mac | `OLLAMA_NUM_THREADS` (4 no Compose, 2 no Kubernetes, igual ao limite de CPU); medido: 10 threads = 0,39 token/s, 4 threads = 43 tokens/s |
| 3 réplicas do worker travaram o cluster | Sem memória num Docker de 8 GB | Máximo de 2 réplicas (HPA e roteiro) |
| Job "Processando" para sempre depois de quedas repetidas do worker | O RabbitMQ manda para a DLQ sozinho, sem evento de falha | A API consome a `ai.generate.dlq` e marca o job `failed` |
| Reexecutar o `k8s-up` não atualizava os pods | Tag `:local` igual, manifesto igual | `rollout restart` quando a aplicação já existe |
| `nginx` sempre `unhealthy` no Compose | Healthcheck em `localhost` = `::1` (IPv6); o NGINX escuta só em IPv4 | Healthcheck em `127.0.0.1` |
