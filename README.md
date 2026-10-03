# gcpe-news-platform

Node.js + PostgreSQL replatform of the GCPE news toolchain: Corporate Calendar → NRMS → NoD → Distribution → News API → static public site.

- Design: [docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md](docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md)
- Plans: [docs/superpowers/plans/](docs/superpowers/plans/)

## Prerequisites

- Node ≥ 24 (`.nvmrc`; bumped from 22 so the bundled ICU/tzdata is new enough to know BC stays UTC−7 permanently from 2026-11-01 — Node 22's bundled tzdata (2025b–2026a depending on patch release) predates that rule), npm 11 (Node 24 ships npm 11)
- PostgreSQL ≥ 14 with the `vector` extension available (Homebrew `postgresql@14` + `pgvector`, or `docker compose -f deploy/docker-compose.yml up postgres`)

## Setup

```bash
npm install
cp .env.example .env   # adjust TEST_DATABASE_ADMIN_URL if needed
npm run check          # type-check every workspace
npm test               # unit + integration tests (creates/drops throwaway databases)
```

## Workspaces

| Path | Purpose |
|---|---|
| `packages/config` | Tenant config (`config/tenants/*.json`) and env parsing |
| `packages/db-kit` | Postgres pool + Drizzle, migrations, test databases |
| `packages/events` | Event envelope/catalogue, outbox, dispatcher, signed webhook receiver |
| `packages/auth` | Entra bearer tokens, role guard, client-credentials tokens |
| `packages/legacy-import` | Legacy SQL Server reader and enum maps |
| `packages/http-kit` | Shared HTTP plumbing: `/health/live` + `/health/ready` (pluggable checks), JSON error handler, ordered graceful shutdown |

## Apps

| App | Path | Port (default) | Purpose |
|---|---|---|---|
| Core | `apps/core` | `3001` | Reference data (organizations, sectors, themes, tags, services) |
| News API | `apps/news-api` | `3002` | Drop-in replacement for the BC Gov News API v1, incl. the `/updates` SignalR hub |
| Public Site | `apps/public-site` | `3003` | Rebuilds the static public site from News API content on `site.rebuild_requested` |
| NoD (News on Demand) | `apps/nod` | `3004` | Subscriptions + As-It-Happens email delivery, hands off to Distribution |
| Distribution | `apps/distribution` | `3005` | Sends mail batches over SMTP for NoD (and any other internal caller) |
| NRMS (News Release Management System) | `apps/nrms` | `3006` | Drafts/schedules/publishes releases; emits `release.*` events to News API and NoD |

Ports are each app's `PORT` env default; override per environment as needed. **NRMS was moved from `3002` to `3006`** (its original default collided with News API's `3002`) — controller ruling P2-R21.

## Running Core locally

```bash
createdb core
DATABASE_URL=postgres://localhost:5432/core ENTRA_TENANT_ID=<tenant> AUTH_AUDIENCE=api://core \
EVENT_SUBSCRIBERS='[]' npm --workspace @gcpe/core run dev
```

### Core environment

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection string |
| `ENTRA_TENANT_ID` | yes | | Entra (Azure AD) tenant whose tokens are accepted |
| `AUTH_AUDIENCE` | yes | | Expected `aud` claim, e.g. `api://core` |
| `PORT` | no | `3001` | HTTP port (the Docker healthcheck follows it) |
| `MIGRATIONS_FOLDER` | no | `apps/core/migrations` (resolved next to the bundle) | Drizzle migrations applied at boot; the Docker image sets `/app/apps/core/migrations` |
| `EVENT_SUBSCRIBERS` | no | `[]` | JSON array of webhook subscribers, see below |

`EVENT_SUBSCRIBERS` is a JSON array; each entry receives the event types it lists (`"*"` means all), signed with its `secret`:

```json
[
  {
    "name": "news-api",
    "url": "https://news-api.internal/events",
    "secret": "<shared HMAC secret, also configured on the receiver>",
    "types": ["org.upserted", "org.deactivated", "tag.upserted"]
  }
]
```

`name` identifies the subscriber in `outbox_deliveries`: after a rename, deliveries still queued under the old name fail as "not configured" and are dead-lettered after 24 h.

Entra app registration: tokens are validated against the v2 issuer (`https://login.microsoftonline.com/<tenant>/v2.0`), so the Core API's app registration manifest must set `"accessTokenAcceptedVersion": 2` (the default `null`/`1` issues v1 tokens whose `iss` is `https://sts.windows.net/<tenant>/` and every request is rejected with 401).

Legacy import (requires network access to a legacy SQL Server copy):

```bash
DATABASE_URL=postgres://localhost:5432/core LEGACY_SQL_SERVER=<host> LEGACY_SQL_USER=<user> LEGACY_SQL_PASSWORD=<pw> \
npm --workspace @gcpe/core run import:legacy
```

## News API (`apps/news-api`)

Drop-in replacement for the BC Gov News API v1 (minus newsletters), including the SignalR `/updates` hub used by `gcpe-news-webapp`.

```bash
createdb news_api_dev
DATABASE_URL=postgres://localhost:5432/news_api_dev npm --workspace @gcpe/news-api run seed:fixtures   # recorded live data
DATABASE_URL=postgres://localhost:5432/news_api_dev EVENT_SECRETS='{"core":"dev","nrms":"dev"}' npm --workspace @gcpe/news-api run dev
curl "http://localhost:3002/api/Posts/Latest/home/default?count=3&api-version=1.0"
```

- Re-record live fixtures: `npm --workspace @gcpe/news-api run record:fixtures` (public read-only GETs, 1 req/s). The compatibility suite (`apps/news-api/test/compat.test.ts`) must stay green.
- Legacy import: `DATABASE_URL=… LEGACY_SQL_SERVER=… LEGACY_SQL_USER=… LEGACY_SQL_PASSWORD=… npm --workspace @gcpe/news-api run import:legacy`
  - Flags (after `--`, each with an env equivalent — a flag wins when both are given; unknown arguments are rejected):
    | Flag | Env | Default | Meaning |
    |---|---|---|---|
    | `--allow-empty-slides` | `LEGACY_ALLOW_EMPTY_SLIDES=true` | `false` | An empty current carousel clears the `slides` table; otherwise an empty result just keeps whatever slides are already there (treated as a transient gap, not "no slides") |
    | `--no-unpublish-missing` | `LEGACY_UNPUBLISH_MISSING=false` | unpublish-missing runs | Skips the unpublish-missing step described below entirely |
  - It is a full import: afterwards, every `posts` row with `origin = 'legacy'` that's still published but absent from legacy's published set is unpublished (skipped if legacy returns no published releases at all — that's far likelier to mean a broken/empty source than legacy genuinely having nothing published).
  - `posts.origin` (`'legacy' | 'event'`, default `'event'`) tracks which pipeline currently owns a post: the event projection (`release.published`/`release.updated`) always writes `'event'`; the legacy importer writes `'legacy'`, **but only when the stored row isn't already `'event'`**. Once NRMS publishes or updates a key — even one the importer previously created — that row belongs to NRMS from then on: the importer's upsert for that key is refused entirely (no write, no notification) rather than reverting the row to `'legacy'` and overwriting NRMS's current content with legacy's stale copy on the next run (controller ruling P1-R21). Refused keys are counted and logged as `skippedEventOwned` in the import result. The unpublish-missing step above only ever looks at `origin = 'legacy'` rows for the same reason.
  - It sends **no** per-release `PostUpdate` notifications (a bulk import would otherwise broadcast once per release to every `/updates` client). Site-content updates (home, features, slides, resource links) are still announced. Connected `gcpe-news-webapp` instances therefore don't learn about imported/unpublished posts until their caches refresh: after an import against a live News API, restart the News API pods (clients reconnect and the webapp clears its caches on reconnect) or the webapp.
- Core reference data reaches the News API as events: configure Core's `EVENT_SUBSCRIBERS` with `{"name":"news-api","url":"http://<news-api>/events","secret":"<same as EVENT_SECRETS.core>","types":["*"]}` and call Core's `POST /api/admin/republish` once.

- `/health/ready` returns 503 while the database is unreachable **or** the Postgres `LISTEN` connection that feeds `/updates` is down/reconnecting (that instance would silently miss pushes); `/health/live` stays 200.

### Exposure: keep `/events` internal

Only `/api/*`, `/updates` (+ `/updates/negotiate`) and `/health/*` belong on the public route. `POST /events` is the signed webhook that Core and NRMS push projection events to, and must be reachable **only on the internal service** (e.g. the OpenShift `Service`, with the public `Route` restricted to the paths above, or a separate internal-only route). Why:

- It is a write path into the read model. HMAC signatures (`EVENT_SECRETS`) authenticate it, but a leaked or weak secret on a public endpoint would let anyone rewrite ministries, releases or site content — keeping it internal means a secret leak alone isn't enough.
- Every request body is buffered (up to the 1 MB event limit, `MAX_EVENT_BYTES`) and HMAC-checked before it can be rejected; publicly reachable, that is free memory and CPU for any anonymous client to burn.
- Nothing outside the cluster legitimately calls it: Core's dispatcher and NRMS are internal callers.

### News API environment

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection string |
| `PORT` | no | `3002` | HTTP port (the Docker healthcheck follows it) |
| `TENANT_CONFIG` | no | `config/tenants/bc.json` (resolved next to the bundle) | Tenant config path, see `packages/config` |
| `EVENT_SECRETS` | no | `{}` | JSON object of event source → shared HMAC secret, e.g. `{"core":"…","nrms":"…"}` |
| `NOD_BASE_URL` | no | | Base URL of the News-on-Demand subscriptions API; omitted means `/api/Subscribe/*` returns 503 |
| `NOD_TOKEN_URL` | no | | OAuth2 client-credentials token endpoint for `NOD_BASE_URL` |
| `NOD_CLIENT_ID` | no | | Client ID for the client-credentials grant |
| `NOD_CLIENT_SECRET` | no | | Client secret for the client-credentials grant |
| `NOD_SCOPE` | no | | OAuth2 scope requested for the client-credentials grant |
| `SUBSCRIBE_RATE_LIMIT_PER_MIN` | no | `300` | Per-client rate limit applied to the `/api/Subscribe/*` proxy |
| `SUBSCRIBE_CLIENT_IP_HEADER` | no | | Request header (e.g. `x-client-ip`) carrying the end user's IP, set by `gcpe-news-webapp`; when set, the subscribe rate limit is keyed on it instead of the caller's IP (falls back to the caller's IP when the header is missing or not an IP). See below |
| `UPDATES_NEGOTIATE_RATE_LIMIT_PER_MIN` | no | `120` | Per-IP rate limit on `POST /updates/negotiate` (429 past it) |
| `UPDATES_MAX_CONNECTIONS` | no | `5000` | Cap on open `/updates` WebSockets; negotiate returns 503 at the cap. Outstanding negotiate tokens are capped at 10,000, oldest evicted first |
| `UPDATES_MAX_CONNECTIONS_PER_IP` | no | `50` | Per-IP cap on open `/updates` sockets (handshaken + outstanding negotiated tokens); negotiate returns 503 `{"error":"too many connections"}` for an IP already at its cap, same as `UPDATES_MAX_CONNECTIONS`. Without this, one IP could hold up to `UPDATES_MAX_CONNECTIONS` sockets and lock every other client out |
| `MIGRATIONS_FOLDER` | no | `apps/news-api/migrations` (resolved next to the bundle) | Drizzle migrations applied at boot; the Docker image sets `/app/apps/news-api/migrations` |

Behind `gcpe-news-webapp`, every subscriber's request arrives from the webapp's IP, so a per-IP subscribe limit collapses all users into one bucket — set `SUBSCRIBE_CLIENT_IP_HEADER` to the header the webapp forwards the user's IP in. Only do this when that header can be trusted: anyone who can reach the News API directly can set it, and rotating its value gives a fresh bucket per request. Either keep the News API reachable only by the webapp, or have the route/proxy in front of it strip or overwrite that header on public traffic.

`NOD_BASE_URL` can be set without the `NOD_TOKEN_URL`/`NOD_CLIENT_ID`/`NOD_CLIENT_SECRET`/`NOD_SCOPE` quartet (the subscribe proxy then forwards unauthenticated); the client-credentials provider is only built when all four are present.

### News API operator notes

- `UPDATES_NEGOTIATE_RATE_LIMIT_PER_MIN` applies per *egress* IP (`req.ip`, honouring the app's `trust proxy` setting), with a fixed 60 s window that isn't configurable. Several `gcpe-news-webapp` instances sharing one outbound NAT all land in the same bucket, as does any one instance that calls `hub.disconnectAll()` (the Postgres `LISTEN` reconnect handler) more than once within a minute — each disconnect sends every currently-connected client straight back to `POST /updates/negotiate` at once. If legitimate traffic is getting 429s for either reason, raise `UPDATES_NEGOTIATE_RATE_LIMIT_PER_MIN`.
- `/health/ready` reports 503 for as long as the dedicated Postgres `LISTEN` connection (that feeds `/updates`) is down or reconnecting — see the exposure note above. If `LISTEN` fails on every pod at the same time (e.g. a Postgres restart/failover all pods are reconnecting to), the read API goes unready on every pod too, not just the `/updates` hub, since `/health/ready` is shared.

### Manual check with the existing .NET public site

Requires the .NET 5 SDK. This is not automated.

1. `git clone https://github.com/bcgov/gcpe-news-webapp && cd gcpe-news-webapp/Gov.News.WebApp`
2. Set `NewsApi` to `http://localhost:3002/` in `appsettings.Development.json` and run `dotnet run`.
3. Open the home page, a release page, and a ministry page. Confirm they render, and that the log shows `SignalR Client Started`.

## NRMS (`apps/nrms`)

Drafts, schedules and publishes releases; the only app in the slice that *emits* `release.*` events (via its outbox/dispatcher) and runs its own `PUBLISH_INTERVAL_MS` poller to flip scheduled releases to published. It has no inbound `/events` receiver.

```bash
createdb nrms_dev
DATABASE_URL=postgres://localhost:5432/nrms_dev LOCAL_ADMIN_ENABLED=true \
LOCAL_ADMIN_PASSWORD_HASH=<hash from `npm run auth:hash-password`> LOCAL_AUTH_SECRET=<32+ char secret> \
EVENT_SUBSCRIBERS='[]' npm --workspace @gcpe/nrms run dev
```

### NRMS environment

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection string |
| `PORT` | no | `3006` | HTTP port (the Docker healthcheck follows it; moved from `3002` — controller ruling P2-R21 — to stop colliding with News API's `3002`) |
| `EVENT_SUBSCRIBERS` | no | `[]` | JSON array of webhook subscribers that receive NRMS's `release.*` events, see [Event wiring](#event-wiring) below |
| `MIGRATIONS_FOLDER` | no | `apps/nrms/migrations` (resolved next to the bundle) | Drizzle migrations applied at boot; the Docker image sets `/app/apps/nrms/migrations` |
| `PUBLISH_INTERVAL_MS` | no | `60000` | How often the scheduled-publish poller runs |

Plus the shared auth env vars — see [Authentication](#authentication-entra-or-local-admin-login-test-environments-only) below.

## Public Site (`apps/public-site`)

Rebuilds the static public site (HTML + assets, under `OUTPUT_DIR`) by reading back from News API whenever it receives a `site.rebuild_requested` event. It has **no** `/api` and no bearer auth at all — its only inbound traffic is the signed `/events` receiver and `/health/*`.

```bash
createdb public_site_dev
DATABASE_URL=postgres://localhost:5432/public_site_dev NEWS_API_URL=http://localhost:3002 \
OUTPUT_DIR=./output EVENT_SECRETS='{"news-api":"dev"}' npm --workspace @gcpe/public-site run dev
```

### Public Site environment

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection string |
| `PORT` | no | `3003` | HTTP port (the Docker healthcheck follows it) |
| `NEWS_API_URL` | yes | | Base URL of the News API this instance rebuilds from |
| `OUTPUT_DIR` | yes | | Directory the rendered static site is written to (the Docker image mounts this as a volume) |
| `SITE_NAME` | only if `TENANT_CONFIG` has no default | from `TENANT_CONFIG`, else required | Site display name |
| `PUBLIC_SITE_URL` | only if `TENANT_CONFIG` has no default | from `TENANT_CONFIG`, else required | Public base URL the rendered site is served from |
| `EVENT_SECRETS` | no | `{}` | JSON object of event source → shared HMAC secret; only `"news-api"` is ever accepted (see [Event wiring](#event-wiring)) |
| `TENANT_CONFIG` | no | `config/tenants/bc.json` (resolved next to the bundle) | Tenant config path, see `packages/config` |
| `MIGRATIONS_FOLDER` | no | `apps/public-site/migrations` (resolved next to the bundle) | Drizzle migrations applied at boot; the Docker image sets `/app/apps/public-site/migrations` |

## NoD — News on Demand (`apps/nod`)

Subscriptions API plus "As-It-Happens" email delivery: on `release.published` it builds per-subscriber delivery records and a send job, then its own `send-jobs` poller forwards chunks to Distribution.

```bash
createdb nod_dev
DATABASE_URL=postgres://localhost:5432/nod_dev EVENT_SECRETS='{"nrms":"dev"}' \
DISTRIBUTION_URL=http://localhost:3005 PUBLIC_SITE_URL=http://localhost:3003 MANAGE_URL=http://localhost:3004/manage \
LOCAL_ADMIN_ENABLED=true LOCAL_ADMIN_PASSWORD_HASH=<hash> LOCAL_AUTH_SECRET=<32+ char secret> \
npm --workspace @gcpe/nod run dev
```

### NoD environment

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection string |
| `PORT` | no | `3004` | HTTP port (the Docker healthcheck follows it) |
| `EVENT_SECRETS` | no | `{}` | JSON object of event source → shared HMAC secret; only `"nrms"`'s `release.published` is ever accepted (see [Event wiring](#event-wiring)) |
| `DISTRIBUTION_URL` | yes | | Base URL of the Distribution app NoD forwards send jobs to |
| `DISTRIBUTION_TOKEN_URL` | no* | | Entra client-credentials token endpoint for calling Distribution |
| `DISTRIBUTION_CLIENT_ID` | no* | | Entra client id for the client-credentials grant |
| `DISTRIBUTION_CLIENT_SECRET` | no* | | Entra client secret for the client-credentials grant |
| `DISTRIBUTION_SCOPE` | no* | | OAuth2 scope requested for the client-credentials grant |
| `DISTRIBUTION_TIMEOUT_MS` | no | `30000` | Per-chunk request timeout against Distribution; also sizes the send-jobs claim lock |
| `PUBLIC_SITE_URL` | yes | | Embedded in As-It-Happens emails as the link back to the public site |
| `MANAGE_URL` | yes | | Embedded in As-It-Happens emails as the subscription-management link |
| `MIGRATIONS_FOLDER` | no | `apps/nod/migrations` (resolved next to the bundle) | Drizzle migrations applied at boot; the Docker image sets `/app/apps/nod/migrations` |

\* All four `DISTRIBUTION_*` Entra fields must be set together, or none of them — see "NoD's token selection" below.

Plus the shared auth env vars — see [Authentication](#authentication-entra-or-local-admin-login-test-environments-only) below.

### NoD's token selection: Entra vs. local, and why you can't switch mid-retry

NoD authenticates its own calls to Distribution one of two ways, chosen once at startup by `distributionTokenProvider` (`apps/nod/src/distribution-token.ts`):

- **Entra client credentials** — used when `DISTRIBUTION_TOKEN_URL`, `DISTRIBUTION_CLIENT_ID`, `DISTRIBUTION_CLIENT_SECRET` and `DISTRIBUTION_SCOPE` are **all** set.
- **A locally minted token** — used when none of the four are set and `LOCAL_ADMIN_ENABLED=true` (test environments only); NoD mints its own short-lived `Distribution.Send` token using the shared `LOCAL_AUTH_SECRET`, with `azp: "nod"`.

Setting some but not all four Entra fields is a startup error.

Distribution scopes both idempotency and a batch's owning app by the calling token's `azp` claim (the Entra client id, or `"nod"` for a local token). **Do not switch which branch is active while any `send_jobs` are mid-retry** — a retry after the switch would carry a different `azp` than earlier attempts of the same job, so Distribution would treat it as a different caller and never dedupe against chunks the old identity already got accepted, silently double-sending them.

## Distribution (`apps/distribution`)

Sends mail batches over SMTP. Has no event wiring of its own — NoD (and any other internal caller) calls its `/api` directly, authenticated the same way as every other app (Entra bearer, or a local token).

```bash
DATABASE_URL=postgres://localhost:5432/distribution_dev SMTP_HOST=localhost SMTP_PORT=1025 \
MAIL_FROM='"BC Gov News" <news@gov.bc.ca>' MAIL_REDIRECT_TO=you@example.com \
LOCAL_ADMIN_ENABLED=true LOCAL_ADMIN_PASSWORD_HASH=<hash> LOCAL_AUTH_SECRET=<32+ char secret> \
npm --workspace @gcpe/distribution run dev
```

### Distribution environment

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection string |
| `PORT` | no | `3005` | HTTP port (the Docker healthcheck follows it) |
| `SMTP_HOST` | yes | | SMTP server host |
| `SMTP_PORT` | no | `587` | SMTP server port |
| `SMTP_SECURE` | no | `false` | Use implicit TLS |
| `SMTP_USER` / `SMTP_PASS` | no | | SMTP auth credentials (omit both for unauthenticated SMTP, e.g. Mailpit) |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | no | `true` | Set `false` only for local/self-signed SMTP |
| `SMTP_CONNECTION_TIMEOUT_MS` / `SMTP_GREETING_TIMEOUT_MS` / `SMTP_SOCKET_TIMEOUT_MS` | no | `10000` / `10000` / `30000` | nodemailer per-connection timeouts; their sum, plus `SMTP_VERIFY_TIMEOUT_MS`, sizes the sender's claim lock per message |
| `SMTP_MAX_CONNECTIONS` | no | `3` | nodemailer pool size |
| `SMTP_VERIFY_TIMEOUT_MS` | no | `10000` | Budget for the `transport.verify()` that tells an SMTP outage from a poison message after a connection-level error; counted per message in the claim lock and stop margin |
| `MAIL_MAX_AGE_MS` | no | `86400000` | Age backstop: a message still pending this long after its batch was created is marked failed |
| `MAIL_FROM` | yes | | `From` header for every sent message |
| `MAIL_REDIRECT_TO` | no† | | Comma-separated list of real addresses every message is actually sent to instead of its real recipients — see the mail-redirect rule below |
| `MAIL_ALLOW_REAL_RECIPIENTS` | no† | `false` | Opt-in to delivering to real recipients (disables the redirect) |
| `INTERNAL_DOMAINS` | no | `` (empty) | Comma-separated list of domains treated as internal by the API's recipient checks |
| `SEND_INTERVAL_MS` | no | `2000` | How often the send poller runs |
| `MIGRATIONS_FOLDER` | no | `apps/distribution/migrations` (resolved next to the bundle) | Drizzle migrations applied at boot; the Docker image sets `/app/apps/distribution/migrations` |

† Startup refuses to boot unless at least one of `MAIL_REDIRECT_TO` or `MAIL_ALLOW_REAL_RECIPIENTS=true` is set — see below.

Plus the shared auth env vars — see [Authentication](#authentication-entra-or-local-admin-login-test-environments-only) below.

### Distribution's mail-redirect safety rule

Distribution refuses to start unless it's told explicitly what to do with real recipients: either

- `MAIL_REDIRECT_TO` is a non-empty, comma-separated list of valid email addresses — every message is sent to **that list instead of its real recipients** (the real recipient list is simply never used at send time), or
- `MAIL_ALLOW_REAL_RECIPIENTS=true` is set — messages go to their real recipients.

If neither is set, startup fails fast with a validation error rather than silently mailing real citizens from a test environment. When both are set, the redirect wins — `MAIL_ALLOW_REAL_RECIPIENTS` is only consulted when `MAIL_REDIRECT_TO` is empty. Every address in `MAIL_REDIRECT_TO` is itself validated as an email address at startup, so a typo (e.g. a bare `qa@`) fails loudly at boot instead of becoming an unroutable `To:` at send time.

## Event wiring

Only three events cross app boundaries in this slice, all signed HMAC webhooks delivered to each receiver's `/events`:

| Source | Event type(s) | Delivered to |
|---|---|---|
| `nrms` | `release.published`, `release.updated`, `release.unpublished` | News API (`apps/news-api`) |
| `nrms` | `release.published` | NoD (`apps/nod`) |
| `news-api` | `site.rebuild_requested` | Public Site (`apps/public-site`) |

Each sender configures `EVENT_SUBSCRIBERS` (a JSON array: one entry per receiver, each with its own secret and the event types it's allowed to see); each receiver configures `EVENT_SECRETS` (a JSON object mapping the sender's `source` name to the **same** secret). A receiver rejects anything signed with the wrong secret, and also rejects event types its source isn't allowed to send (e.g. an `nrms`-signed `org.deactivated` is "ignored", not applied) — see `SOURCE_EVENT_TYPES` in `apps/news-api/src/projections.ts`.

Worked example for NRMS → News API and NoD:

```bash
# NRMS's EVENT_SUBSCRIBERS (sender side)
EVENT_SUBSCRIBERS='[
  { "name": "news-api", "url": "http://localhost:3002/events", "secret": "shared-nrms-to-news-api-secret", "types": ["release.published", "release.updated", "release.unpublished"] },
  { "name": "nod",      "url": "http://localhost:3004/events", "secret": "shared-nrms-to-nod-secret",      "types": ["release.published"] }
]'

# News API's EVENT_SECRETS (receiver side) — the "nrms" key must match NRMS's "news-api" subscriber secret above
EVENT_SECRETS='{"nrms":"shared-nrms-to-news-api-secret"}'

# NoD's EVENT_SECRETS (receiver side) — the "nrms" key must match NRMS's "nod" subscriber secret above
EVENT_SECRETS='{"nrms":"shared-nrms-to-nod-secret"}'
```

News API then emits its own `site.rebuild_requested` to Public Site the same way: News API's `EVENT_SUBSCRIBERS` would include `{ "name": "public-site", "url": "http://localhost:3003/events", "secret": "shared-news-api-to-public-site-secret", "types": ["site.rebuild_requested"] }`, and Public Site's `EVENT_SECRETS` would be `{"news-api":"shared-news-api-to-public-site-secret"}`.

A subscriber's `name` identifies it in `outbox_deliveries`; renaming one mid-flight means deliveries already queued under the old name fail as "not configured" and are dead-lettered after 24 h.

## Authentication: Entra, or local admin login (test environments only)

Every app with an `/api` (Core, News API's admin routes, NRMS, NoD, Distribution) authenticates the same way via `@gcpe/auth`'s `authFromEnv`: Entra bearer tokens in production, or — for test/local environments with no Entra tenant available — a single shared local admin login.

Set, on **every** app sharing the login (same username/password/secret across all of them, so one token minted on any app authenticates admin calls on any other):

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `LOCAL_ADMIN_ENABLED` | no | `false` | Turns the local login on. Without `ENTRA_TENANT_ID`/`AUTH_AUDIENCE` set too, at least one of the two auth methods must be enabled or startup fails |
| `LOCAL_ADMIN_USERNAME` | no | `admin` | Username accepted by `POST /auth/local/token` |
| `LOCAL_ADMIN_PASSWORD_HASH` | yes, when enabled | | Output of `npm run auth:hash-password` — never a plaintext password |
| `LOCAL_AUTH_SECRET` | yes, when enabled | | HMAC secret used to sign minted tokens; must be ≥ 32 characters and **identical** across every app in the shared login |
| `LOCAL_ADMIN_ALLOW_IN_PRODUCTION` | no | `false` | `LOCAL_ADMIN_ENABLED` is refused outright when `NODE_ENV=production` unless this is also `true` — Entra remains the only production identity provider |

Generate a hash once and reuse it everywhere:

```bash
npm run auth:hash-password
# prompts for a password, prints the hash to paste into LOCAL_ADMIN_PASSWORD_HASH

curl -X POST http://localhost:3001/auth/local/token \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"<the password you hashed above>"}'
# {"access_token":"...", "token_type":"Bearer", "expires_in":28800}
```

The returned token carries every admin role (`Core.Admin`, `NRMS.Editor`, `NoD.Admin`, `Distribution.Send`), so one login authenticates admin calls against any of Core, NRMS, NoD or Distribution. Public Site has no `/api` and never checks bearer auth at all.

A boot-time warning (`[auth] LOCAL ADMIN LOGIN ENABLED — test environments only`) is printed on every app that has it on — expect to see it in local/CI logs, never in a production one.

## Running the whole slice locally (Postgres + Mailpit + MinIO)

```bash
docker compose -f deploy/docker-compose.yml up -d
# postgres on localhost:5432, Mailpit SMTP on localhost:1025 (UI at http://localhost:8025), MinIO on localhost:9000/9001
```

Without Docker, `brew install mailpit && mailpit` gives the same SMTP/UI pair directly.

Point Distribution at it with `SMTP_HOST=localhost SMTP_PORT=1025` (no `SMTP_USER`/`SMTP_PASS` — Mailpit accepts unauthenticated SMTP) and open http://localhost:8025 to watch messages arrive instead of hitting a real mail server. Remember Distribution still needs `MAIL_REDIRECT_TO` or `MAIL_ALLOW_REAL_RECIPIENTS=true` set regardless (see the mail-redirect rule above) — Mailpit being a sink doesn't exempt it from that check.

## Known limitations

Deferred by the Phase 2 final-review controller ruling (P2-R22) — tracked here rather than fixed in this pass:

- **Mixed clock sources**: job/message claim loops mix the JS process clock with Postgres's own `now()` in a few places (e.g. comparing a JS-side `Date.now()` against a `default now()`-stamped column). A follow-up refactor extracts a shared claim helper that reads the DB's clock consistently — planned for the next dispatch.
- **NRMS failure-mark/sizing duplication**: the "mark this release/message failed" and "does this payload fit the event-size limit" logic is duplicated across NRMS and the events package rather than shared. A follow-up adds `assertEventFits` to `@gcpe/events` so every caller sizes payloads the same way.
- **`escapeHtml` duplicated three times** (`apps/nod/src/as-it-happens.ts`, `apps/public-site/src/render.ts`, and `apps/distribution/src/substitute.ts`) instead of a single shared helper. Follow-up: extract to a shared package once a natural home (`@gcpe/http-kit` or similar) is settled.
- **`detailsHtml` is rendered unsanitised on the public site** (matches legacy behaviour; content is staff-authored, not public input) — a sanitiser is planned before Phase 6. Relatedly, the home page may briefly render an older list under concurrent rebuilds, and `site.content.changed` doesn't trigger a home-page rebuild on its own — both are Phase 6 work.
- **Static URL casing**: the public site's generated URLs are case-sensitive, while the legacy IIS site treated them case-insensitively. Whether (and how) to normalize this is deferred to a Phase 6 decision.
- **Docker builds are only verified in CI**, not locally as part of this fix wave (no local Docker daemon available here) — rebuild and smoke-test the changed `apps/public-site` image in CI before relying on it. Separately, NoD's legacy array-shaped `batch_ids` column values are currently only exercised against dev databases, not a migrated-from-production fixture.

Then start each app (`npm --workspace @gcpe/<app> run dev`) pointed at its own `createdb`'d database, wired together per [Event wiring](#event-wiring) and [Authentication](#authentication-entra-or-local-admin-login-test-environments-only) above. `tests/e2e/thin-slice.test.ts` is the automated version of this same chain (NRMS release → publish → News API → static page → NoD → Distribution → email), wired in-process over real HTTP instead of separate `npm run dev` processes.
