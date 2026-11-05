# syntax=docker/dockerfile:1
#
# Letter by Letter. The server is TypeScript that Node 24 runs directly (type
# stripping), so the runtime image holds the server source, the built client
# and one production dependency (ws).

ARG NODE_VERSION=24-alpine

FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN npx tsc --noEmit && npm run build

FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:${NODE_VERSION} AS runtime
ARG IMAGE_REVISION=unknown
LABEL org.opencontainers.image.title="Letter by Letter" \
      org.opencontainers.image.source="https://github.com/opgrsankkar/letter-by-letter" \
      org.opencontainers.image.revision="${IMAGE_REVISION}"
ENV NODE_ENV=production \
    PORT=4000
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src/server ./src/server
COPY --chown=node:node src/shared ./src/shared
COPY --from=build --chown=node:node /app/dist/client ./dist/client
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/server/main.ts"]
