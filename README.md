# gcpe-news-platform

Node.js + PostgreSQL replatform of the GCPE news toolchain: Corporate Calendar → NRMS → NoD → Distribution → News API → static public site.

- Design: [docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md](docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md)
- Plans: [docs/superpowers/plans/](docs/superpowers/plans/)

## Prerequisites

- Node ≥ 22.12 (`.nvmrc`; required by tedious/@azure and vite/rolldown), npm 10
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
| `apps/core` | Reference data (organizations, sectors, themes, tags, services) |

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
  - `posts.origin` (`'legacy' | 'event'`, default `'event'`) tracks which pipeline currently owns a post: the legacy importer sets it to `'legacy'` on every row it upserts; the event projection (`release.published`/`release.updated`) sets it to `'event'`. Once NRMS publishes or updates a key — even one the importer previously created — that row flips to `'event'` and belongs to NRMS from then on: the unpublish-missing step above only ever looks at `origin = 'legacy'` rows, so a routine import can never unpublish content NRMS now owns.
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

### Manual check with the existing .NET public site

Requires the .NET 5 SDK. This is not automated.

1. `git clone https://github.com/bcgov/gcpe-news-webapp && cd gcpe-news-webapp/Gov.News.WebApp`
2. Set `NewsApi` to `http://localhost:3002/` in `appsettings.Development.json` and run `dotnet run`.
3. Open the home page, a release page, and a ministry page. Confirm they render, and that the log shows `SignalR Client Started`.
