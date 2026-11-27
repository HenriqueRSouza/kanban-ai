FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY web/package.json ./web/package.json
COPY api/package.json ./api/package.json
COPY worker/package.json ./worker/package.json
RUN npm ci
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
# Imagem de produção: sem "tsx watch" e sem bind mounts. O node é o processo
# principal (PID 1), então recebe o SIGTERM do Docker/Kubernetes direto e o
# desligamento gracioso do serviço roda. Sem root dentro do container.
USER node
WORKDIR /app/worker
CMD ["node", "--import", "tsx", "src/main.ts"]
