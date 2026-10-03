FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/nrms ./apps/nrms
COPY scripts ./scripts
RUN npm ci --workspace @gcpe/nrms --include-workspace-root
RUN node scripts/build-app.mjs apps/nrms

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/apps/nrms/package.json ./apps/nrms/package.json
COPY --from=build /repo/packages ./packages
RUN npm ci --omit=dev --workspace @gcpe/nrms && find packages -name '*.test.ts' -delete
COPY --from=build /repo/apps/nrms/dist ./apps/nrms/dist
COPY --from=build /repo/apps/nrms/migrations ./apps/nrms/migrations
USER 1001
ENV MIGRATIONS_FOLDER=/app/apps/nrms/migrations
EXPOSE 3002
# Shell form so PORT (main.ts default 3002) is read when the check runs.
HEALTHCHECK CMD wget -qO- "http://localhost:${PORT:-3002}/health/live" || exit 1
CMD ["node", "apps/nrms/dist/main.js"]
