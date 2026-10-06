FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/news-api ./apps/news-api
COPY scripts ./scripts
COPY config ./config
RUN npm ci --workspace @gcpe/news-api --include-workspace-root
RUN node scripts/build-app.mjs apps/news-api

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/apps/news-api/package.json ./apps/news-api/package.json
COPY --from=build /repo/packages ./packages
# Known trade-off: this installs every production dependency of @gcpe/news-api, including
# @gcpe/legacy-import's mssql/tedious/@azure stack. The server bundle never imports them
# (only the import:legacy CLI does), so they are dead weight in the image. Accepted for
# Phase 0; splitting the importer into its own optional install is a later clean-up.
RUN npm ci --omit=dev --workspace @gcpe/news-api && find packages -name '*.test.ts' -delete
COPY --from=build /repo/apps/news-api/dist ./apps/news-api/dist
COPY --from=build /repo/apps/news-api/migrations ./apps/news-api/migrations
COPY --from=build /repo/config ./config
USER 1001
ENV MIGRATIONS_FOLDER=/app/apps/news-api/migrations TENANT_CONFIG=/app/config/tenants/bc.json
EXPOSE 3002
# Shell form so PORT (main.ts default 3002) is read when the check runs.
HEALTHCHECK CMD wget -qO- "http://localhost:${PORT:-3002}/health/live" || exit 1
CMD ["node", "apps/news-api/dist/main.js"]
