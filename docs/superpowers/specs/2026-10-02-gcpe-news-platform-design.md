# GCPE News Platform — Platform Design

**Date:** 2026-10-02
**Status:** Approved in brainstorming; awaiting written-spec review
**Scope:** Platform-level spec (architecture, ownership, contracts, security, roadmap). Each phase gets its own implementation plan; Calendar and NRMS parity each get a spec addendum before their phase starts.

---

## 1. Purpose

Replatform the legacy BC GCPE "Hub" news toolchain onto Node.js + PostgreSQL as a configurable **product**, with **BC as the first deployment** (including data migration). The rebuilt platform must carry a news item end to end:

**Corporate Calendar → NRMS (release management) → NoD (subscriptions) → Distribution (email) → News API → public static HTML site.**

### In scope
- Core (shared reference data, users, roles)
- Corporate Calendar — **full parity** with legacy
- NRMS — release authoring/workflow/publishing **plus** public-site content admin ("Website" section)
- News API — v1 compatible with the existing BC Gov News API (minus newsletters), plus v2 additions
- NoD — subscribers, lists (including media distribution lists), As-It-Happens, Daily Digest, emergency RSS ingest
- Distribution — generic email queue/sender with bounce processing
- Public site — static HTML regenerated on publish
- Per-app importers from legacy SQL Server

### Out of scope
- Media Requests (replaced by Media Hub 2.0, which stays a separate, existing app)
- Newsletters / e-newsletters (all `/api/Newsletters*` endpoints)
- News Dashboard (`gcpe-hub-api` / `gcpe-news-dashboard`) and the legacy `dashboard.*` schema
- Changes to Media Hub beyond emitting contact events (see §7.3)

### Success criteria
1. The end-to-end acceptance test (§10.2) passes: activity → forecast → release → auto-publish → News API → static page → subscriber email captured → bounce recorded.
2. News API v1 responses match recorded live `api.news.gov.bc.ca` responses for all 26 in-scope endpoints given the same data.
3. BC's existing `gcpe-news-webapp` runs unmodified against the new News API (cutover safety net).
4. Legacy data imports are idempotent, re-runnable, and preserve release keys/references and activity IDs so legacy URLs and links keep working.
5. Each app runs alone with no other app present (degraded only in the obvious way, e.g. no events delivered).

---

## 2. Legacy context (summary)

Analysis of the legacy code (folders under `~/HUB`) established:

| Legacy system | Role | Key facts carried into this design |
|---|---|---|
| Hub Legacy — Corporate Calendar (`/Legacy/Calendar`) | Cross-ministry comms activity calendar | 25 `calendar.*` tables; roles ReadOnly<Editor<Advanced<Administrator<SysAdmin (`CustomPrincipal.cs:14`) |
| Hub Legacy — News Release Management (`/Legacy/News/ReleaseManagement`) | Author/schedule/publish releases | `NewsRelease.ActivityId` links to calendar (`Release.aspx.cs:624`); Forecast tab lists calendar activities (`ReleasesModel.cs:196-223`); 60 s publish loop in IIS worker (`Global.asax.cs:65`, `ReleasePublisher.cs`) |
| Hub Legacy — news site admin (`/Legacy/News/*`) | Carousel/slides, emergency banner, live feed, files | Stored in Hub DB `dbo.*` and Azure Blob |
| Hub Legacy — Media Contacts | Outlets/journalists/media lists | Replaced by Media Hub 2.0 + NoD media lists |
| Subscribe — NewsOnDemand Services/Admin | Subscriptions, As-It-Happens, Daily Digest (17:00, `NodTask.cs:91`) | Digest was triggered by Hub every minute (`ReleasePublisher.cs:85`) — coupling removed here |
| Subscribe — NewsDistribution | Generic DB-queued SMTP sender | Content-agnostic queue; priorities system 100 / media 40 / immediate 30 / digest 20, +2 gov recipients |
| Subscribe — EmergencyInfo.exe | EMBC RSS → NoD | Becomes a scheduled job in NoD |
| BC Gov News API (`api.news.gov.bc.ca`) | Feeds public site from Hub DB | **Source not found** (not in any repo visible to `pcrosslegov`); contract recovered from its public swagger (31 paths, 19 models). Runs on IIS 8.5. |
| `gcpe-news-webapp` (GitHub, public) | Public news.gov.bc.ca site (.NET) | Consumes News API via `NewsApi` setting |
| `nrms` (2-day NestJS/Prisma rebuild, NB-branded) | Prototype NRMS on Postgres | Source of NRMS schema/logic to port; its importer has a release-type off-by-one bug (legacy enum is 1–5, `ReleaseType.cs:16-20`; `migrate-from-sqlserver.ts:26-30` maps 0–4) |
| Media Hub 2.0 (`~/media-hub-app`, `bcgov-c/media-hub-app`) | Production BC app | Source of conventions, auth pattern, embedding/semantic-search pattern |

---

## 3. Architecture

### 3.1 Apps and data ownership

Seven apps, **one Postgres database each**. In development and small deployments they share one Postgres server (separate databases); any app's DB can be moved to its own server without code change.

| App | Owns (source of truth) | Holds read-only projections of | Exposure |
|---|---|---|---|
| **Core** | Organizations (ministries/departments) incl. minister profile, contacts, weekend number, social/topic/service links; sectors; themes; tags; services; languages; users; per-app role grants with ministry scope | — | Internal |
| **Calendar** | Activities and all calendar lookups, saved filters, favourites, history, edit locks | Core reference data + users; release status per activity | Internal |
| **NRMS** | Releases (all languages, documents, contacts, images, assets, history, logs); public-site content (slides, home settings, live feed, resource links, top/feature post selections, emergency banner, files) | Core reference data; calendar activities flagged as needing a release (Forecast) | Internal |
| **News API** | Nothing authoritative; a denormalized, serve-ready store of **published** content + embeddings + related-post results | Published releases and site content (from NRMS); reference data (from Core) | **Public** |
| **NoD** | Subscribers, subscriptions, list categories, lists (incl. media distribution lists), articles, per-subscriber delivery records, digest runs | Core reference data (auto-creates lists); published releases (from NRMS); media contact emails (from Media Hub) | Internal (public journeys proxied via News API) |
| **Distribution** | Message batches, recipients, queue, send attempts, bounces | — | Internal |
| **Public site builder** | Generated static HTML (in object storage/CDN) | Reads News API only | Output is **public** |

**Rules**
1. Every table has exactly one owning app. No app writes another app's data.
2. No cross-database queries. Apps interact only via REST APIs and events.
3. Each app must start and serve its own function with no subscribers or upstream apps configured.

### 3.2 Topology

```
                 Entra ID (staff sign-in, all staff UIs)
                                │
  ┌──────────┐  org/sector/theme/tag/user/role events
  │   Core   │───────────────────────────────────────────┐
  └──────────┘                                           ▼
  ┌──────────┐ activity.* events  ┌──────────┐ release.*            ┌────────────┐
  │ Calendar │───────────────────►│   NRMS   │ site.content.changed │  News API  │
  │          │◄───────────────────│ releases │─────────────────────►│ public read│
  └──────────┘ release.status_    │ + website│                      │ + pgvector │
               changed            └────┬─────┘                      └─────┬──────┘
                                       │ release.published                │ site.rebuild_requested
       Media Hub 2.0 ─contact.*─┐      ▼                                  ▼
                        ┌───────▼────────────────┐              ┌─────────────────┐
  public subscribe ────►│ NoD                    │              │ Public site     │
  (via News API proxy)  │ lists, AIH, digest     │              │ builder → HTML  │
                        └───────┬────────────────┘              └─────────────────┘
                                │ POST /messages
                        ┌───────▼────────┐
                        │ Distribution   │──SMTP──► recipients
                        │ queue, bounces │◄─Graph── bounce mailbox
                        └────────────────┘
```

### 3.3 Repository layout

New monorepo `gcpe-news-platform` (npm workspaces):

```
apps/
  core/            calendar/        nrms/          news-api/
  nod/             distribution/    public-site/
packages/
  events/      # outbox, dispatcher, HMAC signing/verification, inbox dedupe, zod event schemas
  auth/        # Entra OIDC (openid-client), stateless signed cookies, Core role checks, service tokens
  db-kit/      # Drizzle setup, migration runner, test DB helpers
  embeddings/  # provider interface; Azure OpenAI default; circuit breaker (from Media Hub server/semantic/)
  ui/          # shared React components (Tailwind)
  config/      # tenant config: branding, org names, domains, sender identities, feature flags
  legacy-import/ # shared SQL Server reader utilities, legacy enum maps (with tests)
docs/
deploy/          # docker-compose (Postgres+pgvector, Mailpit, MinIO), OpenShift manifests
```

Each app: own `Dockerfile`, own Drizzle schema + migrations, own OpenShift Deployment, own DB.

### 3.4 Stack and conventions (from Media Hub 2.0)

- Node 20+, TypeScript, **Express**, **Drizzle ORM + drizzle-zod**, **zod** validation
- React 18 + Vite + Tailwind (Radix primitives) for staff UIs
- Auth: `openid-client` against **Entra ID** only; stateless HMAC-signed cookies (no cross-request `req.session` state; multiple replicas)
- PostgreSQL 16 with **pgvector**
- Email: nodemailer via SMTP relay; Mailpit locally
- Tests: vitest; Playwright for E2E
- Deploy: OpenShift via GitHub Actions; local via docker-compose
- Object storage: S3-compatible (BC Object Storage in BC; MinIO locally)

### 3.5 Multi-tenant / product configuration

Single-tenant deployments, configured per customer through `packages/config` + seed data: branding (logo, colours, site name), organization naming ("Ministry" vs "Department"), public site domain, email sender identities, legacy-import enablement, feature flags (semantic search, staff AI). BC is the first configuration; the `nrms` repo's New Brunswick seed becomes a second example configuration.

---

## 4. Events

### 4.1 Delivery mechanism: outbox + signed webhooks

- Producer writes the event to its `outbox` table **in the same transaction** as the state change.
- A dispatcher worker POSTs each event to subscriber URLs from config, `Content-Type: application/json`, headers `X-Event-Id`, `X-Event-Type`, `X-Event-Timestamp`, `X-Signature` (HMAC-SHA256 over timestamp + body, per-subscriber secret).
- Receivers reject signatures older than 5 minutes (replay protection) and record `event_id` in an `inbox` table; duplicates are acknowledged and ignored (handlers idempotent).
- Retry with exponential backoff for 24 h, then move to `outbox_dead_letter`. Each app has an admin page listing dead letters with replay.
- Ordering: per-aggregate ordering via a monotonically increasing `sequence` per aggregate id; receivers ignore events with a sequence lower than the last applied for that aggregate.
- Every event carries `correlationId` (propagated into downstream events and emails) for end-to-end tracing.

### 4.2 Envelope

```json
{
  "id": "uuid",
  "type": "release.published",
  "version": 1,
  "source": "nrms",
  "aggregateId": "release-key",
  "sequence": 42,
  "occurredAt": "2026-10-02T17:00:00Z",
  "correlationId": "uuid",
  "data": { }
}
```

Schemas for every `type@version` live in `packages/events` as zod schemas, shared by producer and consumer.

### 4.3 Catalogue (v1)

| Event | Producer | Consumers | Payload essentials |
|---|---|---|---|
| `org.upserted` / `org.deactivated` | Core | Calendar, NRMS, News API, NoD | Full org record incl. minister profile, contacts, links |
| `sector.*`, `theme.*`, `tag.*`, `service.*` upserted/deactivated | Core | Calendar, NRMS, News API, NoD | Full record |
| `user.upserted`, `role.granted`, `role.revoked` | Core | Calendar, NRMS, NoD | User id, email, display name, app, role, ministry scope |
| `activity.created` / `activity.updated` / `activity.deleted` | Calendar | NRMS | Fields used by Forecast: id, title, start/end, NR date, ministry, status, NR distribution, NR origins, needs-release flag, confidentiality |
| `release.status_changed` | NRMS | Calendar | Release key, activity id, status, scheduled/published time |
| `release.published` / `release.updated` | NRMS | News API, NoD | **Complete published content** (all languages, documents, contacts, index keys, assets, rendered HTML/text/PDF URLs, publish flags, selected media lists, `notify` flag on updates) — consumers never call back into NRMS |
| `release.unpublished` | NRMS | News API, NoD | Release key |
| `site.content.changed` | NRMS | News API | Changed entity (slide, home, resource link, top/feature selection, live feed, emergency banner) as full record |
| `site.rebuild_requested` | News API | Public site builder | List of affected page identifiers |
| `contact.updated` / `contact.deleted` | Media Hub | NoD | Contact id, email, name |
| `delivery.bounced` | Distribution | NoD (by originating app) | Message id, recipient, hard/soft, timestamp |

---

## 5. Release flow (end to end)

1. **Plan** — Calendar activity flagged "needs release" → `activity.*` → appears in NRMS **Forecast**.
2. **Draft** — Staff create release from a Forecast item (sets `activityId`) or standalone. Types: Release, Story, Factsheet, Update, Advisory. Bilingual content, documents, contacts, images, Flickr/YouTube assets. `release.status_changed` keeps Calendar in sync.
3. **Approve & schedule** — Draft → Approved → Scheduled (`publishAt`). Publish flags `toWeb`, `toSubscribers`, `toMediaLists` (+ selected media lists) replace legacy `PublishOptions` bitmask (1/2/4).
4. **Publish** — NRMS scheduler every 60 s; rows claimed with `FOR UPDATE SKIP LOCKED` so only one replica publishes each release. Per release, one transaction: set `publishedAt`, render final HTML/text/PDF to object storage, write `release.published` to outbox. Flickr "make public" runs **after commit** as a retried side job.
5. **Fan-out** —
   - News API updates projection, enqueues embedding + related-posts computation, emits `site.rebuild_requested`.
   - Site builder regenerates release page, affected index pages, home, feeds.
   - NoD (if `toSubscribers`): As-It-Happens now; queue for 17:00 Pacific digest (advisories excluded). If `toMediaLists`: full-text email to selected media lists (advisories without the Gov News link).
6. **Corrections** — `release.updated`; News API + site update; subscribers re-notified only if staff select "re-notify".
7. **Unpublish** — `release.unpublished`; News API hides; site removes page (legacy URLs return 410 Gone); NoD drops from pending digest.
8. **Schedulers are app-owned** — Daily Digest timer lives in NoD.

---

## 6. News API

### 6.1 v1 compatibility contract

Reproduce the 26 non-newsletter endpoints of the BC Gov News API swagger (saved copy committed at `docs/contracts/news-api-v1.swagger.json`) with identical paths, parameters and JSON shapes, including legacy field names (e.g. `azureAssets`, `azureTranslations`).

**Observed live behaviour that is part of the contract** (probed 2026-10-02 against `api.news.gov.bc.ca`; amended after spec approval):

- `api-version` is **required**: missing → `400 {"error":{"code":"ApiVersionUnspecified",…}}`; values other than `1.0`/`1` → `400 {"error":{"code":"UnsupportedApiVersion",…}}`.
- Not-found semantics differ by endpoint: `Posts/{key}`, `Ministries/{key}`, `Posts/Keys/{reference}` → `200` with an empty body; `Posts/Latest|Keys/{indexKind}/{indexKey}` with a known kind (`home`, `ministries`, `sectors`, `tags`, `themes`) and unknown key → `404` RFC 7231 problem JSON; unknown kind → `200` empty body; `Posts/LatestMediaUri/{mediaType}` with no match → `204`.
- `postKind` omitted (or `default`) → `releases` + `stories`; otherwise exact kind. `count` omitted → all matching posts. Ordering is `publishDate` descending.
- `Posts/Latest/{indexKind}/{indexKey}` **excludes** that index's `topPostKey` and `featurePostKey`; `Posts/Keys/{indexKind}/{indexKey}` does **not** (verified: health's top `2026HLTH0085-001117` and feature `2026INF0034-001103` appear in Keys but not Latest).
- `Posts?postKeys=` takes a **comma-separated** list (swagger default `csv`); results are returned in request order with unknown keys skipped; a repeated `postKeys` parameter uses only the first value.
- `memoryCachable` (in the swagger) is never present in responses.
- All key, index-key and reference lookups are **case-insensitive** (`Posts/2026tt0103-001121`, `Ministries/HEALTH`, `Posts/Keys/nEwS-34336` all resolve); responses keep the stored casing. The 404 problem JSON is served as `application/json; charset=utf-8`.
- `childMinistryKey` is the key of the **active** organization whose parent is this one.
- **SignalR hub at `{base}/updates`** (not in the swagger): `gcpe-news-webapp` (`Repository.cs:56-100`) connects with `Microsoft.AspNetCore.SignalR.Client` 5.0.9 and listens for `PostUpdate`, `MinisterUpdate`, `HomeUpdate`, `SlideUpdate`, `ResourceLinkUpdate`, `ThemeUpdate`, `TagUpdate`, `SectorUpdate`, `MinistryUpdate` (argument: array of keys). Without a connected hub the webapp never requests latest posts (`Repository.cs:567`), so the hub is required for success criterion 3.

| Endpoints | Source |
|---|---|
| `GET /api/Posts/{key}`, `GET /api/Posts?postKeys=`, `GET /api/Posts/Latest/{indexKind}/{indexKey}?postKind&count&skip`, `GET /api/Posts/Keys/{indexKind}/{indexKey}?postKind&count&skip`, `GET /api/Posts/Keys/{reference}`, `GET /api/Posts/LatestMediaUri/{mediaType}` | NRMS release events |
| `GET /api/Ministries`, `/{key}`, `/{key}/Minister`; `GET /api/Sectors`, `/{key}`; `GET /api/Themes`, `/{key}`; `GET /api/Tags`, `/{key}` | Core events (+ top/feature post keys from NRMS site content) |
| `GET /api/Home`, `GET /api/Slides`, `/{id}`, `GET /api/ResourceLinks` | NRMS site content events |
| `/api/Subscribe/*` (6 endpoints) | **Proxied to NoD** over the internal network with a service token; News API stores no subscriber data |

Excluded: `/api/Newsletters*` (5 paths).

Behaviour of `indexKind`, `postKind`, sort order, and paging edge cases is **established empirically** from recorded live responses (§10.3) before implementation of the Posts endpoints.

### 6.2 v2 additions (`/api/v2`)

- `GET /api/v2/search?q=&ministry=&sector=&type=&from=&to=&page=` — hybrid: Postgres FTS ∪ pgvector kNN (cosine), fused ranking; FTS-only fallback when embeddings unavailable (circuit breaker).
- `GET /api/v2/posts/{key}/related` — top 5 by vector similarity, precomputed on publish.
- `GET /api/v2/changes?after=` — ordered change feed for the site builder to catch up after downtime.

### 6.3 Store, caching, abuse controls

- Denormalized, response-shaped tables; no joins on hot paths.
- Embeddings: Azure OpenAI `text-embedding-3-small` (1536-d) via `packages/embeddings`; background worker; **published content only**.
- `ETag` + `Cache-Control` on all GETs; projections update within seconds of events.
- Read endpoints anonymous (as today). Subscribe proxy endpoints rate-limited (`express-rate-limit`) and CAPTCHA-protected.

### 6.4 Import

Reference data (`Ministry*`, `Sector`, `Theme`, `Tag`, `Service`) is imported into **Core** (Phase 0) and reaches the News API as Core events. The News API's own Phase 1 importer covers legacy `dbo.NewsRelease*` (published, committed, active only), `Slide`/`Carousel*`, `ResourceLink`, `ApplicationSetting` (`HomeTopReleaseId`, `HomeFeatureReleaseId`, `granville`) and per-category `TopReleaseId`/`FeatureReleaseId`, preserving `Key` and `Reference`. Once NRMS exists, NRMS becomes the importer of record and the News API is rebuilt from NRMS events (replay).

---

## 7. NoD and Distribution

### 7.1 NoD data and rules

- Subscribers, verification/manage tokens, list categories (ministries, sectors, themes, tags, media distribution, emergency), lists, subscriptions (all news vs specific lists; As-It-Happens and/or Daily Digest), articles, per-subscriber delivery records (no duplicate sends).
- Lists for orgs/sectors/themes/tags are created and renamed **automatically** from Core events.
- Journeys (via News API proxy): subscribe → double opt-in email → manage via tokenized link → unsubscribe. All emails carry `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058).
- Retention (legacy parity, `SubscriptionProvider.cs:105-147`):
  - Unverified subscribers deleted 10 days after registration.
  - Records of subscribers who unsubscribed, were deleted by an admin, or changed email (old record) are permanently purged 90 days after that event (10-day look-back window).
- Bounces (legacy parity): hard bounce marks delivery; **10 hard bounces within 15 days** removes the subscriber.

### 7.2 Sending rules

| Trigger | Audience | Content |
|---|---|---|
| `release.published` with `toSubscribers` | As-It-Happens subscribers on any matching list | Rendered once per release, per-subscriber link substitution |
| 17:00 Pacific digest run | Digest subscribers | One email per subscriber per day grouping matching releases; advisories excluded |
| `toMediaLists` | Selected media distribution lists | Full text; advisories omit the Gov News link |
| Emergency category item | Everyone on the list, regardless of timing preference | As-It-Happens format |

### 7.3 Media distribution lists

NoD owns media lists. Staff add journalists by searching Media Hub through its API from NoD's admin UI; NoD stores Media Hub contact id + email. Media Hub emits `contact.updated` / `contact.deleted` (the only Media Hub change in scope). Until that ships, NoD runs a nightly reconciliation against Media Hub's API.

### 7.4 Other NoD functions

- Emergency RSS ingester (replaces `EmergencyInfo.exe`): scheduled job, EmergencyInfoBC feed → emergency articles.
- Admin UI: subscribers (search/edit/history), lists & categories, reports (active subscribers, recent unsubscribes, per-release sends, digest runs), global pause/resume.

### 7.5 Distribution

- API: `POST /messages` `{ appId, priority, content | templateId, recipients[{email, substitutions}] }` → `batchId`; `GET /batches/{id}` for status. Authenticated with Entra service tokens.
- Queue: Postgres, claimed with `SELECT … FOR UPDATE SKIP LOCKED`, multiple workers; configurable send rate and concurrency.
- Priority: system 100, media 40, immediate 30, digest 20; +2 for recipients in configured internal domains.
- SMTP relay (BC: `apps.smtp.gov.bc.ca`), TLS validated.
- Bounces: read bounce mailbox via **Microsoft Graph** (Entra app permission restricted to that mailbox by application access policy); parse DSNs; emit `delivery.bounced` to originating app.
- **Mock email redirect** (Media Hub pattern): admin setting; **on by default in non-prod**; redirects all mail to configured addresses and logs the original recipient.

### 7.6 Capacity assumptions (to verify before Phase 4)

Unverified: a single release may target tens of thousands of subscribers; throughput bound by relay rate limits. Before Phase 4: obtain current counts from legacy `Subscriber` and the relay's per-minute limit.

---

## 8. Corporate Calendar (full parity)

### 8.1 Data

- `activities` (~50 fields): dates (start/end, potential dates, all-day, confirmed, NR date), text (title, details, schedule, significance, strategy, comments, HQ comments), classification (status, HQ status/section, priority, lead organization, venue, city/other city), people (contact ministry, government representative, communication contact, event planner, videographer, premier-requested), flags (issue, at legislature, confidential, cross-government, milestone), nine per-field *needs-review* flags, audit columns, version.
- Join tables: categories, communication materials, files, initiatives, keywords, NR origins, sectors, services, shared-with ministries, themes.
- Lookups: Category, City, CommunicationContact, CommunicationMaterial, EventPlanner, GovernmentRepresentative, Initiative, Keyword, NewsFeed, NRDistribution, NROrigin, PremierRequested, Priority, Status, Videographer — managed via one generic lookup admin.
- Saved filters, favourites, change log, edit locks.

### 8.2 Access

- Roles via Core, ministry-scoped: ReadOnly < Editor < Advanced < Administrator < SysAdmin.
- HQ (application-owner organizations) sees across ministries.
- Confidential activities visible only to the owning ministry, shared-with ministries, and HQ.
- **Daily change freeze: non-HQ users cannot change content 16:00–17:00 Pacific** (configurable). Note: legacy code implements 04:05–17:00 (`ChangeFreezeWindowHandler.ashx.cs:46`, `new TimeSpan(4, 05, 0)`) despite its comment and user message saying 4–5 pm; this design implements the **intended** window, enforced server-side (legacy enforced only client-side).
- Admin: user list, role assignment (via Core), transfer of activities between users/ministries.

### 8.3 Features

List/filter (saved filters, favourites, my ministry / shared with me / all); activity editor with edit locks, conflict warning, cancel changes, needs-review trail cleared by HQ; field-level history; "updates" feed (since last visit / today / date range, legacy `GetCorpCalendarUpdates*`); per-user tokenized iCal feed; attachments in object storage; reports — Look Ahead (4 sub-sections: awareness/consultation/outlook; event/speech/release; issues; legend), 30/60/90 monthly, Planning — as HTML templates exported to PDF and Word.

### 8.4 Integration and import

- Emits `activity.*`; consumes `release.status_changed` (shows release status + link on the activity).
- Imports all `calendar.*` tables **preserving legacy activity IDs** (required to re-link `NewsRelease.ActivityId`). `SystemUser`/`SystemUserMinistry` import into Core; matched to Entra accounts by email/IDIR.
- Report parity: each report generated from migrated data and compared side by side with legacy output for the same date range (requires read access to a legacy environment).

A Calendar spec addendum (field-by-field mapping, report layouts, validation rules) is written before Phase 5.

---

## 9. NRMS

Ported from the `nrms` prototype (NestJS/Prisma → Express/Drizzle per §3.4) and brought to legacy parity. Spec addendum before Phase 3 covers field mapping and screens. Known requirements:

- Release types Release=1, Story=2, Factsheet=3, Update=4, Advisory=5 (legacy enum values preserved in import mapping).
- Views: Forecast / Drafts / Scheduled / Published, filterable by type (legacy routes).
- Bilingual documents, contacts, images (multi-size), Flickr/YouTube assets (Flickr public-on-publish as post-commit job), HTML/text/PDF rendering, history, logs, subscriber counts (from NoD API), media list selection (from NoD API).
- **Website section**: slides/carousel, home settings (live webcast URLs, `granville` flag, top/feature post), emergency banner, live feed, resource links, top/feature post per org/sector/theme/tag, file management (object storage).
- Gaps to close from the prototype: RBAC on documents/images/reference endpoints, no open registration, no hard-coded admin credentials, ministry-scoped permissions.

---

## 10. Security and testing

### 10.1 Security

- Staff auth: Entra OIDC auth-code + PKCE via `openid-client`; stateless signed cookies; Core roles checked per request **and per record** (ministry scope, confidentiality).
- Service-to-service: Entra client-credential tokens for APIs; HMAC + timestamp for webhooks.
- Secrets only in OpenShift Secrets / local `.env` (never committed); CI runs secret scanning, `npm audit`, container image scanning.
- PII: subscriber emails stored only in NoD and Distribution; PII columns encrypted at rest; admin access audited; embeddings never include subscriber data; staff-side AI over unpublished drafts behind a feature flag, **off by default**, pending PIA.
- Internet-facing: News API and static site only. All other apps internal.
- Non-prod mail redirect on by default.

### 10.2 Testing

| Level | Purpose |
|---|---|
| Unit (vitest) | Publish timing, digest grouping, change freeze, bounce thresholds, priorities, retention |
| Integration (real Postgres + pgvector) | Queries, outbox/inbox, SKIP LOCKED queues, migrations |
| Event contract | Shared zod schemas; producer fixtures validated by consumer tests |
| News API v1 compatibility | Recorded live responses for all 26 endpoints vs new API on equivalent data |
| Importer | Fixtures containing real legacy values (enums, LCIDs 4105/3084, nulls, GUIDs) |
| **E2E acceptance** (Playwright) | Calendar activity → Forecast → draft/approve/schedule → auto-publish → News API returns post → static page exists → Mailpit captures As-It-Happens email → simulated bounce recorded |

### 10.3 Recording the live News API

Phase 1 records responses from `https://api.news.gov.bc.ca` (public, read-only GETs; Subscribe endpoints excluded) into `fixtures/news-api-v1/`, at a polite request rate. These fixtures define expected shapes and the empirical behaviour noted in §6.1.

---

## 11. Roadmap

| Phase | Deliverable | Exit check |
|---|---|---|
| 0. Foundation | Monorepo, `events`/`auth`/`db-kit`/`config` packages, CI, docker-compose (Postgres+pgvector, Mailpit, MinIO), Core with reference data | Two sample apps exchange a signed event with dedupe + retry in an integration test |
| 1. News API v1 | 26 endpoints, live-response compatibility suite, legacy importer, event intake | Compatibility suite green; `gcpe-news-webapp` renders home/release/ministry pages against it locally |
| 2. Thin E2E slice | Minimal NRMS publish → News API → static page → NoD → Distribution → Mailpit | Reduced E2E test green |
| 3. NRMS parity | Port + legacy gaps + Website section | NRMS addendum acceptance list |
| 4. NoD + Distribution parity | Journeys, digest, media lists, Graph bounces, admin, reports, emergency RSS | Digest/bounce/retention tests; capacity check vs relay limits |
| 5. Calendar parity | §8 complete + Forecast link | Report side-by-side parity; full E2E green |
| 6. Public site + AI | Full static site, v2 search, related posts, staff similar-item help | Lighthouse/accessibility checks; search relevance spot-checks |
| 7. Cutover | Import rehearsals, OpenShift deploy, parallel run, DNS switch | Rehearsal row counts reconcile; legacy URLs resolve |

### Prerequisites to confirm per phase (assumptions, not verified)

- Phase 1: none beyond public News API access. Legacy data for import tests limited to `gcpe-hub-develop/db-scripts` sample data until a legacy DB copy is available.
- Phase 3/5/7: read access to a legacy SQL Server copy (Hub, NewsOnDemand, NewsDistribution).
- Phase 4: SMTP relay rate limits; bounce mailbox + Graph app registration.
- Phase 6: Azure OpenAI embedding deployment (Canada region).
- Phase 7: OpenShift namespaces; DNS ownership for cutover.

---

## 12. Open questions

1. Whether the legacy News API source exists in an internal (non-GitHub) repository — would reduce Phase 1 risk if found; does not block the design.
2. Actual production behaviour of the legacy change freeze (04:05–17:00 as coded vs 16:00–17:00 as intended) — to confirm with BC's Calendar manager; design implements 16:00–17:00 regardless.
