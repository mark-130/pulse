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
LABEL org.opencontainers.image.source="https://github.com/mark-130/pulse"
ENV NODE_ENV=production PORT=8200 DATA_DIR=/data WEB_DIST=/app/web MIGRATIONS_DIR=/app/drizzle
WORKDIR /app
COPY --from=build /out/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /repo/apps/api/dist/server.mjs ./server.mjs
COPY --from=build /repo/apps/api/drizzle ./drizzle
COPY --from=build /repo/apps/web/dist ./web
RUN mkdir /data && chown 1000:1000 /data
USER 1000:1000
EXPOSE 8200
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:8200/api/health || exit 1
CMD ["node", "server.mjs"]
