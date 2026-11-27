#!/usr/bin/env bash
# Remove a aplicação do cluster. Com --all, apaga também o cluster minikube.
set -euo pipefail
cd "$(dirname "$0")/.."
PROFILE=${MINIKUBE_PROFILE:-kanban-ai}

if [ "${1:-}" = "--all" ]; then
  minikube -p "$PROFILE" delete
else
  # Apagar o namespace remove também os volumes (PVCs) do Postgres e do RabbitMQ.
  kubectl --context "$PROFILE" delete namespace taskflow --ignore-not-found
  echo "Aplicação removida. O cluster continua no ar; use --all para apagá-lo."
fi
