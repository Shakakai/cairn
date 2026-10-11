# syntax=docker/dockerfile:1
# Cairn Pool image (doc 05): multi-stage pnpm build on node:24-slim, non-root, tini.
# Multi-arch: `docker buildx build --platform linux/amd64,linux/arm64 -t <tag> .`

FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
# pnpm needs every workspace package.json for a frozen install.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/router-memory/package.json packages/router-memory/
COPY packages/router-redis/package.json packages/router-redis/
COPY packages/adapter-node/package.json packages/adapter-node/
COPY packages/adapter-cloudflare/package.json packages/adapter-cloudflare/
COPY packages/conformance/package.json packages/conformance/
RUN pnpm install --frozen-lockfile
COPY packages/core/src packages/core/src
COPY packages/core/tsconfig.json packages/core/
COPY packages/router-memory/src packages/router-memory/src
COPY packages/router-memory/tsconfig.json packages/router-memory/
COPY packages/router-redis/src packages/router-redis/src
COPY packages/router-redis/tsconfig.json packages/router-redis/
COPY packages/adapter-node/src packages/adapter-node/src
COPY packages/adapter-node/tsconfig.json packages/adapter-node/
RUN pnpm --filter @cairn/adapter-node exec tsc -b

FROM node:24-slim AS run
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -r cairn && useradd -r -g cairn -d /app cairn
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/router-memory/package.json packages/router-memory/
COPY packages/router-redis/package.json packages/router-redis/
COPY packages/adapter-node/package.json packages/adapter-node/
COPY packages/adapter-cloudflare/package.json packages/adapter-cloudflare/
COPY packages/conformance/package.json packages/conformance/
RUN pnpm install --frozen-lockfile --prod \
  && corepack disable && npm cache clean --force
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/router-memory/dist packages/router-memory/dist
COPY --from=build /app/packages/router-redis/dist packages/router-redis/dist
COPY --from=build /app/packages/adapter-node/dist packages/adapter-node/dist
USER cairn
EXPOSE 8080 8443 9090
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/adapter-node/dist/main.js"]
