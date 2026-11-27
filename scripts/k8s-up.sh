#!/usr/bin/env bash
# Sobe o TaskFlow distribuído no Kubernetes local (minikube), do zero, com um comando.
# Pré-requisitos: Docker, minikube e kubectl; .env criado (cp .env.example .env).
# Variáveis opcionais: MINIKUBE_PROFILE, MINIKUBE_MEMORY, MINIKUBE_CPUS, K8S_PORT.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE=${MINIKUBE_PROFILE:-kanban-ai}
# "max" = toda a memória do Docker Desktop. Com o driver docker, o Kubernetes
# enxerga a memória da VM inteira como capacidade do nó; um limite menor faz o
# agendador aceitar pods que não cabem e o nó trava sem memória.
MEMORY=${MINIKUBE_MEMORY:-max}
# "max" = todos os núcleos do Docker. Cada réplica do worker usa 2 (Ollama).
CPUS=${MINIKUBE_CPUS:-max}
PORT=${K8S_PORT:-8090}
NS=taskflow

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

for cmd in docker minikube kubectl; do
  command -v "$cmd" >/dev/null || { echo "Falta o comando '$cmd'. Veja o README (seção Kubernetes)."; exit 1; }
done
[ -f .env ] || { echo "Crie o .env primeiro: cp .env.example .env"; exit 1; }
set -a; . ./.env; set +a

# Provedor de LLM: Ollama (padrão) roda como sidecar no pod do worker (k8s/base);
# LM Studio e OpenRouter ficam fora do cluster (overlay external-llm).
PROVIDER=${LLM_PROVIDER:-ollama}
OVERLAY_DIR=k8s/overlays/external-llm
case "$PROVIDER" in
  ollama)
    KUSTOMIZE_DIR=k8s/base
    IMAGES="api worker web ollama" ;;
  lmstudio|openrouter)
    KUSTOMIZE_DIR=$OVERLAY_DIR
    IMAGES="api worker web"
    if [ "$PROVIDER" = lmstudio ]; then
      # Dentro do minikube a máquina host é host.minikube.internal (não host.docker.internal).
      BASE_URL=${LLM_BASE_URL:-http://host.minikube.internal:1234/v1}
      BASE_URL=${BASE_URL/host.docker.internal/host.minikube.internal}
      MODEL=${LLM_MODEL:-qwen/qwen3-8b}
    else
      [ -n "${LLM_API_KEY:-}" ] || { echo "LLM_PROVIDER=openrouter exige LLM_API_KEY no .env."; exit 1; }
      [ -n "${LLM_MODEL:-}" ] || { echo "LLM_PROVIDER=openrouter exige LLM_MODEL no .env."; exit 1; }
      BASE_URL=${LLM_BASE_URL:-https://openrouter.ai/api/v1}
      MODEL=$LLM_MODEL
    fi
    # O token não entra aqui: vai para o Secret.
    printf 'LLM_PROVIDER=%s\nLLM_MODEL=%s\nLLM_BASE_URL=%s\n' "$PROVIDER" "$MODEL" "$BASE_URL" > "$OVERLAY_DIR/llm.env" ;;
  *)
    echo "LLM_PROVIDER inválido no .env: '$PROVIDER' (use ollama, lmstudio ou openrouter)."; exit 1 ;;
esac

step "Cluster minikube (perfil $PROFILE, ${MEMORY} de RAM, ${CPUS} CPUs)"
if minikube -p "$PROFILE" status --format '{{.Host}}' 2>/dev/null | grep -q Running; then
  echo "já está rodando"
else
  minikube start -p "$PROFILE" --driver=docker --memory="$MEMORY" --cpus="$CPUS"
fi
kubectl config use-context "$PROFILE" >/dev/null

step "Addons: NGINX Ingress Controller e metrics-server (usado pelo HPA)"
minikube -p "$PROFILE" addons enable ingress
minikube -p "$PROFILE" addons enable metrics-server
# O navegador manda para "localhost" os cookies de outros apps já abertos nesse
# endereço; com o padrão de 8 KB o Ingress responde "400 Cookie Too Large".
kubectl -n ingress-nginx patch configmap ingress-nginx-controller --type merge \
  -p '{"data":{"large-client-header-buffers":"4 32k"}}'

step "Imagens: build no Docker local e cópia para dentro do minikube"
# As mesmas imagens do Compose. O build roda na arquitetura desta máquina
# (Intel/AMD ou ARM), então nada depende de imagem publicada.
if [ "$PROVIDER" = ollama ]; then
  docker compose --profile ollama build
else
  docker compose build nginx api worker
fi
for image in $IMAGES; do
  echo "carregando kanban-ai/$image:local…"
  minikube -p "$PROFILE" image load "kanban-ai/$image:local"
done

# Reexecução: as imagens novas têm a mesma tag (:local), então o Kubernetes não
# percebe a mudança sozinho; o rollout é forçado depois do apply.
EXISTING=false
kubectl get namespace "$NS" >/dev/null 2>&1 && EXISTING=true

step "Namespace, Secret (a partir do .env) e migrations do banco"
kubectl apply -f k8s/base/namespace.yaml
kubectl -n "$NS" create secret generic taskflow-secrets \
  --from-literal=POSTGRES_USER="$POSTGRES_USER" \
  --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  --from-literal=RABBITMQ_USER="$RABBITMQ_USER" \
  --from-literal=RABBITMQ_PASSWORD="$RABBITMQ_PASSWORD" \
  --from-literal=LLM_API_KEY="${LLM_API_KEY:-}" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NS" create configmap postgres-migrations --from-file=api/migrations \
  --dry-run=client -o yaml | kubectl apply -f -

step "Manifestos ($KUSTOMIZE_DIR, LLM: $PROVIDER)"
kubectl apply -k "$KUSTOMIZE_DIR"

if [ "$EXISTING" = true ]; then
  kubectl -n "$NS" rollout restart deployment/api deployment/web deployment/worker
fi

step "Esperando os componentes ficarem prontos"
for resource in statefulset/postgres statefulset/rabbitmq deployment/api deployment/web deployment/worker; do
  kubectl -n "$NS" rollout status "$resource" --timeout=10m
done
kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=5m

step "Pronto"
kubectl -n "$NS" get pods -o wide
cat <<MSG

Acesse pelo Ingress (deixe este comando rodando em outro terminal):
  kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller $PORT:80
  → http://localhost:$PORT

Experimentos (passo a passo em docs/EXPERIMENTOS.md):
  self-healing:  kubectl -n $NS delete pod \$(kubectl -n $NS get pods -l app=worker -o name | head -1); kubectl -n $NS get pods -l app=worker -w
  escala manual: kubectl -n $NS scale deployment/worker --replicas=1   (e depois --replicas=2)
  elasticidade:  kubectl apply -f k8s/autoscaling/hpa.yaml; ./scripts/load.sh 30; kubectl -n $NS get hpa worker -w
  painel do RabbitMQ: kubectl -n $NS port-forward svc/rabbitmq 15672 → http://localhost:15672
Para remover: ./scripts/k8s-down.sh
MSG
if [ "$PROVIDER" != ollama ]; then
  echo
  echo "Atenção: com $PROVIDER a inferência roda fora do pod e o HPA por CPU não reage."
  echo "Para a demonstração de elasticidade, use LLM_PROVIDER=ollama."
fi
