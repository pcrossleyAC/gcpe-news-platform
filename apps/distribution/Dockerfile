FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/distribution ./apps/distribution
COPY scripts ./scripts
RUN npm ci --workspace @gcpe/distribution --include-workspace-root
RUN node scripts/build-app.mjs apps/distribution

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/apps/distribution/package.json ./apps/distribution/package.json
COPY --from=build /repo/packages ./packages
RUN npm ci --omit=dev --workspace @gcpe/distribution && find packages -name '*.test.ts' -delete
COPY --from=build /repo/apps/distribution/dist ./apps/distribution/dist
COPY --from=build /repo/apps/distribution/migrations ./apps/distribution/migrations
USER 1001
ENV MIGRATIONS_FOLDER=/app/apps/distribution/migrations
EXPOSE 3005
# Shell form so PORT (main.ts default 3005) is read when the check runs.
HEALTHCHECK CMD wget -qO- "http://localhost:${PORT:-3005}/health/live" || exit 1
CMD ["node", "apps/distribution/dist/main.js"]
