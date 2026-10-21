# TaskFlow — Planejamento do Projeto de Serviços em Nuvem

> **Disciplina:** Serviços em Nuvem — Engenharia da Computação (Mackenzie)
> **Enunciado:** "Aplicação distribuída com containers, mensageria, orquestração e elasticidade"
> **Data:** 20/10/2026
> **Elaboração:** planejamento feito com Claude Code e revisado de forma independente pelo OpenCode (gpt-6-astra). As divergências entre os dois estão na seção 9.

---

## 1. Ideia: "Agente de IA" como fila de processamento

O usuário clica em **"Agente de IA"**, cola uma *user story* ou um planejamento, escolhe a coluna de destino e envia. O pedido vira um **job assíncrono**: o Serviço A publica no RabbitMQ, o Serviço B (worker) chama um **LLM local**, transforma o texto em cartões e devolve o resultado **também pela fila**. O quadro mostra o job passando por *Na fila → Processando → Concluído*, e no fim aparecem os cartões novos.

**Parecer: a ideia é boa e cabe no enunciado.** O enunciado cita "processamento de documentos" e "geração de relatórios" como domínios possíveis, e gerar cartões a partir de texto é exatamente isso. Os motivos:

- **Separação natural:** A cuida do quadro (CRUD, banco) e B faz um trabalho pesado e lento (inferência). Ninguém precisa forçar uma divisão artificial.
- **A fila fica visível:** uma inferência leva segundos. Com B parado, os jobs se acumulam no RabbitMQ e são processados quando ele volta. É o experimento obrigatório da etapa 1, e acontece sozinho.
- **B é o candidato ideal para escalar:** os consumidores de uma *work queue* competem pelas mensagens, como mostra a Figura 3 do enunciado.

**O ponto que exige cuidado é o HPA por CPU** (seção 4). Se o modelo rodar no LM Studio do Mac, fora do pod, o worker passa o tempo esperando HTTP com a CPU parada, e o HPA não reage. O plano resolve isso rodando, no Kubernetes, um **modelo pequeno dentro do pod de B**.

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
| `llm` | Componente extra | **Compose:** LM Studio nativo no Mac (Qwen3-8B, melhor qualidade, usa a GPU via Metal). **Kubernetes:** sidecar Ollama dentro do pod de B, com um modelo pequeno em CPU (`qwen3:1.7b` ou `qwen2.5:1.5b-instruct`). Os dois expõem a API compatível com OpenAI, então o cliente é o mesmo e só a variável `LLM_BASE_URL` muda. |

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
                                    Serviço B ──HTTP──▶ LLM (LM Studio | sidecar Ollama)
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
  "model": "qwen3:1.7b", "durationMs": 8421,
  "payload": { "cards": [{ "title": "≤ 200 chars", "description": "≤ 160 chars | null" }] }
}
```

O LLM gera **apenas conteúdo** (título e descrição). IDs, posições e coluna ficam com A. A saída passa pelo mesmo `UpsertCardSchema` (os limites de 200/160 caracteres entram no prompt **e** na validação), e o modelo é chamado com `response_format: json_schema` quando o servidor suporta.

### 2.4 Topologia do RabbitMQ e garantias

| Item | Configuração |
|---|---|
| Exchanges | `taskflow.commands` e `taskflow.events` (direct, duráveis) |
| Filas | `ai.generate` e `ai.results`: *quorum*, duráveis, com `x-delivery-limit: 3` |
| DLQ | `ai.generate.dlq` e `ai.results.dlq` via `x-dead-letter-exchange` |
| Mensagens | `persistent: true`, publicação com *confirm channel* |
| Consumo | ack manual; `prefetch=1` em B (uma inferência por vez), `prefetch=10` em A |
| Falhas | Timeout do LLM é reentregue (até 3 vezes) e depois vai para a DLQ, com o job marcado `failed`. JSON inválido gera `failed` direto, sem retry. **Nada de `nack(requeue=true)` em laço.** |

A garantia é **"pelo menos uma vez"**. A aplica o resultado de forma idempotente: faz `select … for update` no job e ignora o evento se ele já for terminal. Os IDs dos cartões são determinísticos (UUID v5 de `jobId + índice`), então uma reentrega nunca duplica cartões.

### 2.5 Observabilidade

- O NGINX gera `$request_id` e envia `X-Request-Id`. A usa esse valor como `correlationId`, ele vai nos *headers* AMQP e B registra o mesmo id.
- Logs em JSON, uma linha por evento, com `ts, service, pod, correlationId, jobId, event`. Eventos: `http.received`, `job.created`, `msg.published`, `msg.consumed`, `llm.done`, `result.published`, `job.succeeded`.
- `docker compose logs -f | grep <correlationId>` mostra a operação inteira atravessando NGINX → A → RabbitMQ → B → A. Isso é exigido explicitamente na etapa 1.

---

## 3. Mudanças no repositório

```
kanban/
├── compose.yml                 # substitui docker-compose.yml (nome usado no enunciado)
├── .env.example                # credenciais de exemplo; .env real fica no .gitignore
├── nginx/
│   ├── Dockerfile              # multi-stage: build do web → nginx:alpine
│   └── default.conf            # / → estáticos, /api → api:3000, X-Request-Id
├── api/src/
│   ├── routes/aiJobs.ts        # POST/GET /api/ai/jobs
│   └── messaging/              # conexão AMQP, publicador (outbox), consumidor de resultados
├── api/migrations/006_ai_jobs.sql
├── worker/                     # Serviço B (novo workspace)
│   ├── Dockerfile
│   └── src/{main.ts, consumer.ts, llm.ts, prompt.ts, health.ts}
├── packages/shared/src/messages.ts
├── web/src/components/AiAgentDialog.tsx  (+ store/aiJobsStore.ts)
├── k8s/                        # manifests (ou kustomize)
│   ├── namespace.yaml, configmap.yaml, secret.example.yaml
│   ├── postgres.yaml, rabbitmq.yaml          # StatefulSet + PVC + Service
│   ├── api.yaml, worker.yaml, web.yaml       # Deployment + Service
│   ├── ingress.yaml, worker-hpa.yaml
├── scripts/load.sh             # gera N jobs pelo ponto de entrada
└── docs/{ARQUITETURA.md, EXPERIMENTOS.md}
```

**Dependências novas** (o `AGENTS.md` proíbe `npm install` sem autorização, então precisam de aprovação explícita): `amqplib` + `@types/amqplib` (api e worker). O cliente do LLM usa `fetch` nativo, sem SDK. O worker reaproveita `zod` e `@taskflow/shared`.

---

## 4. Kubernetes e o problema do HPA

| Recurso | Decisão |
|---|---|
| Cluster | **minikube** (`addons enable ingress metrics-server`) ou Docker Desktop + ingress-nginx. O metrics-server é obrigatório para o HPA. |
| A | `Deployment` com 2 réplicas + `Service` ClusterIP + probes em `/api/health` |
| B | `Deployment` com 2 réplicas, **pod = worker + sidecar Ollama** (modelo já embutido numa imagem própria, para não baixar 1 GB a cada pod novo). Sem Service: B só consome AMQP. |
| RabbitMQ / Postgres | `StatefulSet` com 1 réplica + PVC + Service. Limitação documentada: sem alta disponibilidade. |
| Configuração | `ConfigMap` (URLs, nomes de fila) e `Secret` criado por `kubectl create secret … --from-env-file=.env`. Nada de senha versionada. |
| Entrada | `Ingress` com `/` → web e `/api` → api |
| HPA | `autoscaling/v2`, alvo B, **min 1 / max 4, CPU 60%**, `scaleDown.stabilizationWindowSeconds: 60` (para o retorno ser visível em sala) |

**Por que o sidecar resolve o HPA:** a utilização de CPU que o HPA calcula soma todos os containers do pod. Com a inferência dentro do pod, a fila cheia faz cada réplica usar 100% da CPU (`requests.cpu` do Ollama ≈ 1000m), o HPA cria pods, os novos consumidores pegam mensagens da fila, e quando a fila esvazia a CPU cai e as réplicas diminuem. **A CPU medida é o trabalho real do serviço**, não um cálculo artificial.

Custo: cerca de 1,2 GB de RAM por réplica com um modelo de 1,5–1,7B (q4). Com no máximo 4 réplicas, a VM do minikube precisa de cerca de 8 GB. Um modelo pequeno gera cartões piores que o Qwen3-8B, por isso o Compose continua usando o LM Studio pela qualidade. As duas configurações são documentadas.

**Plano B:** se o sidecar ficar pesado demais no notebook, o worker ganha `LLM_PROVIDER=heuristic`, que quebra o texto em cartões por regras (tópicos, critérios de aceite) com processamento CPU-bound real em `worker_threads`. É a sugestão do OpenCode (seção 9).

**Opcional (atividade avançada):** KEDA com o *scaler* de RabbitMQ (tamanho da fila `ai.generate`) como complemento ao HPA por CPU, nunca como substituto.

**Nota:** o projeto ingress-nginx entrou em aposentadoria (manutenção mínima desde março de 2026). Como o enunciado o exige, ele continua sendo usado, e a limitação é registrada na documentação.

---

## 5. Rastreabilidade: requisito → como é atendido

| Requisito do enunciado | Atendido por | Evidência na demo |
|---|---|---|
| 4 containers independentes (NGINX, A, B, RabbitMQ) | `compose.yml` (+ db) | `docker compose ps` |
| NGINX é o único acesso | Só `nginx` tem `ports:`; api/worker/db/rabbit apenas em `networks:` | `curl localhost:3000` falha; `curl localhost:8080/api/board` funciona |
| A e B sem endereço um do outro | Nenhuma variável de ambiente aponta de A para B nem de B para A; resultado volta por fila | `docker compose config` + grep no código |
| A produtor / B consumidor | `cards.generate` / `ai.generate` | Logs com `correlationId` |
| A continua com B parado; mensagens persistem | Fila quorum durável + mensagens persistentes + ack manual | `docker compose stop worker` → envia 3 jobs → fila = 3 → `start` → fila = 0 |
| Logs rastreáveis ponta a ponta | `X-Request-Id` → `correlationId` | `grep <id>` em todos os serviços |
| RabbitMQ admin justificado | UI de gestão só via `127.0.0.1:15672` em perfil `debug` do compose (ou `kubectl port-forward`) | Explicação na documentação |
| Credenciais fora do Git | `.env` / `Secret` | `.env.example` versionado |
| Deployments + Services + Ingress NGINX | `k8s/` | `kubectl get deploy,svc,ingress` |
| RabbitMQ com estado | StatefulSet + PVC, limitações documentadas | Deletar o pod do rabbit; mensagens continuam lá |
| Self-healing | B com 2 réplicas | `kubectl delete pod worker-…` + `kubectl get pods -w` |
| Escala manual | `kubectl scale deploy/worker --replicas=3` | Logs mostrando 3 pods diferentes consumindo |
| Elasticidade (HPA por CPU) | `worker-hpa.yaml` + `scripts/load.sh` | `kubectl get hpa -w`: sobe até 4 e volta a 1 |
| Documentação da arquitetura real | `docs/ARQUITETURA.md` | Diagramas do que foi implementado |
| Histórico Git do grupo | Um branch por ticket, PRs por integrante | `git log --author` |

---

## 6. Tickets

Cada ticket lista o que **pode ser alterado**, conforme o `AGENTS.md`. Ordem sugerida: T1 → T2 → T3 fecham a **etapa 1**, T4–T6 a **etapa 2** e T7–T8 a **etapa 3**.

| # | Ticket | Pode alterar | Critério de aceite |
|---|---|---|---|
| **T0** | Decisões e dependências | `docs/` | Grupo aprova este plano; `amqplib` autorizado; branch/repositório definidos (seção 8) |
| **T1** | Contratos + jobs em A | `packages/shared/src/messages.ts`, `api/migrations/006_ai_jobs.sql`, `api/src/routes/aiJobs.ts`, `api/src/messaging/*`, `api/test/*` | Schemas com testes válidos/inválidos; `POST` idempotente (mesma chave → mesmo job); com o broker fora, o job fica `pending_publish` e é publicado quando o broker volta |
| **T2** | Worker (Serviço B) | `worker/**` | Consome, chama o LLM, valida, publica resultado; ack só depois do confirm; timeout → retry → DLQ; JSON inválido → `failed`; testes com LLM falso |
| **T3** | Compose + NGINX + logs | `compose.yml`, `nginx/**`, `.env.example`, `.gitignore`, Dockerfiles | Só o NGINX publica porta; app inteira funciona por ele; `grep correlationId` mostra os 5 saltos; experimento "B parado" reproduzível |
| **T4** | UI do Agente de IA | `web/src/components/AiAgentDialog.tsx`, `web/src/store/aiJobsStore.ts`, `web/src/App.tsx`, testes | Botão abre diálogo; status em tempo quase real; o quadro atualiza sem perder edições locais (cuidado com `syncEngine.ts`, que adia snapshots com pendências) |
| **T5** | Imagens de produção | Dockerfiles | Imagens sem *bind mounts* e sem `vite dev`; web em build estático |
| **T6** | Manifests Kubernetes | `k8s/**` | Acesso pelo Ingress; probes ok; B com 2 réplicas; deletar pod → reposição; reiniciar RabbitMQ preserva mensagens |
| **T7** | Sidecar LLM + HPA | `k8s/worker.yaml`, `k8s/worker-hpa.yaml`, `worker/ollama.Dockerfile`, `scripts/load.sh` | Com carga, HPA escala 1 → 4; sem carga, volta a 1; evidências (prints/vídeo) em `docs/EXPERIMENTOS.md` |
| **T8** | Documentação final | `docs/ARQUITETURA.md`, `docs/EXPERIMENTOS.md`, `README.md` | Outro integrante sobe tudo do zero só lendo o README; papel de cada componente, formato das mensagens, rede, estratégia do RabbitMQ e decisões da migração explicados |

---

## 7. Roteiro da demonstração final (~12 min)

1. **Arquitetura (1 min):** diagrama real; mostrar que A e B não têm a URL um do outro.
2. **Entrada única (1 min):** `curl` direto na api falha; pelo NGINX funciona.
3. **Fluxo feliz (2 min):** colar uma user story no "Agente de IA", acompanhar o `jobId` nos logs (NGINX → A → publicação → B → resultado → A) e ver os cartões aparecerem.
4. **Falha controlada (2 min):** `docker compose stop worker`, enviar 3 histórias (A aceita todas), mostrar a fila com 3 mensagens, `start worker`, ver a fila esvaziar. **Explicar:** fila durável, mensagem persistente, ack manual.
5. **Kubernetes + self-healing (2 min):** tudo pelo Ingress; `kubectl delete pod` de um worker; o Deployment repõe a réplica. Se o pod morreu no meio de um job, a mensagem sem ack é reentregue e não duplica cartões.
6. **Escala manual (1 min):** `kubectl scale --replicas=3`; logs com 3 hostnames diferentes dividindo a fila.
7. **Elasticidade (3 min):** `scripts/load.sh 40`; `kubectl get hpa -w` mostra a CPU subindo e as réplicas indo de 1 a 4; com a carga parada, a redução começa depois da janela de estabilização.
8. **Fechamento:** escalabilidade ≠ elasticidade; limitações (RabbitMQ/Postgres de instância única, modelo pequeno no cluster, ingress-nginx aposentado).

---

## 8. Decisões em aberto (para o grupo)

1. **Repositório:** este repositório é a entrega de Mobile. Sugestão: criar um repositório (ou *fork*) do grupo para Nuvem a partir do `main`, para que o histórico mostre a participação de todos sem misturar as disciplinas.
2. **Dependência `amqplib`:** precisa de autorização (regra do `AGENTS.md`).
3. **Cluster:** minikube (recomendado, addons prontos) ou Docker Desktop Kubernetes.
4. **Modelo do sidecar:** testar `qwen3:1.7b` × `qwen2.5:1.5b-instruct` em latência por job (alvo: menos de 20 s em CPU) e qualidade do JSON.

---

## 9. Revisão do OpenCode: onde concordamos e onde não

**Concordância total:** resultado volta por fila (B nunca chama A); só A grava no banco; publisher confirms + ack tardio + idempotência por `jobId`; polling de status; limites de 200/160 caracteres no prompt e na validação; risco do `syncEngine.ts` ao aplicar cartões vindos do servidor; credenciais fixas atuais no compose precisam sair; RabbitMQ de instância única documentado como limitação.

**Divergência: como demonstrar o HPA.**
- *OpenCode:* manter o LM Studio no Mac também no cluster e criar um **modo benchmark** com cálculo CPU-bound sintético no worker para o experimento.
- *Este plano:* rodar a **inferência real dentro do pod** (sidecar Ollama com modelo pequeno). A CPU que o HPA mede é o trabalho de verdade do Serviço B, e a "carga artificial" do enunciado vira simplesmente "muitos jobs na fila". Isso é mais fácil de defender na arguição. O modo heurístico/benchmark fica como **plano B** se faltar RAM.

**Ajuste incorporado da revisão:** outbox simplificada (job `pending_publish` + republicador) em vez de publicar direto no handler HTTP, para não perder pedidos se A cair entre o commit e a publicação.
