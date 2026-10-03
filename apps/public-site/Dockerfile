FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/public-site ./apps/public-site
COPY scripts ./scripts
COPY config ./config
RUN npm ci --workspace @gcpe/public-site --include-workspace-root
RUN node scripts/build-app.mjs apps/public-site

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/apps/public-site/package.json ./apps/public-site/package.json
COPY --from=build /repo/packages ./packages
RUN npm ci --omit=dev --workspace @gcpe/public-site && find packages -name '*.test.ts' -delete
COPY --from=build /repo/apps/public-site/dist ./apps/public-site/dist
COPY --from=build /repo/apps/public-site/migrations ./apps/public-site/migrations
COPY --from=build /repo/config ./config
USER 1001
ENV MIGRATIONS_FOLDER=/app/apps/public-site/migrations
ENV TENANT_CONFIG=/app/config/tenants/bc.json
ENV OUTPUT_DIR=/app/output
VOLUME /app/output
EXPOSE 3003
# Shell form so PORT (main.ts default 3003) is read when the check runs.
HEALTHCHECK CMD wget -qO- "http://localhost:${PORT:-3003}/health/live" || exit 1
CMD ["node", "apps/public-site/dist/main.js"]
