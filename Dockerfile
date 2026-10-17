# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_HTTP_HOST=0.0.0.0 \
    GOOGLE_TOKEN_PATH=/run/secrets/token.json
# No MCP_HTTP_PORT here: the server listens on $PORT when the platform sets it
# (e.g. Railway), otherwise 3333. Setting it would override PORT.
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3333
# Binding 0.0.0.0 requires MCP_HTTP_BEARER_TOKEN; the server refuses to start without it.
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${MCP_HTTP_PORT:-${PORT:-3333}}/healthz" || exit 1
ENTRYPOINT ["node", "dist/index.js"]
