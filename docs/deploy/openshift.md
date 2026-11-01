# The OpenShift image (Linux container)

> **Not used in production.** Production runs natively on Windows Server
> ([windows.md](windows.md)); boxs.ca runs on SiteGround ([siteground.md](siteground.md)). This
> image exists so the platform can move to BC Gov's OpenShift (or any Linux container host) later
> without a porting project, and CI keeps it working on every change. Nothing here changes the
> Windows or SiteGround deployments.

## What the image is

One image, `deploy/openshift/Dockerfile`, runs the whole platform: `apps/stack` (Core, NRMS, News
API, public site, staff Hub, NoD, Distribution, Calendar) in one Node process, exactly as on
Windows and SiteGround.

- **One way to assemble the app.** The build stage runs `scripts/build-siteground.mjs`, the same
  script that produces the SiteGround artifact and the `app\` folder of the Windows package, and
  the runtime stage copies its output (`dist/siteground/`) whole. That artifact bundles every npm
  dependency into `stack.js`, so the runtime stage has no `node_modules`, runs no `npm install`
  and carries no build tools (npm, npx, corepack and yarn are removed from it). There is no file
  list in the Dockerfile to fall out of step with the code. The build also runs `stack.js --check`
  (inside build-siteground.mjs), so an image whose config, migrations or tzdata are wrong fails to
  build.
- **Layout:** the release at `/opt/gcpe` (owned by root, read-only to the app), state at `/data`.
  `/opt/gcpe/VERSION.json` holds the commit it was built from (also the
  `org.opencontainers.image.revision` label).
- **Size:** about 95 MB compressed (what a registry stores and a node pulls), about 260 MB
  unpacked; the release itself is 28 MB. Measured 2026-10-29 on arm64.
- **Base image:** `node:24.22.2-trixie-slim` (official Node 24 LTS on Debian 13), pinned by
  version and multi-arch digest. Red Hat UBI (`ubi9/nodejs-24-minimal`) would be the natural
  OpenShift choice and was tried first, but every UBI Node 24 image available on 2026-10-29
  (ubi9 and ubi10, minimal or not: Node 24.21.0) carries **tzdata 2026a**. That predates BC's
  permanent UTC−7 (tzdata 2026b), so on it 15 January 2027 noon in Vancouver comes out as
  11:00 PST, and the stack refuses to start (its tenant time-zone self-check). The official
  image's Node 24.22.2 carries tzdata 2026e. Move to UBI when its Node reports
  `process.versions.tz` ≥ `2026b`: change `ARG NODE_IMAGE` and the build's `--check` proves it.

## Build

From the repository root:

```sh
docker build -f deploy/openshift/Dockerfile --build-arg GIT_COMMIT=$(git rev-parse HEAD) -t gcpe-stack .
```

About 45 seconds from cold on an M-series Mac. `npm ci` sits in its own layer keyed only on the
package manifests and the lockfile, so a code-only change rebuilds from the build step on. Podman
and `oc start-build` (a Docker strategy build) take the same Dockerfile.

## Run it locally

`deploy/openshift/smoke-test.sh` does the whole thing end to end, the way OpenShift runs it, and
cleans up after itself:

```sh
deploy/openshift/smoke-test.sh gcpe-stack
```

It starts `pgvector/pgvector:pg16` on a private Docker network, creates the seven databases, runs
`node stack.js --migrate` twice (the second must find nothing to do), starts the stack as a random
UID in group 0 with `--read-only`, `--cap-drop ALL`, `no-new-privileges` and a volume at `/data`,
waits for `/stack/health` to be `ok`, checks `/`, `/hub/` and `/hub/manuals/core-admin.docx` (a manual's Word file) answer 200, then stops it with SIGTERM
and requires exit code 0.

By hand, against a Postgres of your own (the container must reach it by name or address, so put
both on one Docker network, or use the host's address):

```sh
docker network create gcpe
docker run -d --name gcpe-pg --network gcpe -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16
for db in core nrms news_api site nod distribution calendar; do
  docker exec gcpe-pg psql -U postgres -c "CREATE DATABASE $db"; done
# gcpe.env: the variables below, with *_DATABASE_URL=postgres://postgres:postgres@gcpe-pg:5432/<db>
docker volume create gcpe-data
OPTS="--user 12345:0 --read-only --network gcpe --env-file gcpe.env -v gcpe-data:/data"
docker run --rm $OPTS gcpe-stack node stack.js --migrate
docker run -d --name gcpe $OPTS -p 8080:8080 gcpe-stack
curl -s localhost:8080/stack/health
```

A host directory works as `/data` too, as long as group 0 may write to it (OpenShift's model): for
example `chgrp 0 <dir> && chmod 0770 <dir>`, or `chmod 0777` on a throwaway test directory.

## Environment

Configuration is environment variables only, from a ConfigMap and a Secret (`envFrom`; templates
in `deploy/openshift/manifests/`). **Secrets come from an OpenShift Secret** (`oc create secret
generic … --from-env-file=<file outside the repo>`, or a sealed/external secret), never from a
committed file. The meaning of every variable is the same as on the other hosts:
[siteground.md, "Environment variables"](siteground.md#4-environment-variables) and
`scripts/windows-env.ts` (which writes the Windows `gcpe.env`) are the reference.

Set by the image (override only with a reason): `NODE_ENV=production`, `PORT=8080`,
`DATA_DIR=/data`, `HOME=/data`. Do not set `TENANT_CONFIG` or any `*_MIGRATIONS_FOLDER`: `stack.js`
finds its own `config/` and `migrations/` beside it.

| Variable | Required | Secret | Notes |
| --- | --- | --- | --- |
| `TICK_TOKEN` | yes | yes | ≥ 32 characters. Guards `/stack/tick`; with `STACK_LOOPS=true` nothing needs to call it. |
| `LOCAL_AUTH_SECRET` | with local admin | yes | ≥ 32 characters. Signs the break-glass admin's tokens only. |
| `STACK_EVENT_SECRET` | yes in practice | yes | ≥ 32 characters. The stack derives every internal event subscription, signing secret and NoD's link secret from it, and the key the apps sign their calls to each other with (so those calls don't depend on the break-glass admin). Changing it signs everyone out and needs a restart of every replica at once. Do not change it just to end sessions: it also changes NoD's unsubscribe-link key, so links already emailed stop working. To end sessions only, set a new explicit `SESSION_SECRET` (32+ characters) instead, and keep it set (removing it brings back the derived one). That signs every staff user out; to end only break-glass access, set a new break-glass password. |
| `CORE_DATABASE_URL`, `NRMS_DATABASE_URL`, `NEWSAPI_DATABASE_URL`, `SITE_DATABASE_URL`, `NOD_DATABASE_URL`, `DIST_DATABASE_URL` | yes | yes | One database per app, `postgres://…`. Never `self:/…`. |
| `CALENDAR_DATABASE_URL` | no | yes | Unset: the Calendar is not mounted (`/calendar` answers 503); every other app runs. |
| `SITE_NEWS_API_URL` | yes | | `self:/` |
| `SITE_OUTPUT_DIR` | yes | | `./site-output` (resolves under `DATA_DIR`) |
| `SITE_PUBLIC_SITE_URL`, `NOD_PUBLIC_SITE_URL` | yes | | `https://<public host>`, the bare origin |
| `NOD_DISTRIBUTION_URL` | yes | | `self:/distribution` |
| `DIST_SMTP_HOST`, `DIST_MAIL_FROM` | yes | | `DIST_SMTP_PORT`, `DIST_SMTP_SECURE` optional; `DIST_SMTP_USER`/`DIST_SMTP_PASS` optional and secret. |
| `DIST_MAIL_REDIRECT_TO` | test sites | | Every message goes here instead. The real production site removes it and sets `DIST_MAIL_ALLOW_REAL_RECIPIENTS=true` (both together is refused). |
| `SITE_ENVIRONMENT` | test sites | | `test` on anything but the real production site; `production` (or unset) on it. Case and spaces are ignored; under `NODE_ENV=production` any other value is refused at startup. |
| `LOCAL_ADMIN_ENABLED`, `LOCAL_ADMIN_USERNAME`, `LOCAL_ADMIN_ALLOW_IN_PRODUCTION` | test sites | | The break-glass admin login; `LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true` is needed with `NODE_ENV=production`. It only allows the login: it does not make a test site (`SITE_ENVIRONMENT=test` does). |
| `LOCAL_ADMIN_PASSWORD_HASH` | with local admin | yes | `npm run auth:hash-password` |
| `TRUST_PROXY_HOPS` | no | | Default `1`: the OpenShift router. `2` if another proxy is in front of it. |
| `SESSION_MAX_HOURS` | no | | Default `12`: a staff session ends this many hours after sign-in, whatever the renewals (more than 0, at most 168). One value for every app. The manual pages say 12 hours: edit them if you change it. Rolling back past Core migration 0012: deploy the previous image and leave `staff_sessions` in place; never drop it by hand. |
| `STACK_LOOPS` | no | | Default `true`: background work runs in the process (no scheduler needed). |
| `UPDATES_HUB_ENABLED` | no | | `true` for the News API's live-updates hub; OpenShift routes pass WebSockets. |
| `ENTRA_TENANT_ID`, `CORE_ENTRA_CLIENT_ID`, `CORE_ENTRA_CLIENT_SECRET`, `CORE_PUBLIC_BASE_URL`, `<PREFIX>_AUTH_AUDIENCE` | for Microsoft sign-in | client secret | As `scripts/windows-env.ts` writes them. |
| `NRMS_FLICKR_*`, `NOD_MEDIA_HUB_URL`, `NOD_EMERGENCY_FEED_URL`, `NEWSAPI_EMBEDDINGS_*`, … | no | keys are | Outside services; unset means the stack's fakes on a test site, nothing in production. See siteground.md. |
| `NOD_EMERGENCY_FEED` | real production, unless the feed URL is set | | `off` switches emergency alerts off on purpose. The real production site refuses to start with neither this nor `NOD_EMERGENCY_FEED_URL`, and with Microsoft sign-in or the mail settings incomplete (docs/deploy/windows.md, "Real production: what the stack refuses"); `--check` reports the same under `production`. |

**The real production site on OpenShift** follows the same go-live steps as Windows
(docs/deploy/windows.md, P4): leave out `SITE_ENVIRONMENT` and every `LOCAL_ADMIN_*` and
`LOCAL_AUTH_SECRET` (keep them in a Secret that isn't mounted, for break-glass in an emergency),
remove `DIST_MAIL_REDIRECT_TO` and set `DIST_MAIL_ALLOW_REAL_RECIPIENTS=true`, and set Microsoft
sign-in and the emergency feed (or `NOD_EMERGENCY_FEED=off`); set `SITE_ENVIRONMENT=production`,
which break-glass in an emergency needs. The stack refuses to start without
them and `--check` names what is missing. The apps' calls to each other stay in the one pod and
need no break-glass. Splitting them into a public and a staff tier would need Entra client
credentials between the tiers, which isn't built.

`node stack.js --check` validates a set of variables without starting anything:
`oc run gcpe-check --rm -i --restart=Never --image=<image> --overrides=<envFrom> -- node stack.js --check`,
or `oc debug deploy/gcpe-stack -- node stack.js --check`.

## Storage: `/data`

Everything the stack writes is under `DATA_DIR` (`/data`, a PersistentVolumeClaim); the rest of
the filesystem can be, and in the manifests is, read-only (`readOnlyRootFilesystem: true`;
verified: the smoke test runs with `--read-only` and no `/tmp`). It holds `site-output/` (the
rendered public site), `storage/` (NRMS uploads), `calendar-files/`, `logs/errors.jsonl` (what
`/hub/error-log` shows) and, on test sites, the fake Flickr's state. Back it up with the
databases: a restore needs both.

Permissions: OpenShift runs the container as an arbitrary UID in group 0 and gives the volume to
that group. The image's own `/data` is `1001:0`, mode 0775, so an emptyDir or a fresh Docker
volume works for any UID in group 0.

## Health probes

OpenShift ignores a Dockerfile `HEALTHCHECK`, so the image has none; the Deployment declares:

| Probe | Path | Why |
| --- | --- | --- |
| startup | `/core/health/live` | The server listens only once every app has migrated and started; the first start on empty databases migrates everything. Allows 5 minutes (60 × 5 s). |
| readiness | `/core/health/live` | 200 while the process serves HTTP. Not `/stack/health`: with one replica, one app's database blip (Calendar, NoD) would take the only pod out of the Service and the Route would answer 503 for everything, the public site included. Watch `/stack/health` (every app's readiness, databases included; cached 5 s) from monitoring and alert on it instead. |
| liveness | `/core/health/live` | 200 while the process serves HTTP. Deliberately not `/stack/health`: a database outage fails that too, and restarting the pod would not fix the database but would stop the public site, which can still serve its pages from `/data`. |

## Migrations

Two ways, both the same image, both safe to repeat or overlap (each app's migrations run under a
Postgres advisory lock; a later run finds nothing to apply):

1. **On start (default, as on Windows and SiteGround).** `node stack.js` migrates every app's
   database before it listens. Nothing to configure.
2. **As a Job before a rollout** (`deploy/openshift/manifests/migrate-job.yaml`), running
   `node stack.js --migrate` with the Deployment's ConfigMap and Secret. It applies every
   configured app's migrations, prints a per-app JSON summary and exits 0, or 1 naming the app
   and its variable prefix. Use it to stop a release whose migration fails before the running pod
   is replaced. The same command works as an initContainer.

Migrations are additive, so rolling back to the previous image after a migration is safe (as on
Windows). News API `0012_unpublish_advisories` changes data, not structure: it takes any Advisory an
older build put on the public site back off it (`docs/deploy/siteground.md`, "Pages and rebuilds").
Rolling back past it doesn't put existing ones back, but an older image puts any Advisory published
or corrected after the rollback on the site again. It takes the change feed's lock, so the public
site can't skip its changes; still, run siteground.md's after-deploy check only once every process
is on the new build (an older process still running can re-store an Advisory it receives meanwhile). NRMS `0022_site_file_tombstones` adds the table of
deleted Website file names that stops `/files` falling back to legacy's copy (same guide, "Website
section"). NoD `0033_correction_modes` (corrected copies) changes only metadata on the large
`deliveries` table (its mode check is replaced `NOT VALID`, so the table isn't scanned) plus a column
with a default and an index on the small `send_jobs`: its locks last milliseconds. It sets a 5-second
lock timeout, so on a busy table it fails the migration (retry it) rather than stall NoD. NRMS
`0023_release_email_again` adds three columns to `news_releases`.

## PostgreSQL

External; on BC Gov OpenShift that would be a Crunchy (PGO) / Patroni cluster. Needs:

- **Seven databases** (six plus the optional Calendar), any names, reachable from the namespace.
  The role in each URL owns its database's schema: the migrations create tables, indexes and the
  `drizzle` schema.
- **pgvector (optional):** the News API's migration `0005_pgvector_optional` runs
  `CREATE EXTENSION IF NOT EXISTS vector` and skips it without failing when the role may not or
  the extension is not installed; search then stays in text mode. For semantic search, have the
  DBA enable `vector` in the News API database (Crunchy images ship pgvector) and follow
  [siteground.md, "pgvector and the search mode"](siteground.md#pgvector-and-the-search-mode).
- **tzdata 2026b or later** in the Calendar database's Postgres (BC's permanent UTC−7); older,
  the Calendar puts midnight–1 a.m. activities on the previous day. The stack warns at start
  (`errors.jsonl`) and `--check` reports `calendarDbTimeZone`.
- The CI and the smoke test use PostgreSQL 16 with pgvector; Windows uses PostgreSQL 17.

## Manifests

`deploy/openshift/manifests/` holds a plain-Kubernetes example (no DeploymentConfig), placeholder
values only. Fill in and apply with `oc apply -k deploy/openshift/manifests` after creating the
Secret yourself from `secret.example.yaml` (it is deliberately not in the kustomization).

- `deployment.yaml`: one replica, `Recreate` (a ReadWriteOnce volume cannot be attached to the old
  and new pod at once), the probes above, requests 250m CPU / 512 Mi, limits 1 CPU / 1.5 Gi
  (measured idle: ~165 MiB with empty databases; tune from real use), and the restricted
  securityContext: `runAsNonRoot`, `allowPrivilegeEscalation: false`, all capabilities dropped,
  seccomp `RuntimeDefault`, `readOnlyRootFilesystem: true`. No `runAsUser`/`fsGroup`: the
  restricted-v2 SCC assigns them.
- `service.yaml`, `route.yaml` (edge TLS, HTTP redirected, HSTS for a year), `pvc.yaml` (10 Gi, set the storage
  class), `configmap.yaml`, `secret.example.yaml`, `migrate-job.yaml`.
- Point `kustomization.yaml`'s `images:` at the pushed image by digest.

**Exposure.** One Route exposes everything the stack serves: the Hub, every app's API and
`/stack/*`. On Windows the DMZ proxy's allow list (`deploy/windows/Install-GcpeProxy.ps1`, kept
complete by `tests/dmz-proxy-allow-list.test.ts`) decides what the internet sees. Until an
equivalent public front exists here (a second, restricted Route per public prefix, or a proxy
with the same list), keep the Route limited to staff networks with the
`haproxy.router.openshift.io/ip_whitelist` annotation, as the example does.

**Scaling.** One replica is the tested shape. More need ReadWriteMany storage for `/data` (BC
Gov: a file storage class) and a `RollingUpdate` strategy; whether every background loop is safe
with two processes at once has not been verified for this image (migrations are).

**Shutdown.** Node runs as PID 1 and handles SIGTERM itself (drains HTTP, stops the loops, closes
the database pools, exits 0; verified by the smoke test, under a second with no traffic). The
stack starts no child processes, so no init process (tini) is needed. `terminationGracePeriodSeconds`
is 30.

**Logs** go to stdout/stderr (`oc logs`); `errors.jsonl` under `/data/logs` additionally keeps the
recent errors across restarts.

**Command-line tools** bundled in the release are in the image: `node tools/<tool>.mjs`
(`news-api-import-public`, `news-api-import-files`, `nrms-import-public-slides`,
`legacy-files-copy`; see siteground.md), runnable with `oc exec` or as a Job. The Windows
package's legacy importers (which read the legacy SQL Server) are not in this image.

## Scaling later (planned, not built)

The owner expects to want to scale on OpenShift at some point (2026-10-29). The plan is **one
image, several Deployments**, not an image per app (the per-app `apps/*/Dockerfile` images were
removed: they predated the single-stack design and nothing deployed them):

- A public tier (public site and News API) scaled to several replicas, and a staff tier (Core,
  NRMS, NoD, Distribution, Calendar) kept at one, each running the same image with a switch that
  mounts only its apps. **That switch does not exist yet** — today every process mounts every app.
  `STACK_LOOPS` already turns the background loops off, which is what every replica but one needs.
- Before more than one replica of anything: shared `ReadWriteMany` storage for `/data` (uploads,
  the generated site), and a check that every background job is safe with two processes (the NRMS
  publisher, Flickr jobs and carousel, the event dispatcher, NoD send jobs, Distribution's sender
  and the News API embeddings worker use `SKIP LOCKED` row claims; the other loops are unverified).
- The Route splits by path: public paths to the public tier, `/hub` and staff APIs to the staff
  tier, with the same allow list the Windows DMZ proxy applies.
- An app run on its own loses what the stack wires for it. The public site builder then needs an
  Entra app registration with the News API's `NewsApi.ChangesRead` app role (`NEWS_API_TOKEN_URL`,
  `NEWS_API_CLIENT_ID`, `NEWS_API_CLIENT_SECRET`, `NEWS_API_SCOPE`), and the News API needs
  `AUTH_AUDIENCE`; neither starts without them. NRMS needs `NEWS_API_URL` and an Entra app
  registration holding the News API's `NewsApi.Similar` app role (the same four `NEWS_API_*`
  settings) for "Similar published releases"; without `NEWS_API_URL` the panel doesn't appear.

## How it stays in sync

- **CI** (`.github/workflows/openshift-image.yml`) runs on every pull request and every push to
  `main`: builds the image with BuildKit (layers cached in the GitHub Actions cache) and runs
  `deploy/openshift/smoke-test.sh` on it. A change that breaks the image, the build, migrations,
  startup on a read-only filesystem as an arbitrary UID, `/stack/health`, `/`, `/hub/`, a manual's Word file or a clean
  SIGTERM fails the check. The image is **never pushed** to a registry; publishing is a separate,
  deliberate decision.
- **`tests/openshift-image.test.ts`** (in the normal `npm test`) fails when the Dockerfile, the
  manifests or the smoke test drift from the code: the base image unpinned or on another Node
  major than `.nvmrc`, the build not being build-siteground.mjs or not shipped whole, a workspace
  missing from the dependency layer, the port/`DATA_DIR`/user, probe paths the stack doesn't
  serve, the security context, the `--migrate` command, an app's database missing from the Secret
  template or the smoke test, or the smoke test's Postgres differing from `ci.yml`'s.
- Because the image is built by the same script as the other two deployments, a new app,
  migration folder, asset or tool reaches the image the moment it reaches SiteGround and Windows.

## Assumptions about BC Gov OpenShift (not verified here)

- The cluster runs pods under the `restricted-v2` SCC: arbitrary UID, group 0, no capabilities.
  The image and manifests are built for exactly that.
- Images are pulled from an approved registry. BC Gov's Artifactory proxies Docker Hub and Red
  Hat's registry; if Docker Hub-based images are not allowed, mirror `node:24.22.2-trixie-slim` (or
  switch to UBI once its tzdata is current, above) and change `ARG NODE_IMAGE`.
- Storage classes: a block class for ReadWriteOnce and `netapp-file-standard` for ReadWriteMany
  are typical; check `oc get storageclass`.
- PostgreSQL is a Crunchy/Patroni cluster the team provisions; the extension and tzdata
  requirements above go to whoever runs it.
- Outbound SMTP, Entra, Flickr and the emergency feed need egress (NetworkPolicy) from the
  namespace.
