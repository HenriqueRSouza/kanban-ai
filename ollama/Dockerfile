# Ollama com o modelo já embutido: funciona sem internet depois do build e não
# baixa ~1,4 GB a cada container novo (importante para o HPA no Kubernetes).
FROM ollama/ollama:0.40.7
ARG OLLAMA_MODEL=qwen3:1.7b
RUN ollama serve >/tmp/ollama.log 2>&1 & \
    pid=$!; \
    for i in $(seq 1 30); do ollama list >/dev/null 2>&1 && break; sleep 1; done; \
    ollama pull "$OLLAMA_MODEL" && kill "$pid"
# Mantém o modelo carregado na memória entre pedidos (o primeiro carregamento leva alguns segundos).
ENV OLLAMA_KEEP_ALIVE=1h
ENV OLLAMA_MODEL=$OLLAMA_MODEL
COPY --chmod=755 entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD []
EXPOSE 11434
