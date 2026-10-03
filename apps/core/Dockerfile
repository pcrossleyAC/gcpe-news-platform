FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/core ./apps/core
COPY scripts ./scripts
RUN npm ci --workspace @gcpe/core --include-workspace-root
RUN node scripts/build-app.mjs apps/core

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/apps/core/package.json ./apps/core/package.json
COPY --from=build /repo/packages ./packages
# Known trade-off: this installs every production dependency of @gcpe/core, including
# @gcpe/legacy-import's mssql/tedious/@azure stack. The server bundle never imports them
# (only the import:legacy CLI does), so they are dead weight in the image. Accepted for
# Phase 0; splitting the importer into its own optional install is a later clean-up.
RUN npm ci --omit=dev --workspace @gcpe/core && find packages -name '*.test.ts' -delete
COPY --from=build /repo/apps/core/dist ./apps/core/dist
COPY --from=build /repo/apps/core/migrations ./apps/core/migrations
USER 1001
ENV MIGRATIONS_FOLDER=/app/apps/core/migrations
EXPOSE 3001
# Shell form so PORT (main.ts default 3001) is read when the check runs.
HEALTHCHECK CMD wget -qO- "http://localhost:${PORT:-3001}/health/live" || exit 1
CMD ["node", "apps/core/dist/main.js"]
