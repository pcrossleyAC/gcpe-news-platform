FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/calendar ./apps/calendar
COPY scripts ./scripts
COPY config ./config
RUN npm ci --workspace @gcpe/calendar --include-workspace-root
RUN node scripts/build-app.mjs apps/calendar

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/apps/calendar/package.json ./apps/calendar/package.json
COPY --from=build /repo/packages ./packages
RUN npm ci --omit=dev --workspace @gcpe/calendar && find packages -name '*.test.ts' -delete
COPY --from=build /repo/apps/calendar/dist ./apps/calendar/dist
COPY --from=build /repo/apps/calendar/migrations ./apps/calendar/migrations
COPY --from=build /repo/config ./config
USER 1001
ENV MIGRATIONS_FOLDER=/app/apps/calendar/migrations TENANT_CONFIG=/app/config/tenants/bc.json
EXPOSE 3007
# Shell form so PORT (main.ts default 3007) is read when the check runs.
HEALTHCHECK CMD wget -qO- "http://localhost:${PORT:-3007}/health/live" || exit 1
CMD ["node", "apps/calendar/dist/main.js"]
