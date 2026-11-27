#!/bin/sh
# Inicia o Ollama e fixa o número de threads de inferência do modelo antes de
# marcar o container como pronto (/tmp/ready, usado pelas healthchecks/probes).
#
# Por quê: sem isso o Ollama abre uma thread por núcleo que o container enxerga.
# Medido num Mac com 10 núcleos (4 de desempenho + 6 de eficiência): 10 threads
# geram 0,4 token/s, 4 threads geram 43 tokens/s. No Kubernetes, várias réplicas
# no mesmo nó também disputariam os núcleos. Padrão: 4 (o Kubernetes usa 2).
set -e

threads=${OLLAMA_NUM_THREADS:-4}
cores=$(nproc)
[ "$threads" -gt "$cores" ] && threads=$cores

ollama serve &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null; wait "$pid"; exit 0' TERM INT

until ollama list >/dev/null 2>&1; do sleep 1; done
printf 'FROM %s\nPARAMETER num_thread %s\n' "$OLLAMA_MODEL" "$threads" > /tmp/Modelfile
ollama create "$OLLAMA_MODEL" -f /tmp/Modelfile >/dev/null
echo "modelo $OLLAMA_MODEL configurado com $threads threads"
touch /tmp/ready

wait "$pid"
