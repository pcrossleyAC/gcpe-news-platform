FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/core ./apps/core
COPY scripts ./scripts
RUN npm ci --workspace @gcpe/core --include-workspace-root
RUN node scripts/build-app.mjs apps/core

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/apps/core/package.json ./apps/core/package.json
COPY --from=build /repo/packages ./packages
RUN npm ci --omit=dev --workspace @gcpe/core && rm -rf packages/*/src/**/*.test.ts
COPY --from=build /repo/apps/core/dist ./apps/core/dist
COPY --from=build /repo/apps/core/migrations ./apps/core/migrations
USER 1001
ENV MIGRATIONS_FOLDER=/app/apps/core/migrations
EXPOSE 3001
HEALTHCHECK CMD wget -qO- http://localhost:3001/health/live || exit 1
CMD ["node", "apps/core/dist/main.js"]
