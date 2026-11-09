FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm build \
 && mkdir /out \
 && node -e "const v=require('./apps/api/package.json').dependencies['better-sqlite3'];require('fs').writeFileSync('/out/package.json',JSON.stringify({name:'pulse-runtime',private:true,type:'module',dependencies:{'better-sqlite3':v}}))"

FROM node:22-alpine AS runtime
# Runtime assumptions (D58), so the container can be locked down from deploy/docker-compose.yml:
# - runs as uid 1000 and listens on 8200, so it needs no Linux capabilities and no privileges;
# - writes only to /data (SQLite database, WAL files, backups made with VACUUM INTO), so the root filesystem can be read only;
# - /tmp is a small scratch area for SQLite temp files, so it can be a tmpfs mounted noexec and nosuid;
# - the healthcheck uses wget from the base image and talks to 127.0.0.1 only.
# Watchtower recreates the container from its own configuration, so the flags in the compose file are kept on update.
LABEL org.opencontainers.image.source="https://github.com/mark-130/pulse"
ENV NODE_ENV=production PORT=8200 DATA_DIR=/data WEB_DIST=/app/web MIGRATIONS_DIR=/app/drizzle
WORKDIR /app
COPY --from=build /out/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /repo/apps/api/dist/server.mjs ./server.mjs
COPY --from=build /repo/apps/api/drizzle ./drizzle
COPY --from=build /repo/apps/web/dist ./web
RUN mkdir /data && chown 1000:1000 /data
# Build identity from CI (D39). Last on purpose, so a new commit does not rebuild the layers above. Empty outside CI.
ARG GIT_SHA=""
ARG BUILD_TIME=""
LABEL org.opencontainers.image.revision=$GIT_SHA org.opencontainers.image.created=$BUILD_TIME
ENV PULSE_BUILD_SHA=$GIT_SHA PULSE_BUILD_TIME=$BUILD_TIME
USER 1000:1000
EXPOSE 8200
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:8200/api/health || exit 1
CMD ["node", "server.mjs"]
