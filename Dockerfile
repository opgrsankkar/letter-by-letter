# syntax=docker/dockerfile:1
#
# Letter by Letter - production multi-stage image.
#
# Stages
#   1. client-builder   : npm ci + vite build  -> client/dist
#   2. server-builder   : npm ci + tsc build   -> server/dist
#   3. server-prod-deps : npm ci --omit=dev    -> production node_modules
#   4. runtime          : non-root node, only production artifacts
#
# The runtime image intentionally preserves the on-disk source layout
# (server/ and client/ side by side) because server/dist/index.js resolves the
# static client at path.resolve(__dirname, '../../client/dist').
#
ARG NODE_VERSION=24-alpine

###############################################################################
# 1) Client build
###############################################################################
FROM node:${NODE_VERSION} AS client-builder
WORKDIR /app/client

# Install from the lockfile first so dependency layers cache independently of
# source edits. package-lock.json ships with the real source tree.
COPY client/package.json client/package-lock.json ./
RUN npm ci

# node_modules/ and dist/ are excluded via .dockerignore, so this cannot clobber
# the freshly installed dependencies or ship a stale build.
COPY client/ ./
RUN npm run build

###############################################################################
# 2) Server build (TypeScript -> dist)
###############################################################################
FROM node:${NODE_VERSION} AS server-builder
WORKDIR /app/server

COPY server/package.json server/package-lock.json ./
RUN npm ci

COPY server/ ./
RUN npm run build

###############################################################################
# 3) Production-only server dependencies
###############################################################################
FROM node:${NODE_VERSION} AS server-prod-deps
WORKDIR /app/server

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

###############################################################################
# 4) Minimal non-root runtime
###############################################################################
FROM node:${NODE_VERSION} AS runtime

# OCI metadata. All optional: pass with
#   docker build --build-arg IMAGE_REVISION=$(git rev-parse HEAD) ...
ARG IMAGE_SOURCE="https://github.com/opgrsankkar/letter-by-letter"
ARG IMAGE_REVISION="unknown"
LABEL org.opencontainers.image.title="Letter by Letter" \
      org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.description="Multiplayer facilitator app (Express + Socket.IO + React)." \
      org.opencontainers.image.licenses="UNLICENSED"

ENV NODE_ENV=production \
    PORT=4000

# Match the source layout: /app/server and /app/client live side by side.
WORKDIR /app/server

# Production server dependencies (only what "dependencies" declares).
COPY --from=server-prod-deps --chown=node:node /app/server/node_modules ./node_modules

# Compiled server.
COPY --from=server-builder --chown=node:node /app/server/dist ./dist

# Server manifest (main/type metadata) and the word list read at /random-word.
COPY --chown=node:node server/package.json ./package.json
COPY --chown=node:node server/words_list.txt ./words_list.txt

# Built client, resolved at runtime as ../../client/dist from /app/server/dist.
COPY --from=client-builder --chown=node:node /app/client/dist /app/client/dist

# The official node image already provides the unprivileged "node" user (uid 1000).
USER node

EXPOSE 4000

# Node-only HTTP healthcheck (no curl/wget in the slim runtime). Uses a dynamic
# import so it works regardless of the ESM/CJS evaluation mode of `node -e`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "import('node:http').then((h)=>{const req=h.get({host:'127.0.0.1',port:Number(process.env.PORT)||4000,path:'/health',timeout:4000},(res)=>{res.resume();process.exit(res.statusCode===200?0:1)});req.on('error',()=>process.exit(1));req.on('timeout',()=>{req.destroy();process.exit(1)})}).catch(()=>process.exit(1))"]

CMD ["node", "dist/index.js"]
