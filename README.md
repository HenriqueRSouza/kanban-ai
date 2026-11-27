# TaskFlow Kanban

Quadro Kanban no estilo Trello, *mobile-first*, desenvolvido com **React + TypeScript** para a disciplina de Desenvolvimento Mobile da Universidade Presbiteriana Mackenzie.

O usuário cria colunas e cartões, arrasta tudo com mouse, toque ou teclado, edita títulos direto no quadro, organiza com etiquetas coloridas e continua trabalhando mesmo sem internet: as alterações são sincronizadas com o servidor quando a conexão volta.

![Quadro TaskFlow](docs/screenshot.png)

**Autor:** Henrique Ribeiro — RA 10401770

---

## Projeto de Serviços de Nuvem

Este repositório também é o projeto da disciplina **Serviços de Nuvem**
(aplicação distribuída com containers, mensageria, orquestração e elasticidade).
O botão **"Agente de IA"** transforma um texto em cartões: o **Serviço A** (`api/`)
publica o pedido no **RabbitMQ**, o **Serviço B** (`worker/`) consome e gera os
cartões com um modelo de linguagem local (Ollama) e devolve o resultado também
pela fila. A e B nunca se chamam diretamente, e o **NGINX** é o único ponto de entrada.

| Etapa | Como rodar | Detalhes |
|---|---|---|
| 1. Docker Compose | `docker compose up --build` → http://localhost:8080 | [Como executar](#como-executar) |
| 2. Kubernetes | `./scripts/k8s-up.sh` (Windows: `.\scripts\k8s-up.ps1`) | [Kubernetes](#kubernetes-etapas-2-e-3) |
| 3. Elasticidade (HPA) | `kubectl apply -f k8s/autoscaling/hpa.yaml` e `./scripts/load.sh 30` | [Kubernetes](#kubernetes-etapas-2-e-3) |

- **Arquitetura implementada** (componentes, fluxo, mensagens, rede, RabbitMQ, decisões do Kubernetes): [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md)
- **Experimentos passo a passo**, com os resultados observados: [`docs/EXPERIMENTOS.md`](docs/EXPERIMENTOS.md)

---

## Funcionalidades

| | Funcionalidade |
|---|---|
| 🗂️ | Criar, renomear e excluir **colunas** e **cartões** |
| ✏️ | **Edição inline** de títulos (clique → digite → Enter salva / Esc cancela) |
| ↕️ | **Drag-and-drop** de cartões (na mesma coluna e entre colunas) e de colunas |
| 📱 | Arrasto por **toque** (segurar ~0,2 s) sem atrapalhar a rolagem do celular |
| ⌨️ | Arrasto por **teclado** (Tab → Espaço → setas → Espaço) com anúncios para leitor de tela |
| 🏷️ | **Etiquetas** coloridas: criar, atribuir, remover e **filtrar** o quadro por etiqueta |
| 📝 | **Painel de detalhes** do cartão: descrição, etiquetas, datas e exclusão |
| 🕓 | **Histórico de movimentação** de cada cartão, gravado pelo banco: criação e cada troca de coluna, com data e hora |
| 💾 | Persistência no **`localStorage`** (o quadro abre instantaneamente) |
| ☁️ | Sincronização com **API REST + PostgreSQL**, com **modo offline** e reenvio automático |
| 🐳 | Tudo sobe com **um comando** via Docker Compose |

## Como executar

Pré-requisito: [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```bash
git clone https://github.com/HenriqueRSouza/kanban-ai.git
cd kanban-ai
cp .env.example .env          # já vem pronto para o Ollama local; troque as senhas se quiser
docker compose up --build     # o primeiro build leva alguns minutos (imagem do modelo, ~1,4 GB)
```

A aplicação fica em **http://localhost:8080**. O NGINX é o único ponto de entrada: a API, o banco, o RabbitMQ, o worker e o Ollama ficam só na rede interna. Na primeira execução o banco é criado com um quadro de exemplo.

| Container | Papel |
|---|---|
| `nginx` | Entrada única: serve o front e encaminha `/api` para a API |
| `api` | Serviço A: CRUD do quadro e produtor dos pedidos do Agente de IA |
| `worker` | Serviço B: consome os pedidos e gera os cartões com o LLM |
| `rabbitmq` | Broker entre A e B (filas duráveis) |
| `db` | PostgreSQL |
| `ollama` | LLM local com o modelo `qwen3:1.7b` embutido (perfil `ollama`) |

O provedor do Agente de IA (Ollama, LM Studio ou OpenRouter) é escolhido no `.env`; as três configurações estão comentadas no `.env.example`.

- **Parar:** `docker compose down`
- **Apagar também os dados:** `docker compose down -v`
- **Painel do RabbitMQ** (só nesta máquina, para desenvolvimento e demonstração): `docker compose -f compose.yml -f compose.debug.yml up -d` e abra http://localhost:15672 com o usuário e a senha do `.env`
- **Seguir uma operação nos logs:** `docker compose logs -f | grep <X-Request-Id>` (o id volta no header `X-Request-Id` de toda resposta)
- **Testar no celular** (mesma rede Wi-Fi): acesse `http://<IP-do-computador>:8080` — no macOS o IP aparece com `ipconfig getifaddr en0`.

> **Banco criado antes de alguma migration?** O PostgreSQL só executa as migrations na criação do banco. Aplique a que faltar (todas podem ser reaplicadas sem problema), por exemplo:
> ```bash
> docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < api/migrations/006_ai_jobs.sql
> ```

### Kubernetes (etapas 2 e 3)

Pré-requisitos: Docker Desktop, [minikube](https://minikube.sigs.k8s.io/docs/start/) e
[kubectl](https://kubernetes.io/docs/tasks/tools/), com cerca de **8 GB de RAM** livres
para o Docker (cada réplica do worker usa ~2 GB; em 8 GB cabem 2). Não precisa de internet depois do primeiro build nem de conta em nenhum serviço.

```bash
cp .env.example .env               # se ainda não existir
./scripts/k8s-up.sh                # Windows (PowerShell): .\scripts\k8s-up.ps1
```

O script cria o cluster minikube (perfil `kanban-ai`), liga os addons `ingress` e
`metrics-server`, constrói as imagens e as carrega no cluster, cria o Secret a
partir do `.env`, aplica `k8s/base` e espera tudo ficar pronto. Pode ser executado
de novo a qualquer momento (atualiza as imagens e reinicia os pods).

Acesso pelo Ingress (deixe rodando em outro terminal):

```bash
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 8090:80   # → http://localhost:8090
```

| Experimento | Comando |
|---|---|
| Estado do cluster | `kubectl -n taskflow get deploy,sts,svc,ingress,pods` |
| Self-healing | `kubectl -n taskflow delete pod <um-pod-worker>` e `kubectl -n taskflow get pods -l app=worker -w` |
| Escala manual | `kubectl -n taskflow scale deployment/worker --replicas=1` e depois `--replicas=2` |
| Elasticidade | `kubectl apply -f k8s/autoscaling/hpa.yaml`, `./scripts/load.sh 30` e `kubectl -n taskflow get hpa worker -w` |
| Painel do RabbitMQ | `kubectl -n taskflow port-forward svc/rabbitmq 15672` → http://localhost:15672 |
| Remover | `./scripts/k8s-down.sh` (só a aplicação) ou `./scripts/k8s-down.sh --all` (apaga o cluster) |

O roteiro completo, com o que observar em cada passo, está em [`docs/EXPERIMENTOS.md`](docs/EXPERIMENTOS.md).

### Sem Docker (opcional)

Requer Node.js 22, um PostgreSQL com as migrations de `api/migrations/` aplicadas e, para o Agente de IA, um RabbitMQ (as variáveis estão no fim do `.env.example`).

```bash
npm install
DATABASE_URL=postgres://<usuario>:<senha>@localhost:5432/taskflow npm run dev:api
npm run dev:web
```

## Testes e qualidade

```bash
npm run typecheck                 # TypeScript estrito nos 3 pacotes
npm test                          # testes unitários e de componentes (Vitest)
npm run test:coverage -w web      # cobertura do front-end
DATABASE_URL=postgres://taskflow:taskflow@localhost:5432/taskflow npm test -w api   # API contra o banco real
```

- **TypeScript `strict`** em todo o projeto, sem `any`.
- Dados externos (corpo HTTP, `localStorage`, respostas da API) são **validados com Zod** usando os mesmos schemas no front e no back.
- Desempenho medido com um quadro de **200 cartões**: arrasto a **60 fps** no build de produção (abra `http://localhost:5173/?seed=200` em desenvolvimento para gerar esse quadro).

## Arquitetura

```
                       ┌─────────────────────── rede interna ────────────────────────┐
 Navegador ──▶ NGINX ──┼─▶ api (Serviço A) ──▶ RabbitMQ ──▶ worker (Serviço B) ──▶ Ollama │
   (único acesso)      │        │      ▲                         │                    │
                       │        ▼      └──── resultado pela fila ┘                    │
                       │    PostgreSQL                                                │
                       └──────────────────────────────────────────────────────────────┘
   No navegador: localStorage (quadro + fila de alterações pendentes, modo offline)
```

Detalhes da arquitetura distribuída em [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md).

| Camada | Tecnologias |
|---|---|
| Front-end | Vite, React 19, TypeScript, Tailwind CSS v4 |
| Estado global | Zustand (com `persist` para o `localStorage`) |
| Drag-and-drop | @dnd-kit/core + @dnd-kit/sortable |
| Validação | Zod (pacote compartilhado `@taskflow/shared`) |
| Back-end | Node.js 22, Express 5, `pg` (SQL escrito à mão) |
| Banco | PostgreSQL 16 |
| Testes | Vitest, Testing Library, Supertest |
| Mensageria | RabbitMQ 4 (filas quorum duráveis), `amqplib` |
| Agente de IA | Ollama com `qwen3:1.7b` (ou LM Studio / OpenRouter) |
| Infraestrutura | Docker, Docker Compose, Kubernetes (minikube), NGINX Ingress, HPA |

### Estrutura de pastas

```
kanban-ai/
├── packages/shared/     # schemas Zod: dados do quadro e contratos das mensagens (messages.ts)
├── web/src/             # front-end React (components, hooks, store, data, lib)
├── api/                 # Serviço A: rotas, outbox e mensageria (src/messaging), migrations SQL
├── worker/              # Serviço B: consumidor, cliente do LLM e prompt
├── nginx/               # imagem do ponto de entrada (front estático + proxy /api)
├── ollama/              # imagem do Ollama com o modelo embutido
├── k8s/base/            # manifestos Kubernetes (kustomize)
├── k8s/autoscaling/     # HPA do worker e Job gerador de carga (etapa 3)
├── k8s/overlays/        # external-llm: worker sem sidecar (LM Studio / OpenRouter)
├── scripts/             # k8s-up, k8s-down e load (bash e PowerShell)
├── docs/                # ARQUITETURA.md, EXPERIMENTOS.md e planejamentos
└── compose.yml          # etapa 1 (+ compose.debug.yml e compose.external-llm.yml)
```

## Decisões técnicas

**Estado normalizado.** O quadro fica no store como objetos indexados por ID (`cards[id]`) mais listas de IDs com a ordem (`cardOrder[colunaId]`). Mover um cartão altera só duas listas, e cada componente assina apenas o seu pedaço do estado: editar um cartão re-renderiza só aquele cartão.

**Ordenação fracionária.** Cada item tem um `position` numérico. Soltar um cartão entre outros dois (1024 e 2048) dá a ele 1536: **uma única** escrita no banco por movimento, em vez de renumerar a coluna inteira.

**Atualização otimista e modo offline.** A tela muda na hora; o motor de sincronização compara o estado anterior com o novo (por referência, já que o store é imutável), coloca as entidades alteradas numa fila salva no `localStorage` e envia ao servidor. Sem conexão, a fila espera e é reenviada automaticamente (com intervalos crescentes ou assim que o navegador volta a ficar online).

**API idempotente.** As escritas usam `PUT /api/<recurso>/:id` com o objeto completo (cria ou atualiza). Reenviar a mesma requisição após uma falha de rede é seguro.

**Camada de dados desacoplada.** Os componentes não conhecem a API: tudo passa pela interface `BoardRepository`. Migrar para outro back-end (ex.: Supabase) exige apenas uma nova implementação dessa interface.

**Histórico de movimentação no banco.** Um *trigger* do PostgreSQL (`api/migrations/003_card_history.sql`) grava na tabela `card_events` a criação de cada cartão e toda troca de coluna, independentemente de quem fez a alteração. O evento guarda o nome das colunas daquele momento (o histórico continua correto se a coluna for renomeada ou excluída) e a hora em que a ação aconteceu no aparelho — um cartão movido offline às 10h e sincronizado às 15h fica registrado às 10h.

```sql
select to_char(occurred_at, 'DD/MM HH24:MI') as quando, type, from_column_title, to_column_title
from card_events where card_id = '<id do cartão>' order by occurred_at;
```

**Acessibilidade.** Arrasto por teclado com instruções e anúncios em português, contorno de foco visível, painel de detalhes com `<dialog>` nativo (foco preso e Esc), respeito à preferência de "reduzir movimento" do sistema.

## API

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/health` | Verifica a API e a conexão com o banco |
| GET | `/api/board` | Quadro completo (colunas, cartões e etiquetas) |
| PUT / DELETE | `/api/columns/:id` | Cria/atualiza ou exclui uma coluna (e seus cartões) |
| PUT / DELETE | `/api/cards/:id` | Cria/atualiza ou exclui um cartão (inclui suas etiquetas) |
| GET | `/api/cards/:id/history` | Histórico de movimentação do cartão (criação e trocas de coluna) |
| PUT / DELETE | `/api/tags/:id` | Cria/atualiza ou exclui uma etiqueta |
| POST | `/api/ai/jobs` | Cria um pedido ao Agente de IA (`202`; idempotente pela `idempotencyKey`) |
| GET | `/api/ai/jobs/:id` | Status do pedido: `pending_publish`, `queued`, `processing`, `succeeded` ou `failed` |

Erros retornam `{ "error": "mensagem" }` com status `400` (dados inválidos), `409` (coluna ou etiqueta inexistente) ou `500`.
