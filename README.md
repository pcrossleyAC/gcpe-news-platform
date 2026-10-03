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
- Core reference data reaches the News API as events: configure Core's `EVENT_SUBSCRIBERS` with `{"name":"news-api","url":"http://<news-api>/events","secret":"<same as EVENT_SECRETS.core>","types":["*"]}` and call Core's `POST /api/admin/republish` once.

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
| `SUBSCRIBE_RATE_LIMIT_PER_MIN` | no | `300` | Rate limit applied to the `/api/Subscribe/*` proxy |
| `MIGRATIONS_FOLDER` | no | `apps/news-api/migrations` (resolved next to the bundle) | Drizzle migrations applied at boot; the Docker image sets `/app/apps/news-api/migrations` |

`NOD_BASE_URL` can be set without the `NOD_TOKEN_URL`/`NOD_CLIENT_ID`/`NOD_CLIENT_SECRET`/`NOD_SCOPE` quartet (the subscribe proxy then forwards unauthenticated); the client-credentials provider is only built when all four are present.

### Manual check with the existing .NET public site

Requires the .NET 5 SDK. This is not automated.

1. `git clone https://github.com/bcgov/gcpe-news-webapp && cd gcpe-news-webapp/Gov.News.WebApp`
2. Set `NewsApi` to `http://localhost:3002/` in `appsettings.Development.json` and run `dotnet run`.
3. Open the home page, a release page, and a ministry page. Confirm they render, and that the log shows `SignalR Client Started`.
