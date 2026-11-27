# TaskFlow — Planejamento do Projeto de Serviços em Nuvem

> **Documento de planejamento (20/10/2026), mantido como histórico.** A solução
> implementada mudou em alguns pontos durante os testes, por exemplo: HPA com
> máximo de **2** réplicas (cada réplica usa ~2 GB), escala manual de 1 para 2,
> Ollama com número fixo de threads e consumo da DLQ pela API. O que vale é:
> [`ARQUITETURA.md`](ARQUITETURA.md) (arquitetura efetivamente implementada) e
> [`EXPERIMENTOS.md`](EXPERIMENTOS.md) (roteiro e resultados observados).

> **Disciplina:** Serviços em Nuvem — Engenharia da Computação (Mackenzie)
> **Enunciado:** "Aplicação distribuída com containers, mensageria, orquestração e elasticidade"
> **Repositório:** https://github.com/HenriqueRSouza/kanban-ai (separado do TaskFlow de Mobile)
> **Data:** 20/10/2026 — revisão 2: três provedores de LLM e execução na máquina do professor
> **Elaboração:** planejamento feito com Claude Code e revisado de forma independente pelo OpenCode (gpt-6-astra). As divergências entre os dois estão na seção 11.

---

## 1. Ideia: "Agente de IA" como fila de processamento

O usuário clica em **"Agente de IA"**, cola uma *user story* ou um planejamento, escolhe a coluna de destino e envia. O pedido vira um **job assíncrono**: o Serviço A publica no RabbitMQ, o Serviço B (worker) chama um **LLM**, transforma o texto em cartões e devolve o resultado **também pela fila**. O LLM pode ser Ollama, LM Studio ou OpenRouter (seção 3). O quadro mostra o job passando por *Na fila → Processando → Concluído*, e no fim aparecem os cartões novos.

**Parecer: a ideia é boa e cabe no enunciado.** O enunciado cita "processamento de documentos" e "geração de relatórios" como domínios possíveis, e gerar cartões a partir de texto é exatamente isso. Os motivos:

- **Separação natural:** A cuida do quadro (CRUD, banco) e B faz um trabalho pesado e lento (inferência). Ninguém precisa forçar uma divisão artificial.
- **A fila fica visível:** uma inferência leva segundos. Com B parado, os jobs se acumulam no RabbitMQ e são processados quando ele volta. É o experimento obrigatório da etapa 1, e acontece sozinho.
- **B é o candidato ideal para escalar:** os consumidores de uma *work queue* competem pelas mensagens, como mostra a Figura 3 do enunciado.

**O ponto que exige cuidado é o HPA por CPU** (seção 5). Se o modelo rodar fora do pod (LM Studio no Mac ou OpenRouter na internet), o worker passa o tempo esperando HTTP com a CPU parada, e o HPA não reage. O plano resolve isso usando o **Ollama como provedor principal**: no Kubernetes, um modelo pequeno roda **dentro do pod de B**.

**Requisito do professor:** ele vai rodar o projeto **na máquina dele**. Por isso o padrão não pode depender de nada que só exista no seu Mac (LM Studio) nem de uma conta com token (OpenRouter). O Ollama, com o modelo embutido na imagem, funciona em qualquer máquina com Docker e sem configuração (seção 6).

---

## 2. Arquitetura

### 2.1 Componentes

| Componente | Papel no enunciado | Implementação |
|---|---|---|
| `nginx` | Único ponto de entrada (reverse proxy) | Imagem NGINX que serve o build estático do React e encaminha `/api/*` para A. No Kubernetes, o **Ingress NGINX** assume a entrada e o `web` vira um pod NGINX só com os estáticos. |
| `api` | **Serviço A**: produtor | Express atual + `POST/GET /api/ai/jobs` + publicador AMQP + consumidor da fila de resultados. **Só A grava no Postgres.** |
| `worker` | **Serviço B**: consumidor | Novo workspace `worker/` (Node 22 + TS). Consome `ai.generate`, chama o LLM, valida a saída com Zod e publica `ai.results`. **Não tem banco nem HTTP público**, só um `/healthz` para as probes. |
| `rabbitmq` | Broker | `rabbitmq:4-management`, com volume/PVC. Filas *quorum* duráveis. |
| `db` | Componente extra (com estado) | Postgres 16 atual. Sem porta publicada. |
| `ollama` | Componente extra: **LLM padrão** | Imagem própria `kanban-ai/ollama` com o modelo já embutido. No Compose é um container; no Kubernetes é um sidecar dentro do pod de B. Ver seção 3. |

### 2.2 Fluxo de uma operação

```
Navegador ──HTTP──▶ NGINX ──/api──▶ Serviço A ──SQL──▶ Postgres
                                       │  ▲
                   publica cards.generate │  │ consome cards.generated / failed
                                       ▼  │
                                    RabbitMQ
                                       │  ▲
                   consome cards.generate │  │ publica resultado
                                       ▼  │
                                    Serviço B ──HTTP──▶ LLM: Ollama (padrão) | LM Studio | OpenRouter
```

1. O front faz `POST /api/ai/jobs` com `{ input, targetColumnId, idempotencyKey }`.
2. A valida, grava o job (`pending_publish`) em `ai_jobs` e responde `202 { jobId }`.
3. O publicador de A envia a mensagem com *publisher confirms* e marca o job como `queued`. Se o broker estiver fora, o job fica pendente e um laço republica depois (*outbox* simplificada).
4. B consome (`prefetch=1`, ack manual), publica o evento `cards.generation_started`, chama o LLM e valida o JSON.
5. B publica `cards.generated` (ou `cards.generation_failed`), espera a confirmação e **só então** dá ack no comando.
6. A consome o resultado e, **em uma transação**, cria os cartões, marca o job `succeeded` e dá ack depois do commit.
7. O front faz *polling* em `GET /api/ai/jobs/:id` a cada 2 s. Quando o job termina, recarrega o quadro.

**Por que B não grava no banco:** B fica sem estado e sem credenciais de banco. Assim é trivial escalar, e A continua dono das regras do quadro (posições, IDs, coluna existente). O resultado volta pelo RabbitMQ, então **não existe chamada direta entre A e B em nenhum sentido**.

### 2.3 Contratos das mensagens (`packages/shared/src/messages.ts`)

```jsonc
// comando: exchange taskflow.commands → fila ai.generate
{
  "schemaVersion": 1,
  "type": "cards.generate",
  "messageId": "uuid", "jobId": "uuid", "correlationId": "uuid (X-Request-Id do NGINX)",
  "createdAt": "2026-10-20T12:00:00Z",
  "payload": { "boardId": "uuid", "targetColumnId": "uuid",
               "input": "Como usuário, quero...", "maxCards": 8, "locale": "pt-BR", "promptVersion": "v1" }
}
// evento: exchange taskflow.events → fila ai.results
{
  "schemaVersion": 1,
  "type": "cards.generated",            // ou cards.generation_started | cards.generation_failed
  "messageId": "uuid", "jobId": "uuid", "correlationId": "uuid",
  "worker": "worker-7d9f-abc12",        // hostname do pod, para mostrar a distribuição
  "provider": "ollama", "model": "qwen3:1.7b", "durationMs": 8421,
  "payload": { "cards": [{ "title": "≤ 200 chars", "description": "≤ 160 chars | null" }] }
}
```

O LLM gera **apenas conteúdo** (título e descrição). IDs, posições e coluna ficam com A. A saída passa pelo mesmo `UpsertCardSchema` (os limites de 200/160 caracteres entram no prompt **e** na validação), e o modelo é chamado com `response_format: json_schema` quando o provedor suporta.

### 2.4 Topologia do RabbitMQ e garantias

| Item | Configuração |
|---|---|
| Exchanges | `taskflow.commands` e `taskflow.events` (direct, duráveis) |
| Filas | `ai.generate` e `ai.results`: *quorum*, duráveis, com `x-delivery-limit: 3` |
| DLQ | `ai.generate.dlq` e `ai.results.dlq` via `x-dead-letter-exchange` |
| Mensagens | `persistent: true`, publicação com *confirm channel* |
| Consumo | ack manual; `prefetch=1` em B (uma inferência por vez), `prefetch=10` em A |
| Falhas | Timeout do LLM é reentregue (até 3 vezes) e depois vai para a DLQ, com o job marcado `failed`. JSON inválido gera `failed` direto, sem retry. Erro de autenticação no OpenRouter (401/403) também gera `failed` direto. **Nada de `nack(requeue=true)` em laço.** |

A garantia é **"pelo menos uma vez"**. A aplica o resultado de forma idempotente: faz `select … for update` no job e ignora o evento se ele já for terminal. Os IDs dos cartões são determinísticos (UUID v5 de `jobId + índice`), então uma reentrega nunca duplica cartões.

### 2.5 Observabilidade

- O NGINX gera `$request_id` e envia `X-Request-Id`. A usa esse valor como `correlationId`, ele vai nos *headers* AMQP e B registra o mesmo id.
- Logs em JSON, uma linha por evento, com `ts, service, pod, correlationId, jobId, event`. Eventos: `http.received`, `job.created`, `msg.published`, `msg.consumed`, `llm.done` (com `provider` e `model`), `result.published`, `job.succeeded`.
- `docker compose logs -f | grep <correlationId>` mostra a operação inteira atravessando NGINX → A → RabbitMQ → B → A. Isso é exigido explicitamente na etapa 1.
- **O token do OpenRouter nunca aparece em log** (o cliente remove o header `Authorization` de qualquer mensagem de erro).

---

## 3. Provedores de LLM (três opções)

O worker tem **um único cliente HTTP** para `/v1/chat/completions`, a API compatível com OpenAI que os três provedores oferecem. Trocar de provedor é só configuração, sem mudar código.

| | **1. Ollama (principal, padrão)** | **2. LM Studio** | **3. OpenRouter** |
|---|---|---|---|
| Onde roda | Container `ollama` (Compose) / sidecar no pod de B (Kubernetes) | App nativo no Mac de quem desenvolve | Serviço externo na internet |
| `LLM_BASE_URL` padrão | `http://ollama:11434/v1` (Compose) · `http://localhost:11434/v1` (sidecar) | `http://host.docker.internal:1234/v1` | `https://openrouter.ai/api/v1` |
| Credencial | Nenhuma | Nenhuma | `LLM_API_KEY` (token do OpenRouter) |
| Modelo sugerido | `qwen3:1.7b` (embutido na imagem; alternativa `qwen2.5:1.5b-instruct`) | `qwen/qwen3-8b` (já baixado no seu LM Studio) | Qualquer modelo do catálogo, definido em `LLM_MODEL` |
| Funciona na máquina do professor | **Sim, sem configurar nada** | Só se ele tiver LM Studio | Só com um token dele ou do grupo |
| Qualidade dos cartões | Razoável | Boa | Boa a ótima, conforme o modelo |
| CPU dentro do pod de B | **Sim**, o que permite o HPA | Não | Não |
| Uso no projeto | Padrão, demo do professor e **experimento do HPA** | Desenvolvimento com resposta melhor no seu Mac | Alternativa quando a máquina não aguenta o Ollama, ou para comparar qualidade |

**Variáveis de ambiente do worker** (validadas com Zod na inicialização; com valor inválido, o worker para com uma mensagem clara):

```dotenv
LLM_PROVIDER=ollama            # ollama | lmstudio | openrouter
LLM_BASE_URL=                  # vazio = padrão do provedor (tabela acima)
LLM_MODEL=qwen3:1.7b
LLM_API_KEY=                   # obrigatório só com openrouter
LLM_TIMEOUT_MS=60000
```

**Regras específicas do OpenRouter:**
- O token fica **só** no `.env` local (que está no `.gitignore`) ou num `Secret` criado por linha de comando. **Nunca** vai para o repositório nem para a imagem. O `.env.example` traz a variável vazia.
- O worker envia os headers opcionais `HTTP-Referer` e `X-Title` (identificação do app no OpenRouter).
- O texto colado pelo usuário **sai da máquina** e vai para um serviço externo. O diálogo do Agente de IA mostra um aviso quando o provedor ativo é o OpenRouter.
- Modelos `:free` têm limite de requisições; erro 429 entra no retry com espera.

**Compose:** o serviço `ollama` fica no perfil `ollama`, ligado por padrão (`COMPOSE_PROFILES=ollama` no `.env.example`). Quem usa LM Studio ou OpenRouter tira o perfil e não sobe o container à toa.

**Kubernetes:** o provedor vem do `ConfigMap`. Com `ollama`, o pod de B tem o sidecar. Com os outros, existe a variante `k8s/overlays/external-llm` (kustomize) que remove o sidecar e lê o token do `Secret`. O **experimento do HPA é sempre feito com Ollama**, porque com provedor externo a CPU do pod não reflete a carga (seção 5).

---

## 4. Mudanças no repositório

```
kanban-ai/
├── compose.yml                 # substitui docker-compose.yml (nome usado no enunciado)
├── .env.example                # credenciais de exemplo e LLM_*; .env real fica no .gitignore
├── nginx/
│   ├── Dockerfile              # multi-stage: build do web → nginx:alpine
│   └── default.conf            # / → estáticos, /api → api:3000, X-Request-Id
├── ollama/
│   └── Dockerfile              # ollama/ollama + `ollama pull` do modelo durante o build
├── api/src/
│   ├── routes/aiJobs.ts        # POST/GET /api/ai/jobs
│   └── messaging/              # conexão AMQP, publicador (outbox), consumidor de resultados
├── api/migrations/006_ai_jobs.sql
├── worker/                     # Serviço B (novo workspace)
│   ├── Dockerfile
│   └── src/{main.ts, config.ts, consumer.ts, llm/client.ts, llm/providers.ts, prompt.ts, health.ts}
├── packages/shared/src/messages.ts
├── web/src/components/AiAgentDialog.tsx  (+ store/aiJobsStore.ts)
├── k8s/
│   ├── base/                   # namespace, configmap, postgres, rabbitmq, api, worker(+ollama), web, ingress, hpa
│   └── overlays/external-llm/  # worker sem sidecar, para LM Studio/OpenRouter
├── scripts/
│   ├── k8s-up.sh / k8s-up.ps1  # sobe tudo no minikube com um comando
│   ├── k8s-down.sh
│   └── load.sh                 # gera N jobs pelo ponto de entrada
└── docs/{ARQUITETURA.md, EXPERIMENTOS.md}
```

**Dependências:** `amqplib` 2.2.0 já instalado na API (traz os próprios tipos). O worker usa o mesmo `amqplib`, `zod` e `@taskflow/shared`. O cliente do LLM usa `fetch` nativo, sem SDK.

---

## 5. Kubernetes e o problema do HPA

| Recurso | Decisão |
|---|---|
| Cluster | **minikube** (`addons enable ingress metrics-server`). O metrics-server é obrigatório para o HPA. |
| A | `Deployment` com 2 réplicas + `Service` ClusterIP + probes em `/api/health` |
| B | `Deployment` com 2 réplicas, **pod = worker + sidecar Ollama** (imagem com o modelo embutido, para não baixar ~1 GB a cada pod novo). Sem Service: B só consome AMQP. |
| RabbitMQ / Postgres | `StatefulSet` com 1 réplica + PVC + Service. Limitação documentada: sem alta disponibilidade. |
| Configuração | `ConfigMap` (URLs, filas, `LLM_PROVIDER`, `LLM_MODEL`) e `Secret` criado por `kubectl create secret … --from-env-file=.env` (senhas e, se usado, o token do OpenRouter). Nada de segredo versionado. |
| Entrada | `Ingress` com `/` → web e `/api` → api |
| HPA | `autoscaling/v2`, alvo B, **min 1 / max `HPA_MAX` (padrão 4), CPU 60%**, `scaleDown.stabilizationWindowSeconds: 60` (para o retorno ser visível em sala) |

**Por que o sidecar resolve o HPA:** a utilização de CPU que o HPA calcula soma todos os containers do pod. Com a inferência dentro do pod, a fila cheia faz cada réplica usar 100% da CPU (`requests.cpu` do Ollama ≈ 1000m), o HPA cria pods, os novos consumidores pegam mensagens da fila, e quando a fila esvazia a CPU cai e as réplicas diminuem. **A CPU medida é o trabalho real do serviço**, não um cálculo artificial.

Custo: cerca de 1,2 GB de RAM por réplica com um modelo de 1,5–1,7B (q4). Com no máximo 4 réplicas, o minikube precisa de cerca de 8 GB. Se a máquina tiver menos, o script aceita `HPA_MAX=2`.

**Plano B:** se nem assim couber, o worker ganha `LLM_PROVIDER=heuristic`, que quebra o texto em cartões por regras (tópicos, critérios de aceite) com processamento CPU-bound real em `worker_threads`. É a sugestão do OpenCode (seção 11).

**Opcional (atividade avançada):** KEDA com o *scaler* de RabbitMQ (tamanho da fila `ai.generate`) como complemento ao HPA por CPU, nunca como substituto.

**Nota:** o projeto ingress-nginx entrou em aposentadoria (manutenção mínima desde março de 2026). Como o enunciado o exige, ele continua sendo usado, e a limitação é registrada na documentação.

---

## 6. Como o professor roda na máquina dele

**Pré-requisitos:** Docker Desktop (Windows, macOS ou Linux), minikube e cerca de 8 GB de RAM livres para a etapa Kubernetes. Não precisa de LM Studio, conta no OpenRouter nem internet depois do primeiro build.

```bash
git clone https://github.com/HenriqueRSouza/kanban-ai && cd kanban-ai
cp .env.example .env              # já vem pronto para Ollama; só senhas locais

# Etapa 1 — Docker Compose
docker compose up --build         # abrir http://localhost:8080

# Etapas 2 e 3 — Kubernetes
./scripts/k8s-up.sh               # Windows: .\scripts\k8s-up.ps1
```

O `k8s-up` faz tudo:
1. `minikube start --memory 8g --cpus 4`;
2. liga os addons `ingress` e `metrics-server`;
3. constrói as imagens **dentro** do minikube (`minikube image build`), de modo que funcionam em processador Intel/AMD ou ARM sem imagens publicadas;
4. cria o `Secret` a partir do `.env` e aplica `k8s/base`;
5. espera todos os pods ficarem prontos (`kubectl wait`);
6. imprime a URL de acesso e os comandos dos experimentos.

**Decisão: não empacotar tudo num container único.** O enunciado avalia justamente a separação de componentes ("cada componente executa em seu próprio container"), e Kubernetes dentro de container (Docker-in-Docker) exige `--privileged`, é frágil e atrapalha o metrics-server. Se o professor não quiser instalar o minikube, a alternativa (só no fim, se pedirem) é um container "lançador" com `kubectl` + `kind` que cria o cluster usando o Docker dele.

**Tempo do primeiro build:** alguns minutos, por causa da imagem do Ollama com o modelo (~1,2 GB). O README avisa.

---

## 7. Rastreabilidade: requisito → como é atendido

| Requisito do enunciado | Atendido por | Evidência na demo |
|---|---|---|
| 4 containers independentes (NGINX, A, B, RabbitMQ) | `compose.yml` (+ db e ollama) | `docker compose ps` |
| NGINX é o único acesso | Só `nginx` tem `ports:`; api/worker/db/rabbit/ollama apenas em `networks:` | `curl localhost:3000` falha; `curl localhost:8080/api/board` funciona |
| A e B sem endereço um do outro | Nenhuma variável de ambiente aponta de A para B nem de B para A; resultado volta por fila | `docker compose config` + grep no código |
| A produtor / B consumidor | `cards.generate` / `ai.generate` | Logs com `correlationId` |
| A continua com B parado; mensagens persistem | Fila quorum durável + mensagens persistentes + ack manual | `docker compose stop worker` → envia 3 jobs → fila = 3 → `start` → fila = 0 |
| Logs rastreáveis ponta a ponta | `X-Request-Id` → `correlationId` | `grep <id>` em todos os serviços |
| RabbitMQ admin justificado | UI de gestão só via `127.0.0.1:15672` em perfil `debug` do compose (ou `kubectl port-forward`) | Explicação na documentação |
| Credenciais fora do Git | `.env` / `Secret` (inclui o token do OpenRouter) | `.env.example` versionado sem valores sensíveis |
| Deployments + Services + Ingress NGINX | `k8s/base` | `kubectl get deploy,svc,ingress` |
| RabbitMQ com estado | StatefulSet + PVC, limitações documentadas | Deletar o pod do rabbit; mensagens continuam lá |
| Self-healing | B com 2 réplicas | `kubectl delete pod worker-…` + `kubectl get pods -w` |
| Escala manual | `kubectl scale deploy/worker --replicas=3` | Logs mostrando 3 pods diferentes consumindo |
| Elasticidade (HPA por CPU) | `hpa.yaml` + `scripts/load.sh`, com Ollama | `kubectl get hpa -w`: sobe até 4 e volta a 1 |
| Documentação reproduzível | `README.md` + `docs/ARQUITETURA.md` + `scripts/k8s-up` | Professor sobe tudo na máquina dele |
| Histórico Git do grupo | Um branch por ticket, PRs por integrante | `git log --author` |

---

## 8. Tickets

Cada ticket lista o que **pode ser alterado**, conforme o `AGENTS.md`. Ordem sugerida: T1 → T2 → T3 fecham a **etapa 1**, T4–T6 a **etapa 2** e T7–T8 a **etapa 3**.

| # | Ticket | Pode alterar | Critério de aceite |
|---|---|---|---|
| **T0** | Decisões e dependências | `docs/` | ✅ Repositório `kanban-ai` criado; ✅ `amqplib` instalado; ✅ três provedores de LLM definidos |
| **T1** | Contratos + jobs em A | `packages/shared/src/messages.ts`, `api/migrations/006_ai_jobs.sql`, `api/src/routes/aiJobs.ts`, `api/src/messaging/*`, `api/test/*` | Schemas com testes válidos/inválidos; `POST` idempotente (mesma chave → mesmo job); com o broker fora, o job fica `pending_publish` e é publicado quando o broker volta |
| **T2** | Worker (Serviço B) + provedores | `worker/**` | Consome, chama o LLM, valida, publica resultado; ack só depois do confirm; timeout/429 → retry → DLQ; JSON inválido ou 401 → `failed`; config Zod para os 3 provedores; token nunca logado; testes com LLM falso para cada provedor |
| **T3** | Compose + NGINX + Ollama + logs | `compose.yml`, `nginx/**`, `ollama/**`, `.env.example`, `.gitignore`, Dockerfiles | Só o NGINX publica porta; `docker compose up` funciona com o `.env.example` sem editar nada (Ollama); trocar `LLM_PROVIDER` para lmstudio/openrouter funciona; `grep correlationId` mostra os 5 saltos; experimento "B parado" reproduzível |
| **T4** | UI do Agente de IA | `web/src/components/AiAgentDialog.tsx`, `web/src/store/aiJobsStore.ts`, `web/src/App.tsx`, testes | Botão abre diálogo; status em tempo quase real; aviso de envio externo quando o provedor é OpenRouter; o quadro atualiza sem perder edições locais (cuidado com `syncEngine.ts`, que adia snapshots com pendências) |
| **T5** | Imagens de produção | Dockerfiles | Imagens sem *bind mounts* e sem `vite dev`; web em build estático |
| **T6** | Manifests Kubernetes + script | `k8s/**`, `scripts/k8s-up.*`, `scripts/k8s-down.sh` | `k8s-up` sobe tudo do zero numa máquina limpa; acesso pelo Ingress; probes ok; B com 2 réplicas; deletar pod → reposição; reiniciar RabbitMQ preserva mensagens; overlay `external-llm` funciona |
| **T7** | HPA + carga | `k8s/base/hpa.yaml`, `scripts/load.sh` | Com carga, HPA escala 1 → `HPA_MAX`; sem carga, volta a 1; evidências (prints/vídeo) em `docs/EXPERIMENTOS.md` |
| **T8** | Documentação final | `docs/ARQUITETURA.md`, `docs/EXPERIMENTOS.md`, `README.md` | Alguém que nunca viu o projeto sobe tudo seguindo só o README (teste: um colega em Windows); papel de cada componente, formato das mensagens, rede, estratégia do RabbitMQ, provedores de LLM e decisões da migração explicados |

---

## 9. Roteiro da demonstração final (~12 min)

1. **Arquitetura (1 min):** diagrama real; mostrar que A e B não têm a URL um do outro.
2. **Entrada única (1 min):** `curl` direto na api falha; pelo NGINX funciona.
3. **Fluxo feliz (2 min):** colar uma user story no "Agente de IA", acompanhar o `jobId` nos logs (NGINX → A → publicação → B → resultado → A) e ver os cartões aparecerem. Mencionar que trocar `LLM_PROVIDER` muda o modelo sem mexer na arquitetura.
4. **Falha controlada (2 min):** `docker compose stop worker`, enviar 3 histórias (A aceita todas), mostrar a fila com 3 mensagens, `start worker`, ver a fila esvaziar. **Explicar:** fila durável, mensagem persistente, ack manual.
5. **Kubernetes + self-healing (2 min):** tudo pelo Ingress; `kubectl delete pod` de um worker; o Deployment repõe a réplica. Se o pod morreu no meio de um job, a mensagem sem ack é reentregue e não duplica cartões.
6. **Escala manual (1 min):** `kubectl scale --replicas=3`; logs com 3 hostnames diferentes dividindo a fila.
7. **Elasticidade (3 min):** `scripts/load.sh 40`; `kubectl get hpa -w` mostra a CPU subindo e as réplicas indo de 1 a 4; com a carga parada, a redução começa depois da janela de estabilização. Explicar por que o HPA usa Ollama, e não LM Studio/OpenRouter.
8. **Fechamento:** escalabilidade ≠ elasticidade; limitações (RabbitMQ/Postgres de instância única, modelo pequeno no cluster, ingress-nginx aposentado).

---

## 10. Decisões em aberto

1. **Modelo do Ollama:** testar `qwen3:1.7b` × `qwen2.5:1.5b-instruct` em latência por job (alvo: menos de 20 s em CPU) e qualidade do JSON.
2. **Modelo padrão do OpenRouter:** escolher um modelo barato ou `:free` para o `.env.example` (comentado).
3. **Teste em Windows:** algum integrante com Windows valida o `k8s-up.ps1` antes da entrega.

---

## 11. Revisão do OpenCode: onde concordamos e onde não

**Concordância total:** resultado volta por fila (B nunca chama A); só A grava no banco; publisher confirms + ack tardio + idempotência por `jobId`; polling de status; limites de 200/160 caracteres no prompt e na validação; risco do `syncEngine.ts` ao aplicar cartões vindos do servidor; credenciais fixas atuais no compose precisam sair; RabbitMQ de instância única documentado como limitação.

**Divergência: como demonstrar o HPA.**
- *OpenCode:* manter o LM Studio no Mac também no cluster e criar um **modo benchmark** com cálculo CPU-bound sintético no worker para o experimento.
- *Este plano:* rodar a **inferência real dentro do pod** (sidecar Ollama com modelo pequeno). A CPU que o HPA mede é o trabalho de verdade do Serviço B, e a "carga artificial" do enunciado vira simplesmente "muitos jobs na fila". Isso é mais fácil de defender na arguição e, com o requisito de rodar na máquina do professor, é também a única opção que dispensa LM Studio. O modo heurístico/benchmark fica como **plano B** se faltar RAM.

**Ajuste incorporado da revisão:** outbox simplificada (job `pending_publish` + republicador) em vez de publicar direto no handler HTTP, para não perder pedidos se A cair entre o commit e a publicação.
