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
