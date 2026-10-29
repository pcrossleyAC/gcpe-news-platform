# The GCPE platform as one OpenShift-ready image: the whole stack (apps/stack) in one Node process.
# NOT used in production today (production is the Windows Server package, docs/deploy/windows.md);
# this is for a possible move to BC Gov OpenShift or Linux hosts. Runbook: docs/deploy/openshift.md.
#
#   docker build -f deploy/openshift/Dockerfile -t gcpe-stack .        (context: the repository root)
#
# ONE way the app is assembled: the build stage runs scripts/build-siteground.mjs, the same script
# that produces the SiteGround artifact and the app/ folder of the Windows package, and the runtime
# stage copies its output (dist/siteground) whole. That artifact is self-contained — every npm
# dependency is bundled into stack.js — so the runtime stage has no node_modules, no npm install
# and no build tools; there is no file list here to keep in step with the code.
# tests/openshift-image.test.ts checks this file and the manifests beside it against the code.
#
# Base: the official Node 24 LTS image (Debian 13 "trixie" slim), pinned by its exact version AND
# multi-arch index digest. Not Red Hat UBI, which would otherwise be the natural OpenShift choice:
# every UBI Node 24 image (ubi9/ubi10 nodejs-24, -minimal or not; checked 2026-10-29, Node 24.21.0)
# carries tzdata 2026a, which predates BC's permanent UTC-7 (tzdata 2026b), and the stack refuses to
# start on it (the tenant time-zone self-check; build-siteground.mjs's --check fails the build).
# Switch to UBI once its Node reports process.versions.tz >= 2026b. To update this pin, take the
# new tag's digest from `docker buildx imagetools inspect node:<version>-trixie-slim`.
ARG NODE_IMAGE=node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446

# --- manifests: only the package.json files and the lockfile, so the npm ci layer below stays
# cached until a dependency actually changes (the globs are the root package.json's workspaces).
FROM ${NODE_IMAGE} AS manifests
COPY . /tmp/repo
RUN mkdir /manifests && cd /tmp/repo \
 && for f in package.json package-lock.json packages/*/package.json apps/*/package.json; do \
      mkdir -p "/manifests/$(dirname "$f")" && cp "$f" "/manifests/$f"; \
    done

# --- build: install every dependency (the build needs esbuild etc.) and run the shared build.
FROM ${NODE_IMAGE} AS build
RUN mkdir /opt/gcpe-build && chown node:node /opt/gcpe-build
USER node
WORKDIR /opt/gcpe-build
# GCPE_IMAGE_BUILD: build-siteground.mjs's leak scan skips the build user's name ("node", a word
# every bundle contains); it still fails on this directory's path or the home directory.
ENV GCPE_IMAGE_BUILD=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false
COPY --from=manifests --chown=node:node /manifests/ ./
RUN npm ci
COPY --chown=node:node . .
RUN node scripts/build-siteground.mjs

# --- runtime
FROM ${NODE_IMAGE}
ARG GIT_COMMIT=unknown
LABEL org.opencontainers.image.title="gcpe-stack" \
      org.opencontainers.image.description="GCPE news platform: every app in one Node process (apps/stack)" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      io.openshift.expose-services="8080:http" \
      io.k8s.description="GCPE news platform stack; health at /stack/health; all state under DATA_DIR"
# The release, owned by root and not writable by the runtime user: only DATA_DIR is.
WORKDIR /opt/gcpe
COPY --from=build --chown=0:0 /opt/gcpe-build/dist/siteground/ ./
# OpenShift runs the container as an arbitrary UID in group 0, so /data is group-0 owned and
# group-writable (a mounted volume replaces it; OpenShift sets that volume's group itself).
# UID 1001 has no passwd entry, like OpenShift's own arbitrary UIDs; nothing at runtime needs one.
# npm, npx, corepack and yarn are removed: nothing is installed at runtime (stack.js bundles its
# dependencies), and a package manager in the image is only attack surface and scanner noise.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && mkdir -p /data && chown 1001:0 /data && chmod 0775 /data \
 && printf '{"commit":"%s"}\n' "${GIT_COMMIT}" > /opt/gcpe/VERSION.json
USER 1001
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    HOME=/data
EXPOSE 8080
# Node is PID 1 and handles SIGTERM itself (main.ts: drains the HTTP server, stops the loops, closes
# the pools); the stack starts no child processes, so no init (tini) is needed.
# Other commands, same image: `node stack.js --migrate` (a migration Job), `node stack.js --check`.
CMD ["node", "stack.js"]
