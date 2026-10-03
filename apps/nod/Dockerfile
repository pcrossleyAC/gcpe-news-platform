FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/nod ./apps/nod
COPY scripts ./scripts
RUN npm ci --workspace @gcpe/nod --include-workspace-root
RUN node scripts/build-app.mjs apps/nod

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/apps/nod/package.json ./apps/nod/package.json
COPY --from=build /repo/packages ./packages
RUN npm ci --omit=dev --workspace @gcpe/nod && find packages -name '*.test.ts' -delete
COPY --from=build /repo/apps/nod/dist ./apps/nod/dist
COPY --from=build /repo/apps/nod/migrations ./apps/nod/migrations
USER 1001
ENV MIGRATIONS_FOLDER=/app/apps/nod/migrations
EXPOSE 3004
# Shell form so PORT (main.ts default 3004) is read when the check runs.
HEALTHCHECK CMD wget -qO- "http://localhost:${PORT:-3004}/health/live" || exit 1
CMD ["node", "apps/nod/dist/main.js"]
