FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/onshape-panel/package.json apps/onshape-panel/package.json
COPY packages/cad-command-schema/package.json packages/cad-command-schema/package.json
COPY packages/onshape-client/package.json packages/onshape-client/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY services/api/package.json services/api/package.json
COPY services/codex-worker/package.json services/codex-worker/package.json
COPY services/onshape-mcp/package.json services/onshape-mcp/package.json
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates gosu \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@0.144.4 \
    && npm cache clean --force

WORKDIR /app
COPY --from=build /app /app
COPY scripts/docker-entrypoint.sh /usr/local/bin/morassistant-entrypoint

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    SESSION_DB_PATH=/data/morassistant.sqlite \
    CODEX_USERS_ROOT=/data/codex-users

EXPOSE 3000
ENTRYPOINT ["morassistant-entrypoint"]
CMD ["node", "services/api/dist/server.js"]
