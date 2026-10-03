# gcpe-news-platform

Node.js + PostgreSQL replatform of the GCPE news toolchain: Corporate Calendar → NRMS → NoD → Distribution → News API → static public site.

- Design: [docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md](docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md)
- Plans: [docs/superpowers/plans/](docs/superpowers/plans/)

## Prerequisites

- Node 22 (`.nvmrc`), npm 10
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

Legacy import (requires network access to a legacy SQL Server copy):

```bash
DATABASE_URL=postgres://localhost:5432/core LEGACY_SQL_SERVER=<host> LEGACY_SQL_USER=<user> LEGACY_SQL_PASSWORD=<pw> \
npm --workspace @gcpe/core run import:legacy
```
