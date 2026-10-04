# Phase 3d — Website Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Site editors can manage the home page's carousel (with a scheduled next carousel), emergency pins, Live Feed, resource links and general files; Core.Admin can switch Project Blue Bridge with a typed confirmation; editors can set Top/Feature slots. Every change is logged with its actor and reaches the News API's home record through `site.content.changed`. The public site shows the Blue Bridge banner, prefixed "TEST —" and with `noindex` on every page when it isn't the real production site.

**Architecture:** NRMS gains website tables (migration `0012_website`), a `website/` service folder, `/api/site/*` routes, and a `site` background worker (carousel switch-over) added to `/stack/tick`. Every write emits a full-snapshot `site.content.changed` event (`home`, `slides`, `resourceLinks`, `categoryFeatures`) through the existing outbox in the same transaction. The News API (already a consumer) additionally requests a home-page rebuild on `site.content.changed`. The public site reads `GET /api/Home` when rendering to show the Blue Bridge banner. Blue Bridge emails all Core.Admin users via a new narrow Core endpoint and an NRMS Core client.

**Tech Stack:** Node 24, TypeScript 5.9 strict, Express 5, Drizzle 0.45 / drizzle-kit 0.31, zod 3.25, Vitest 4.1, supertest. No new third-party runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-03-nrms-parity-design.md` §6 (Website section) and §9 acceptance items 12–13. Phase overview: `docs/superpowers/plans/2026-10-03-phase-3-overview.md`. Builds on 3a (auth, roles, `actorOf`), 3b (releases, publisher, outbox, Distribution client), 3c (`@gcpe/storage`, `sniff`, `/files` mount). Code map used to write this plan: the event schema is `packages/events/src/catalogue.ts:117-157` (`slideRecordSchema`, `siteContentChangedSchema`); the consumer is `apps/news-api/src/projections.ts` `applySiteContent`; the outbox call is `enqueueEvent(tx, input, subscribers)` from `@gcpe/events` as used in `apps/nrms/src/publisher.ts`.

## Global Constraints

- Worktree `/Users/paul/gcpe-news-platform-p3`, branch `feat/phase-3`. Commit locally after each task. Never add a `Co-Authored-By` trailer or any AI attribution. Never commit `CLAUDE.md`.
- Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`; type-check: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`. Deps (none expected): `npx -y npm@11 install <pkg> -w <workspace>`.
- Migrations via drizzle-kit: `cd apps/nrms && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`. Next NRMS migration is `0012`. If drizzle-kit prompts, stop and report.
- Worker time comparisons use the DB clock (`sqlNow` / `now()`), never `Date.now()`.
- **Permissions (spec §6):** `NRMS.SiteEditor` — carousel, emergency pins, Live Feed, resource links, files. `Core.Admin` — Project Blue Bridge. `NRMS.Editor` — Top/Feature. Reads of `/api/site/*`: any of `NRMS.Viewer`, `NRMS.Editor`, `NRMS.SiteEditor`, `Core.Admin`.
- **Field limits (spec §6.1):** slide headline ≤ 255, summary ≤ 255, action URL ≤ 255, Facebook post URL ≤ 255 (URLs must be `http(s)` absolute or empty), justify `left` | `right`, image JPEG or PNG by content (`sniff`), ≤ 2 MiB (2 × 1024 × 1024 bytes). Resource link text ≤ 255, URL ≤ 255 `http(s)` or site-relative starting with `/`.
- **Carousel retention:** one live carousel, at most one next carousel, five past carousels kept (older deleted with their slides).
- **Blue Bridge confirmation phrase:** exactly `KING CHARLES III` (case-sensitive, surrounding whitespace trimmed) plus `acknowledgeIgrs: true`. The IGRS warning text (legacy, `ProjectBlueBridge.aspx:50`): `Do not click OK unless you have approval from IGRS`.
- **Blue Bridge banner text** (from bcgov/gcpe-news-webapp `_BlueBridgeBanner.cshtml`, Q2): `ALERT: His Majesty King Charles III, King of Canada, has passed away at the age of N`, where N is his age in whole years on the render date (born 1948-11-14, BC time).
- **Test-site rule (ruling, see C39):** a site is a *test site* unless it is the real production deployment. `isTestSite(env) = env.NODE_ENV !== "production" || env.LOCAL_ADMIN_ALLOW_IN_PRODUCTION === "true" || env.SITE_ENVIRONMENT === "test"`. boxs.ca runs `NODE_ENV=production` with `LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true`, so it is a test site. On a test site every public page carries `<meta name="robots" content="noindex, nofollow">` and the Blue Bridge banner text is prefixed `TEST — `.
- Events: `type: "site.content.changed"`, `source: "nrms"`, aggregate ids `site:home`, `site:slides`, `site:resourceLinks`, `` `site:feature:${kind}:${key}` `` (the ids the News API importer already uses). Each event is a **full snapshot** of its entity, enqueued in the **same transaction** as the write. Timestamps: `new Date(...).toISOString()` from the DB row's `updated_at`.
- Never log secrets, tokens, file contents or image bytes.

## Review Focus

1. A site editor tries to switch Blue Bridge, or an admin sends the phrase in lower case or omits `acknowledgeIgrs` → refused (403 / 422), nothing changes, no event. (Task 4 tests.)
2. Two site editors save the same carousel or link list from stale copies → the second gets 409 and nothing is lost silently. (Tasks 2 and 3 tests with `version`.)
3. The next carousel's go-live time passes while the stack was down for an hour → the next tick switches over once, the emergency pins are still present in the emitted slides, and exactly five past carousels remain. (Task 2 test.)
4. A release holding a Top/Feature slot is unpublished or deleted → the slot is emptied and the News API is told, so the home page never points at a missing post. (Task 5 test.)
5. A general file upload named like an existing file, or with bytes that don't match `.pdf` → 409 (unless `replace=true`) / 422; a name like `../x.pdf` stays inside the files namespace. (Task 3 tests.)

---

## File structure

| File | Responsibility |
|---|---|
| `apps/nrms/src/db/schema.ts` (+ `migrations/0012_website.sql`) | Website tables |
| `apps/nrms/src/website/events.ts` (new) | Build and enqueue `site.content.changed` snapshots; `writeSiteLog` |
| `apps/nrms/src/website/carousel.ts` (new) | Carousels, slides, emergency pins, switch-over worker |
| `apps/nrms/src/website/settings.ts` (new) | Live Feed, Blue Bridge |
| `apps/nrms/src/website/links.ts` (new) | Resource links |
| `apps/nrms/src/website/files.ts` (new) | General files |
| `apps/nrms/src/website/features.ts` (new) | Top/Feature slots, "what's featured where", clearing on unpublish |
| `apps/nrms/src/website/errors.ts` (new) | `SiteRuleError` (422), `SiteConflictError` (409), `SiteNotFoundError` (404) |
| `apps/nrms/src/http/site-routes.ts` (new) | `/api/site/*` routes |
| `apps/nrms/src/clients.ts` | + `coreClient` (`adminEmails()`) |
| `apps/core/src/http/users.ts`, `routes.ts`, `packages/auth/src/roles.ts` | + `GET /api/directory/admin-emails`, service role `Core.AdminDirectory` |
| `apps/news-api/src/projections.ts` | Request a home rebuild on `site.content.changed` |
| `apps/public-site/src/{site-env.ts,render.ts,news-api-client.ts,rebuild.ts}` | Test-site rule, `noindex`, Blue Bridge banner |
| `apps/stack/src/{env.ts,stack.ts}` | `CORE_URL` default for NRMS, `nrms.site` tick step |

---

### Task 1: Website schema, site log and event snapshots

**Files:**
- Modify: `apps/nrms/src/db/schema.ts` (+ generated `0012_website` migration)
- Create: `apps/nrms/src/website/events.ts`, `apps/nrms/src/website/errors.ts`, `apps/nrms/src/website/events.test.ts`
- Modify: `apps/news-api/src/projections.ts` (+ its test)

**Interfaces:**
- Tables (all timestamps `timestamptz`):
  - `carousels`: `id uuid pk default random`, `state text not null check in ('live','next','past')`, `go_live_at timestamptz null` (required when `state='next'`, check), `went_live_at timestamptz null`, `version integer not null default 1`, `created_at default now()`, `updated_at default now()`. Partial unique indexes: one row where `state='live'`, one where `state='next'`.
  - `slides`: `id uuid pk default random`, `carousel_id uuid not null fk → carousels on delete cascade`, `sort_index integer not null`, `headline text not null`, `summary text not null default ''`, `action_url text not null default ''`, `facebook_post_url text not null default ''`, `justify text not null default 'left' check in ('left','right')`, `image bytea null`, `image_type text null`, `updated_at default now()`. Index `(carousel_id, sort_index)`.
  - `emergency_pins`: `slot text pk check in ('primary','secondary')`, `pinned boolean not null default false`, `slide_id uuid not null default random` (stable id used in the event), same slide content columns as `slides`, `version integer not null default 1`, `updated_at`.
  - `site_settings`: single row `id integer pk default 1 check (id = 1)`, `live_feed_enabled boolean not null default false`, `live_manifest_url text not null default ''`, `live_m3u_url text not null default ''`, `granville text null`, `links_version integer not null default 1`, `version integer not null default 1`, `updated_at`. The migration inserts the single row.
  - `resource_links`: `id uuid pk default random`, `sort_index integer not null`, `text text not null`, `url text not null`.
  - `site_files`: `id uuid pk default random`, `storage_key text not null unique`, `name text not null unique` (the public file name), `content_type text not null`, `size integer not null`, `created_at default now()`, `created_by text not null`.
  - `site_log`: `id bigserial pk`, `at timestamptz default now()`, `actor_id text not null`, `actor_name text not null`, `area text not null check in ('carousel','pins','live-feed','blue-bridge','links','files','features')`, `text text not null`. Index `(at desc)`.
  - The existing `category_features` table (migration 0003, unused) is kept as is for Task 5.
- `website/errors.ts`: `class SiteRuleError extends Error { constructor(public problems: string[]) }` (→ 422 `{ errors: problems }`), `class SiteConflictError extends Error` (→ 409, message `Someone else changed this — reload to see their changes` unless given), `class SiteNotFoundError extends Error` (→ 404).
- `website/events.ts`:
  - `writeSiteLog(tx, actor: Actor, area: SiteLogArea, text: string): Promise<void>`
  - `homeSnapshot(tx): Promise<SiteContentChanged & { entity: "home" }>` — from `site_settings` + `category_features` row `('home','default')`; release ids resolved to release **keys** (`news_releases.key`); `liveWebcastFlashMediaManifestUrl` / `liveWebcastM3uPlaylist` are the stored URLs when `live_feed_enabled`, else both `null` (empty string → `null`); `granville` is the stored value or `null`; `timestamp` = `site_settings.updated_at`.
  - `slidesSnapshot(tx)` — pinned emergency slides first (`primary` → `sortIndex -2`, `secondary` → `-1`, only when `pinned`), then the live carousel's slides with `sortIndex` 0..n-1 in order. Each slide: `{ id, sortIndex, headline, summary, actionLabel: null, actionUri: action_url || null, imageBase64, imageType, facebookPostUri: facebook_post_url || null, justify: "Left" | "Right", timestamp }` (legacy capitalisation for `justify`). No live carousel → only the pins.
  - `linksSnapshot(tx)` — `{ entity: "resourceLinks", links: [{ sortIndex, text, uri }], timestamp }` ordered by `sort_index`.
  - `featureSnapshot(tx, kind: "ministries" | "sectors" | "themes", key)` — `{ entity: "categoryFeatures", kind, key, topPostKey, featurePostKey }`.
  - `emitSite(tx, subscribers, which: "home" | "slides" | "links" | { kind, key })` — builds the snapshot and calls `enqueueEvent(tx, { type: "site.content.changed", source: "nrms", aggregateId, data }, subscribers)`.
- News API `projections.ts`: after `applySiteContent` succeeds, enqueue `site.rebuild_requested` with `pages: ["home"]`, `aggregateId: "site:home-page"`, `source: "news-api"`, in the same transaction (add a `requestHomeRebuild` next to `requestRebuild`).

- [ ] **Step 1: Failing tests.** `events.test.ts` (real DB via `createNrmsTestDb`):

```ts
// 1. a fresh database has exactly one site_settings row; homeSnapshot gives all-null URLs/granville/post keys
// 2. live feed enabled with URLs → snapshot carries them; disabled → both null even though URLs are stored
// 3. slidesSnapshot: pinned primary (-2) and secondary (-1) come before live slides 0..n-1; an unpinned pin is absent; justify "Right" for 'right'
// 4. slidesSnapshot with no live carousel returns only pinned slides
// 5. emitSite("slides") inserts one outbox_events row of type site.content.changed whose data passes siteContentChangedSchema, aggregate "site:slides"
// 6. homeSnapshot resolves category_features ('home','default') release ids to release keys
// 7. the DB refuses a second 'live' carousel and a 'next' carousel without go_live_at
```

News API: extend the existing `site.content.changed` projection test — applying a `home` change also enqueues one `site.rebuild_requested` with `pages: ["home"]`.

- [ ] **Step 2: Run, verify failure.** **Step 3: Implement** (schema → `generate --name website` → hand-add the `INSERT INTO site_settings (id) VALUES (1)` to the generated SQL, then services). **Step 4:** run `apps/nrms apps/news-api packages/events` + tsc + full suite. **Step 5: Commit** `feat(nrms): website tables, site log and site.content.changed snapshots`.

---

### Task 2: Carousel, slides, emergency pins and the switch-over worker

**Files:**
- Create: `apps/nrms/src/website/carousel.ts`, `apps/nrms/src/website/carousel.test.ts`, `apps/nrms/src/http/site-routes.ts`, `apps/nrms/src/http/site-routes.test.ts`
- Modify: `apps/nrms/src/http/routes.ts` (mount `siteRoutes` under `/site`; add the three site errors to `handleError`), `apps/nrms/src/app.ts` / `start.ts` (pass `subscribers`, add worker `site`), `apps/stack/src/stack.ts` (tick step `{ name: "nrms.site", run: worker(nrms, "site") }` placed **before** `nrms.publish`)

**Interfaces:**
- Views: `SlideView { id, headline, summary, actionUrl, facebookPostUrl, justify: "left" | "right", hasImage: boolean, imageUrl: string | null }` (`imageUrl` = `/nrms/api/site/slides/<id>/image` or for pins `/nrms/api/site/pins/<slot>/image`); `CarouselView { id, state, goLiveAt: string | null, wentLiveAt: string | null, version, slides: SlideView[] }`; `PinView { slot, pinned, version, slide: SlideView }`.
- Service (`carousel.ts`), all writes take `actor` and `subscribers` and run in one transaction:
  - `getCarousels(db): Promise<{ live: CarouselView | null; next: CarouselView | null; past: CarouselView[] }>` (past newest first).
  - `createNextCarousel(db, { goLiveAt }, actor, subs)` — refuses if a next carousel exists (`SiteConflictError("There is already a next carousel.")`); copies the live carousel's slides (new slide ids, images copied) or starts empty; `goLiveAt` must be in the future by DB clock (`SiteRuleError(["Choose a go-live time in the future."])`). Log `Created the next carousel for <BC time>`.
  - `saveCarousel(db, id, { version, goLiveAt?, slides: SlideInput[] }, actor, subs)` — `SlideInput { id?: string; headline; summary; actionUrl; facebookPostUrl; justify }`; replaces the carousel's slide list in the given order (existing ids keep their image; unknown ids → `SiteRuleError`); past carousels are read-only (`SiteConflictError("Past carousels can't be changed.")`); version check → `SiteConflictError`; bumps version. If the carousel is live → `emitSite("slides")`. Log `Saved the live carousel` / `Saved the next carousel`.
  - `setSlideImage(db, slideId, bytes, actor, subs)` / `setPinImage(db, slot, bytes, actor, subs)` — `sniff` must give PNG or JPEG (`SiteRuleError(["Upload a JPEG or PNG image."])`), ≤ 2 MiB (route enforces 413 via body limit); emits slides if it affects what's live.
  - `makeNextLive(db, actor, subs)` (button "Make live now") and the worker `switchCarousels(db, subs, opts?: { now?: TestClock }): Promise<{ switched: boolean }>` — when a next carousel's `go_live_at <= now()`: live → `past`, next → `live` with `went_live_at = now()`, delete past carousels beyond the newest five, `emitSite("slides")`, log as `SYSTEM_ACTOR` `The next carousel went live`. Claims with `FOR UPDATE SKIP LOCKED` so two concurrent ticks switch once. Pins are untouched (C21).
  - `deleteNextCarousel(db, version, actor)`.
  - Pins: `getPins(db): Promise<PinView[]>`; `savePin(db, slot, { version, headline, summary, actionUrl, facebookPostUrl, justify }, actor, subs)`; `setPinned(db, slot, { version, pinned }, actor, subs)` — both emit slides when the pin is (or was) pinned; log `Pinned the primary emergency slide` etc. Pinning requires a headline (`SiteRuleError(["Add a headline before pinning."])`).
  - Image bytes: `slideImage(db, id)`, `pinImage(db, slot)` → `{ bytes, mimeType } | null`.
- Routes (`site-routes.ts`, JSON unless noted; `edit = requireRole("NRMS.SiteEditor")`, `read` per Global Constraints):
  - `GET /site/carousels` (read); `POST /site/carousels/next` `{ goLiveAt }` (edit) → 201; `PUT /site/carousels/:id` (edit); `POST /site/carousels/next/make-live` (edit); `DELETE /site/carousels/next?version=N` (edit)
  - `PUT /site/slides/:id/image` raw body ≤ 2 MiB (edit); `GET /site/slides/:id/image` (read) with stored type, `cache-control: private, max-age=300`
  - `GET /site/pins` (read); `PUT /site/pins/:slot` (edit); `POST /site/pins/:slot/pinned` `{ version, pinned }` (edit); `PUT|GET /site/pins/:slot/image`
  - `GET /site/log?area=&limit=50` (read) → `[{ at, actorName, area, text }]` newest first.
  - Raw-body routes are registered with `express.raw({ type: () => true, limit: 2 * 1024 * 1024 })` the same way `media-routes.ts` does for page images.

- [ ] **Step 1: Failing tests.** `carousel.test.ts`:

```ts
// 1. createNextCarousel copies the live slides (new ids) and refuses a second next carousel
// 2. saveCarousel with a stale version → SiteConflictError; nothing changed
// 3. saving the live carousel emits one site.content.changed "slides" event; saving the next carousel emits none
// 4. switchCarousels before go_live_at does nothing; after it (advance the test clock) live→past, next→live, one slides event, log by "System"
// 5. after seven switch-overs exactly five past carousels remain and their slides are deleted with them
// 6. two concurrent switchCarousels calls switch once (Promise.all; one returns switched:false)
// 7. pinned primary + secondary survive a switch-over and appear at -2/-1 in the emitted slides (C21)
// 8. setPinned true without a headline → SiteRuleError; with one → slides event includes the pin
// 9. setSlideImage with HTML bytes → SiteRuleError(["Upload a JPEG or PNG image."]); with a PNG → hasImage true and imageBase64 in the next emitted snapshot
// 10. a past carousel can't be saved
```

`site-routes.test.ts` (supertest + `mintSession` cookies): a site editor can create/save the next carousel (201/200); an `NRMS.Editor`-only user gets 403 on `PUT /site/carousels/:id`; a viewer can `GET /site/carousels` but not write; a 3 MiB image → 413; `GET /site/slides/:id/image` returns `content-type: image/png`; missing `x-gcpe-request` on a write → 403; `GET /site/log` lists the actor's display name.

- [ ] **Steps 2–5:** verify failure → implement (+ stack tick step and NRMS `workers.site` running `switchCarousels`) → run `apps/nrms apps/stack` + tsc + full suite → commit `feat(nrms): carousel, emergency pins and scheduled carousel switch-over`.

---

### Task 3: Live Feed, resource links and general files

**Files:**
- Create: `apps/nrms/src/website/settings.ts` (Live Feed part), `apps/nrms/src/website/links.ts`, `apps/nrms/src/website/files.ts`, tests `settings.test.ts`, `links.test.ts`, `files.test.ts` (in `apps/nrms/src/website/`)
- Modify: `apps/nrms/src/http/site-routes.ts` (+ test), `apps/nrms/src/start.ts` (env `LIVE_WEBCAST_MANIFEST_URL_DEFAULT`, `LIVE_WEBCAST_M3U_URL_DEFAULT`, both optional URLs)

**Interfaces:**
- Live Feed: `getLiveFeed(db, defaults): Promise<{ enabled; manifestUrl; m3uUrl; version }>` — a stored empty URL shows the environment default (Q1); `saveLiveFeed(db, { version, enabled, manifestUrl, m3uUrl }, actor, subs)` — URLs `https://` or empty; enabling with an empty M3U URL → `SiteRuleError(["Add the M3U playlist URL before turning the Live Feed on."])`; emits `home`; log `Turned the Live Feed on` / `off` / `Changed the Live Feed URLs`.
- Links: `getLinks(db): Promise<{ version: number; links: { id; text; url }[] }>`; `saveLinks(db, { version, links: { id?: string; text; url }[] }, actor, subs)` — replaces the whole ordered list (`sort_index` = position), keeps given ids, new ones get fresh ids; checks against `site_settings.links_version` (bump on save) → `SiteConflictError`; emits `links`; log `Saved N resource links`.
- Files: `listFiles(db, { q?: string; page?: number }): Promise<{ total; files: { id; name; url; contentType; size; createdAt; createdBy }[] }>` — `q` is a case-insensitive substring of `name`, newest first, 50 per page; `uploadFile(db, store, { name, bytes, replace }, actor)` — content by `sniff` must be PDF, PNG or JPEG (`SiteRuleError(["Upload a PDF, PNG or JPEG file."])`), empty → `SiteRuleError(["The file is empty."])`; public name = `safeFileName(name)` with its extension forced to match the sniffed type (reuse the helper NRMS release files use for that); storage key = the public name itself (single segment, passes `assertSafeKey`; it can't collide with `releases/…` because it has no `/`); an existing name → `SiteConflictError("A file with that name already exists.")` unless `replace` (then bytes are overwritten, row updated); bytes written before the transaction and removed if it fails (as `media/files.ts` does); URL `/files/<name>`; log `Uploaded <name>` / `Replaced <name>`. `deleteFile(db, store, id, actor)` → log `Deleted <name>`; deletes bytes after commit. Files don't emit events (they're served directly).
- Routes: `GET|PUT /site/live-feed`; `GET|PUT /site/links`; `GET /site/files?q=&page=`; `POST /site/files?name=<name>&replace=true|false` raw body ≤ 25 MiB; `DELETE /site/files/:id`. Writes `NRMS.SiteEditor`.

- [ ] **Step 1: Failing tests:**

```ts
// settings: stored empty URL shows the env default; enabling without an M3U URL → SiteRuleError; saving emits "home" with URLs when on and nulls when off; stale version → SiteConflictError
// links: save three links, reorder, save again → ids kept, sort_index 0..2, one resourceLinks event per save; a "javascript:" url → SiteRuleError; stale links_version → SiteConflictError
// files: upload "Budget 2026.pdf" → name "budget-2026.pdf", url "/files/budget-2026.pdf", bytes readable from the store; same name again → SiteConflictError; replace=true overwrites; "../x.pdf" → name "x.pdf" (no "/" or ".."); a PNG uploaded as "report.pdf" → name "report.png"; HTML bytes → SiteRuleError; search "budg" finds it; delete removes row and bytes
```

Route tests: a site editor uploads a PDF → 201 and `GET https://<app>/files/budget-2026.pdf` via the stack test harness (or the store) returns it; viewer upload → 403; 26 MiB → 413.

- [ ] **Steps 2–5:** verify failure → implement → run `apps/nrms` + tsc + full suite → commit `feat(nrms): Live Feed, resource links and general files`.

---

### Task 4: Project Blue Bridge, admin emails, and the public site's banner and noindex

**Files:**
- Modify: `packages/auth/src/roles.ts` (add service-only role constant `CORE_ADMIN_DIRECTORY_ROLE = "Core.AdminDirectory"`, not in `STAFF_ROLES`), `apps/core/src/http/routes.ts` + `users.ts` + `services/users.ts` (+ tests): `GET /api/directory/admin-emails` → `{ emails: string[] }` (active users holding `Core.Admin`), allowed for `Core.Admin` or `Core.AdminDirectory`.
- Modify: `apps/nrms/src/clients.ts` (`coreClient({ baseUrl, getToken, fetchImpl? }): { adminEmails(): Promise<string[]> }`, 10 s timeout, errors never include the token), `apps/nrms/src/start.ts` (`CORE_URL`, `CORE_TOKEN_URL`, `CORE_CLIENT_ID`, `CORE_CLIENT_SECRET`, `CORE_SCOPE` all-or-none like `NOD_*`; service token with `roles: ["Core.AdminDirectory"]`), `apps/stack/src/env.ts` (`STACK_APP_DEFAULTS.NRMS.CORE_URL = "self:/core"`)
- Modify: `apps/nrms/src/website/settings.ts` (+ test), `apps/nrms/src/http/site-routes.ts` (+ test)
- Create: `apps/public-site/src/site-env.ts` (+ test)
- Modify: `apps/public-site/src/news-api-client.ts` (`home(): Promise<{ granville: string | null }>` from `GET api/Home`), `render.ts`, `rebuild.ts`, `self-heal.ts` (+ tests)

**Interfaces:**
- `getBlueBridge(db): Promise<{ on: boolean; version: number; updatedAt: string | null }>`
- `setBlueBridge(db, { version, on, confirmation, acknowledgeIgrs }, actor, deps: { subscribers; notify: (subject: string, text: string) => Promise<void> })`:
  - `confirmation.trim() !== "KING CHARLES III"` → `SiteRuleError(["Type KING CHARLES III to confirm."])`; `acknowledgeIgrs !== true` → `SiteRuleError(["Confirm that IGRS has approved this change."])`. Both apply to switching on **and** off.
  - stores `granville = on ? "true" : null`, bumps version, emits `home`, logs `Turned Project Blue Bridge ON` / `OFF` (area `blue-bridge`), all in one transaction.
  - After commit, `notify(subject, text)` — subject `Project Blue Bridge turned ON on <site URL>` (or `OFF`), text naming the actor's display name and the BC time. A notify failure is logged (`console.error` without addresses) and does not undo the change.
- NRMS wiring for `notify`: `adminEmails()` from Core, then `distribution.send({ priority: "system", subject, text, html: <pre>escaped</pre>, recipients })`; no Core or Distribution client → log only.
- Route: `GET /site/blue-bridge` (read incl. `Core.Admin`); `PUT /site/blue-bridge` `{ version, on, confirmation, acknowledgeIgrs }` — `requireRole("Core.Admin")`. The response includes `warning: "Do not click OK unless you have approval from IGRS"` on GET so the staff app can show it.
- Public site:
  - `site-env.ts`: `isTestSite(env: NodeJS.ProcessEnv): boolean` per the Global Constraints rule; `blueBridgeBanner(granville: string | null, now: Date, test: boolean): string | null` — `null` when `granville` is null/empty; age computed in `America/Vancouver`.
  - `render.ts`: `page()` gains `{ test: boolean; banner: string | null }`; when `test`, adds `<meta name="robots" content="noindex, nofollow">` to every page; when `banner`, renders `<div class="blue-bridge-banner" role="alert">…</div>` (HTML-escaped) at the top of `<body>` on every page kind.
  - `rebuild.ts` / `self-heal.ts`: fetch `home()` once per rebuild run (a failure → render with no banner and log it — never fail the rebuild); pass `isTestSite(process.env)`.

- [ ] **Step 1: Failing tests:**

```ts
// core: GET /api/directory/admin-emails as Core.Admin → active admins only; with a Core.AdminDirectory service token → same; as NRMS.Editor → 403
// nrms settings: wrong phrase / lower-case phrase / missing acknowledgeIgrs → SiteRuleError and no outbox row; correct → granville "true", one home event with granville "true", log by actor, notify called once with "ON"; turning off → granville null in the event; notify throwing doesn't undo
// routes: NRMS.SiteEditor PUT /site/blue-bridge → 403; Core.Admin with phrase → 200
// clients: coreClient.adminEmails against a stub server; a 500 → error message has the status, not the token
// public-site: isTestSite({NODE_ENV:"production"}) false; with LOCAL_ADMIN_ALLOW_IN_PRODUCTION "true" → true; {NODE_ENV:"development"} → true; SITE_ENVIRONMENT "test" → true
// banner: granville null → null; "true" on 2026-10-04 → "ALERT: His Majesty King Charles III, King of Canada, has passed away at the age of 77"; on 2026-11-14 → 78; test → starts "TEST — ALERT:"
// render: test site home and post pages contain the noindex meta; production pages don't; banner present on both page kinds when set, absent when null
```

- [ ] **Steps 2–5:** verify failure → implement → run `apps/core apps/nrms apps/public-site apps/stack packages/auth` + tsc + full suite → commit `feat: Project Blue Bridge with admin confirmation and emails; public-site TEST banner and noindex off production`.

---

### Task 5: Top and Feature slots

**Files:**
- Create: `apps/nrms/src/website/features.ts`, `apps/nrms/src/website/features.test.ts`
- Modify: `packages/nrms-contract/src/types.ts` (`ReleaseView.features: { kind: FeatureKind; key: string; slot: "top" | "feature" }[]`; testing `view()` default `features: []`), `apps/nrms/src/releases/store.ts` (`loadView` fills `features`), `apps/nrms/src/publisher.ts` (clear on unpublish), `apps/nrms/src/releases/service.ts` (clear on delete of a release that holds a slot), `apps/nrms/src/http/routes.ts` (+ test), `apps/nrms/src/http/site-routes.ts` (+ test)

**Interfaces:**
- `type FeatureKind = "home" | "ministries" | "sectors" | "themes"`; home uses key `default`.
- `setFeature(db, releaseId, { kind, key, slot, on }, actor, subs)`:
  - the release must be `published` (live) — else `ReleaseStateError("Only a published release can be Top or Feature.")`; for kind ≠ home, the release must be tagged with that category (`ReleaseRuleError(["This release isn't in that category."])`).
  - `on: true` upserts `category_features` and sets the slot to this release — whatever release held it is moved out (spec §6.5); `on: false` clears the slot only if this release holds it.
  - Emits `home` (kind home) or `{ kind, key }`; writes the release log (`Set as Top for Home`, `Removed as Feature for ministries/health`) **and** the site log (area `features`).
- `clearFeaturesFor(tx, releaseId, subs)` — empties every slot held by the release and emits for each affected slot; called in the publisher's unpublish transaction (where `release.unpublished` is enqueued) and in `deleteRelease` when the release holds a slot.
- `featuredWhere(db): Promise<{ kind; key; label; top: { id; key; headline } | null; feature: { id; key; headline } | null }[]>` — every row of `category_features` with a slot set, home first then by kind/label (labels from `category_terms`/`organizations`).
- Routes: `POST /releases/:id/features` `{ kind, key, slot, on }` (`NRMS.Editor`) → the release view; `GET /site/features` (read) → `featuredWhere`.

- [ ] **Step 1: Failing tests:**

```ts
// 1. setFeature on a draft → ReleaseStateError
// 2. release A Top for Home, then release B Top for Home → slot holds B, A's view.features empty, two home events (latest topPostKey = B's key)
// 3. Feature for ministries/health on a release not tagged health → ReleaseRuleError
// 4. Feature for ministries/health → one categoryFeatures event {kind:"ministries", key:"health", featurePostKey: key}
// 5. unpublishing (through the publisher) a release holding Top for Home and Feature for sectors/x → both slots empty, two site events in the same transaction as release.unpublished
// 6. deleting a release holding a slot clears it
// 7. featuredWhere lists home first with headlines
```

Route test: `NRMS.SiteEditor` → 403 on `POST /releases/:id/features`; `NRMS.Editor` → 200.

- [ ] **Steps 2–5:** verify failure → implement → run `apps/nrms packages/nrms-contract` + tsc + full suite → commit `feat(nrms): Top and Feature slots with takeover, clearing on unpublish, and what's-featured-where`.

---

### Task 6: Docs, parity lists and the boxs.ca website walkthrough

**Files:**
- Create: `scripts/siteground-website-walkthrough.sh`, `tests/siteground-website-walkthrough.test.ts`
- Modify: `docs/deploy/siteground.md`, `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`

**Interfaces:**
- Walkthrough `scripts/siteground-website-walkthrough.sh BASE`: signs in as the break-glass admin (same secrecy rules as `siteground-flickr-walkthrough.sh`: password via getpass → stdin only, private cookie jar deleted on exit, `x-gcpe-request: 1`), then with `curl -f`: creates a next carousel 2 minutes ahead with one slide, pins and saves the primary emergency slide, sets Live Feed on with test URLs, saves two resource links, uploads a small generated PDF as a general file, turns Blue Bridge ON with the phrase and acknowledgement; polls (once per minute, up to 6 polls) `BASE/api/Home` and `BASE/api/Slides` (the News API is mounted at the site root; NRMS→News API events already route `types: ["*"]`, `apps/stack/src/env.ts:176`) until the carousel switched, the pin is at sortIndex −2, the URLs are present and `granville` is set; checks `BASE/site/` contains `TEST — ALERT:` and `noindex`; fetches the file at `BASE/files/<name>`; finally turns Blue Bridge OFF and unpins (cleanup runs even on failure via trap). Prints PASS/FAILED per step and exits non-zero on failure.
- `siteground.md`: a "Website section" subsection — env `NRMS_LIVE_WEBCAST_*_DEFAULT`, the Core client (defaults to `self:/core`, uses a service token with `Core.AdminDirectory`), the test-site rule and `SITE_ENVIRONMENT`, how to run the walkthrough.
- Parity lists:
  - **C39** (new): Legacy — production/test decided by the hosting environment name. New — a site is treated as a test site (TEST banner, noindex) unless it's the real production deployment: `NODE_ENV=production` **and** not `LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true` **and** not `SITE_ENVIRONMENT=test`. Why — boxs.ca runs with `NODE_ENV=production`, and a test site must never look like a real announcement or be indexed. Status Agreed (spec §6.4 intent).
  - **C40** (new): Top/Feature can be set only on a published release, and unpublishing or deleting the release empties its slots. Why — a slot pointing at a missing post breaks the home page. Status Proposed; add **Q18**: "Should a scheduled (not yet live) release be able to take a Top/Feature slot, appearing there when it goes out?" Working assumption: no.
  - **C41** (new): General files are named by their sanitised name with an extension matching their content; a duplicate name needs "replace". Why — stable public URLs (`/files/<name>`) and no silent overwrite. Status Proposed.
  - Confirm C19–C25 wording matches what was built; update Q1's working assumption (env defaults `NRMS_LIVE_WEBCAST_*_DEFAULT`) and Q15 (built as assumed).

**Tests:** `bash -n` on the script; a static test (like `tests/siteground-flickr-walkthrough.test.ts`) that the admin password never appears in a command's arguments and every control call uses `curl -f` or checks its status.

- [ ] **Steps:** write → `bash -n` + static test + full suite + tsc → commit `docs: website section deploy notes, parity rows C39–C41/Q18, and the boxs.ca website walkthrough`.
