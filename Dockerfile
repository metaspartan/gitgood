# syntax=docker/dockerfile:1.7

FROM oven/bun:1.4.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM deps AS web
WORKDIR /app
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun types ./types
COPY --chown=bun:bun tools ./tools
COPY --chown=bun:bun tsconfig.json ./
RUN bun tools/build-web.ts /app/dist/web

FROM oven/bun:1.4.4-alpine AS runtime

RUN apk add --no-cache git git-lfs tini \
    && git lfs install --system --skip-repo \
    && mkdir -p /data /backups \
    && chown -R bun:bun /data /backups

WORKDIR /app
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock tsconfig.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun types ./types
COPY --chown=bun:bun tools ./tools
COPY --from=web --chown=bun:bun /app/dist ./dist

ENV NODE_ENV=production \
    GITGOOD_HOST=0.0.0.0 \
    GITGOOD_PORT=3000 \
    GITGOOD_DATA_DIR=/data \
    GITGOOD_DB_PATH=/data/gitgood.db \
    GITGOOD_REPO_ROOT=/data/repositories \
    GITGOOD_LFS_ROOT=/data/lfs \
    GITGOOD_WEB_DIST=/app/dist/web

VOLUME ["/data"]
EXPOSE 3000

USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:3000/api/ready || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "src/server.ts"]
