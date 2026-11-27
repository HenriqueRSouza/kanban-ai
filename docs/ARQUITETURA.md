# Arquitetura implementada — TaskFlow com Agente de IA

Projeto da disciplina **Serviços de Nuvem**: aplicação distribuída com containers,
mensageria, orquestração e elasticidade. Este documento descreve o que está
implementado no repositório (não o diagrama do enunciado). Os experimentos e os
resultados observados estão em [`EXPERIMENTOS.md`](EXPERIMENTOS.md).

## 1. Domínio

Um quadro Kanban com um botão **"Agente de IA"**: o usuário cola uma *user story*
ou um planejamento, escolhe a coluna de destino e o sistema gera cartões a partir
do texto. A geração é lenta (segundos de inferência em CPU) e por isso vira um
**job assíncrono**: o Serviço A registra o pedido e publica uma mensagem; o
Serviço B consome, chama o modelo de linguagem e devolve o resultado também por
mensagem. É o caso "processamento de documentos" citado no enunciado.

## 2. Componentes

| Componente | Papel | Compose | Kubernetes |
|---|---|---|---|
| **NGINX** | Único ponto de entrada (reverse proxy). Serve o front (build estático do React) e encaminha `/api` para o Serviço A. Gera/propaga o `X-Request-Id`. | container `nginx` (única porta publicada) | **NGINX Ingress Controller** (`k8s/base/ingress.yaml`); o front vira o Deployment `web` |
| **Serviço A** (`api/`) | Produtor. CRUD do quadro e `POST/GET /api/ai/jobs`. Único componente que grava no banco. Publica `cards.generate` e consome os resultados. | container `api` | Deployment `api` (2 réplicas) + Service |
| **Serviço B** (`worker/`) | Consumidor. Consome `ai.generate`, chama o LLM, valida a saída e publica o resultado. Sem banco e sem HTTP público (só `/healthz` para as probes). | container `worker` | Deployment `worker` (2 réplicas; HPA na etapa 3), **sem Service** |
| **RabbitMQ** | Broker entre A e B. | container `rabbitmq` + volume | StatefulSet `rabbitmq` (1 réplica) + PVC + Service |
| PostgreSQL | Dados do quadro e dos jobs (componente extra). | container `db` + volume | StatefulSet `postgres` (1 réplica) + PVC |
| Ollama | Modelo de linguagem local `qwen3:1.7b`, já embutido na imagem (componente extra). | container `ollama` | **sidecar** dentro do pod do worker |

**A e B não se conhecem.** Nenhuma variável de ambiente de A aponta para B ou o
contrário; os dois só conhecem o endereço do RabbitMQ e o contrato das
mensagens (`packages/shared/src/messages.ts`). O resultado volta por fila, então
não existe chamada HTTP/TCP entre A e B em nenhum sentido.

## 3. Fluxo de uma operação

```
Navegador ─HTTP─▶ NGINX ─/api─▶ Serviço A ─SQL─▶ PostgreSQL
                                   │  ▲
         publica cards.generate    │  │  consome cards.generated / cards.generation_failed
                                   ▼  │
                                RabbitMQ
                                   │  ▲
         consome ai.generate       │  │  publica o resultado (exchange taskflow.events)
                                   ▼  │
                                Serviço B ─HTTP─▶ Ollama (localhost no pod / container ollama)
```

1. O front faz `POST /api/ai/jobs` com `{ input, targetColumnId, idempotencyKey, maxCards }`.
2. A valida com Zod, grava o job em `ai_jobs` como `pending_publish` e responde `202`.
   A mesma `idempotencyKey` devolve o mesmo job (o clique duplo não cria dois).
3. O *outbox* de A publica a mensagem com *publisher confirms* e marca o job como `queued`.
   Se o broker estiver fora, o job continua `pending_publish` e é publicado quando a conexão volta.
4. B consome com `prefetch=1` e ack manual, publica `cards.generation_started`, chama o LLM e valida o JSON.
5. B publica `cards.generated` (ou `cards.generation_failed`), espera a confirmação do broker e **só então** dá ack no comando.
6. A consome o resultado e, numa transação, cria os cartões, marca o job `succeeded` e dá ack depois do commit.
7. O front consulta `GET /api/ai/jobs/:id` a cada 2 s e recarrega o quadro quando o job termina.

## 4. Formato das mensagens

Definido e validado com Zod em `packages/shared/src/messages.ts` (A e B usam o mesmo schema).

```jsonc
// Comando — exchange taskflow.commands → fila ai.generate
{
  "schemaVersion": 1,
  "type": "cards.generate",
  "messageId": "uuid", "jobId": "uuid",
  "correlationId": "X-Request-Id recebido pelo NGINX",
  "createdAt": "2026-11-27T02:14:41.928Z",
  "payload": { "boardId": "uuid", "targetColumnId": "uuid", "input": "Como usuário, quero…",
               "maxCards": 3, "locale": "pt-BR", "promptVersion": "v1" }
}

// Evento — exchange taskflow.events → fila ai.results
{
  "schemaVersion": 1,
  "type": "cards.generated",             // ou cards.generation_started | cards.generation_failed
  "messageId": "uuid", "jobId": "uuid", "correlationId": "…",
  "worker": "worker-7b6df549b5-8lll6",   // nome do pod: mostra qual réplica processou
  "provider": "ollama", "model": "qwen3:1.7b", "durationMs": 8421,
  "payload": { "cards": [{ "title": "…", "description": "… | null" }] }
}
```

Propriedades AMQP: `persistent: true`, `contentType: application/json`,
`messageId`, `correlationId` e `type`. O modelo gera só o conteúdo (título e
descrição); IDs, posições e coluna são decididos por A. Os IDs dos cartões são
determinísticos (UUID v5 de `jobId + índice`), então uma reentrega nunca duplica cartões.

## 5. Estratégia do RabbitMQ

| Item | Configuração | Motivo |
|---|---|---|
| Exchanges | `taskflow.commands`, `taskflow.events`, `taskflow.dlx` (direct, duráveis) | Produtor publica no exchange, não numa fila específica |
| Filas | `ai.generate` e `ai.results`: **quorum**, duráveis, `x-delivery-limit: 3` | Sobrevivem a restart do broker |
| Mensagens mortas | `ai.generate.dlq` e `ai.results.dlq` via dead-letter exchange. A API consome a `ai.generate.dlq` e marca como `failed` o job que ainda não terminou (log `job.dead_lettered`) | Mensagem que falhou demais sai da fila principal. Se o worker cair em todas as entregas, o RabbitMQ desiste sozinho sem evento de falha, e sem esse consumidor o job ficaria "Processando" para sempre |
| Mensagens | persistentes, publicadas com *confirm channel* | A mensagem só conta como enviada quando o broker confirmou que gravou |
| Consumo | ack manual; `prefetch=1` em B | Uma inferência por vez por réplica: com várias réplicas, cada uma pega a próxima mensagem livre (*work queue*) |
| Novas tentativas | Timeout/erro passageiro do LLM: B republica a mensagem com o cabeçalho `x-taskflow-attempt` e dá ack na original; na 3ª falha publica `cards.generation_failed` e rejeita para a DLQ. Erro definitivo (JSON inválido, 401): `failed` direto. | No RabbitMQ 4 o `nack` com requeue não incrementa o `x-delivery-count`; sem o cabeçalho próprio, um job com timeout ficaria em laço para sempre |
| Garantia | "pelo menos uma vez" + idempotência em A pelo `jobId` | Se B cair no meio de um job, a mensagem sem ack volta para a fila e outra réplica processa |
| Reconexão | API e worker reconectam sozinhos (backoff até 10 s) com timeout de 10 s no handshake | Uma tentativa que pega o broker ainda desligando não fica pendurada |

**Limitação:** o RabbitMQ roda com **uma** instância (aceito pelo enunciado). Com o
volume persistente, as mensagens sobrevivem ao restart do pod, mas durante o
restart não há broker: A continua aceitando pedidos (ficam `pending_publish`) e
B fica parado. Alta disponibilidade exigiria um cluster de 3 nós (quorum real).

## 6. Rede e exposição

**Compose** (`compose.yml`):

| Rede | Quem participa | Observação |
|---|---|---|
| `edge` | `nginx`, `api` | Caminho de fora para dentro |
| `internal` (`internal: true`, sem saída para a internet) | `api`, `worker`, `rabbitmq`, `db`, `ollama` | O NGINX não participa |

- Só o `nginx` tem `ports:` (`${APP_PORT:-8080}:80`). API, worker, banco, RabbitMQ e Ollama não publicam portas.
- O painel do RabbitMQ não faz parte da aplicação: só com `compose.debug.yml`, e só em `127.0.0.1:15672` (para a demonstração).
- Com LM Studio/OpenRouter, `compose.external-llm.yml` dá ao worker uma rede extra com saída.

**Kubernetes:** todos os Services são `ClusterIP` (ou headless, nos StatefulSets);
a única entrada é o Ingress (`/api` → `api:3000`, `/` → `web:80`). Os serviços se
encontram pelo **nome do Service** (`rabbitmq`, `postgres`), nunca pelo IP de um pod.
O painel do RabbitMQ só é acessível por `kubectl port-forward`.

## 7. Credenciais

Nenhuma senha está no Git. No Compose elas vêm do `.env` (ignorado pelo Git;
`.env.example` versionado só com valores de exemplo). No Kubernetes o
`scripts/k8s-up.sh` cria o Secret `taskflow-secrets` a partir do `.env`;
`k8s/secret.example.yaml` só documenta as chaves.

## 8. Migração para Kubernetes: decisões

| Decisão | Por quê |
|---|---|
| **minikube** com addons `ingress` e `metrics-server` | Roda em qualquer máquina com Docker; o metrics-server é obrigatório para o HPA |
| Imagens construídas localmente e carregadas no minikube (`imagePullPolicy: Never`) | Funciona em Intel/AMD e ARM sem depender de registry público |
| A e B como **Deployment**; RabbitMQ e PostgreSQL como **StatefulSet** com PVC | A e B não têm estado (qualquer réplica atende); broker e banco precisam do mesmo volume após restart. O nome estável `rabbitmq-0` é o que o RabbitMQ usa para achar seus dados |
| **Ingress NGINX** no lugar do container `nginx` | É o ponto de entrada pedido no enunciado; o front vira um Deployment só com os arquivos estáticos |
| Ollama como **sidecar** do worker (initContainer com `restartPolicy: Always`) | A inferência acontece *dentro* do pod do Serviço B, então a CPU que o HPA mede é o trabalho real do serviço. Com o modelo fora do pod, o worker só esperaria HTTP com a CPU parada e o HPA não reagiria |
| `OLLAMA_NUM_THREADS=2` e `limits.cpu: 2` no sidecar (no Compose, 4 threads) | O Ollama abre uma thread por núcleo que enxerga no nó, não pelo limite do pod. Com 2 réplicas, as threads disputavam poucos núcleos e a geração caía para ~0,1 token/s (timeout). Threads = limite resolve |
| Probes: readiness em `/api/health` e `/healthz`; startup do Ollama espera o modelo estar configurado | O Service só manda tráfego para pods prontos; o worker só sobe depois do modelo |
| HPA em `k8s/autoscaling/`, fora da base, com mínimo 1 e máximo 2 réplicas | Os experimentos da etapa 2 (self-healing com 2 réplicas, escala manual) precisam de controle manual das réplicas. O máximo é 2 porque cada réplica usa ~2 GB: com 3 num Docker de 8 GB, o nó ficou sem memória e o servidor da API travou (ver EXPERIMENTOS.md) |
| Secret criado a partir do `.env` | Mesmo arquivo de configuração do Compose; nada sensível versionado |

**Limitações conhecidas:** RabbitMQ e PostgreSQL sem alta disponibilidade (1
réplica); o modelo pequeno (1,7 B) gera cartões mais simples que um modelo
grande; o projeto ingress-nginx está em manutenção mínima desde 2026, mas é o
exigido pelo enunciado.

## 9. Provedores de LLM

O padrão (e o usado nas demonstrações) é o **Ollama local**, que funciona em
qualquer máquina com Docker, sem conta e sem internet depois do build. O worker
também aceita **LM Studio** e **OpenRouter** (`LLM_PROVIDER` no `.env`); no
Kubernetes o `k8s-up` escolhe então o overlay `k8s/overlays/external-llm`, que
remove o sidecar. Nesse modo o HPA por CPU não reage, pela razão da seção 8.
