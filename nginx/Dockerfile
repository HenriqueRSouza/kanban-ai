# Etapa 1: build do front (React + Vite) dentro do monorepo.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY web/package.json ./web/package.json
COPY api/package.json ./api/package.json
COPY worker/package.json ./worker/package.json
RUN npm ci
COPY packages/shared ./packages/shared
COPY web ./web
RUN npm run build -w web

# Etapa 2: só o NGINX e os arquivos estáticos; nada de Node na imagem final.
FROM nginx:1.27-alpine
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
