#!/usr/bin/env bash
# Etapa 3: envia N pedidos ao Agente de IA (padrão 30) para encher a fila ai.generate
# e fazer o HPA escalar o worker. Acompanhe em outro terminal:
#   kubectl -n taskflow get hpa worker -w
set -euo pipefail
cd "$(dirname "$0")/.."
N=${1:-30}
NS=taskflow
kubectl -n "$NS" delete job load --ignore-not-found >/dev/null
sed "s/value: \"30\"/value: \"$N\"/" k8s/autoscaling/load-job.yaml | kubectl create -f -
kubectl -n "$NS" wait --for=condition=complete job/load --timeout=5m
kubectl -n "$NS" logs job/load | tail -1
echo "Fila e HPA:  kubectl -n $NS get hpa worker -w   |   kubectl -n $NS get pods -l app=worker -w"
