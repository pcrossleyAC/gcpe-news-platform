# Phase 4i: Emergency Feed, Retention Purge and Legacy NoD Importer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** NoD reads the EMCR emergency alerts feed every 5 minutes and emails new alerts to the Emergency Info BC list; a nightly retention purge (built, off by default) deletes unconfirmed and long-ended subscribers, with its switch and preview on Operations; and `npm run nod:import` loads legacy NoD's subscribers, lists and recent sends into the new model with a reconciled report.

**Architecture:**
- **Emergency feed (NoD, `apps/nod/src/emergency/`):**
  - `feed.ts` parses RSS 2.0 or Atom into alerts, with the full content as plain text.
  - `ingest.ts` is a tick worker gated to every 5 minutes through `nod_settings`. It fetches `EMERGENCY_FEED_URL` (time and size capped), dedupes by feed id and by link, and records new alerts through the existing `recordEmergencyItem`. That function already sends emergency items to everyone on `emergency:alerts`, whatever their timing.
  - A new `packages/emergency-feed-fake` serves a test RSS feed. The stack mounts it on test sites and in e2e.
- **Retention purge (NoD, `apps/nod/src/purge.ts`):**
  - `purgeSelection()` is the one definition of what goes. Both `previewPurge()` (the count Operations shows) and `purgeBatch()` (the deletes) are built on it.
  - Deletes run in bounded batches: links set-based, 5,000 at a time; subscribers one transaction each, under `withLockedSubscriber`, with eligibility re-checked under the lock.
  - `runPurgeIfDue()` runs nightly at 03:00 BC behind a lease. It continues across ticks until the night's work is done.
  - `opt-outs.ts` keeps media-list opt-outs as address-free hashes when a subscriber is purged. `addMediaMember` checks them.
- **Legacy importer (NoD, `apps/nod/src/import/`):** shaped like `apps/nrms/src/import/`.
  - Read-only queries against legacy `Gcpe.NewsOnDemand` go through `@gcpe/legacy-import`.
  - `map.ts` holds the pure mapping. The stage writers handle lists, subscribers, articles and settings.
  - The run holds a whole-run advisory lock and writes a JSON + text report. The CLI is `npm run nod:import`.
  - Re-runs are safe: a per-subscriber fingerprint table tells "untouched since import" (legacy wins) from "changed in NoD" (NoD wins).
- **staff-web:** Operations gains a "Retention purge" section (switch, preview, last run) and a read-only "Emergency alerts feed" section.

**Tech Stack:** Node 24, TypeScript 5.9 strict, Express 5, Drizzle 0.45 / drizzle-kit 0.31, zod 3.25, htmlparser2 10 (already used by NRMS), mssql via `@gcpe/legacy-import`, Vitest 4.1, supertest, React 19, `@bcgov/design-system-react-components`, axe-core, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-nod-distribution-parity-design.md`:
- §9 (all three parts);
- §5.1 "Emergency" (to everyone on the list, whatever their timing);
- §3 (`subscribers.ended_at` drives the purge; `nod_settings` holds the purge switch);
- §8 "Operations" (purge on/off and next-run preview count);
- §10 acceptance items 5, 12 and 13.

Executors read the spec alongside this plan.

**Also read:**
- `docs/superpowers/plans/2026-10-07-phase-4g-lists-media-operations.md`, Ruling R2: the purge switch and preview were deferred to here, and one selection function must feed both.
- `docs/superpowers/plans/phase-4-carry-forward.md`, section "4i".
- `docs/deploy/siteground.md`, "Importing legacy NRMS data" and "Migrations on populated deliveries or messages tables".

**Base:**
- **Branch:** `feat/phase-4i`, cut from `main` at `84bb836`. **A flaky-test fix from another branch is merged in first.** Rebase onto it before Task 1.
- **Worktree:** `/Users/paul/gcpe-news-platform-4i`.
- **Line numbers:** file:line references are against `84bb836`. Re-find everything by symbol after the merge.
- **Migrations:** at planning, NoD's last migration is `0025_bounce_soft_codes`, so the next free number is `0026`. Re-check `apps/nod/migrations/meta/_journal.json` before each `generate`.

**What legacy did** (read 2026-10-07):
- **`EmergencyInfo.exe`** (`~/HUB/Subscribe/Gcpe.NewsOnDemand.EmergencyInfo/Program.cs`):
  - It downloads `EmergencyInfoFeed` with a `WebClient` and loads it with .NET `SyndicationFeed` (RSS or Atom).
  - For each item it calls the NoD service's `AddNewsOnDemandEntry` with:
    - lists `["emergency/alerts"]`;
    - `Title`;
    - `Uri` = the `alternate` link;
    - `Id` = the item id (RSS `guid`);
    - `Published` = the pubDate;
    - `HtmlContent` = `content:encoded`, else the summary. The comment says alerts "must include all of the content".
  - Errors are logged to a text file. The TODO "detect if data has changed" was never done. Its schedule lived outside the source (Windows Task Scheduler).
- **Feed URL** (`App.config`): production `http://www.emergencyinfobc.gov.bc.ca/category/alerts/feed/?hide_expired=true`; dev/test/uat `http://test.vanity.blog.gov.bc.ca/embc/category/alerts/feed/?hide_expired=true`. This is a WordPress category feed.
- **`DistributionProvider.AddNewsOnDemandEntry`** (`Gcpe.NewsOnDemand.Library/Legacy/DistributionProvider.cs:162-330`):
  - It dedupes by `ArticleSourceID` (= the feed's `guid`, unique index `UX_Article_SourceID`). A known id only updates the content when it changed. It never re-sends.
  - Recipients are subscribers on the list. A non-news site (Emergency Info BC) goes to them "regardless of as-it-happens/daily-digest preferences" (`:286-310`).
- **Legacy today** (survey `docs/parity/legacy-survey/results/NewsOnDemand/06-NoD_Queries.xlsx`, sheet 1.5): the `emergency` category and its `alerts` list are **deleted**, with 0 active subscribers. Paul and Anne confirmed the EMCR category and feed stay in scope. EMBC-specific news and Reply-To are out of scope.
- **Purge:** legacy's purge never ran (spec §9).
  - Sheet 1.13: 16,825 disabled records are older than 10 days. No ended-90-days figure could be computed from SysLog.
  - Sheet 1.11: 7.9 M expired, never-used `SubscriberLink` rows are kept.
- **Legacy schema** (`~/HUB/Subscribe/Gcpe.NewsOnDemand.Database/dbo/Tables/*.sql`):
  - `Subscriber(SubscriberGuid, RegisteredDateTime DATETIME, EmailAddress varchar(150) not unique, IsSelfSubscription, IsEnabled, IsChanged, IsDeleted, ImmediateDelivery, DigestDelivery, NotifyIfNewCategories)`.
  - `SubscriberList(ListGuid, SubscriberGuid)`.
  - `List(ListGuid, SiteGuid, ListName, CategoryGuid, SlotNumber, IsDeleted, Key, TopicUrl, …)`.
  - `ListCategory(CategoryGuid, CategoryName, IsEnabled, IsDeleted, Key, …)`.
  - `Article(ArticleGuid, RelativeUri, ArticleSourceID unique, IsDeleted, IsImmediateDelivered, IsDigestDelivered, PublishDateTimeUtc DATETIMEOFFSET)`.
  - `ArticleContent(…, TitleText, HtmlContent, UpdateDateTimeUtc)`.
  - `ArticleList(ArticleGuid, ListGuid)`.
  - `SubscriberArticle(SubscriberGuid, ArticleGuid, ImmediateAttempted, ImmediateDelivered, DigestAttempted, DigestDelivered, HardBounced)`. There are **no timestamps**.
  - `SubscriberLink(LinkGuid, SubscriberGuid null, ExpiryDate, SubscriberInfo text, SubscribeDate)`.
  - `SysLog(Action varchar = the enum number as text, EntityType, EntityGuid, EntityData, EventGuid, EventData, EventUser, EventDate DATETIME local)`. **`EntityData` holds the subscriber's address** (`NewsOnDemandEventLogging.cs:186`). No query here may select it.
  - `SysConfig.DailyDigestEndDateTimeUtc`.
- **Legacy SysLog actions** (`NewsOnDemandEventLogging.cs:29-51`): `8` DeleteSubscriber, `104` Unsubscribe, `106` UnsubscribedFromList (EventGuid = the list), `108` PermanentlyDeleteSubscriber.
- **Article ids:** a release's `ArticleSourceID` is Hub's `GetAtomId()`, which is `AtomId`, or `"uuid:" + NewsRelease.Id` lowercased (`HubEntitiesExtensions.cs:81-84`). NRMS keeps both as `news_releases.atom_id` and `legacy_id` (3e importer).

**Volumes** (survey, 2026-10-06; Q21):

| Legacy table | Rows | Notes |
|---|---|---|
| `Subscriber` | 47,505 | 30,674 enabled and not deleted; **7,719 of those have neither timing flag**; 11,404 deleted; 5,428 disabled; 7 both enabled and deleted |
| `SubscriberList` | 305,332 | |
| `List` / `ListCategory` | 693 / 27 | Categories: `all-news`, `ministries`, `sectors`, `tags`, `media-distribution-lists` (129 lists), plus `services` (not deleted, 10,817 subscriptions), `regions`, `newsletters`, `emergency` (all three deleted). **No `themes`.** |
| `Article` | 28,272 | about 1,430 a year; up to 12,572 recipients each |
| `SubscriberArticle` | **93.7 M** (17 GB) | Not importable whole (R18) |
| `SubscriberLink` | 16.1 M | Not imported |
| `SysLog` | 71.9 M | Read only through two `GROUP BY` queries (R16, R17) |

**What the code does today** (`84bb836`):
- **Emergency items already exist** (4b):
  - `createItemSending().recordEmergencyItem` (`apps/nod/src/as-it-happens.ts:118-148`) inserts an `items` row keyed `emergency:<sha256(guid)[0..32]>` on list `emergency:alerts`, idempotent on the key. When new, it creates an `emergency` send job for every active subscriber on that list, whatever their timing.
  - `POST /nod/api/emergency-items` (`http/routes.ts:106-114`, NoD.Admin) calls it.
  - `renderEmergency` (`render.ts:191`) gives the subject `Emergency Info BC - <title>`, with the summary as one paragraph.
  - `replyToFor` gives emergency items no Reply-To (4e.1).
- **No purge code exists.**
  - `nod_settings` has no purge switch.
  - `subscribers.ended_at` is set only when status becomes `deleted` (`journeys.ts:258`, `staff-subscribers/actions.ts:114`, `media-members.ts:225`). A bounce disable sets `disabled` with no `ended_at` (`bounces.ts:195`).
  - Every child table cascades on a subscriber delete. **But `job_recipients` (PK `(job_id, subscriber_id)`) and `subscriber_links` have no index leading with `subscriber_id`.** Each cascaded delete would scan them.
  - Send-origin links are minted per recipient per send. That is about 23,000 a day at Q21 volume, and nothing ever deletes them.
- **Media opt-out evidence** lives only in `subscriber_history` (`media-list-opted-out`, detail = list key). `addMediaMember` reads it through `optedOutOf` (`media-members.ts:93-107`) for an **existing** row only.
- **NRMS importer pattern** (`apps/nrms/src/import/`): `cli.ts` parses env; `run.ts` holds `withImportLock` (session `pg_try_advisory_lock(0x67637065, 2)`), the stages, `ImportStageError` and `runImportCli` (exit 0/2/1). `report.ts` balances `legacy = imported + skipped` per table. Tests use `createFakeSource` keyed by each query's `-- name:` line.

---

## Rulings

Decided for this plan. Task 9 writes the parity rows for each.

### Scope

- **R1. One plan, nine tasks; no split.**
  - Nine tasks is inside the 7–9 budget.
  - The importer (Tasks 6–8) touches nothing in Tasks 1–5 except shared schema files. It could be cut off as a 4j without changes if review time runs short.
  - The three parts share Task 9's docs and the e2e pass.
- **R2. EMBC branding and Reply-To are out of scope (Paul).**
  - Emergency emails keep the BC Gov News shell and carry no Reply-To, which 4e.1 already does.
  - The carry-forward item about the Emergency Info BC banner and per-site reply-to is closed by this ruling.

### Emergency feed

- **R3. Feed format.**
  - RSS 2.0 (`channel/item`) and Atom (`feed/entry`), parsed with htmlparser2 in XML mode. No DTDs or external entities are resolved.
  - A body that doesn't end in `</rss>` or `</feed>` is treated as truncated and rejected whole. A half-read alert must never be emailed.
  - Identity is the RSS `guid` or Atom `id`, falling back to the link.
  - The link must be http(s). The title is required and capped at 500 characters, `emergencyItemSchema`'s own limit.
- **R4. Content.** `content:encoded` (else `description`; Atom `content`, else `summary`) becomes plain text in Node:
  - paragraphs are separated by a blank line;
  - list items become "- " lines;
  - a link keeps its URL as "text (url)";
  - script and style are dropped;
  - the text is capped at 20,000 characters.
  - It is stored as `items.summary`. The emergency email shows every paragraph (legacy: "must include all of the content"). Release emails are byte-for-byte unchanged.
- **R5. Schedule and fetch.**
  - Every 5 minutes from the tick, gated by one atomic `UPDATE` on `nod_settings.emergency_feed_checked_at`, the same shape as Distribution's 15-minute bounce gate.
  - Fetch timeout 15 s, body cap 2 MB, UTF-8.
  - A failed check records its error label and sends nothing. The next check is 5 minutes later.
  - No conditional GET: the feed is small, and YAGNI.
- **R6. Dedupe and changes.**
  - An alert is known if an emergency item has its key (from its identity) **or its link**. The link check stops a WordPress guid change from re-sending.
  - A known alert whose title or text changed is updated in place and **never re-sent** (legacy parity).
- **R7. First read of a feed URL sends nothing.**
  - When `nod_settings.emergency_feed_seeded_url` differs from the configured URL (first deploy, a URL change, boxs.ca's first tick), that check records every alert in the feed without sending.
  - After one successful seeding check, new alerts send.
  - Why: pointing NoD at a live feed must never email every current alert at once. Legacy's list has 0 subscribers today, so cutover loses nothing.
- **R8. Configuration.**
  - `EMERGENCY_FEED_URL` (stack: `NOD_EMERGENCY_FEED_URL`). Unset → the worker is a no-op, startup logs one warning, and Operations says "not configured".
  - Test sites and e2e get the stack's fake feed, exactly like the fake Media Hub (`usesFakeEmergencyFeed`). Production with no URL reads nothing; it is never pointed at the fake.
  - Production's real URL is Q43.

### Retention purge

- **R9. What the purge removes** (spec §9; one definition, `purgeSelection`). Durations are rolling, by the database clock, strictly older than the limit:
  - **Unconfirmed subscribers:** `status = 'pending'` and `created_at` more than 10 days ago.
  - **Ended subscribers:** `status = 'deleted'` and `ended_at` more than 90 days ago. They go with their deliveries, history, subscriptions, links and job recipients, all by FK cascade.
  - **Unused links:** `origin = 'request'`, `used_at IS NULL OR subscriber_id IS NULL`, created more than 10 days ago. Unconfirmed signups live here (spec §3), so this is Q25's "unverified signups". So do a signup's other verify links, which confirming one marks used without binding to the subscriber; without the `subscriber_id IS NULL` arm they would keep the address after the subscriber is purged.
  - **Expired send links:** `origin = 'send'`, expired more than 10 days ago.
- **R10. Link housekeeping runs whether the purge is on or off.**
  - Only expired send links are cleared. These are the manage links stamped into every sent email, unusable after 24 hours. They are not signups and not consent records, and they grow by about 23,000 a day.
  - Everything else waits for the switch (Q25).
  - Used verify links (the double opt-in record) stay as long as their subscriber does.
- **R11. Not purged:**
  - `disabled` subscribers (bounce or staff), which staff can reactivate;
  - `deleted` with no `ended_at`;
  - `active` subscribers with no lists.
  - Q25 is extended to ask whether disabled subscribers need a window.
- **R12. Batching and locking.**
  - Links go set-based, in deletes of at most 5,000.
  - Subscribers are selected 100 ids at a time. Each is deleted in **its own transaction** through `withLockedSubscriber`, which re-checks the same condition under the address lock. Someone who re-subscribed or was re-added to a media list after selection is kept.
  - One call stops after 20 s or 500 subscribers and reports itself unfinished. The night's run continues on the next tick, behind a 5-minute lease (`purge_lease*`), and counts add up in `purge_result`.
  - The night is done (`purge_done_cutoff` = that 03:00) only when a call finishes.
- **R13. Schedule.**
  - Nightly at 03:00 BC (`dailyCutoff(…, 3)`). That is after the 02:00 Media Hub sync, and clear of the 08:00 summary and 17:00 digest.
  - A missed night catches up on the next tick, like the digest. The very first tick after deploy runs housekeeping.
- **R14. Media-list opt-outs survive the purge without the address.**
  - Before a purged subscriber's row goes, every opt-out the live history check (`optedOutOf`, opt-outs.ts) would enforce is written to `media_opt_outs(email_hash, list_key, opted_out_at)`. `email_hash` is SHA-256 of `"gcpe-nod-media-opt-out:" + lowercased address`. That is:
    - one row per media list they left: a `media-list-opted-out`, or an `unsubscribed` after their last add to that list with no staff removal in between;
    - for an ended (`deleted`) record whose `unsubscribed` is newer than its last add to any media list, one row with `list_key = '*'`, meaning every media list.
  - `addMediaMember` checks it on **every** add, whether or not the address has a new record by then (public subscribe, another list). A match on that list or on `'*'` needs the same `confirmOptOut` the history-based check asks for. Once staff confirm, that record's own `media-list-added` supersedes the kept row, as for a live opt-out.
  - It is unkeyed on purpose. Rotating `LINK_SECRET` (a legitimate response to token compromise) must never forget an opt-out.
  - Public unsubscribes need no record: re-subscribing goes through double opt-in.
  - Q44 asks Paul to confirm keeping these indefinitely.
- **R15. Operations.**
  - `GET /operations` adds `purge` (enabled, preview counts, last run, next 03:00) and `emergencyFeed` (URL, last check, its result).
  - `PUT /operations/purge {enabled}` is NoD.Admin only. Each change writes `operations_log` (`purge-enabled` with the preview counts at that moment, or `purge-disabled`). A finished night that removed anything writes `purge-ran` with its counts. No address is ever written.
  - The preview reads "if it ran now". The next run's own counts can differ by whatever ages past a limit before 03:00.

### Importer

- **R16. Subscribers.**
  - **Ids:** legacy `SubscriberGuid` becomes `subscribers.id`.
  - **Address:** trimmed and lowercased, then validated with `emailAddressSchema`. An invalid one is skipped.
  - **Status:** `IsDeleted` → `deleted`; else `IsEnabled` → `active`; else `disabled`. Legacy has no pending rows: unconfirmed signups live only in `SubscriberLink` JSON and aren't imported. The report gives their count, so staff know they must sign up again.
  - **Timing** is copied as is (`ImmediateDelivery`/`DigestDelivery`). That includes the 7,719 active subscribers with neither flag, who receive nothing in legacy or here (Q45).
  - **Source:** `IsSelfSubscription` → `self`; else on any media list → `manual-media` (spec: until matched to Media Hub, which is a later step; Q26 is Media Hub's API); else `admin`.
  - **Dates:** `created_at` = `RegisteredDateTime` (BC wall clock → instant via `wallClockToInstant`). `verified_at` = `created_at`.
  - **`ended_at`** (deleted only) = the latest SysLog `104`/`8` date for that subscriber, else the import time. The import-time fallback keeps them for 90 days after cutover rather than purging them on night one.
- **R17. Lists and memberships.**
  - Legacy `<category>:<key>` maps to NoD's existing `lists` row, case-insensitively. `all-news` maps to `*`.
  - A media list matches by key, then by exact name (legacy keys were hand-matched to Hub's).
  - **Not carried:**
    - deleted lists or categories;
    - `services` (Featured Programs and Services, never part of this platform);
    - `regions`, `newsletters`;
    - any list with no NoD match.
    Each is reported by reason.
  - A deleted subscriber's memberships aren't imported (as after any unsubscribe here).
  - Every SysLog `106` UnsubscribedFromList on a media list, for a subscriber not on that list now, becomes `media-list-opted-out` history (actor "Legacy import", at = that date). Staff are then asked before re-adding them. That is conservative: legacy can't tell an opt-out from a staff removal.
  - The importer refuses to start while NoD has no ministry lists (Core's reference data hasn't reached NoD yet).
- **R18. Sends.**
  - Only articles published in the last `--since-days` (default 30, at most 92) are imported, with their `SubscriberArticle` rows. 93.7 M rows aren't importable, and 30 days covers the 15-day bounce window and a month of the 4h reports.
  - **Article → item:**
    - a release resolves to its NRMS key through `atom_id`/`legacy_id` (NRMS's database, read-only), so a post-cutover republish can't re-send it;
    - an article on the emergency category → `emergencyItemKey(ArticleSourceID)`, the ingester's own key;
    - newsletters, programs and unresolved articles are skipped by reason.
  - **Deliveries:**
    - emergency → `as_it_happens`;
    - on a media list the subscriber is on → `media`;
    - otherwise `ImmediateAttempted` and the subscriber's `ImmediateDelivery` → `as_it_happens`, and `DigestAttempted` and `DigestDelivery` → `digest`.
    - The subscriber's own flag is checked because legacy marks "prevented" modes as attempted (`DistributionProvider.cs:313-320`).
  - **Delivery columns:** `attempted_at` = publish time. `distribution_batch_id` = the fixed `LEGACY_BATCH_ID`, so reports count them as handed off and no bounce event can ever match them. `HardBounced` → `hard_bounced_at` = publish time and `bounce_status = 'legacy'`.
  - `items` and `deliveries` use `ON CONFLICT DO NOTHING`.
- **R19. Digest continuity.** `nod_settings.last_digest_cutoff` = `GREATEST(current, SysConfig.DailyDigestEndDateTimeUtc)`. NoD's first digest then starts where legacy's last one ended, and never re-sends a day.
- **R20. Re-running is safe; NoD wins where staff touched a record.**
  - `legacy_subscriber_imports(subscriber_id, fingerprint, imported_at)` stores a SHA-256 of what was written: address, status, timing, source and sorted list keys.
  - On a re-run, for each legacy subscriber:
    - **no NoD row:** insert;
    - **the address belongs to a different NoD row:** skip, "address already in NoD";
    - **NoD's current state no longer matches the stored fingerprint** (someone changed it here): skip, "changed in NoD since the last import";
    - **the new legacy fingerprint equals the stored one:** unchanged;
    - **otherwise:** update from legacy and store the new fingerprint.
  - **Duplicate legacy addresses** (the column isn't unique): one record is kept, ranked active > disabled > deleted, then newest registration. Others are skipped by reason.
  - Items, deliveries and opt-out history rows insert-if-absent. The digest cutoff only moves forward.
  - A whole-run advisory lock (`0x67637065, 3`) stops two runs at once.
  - Each batch of 500 locks its addresses through `lockAddress` (sorted), the same keyspace as the live journeys, so the import can run while NoD is live.
- **R21. The report never holds an address.**
  - Skipped rows are grouped by table and reason, each with a count and up to 10 sample GUIDs. `skip()` withholds any id that isn't a GUID (or `guid/guid`).
  - The report balances `legacy = imported + skipped` per table and exits like `nrms:import`: 0 balanced, 2 not, 1 on error or lock contention.

---

## Global Constraints

- **Worktree and commits:**
  - Work in `/Users/paul/gcpe-news-platform-4i`, branch `feat/phase-4i`. Commit locally after each task.
  - **Never add `Co-Authored-By` or any AI attribution** (project rule). Never commit `CLAUDE.md`.
  - **Code comments never carry task, round or ruling labels** ("Task 3", "R12", "fix round 1"). Say *why*, not *when*.
- **Node 24 for everything:**
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `… -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e`.
  - Show each new test failing before implementing it (a real RED run).
  - Node 24's tzdata is 2026b or later. The purge tests run across BC's permanent UTC−7 from 2026-11-01 (03:00 BC = 10:00Z on both sides of that date).
- **Migrations:**
  - drizzle-kit only: `cd apps/nod && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`.
  - Never hand-edit generated DDL. Additive only, and safe on boxs.ca's data.
  - **Index-only migrations stay index-only** (Task 3 generates its indexes separately), so `docs/deploy/siteground.md`'s CONCURRENTLY runbook applies to them.
- **Clocks and time:**
  - Time comparisons in SQL use the database clock (`sqlNow(clock)` from `@gcpe/db-kit`), never a JS `Date` against a DB column. Tests pass a `TestClock`.
  - **BC day boundaries are computed in Node** (`dailyCutoff`/`todaysCutoff` in `digest.ts`, `wallClockToInstant`). SQL never uses `AT TIME ZONE` or `date_trunc` on a zone. Rolling durations (10 or 90 days) are `sqlInterval` arithmetic, not day boundaries.
  - Legacy `DATETIME` values (`RegisteredDateTime`, `SysLog.EventDate`) are BC wall clock. Convert them with `wallClockToInstant(value, timeZone)`. `DATETIMEOFFSET` values (`PublishDateTimeUtc`) are already instants.
- **Privacy:**
  - **No email address in any log, URL, `operations_log.detail`, error message or import report.** Log errors with `safeErrorLabel` only. Report ids are legacy GUIDs.
  - No legacy query selects `SysLog.EntityData` or `EventData`, which hold addresses.
  - **Legacy documents and survey files contain real people's addresses. Never copy one** into code, tests, fixtures, docs or commits. Use `example.test`.
- **Bundles:** the importer (`apps/nod/src/import/*`) is reached only from its CLI. Nothing under `apps/nod/src/start.ts`'s import graph may import it, so `mssql` never enters the server bundle.
- **Roles:** Operations reads and writes need NoD.Admin (`NOD_ADMIN_ROLES`). The fake feed's `/__fake` controls need Core.Admin, like the fake Media Hub's.
- **Staff-web patterns (unchanged from 4f–4h):**
  - Calls go through `apiFetch`. A load failure shows a danger `InlineAlert`.
  - Every load is guarded against out-of-order responses (`latest` ref).
  - Each screen calls `useDocumentTitle`. Title assertions use `await waitFor(() => expect(document.title).toBe(...))`.
  - Status messages are found with `getByRole("status")` (use `.filter` when there are several).
  - Errors from a dialog action show **inside** the dialog.
  - Each changed screen keeps an axe test (wcag2a/wcag2aa, serious/critical).
- **Indexes on big tables:** `job_recipients` and `subscriber_links` grow by tens of thousands of rows a day. Task 3's index migration is index-only, and Task 9 adds it to the runbook's CONCURRENTLY list.

## Review Focus

1. **A subscriber comes back while the purge is deleting.** Someone re-subscribes, or staff re-add them to a media list, after the batch selected them but before their delete. They must be kept, with their history. Pinned in Task 3 ("someone who comes back after selection is kept"): it holds the address lock, reactivates, and the purge's re-check under the lock declines.
2. **A truncated or HTML feed body with status 200.** Nothing is recorded or sent, and Operations shows `not-a-feed`. The next check retries. A half-downloaded alert must never be emailed. Pinned in Task 1 (truncated body, HTML error page) and Task 2 ("a 200 HTML page records nothing and reports not-a-feed").
3. **The same alert with a new guid, or edited text.** WordPress can change a guid or edit an alert in place. Subscribers get no second email; the stored text updates. Pinned in Task 2 ("a new guid on a known link sends nothing", "an edited alert is updated, not re-sent").
4. **Turning the purge on over a big backlog.** About 11,000 ended legacy subscribers after import must go in bounded per-subscriber transactions across ticks, never one giant transaction. The total removed equals the preview taken before. Pinned in Task 3 ("a backlog runs in bounded calls…" and "an unfinished night continues…").
5. **Re-running the importer after staff edited an imported subscriber.** The staff edit is kept and reported. Untouched records pick up legacy changes, and nothing is duplicated (history, deliveries, opt-outs). Pinned in Task 7 ("re-run: …") and Task 8 ("a second full run changes nothing").

---

## File structure

| File | Responsibility |
|---|---|
| `apps/nod/src/emergency/feed.ts` | `parseEmergencyFeed`, `htmlToText`, `FeedFormatError` |
| `apps/nod/src/emergency/ingest.ts` | `fetchFeed`, `runEmergencyFeedIfDue`, `getEmergencyFeedStatus` |
| `apps/nod/src/loop.ts` | `startLoop`: a one-at-a-time interval loop for the two new workers |
| `apps/nod/src/as-it-happens.ts` | `emergencyItemKey`; `recordEmergencyItem(…, { send })` |
| `apps/nod/src/render.ts` | Emergency emails show every paragraph |
| `apps/nod/src/purge.ts` | `purgeSelection`, `previewPurge`, `purgeBatch`, `runPurgeIfDue`, `setPurgeEnabled`, `getPurgeStatus` |
| `apps/nod/src/opt-outs.ts` | `optOutHash`, `keepMediaOptOuts`, `suppressedOptOutAt` |
| `apps/nod/src/media-members.ts` | `addMediaMember` checks kept opt-outs on create |
| `apps/nod/src/operations.ts`, `http/operations-routes.ts`, `http/routes.ts`, `app.ts`, `start.ts` | Status, the purge route, wiring, workers |
| `apps/nod/src/settings.ts` | `OperationsAction` gains `purge-enabled`, `purge-disabled`, `purge-ran` |
| `apps/nod/src/subscribe/history.ts` | `HISTORY_ACTIONS` gains `legacy-imported` |
| `apps/nod/src/db/schema.ts` + migrations `0026`–`0029` | Feed state; purge state and `media_opt_outs`; purge indexes; `legacy_subscriber_imports` |
| `apps/nod/src/import/{queries,map,report,lists,subscribers,articles,run,cli}.ts` | The legacy importer |
| `apps/nod/test/legacy-nod-fixture.ts` | The synthetic legacy database (shaped by the `.sqlproj`) |
| `packages/emergency-feed-fake/*` | The fake RSS feed and its `/__fake` controls |
| `apps/stack/src/{env,stack}.ts` | Fake feed mount, env view, tick steps |
| `apps/staff-web/src/screens/subscribers/{OperationsScreen,types,labels}.ts(x)` | Purge and feed sections; the new history label |
| `tests/e2e/emergency-purge.spec.ts` | Alert end to end; purge preview vs purge |
| `docs/*`, `README.md`, `package.json` | Parity lists, running notes, runbook, env, `nod:import` |

---
### Task 1: Feed parser and the fake emergency feed

Covers spec §9's "fake feed is used on boxs.ca and in tests", and R3–R4.

**Files:**
- Create:
  - `packages/emergency-feed-fake/package.json`;
  - `packages/emergency-feed-fake/src/index.ts`, `packages/emergency-feed-fake/src/index.test.ts`;
  - `apps/nod/src/emergency/feed.ts`, `apps/nod/src/emergency/feed.test.ts`.
- Modify: `apps/nod/package.json`. Dependencies gain `"htmlparser2": "^10.1.0"` and `"domhandler": "^5.0.3"` (the versions NRMS already uses, so the lockfile doesn't move). devDependencies gain `"@gcpe/emergency-feed-fake": "0.0.0"`. Run `npx -y -p node@24 -- npm install` afterwards to link the workspace.

**Interfaces:**
- Produces, in `@gcpe/emergency-feed-fake`:
  - `FakeAlert { guid; link; title; html; publishedAt }`;
  - `FAKE_ALERT_HOST = "https://emergency.example.test"`;
  - `renderFeedXml(alerts: FakeAlert[]): string`;
  - `createFakeEmergencyFeed(opts?: { statePath?: string }): { router: Router; controls: FakeEmergencyFeedControls }`. The controls are `add({ title, html?, guid?, link? }): FakeAlert`, `reset()` and `alerts()`.
  - Routes, relative to the mount: `GET /feed.xml`; `GET|POST /__fake/alerts`; `POST /__fake/reset`.
- Produces, in `apps/nod/src/emergency/feed.ts`:
  - `FeedAlert { identity; link; title; text; publishedAt: Date | null }`;
  - `ParsedFeed { alerts: FeedAlert[]; skipped: number }`;
  - `FeedFormatError`;
  - `MAX_TITLE_LENGTH = 500`, `MAX_ALERT_TEXT = 20_000`;
  - `parseEmergencyFeed(xml: string): ParsedFeed`;
  - `htmlToText(html: string): string`.

- [ ] **Step 1: Write the fake package and its failing test**

`packages/emergency-feed-fake/package.json`:

```json
{
  "name": "@gcpe/emergency-feed-fake",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "express": "^5.2.1" },
  "devDependencies": { "@types/express": "^5.0.6", "supertest": "^7.1.0", "@types/supertest": "^7.2.1" }
}
```

`packages/emergency-feed-fake/src/index.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createFakeEmergencyFeed, FAKE_ALERT_HOST } from "./index";

function appFor(statePath?: string) {
  const fake = createFakeEmergencyFeed({ statePath });
  const app = express();
  app.use(fake.router);
  return { app, fake };
}

describe("fake emergency feed", () => {
  it("serves an RSS 2.0 feed with two made-up alerts to begin with", async () => {
    const { app } = appFor();
    const res = await request(app).get("/feed.xml");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/rss+xml");
    expect(res.text).toMatch(/^<\?xml/);
    expect(res.text.match(/<item>/g)).toHaveLength(2);
    expect(res.text).toContain(`<link>${FAKE_ALERT_HOST}/alerts/`);
    expect(res.text.trimEnd()).toMatch(/<\/rss>$/);
  });

  it("an added alert is listed first, with its HTML in content:encoded", async () => {
    const { app } = appFor();
    const added = await request(app).post("/__fake/alerts").send({ title: "Evacuation order: Sample Creek", html: "<p>Leave now.</p><p>Route: Highway 1.</p>" });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ title: "Evacuation order: Sample Creek", link: expect.stringContaining(FAKE_ALERT_HOST) });
    const feed = (await request(app).get("/feed.xml")).text;
    expect(feed.indexOf("Evacuation order: Sample Creek")).toBeLessThan(feed.indexOf("Sample alert"));
    expect(feed).toContain("<content:encoded><![CDATA[<p>Leave now.</p><p>Route: Highway 1.</p>]]></content:encoded>");
  });

  it("a title is required", async () => {
    const { app } = appFor();
    expect((await request(app).post("/__fake/alerts").send({ html: "<p>x</p>" })).status).toBe(400);
  });

  it("reset goes back to the two starting alerts", async () => {
    const { app, fake } = appFor();
    fake.controls.add({ title: "Extra" });
    expect((await request(app).post("/__fake/reset")).status).toBe(204);
    expect(fake.controls.alerts()).toHaveLength(2);
  });

  it("keeps its alerts across a restart when given a state file", async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "fake-feed-")), "state.json");
    appFor(statePath).fake.controls.add({ title: "Survives restart" });
    expect(appFor(statePath).fake.controls.alerts().map((a) => a.title)).toContain("Survives restart");
  });
});
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/emergency-feed-fake`
Expected: FAIL, "Cannot find module './index'".

- [ ] **Step 2: Implement the fake**

`packages/emergency-feed-fake/src/index.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import express, { type Router } from "express";

/**
 * A fake emergency alerts feed, shaped like the WordPress category feed legacy's
 * EmergencyInfo.exe read (RSS 2.0 with `content:encoded`). Mounted by the stack on test sites
 * and in e2e, never in production. Every alert is made up; links point at example.test.
 */

export interface FakeAlert {
  guid: string;
  link: string;
  title: string;
  html: string;
  publishedAt: string;
}

export interface FakeEmergencyFeedControls {
  add(input: { title: string; html?: string; guid?: string; link?: string }): FakeAlert;
  reset(): void;
  alerts(): FakeAlert[];
}

export const FAKE_ALERT_HOST = "https://emergency.example.test";

function startingAlerts(): FakeAlert[] {
  return [
    { guid: "fake-alert-seed-1", link: `${FAKE_ALERT_HOST}/alerts/fake-alert-seed-1`, title: "Sample alert: boil water advisory lifted", html: "<p>Sample text for testing only.</p>", publishedAt: "2026-09-01T17:00:00.000Z" },
    { guid: "fake-alert-seed-2", link: `${FAKE_ALERT_HOST}/alerts/fake-alert-seed-2`, title: "Sample alert: road reopened", html: "<p>Sample text for testing only.</p>", publishedAt: "2026-08-15T17:00:00.000Z" },
  ];
}

const escapeXml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** A CDATA section can't contain "]]>", so it is split across two sections. */
const cdata = (s: string): string => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

/** Newest first, as WordPress serves it. */
export function renderFeedXml(alerts: FakeAlert[]): string {
  const items = [...alerts]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .map(
      (a) =>
        `<item><title>${escapeXml(a.title)}</title><link>${escapeXml(a.link)}</link>` +
        `<guid isPermaLink="false">${escapeXml(a.guid)}</guid><pubDate>${new Date(a.publishedAt).toUTCString()}</pubDate>` +
        `<description>${escapeXml(a.title)}</description><content:encoded>${cdata(a.html)}</content:encoded></item>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>` +
    `<title>Fake Emergency Info BC alerts</title><link>${FAKE_ALERT_HOST}/</link><description>Test feed. Never real alerts.</description>` +
    `${items}</channel></rss>\n`
  );
}

function load(statePath: string | undefined): FakeAlert[] {
  if (!statePath) return startingAlerts();
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { alerts?: FakeAlert[] };
    return Array.isArray(parsed.alerts) ? parsed.alerts : startingAlerts();
  } catch {
    return startingAlerts();
  }
}

export function createFakeEmergencyFeed(opts: { statePath?: string } = {}): { router: Router; controls: FakeEmergencyFeedControls } {
  let alerts = load(opts.statePath);
  let counter = alerts.length;
  const save = () => {
    if (!opts.statePath) return;
    mkdirSync(dirname(opts.statePath), { recursive: true });
    writeFileSync(opts.statePath, JSON.stringify({ alerts }));
  };

  const controls: FakeEmergencyFeedControls = {
    add(input) {
      counter += 1;
      const guid = input.guid ?? `fake-alert-${Date.now()}-${counter}`;
      const alert: FakeAlert = {
        guid,
        link: input.link ?? `${FAKE_ALERT_HOST}/alerts/${encodeURIComponent(guid)}`,
        title: input.title,
        html: input.html ?? "<p>Test alert.</p>",
        publishedAt: new Date().toISOString(),
      };
      alerts = [alert, ...alerts];
      save();
      return alert;
    },
    reset() {
      alerts = startingAlerts();
      save();
    },
    alerts: () => [...alerts],
  };

  const router = express.Router();
  router.get("/feed.xml", (_req, res) => {
    res.type("application/rss+xml; charset=utf-8").send(renderFeedXml(alerts));
  });
  router.get("/__fake/alerts", (_req, res) => void res.json(controls.alerts()));
  router.post("/__fake/alerts", express.json({ limit: "100kb" }), (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : undefined);
    const title = str(b.title);
    if (!title || title.length > 500) return void res.status(400).json({ error: "title is required (at most 500 characters)" });
    res.status(201).json(controls.add({ title, html: str(b.html), guid: str(b.guid), link: str(b.link) }));
  });
  router.post("/__fake/reset", (_req, res) => {
    controls.reset();
    res.status(204).end();
  });
  return { router, controls };
}
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/emergency-feed-fake`
Expected: PASS (5 tests).

- [ ] **Step 3: Write the failing parser tests**

`apps/nod/src/emergency/feed.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderFeedXml } from "@gcpe/emergency-feed-fake";
import { FeedFormatError, htmlToText, MAX_ALERT_TEXT, MAX_TITLE_LENGTH, parseEmergencyFeed } from "./feed";

/** The shape of a WordPress category feed (legacy's production feed was one). */
const WORDPRESS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Alerts &#8211; Emergency Info BC</title>
  <atom:link href="https://emergency.example.test/category/alerts/feed/" rel="self" type="application/rss+xml" />
  <item>
    <title>Evacuation order &#8211; Sample Creek&#8217;s east bank</title>
    <link>https://emergency.example.test/alerts/sample-creek/</link>
    <pubDate>Tue, 06 Oct 2026 21:15:00 +0000</pubDate>
    <guid isPermaLink="false">https://emergency.example.test/?p=1234</guid>
    <description><![CDATA[Short excerpt]]></description>
    <content:encoded><![CDATA[<p>Leave&nbsp;now.</p><ul><li>Route: Highway 1</li><li>Shelter: <a href="https://emergency.example.test/shelters">reception centre</a></li></ul><script>alert(1)</script><p>More at the <a href="https://emergency.example.test/">site</a>.</p>]]></content:encoded>
  </item>
</channel>
</rss>`;

describe("parseEmergencyFeed", () => {
  it("reads a WordPress RSS item: guid, link, decoded title, full content as text, date", () => {
    const { alerts, skipped } = parseEmergencyFeed(WORDPRESS);
    expect(skipped).toBe(0);
    expect(alerts).toEqual([
      {
        identity: "https://emergency.example.test/?p=1234",
        link: "https://emergency.example.test/alerts/sample-creek/",
        title: "Evacuation order – Sample Creek’s east bank",
        text: "Leave now.\n\n- Route: Highway 1\n- Shelter: reception centre (https://emergency.example.test/shelters)\n\nMore at the site (https://emergency.example.test/).",
        publishedAt: new Date("2026-10-06T21:15:00Z"),
      },
    ]);
  });

  it("falls back to description, and to the link when there is no guid", () => {
    const xml = `<rss version="2.0"><channel><item><title>T</title><link>https://emergency.example.test/a</link><description>&lt;p&gt;Body&lt;/p&gt;</description></item></channel></rss>`;
    expect(parseEmergencyFeed(xml).alerts[0]).toMatchObject({ identity: "https://emergency.example.test/a", text: "Body", publishedAt: null });
  });

  it("reads Atom entries: id, the alternate link, content, published", () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title>
      <entry><id>tag:emergency.example.test,2026:1</id><title>Atom alert</title>
        <link rel="self" href="https://emergency.example.test/self"/><link rel="alternate" href="https://emergency.example.test/alerts/1"/>
        <content type="html">&lt;p&gt;One&lt;/p&gt;&lt;p&gt;Two&lt;/p&gt;</content><published>2026-10-06T21:15:00Z</published></entry></feed>`;
    expect(parseEmergencyFeed(xml).alerts).toEqual([
      { identity: "tag:emergency.example.test,2026:1", link: "https://emergency.example.test/alerts/1", title: "Atom alert", text: "One\n\nTwo", publishedAt: new Date("2026-10-06T21:15:00Z") },
    ]);
  });

  it("skips entries with no http(s) link or no title, and counts them", () => {
    const xml = `<rss version="2.0"><channel>
      <item><title>No link</title><guid>g1</guid></item>
      <item><title>   </title><link>https://emergency.example.test/b</link></item>
      <item><title>Bad scheme</title><link>javascript:alert(1)</link></item>
      <item><title>Good</title><link>https://emergency.example.test/c</link></item></channel></rss>`;
    const parsed = parseEmergencyFeed(xml);
    expect(parsed.alerts.map((a) => a.title)).toEqual(["Good"]);
    expect(parsed.skipped).toBe(3);
  });

  it("an HTML error page served with 200 is not a feed", () => {
    expect(() => parseEmergencyFeed("<!doctype html><html><body><h1>503 Service Unavailable</h1></body></html>")).toThrow(FeedFormatError);
  });

  it("a truncated body is rejected whole, so half an alert is never sent", () => {
    expect(() => parseEmergencyFeed(WORDPRESS.slice(0, WORDPRESS.indexOf("<ul>")))).toThrow(FeedFormatError);
  });

  it("caps the title and the text", () => {
    const longTitle = "T".repeat(MAX_TITLE_LENGTH + 50);
    const longBody = `<p>${"x".repeat(MAX_ALERT_TEXT + 50)}</p>`;
    const xml = `<rss version="2.0"><channel><item><title>${longTitle}</title><link>https://emergency.example.test/l</link><description><![CDATA[${longBody}]]></description></item></channel></rss>`;
    const [a] = parseEmergencyFeed(xml).alerts;
    expect(a!.title).toHaveLength(MAX_TITLE_LENGTH);
    expect(a!.text).toHaveLength(MAX_ALERT_TEXT);
  });

  it("round-trips the fake feed, including a ']]>' inside the HTML", () => {
    const xml = renderFeedXml([{ guid: "g", link: "https://emergency.example.test/x", title: "A & B", html: "<p>odd ]]> text</p>", publishedAt: "2026-10-06T21:15:00.000Z" }]);
    expect(parseEmergencyFeed(xml).alerts).toEqual([
      { identity: "g", link: "https://emergency.example.test/x", title: "A & B", text: "odd ]]> text", publishedAt: new Date("2026-10-06T21:15:00Z") },
    ]);
  });
});

describe("htmlToText", () => {
  it("drops style and script, keeps line breaks, collapses blank runs", () => {
    expect(htmlToText("<style>p{}</style><p>a<br>b</p>\n\n\n<div>c</div>")).toBe("a\nb\n\nc");
  });
  it("leaves a link's URL off when the link text already is the URL", () => {
    expect(htmlToText(`<a href="https://emergency.example.test/">https://emergency.example.test/</a>`)).toBe("https://emergency.example.test/");
  });
  it("is empty for empty input", () => {
    expect(htmlToText("   ")).toBe("");
  });
});
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/emergency/feed.test.ts`
Expected: FAIL, "Cannot find module './feed'".

- [ ] **Step 4: Implement the parser**

`apps/nod/src/emergency/feed.ts`:

```ts
import { DomUtils, parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";

/** One alert, normalised for an `items` row. */
export interface FeedAlert {
  /** The feed's own id for the alert (RSS guid, Atom id), else its link. */
  identity: string;
  link: string;
  title: string;
  /** The alert's full content as plain text; paragraphs are separated by a blank line. */
  text: string;
  publishedAt: Date | null;
}

export interface ParsedFeed {
  alerts: FeedAlert[];
  /** Entries without a title or an http(s) link. */
  skipped: number;
}

/** Not RSS 2.0 or Atom, or cut off before its closing tag. */
export class FeedFormatError extends Error {
  constructor() {
    super("not a complete RSS or Atom feed");
    this.name = "FeedFormatError";
  }
}

export const MAX_TITLE_LENGTH = 500;
export const MAX_ALERT_TEXT = 20_000;

const isHttpUrl = (s: string): boolean => /^https?:\/\/\S+$/i.test(s);
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

function elementsOf(nodes: ChildNode[]): Element[] {
  return nodes.filter((c): c is Element => DomUtils.isTag(c));
}
function child(el: Element, name: string): Element | undefined {
  return elementsOf(el.children).find((c) => c.name === name);
}
function childText(el: Element, name: string): string {
  const c = child(el, name);
  return c ? DomUtils.textContent(c).trim() : "";
}
function parseDate(raw: string): Date | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t);
}

function toAlert(r: { identity: string; link: string; title: string; html: string; published: string }): FeedAlert | null {
  const title = squash(r.title).slice(0, MAX_TITLE_LENGTH);
  if (!isHttpUrl(r.link) || !title) return null;
  return {
    identity: r.identity || r.link,
    link: r.link,
    title,
    text: htmlToText(r.html).slice(0, MAX_ALERT_TEXT),
    publishedAt: parseDate(r.published),
  };
}

function fromRssItem(item: Element): FeedAlert | null {
  return toAlert({
    identity: childText(item, "guid"),
    link: childText(item, "link"),
    title: childText(item, "title"),
    html: childText(item, "content:encoded") || childText(item, "description"),
    published: childText(item, "pubDate"),
  });
}

function fromAtomEntry(entry: Element): FeedAlert | null {
  const links = elementsOf(entry.children).filter((c) => c.name === "link");
  const alternate = links.find((l) => (l.attribs.rel ?? "alternate") === "alternate");
  return toAlert({
    identity: childText(entry, "id"),
    link: (alternate?.attribs.href ?? "").trim(),
    title: childText(entry, "title"),
    html: childText(entry, "content") || childText(entry, "summary"),
    published: childText(entry, "published") || childText(entry, "updated"),
  });
}

/**
 * RSS 2.0 or Atom → alerts. Parsed in XML mode, which resolves no DTD or external entity. A
 * body that doesn't end with its root's closing tag is rejected whole: a feed cut off mid-download
 * would otherwise yield its last alert with half its text, and that alert would be emailed.
 */
export function parseEmergencyFeed(xml: string): ParsedFeed {
  if (!/<\/(rss|feed)>\s*$/.test(xml)) throw new FeedFormatError();
  const doc = parseDocument(xml, { xmlMode: true });
  const root = elementsOf(doc.children).find((c) => c.name === "rss" || c.name === "feed");
  if (!root) throw new FeedFormatError();
  const entries =
    root.name === "rss"
      ? elementsOf((child(root, "channel") ?? root).children).filter((c) => c.name === "item")
      : elementsOf(root.children).filter((c) => c.name === "entry");
  const alerts: FeedAlert[] = [];
  let skipped = 0;
  for (const e of entries) {
    const alert = root.name === "rss" ? fromRssItem(e) : fromAtomEntry(e);
    if (alert) alerts.push(alert);
    else skipped += 1;
  }
  return { alerts, skipped };
}

const BLOCK = new Set(["p", "div", "section", "article", "header", "footer", "ul", "ol", "table", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "figure", "hr"]);
const SKIP = new Set(["script", "style", "head", "noscript", "template"]);

/** Alert HTML → plain text: blocks become paragraphs, list items "- " lines, links "text (url)". */
export function htmlToText(html: string): string {
  if (!html.trim()) return "";
  const out: string[] = [];
  const walk = (nodes: ChildNode[]): void => {
    for (const n of nodes) {
      if (DomUtils.isText(n)) {
        out.push(n.data.replace(/\s+/g, " "));
        continue;
      }
      if (!DomUtils.isTag(n) || SKIP.has(n.name)) continue;
      if (n.name === "br") {
        out.push("\n");
        continue;
      }
      const block = BLOCK.has(n.name);
      if (block) out.push("\n\n");
      if (n.name === "li") out.push("\n- ");
      walk(n.children);
      if (n.name === "a") {
        const href = (n.attribs.href ?? "").trim();
        if (isHttpUrl(href) && href !== squash(DomUtils.textContent(n))) out.push(` (${href})`);
      }
      if (block) out.push("\n\n");
    }
  };
  walk(parseDocument(html).children);
  return out
    .join("")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/emergency/feed.test.ts`
Expected: PASS (11 tests).

If the list case yields `Leave now.\n\n\n- Route…`, the blank-run collapse is running before the per-line trim. Keep the order shown: split, trim each line, join, then collapse.

- [ ] **Step 5: Type-check and commit**

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

```bash
git add packages/emergency-feed-fake apps/nod/package.json package-lock.json apps/nod/src/emergency/feed.ts apps/nod/src/emergency/feed.test.ts
git commit -m "feat(nod): parse the emergency alerts feed; add a fake feed package"
```

---

### Task 2: The emergency ingester, its schedule and the stack wiring

Covers spec §9's "Emergency RSS ingester" (scheduled every 5 minutes, `EMERGENCY_FEED_URL`, dedupe, emergency sends) and R5–R8.

**Files:**
- Modify:
  - `apps/nod/src/db/schema.ts` (`nodSettings`), plus the generated migration `apps/nod/migrations/0026_emergency_feed_state.sql`;
  - `apps/nod/src/as-it-happens.ts` (`emergencyItemKey`; `recordEmergencyItem`'s `send` option);
  - `apps/nod/src/render.ts` (emergency paragraphs), and `apps/nod/src/render.test.ts`;
  - `apps/nod/src/start.ts` (env, worker, loop);
  - `apps/stack/src/env.ts`, `apps/stack/src/env.test.ts`;
  - `apps/stack/src/stack.ts`, `apps/stack/src/stack.test.ts`;
  - `apps/stack/package.json` (dependency `"@gcpe/emergency-feed-fake": "0.0.0"`).
- Create:
  - `apps/nod/src/emergency/ingest.ts`, `apps/nod/src/emergency/ingest.test.ts`;
  - `apps/nod/src/loop.ts`.

**Interfaces:**
- Consumes: `parseEmergencyFeed`, `FeedFormatError`, `FeedAlert` (Task 1); `renderFeedXml` (Task 1, tests).
- Produces:
  - `emergencyItemKey(identity: string): string` (as-it-happens.ts; the importer uses it in Task 8);
  - `ItemSending.recordEmergencyItem(db, input, opts?: { send?: boolean })`;
  - `nod_settings`: `emergency_feed_checked_at timestamptz`, `emergency_feed_seeded_url text`, `emergency_feed_result jsonb`;
  - in ingest.ts:
    - `EMERGENCY_FEED_INTERVAL_MS`, `FEED_TIMEOUT_MS`, `MAX_FEED_BYTES`;
    - `FeedFetchError` (`kind`);
    - `EmergencyFeedResult { at; ok; seeded; inFeed; created; updated; skipped; error }`;
    - `EmergencyFeedStatus { url: string | null; checkedAt: string | null; result: EmergencyFeedResult | null }`;
    - `fetchFeed(url, fetchImpl?)`;
    - `runEmergencyFeedIfDue(deps: EmergencyFeedDeps): Promise<{ ran: boolean; result?: EmergencyFeedResult }>`;
    - `getEmergencyFeedStatus(db, url)`;
  - `startLoop(label, run, intervalMs?)` (loop.ts);
  - NoD worker `emergencyFeed`; stack tick step `nod.emergency-feed`;
  - stack `FAKE_EMERGENCY_FEED_PATH = "/fake-emergency-feed"`, `FAKE_EMERGENCY_FEED_ENV`, `usesFakeEmergencyFeed(env)`.

- [ ] **Step 1: Add the schema columns and generate the migration**

In `apps/nod/src/db/schema.ts`, inside `nodSettings` after `bounceSoftCodesCounted`:

```ts
    // The emergency feed's 5-minute gate: when a check last claimed it (emergency/ingest.ts).
    emergencyFeedCheckedAt: timestamp("emergency_feed_checked_at", { withTimezone: true }),
    // The feed URL whose alerts were recorded without sending on its first successful read. A
    // different configured URL is read that way once, so pointing NoD at a live feed never
    // emails every alert already in it.
    emergencyFeedSeededUrl: text("emergency_feed_seeded_url"),
    // The last check's outcome (EmergencyFeedResult), shown on Operations.
    emergencyFeedResult: jsonb("emergency_feed_result"),
```

Run: `cd apps/nod && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name emergency_feed_state`
Expected: `migrations/0026_emergency_feed_state.sql` with three `ALTER TABLE "nod_settings" ADD COLUMN` statements and nothing else.

- [ ] **Step 2: Write the failing ingester tests**

`apps/nod/src/emergency/ingest.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { renderFeedXml, type FakeAlert } from "@gcpe/emergency-feed-fake";
import { createNodTestDb } from "../../test/helpers";
import { createItemSending, emergencyItemKey } from "../as-it-happens";
import { deliveries, items, nodSettings, sendJobs, subscribers, subscriptions } from "../db/schema";
import { fetchFeed, FeedFetchError, getEmergencyFeedStatus, MAX_FEED_BYTES, runEmergencyFeedIfDue } from "./ingest";

const URL_A = "https://emergency.example.test/feed.xml";
const render = { siteUrl: "https://news.example.test", bannerUrl: null };
const alert = (n: number, over: Partial<FakeAlert> = {}): FakeAlert => ({
  guid: `g-${n}`,
  link: `https://emergency.example.test/alerts/${n}`,
  title: `Alert ${n}`,
  html: `<p>Body ${n}</p>`,
  publishedAt: "2026-10-06T21:15:00.000Z",
  ...over,
});
/** A fetch stand-in; each call gets a fresh Response (a body can be read only once). */
const asFetch = (f: () => Promise<Response>) => vi.fn(f) as unknown as typeof fetch;
const serving = (body: string, status = 200) => asFetch(async () => new Response(body, { status }));

describe("emergency feed ingester", () => {
  let tdb: TestDatabase;
  const sending = createItemSending({ render });
  let clock = new Date("2026-10-07T18:00:00Z");
  const now = () => clock;
  const later = (minutes: number) => (clock = new Date(clock.getTime() + minutes * 60_000));
  const run = (fetchImpl: typeof fetch, url: string | null = URL_A) => runEmergencyFeedIfDue({ db: tdb.db, url, items: sending, fetch: fetchImpl, now });
  const emergencyJobs = async () => (await tdb.db.select().from(sendJobs).where(like(sendJobs.jobKey, "emergency:%"))).length;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const [s] = await tdb.db.insert(subscribers).values({ email: "alerts@example.test", status: "active", asItHappens: false, digest: true }).returning({ id: subscribers.id });
    await tdb.db.insert(subscriptions).values({ subscriberId: s!.id, listKey: "emergency:alerts" });
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    // Deliveries too: a leftover row for the same item and subscriber would make the next
    // test's send insert nothing.
    await tdb.db.delete(deliveries);
    await tdb.db.delete(sendJobs);
    await tdb.db.delete(items).where(eq(items.kind, "emergency"));
    await tdb.db.update(nodSettings).set({ emergencyFeedCheckedAt: null, emergencyFeedSeededUrl: null, emergencyFeedResult: null }).where(eq(nodSettings.id, 1));
    clock = new Date("2026-10-07T18:00:00Z");
  });

  it("no URL configured: does nothing and claims nothing", async () => {
    const f = serving(renderFeedXml([alert(1)]));
    expect(await run(f, null)).toEqual({ ran: false });
    expect(f).not.toHaveBeenCalled();
  });

  it("the first read of a URL records its alerts and sends nothing; a later new alert sends", async () => {
    const first = await run(serving(renderFeedXml([alert(1), alert(2)])));
    expect(first.result).toMatchObject({ ok: true, seeded: true, inFeed: 2, created: 2 });
    expect(await emergencyJobs()).toBe(0);

    later(5);
    const second = await run(serving(renderFeedXml([alert(3), alert(1), alert(2)])));
    expect(second.result).toMatchObject({ ok: true, seeded: false, inFeed: 3, created: 1 });
    const [job] = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, emergencyItemKey("g-3")));
    expect(job).toMatchObject({ kind: "emergency", subject: "Emergency Info BC - Alert 3" });
  });

  it("changing the configured URL seeds again instead of sending everything in the new feed", async () => {
    await run(serving(renderFeedXml([alert(1)])));
    later(5);
    const other = await run(serving(renderFeedXml([alert(7), alert(8)])), "https://emergency.example.test/other.xml");
    expect(other.result).toMatchObject({ seeded: true, created: 2 });
    expect(await emergencyJobs()).toBe(0);
  });

  it("runs at most once every 5 minutes", async () => {
    const f = serving(renderFeedXml([alert(1)]));
    expect((await run(f)).ran).toBe(true);
    later(4);
    expect((await run(f)).ran).toBe(false);
    later(1);
    expect((await run(f)).ran).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("a new guid on a known link sends nothing", async () => {
    await run(serving(renderFeedXml([alert(1)])));
    later(5);
    const r = await run(serving(renderFeedXml([alert(1, { guid: "g-1-renamed" })])));
    expect(r.result).toMatchObject({ created: 0, updated: 0 });
    expect(await emergencyJobs()).toBe(0);
  });

  it("an edited alert is updated in place, not re-sent", async () => {
    await run(serving(renderFeedXml([alert(1)])));
    later(5);
    await run(serving(renderFeedXml([alert(1), alert(2)])));
    expect(await emergencyJobs()).toBe(1);
    later(5);
    const r = await run(serving(renderFeedXml([alert(2, { title: "Alert 2 (updated)", html: "<p>New text</p>" }), alert(1)])));
    expect(r.result).toMatchObject({ created: 0, updated: 1 });
    expect(await emergencyJobs()).toBe(1);
    const [row] = await tdb.db.select().from(items).where(eq(items.key, emergencyItemKey("g-2")));
    expect(row).toMatchObject({ title: "Alert 2 (updated)", summary: "New text" });
  });

  it("a 200 HTML page records nothing and reports not-a-feed; the next check retries", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await run(serving("<!doctype html><html><body>Maintenance</body></html>"));
    expect(r.result).toMatchObject({ ok: false, error: "not-a-feed", created: 0 });
    expect(await getEmergencyFeedStatus(tdb.db, URL_A)).toMatchObject({ url: URL_A, result: { ok: false, error: "not-a-feed" } });
    later(5);
    expect((await run(serving(renderFeedXml([alert(1)])))).result).toMatchObject({ ok: true, seeded: true });
    spy.mockRestore();
  });

  it("an HTTP error is recorded by status, and the log carries only that label", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await run(serving("nope", 503))).result).toMatchObject({ ok: false, error: "http-503" });
    expect(spy.mock.calls.flat().join(" ")).toBe("[nod] emergency feed check failed: http-503");
    spy.mockRestore();
  });

  it("an emergency alert reaches a digest-only subscriber (everyone on the list, whatever their timing)", async () => {
    await run(serving(renderFeedXml([alert(1)])));
    later(5);
    await run(serving(renderFeedXml([alert(2), alert(1)])));
    const { rows } = await tdb.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM deliveries WHERE item_key = ${emergencyItemKey("g-2")}`);
    expect(rows[0]!.n).toBe(1);
  });
});

describe("fetchFeed", () => {
  it("rejects a body over the cap", async () => {
    const big = new Response(new Uint8Array(MAX_FEED_BYTES + 1));
    await expect(fetchFeed("https://emergency.example.test/feed.xml", asFetch(async () => big))).rejects.toMatchObject({ kind: "too-large" });
  });
  it("names a timeout as such", async () => {
    const abort = asFetch(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    await expect(fetchFeed("https://emergency.example.test/feed.xml", abort)).rejects.toBeInstanceOf(FeedFetchError);
    await expect(fetchFeed("https://emergency.example.test/feed.xml", abort)).rejects.toMatchObject({ kind: "timeout" });
  });
});
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/emergency/ingest.test.ts`
Expected: FAIL, "Cannot find module './ingest'" (and `emergencyItemKey` is not exported).

- [ ] **Step 3: Export the key function and add the `send` option**

In `apps/nod/src/as-it-happens.ts`, add above `createItemSending`:

```ts
/** An emergency alert's `items.key`: deterministic from the feed's identity, so the feed
 * ingester, the admin route and the legacy importer all land on the same row for one alert. */
export function emergencyItemKey(identity: string): string {
  return `emergency:${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}
```

Change the `ItemSending.recordEmergencyItem` declaration and implementation:

```ts
  /** Records a new emergency item (idempotent on `guid`) and, when it's genuinely new and
   * `send` isn't false, sends it in the same transaction. */
  recordEmergencyItem(
    db: Db,
    input: { guid: string; title: string; summary: string; url: string; publishedAt?: string },
    opts?: { send?: boolean },
  ): Promise<{ key: string; created: boolean }>;
```

```ts
  async function recordEmergencyItem(
    db: Db,
    input: { guid: string; title: string; summary: string; url: string; publishedAt?: string },
    opts: { send?: boolean } = {},
  ): Promise<{ key: string; created: boolean }> {
    const key = emergencyItemKey(input.guid);
    return db.transaction(async (tx) => {
      // ...the insert is unchanged...
      const created = insertedRows.length > 0;
      if (created && opts.send !== false) await createItemSend(tx, key, "emergency");
      return { key, created };
    });
  }
```

Delete the old inline key line and its comment. The new function's doc comment carries the reason.

- [ ] **Step 4: Implement the ingester and the loop helper**

`apps/nod/src/loop.ts`:

```ts
import { safeErrorLabel } from "@gcpe/http-kit";

/**
 * Calls `run` every `intervalMs`, never two at once. A failure is logged by label and never
 * stops later calls. The returned stop function clears the interval and waits for a call in
 * flight. Gating (every 5 minutes, nightly) lives in `run` itself, so a minute's interval is
 * enough for every worker.
 */
export function startLoop(label: string, run: () => Promise<unknown>, intervalMs = 60_000): () => Promise<void> {
  let stopped = false;
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = run()
      .catch((e) => console.error(`[nod] ${label} failed: ${safeErrorLabel(e)}`))
      .finally(() => {
        running = null;
      });
  }, intervalMs);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
```

`apps/nod/src/emergency/ingest.ts`:

```ts
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { sqlInterval, sqlNow, type Db, type DbOrTx, type TestClock } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import { emergencyItemKey, type ItemSending } from "../as-it-happens";
import { items, nodSettings } from "../db/schema";
import { FeedFormatError, parseEmergencyFeed, type FeedAlert } from "./feed";

export const EMERGENCY_FEED_INTERVAL_MS = 5 * 60_000;
export const FEED_TIMEOUT_MS = 15_000;
export const MAX_FEED_BYTES = 2 * 1024 * 1024;

/** What one check did, kept on nod_settings for Operations. `error` is a label, never a body. */
export interface EmergencyFeedResult {
  at: string;
  ok: boolean;
  /** This check was a first read of the URL: alerts were recorded, nothing was sent. */
  seeded: boolean;
  inFeed: number;
  created: number;
  updated: number;
  skipped: number;
  error: string | null;
}

export interface EmergencyFeedStatus {
  url: string | null;
  checkedAt: string | null;
  result: EmergencyFeedResult | null;
}

export class FeedFetchError extends Error {
  constructor(public readonly kind: string) {
    super(`emergency feed fetch failed: ${kind}`);
    this.name = "FeedFetchError";
  }
}

const isTimeout = (e: unknown) => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

/** GETs the feed with a time limit (covering the body too) and a size cap. */
export async function fetchFeed(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      headers: { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.1" },
    });
  } catch (e) {
    throw new FeedFetchError(isTimeout(e) ? "timeout" : "network");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new FeedFetchError(`http-${res.status}`);
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FEED_BYTES) {
        await reader.cancel().catch(() => {});
        throw new FeedFetchError("too-large");
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof FeedFetchError) throw e;
    throw new FeedFetchError(isTimeout(e) ? "timeout" : "network");
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One atomic UPDATE claims the 5-minute gate, by the database clock: two concurrent callers
 * resolve to one claim (the second re-evaluates its WHERE against the committed row). */
async function claimFeedGate(db: Db, now?: TestClock): Promise<{ seededUrl: string | null; checkedAt: Date } | null> {
  const n = sqlNow(now);
  const [row] = await db
    .update(nodSettings)
    .set({ emergencyFeedCheckedAt: n })
    .where(
      and(
        eq(nodSettings.id, 1),
        or(isNull(nodSettings.emergencyFeedCheckedAt), sql`${nodSettings.emergencyFeedCheckedAt} <= ${n} - ${sqlInterval(EMERGENCY_FEED_INTERVAL_MS)}`),
      ),
    )
    .returning({ seededUrl: nodSettings.emergencyFeedSeededUrl, checkedAt: nodSettings.emergencyFeedCheckedAt });
  return row ? { seededUrl: row.seededUrl, checkedAt: row.checkedAt! } : null;
}

/** An alert is known by its key or by its link, so a guid change alone never re-sends it. */
async function knownAlert(db: DbOrTx, alert: FeedAlert): Promise<{ key: string; title: string; summary: string } | null> {
  const [row] = await db
    .select({ key: items.key, title: items.title, summary: items.summary })
    .from(items)
    .where(and(eq(items.kind, "emergency"), or(eq(items.key, emergencyItemKey(alert.identity)), eq(items.url, alert.link))))
    .orderBy(items.publishedAt)
    .limit(1);
  return row ?? null;
}

export interface EmergencyFeedDeps {
  db: Db;
  /** EMERGENCY_FEED_URL; null = no feed, nothing is read. */
  url: string | null;
  items: Pick<ItemSending, "recordEmergencyItem">;
  fetch?: typeof fetch;
  now?: TestClock;
}

/**
 * The 5-minute emergency feed check. A new alert becomes an emergency item and is sent to
 * everyone on emergency:alerts. A known one (same key or same link) whose title or text
 * changed is updated in place and never re-sent, as legacy did. The first successful read of a
 * URL records everything without sending. Any failure records its label; alerts recorded
 * before it stay, and the next check carries on from there.
 */
export async function runEmergencyFeedIfDue(deps: EmergencyFeedDeps): Promise<{ ran: boolean; result?: EmergencyFeedResult }> {
  if (!deps.url) return { ran: false };
  const gate = await claimFeedGate(deps.db, deps.now);
  if (!gate) return { ran: false };

  const seeding = gate.seededUrl !== deps.url;
  const result: EmergencyFeedResult = { at: gate.checkedAt.toISOString(), ok: false, seeded: seeding, inFeed: 0, created: 0, updated: 0, skipped: 0, error: null };
  try {
    const parsed = parseEmergencyFeed(await fetchFeed(deps.url, deps.fetch));
    result.inFeed = parsed.alerts.length;
    result.skipped = parsed.skipped;
    for (const alert of parsed.alerts) {
      const known = await knownAlert(deps.db, alert);
      if (known) {
        if (known.title === alert.title && known.summary === alert.text) continue;
        await deps.db.update(items).set({ title: alert.title, summary: alert.text, updatedAt: sql`now()` }).where(eq(items.key, known.key));
        result.updated += 1;
        continue;
      }
      const { created } = await deps.items.recordEmergencyItem(
        deps.db,
        { guid: alert.identity, title: alert.title, summary: alert.text, url: alert.link, publishedAt: alert.publishedAt?.toISOString() },
        { send: !seeding },
      );
      if (created) result.created += 1;
    }
    result.ok = true;
  } catch (e) {
    result.error = e instanceof FeedFetchError ? e.kind : e instanceof FeedFormatError ? "not-a-feed" : safeErrorLabel(e);
    console.error(`[nod] emergency feed check failed: ${result.error}`);
  }

  await deps.db
    .update(nodSettings)
    .set({ emergencyFeedResult: result, ...(result.ok && seeding ? { emergencyFeedSeededUrl: deps.url } : {}), updatedAt: sql`now()` })
    .where(eq(nodSettings.id, 1));
  return { ran: true, result };
}

export async function getEmergencyFeedStatus(db: DbOrTx, url: string | null): Promise<EmergencyFeedStatus> {
  const [row] = await db
    .select({ checkedAt: nodSettings.emergencyFeedCheckedAt, result: nodSettings.emergencyFeedResult })
    .from(nodSettings)
    .where(eq(nodSettings.id, 1));
  return { url, checkedAt: row?.checkedAt ? row.checkedAt.toISOString() : null, result: (row?.result as EmergencyFeedResult | null) ?? null };
}
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/emergency apps/nod/src/as-it-happens.test.ts`
Expected: PASS. The existing as-it-happens tests still pass, because the key is unchanged and `send` defaults to true.

- [ ] **Step 5: Emergency emails show every paragraph (failing test first)**

In `apps/nod/src/render.test.ts`, add:

```ts
it("an emergency email keeps the alert's paragraphs; a release's summary stays one paragraph", () => {
  const item = { key: "emergency:x", title: "T", summary: "First line\nsecond line\n\nNext paragraph", url: "https://emergency.example.test/a", publishedAt: new Date("2026-10-06T21:15:00Z"), categories: [] };
  const emergency = renderEmergency(item, { siteUrl: "https://news.example.test", bannerUrl: null });
  expect(emergency.html).toContain(">First line<br>second line</p>");
  expect(emergency.html).toContain(">Next paragraph</p>");
  expect(emergency.text).toContain("First line\nsecond line\n\nNext paragraph");
  const release = renderAsItHappens(item, { siteUrl: "https://news.example.test", bannerUrl: null });
  expect(release.html).toContain(">First line\nsecond line\n\nNext paragraph</p>");
});
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/render.test.ts`
Expected: FAIL on the `<br>` assertion.

In `apps/nod/src/render.ts`, replace the summary paragraph inside `itemBlockHtml` with a call to a new helper, and give `itemBlockHtml` a `paragraphs` flag:

```ts
const SUMMARY_STYLE = "margin:0 0 8px;font-size:14px;color:#333333;";

/** A release's summary is one paragraph, as it always was. An emergency alert carries its whole
 * text, so its blank-line paragraphs and line breaks are kept. */
function summaryHtml(summary: string, paragraphs: boolean): string {
  if (!paragraphs) return `<p style="${SUMMARY_STYLE}">${neutralizeHtml(summary)}</p>`;
  return summary
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== "")
    .map((p) => `<p style="${SUMMARY_STYLE}">${neutralizeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}
```

In `itemBlockHtml(item: RenderItem, paragraphs = false)`, use `summaryHtml(item.summary, paragraphs)` where the summary `<p>` was. In `renderEmergency`, call `itemBlockHtml(item, true)`. Every other caller is unchanged.

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/render.test.ts apps/nod/src/digest.test.ts apps/nod/src/send-jobs.test.ts`
Expected: PASS, including every existing exact-HTML assertion for releases and digests.

- [ ] **Step 6: Wire the worker into NoD's start**

In `apps/nod/src/start.ts`:
- `nodEnvSchema` gains, after `REPLY_TO`:

```ts
  // The EMCR emergency alerts feed (RSS or Atom), read every 5 minutes (emergency/ingest.ts).
  // Unset: no alerts are read. The stack points test sites at its fake feed. The operator sets
  // `NOD_EMERGENCY_FEED_URL`; envFor strips the "NOD_" prefix.
  EMERGENCY_FEED_URL: z.string().url().optional(),
```

- After `sendJobsOptions`:

```ts
  const emergencyFeed: EmergencyFeedDeps = { db, url: parsed.EMERGENCY_FEED_URL ?? null, items: createItemSending({ render }) };
  if (!emergencyFeed.url) console.warn("[nod] EMERGENCY_FEED_URL is not set: no emergency alerts are read");
```

- `workers` gains `emergencyFeed: () => runEmergencyFeedIfDue(emergencyFeed),`.
- `startLoops()` gains `stopEmergencyFeedLoop = startLoop("emergency feed", () => runEmergencyFeedIfDue(emergencyFeed));`, with a matching `let stopEmergencyFeedLoop` and a closer `{ name: "emergency feed loop", close: async () => { await stopEmergencyFeedLoop?.(); } }` before `db pool`.
- Imports: `createItemSending` from `./as-it-happens`, `runEmergencyFeedIfDue` and `type EmergencyFeedDeps` from `./emergency/ingest`, and `startLoop` from `./loop`.

In `apps/nod/src/start.test.ts`, add `"emergencyFeed"` wherever the test lists the worker names. If it asserts `Object.keys(handle.workers)`, insert it after `bounceSummary`.

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/start.test.ts`
Expected: PASS.

- [ ] **Step 7: Stack: the fake feed, the env view and the tick step (failing tests first)**

In `apps/stack/src/env.test.ts`, import `FAKE_EMERGENCY_FEED_ENV`, `FAKE_EMERGENCY_FEED_PATH` and `usesFakeEmergencyFeed`. Wherever a test expects `envFor(…, "NOD")` to `toEqual` an object containing `...FAKE_MEDIA_HUB_ENV`, add `...FAKE_EMERGENCY_FEED_ENV` beside it. Then add:

```ts
describe("fake emergency feed", () => {
  it("no NOD_EMERGENCY_FEED_URL on a test deployment: NoD reads the stack's fake", () => {
    expect(usesFakeEmergencyFeed({})).toBe(true);
    expect(envFor({}, "NOD")).toMatchObject(FAKE_EMERGENCY_FEED_ENV);
    expect(resolveSelfUrls(envFor({}, "NOD")).EMERGENCY_FEED_URL).toBe(`http://stack.internal${FAKE_EMERGENCY_FEED_PATH}/feed.xml`);
  });
  it("a configured URL wins and nothing of the fake is set", () => {
    const env = { NOD_EMERGENCY_FEED_URL: "https://emergency.example.test/feed/" };
    expect(usesFakeEmergencyFeed(env)).toBe(false);
    expect(envFor(env, "NOD").EMERGENCY_FEED_URL).toBe("https://emergency.example.test/feed/");
  });
  it("production with no URL reads nothing; it is never pointed at the fake", () => {
    expect(usesFakeEmergencyFeed({ NODE_ENV: "production" })).toBe(false);
    expect(envFor({ NODE_ENV: "production" }, "NOD").EMERGENCY_FEED_URL).toBeUndefined();
  });
  it("an explicitly allowed test deployment in production mode still gets the fake", () => {
    expect(usesFakeEmergencyFeed({ NODE_ENV: "production", LOCAL_ADMIN_ALLOW_IN_PRODUCTION: "true" })).toBe(true);
  });
});
```

In `apps/stack/src/stack.test.ts`:
- In the `/stack/tick` test, the expected step list becomes `…, "nod.media-sync", "nod.bounce-summary", "nod.purge", "nod.emergency-feed", "nod.digest", "nod.send", …`, with 15 `"ok"` values. `nod.purge` arrives in Task 3. Until then, assert the 14-step list without it and add it in Task 3 Step 8.
- Add a `describe("fake emergency feed …")` beside the fake Media Hub block:

```ts
  describe("fake emergency feed (no NOD_EMERGENCY_FEED_URL configured)", () => {
    it("serves its RSS publicly, like the real feed; /__fake needs Core.Admin", async () => {
      const feed = await fetch(`${instance.stackUrl}/fake-emergency-feed/feed.xml`);
      expect(feed.status).toBe(200);
      expect(await feed.text()).toContain("<rss");
      const editor = await mintLocalToken({ secret: LOCAL_AUTH_SECRET, subject: "editor", roles: ["NRMS.Editor"] });
      const add = (headers: Record<string, string>) =>
        fetch(`${instance.stackUrl}/fake-emergency-feed/__fake/alerts`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ title: "Stack test alert" }) });
      expect((await add({})).status).toBe(401);
      expect((await add({ authorization: `Bearer ${editor}` })).status).toBe(403);
      expect((await add({ authorization: `Bearer ${instance.adminToken}` })).status).toBe(201);
    });
  });
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/stack/src/env.test.ts apps/stack/src/stack.test.ts`
Expected: FAIL (the exports are missing).

In `apps/stack/src/env.ts`, after the fake Media Hub block:

```ts
/** Where the stack mounts its fake emergency feed when NoD has no real one configured. */
export const FAKE_EMERGENCY_FEED_PATH = "/fake-emergency-feed";

/** What NoD's env view gets in fake mode: the fake's in-process feed URL. */
export const FAKE_EMERGENCY_FEED_ENV: Readonly<Record<string, string>> = {
  EMERGENCY_FEED_URL: `self:${FAKE_EMERGENCY_FEED_PATH}/feed.xml`,
};

/**
 * True when NoD reads the stack's fake emergency feed: no effective NOD_EMERGENCY_FEED_URL and
 * not a real production deployment (the same net as usesFakeMediaHub). Production with no URL
 * reads no feed at all rather than made-up alerts.
 */
export function usesFakeEmergencyFeed(env: NodeJS.ProcessEnv): boolean {
  if (env.NOD_EMERGENCY_FEED_URL) return false;
  return env.NODE_ENV !== "production" || env.LOCAL_ADMIN_ALLOW_IN_PRODUCTION === "true";
}
```

In `envFor`, after the Media Hub line:

```ts
  if (prefix === "NOD" && usesFakeEmergencyFeed(env)) Object.assign(view, FAKE_EMERGENCY_FEED_ENV);
```

In `apps/stack/src/stack.ts`:
- Import `createFakeEmergencyFeed` from `@gcpe/emergency-feed-fake`, and `FAKE_EMERGENCY_FEED_PATH`, `usesFakeEmergencyFeed` from `./env`.
- After the fake Media Hub block:

```ts
  // No NOD_EMERGENCY_FEED_URL on a test deployment → a fake alerts feed NoD's env view already
  // points at. The feed itself is public, as the real one is; adding or resetting alerts
  // (/__fake) is Core.Admin-only, as with the other fakes.
  if (usesFakeEmergencyFeed(env)) {
    console.warn(`[stack] EMERGENCY FEED: using the FAKE feed at ${FAKE_EMERGENCY_FEED_PATH} — set NOD_EMERGENCY_FEED_URL for the real one`);
    const fakeFeed = createFakeEmergencyFeed({ statePath: join(dataDir, "fake-emergency-feed-state.json") });
    app.use(`${FAKE_EMERGENCY_FEED_PATH}/__fake`, requireBearer(errorsAuth.bearer), requireRole("Core.Admin"));
    app.use(FAKE_EMERGENCY_FEED_PATH, fakeFeed.router);
  }
```

- In the tick list, after `nod.bounce-summary`:

```ts
        // Self-gated to every 5 minutes (emergency/ingest.ts). Before nod.send, so an alert
        // recorded this tick goes out in the same tick.
        { name: "nod.emergency-feed", run: worker(nod, "emergencyFeed") },
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/stack apps/nod`
Expected: PASS.

- [ ] **Step 8: Type-check and commit**

Run both `tsc` commands. Expected: no errors.

```bash
git add apps/nod apps/stack package-lock.json
git commit -m "feat(nod): read the emergency alerts feed every 5 minutes and send new alerts"
```

---
### Task 3: The retention purge engine

Covers spec §9's "Retention purge" (off by default, nightly, the 10- and 90-day rules, cascading deliveries and history, a preview), acceptance item 12, the carry-forward "purge expired `origin='send'` links", and R9–R14.

**Files:**
- Modify:
  - `apps/nod/src/db/schema.ts` (`nodSettings` purge columns; new `mediaOptOuts`; indexes on `jobRecipients` and `subscriberLinks`), plus the generated migrations `apps/nod/migrations/0027_retention_purge.sql` and `0028_purge_indexes.sql`;
  - `apps/nod/src/settings.ts` (`OperationsAction`);
  - `apps/nod/src/start.ts` (worker and loop);
  - `apps/stack/src/stack.ts`, `apps/stack/src/stack.test.ts` (tick step `nod.purge`).
- Create:
  - `apps/nod/src/purge.ts`, `apps/nod/src/purge.test.ts`;
  - `apps/nod/src/opt-outs.ts`, `apps/nod/src/opt-outs.test.ts`.

**Interfaces:**
- Consumes: `withLockedSubscriber`, `lockAddress` (`locks.ts`); `dailyCutoff`, `todaysCutoff` (`digest.ts`); `writeOpsLog` (`settings.ts`); `sqlNow`, `sqlInterval`, `TestClock` (`@gcpe/db-kit`); `waitForLockWaiter` (`apps/nod/test/helpers.ts`).
- Produces, in `purge.ts`:
  - `PURGE_HOUR = 3`, `UNCONFIRMED_DAYS = 10`, `ENDED_DAYS = 90`, `LINK_DAYS = 10`, `SUBSCRIBER_BATCH = 100`, `RUN_BUDGET_MS = 20_000`, `RUN_MAX_SUBSCRIBERS = 500`;
  - `PurgeCounts { pendingSubscribers; endedSubscribers; unusedLinks; expiredSendLinks }`;
  - `purgeSelection(now?): Record<keyof PurgeCounts, SQL>`;
  - `previewPurge(db, now?): Promise<PurgeCounts>`;
  - `purgeBatch(db, opts: { enabled; deadline; maxSubscribers?; batchSize?; now? }): Promise<{ counts: PurgeCounts; finished: boolean }>`;
  - `PurgeRunResult { cutoff; counts; finished; enabled }`;
  - `runPurgeIfDue(db, timeZone, opts?: { now?; budgetMs?; maxSubscribers? }): Promise<{ ran: boolean; result?: PurgeRunResult }>`;
  - `setPurgeEnabled(db, enabled, actor): Promise<{ changed: boolean }>`;
  - `PurgeStatus { enabled; preview: PurgeCounts; lastRun: PurgeRunResult | null; nextRunAt: string }`;
  - `getPurgeStatus(db, timeZone, now?): Promise<PurgeStatus>`;
  - `describeCounts(c): string`;
  - `PURGE_ACTOR = "Retention purge"`.
- Produces, in `opt-outs.ts`: `optOutHash(email): string`; `keepMediaOptOuts(tx, s: { id; email }): Promise<number>`; `suppressedOptOutAt(tx, email, listKey): Promise<Date | null>`.
- Schema:
  - `nod_settings.purge_enabled bool not null default false`, `purge_done_cutoff`, `purge_lease`, `purge_lease_until`, `purge_result jsonb`;
  - table `media_opt_outs(email_hash, list_key, opted_out_at)`, PK `(email_hash, list_key)`;
  - indexes `job_recipients_subscriber_idx`, `subscriber_links_subscriber_idx`, `subscriber_links_send_expiry_idx` (partial, `origin = 'send'`) and `subscriber_links_request_unused_idx` (partial, `origin = 'request' AND used_at IS NULL`).
- `OperationsAction` gains `"purge-enabled" | "purge-disabled" | "purge-ran"`.

- [ ] **Step 1: Schema and the two migrations**

In `apps/nod/src/db/schema.ts`, inside `nodSettings` after the emergency feed columns:

```ts
    // The retention purge (purge.ts). Off until the business sets retention windows (Q25).
    purgeEnabled: boolean("purge_enabled").notNull().default(false),
    // The 03:00 BC cutoff of the last night whose purge finished: that night is done.
    purgeDoneCutoff: timestamp("purge_done_cutoff", { withTimezone: true }),
    // A lease, as for the bounce summary: one night's purge may need several ticks to finish.
    purgeLease: uuid("purge_lease"),
    purgeLeaseUntil: timestamp("purge_lease_until", { withTimezone: true }),
    // That night's running totals (PurgeRunResult), shown on Operations.
    purgeResult: jsonb("purge_result"),
```

After `subscriberHistory`, add:

```ts
/**
 * Media-list opt-outs kept after the retention purge deleted the subscriber: a hash of the
 * address (opt-outs.ts), never the address. Re-adding that address to that list asks staff
 * first, exactly as the history-based check does for a subscriber who still exists.
 */
export const mediaOptOuts = pgTable(
  "media_opt_outs",
  {
    emailHash: text("email_hash").notNull(),
    listKey: text("list_key").notNull(),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.emailHash, t.listKey] })],
);
```

Run: `cd apps/nod && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name retention_purge`
Expected: `0027_retention_purge.sql` with five `ADD COLUMN`s and one `CREATE TABLE "media_opt_outs"`, and no index.

Then add the indexes:
- On `jobRecipients`, the third argument becomes:

```ts
  (t) => [
    primaryKey({ columns: [t.jobId, t.subscriberId] }),
    // A subscriber's delete cascades here; the primary key leads with job_id and can't serve it.
    index("job_recipients_subscriber_idx").on(t.subscriberId),
  ],
```

- On `subscriberLinks`, add to its index list:

```ts
    // A subscriber's delete cascades here.
    index("subscriber_links_subscriber_idx").on(t.subscriberId),
    // The nightly sweep of expired send links, and of unused request links (purge.ts).
    index("subscriber_links_send_expiry_idx").on(t.expiresAt).where(sql`${t.origin} = 'send'`),
    index("subscriber_links_request_unused_idx").on(t.createdAt).where(sql`${t.origin} = 'request' AND ${t.usedAt} IS NULL`),
```

Run: `cd apps/nod && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name purge_indexes`
Expected: `0028_purge_indexes.sql` containing **only** four `CREATE INDEX` statements. If anything else appears, the first generate missed a change: delete both files and the journal entries, and regenerate in order.

- [ ] **Step 2: Write the failing opt-out tests**

`apps/nod/src/opt-outs.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { mediaOptOuts, subscriberHistory, subscribers } from "./db/schema";
import { keepMediaOptOuts, optOutHash, suppressedOptOutAt } from "./opt-outs";

describe("kept media opt-outs", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());

  it("the hash ignores case and surrounding space, and is not the address", () => {
    expect(optOutHash(" Gone@Example.TEST ")).toBe(optOutHash("gone@example.test"));
    expect(optOutHash("gone@example.test")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps each list's latest opt-out, without the address; a later keep only moves it forward", async () => {
    const [s] = await tdb.db.insert(subscribers).values({ email: "gone@example.test", status: "deleted" }).returning();
    await tdb.db.insert(subscriberHistory).values([
      { subscriberId: s!.id, actor: "self", action: "media-list-opted-out", detail: "media-distribution-lists:budget", at: new Date("2026-03-01T17:00:00Z") },
      { subscriberId: s!.id, actor: "self", action: "media-list-opted-out", detail: "media-distribution-lists:budget", at: new Date("2026-05-01T17:00:00Z") },
      { subscriberId: s!.id, actor: "self", action: "media-list-opted-out", detail: "media-distribution-lists:transport", at: new Date("2026-04-01T17:00:00Z") },
      { subscriberId: s!.id, actor: "staff", action: "media-list-removed", detail: "media-distribution-lists:health", at: new Date("2026-04-01T17:00:00Z") },
    ]);
    expect(await keepMediaOptOuts(tdb.db, s!)).toBe(2);
    expect(await suppressedOptOutAt(tdb.db, "GONE@example.test", "media-distribution-lists:budget")).toEqual(new Date("2026-05-01T17:00:00Z"));
    expect(await suppressedOptOutAt(tdb.db, "gone@example.test", "media-distribution-lists:health")).toBeNull();
    const rows = await tdb.db.select().from(mediaOptOuts);
    expect(JSON.stringify(rows)).not.toContain("@");

    await tdb.db.execute(sql`UPDATE subscriber_history SET at = '2026-01-01T00:00:00Z' WHERE detail = 'media-distribution-lists:budget'`);
    await keepMediaOptOuts(tdb.db, s!);
    expect(await suppressedOptOutAt(tdb.db, "gone@example.test", "media-distribution-lists:budget")).toEqual(new Date("2026-05-01T17:00:00Z"));
  });
});
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/opt-outs.test.ts`
Expected: FAIL, "Cannot find module './opt-outs'".

- [ ] **Step 3: Implement `opt-outs.ts`**

```ts
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { mediaOptOuts, type SubscriberRow } from "./db/schema";
import { normaliseEmail } from "./subscribe/info";

/**
 * The key a media-list opt-out is kept under once the subscriber row is purged: SHA-256 of the
 * lowercased address under a fixed prefix. Unkeyed on purpose: rotating LINK_SECRET (the
 * response to a leaked unsubscribe token) must never forget anyone's opt-out.
 */
export function optOutHash(email: string): string {
  return createHash("sha256").update(`gcpe-nod-media-opt-out:${normaliseEmail(email)}`).digest("hex");
}

/** Copies the subscriber's media-list opt-outs (latest per list) into media_opt_outs. Called
 * inside the purge's per-subscriber transaction, just before the row is deleted. */
export async function keepMediaOptOuts(tx: DbOrTx, s: Pick<SubscriberRow, "id" | "email">): Promise<number> {
  const res = await tx.execute(sql`
    INSERT INTO ${mediaOptOuts} (email_hash, list_key, opted_out_at)
    SELECT ${optOutHash(s.email)}, detail, max(at) FROM subscriber_history
     WHERE subscriber_id = ${s.id} AND action = 'media-list-opted-out'
     GROUP BY detail
    ON CONFLICT (email_hash, list_key) DO UPDATE SET opted_out_at = GREATEST(${mediaOptOuts.optedOutAt}, EXCLUDED.opted_out_at)`);
  return res.rowCount ?? 0;
}

export async function suppressedOptOutAt(tx: DbOrTx, email: string, listKey: string): Promise<Date | null> {
  const [row] = await tx
    .select({ at: mediaOptOuts.optedOutAt })
    .from(mediaOptOuts)
    .where(and(eq(mediaOptOuts.emailHash, optOutHash(email)), eq(mediaOptOuts.listKey, listKey)));
  return row?.at ?? null;
}
```

Run the opt-out tests. Expected: PASS.

- [ ] **Step 4: Write the failing purge tests**

`apps/nod/src/purge.test.ts`:

```ts
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql, type SQL } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb, waitForLockWaiter } from "../test/helpers";
import {
  deliveries, jobRecipients, mediaOptOuts, nodSettings, operationsLog, sendJobs, subscriberHistory, subscriberLinks, subscribers, subscriptions,
  type SubscriberStatus,
} from "./db/schema";
import { lockAddress } from "./locks";
import { getPurgeStatus, previewPurge, purgeBatch, purgeSelection, runPurgeIfDue, setPurgeEnabled } from "./purge";

const TZ = "America/Vancouver";
const DAY = 24 * 3_600_000;
/** 04:00 BC on 2026-11-20, after BC moved to permanent UTC−7: 03:00 BC is 10:00Z. */
const NOW = new Date("2026-11-20T11:00:00Z");
const ago = (days: number, from = NOW) => new Date(from.getTime() - days * DAY);

describe("retention purge", () => {
  let tdb: TestDatabase;
  let clock = NOW;
  const now = () => clock;
  let n = 0;

  async function subscriber(status: SubscriberStatus, opts: { createdAt?: Date; endedAt?: Date | null } = {}): Promise<string> {
    n += 1;
    const [s] = await tdb.db
      .insert(subscribers)
      .values({ email: `p${n}@example.test`, status, createdAt: opts.createdAt ?? ago(400), endedAt: opts.endedAt ?? null })
      .returning({ id: subscribers.id });
    return s!.id;
  }
  async function link(origin: "request" | "send", opts: { createdAt: Date; expiresAt?: Date; usedAt?: Date | null; subscriberId?: string | null }): Promise<string> {
    const [l] = await tdb.db
      .insert(subscriberLinks)
      .values({
        tokenHash: randomBytes(16).toString("hex"),
        purpose: origin === "send" ? "manage" : "verify",
        email: "link@example.test",
        origin,
        createdAt: opts.createdAt,
        expiresAt: opts.expiresAt ?? new Date(opts.createdAt.getTime() + DAY),
        usedAt: opts.usedAt ?? null,
        subscriberId: opts.subscriberId ?? null,
      })
      .returning({ id: subscriberLinks.id });
    return l!.id;
  }
  const exists = async (id: string) => (await tdb.db.select({ id: subscribers.id }).from(subscribers).where(eq(subscribers.id, id))).length === 1;
  const linkExists = async (id: string) => (await tdb.db.select({ id: subscriberLinks.id }).from(subscriberLinks).where(eq(subscriberLinks.id, id))).length === 1;

  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    clock = NOW;
    await tdb.db.execute(sql`DELETE FROM subscriber_links; DELETE FROM job_recipients; DELETE FROM send_jobs; DELETE FROM deliveries; DELETE FROM subscriber_history; DELETE FROM subscriptions; DELETE FROM subscribers; DELETE FROM media_opt_outs; DELETE FROM operations_log;`);
    await tdb.db.update(nodSettings).set({ purgeEnabled: false, purgeDoneCutoff: null, purgeLease: null, purgeLeaseUntil: null, purgeResult: null }).where(eq(nodSettings.id, 1));
  });

  it("the preview counts exactly what the purge removes, at each boundary", async () => {
    const goneUnconfirmed = await subscriber("pending", { createdAt: ago(11) });
    const keptUnconfirmed9 = await subscriber("pending", { createdAt: ago(9) });
    const keptUnconfirmed10 = await subscriber("pending", { createdAt: ago(10) });
    const goneEnded = await subscriber("deleted", { endedAt: ago(91) });
    const keptEnded89 = await subscriber("deleted", { endedAt: ago(89) });
    const keptEnded90 = await subscriber("deleted", { endedAt: ago(90) });
    const keptDeletedNoEnd = await subscriber("deleted");
    const keptActive = await subscriber("active");
    const keptDisabled = await subscriber("disabled");
    const goneUnused = await link("request", { createdAt: ago(11) });
    const keptUsed = await link("request", { createdAt: ago(11), usedAt: ago(10.5) });
    const keptRecent = await link("request", { createdAt: ago(9) });
    const goneSend = await link("send", { createdAt: ago(12), expiresAt: ago(11) });
    const keptSend = await link("send", { createdAt: ago(10), expiresAt: ago(9) });

    const preview = await previewPurge(tdb.db, now);
    expect(preview).toEqual({ pendingSubscribers: 1, endedSubscribers: 1, unusedLinks: 1, expiredSendLinks: 1 });

    const run = await purgeBatch(tdb.db, { enabled: true, deadline: Infinity, now });
    expect(run).toEqual({ counts: preview, finished: true });
    expect(await previewPurge(tdb.db, now)).toEqual({ pendingSubscribers: 0, endedSubscribers: 0, unusedLinks: 0, expiredSendLinks: 0 });

    for (const id of [goneUnconfirmed, goneEnded]) expect(await exists(id)).toBe(false);
    for (const id of [keptUnconfirmed9, keptUnconfirmed10, keptEnded89, keptEnded90, keptDeletedNoEnd, keptActive, keptDisabled]) expect(await exists(id)).toBe(true);
    for (const id of [goneUnused, goneSend]) expect(await linkExists(id)).toBe(false);
    for (const id of [keptUsed, keptRecent, keptSend]) expect(await linkExists(id)).toBe(true);
  });

  it("while off, only expired send links are cleared", async () => {
    const ended = await subscriber("deleted", { endedAt: ago(200) });
    const unused = await link("request", { createdAt: ago(30) });
    await link("send", { createdAt: ago(30), expiresAt: ago(29) });
    const run = await purgeBatch(tdb.db, { enabled: false, deadline: Infinity, now });
    expect(run).toEqual({ counts: { pendingSubscribers: 0, endedSubscribers: 0, unusedLinks: 0, expiredSendLinks: 1 }, finished: true });
    expect(await exists(ended)).toBe(true);
    expect(await linkExists(unused)).toBe(true);
  });

  it("a purged subscriber's deliveries, history, subscriptions, links and job places go with them", async () => {
    const id = await subscriber("deleted", { endedAt: ago(120) });
    const [job] = await tdb.db.insert(sendJobs).values({ jobKey: `test:${randomUUID()}` }).returning({ id: sendJobs.id });
    await tdb.db.insert(jobRecipients).values({ jobId: job!.id, subscriberId: id });
    await tdb.db.insert(deliveries).values({ itemKey: "2026FIN0001-000001", subscriberId: id, mode: "as_it_happens" });
    await tdb.db.insert(subscriberHistory).values({ subscriberId: id, actor: "self", action: "unsubscribed" });
    await tdb.db.insert(subscriptions).values({ subscriberId: id, listKey: "ministries:finance" });
    await link("request", { createdAt: ago(130), usedAt: ago(130), subscriberId: id });
    await purgeBatch(tdb.db, { enabled: true, deadline: Infinity, now });
    const left = await tdb.db.execute<{ n: number }>(sql`
      SELECT (SELECT count(*) FROM deliveries WHERE subscriber_id = ${id}) + (SELECT count(*) FROM subscriber_history WHERE subscriber_id = ${id})
           + (SELECT count(*) FROM subscriptions WHERE subscriber_id = ${id}) + (SELECT count(*) FROM subscriber_links WHERE subscriber_id = ${id})
           + (SELECT count(*) FROM job_recipients WHERE subscriber_id = ${id}) AS n`);
    expect(Number(left.rows[0]!.n)).toBe(0);
  });

  it("a purged media-list opt-out is kept as a hash", async () => {
    const id = await subscriber("deleted", { endedAt: ago(100) });
    await tdb.db.insert(subscriberHistory).values({ subscriberId: id, actor: "self", action: "media-list-opted-out", detail: "media-distribution-lists:budget", at: ago(100) });
    await purgeBatch(tdb.db, { enabled: true, deadline: Infinity, now });
    const kept = await tdb.db.select().from(mediaOptOuts);
    expect(kept).toEqual([{ emailHash: expect.stringMatching(/^[0-9a-f]{64}$/), listKey: "media-distribution-lists:budget", optedOutAt: ago(100) }]);
  });

  it("someone who comes back after selection is kept", async () => {
    const id = await subscriber("deleted", { endedAt: ago(100) });
    const [row] = await tdb.db.select({ email: subscribers.email }).from(subscribers).where(eq(subscribers.id, id));
    let locked!: () => void;
    let release!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const released = new Promise<void>((r) => (release = r));
    const holder = tdb.db.transaction(async (tx) => {
      await lockAddress(tx, row!.email);
      locked();
      await released;
      await tx.update(subscribers).set({ status: "active", endedAt: null }).where(eq(subscribers.id, id));
    });
    await isLocked;
    const purge = purgeBatch(tdb.db, { enabled: true, deadline: Infinity, now });
    await waitForLockWaiter(tdb.db);
    release();
    await holder;
    expect((await purge).counts.endedSubscribers).toBe(0);
    expect(await exists(id)).toBe(true);
  });

  it("a backlog runs in bounded calls, each subscriber in its own transaction, and adds up to the preview", async () => {
    for (let i = 0; i < 25; i++) await subscriber("deleted", { endedAt: ago(100 + i) });
    const preview = await previewPurge(tdb.db, now);
    const calls = [];
    for (let i = 0; i < 3; i++) calls.push(await purgeBatch(tdb.db, { enabled: true, deadline: Infinity, maxSubscribers: 10, now }));
    expect(calls.map((c) => [c.counts.endedSubscribers, c.finished])).toEqual([[10, false], [10, false], [5, true]]);
    expect(calls.reduce((t, c) => t + c.counts.endedSubscribers, 0)).toBe(preview.endedSubscribers);
  });

  it("cascades and sweeps read through indexes", async () => {
    await tdb.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const plan = async (q: SQL) => (await tx.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN ${q}`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
      const sel = purgeSelection(now);
      expect(await plan(sql`SELECT 1 FROM job_recipients WHERE subscriber_id = ${randomUUID()}::uuid`)).toContain("job_recipients_subscriber_idx");
      expect(await plan(sql`SELECT 1 FROM subscriber_links WHERE subscriber_id = ${randomUUID()}::uuid`)).toContain("subscriber_links_subscriber_idx");
      expect(await plan(sql`SELECT id FROM subscriber_links WHERE ${sel.expiredSendLinks}`)).toContain("subscriber_links_send_expiry_idx");
      expect(await plan(sql`SELECT id FROM subscriber_links WHERE ${sel.unusedLinks}`)).toContain("subscriber_links_request_unused_idx");
    });
  });

  describe("the nightly run", () => {
    const yesterday0300 = new Date("2026-11-19T10:00:00Z");
    const today0300 = new Date("2026-11-20T10:00:00Z");

    it("not before 03:00 BC; once a night", async () => {
      await tdb.db.update(nodSettings).set({ purgeDoneCutoff: yesterday0300 }).where(eq(nodSettings.id, 1));
      clock = new Date(today0300.getTime() - 60_000);
      expect((await runPurgeIfDue(tdb.db, TZ, { now })).ran).toBe(false);
      clock = today0300;
      expect((await runPurgeIfDue(tdb.db, TZ, { now })).ran).toBe(true);
      clock = new Date(today0300.getTime() + 3_600_000);
      expect((await runPurgeIfDue(tdb.db, TZ, { now })).ran).toBe(false);
    });

    it("an unfinished night continues on the next call, adds up its counts, and logs once at the end", async () => {
      await setPurgeEnabled(tdb.db, true, "Avery Admin");
      for (let i = 0; i < 3; i++) await subscriber("deleted", { endedAt: ago(100) });
      const first = await runPurgeIfDue(tdb.db, TZ, { now, maxSubscribers: 2 });
      expect(first.result).toMatchObject({ cutoff: today0300.toISOString(), finished: false, counts: { endedSubscribers: 2 } });
      const second = await runPurgeIfDue(tdb.db, TZ, { now, maxSubscribers: 2 });
      expect(second.result).toMatchObject({ finished: true, counts: { endedSubscribers: 3 } });
      expect((await runPurgeIfDue(tdb.db, TZ, { now })).ran).toBe(false);
      const log = await tdb.db.select().from(operationsLog).where(eq(operationsLog.action, "purge-ran"));
      expect(log).toHaveLength(1);
      expect(log[0]!.detail).toContain("ended subscribers 3");
      expect(JSON.stringify(log)).not.toContain("@");
    });

    it("enabling logs what it would remove now; a repeat changes nothing", async () => {
      await subscriber("pending", { createdAt: ago(20) });
      expect(await setPurgeEnabled(tdb.db, true, "Avery Admin")).toEqual({ changed: true });
      expect(await setPurgeEnabled(tdb.db, true, "Avery Admin")).toEqual({ changed: false });
      expect(await setPurgeEnabled(tdb.db, false, "Avery Admin")).toEqual({ changed: true });
      const log = await tdb.db.select().from(operationsLog).orderBy(operationsLog.at);
      expect(log.map((l) => l.action)).toEqual(["purge-enabled", "purge-disabled"]);
      expect(log[0]!.detail).toContain("unconfirmed subscribers 1");
    });

    it("status: the switch, the preview, the last run and the next 03:00", async () => {
      await runPurgeIfDue(tdb.db, TZ, { now });
      expect(await getPurgeStatus(tdb.db, TZ, now)).toEqual({
        enabled: false,
        preview: { pendingSubscribers: 0, endedSubscribers: 0, unusedLinks: 0, expiredSendLinks: 0 },
        lastRun: { cutoff: today0300.toISOString(), counts: { pendingSubscribers: 0, endedSubscribers: 0, unusedLinks: 0, expiredSendLinks: 0 }, finished: true, enabled: false },
        nextRunAt: "2026-11-21T10:00:00.000Z",
      });
    });
  });
});
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/purge.test.ts`
Expected: FAIL, "Cannot find module './purge'".

- [ ] **Step 5: Implement `purge.ts`**

```ts
import { randomUUID } from "node:crypto";
import { and, eq, ne, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sqlInterval, sqlNow, type Db, type DbOrTx, type TestClock } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import { dailyCutoff, todaysCutoff } from "./digest";
import { nodSettings, subscriberLinks, subscribers } from "./db/schema";
import { withLockedSubscriber } from "./locks";
import { keepMediaOptOuts } from "./opt-outs";
import { writeOpsLog } from "./settings";

export const PURGE_HOUR = 3;
export const UNCONFIRMED_DAYS = 10;
export const ENDED_DAYS = 90;
export const LINK_DAYS = 10;
export const SUBSCRIBER_BATCH = 100;
export const RUN_BUDGET_MS = 20_000;
export const RUN_MAX_SUBSCRIBERS = 500;
export const PURGE_ACTOR = "Retention purge";
const LINK_BATCH = 5_000;
const LEASE_MS = 5 * 60_000;
const DAY_MS = 24 * 3_600_000;

export interface PurgeCounts {
  pendingSubscribers: number;
  endedSubscribers: number;
  unusedLinks: number;
  expiredSendLinks: number;
}
const NO_COUNTS: PurgeCounts = { pendingSubscribers: 0, endedSubscribers: 0, unusedLinks: 0, expiredSendLinks: 0 };
const addCounts = (a: PurgeCounts, b: PurgeCounts): PurgeCounts => ({
  pendingSubscribers: a.pendingSubscribers + b.pendingSubscribers,
  endedSubscribers: a.endedSubscribers + b.endedSubscribers,
  unusedLinks: a.unusedLinks + b.unusedLinks,
  expiredSendLinks: a.expiredSendLinks + b.expiredSendLinks,
});

export function describeCounts(c: PurgeCounts): string {
  return `unconfirmed subscribers ${c.pendingSubscribers}, ended subscribers ${c.endedSubscribers}, unused links ${c.unusedLinks}, expired send links ${c.expiredSendLinks}`;
}

/**
 * The one definition of what the purge removes. The preview counts with these conditions and
 * the purge deletes with them, so the two can't drift. Durations are rolling, by the database
 * clock (or the test clock), strictly older than the limit:
 * - unconfirmed (pending) subscribers created more than 10 days ago;
 * - ended (deleted) subscribers whose ended_at is more than 90 days ago, with everything that
 *   cascades from them;
 * - request links never used, created more than 10 days ago (unconfirmed signups live here);
 * - send links (the manage link in each sent email) expired more than 10 days ago.
 */
export function purgeSelection(now?: TestClock): Record<keyof PurgeCounts, SQL> {
  const n = sqlNow(now);
  const olderThan = (col: AnyPgColumn, days: number) => sql`${col} < ${n} - ${sqlInterval(days * DAY_MS)}`;
  return {
    pendingSubscribers: sql`${subscribers.status} = 'pending' AND ${olderThan(subscribers.createdAt, UNCONFIRMED_DAYS)}`,
    endedSubscribers: sql`${subscribers.status} = 'deleted' AND ${subscribers.endedAt} IS NOT NULL AND ${olderThan(subscribers.endedAt, ENDED_DAYS)}`,
    unusedLinks: sql`${subscriberLinks.origin} = 'request' AND ${subscriberLinks.usedAt} IS NULL AND ${olderThan(subscriberLinks.createdAt, LINK_DAYS)}`,
    expiredSendLinks: sql`${subscriberLinks.origin} = 'send' AND ${olderThan(subscriberLinks.expiresAt, LINK_DAYS)}`,
  };
}

/** What the purge would remove if it ran now (with the switch on). */
export async function previewPurge(db: DbOrTx, now?: TestClock): Promise<PurgeCounts> {
  const sel = purgeSelection(now);
  const { rows } = await db.execute<PurgeCounts>(sql`
    SELECT (SELECT count(*)::int FROM ${subscribers} WHERE ${sel.pendingSubscribers}) AS "pendingSubscribers",
           (SELECT count(*)::int FROM ${subscribers} WHERE ${sel.endedSubscribers}) AS "endedSubscribers",
           (SELECT count(*)::int FROM ${subscriberLinks} WHERE ${sel.unusedLinks}) AS "unusedLinks",
           (SELECT count(*)::int FROM ${subscriberLinks} WHERE ${sel.expiredSendLinks}) AS "expiredSendLinks"`);
  return rows[0]!;
}

/** One bounded, set-based delete. The condition is repeated outside the subquery so a row that
 * changed after the subquery read it (a link used meanwhile) is re-checked, not deleted. */
async function deleteLinks(db: Db, where: SQL): Promise<number> {
  const res = await db.execute(sql`
    DELETE FROM ${subscriberLinks}
     WHERE ${subscriberLinks.id} IN (SELECT ${subscriberLinks.id} FROM ${subscriberLinks} WHERE ${where} LIMIT ${LINK_BATCH})
       AND ${where}`);
  return res.rowCount ?? 0;
}

/** Deletes one subscriber in its own transaction, under their address lock, only if they still
 * match `where` there. Someone who re-subscribed, or was re-added to a media list, after being
 * selected no longer matches and is kept. Their media opt-outs are kept first, as hashes. */
async function purgeSubscriber(db: Db, id: string, where: SQL): Promise<boolean> {
  return withLockedSubscriber(db, id, null, async (tx, s) => {
    if (!s) return false;
    const still = await tx.execute(sql`SELECT 1 FROM ${subscribers} WHERE ${subscribers.id} = ${id} AND ${where}`);
    if (still.rows.length === 0) return false;
    await keepMediaOptOuts(tx, s);
    await tx.delete(subscribers).where(eq(subscribers.id, id));
    return true;
  });
}

export interface PurgeBatchOptions {
  /** The switch. Off: only expired send links are cleared. */
  enabled: boolean;
  /** Date.now() past which the call stops and reports itself unfinished. */
  deadline: number;
  /** At most this many subscribers per call. */
  maxSubscribers?: number;
  batchSize?: number;
  now?: TestClock;
}

/**
 * One bounded pass. Links go set-based, 5,000 per statement; subscribers one per transaction.
 * `finished` is false when the time or subscriber budget ran out with work left, so the
 * nightly run carries on next tick. A subscriber whose delete fails is logged by label and
 * left for the next night, never retried in a loop.
 */
export async function purgeBatch(db: Db, opts: PurgeBatchOptions): Promise<{ counts: PurgeCounts; finished: boolean }> {
  const sel = purgeSelection(opts.now);
  const counts = { ...NO_COUNTS };
  const batchSize = opts.batchSize ?? SUBSCRIBER_BATCH;
  const maxSubscribers = opts.maxSubscribers ?? Infinity;
  const outOfTime = () => Date.now() >= opts.deadline;
  const unfinished = () => ({ counts, finished: false });

  const sweep = async (kind: "expiredSendLinks" | "unusedLinks"): Promise<boolean> => {
    for (;;) {
      const deleted = await deleteLinks(db, sel[kind]);
      counts[kind] += deleted;
      if (deleted < LINK_BATCH) return true;
      if (outOfTime()) return false;
    }
  };

  if (!(await sweep("expiredSendLinks"))) return unfinished();
  if (!opts.enabled) return { counts, finished: true };
  if (!(await sweep("unusedLinks"))) return unfinished();

  let purged = 0;
  for (const kind of ["pendingSubscribers", "endedSubscribers"] as const) {
    const passedOver: string[] = [];
    for (;;) {
      if (outOfTime() || purged >= maxSubscribers) return unfinished();
      const { rows } = await db.execute<{ id: string }>(sql`
        SELECT ${subscribers.id} AS id FROM ${subscribers}
         WHERE ${sel[kind]} AND NOT (${subscribers.id} = ANY(${sql.param(passedOver)}::uuid[]))
         ORDER BY ${subscribers.id} LIMIT ${batchSize}`);
      for (const { id } of rows) {
        if (outOfTime() || purged >= maxSubscribers) return unfinished();
        try {
          if (await purgeSubscriber(db, id, sel[kind])) {
            counts[kind] += 1;
            purged += 1;
          } else passedOver.push(id);
        } catch (e) {
          passedOver.push(id);
          console.error(`[nod] purge skipped one subscriber: ${safeErrorLabel(e)}`);
        }
      }
      if (rows.length < batchSize) break;
    }
  }
  return { counts, finished: true };
}

export interface PurgeRunResult {
  /** The night's 03:00 BC cutoff. */
  cutoff: string;
  counts: PurgeCounts;
  finished: boolean;
  enabled: boolean;
}

type Claim =
  | { kind: "not-due" | "busy" }
  | { kind: "claimed"; lease: string; cutoff: Date; enabled: boolean; prior: PurgeRunResult | null };

/** Claims tonight's run in one short transaction (nod_settings FOR UPDATE), never across the
 * work itself. Due when tonight's 03:00 has passed and isn't done; a missed night catches up. */
async function claim(db: Db, timeZone: string, now?: TestClock): Promise<Claim> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ now: string }>(sql`SELECT ${sqlNow(now)} AS now`);
    const dbNow = new Date(rows[0]!.now);
    const cutoff = dailyCutoff(dbNow, timeZone, PURGE_HOUR);
    const [s] = await tx
      .select({ done: nodSettings.purgeDoneCutoff, leaseUntil: nodSettings.purgeLeaseUntil, enabled: nodSettings.purgeEnabled, result: nodSettings.purgeResult })
      .from(nodSettings)
      .where(eq(nodSettings.id, 1))
      .for("update");
    if (!s || (s.done && s.done.getTime() >= cutoff.getTime())) return { kind: "not-due" };
    if (s.leaseUntil && s.leaseUntil.getTime() > dbNow.getTime()) return { kind: "busy" };
    const lease = randomUUID();
    await tx.update(nodSettings).set({ purgeLease: lease, purgeLeaseUntil: new Date(dbNow.getTime() + LEASE_MS) }).where(eq(nodSettings.id, 1));
    const last = s.result as PurgeRunResult | null;
    return { kind: "claimed", lease, cutoff, enabled: s.enabled, prior: last?.cutoff === cutoff.toISOString() ? last : null };
  });
}

/**
 * The nightly purge (03:00 BC). Link housekeeping runs every night; subscribers and request
 * links only while the switch is on. A night that runs out of budget is picked up by the next
 * tick and its counts add up. The operations log gets one row when a night that removed
 * anything finishes.
 */
export async function runPurgeIfDue(
  db: Db,
  timeZone: string,
  opts: { now?: TestClock; budgetMs?: number; maxSubscribers?: number } = {},
): Promise<{ ran: boolean; result?: PurgeRunResult }> {
  const c = await claim(db, timeZone, opts.now);
  if (c.kind !== "claimed") return { ran: false };
  let outcome: { counts: PurgeCounts; finished: boolean };
  try {
    outcome = await purgeBatch(db, {
      enabled: c.enabled,
      deadline: Date.now() + (opts.budgetMs ?? RUN_BUDGET_MS),
      maxSubscribers: opts.maxSubscribers ?? RUN_MAX_SUBSCRIBERS,
      now: opts.now,
    });
  } catch (e) {
    await db.update(nodSettings).set({ purgeLease: null, purgeLeaseUntil: null }).where(and(eq(nodSettings.id, 1), eq(nodSettings.purgeLease, c.lease)));
    throw e;
  }
  const result: PurgeRunResult = {
    cutoff: c.cutoff.toISOString(),
    counts: addCounts(c.prior?.counts ?? NO_COUNTS, outcome.counts),
    finished: outcome.finished,
    enabled: c.enabled,
  };
  await db.transaction(async (tx) => {
    const kept = await tx
      .update(nodSettings)
      .set({ purgeResult: result, purgeLease: null, purgeLeaseUntil: null, ...(outcome.finished ? { purgeDoneCutoff: c.cutoff } : {}), updatedAt: sql`now()` })
      .where(and(eq(nodSettings.id, 1), eq(nodSettings.purgeLease, c.lease)))
      .returning({ id: nodSettings.id });
    if (kept.length > 0 && outcome.finished && Object.values(result.counts).some((x) => x > 0)) {
      await writeOpsLog(tx, PURGE_ACTOR, "purge-ran", describeCounts(result.counts));
    }
  });
  return { ran: true, result };
}

/** The Operations switch. Turning it on records what it would remove at that moment. */
export async function setPurgeEnabled(db: Db, enabled: boolean, actor: string): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(nodSettings)
      .set({ purgeEnabled: enabled, updatedAt: sql`now()` })
      .where(and(eq(nodSettings.id, 1), ne(nodSettings.purgeEnabled, enabled)))
      .returning({ id: nodSettings.id });
    if (!row) return { changed: false };
    const detail = enabled ? `would remove now: ${describeCounts(await previewPurge(tx))}` : "";
    await writeOpsLog(tx, actor, enabled ? "purge-enabled" : "purge-disabled", detail);
    return { changed: true };
  });
}

export interface PurgeStatus {
  enabled: boolean;
  preview: PurgeCounts;
  lastRun: PurgeRunResult | null;
  /** The next 03:00 BC after now. */
  nextRunAt: string;
}

export async function getPurgeStatus(db: DbOrTx, timeZone: string, now?: TestClock): Promise<PurgeStatus> {
  const { rows } = await db.execute<{ now: string }>(sql`SELECT ${sqlNow(now)} AS now`);
  const dbNow = new Date(rows[0]!.now);
  const today = todaysCutoff(dbNow, timeZone, PURGE_HOUR);
  const next = today.getTime() > dbNow.getTime() ? today : todaysCutoff(new Date(dbNow.getTime() + DAY_MS), timeZone, PURGE_HOUR);
  const [s] = await db.select({ enabled: nodSettings.purgeEnabled, result: nodSettings.purgeResult }).from(nodSettings).where(eq(nodSettings.id, 1));
  return {
    enabled: s?.enabled ?? false,
    preview: await previewPurge(db, now),
    lastRun: (s?.result as PurgeRunResult | null) ?? null,
    nextRunAt: next.toISOString(),
  };
}
```

In `apps/nod/src/settings.ts`, add `| "purge-enabled" | "purge-disabled" | "purge-ran"` to `OperationsAction`.

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/purge.test.ts apps/nod/src/opt-outs.test.ts`
Expected: PASS (13 tests).

If "someone who comes back after selection is kept" hangs, the test pool has a single connection. `waitForLockWaiter` needs the purge's transaction, the holder's transaction and its own query at once. Check `createTestDatabase`'s pool size, and pass `{ max: 4 }` if it takes one.

- [ ] **Step 6: Wire the worker**

In `apps/nod/src/start.ts`:
- `workers` gains `purge: () => runPurgeIfDue(db, tenant.timeZone),`.
- `startLoops()` gains `stopPurgeLoop = startLoop("purge", () => runPurgeIfDue(db, tenant.timeZone));`, with its `let` and a closer `{ name: "purge loop", … }` before `db pool`.
- `start.test.ts` lists `"purge"` among the workers.

- [ ] **Step 7: Stack tick step**

In `apps/stack/src/stack.ts`, after `nod.bounce-summary` and before `nod.emergency-feed`:

```ts
        // Self-gated to 03:00 BC nightly (purge.ts): expired send links always, subscribers only
        // while the Operations switch is on. Bounded per tick; a big night finishes over several.
        { name: "nod.purge", run: worker(nod, "purge") },
```

In `apps/stack/src/stack.test.ts`, the tick step list becomes:

```ts
        "nod.media-sync",
        "nod.bounce-summary",
        "nod.purge",
        "nod.emergency-feed",
        "nod.digest",
        "nod.send",
```

with 15 `"ok"` values.

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod apps/stack`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/nod apps/stack
git commit -m "feat(nod): nightly retention purge (off by default) with a shared preview, and address-free media opt-outs"
```

---

### Task 4: Operations API for the purge and the feed; kept opt-outs block a silent re-add

Covers spec §8 "Operations: … purge on/off (and next-run preview count)" (deferred from 4g R2), and R14–R15.

**Files:**
- Modify:
  - `apps/nod/src/operations.ts`, `apps/nod/src/operations.test.ts`;
  - `apps/nod/src/http/operations-routes.ts`, `apps/nod/src/http/operations-routes.test.ts`;
  - `apps/nod/src/http/routes.ts` (`SettingsRouteDeps.emergencyFeedUrl`);
  - `apps/nod/src/app.ts` (`AppDeps.emergencyFeedUrl`);
  - `apps/nod/src/start.ts` (passes it);
  - `apps/nod/src/media-members.ts`, `apps/nod/src/media-members.test.ts`.

**Interfaces:**
- Consumes: `getPurgeStatus`, `setPurgeEnabled`, `PurgeStatus` (Task 3); `getEmergencyFeedStatus`, `EmergencyFeedStatus` (Task 2); `suppressedOptOutAt` (Task 3).
- Produces:
  - `OperationsStatus` gains `purge: PurgeStatus` and `emergencyFeed: EmergencyFeedStatus`;
  - `getOperations(db, distribution, opts: { bounceSummaryFallback; timeZone; emergencyFeedUrl })`;
  - `PUT /nod/api/operations/purge {enabled: boolean}` (NoD.Admin) → `{ changed, purge: PurgeStatus }`;
  - `SettingsRouteDeps.emergencyFeedUrl: string | null`.

- [ ] **Step 1: Write the failing tests**

In `apps/nod/src/http/operations-routes.test.ts`:
- `createApp` also gets `timeZone: "America/Vancouver"` and `emergencyFeedUrl: "https://emergency.example.test/feed.xml"`.
- The "reads the whole status" expectation gains:

```ts
      purge: { enabled: false, preview: { pendingSubscribers: 0, endedSubscribers: 0, unusedLinks: 0, expiredSendLinks: 0 }, lastRun: null, nextRunAt: expect.any(String) },
      emergencyFeed: { url: "https://emergency.example.test/feed.xml", checkedAt: null, result: null },
```

- Then add:

```ts
  it("the purge switch: Admin only, a boolean only, logged with the preview, idempotent", async () => {
    expect((await request(app).put("/api/operations/purge").set("authorization", `Bearer ${editor}`).send({ enabled: true })).status).toBe(403);
    expect((await request(app).put("/api/operations/purge").set("authorization", `Bearer ${admin}`).send({ enabled: "yes" })).status).toBe(400);
    const on = await request(app).put("/api/operations/purge").set("authorization", `Bearer ${admin}`).send({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ changed: true, purge: { enabled: true } });
    expect((await request(app).put("/api/operations/purge").set("authorization", `Bearer ${admin}`).send({ enabled: true })).body.changed).toBe(false);
    const log = await tdb.db.select().from(operationsLog).where(eq(operationsLog.action, "purge-enabled"));
    expect(log).toMatchObject([{ actor: "Avery Admin", detail: expect.stringContaining("would remove now:") }]);
    await request(app).put("/api/operations/purge").set("authorization", `Bearer ${admin}`).send({ enabled: false });
  });
```

Add any imports it needs: `eq` from drizzle-orm, `operationsLog` from the schema.

In `apps/nod/src/operations.test.ts`, change both `getOperations(...)` calls to the options form, for example `getOperations(tdb.db, distribution, { bounceSummaryFallback: "server@example.test", timeZone: "America/Vancouver", emergencyFeedUrl: null })`. The "Distribution down" `toEqual` gains:

```ts
      purge: expect.objectContaining({ enabled: false }),
      emergencyFeed: { url: null, checkedAt: null, result: null },
```

In `apps/nod/src/media-members.test.ts`, import `mediaOptOuts` and `optOutHash`, add `DELETE FROM media_opt_outs;` to the `beforeEach` SQL, then add:

```ts
  it("an address whose earlier record was purged after opting out needs confirmation to come back", async () => {
    await tdb.db.insert(mediaOptOuts).values({ emailHash: optOutHash("Purged@Example.test"), listKey: "media-distribution-lists:budget", optedOutAt: new Date("2026-06-01T17:00:00Z") });
    const err = await addMediaMember(tdb.db, "budget", { email: "purged@example.test", source: "manual-media" }, ACTOR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OptedOutError);
    expect((err as OptedOutError).at).toEqual(new Date("2026-06-01T17:00:00Z"));
    expect(await tdb.db.select().from(subscribers).where(eq(subscribers.email, "purged@example.test"))).toEqual([]);
    expect((await addMediaMember(tdb.db, "budget", { email: "purged@example.test", source: "manual-media", confirmOptOut: true }, ACTOR)).created).toBe(true);
  });

  it("a kept opt-out from another list doesn't block this one", async () => {
    await tdb.db.insert(mediaOptOuts).values({ emailHash: optOutHash("other@example.test"), listKey: "media-distribution-lists:transport", optedOutAt: new Date("2026-06-01T17:00:00Z") });
    expect((await addMediaMember(tdb.db, "budget", { email: "other@example.test", source: "manual-media" }, ACTOR)).created).toBe(true);
  });
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/http/operations-routes.test.ts apps/nod/src/operations.test.ts apps/nod/src/media-members.test.ts`
Expected: FAIL. The route is missing, the status has no `purge` or `emergencyFeed`, and the re-add isn't blocked.

- [ ] **Step 2: Implement**

`apps/nod/src/operations.ts`:

```ts
import type { Db } from "@gcpe/db-kit";
import type { DistributionClient } from "./distribution-client";
import { getEmergencyFeedStatus, type EmergencyFeedStatus } from "./emergency/ingest";
import { getPurgeStatus, type PurgeStatus } from "./purge";
import { getSettings, getSoftCodesCounted, resolveBounceSummaryAddress, type BounceSummaryAddress } from "./settings";
import { safeErrorLabel } from "./subscribe/journeys";

/** Everything the staff Operations screen shows (spec §8), in one read. */
export interface OperationsStatus {
  nod: { paused: boolean; lastDigestCutoff: string | null };
  /** Null when Distribution didn't answer: the screen says so, and NoD's own controls still work. */
  distribution: { paused: boolean } | null;
  bounceSource: "fake" | "graph" | null;
  bounceSummary: BounceSummaryAddress;
  softCodesCounted: string[];
  purge: PurgeStatus;
  emergencyFeed: EmergencyFeedStatus;
}

export interface OperationsOptions {
  bounceSummaryFallback: string | null;
  timeZone: string;
  emergencyFeedUrl: string | null;
}

export async function getOperations(
  db: Db,
  distribution: Pick<DistributionClient, "getSettings" | "bounceSource">,
  opts: OperationsOptions,
): Promise<OperationsStatus> {
  const [nod, bounceSummary, dist, bounceSource, softCodesCounted, purge, emergencyFeed] = await Promise.all([
    getSettings(db),
    resolveBounceSummaryAddress(db, opts.bounceSummaryFallback),
    distribution.getSettings().then(
      (s) => ({ paused: s.paused }),
      (e: unknown) => {
        console.error("[nod] operations: Distribution settings unavailable", safeErrorLabel(e));
        return null;
      },
    ),
    distribution.bounceSource().then(
      (s) => s.source,
      (e: unknown) => {
        console.error("[nod] operations: bounce source unavailable", safeErrorLabel(e));
        return null;
      },
    ),
    getSoftCodesCounted(db),
    getPurgeStatus(db, opts.timeZone),
    getEmergencyFeedStatus(db, opts.emergencyFeedUrl),
  ]);
  return { nod, distribution: dist, bounceSource, bounceSummary, softCodesCounted, purge, emergencyFeed };
}
```

In `apps/nod/src/http/operations-routes.ts`:
- The GET calls `getOperations(db, deps.distribution, { bounceSummaryFallback: deps.bounceSummaryFallback, timeZone: deps.timeZone, emergencyFeedUrl: deps.emergencyFeedUrl })`.
- Add the route:

```ts
const purgeBody = z.object({ enabled: z.boolean() });
```

```ts
  // The retention purge switch (spec §9, Q25). Turning it on is logged with what it would
  // remove at that moment; the nightly run then deletes for good.
  r.put("/operations/purge", admin, privateErrors(async (req, res) => {
    const { enabled } = purgeBody.parse(req.body);
    const { changed } = await setPurgeEnabled(db, enabled, actorOf(req).name);
    res.json({ changed, purge: await getPurgeStatus(db, deps.timeZone) });
  }));
```

Import `getPurgeStatus` and `setPurgeEnabled` from `../purge`.

In `apps/nod/src/http/routes.ts`, `SettingsRouteDeps` gains:

```ts
  /** EMERGENCY_FEED_URL, shown on Operations; null = no feed configured. */
  emergencyFeedUrl: string | null;
```

In `apps/nod/src/app.ts`:
- `AppDeps` gains `/** EMERGENCY_FEED_URL, for Operations. */ emergencyFeedUrl?: string | null;`.
- The settings object passed to `apiRoutes` gains `emergencyFeedUrl: deps.emergencyFeedUrl ?? null,`.

In `apps/nod/src/start.ts`, `createApp({ … })` gains `emergencyFeedUrl: parsed.EMERGENCY_FEED_URL ?? null,`.

In `apps/nod/src/media-members.ts` `addMediaMember`, in the `else` branch (no existing row), before the insert:

```ts
      // A record purged after its owner opted out of this list is gone, but the opt-out was
      // kept (opt-outs.ts): the same confirmation as for a subscriber who still exists.
      if (!input.confirmOptOut) {
        const keptAt = await suppressedOptOutAt(tx, email, key);
        if (keptAt) throw new OptedOutError(keptAt);
      }
```

Import `suppressedOptOutAt` from `./opt-outs`. Update the function's doc comment: "A new address with a kept opt-out for this list (a purged record) needs `confirmOptOut: true` too."

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod`
Expected: PASS. Any other `toEqual` on the operations status shape now needs `purge` and `emergencyFeed`. Update those expectations in place, never the code.

- [ ] **Step 3: Type-check and commit**

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

```bash
git add apps/nod
git commit -m "feat(nod): Operations reads and switches the purge and shows the emergency feed; kept opt-outs need confirmation"
```

---
### Task 5: staff-web Operations: the purge switch and preview, and the feed's status

Covers spec §8 "Operations: … purge on/off (and next-run preview count)", NoD.Admin only (4g R2). Also shows what Task 2 recorded about the feed, so operators can see a broken feed without logs.

**Files:**
- Modify:
  - `apps/staff-web/src/screens/subscribers/types.ts`;
  - `apps/staff-web/src/screens/subscribers/OperationsScreen.tsx`, `OperationsScreen.test.tsx`;
  - `apps/staff-web/src/screens/subscribers/a11y.test.tsx` (`OPS` fixture, one new test).

**Interfaces:**
- Consumes: `GET /nod/api/operations` (`purge`, `emergencyFeed`) and `PUT /nod/api/operations/purge` (Task 4).
- Produces: the `PurgeCounts`, `PurgeRunResult`, `PurgeStatus`, `EmergencyFeedResult` and `EmergencyFeedStatus` types (same field names as NoD's); `OperationsStatus.purge` and `.emergencyFeed`.

- [ ] **Step 1: Types**

In `types.ts`, add:

```ts
export interface PurgeCounts {
  pendingSubscribers: number;
  endedSubscribers: number;
  unusedLinks: number;
  expiredSendLinks: number;
}
export interface PurgeRunResult {
  cutoff: string;
  counts: PurgeCounts;
  finished: boolean;
  enabled: boolean;
}
export interface PurgeStatus {
  enabled: boolean;
  preview: PurgeCounts;
  lastRun: PurgeRunResult | null;
  nextRunAt: string;
}
export interface EmergencyFeedResult {
  at: string;
  ok: boolean;
  seeded: boolean;
  inFeed: number;
  created: number;
  updated: number;
  skipped: number;
  error: string | null;
}
export interface EmergencyFeedStatus {
  url: string | null;
  checkedAt: string | null;
  result: EmergencyFeedResult | null;
}
```

Then add `purge: PurgeStatus;` and `emergencyFeed: EmergencyFeedStatus;` to `OperationsStatus`.

- [ ] **Step 2: Write the failing screen tests**

In `OperationsScreen.test.tsx`, extend `OPS`:

```ts
  purge: {
    enabled: false,
    preview: { pendingSubscribers: 0, endedSubscribers: 3, unusedLinks: 2, expiredSendLinks: 40 },
    lastRun: null,
    nextRunAt: "2026-10-08T10:00:00.000Z",
  },
  emergencyFeed: {
    url: "https://emergency.example.test/feed.xml",
    checkedAt: "2026-10-07T18:00:00.000Z",
    result: { at: "2026-10-07T18:00:00.000Z", ok: true, seeded: false, inFeed: 2, created: 1, updated: 0, skipped: 0, error: null },
  },
```

`stub`'s options gain `purge?: () => Response`, with the route:

```ts
    if (url === "/nod/api/operations/purge") return opts.purge?.() ?? jsonResponse(200, { changed: true, purge: { ...ops.purge, enabled: true } });
```

Add the tests:

```ts
  it("the purge: off, what it would delete if it ran now, and the link cleanup that always runs", async () => {
    stub(["NoD.Admin"]);
    renderIt();
    const purge = await screen.findByRole("region", { name: "Retention purge" });
    expect(within(purge).getByText("Off")).toBeInTheDocument();
    expect(purge).toHaveTextContent("0 unconfirmed subscribers");
    expect(purge).toHaveTextContent("3 ended subscribers");
    expect(purge).toHaveTextContent("2 unused links");
    expect(purge).toHaveTextContent("(40 waiting)");
  });

  it("turning the purge on asks first, says it can't be undone, then saves and reloads", async () => {
    const calls = stub(["NoD.Admin"]);
    renderIt();
    const user = userEvent.setup();
    const purge = await screen.findByRole("region", { name: "Retention purge" });
    await user.click(within(purge).getByRole("button", { name: "Turn on the retention purge" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("3 subscribers and 2 unused links");
    expect(dialog).toHaveTextContent("can’t be undone");
    await user.click(within(dialog).getByRole("button", { name: "Turn on purge" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/operations/purge", method: "PUT", body: { enabled: true } }));
    await waitFor(() => expect(screen.getAllByRole("status").filter((s) => s.textContent === "Retention purge turned on.")).toHaveLength(1));
    expect(calls.filter((c) => c.url === "/nod/api/operations").length).toBeGreaterThanOrEqual(2);
  });

  it("a failed switch keeps the dialog open with the error inside it", async () => {
    stub(["NoD.Admin"], OPS, { purge: () => jsonResponse(500, { error: "internal" }) });
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Turn on the retention purge" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Turn on purge" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn’t change it. Nothing changed.");
  });

  it("an on purge offers to turn it off, and shows its last night", async () => {
    stub(["NoD.Admin"], {
      ...OPS,
      purge: {
        ...OPS.purge,
        enabled: true,
        lastRun: { cutoff: "2026-10-07T10:00:00.000Z", counts: { pendingSubscribers: 1, endedSubscribers: 4, unusedLinks: 2, expiredSendLinks: 300 }, finished: true, enabled: true },
      },
    });
    renderIt();
    const purge = await screen.findByRole("region", { name: "Retention purge" });
    expect(within(purge).getByText("On")).toBeInTheDocument();
    expect(purge).toHaveTextContent("finished; deleted 5 subscribers and 302 links");
    expect(within(purge).getByRole("button", { name: "Turn off the retention purge" })).toBeInTheDocument();
  });

  it("the emergency feed: the last check's counts", async () => {
    stub(["NoD.Admin"]);
    renderIt();
    const feed = await screen.findByRole("region", { name: "Emergency alerts feed" });
    expect(feed).toHaveTextContent("https://emergency.example.test/feed.xml");
    expect(feed).toHaveTextContent("2 alerts in the feed, 1 new, 0 updated");
  });

  it("the emergency feed: a failed check is a warning with its label", async () => {
    stub(["NoD.Admin"], { ...OPS, emergencyFeed: { ...OPS.emergencyFeed, result: { ...OPS.emergencyFeed.result!, ok: false, error: "http-503" } } });
    renderIt();
    const feed = await screen.findByRole("region", { name: "Emergency alerts feed" });
    expect(await within(feed).findByText(/failed: http-503\. It tries again every 5 minutes\./)).toBeInTheDocument();
  });

  it("the emergency feed: none configured says so", async () => {
    stub(["NoD.Admin"], { ...OPS, emergencyFeed: { url: null, checkedAt: null, result: null } });
    renderIt();
    expect(await screen.findByText("No feed is configured (EMERGENCY_FEED_URL), so no emergency alerts are read.")).toBeInTheDocument();
  });
```

In `a11y.test.tsx`, give its `OPS` fixture the same `purge` and `emergencyFeed` values. Make sure `stubCommon` answers `/nod/api/operations` with that `OPS`. Then add:

```ts
  it("Operations, with the purge dialog open, has no serious violations", async () => {
    stubCommon(["NoD.Admin"]);
    const { container } = render(withAuthAt("/subscribers/operations", "/subscribers/operations", <OperationsScreen />));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Turn on the retention purge" }));
    await screen.findByRole("alertdialog");
    // jsdom has no `inert` (see the bulk delete dialog's note above).
    const noInert = { rules: { "aria-hidden-focus": { enabled: false } } };
    expect(await seriousViolations(document.body, noInert)).toEqual([]);
    expect(await seriousViolations(container, noInert)).toEqual([]);
  });
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/subscribers/OperationsScreen.test.tsx apps/staff-web/src/screens/subscribers/a11y.test.tsx`
Expected: FAIL: no "Retention purge" region, and `OperationsStatus` type errors in the fixtures.

- [ ] **Step 3: Implement the two sections**

In `OperationsScreen.tsx`:
- Import the types `EmergencyFeedStatus` and `PurgeStatus`.
- In `OperationsPanels`, render `<EmergencyFeedPanel feed={ops.emergencyFeed} timeZone={timeZone} />` after the Distribution block.
- Render `<PurgeControl purge={ops.purge} timeZone={timeZone} onDone={done} />` after `<SoftCodesForm …/>`.
- Add:

```tsx
const count = (n: number): string => n.toLocaleString("en-CA");
const plural = (n: number, one: string, many = `${one}s`): string => `${count(n)} ${n === 1 ? one : many}`;

/** Spec §9: built, off by default (Q25). Admins see what it would delete before turning it on. */
function PurgeControl({ purge, timeZone, onDone }: { purge: PurgeStatus; timeZone: string; onDone(text: string): void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = purge.preview;
  const turningOn = !purge.enabled;
  const last = purge.lastRun;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/nod/api/operations/purge", { method: "PUT", body: { enabled: turningOn } });
      setOpen(false);
      onDone(turningOn ? "Retention purge turned on." : "Retention purge turned off.");
    } catch {
      setError("Couldn’t change it. Nothing changed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="ops-purge">
      <h2 id="ops-purge">Retention purge</h2>
      <p>{purge.enabled ? "On" : "Off"}</p>
      <p>
        When on, every night at 3:00 it permanently deletes unconfirmed signups and unused links older than 10 days, and subscribers who unsubscribed
        or were deleted more than 90 days ago, with their history and delivery records. Media-list opt-outs are kept, without the address.
      </p>
      <p>If it ran now, it would delete:</p>
      <ul>
        <li>{plural(p.pendingSubscribers, "unconfirmed subscriber")}</li>
        <li>{plural(p.endedSubscribers, "ended subscriber")}</li>
        <li>{plural(p.unusedLinks, "unused link")}</li>
      </ul>
      <p>{`Expired links in sent emails are cleared every night, on or off (${count(p.expiredSendLinks)} waiting).`}</p>
      <p>{`Next run: ${formatWhen(purge.nextRunAt, new Date(), timeZone)}.`}</p>
      {last && (
        <p>
          {`Last run (${formatWhen(last.cutoff, new Date(), timeZone)}): ${last.finished ? "finished" : "still going"}; deleted ` +
            `${plural(last.counts.pendingSubscribers + last.counts.endedSubscribers, "subscriber")} and ${plural(last.counts.unusedLinks + last.counts.expiredSendLinks, "link")}.`}
        </p>
      )}
      <DialogTrigger
        isOpen={open}
        onOpenChange={(o) => {
          setError(null);
          setOpen(o);
        }}
      >
        <Button variant="secondary" danger={turningOn}>
          {turningOn ? "Turn on the retention purge" : "Turn off the retention purge"}
        </Button>
        <Modal isDismissable>
          <AlertDialog
            role="alertdialog"
            variant="warning"
            title={turningOn ? "Turn on the retention purge?" : "Turn off the retention purge?"}
            buttons={
              <>
                <Button onPress={() => setOpen(false)} isDisabled={busy}>
                  Cancel
                </Button>
                <Button danger={turningOn} onPress={() => void run()} isDisabled={busy}>
                  {turningOn ? "Turn on purge" : "Turn off purge"}
                </Button>
              </>
            }
          >
            <p>
              {turningOn
                ? `At the next 3:00 run it deletes ${plural(p.pendingSubscribers + p.endedSubscribers, "subscriber")} and ${plural(p.unusedLinks, "unused link")} for good, and keeps doing so every night. This can’t be undone.`
                : "Nothing more is deleted. Expired links in sent emails are still cleared every night."}
            </p>
            {error && <InlineAlert variant="danger" role="alert" description={error} />}
          </AlertDialog>
        </Modal>
      </DialogTrigger>
    </section>
  );
}

/** Read-only: the emergency feed's last check (spec §9). */
function EmergencyFeedPanel({ feed, timeZone }: { feed: EmergencyFeedStatus; timeZone: string }): React.JSX.Element {
  const r = feed.result;
  return (
    <section aria-labelledby="ops-emergency-feed">
      <h2 id="ops-emergency-feed">Emergency alerts feed</h2>
      {feed.url === null ? (
        <p>No feed is configured (EMERGENCY_FEED_URL), so no emergency alerts are read.</p>
      ) : (
        <>
          <p>{`Read every 5 minutes from ${feed.url}. New alerts go to everyone on the Emergency Info BC list.`}</p>
          {!r ? (
            <p>Not checked yet.</p>
          ) : r.ok ? (
            <p>
              {`Last checked ${formatWhen(r.at, new Date(), timeZone)}: ${plural(r.inFeed, "alert")} in the feed, ${count(r.created)} new, ${count(r.updated)} updated.` +
                (r.seeded ? " This was the first read of this feed, so its alerts were recorded without emailing anyone." : "")}
            </p>
          ) : (
            <InlineAlert variant="warning" description={`The last check (${formatWhen(r.at, new Date(), timeZone)}) failed: ${r.error ?? "unknown error"}. It tries again every 5 minutes.`} />
          )}
        </>
      )}
    </section>
  );
}
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/subscribers`
Expected: PASS, the existing Operations tests included.

- [ ] **Step 4: Type-check and commit**

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`
Expected: no errors.

```bash
git add apps/staff-web
git commit -m "feat(staff-web): Operations shows and switches the retention purge, and the emergency feed's last check"
```

---
### Task 6: Importer foundations: legacy queries, pure mapping, the report

Covers spec §9's importer mapping rules (statuses from `IsEnabled`/`IsDeleted`, media members as `manual-media`, a report like the NRMS importer's), and R16–R18 and R21 as pure, unit-tested functions.

**Files:**
- Create, each with a test beside it:
  - `apps/nod/src/import/queries.ts` (+ `queries.test.ts`);
  - `apps/nod/src/import/map.ts` (+ `map.test.ts`);
  - `apps/nod/src/import/report.ts` (+ `report.test.ts`).
- Modify: `apps/nod/package.json` dependencies gain `"@gcpe/legacy-import": "0.0.0"`, `"@gcpe/nrms-contract": "0.0.0"`, `"pg": "^8.16.3"`; devDependencies gain `"@types/pg": "^8.23.1"`. These are the versions NRMS uses. Run `npx -y -p node@24 -- npm install`.

**Interfaces:**
- Produces, in `queries.ts`:
  - `Q_LISTS`, `Q_SUBSCRIBERS`, `Q_SUBSCRIBER_LISTS`, `Q_ENDED`, `Q_MEDIA_LIST_LEAVES`, `Q_UNCONFIRMED_SIGNUPS`, `Q_DIGEST_END`;
  - `MAX_SINCE_DAYS = 92`;
  - `qArticles(sinceDays)`, `qArticleLists(sinceDays)`, `qSubscriberArticles(articleGuid)`;
  - `ALL_QUERIES` (for the privacy test).
- Produces, in `map.ts`:
  - `ALL_NEWS_KEY = "*"`, `MEDIA_CATEGORY_KEY`, `EMERGENCY_CATEGORY_KEY`;
  - `guidKey(g)`;
  - `LegacyListRow`, `NodListRow`, `MappedList { listKey; media }`, `ListMapping { byGuid; skipped; categoryOf }`;
  - `mapLists(legacy, nod)`;
  - `LegacySubscriberRow`;
  - `legacyStatus(s)`;
  - `pickWinners(rows): { winners; duplicates; invalid }`;
  - `SubscriberState`, `fingerprintOf(state)`;
  - `MappedSubscriber { id; state; createdAt; endedAt; fingerprint }`;
  - `mapSubscriber(s, memberships, endedAt, ctx: { timeZone; runAt })`;
  - `deliveryModes(row, subscriber, item): DeliveryMode[]`.
- Produces, in `report.ts`: `NodImportReport` with `count`, `skip`, `note`, `markFailed`, `balanced`, `toJSON`, `toText`; `SkipGroup`; `NodImportReportJSON`.

- [ ] **Step 1: Write the failing tests**

`apps/nod/src/import/queries.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ALL_QUERIES, MAX_SINCE_DAYS, qArticles, qSubscriberArticles } from "./queries";

describe("legacy NoD queries", () => {
  it("every query names itself on its first line (the fake source is keyed by it)", () => {
    for (const q of [...ALL_QUERIES, qArticles(30), qSubscriberArticles("c0000000-0000-4000-8000-000000000001")]) expect(q.split("\n")[0]).toMatch(/^-- name: \S+$/);
  });

  it("no query reads SysLog's EntityData or EventData, or any address column but Subscriber's own", () => {
    for (const q of ALL_QUERIES) {
      expect(q).not.toMatch(/EntityData|EventData|SubscriberInfo/);
      if (!q.startsWith("-- name: subscribers\n")) expect(q).not.toMatch(/EmailAddress/);
    }
  });

  it("the window is a whole number of days, 1 to 92", () => {
    expect(qArticles(30)).toContain("DATEADD(day, -30, SYSDATETIMEOFFSET())");
    for (const bad of [0, MAX_SINCE_DAYS + 1, 1.5, Number.NaN]) expect(() => qArticles(bad)).toThrow(RangeError);
  });

  it("an article id must be a GUID before it reaches SQL text", () => {
    expect(qSubscriberArticles("C0000000-0000-4000-8000-000000000001")).toContain("'c0000000-0000-4000-8000-000000000001'");
    expect(() => qSubscriberArticles("x'; DROP TABLE Subscriber; --")).toThrow(RangeError);
  });
});
```

`apps/nod/src/import/map.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deliveryModes, fingerprintOf, legacyStatus, mapLists, mapSubscriber, pickWinners, type LegacySubscriberRow } from "./map";

const TZ = "America/Vancouver";
const RUN_AT = new Date("2026-11-20T18:00:00Z");
const row = (over: Partial<LegacySubscriberRow>): LegacySubscriberRow => ({
  SubscriberGuid: "B0000000-0000-4000-8000-000000000001",
  RegisteredDateTime: new Date("2017-03-01T09:00:00Z"),
  EmailAddress: "pat@example.test",
  IsSelfSubscription: true,
  IsEnabled: true,
  IsDeleted: false,
  ImmediateDelivery: true,
  DigestDelivery: false,
  ...over,
});

describe("mapLists", () => {
  const nod = [
    { listKey: "ministries:health", category: "ministries", name: "Health" },
    { listKey: "media-distribution-lists:000-0-victoria", category: "media-distribution-lists", name: "000.0 - Victoria" },
    { listKey: "media-distribution-lists:sample-town", category: "media-distribution-lists", name: "001.0 - Sample Town" },
  ];
  const legacy = (guid: string, CategoryKey: string, ListKey: string, over: Partial<{ ListName: string; ListDeleted: boolean; CategoryDeleted: boolean }> = {}) => ({
    ListGuid: guid, CategoryKey, ListKey, ListName: over.ListName ?? ListKey, ListDeleted: over.ListDeleted ?? false, CategoryDeleted: over.CategoryDeleted ?? false,
  });

  it("maps by key case-insensitively, All news to '*', a media list by name when its key differs; skips with reasons", () => {
    const m = mapLists(
      [
        legacy("A1", "all-news", "all-news"),
        legacy("A2", "Ministries", "HEALTH"),
        legacy("A3", "media-distribution-lists", "000-0-victoria"),
        legacy("A4", "media-distribution-lists", "old-key", { ListName: "001.0 - Sample Town" }),
        legacy("A5", "ministries", "finance", { ListDeleted: true }),
        legacy("A6", "services", "bc-jobs"),
        legacy("A7", "emergency", "alerts", { CategoryDeleted: true }),
        legacy("A8", "ministries", "nowhere"),
      ],
      nod,
    );
    expect(Object.fromEntries(m.byGuid)).toEqual({
      a1: { listKey: "*", media: false },
      a2: { listKey: "ministries:health", media: false },
      a3: { listKey: "media-distribution-lists:000-0-victoria", media: true },
      a4: { listKey: "media-distribution-lists:sample-town", media: true },
    });
    expect(Object.fromEntries(m.skipped)).toEqual({
      a5: "list or its category is deleted in legacy",
      a6: 'category "services" is not carried over',
      a7: "list or its category is deleted in legacy",
      a8: "no matching NoD list",
    });
    expect(m.categoryOf.get("a7")).toBe("emergency");
  });
});

describe("subscribers", () => {
  it("status: deleted wins, then enabled; legacy has no pending", () => {
    expect(legacyStatus(row({ IsEnabled: true, IsDeleted: true }))).toBe("deleted");
    expect(legacyStatus(row({ IsEnabled: true }))).toBe("active");
    expect(legacyStatus(row({ IsEnabled: false }))).toBe("disabled");
  });

  it("one record per address: active over disabled over deleted, then the newest; invalid addresses out", () => {
    const { winners, duplicates, invalid } = pickWinners([
      row({ SubscriberGuid: "B1", EmailAddress: " Pat@Example.TEST ", IsDeleted: true, RegisteredDateTime: new Date("2025-01-01T00:00:00Z") }),
      row({ SubscriberGuid: "B2", EmailAddress: "pat@example.test", IsEnabled: false }),
      row({ SubscriberGuid: "B3", EmailAddress: "pat@example.test", RegisteredDateTime: new Date("2015-01-01T00:00:00Z") }),
      row({ SubscriberGuid: "B4", EmailAddress: "pat@example.test", RegisteredDateTime: new Date("2016-01-01T00:00:00Z") }),
      row({ SubscriberGuid: "B5", EmailAddress: "not-an-address" }),
    ]);
    expect(winners.map((w) => w.SubscriberGuid)).toEqual(["B4"]);
    expect(duplicates.sort()).toEqual(["b1", "b2", "b3"]);
    expect(invalid).toEqual(["b5"]);
  });

  it("maps a self subscriber: lowercased address, BC wall clock to an instant, timing as is", () => {
    const m = mapSubscriber(row({ EmailAddress: " Pat@Example.TEST " }), [{ listKey: "ministries:health", media: false }, { listKey: "*", media: false }], null, { timeZone: TZ, runAt: RUN_AT });
    expect(m).toMatchObject({
      id: "b0000000-0000-4000-8000-000000000001",
      state: { email: "pat@example.test", status: "active", asItHappens: true, digest: false, source: "self", listKeys: ["*", "ministries:health"] },
      createdAt: new Date("2017-03-01T17:00:00Z"),
      endedAt: null,
    });
  });

  it("a non-self subscriber on a media list is manual-media; otherwise admin", () => {
    const media = [{ listKey: "media-distribution-lists:000-0-victoria", media: true }];
    expect(mapSubscriber(row({ IsSelfSubscription: false }), media, null, { timeZone: TZ, runAt: RUN_AT }).state.source).toBe("manual-media");
    expect(mapSubscriber(row({ IsSelfSubscription: false }), [], null, { timeZone: TZ, runAt: RUN_AT }).state.source).toBe("admin");
    expect(mapSubscriber(row({ IsSelfSubscription: true }), media, null, { timeZone: TZ, runAt: RUN_AT }).state.source).toBe("self");
  });

  it("a deleted subscriber keeps no lists; ended_at is legacy's date, else the import time", () => {
    const lists = [{ listKey: "ministries:health", media: false }];
    const ended = new Date("2026-05-01T17:00:00Z");
    expect(mapSubscriber(row({ IsDeleted: true }), lists, ended, { timeZone: TZ, runAt: RUN_AT })).toMatchObject({ state: { status: "deleted", listKeys: [] }, endedAt: ended });
    expect(mapSubscriber(row({ IsDeleted: true }), lists, null, { timeZone: TZ, runAt: RUN_AT }).endedAt).toEqual(RUN_AT);
  });

  it("an active subscriber with neither timing is imported as is", () => {
    expect(mapSubscriber(row({ ImmediateDelivery: false, DigestDelivery: false }), [], null, { timeZone: TZ, runAt: RUN_AT }).state).toMatchObject({ status: "active", asItHappens: false, digest: false });
  });

  it("the fingerprint ignores list order and duplicates, and changes with any field", () => {
    const base = { email: "pat@example.test", status: "active" as const, asItHappens: true, digest: false, source: "self" as const, listKeys: ["b", "a"] };
    expect(fingerprintOf(base)).toBe(fingerprintOf({ ...base, listKeys: ["a", "b", "a"] }));
    expect(fingerprintOf(base)).not.toBe(fingerprintOf({ ...base, digest: true }));
  });
});

describe("deliveryModes", () => {
  const sub = { asItHappens: true, digest: false, mediaKeys: new Set(["media-distribution-lists:000-0-victoria"]) };
  const release = { kind: "release" as const, mediaListKeys: [] as string[] };
  const flags = (i: boolean, d: boolean) => ({ ImmediateAttempted: i, DigestAttempted: d });

  it("a release: each attempted mode the subscriber actually takes", () => {
    expect(deliveryModes(flags(true, true), sub, release)).toEqual(["as_it_happens"]);
    expect(deliveryModes(flags(true, true), { ...sub, digest: true }, release)).toEqual(["as_it_happens", "digest"]);
    expect(deliveryModes(flags(true, true), { ...sub, asItHappens: false, digest: false }, release)).toEqual([]);
    expect(deliveryModes(flags(false, false), sub, release)).toEqual([]);
  });
  it("a release on a media list the subscriber is on is a media send", () => {
    expect(deliveryModes(flags(true, false), sub, { kind: "release", mediaListKeys: ["media-distribution-lists:000-0-victoria"] })).toEqual(["media"]);
  });
  it("an emergency alert went to everyone on the list, whatever their timing", () => {
    expect(deliveryModes(flags(false, true), { ...sub, asItHappens: false }, { kind: "emergency", mediaListKeys: [] })).toEqual(["as_it_happens"]);
  });
});
```

`apps/nod/src/import/report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NodImportReport } from "./report";

const G1 = "b0000000-0000-4000-8000-000000000001";
const G2 = "c0000000-0000-4000-8000-000000000002";

describe("NodImportReport", () => {
  it("balances legacy = imported + skipped per table", () => {
    const r = new NodImportReport();
    r.count("Subscriber", "legacy", 3);
    r.count("Subscriber", "imported", 2);
    r.skip("Subscriber", "invalid email address", G1);
    expect(r.balanced()).toBe(true);
    r.count("Subscriber", "legacy");
    expect(r.balanced()).toBe(false);
  });

  it("groups skips by table and reason, with a count and at most 10 sample ids", () => {
    const r = new NodImportReport();
    for (let i = 0; i < 12; i++) r.skip("SubscriberList", "subscriber not imported", `${G1}/${G2}`);
    expect(r.toJSON().skipped).toEqual([{ table: "SubscriberList", reason: "subscriber not imported", count: 12, sample: Array(10).fill(`${G1}/${G2}`) }]);
  });

  it("withholds any id that isn't a GUID, so an address can never land in the report", () => {
    const r = new NodImportReport();
    r.skip("Subscriber", "invalid email address", "someone@example.test");
    const json = JSON.stringify(r.toJSON());
    expect(json).toContain("(id withheld)");
    expect(json).not.toContain("@");
    expect(r.toText()).not.toContain("@");
  });

  it("a failed run is never balanced, and its text says where it stopped", () => {
    const r = new NodImportReport();
    r.note("Sends: articles published in legacy's last 30 days, with their recipients.");
    r.markFailed("articles", "connection reset");
    expect(r.balanced()).toBe(false);
    expect(r.toText()).toMatch(/^NoD import report — NOT BALANCED — failed during articles: connection reset/);
    expect(r.toText()).toContain("Sends: articles published");
  });
});
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/import`
Expected: FAIL (the modules don't exist yet).

- [ ] **Step 2: Implement `queries.ts`**

```ts
/**
 * Read-only queries against legacy Gcpe.NewsOnDemand. Each starts with `-- name: <name>`, which
 * keys the fake source in tests. None reads SysLog.EntityData/EventData or
 * SubscriberLink.SubscriberInfo, which hold addresses. Only the subscribers query reads one,
 * the subscriber's own.
 */

export const Q_LISTS = `-- name: lists
SELECT l.ListGuid, l.[Key] AS ListKey, l.ListName, l.IsDeleted AS ListDeleted,
       c.[Key] AS CategoryKey, c.IsDeleted AS CategoryDeleted
  FROM dbo.List l JOIN dbo.ListCategory c ON c.CategoryGuid = l.CategoryGuid`;

export const Q_SUBSCRIBERS = `-- name: subscribers
SELECT SubscriberGuid, RegisteredDateTime, EmailAddress, IsSelfSubscription, IsEnabled, IsDeleted,
       ImmediateDelivery, DigestDelivery
  FROM dbo.Subscriber`;

export const Q_SUBSCRIBER_LISTS = `-- name: subscriberLists
SELECT SubscriberGuid, ListGuid FROM dbo.SubscriberList`;

/** When each subscriber last unsubscribed (104) or was deleted (8); EntityType 1 = Subscriber. */
export const Q_ENDED = `-- name: ended
SELECT EntityGuid AS SubscriberGuid, MAX(EventDate) AS EndedAt
  FROM dbo.SysLog
 WHERE Action IN ('104', '8') AND EntityType = '1' AND EntityGuid IS NOT NULL
 GROUP BY EntityGuid`;

/** Each subscriber's latest removal from each media list (106 UnsubscribedFromList; EventGuid is the list). */
export const Q_MEDIA_LIST_LEAVES = `-- name: mediaListLeaves
SELECT s.EntityGuid AS SubscriberGuid, s.EventGuid AS ListGuid, MAX(s.EventDate) AS LeftAt
  FROM dbo.SysLog s
  JOIN dbo.List l ON l.ListGuid = s.EventGuid
  JOIN dbo.ListCategory c ON c.CategoryGuid = l.CategoryGuid
 WHERE s.Action = '106' AND s.EntityType = '1' AND c.[Key] = 'media-distribution-lists'
 GROUP BY s.EntityGuid, s.EventGuid`;

/** Signups still waiting for their verification link: counted only, never imported. */
export const Q_UNCONFIRMED_SIGNUPS = `-- name: unconfirmedSignups
SELECT COUNT(*) AS Signups FROM dbo.SubscriberLink
 WHERE SubscriberGuid IS NULL AND SubscribeDate IS NULL AND ExpiryDate > GETDATE()`;

export const Q_DIGEST_END = `-- name: digestEnd
SELECT ConfigValue FROM dbo.SysConfig WHERE ConfigKey = 'DailyDigestEndDateTimeUtc'`;

export const ALL_QUERIES = [Q_LISTS, Q_SUBSCRIBERS, Q_SUBSCRIBER_LISTS, Q_ENDED, Q_MEDIA_LIST_LEAVES, Q_UNCONFIRMED_SIGNUPS, Q_DIGEST_END];

export const MAX_SINCE_DAYS = 92;

function checkDays(sinceDays: number): number {
  if (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > MAX_SINCE_DAYS) throw new RangeError(`--since-days must be a whole number from 1 to ${MAX_SINCE_DAYS}`);
  return sinceDays;
}

export function qArticles(sinceDays: number): string {
  return `-- name: articles
SELECT a.ArticleGuid, a.ArticleSourceID, a.RelativeUri, a.PublishDateTimeUtc, a.IsDeleted,
       (SELECT TOP 1 c.TitleText FROM dbo.ArticleContent c WHERE c.ArticleGuid = a.ArticleGuid
         ORDER BY c.UpdateDateTimeUtc DESC) AS Title
  FROM dbo.Article a
 WHERE a.PublishDateTimeUtc >= DATEADD(day, -${checkDays(sinceDays)}, SYSDATETIMEOFFSET())`;
}

export function qArticleLists(sinceDays: number): string {
  return `-- name: articleLists
SELECT al.ArticleGuid, al.ListGuid
  FROM dbo.ArticleList al JOIN dbo.Article a ON a.ArticleGuid = al.ArticleGuid
 WHERE a.PublishDateTimeUtc >= DATEADD(day, -${checkDays(sinceDays)}, SYSDATETIMEOFFSET())`;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One article's recipients. Per article, so at most ~12,600 rows (Q21's largest send) are held at once. */
export function qSubscriberArticles(articleGuid: string): string {
  const guid = articleGuid.trim().toLowerCase();
  if (!GUID_RE.test(guid)) throw new RangeError("article id must be a GUID");
  return `-- name: subscriberArticles:${guid}
SELECT SubscriberGuid, ImmediateAttempted, DigestAttempted, HardBounced
  FROM dbo.SubscriberArticle WHERE ArticleGuid = '${guid}'`;
}
```

- [ ] **Step 3: Implement `map.ts`**

```ts
import { createHash } from "node:crypto";
import { wallClockToInstant } from "@gcpe/config";
import type { DeliveryMode, SubscriberSource, SubscriberStatus } from "../db/schema";
import { emailAddressSchema, normaliseEmail } from "../subscribe/info";

export const ALL_NEWS_KEY = "*";
export const MEDIA_CATEGORY_KEY = "media-distribution-lists";
export const EMERGENCY_CATEGORY_KEY = "emergency";
const CARRIED_CATEGORIES = new Set(["ministries", "sectors", "themes", "tags", EMERGENCY_CATEGORY_KEY, MEDIA_CATEGORY_KEY]);

/** SQL Server hands GUIDs back upper-case; NoD's uuids and every map here are lower-case. */
export const guidKey = (g: string): string => g.trim().toLowerCase();

export interface LegacyListRow {
  ListGuid: string;
  ListKey: string;
  ListName: string;
  ListDeleted: boolean;
  CategoryKey: string;
  CategoryDeleted: boolean;
}
export interface NodListRow {
  listKey: string;
  category: string;
  name: string;
}
export interface MappedList {
  listKey: string;
  media: boolean;
}
export interface ListMapping {
  /** Legacy ListGuid → the NoD list it is carried to. */
  byGuid: Map<string, MappedList>;
  /** Legacy ListGuid → why it isn't. */
  skipped: Map<string, string>;
  /** Legacy ListGuid → its legacy category, carried or not (articles are classified by it). */
  categoryOf: Map<string, string>;
}

/**
 * Legacy lists → NoD's own `lists` rows (which Core and NRMS already filled). `<category>:<key>`
 * matches case-insensitively; a media list whose key differs (legacy keys were matched to Hub's by
 * hand) matches by its exact name. Deleted lists, categories that never became part of this
 * platform, and anything with no NoD match are skipped by reason.
 */
export function mapLists(legacy: LegacyListRow[], nod: NodListRow[]): ListMapping {
  const byKey = new Map(nod.map((l) => [l.listKey.toLowerCase(), l]));
  const mediaByName = new Map(nod.filter((l) => l.category === MEDIA_CATEGORY_KEY).map((l) => [l.name.trim().toLowerCase(), l]));
  const out: ListMapping = { byGuid: new Map(), skipped: new Map(), categoryOf: new Map() };
  for (const l of legacy) {
    const guid = guidKey(l.ListGuid);
    const category = l.CategoryKey.trim().toLowerCase();
    out.categoryOf.set(guid, category);
    if (l.ListDeleted || l.CategoryDeleted) out.skipped.set(guid, "list or its category is deleted in legacy");
    else if (category === "all-news") out.byGuid.set(guid, { listKey: ALL_NEWS_KEY, media: false });
    else if (!CARRIED_CATEGORIES.has(category)) out.skipped.set(guid, `category "${category}" is not carried over`);
    else {
      const found = byKey.get(`${category}:${l.ListKey.trim().toLowerCase()}`) ?? (category === MEDIA_CATEGORY_KEY ? mediaByName.get(l.ListName.trim().toLowerCase()) : undefined);
      if (found) out.byGuid.set(guid, { listKey: found.listKey, media: category === MEDIA_CATEGORY_KEY });
      else out.skipped.set(guid, "no matching NoD list");
    }
  }
  return out;
}

export interface LegacySubscriberRow {
  SubscriberGuid: string;
  /** Legacy DATETIME: BC wall clock, handed back with its UTC fields holding it. */
  RegisteredDateTime: Date;
  EmailAddress: string;
  IsSelfSubscription: boolean;
  IsEnabled: boolean;
  IsDeleted: boolean;
  ImmediateDelivery: boolean;
  DigestDelivery: boolean;
}

export function legacyStatus(s: Pick<LegacySubscriberRow, "IsEnabled" | "IsDeleted">): SubscriberStatus {
  return s.IsDeleted ? "deleted" : s.IsEnabled ? "active" : "disabled";
}

const RANK: Record<SubscriberStatus, number> = { active: 0, disabled: 1, pending: 2, deleted: 3 };

/** One record per address (legacy's column isn't unique): active over disabled over deleted,
 * then the newest registration. Ids come back lower-case. */
export function pickWinners(rows: LegacySubscriberRow[]): { winners: LegacySubscriberRow[]; duplicates: string[]; invalid: string[] } {
  const invalid: string[] = [];
  const groups = new Map<string, LegacySubscriberRow[]>();
  for (const r of rows) {
    const email = normaliseEmail(r.EmailAddress ?? "");
    if (!emailAddressSchema.safeParse(email).success) {
      invalid.push(guidKey(r.SubscriberGuid));
      continue;
    }
    groups.set(email, [...(groups.get(email) ?? []), r]);
  }
  const winners: LegacySubscriberRow[] = [];
  const duplicates: string[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort(
      (a, b) =>
        RANK[legacyStatus(a)] - RANK[legacyStatus(b)] ||
        b.RegisteredDateTime.getTime() - a.RegisteredDateTime.getTime() ||
        guidKey(a.SubscriberGuid).localeCompare(guidKey(b.SubscriberGuid)),
    );
    winners.push(sorted[0]!);
    for (const d of sorted.slice(1)) duplicates.push(guidKey(d.SubscriberGuid));
  }
  return { winners, duplicates, invalid };
}

export interface SubscriberState {
  email: string;
  status: SubscriberStatus;
  asItHappens: boolean;
  digest: boolean;
  source: SubscriberSource;
  listKeys: string[];
}

/** What the importer wrote, as one hash: a re-run compares it with NoD's current state to tell
 * "untouched since import" from "changed in NoD". */
export function fingerprintOf(s: SubscriberState): string {
  return createHash("sha256")
    .update(JSON.stringify([s.email, s.status, s.asItHappens, s.digest, s.source, [...new Set(s.listKeys)].sort()]))
    .digest("hex");
}

export interface MappedSubscriber {
  id: string;
  state: SubscriberState;
  createdAt: Date;
  endedAt: Date | null;
  fingerprint: string;
}

export function mapSubscriber(s: LegacySubscriberRow, memberships: MappedList[], endedAt: Date | null, ctx: { timeZone: string; runAt: Date }): MappedSubscriber {
  const status = legacyStatus(s);
  const source: SubscriberSource = s.IsSelfSubscription ? "self" : memberships.some((m) => m.media) ? "manual-media" : "admin";
  const state: SubscriberState = {
    email: normaliseEmail(s.EmailAddress),
    status,
    asItHappens: s.ImmediateDelivery,
    digest: s.DigestDelivery,
    source,
    // An unsubscribed or deleted subscriber keeps no lists here, as after any unsubscribe in NoD.
    listKeys: status === "deleted" ? [] : [...new Set(memberships.map((m) => m.listKey))].sort(),
  };
  return {
    id: guidKey(s.SubscriberGuid),
    state,
    createdAt: wallClockToInstant(s.RegisteredDateTime, ctx.timeZone),
    // No SysLog date: the import time, so the purge waits a full 90 days after cutover.
    endedAt: status === "deleted" ? (endedAt ?? ctx.runAt) : null,
    fingerprint: fingerprintOf(state),
  };
}

/**
 * Which NoD deliveries one legacy SubscriberArticle row stands for. Legacy marks a mode the
 * subscriber doesn't take as attempted, to stop it being sent (DistributionProvider.cs:313-320),
 * so a release's modes are checked against the subscriber's own timing. A media-list member got
 * the release as a media send; an emergency alert went to everyone on its list.
 */
export function deliveryModes(
  row: { ImmediateAttempted: boolean; DigestAttempted: boolean },
  sub: { asItHappens: boolean; digest: boolean; mediaKeys: Set<string> },
  item: { kind: "release" | "emergency"; mediaListKeys: string[] },
): DeliveryMode[] {
  if (item.kind === "emergency") return row.ImmediateAttempted || row.DigestAttempted ? ["as_it_happens"] : [];
  if (row.ImmediateAttempted && item.mediaListKeys.some((k) => sub.mediaKeys.has(k))) return ["media"];
  const modes: DeliveryMode[] = [];
  if (row.ImmediateAttempted && sub.asItHappens) modes.push("as_it_happens");
  if (row.DigestAttempted && sub.digest) modes.push("digest");
  return modes;
}
```

- [ ] **Step 4: Implement `report.ts`**

```ts
/**
 * The NoD importer's report, shaped like the NRMS importer's: per legacy table, legacy =
 * imported + skipped. Skipped rows are grouped by reason, with up to 10 sample ids. Ids are
 * legacy GUIDs only. Anything else passed as an id is withheld, so an address can never reach
 * this file. Reasons are fixed text written by the importer, never legacy content.
 */

export type ReportSide = "legacy" | "imported" | "skipped";

interface TableCounts {
  legacy: number;
  imported: number;
  skipped: number;
}

export interface SkipGroup {
  table: string;
  reason: string;
  count: number;
  sample: string[];
}

export interface NodImportReportJSON {
  balanced: boolean;
  tables: Record<string, TableCounts>;
  skipped: SkipGroup[];
  notes: string[];
  failed: { stage: string; message: string } | null;
}

const GUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ID_RE = new RegExp(`^${GUID}(/${GUID})?$`, "i");
const SAMPLE_SIZE = 10;

export class NodImportReport {
  private readonly tables = new Map<string, TableCounts>();
  private readonly skips = new Map<string, SkipGroup>();
  private readonly notes: string[] = [];
  private failed: { stage: string; message: string } | null = null;

  count(table: string, side: ReportSide, n = 1): void {
    const row = this.tables.get(table) ?? { legacy: 0, imported: 0, skipped: 0 };
    row[side] += n;
    this.tables.set(table, row);
  }

  skip(table: string, reason: string, legacyId: string): void {
    this.count(table, "skipped");
    const key = `${table}\u0000${reason}`;
    const group = this.skips.get(key) ?? { table, reason, count: 0, sample: [] };
    group.count += 1;
    if (group.sample.length < SAMPLE_SIZE) group.sample.push(ID_RE.test(legacyId) ? legacyId.toLowerCase() : "(id withheld)");
    this.skips.set(key, group);
  }

  note(text: string): void {
    this.notes.push(text);
  }

  /** `message` must already be redacted and length-capped (run.ts does this). */
  markFailed(stage: string, message: string): void {
    this.failed = { stage, message };
  }

  balanced(): boolean {
    if (this.failed) return false;
    for (const t of this.tables.values()) if (t.legacy !== t.imported + t.skipped) return false;
    return true;
  }

  toJSON(): NodImportReportJSON {
    return {
      balanced: this.balanced(),
      tables: Object.fromEntries([...this.tables.entries()].sort(([a], [b]) => a.localeCompare(b))),
      skipped: [...this.skips.values()].sort((a, b) => a.table.localeCompare(b.table) || b.count - a.count),
      notes: [...this.notes],
      failed: this.failed ? { ...this.failed } : null,
    };
  }

  toText(): string {
    const j = this.toJSON();
    const head = `NoD import report — ${j.balanced ? "balanced" : "NOT BALANCED"}`;
    const lines = [j.failed ? `${head} — failed during ${j.failed.stage}: ${j.failed.message}` : head];
    for (const [table, c] of Object.entries(j.tables)) lines.push(`  ${table}: legacy=${c.legacy} imported=${c.imported} skipped=${c.skipped}`);
    if (j.skipped.length > 0) {
      lines.push("Skipped:");
      for (const s of j.skipped) lines.push(`  [${s.table}] ${s.count} × ${s.reason} (e.g. ${s.sample.slice(0, 3).join(", ")})`);
    }
    if (j.notes.length > 0) {
      lines.push("Notes:");
      for (const n of j.notes) lines.push(`  ${n}`);
    }
    return lines.join("\n");
  }
}
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/import`
Expected: PASS (19 tests).

The `createdAt` case converts 09:00 on 2017-03-01 BC (PST, UTC−8) to 17:00Z. If it comes out at 09:00Z, `wallClockToInstant` was handed a value that isn't a wall clock. Check the argument order against `packages/config/src/timezone.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/nod/package.json package-lock.json apps/nod/src/import
git commit -m "feat(nod): legacy NoD import mapping, queries and report"
```

---

### Task 7: Importer: lists, subscribers, memberships and opt-outs, safely re-runnable

Covers spec §9's importer for `Subscriber`, `SubscriberList` and `List`/`ListCategory`, and R16, R17 and R20.

**Files:**
- Modify:
  - `apps/nod/src/db/schema.ts` (new `legacySubscriberImports`), plus the generated migration `apps/nod/migrations/0029_legacy_import.sql`;
  - `apps/nod/src/subscribe/history.ts` (`HISTORY_ACTIONS` gains `"legacy-imported"`);
  - `apps/staff-web/src/screens/subscribers/labels.ts` (`"legacy-imported": "Imported from legacy News On Demand"`).
- Create:
  - `apps/nod/src/import/lists.ts`;
  - `apps/nod/src/import/subscribers.ts`, `apps/nod/src/import/subscribers.test.ts`;
  - `apps/nod/test/legacy-nod-fixture.ts`.

**Interfaces:**
- Consumes: everything from Task 6; `lockAddress` (`locks.ts`); `writeHistory` (`subscribe/history.ts`); `addMediaMember`, `OptedOutError` (tests).
- Produces:
  - `legacy_subscriber_imports(subscriber_id uuid PK, fingerprint text, imported_at)`. It has **no foreign key**, so a record outlives a purged subscriber and a re-run doesn't recreate them.
  - In `lists.ts`: `importLists(db, source, report): Promise<ListMapping>`; `NodNotReadyError`.
  - In `subscribers.ts`:
    - `IMPORT_ACTOR = "Legacy import"`;
    - `ImportedSubscriber { asItHappens; digest; mediaKeys: Set<string> }`;
    - `importSubscribers(db, source, ctx: { report; timeZone; lists; runAt }): Promise<Map<string, ImportedSubscriber>>`, keyed by lower-case legacy GUID, for records imported, updated or unchanged.
  - In the fixture: `FIXTURE_GUIDS`, `legacyNodTables()`, `legacyNodSource(tables?)`, `seedNodListsForImport(db)`.

- [ ] **Step 1: Schema, history action and label**

In `schema.ts`, after `mediaOptOuts`:

```ts
/**
 * What the legacy importer last wrote for each subscriber (import/subscribers.ts), as a
 * fingerprint. A re-run compares it with NoD's current state: equal means untouched since the
 * import, so legacy's newer data wins; different means someone changed it here, and NoD wins.
 * No foreign key on purpose: a row outlives a purged subscriber, so a re-run doesn't recreate them.
 */
export const legacySubscriberImports = pgTable("legacy_subscriber_imports", {
  subscriberId: uuid("subscriber_id").primaryKey(),
  fingerprint: text("fingerprint").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Run: `cd apps/nod && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name legacy_import`
Expected: `0029_legacy_import.sql` with one `CREATE TABLE`.

Add `"legacy-imported"` to the end of `HISTORY_ACTIONS`, and the matching label in staff-web's `labels.ts`. Then run `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/subscribers/labels.test.ts`. Expected: PASS. It fails only if the two lists disagree.

- [ ] **Step 2: Write the synthetic legacy fixture**

`apps/nod/test/legacy-nod-fixture.ts`. The shape follows `Gcpe.NewsOnDemand.Database/dbo/Tables/*.sql`. Every value is made up, every address is `example.test`, and GUIDs are upper-case as SQL Server returns them.

```ts
import { createFakeSource, type LegacySource } from "@gcpe/legacy-import";
import type { Db } from "@gcpe/db-kit";
import { lists } from "../src/db/schema";

/** Legacy DATETIME columns come back with their UTC fields holding BC wall-clock time. */
const wall = (s: string) => new Date(`${s}Z`);

export const FIXTURE_GUIDS = {
  listAllNews: "A0000000-0000-4000-8000-000000000001",
  listHealth: "A0000000-0000-4000-8000-000000000002",
  listFinanceDeleted: "A0000000-0000-4000-8000-000000000003",
  listVictoria: "A0000000-0000-4000-8000-000000000004",
  listByName: "A0000000-0000-4000-8000-000000000005",
  listServices: "A0000000-0000-4000-8000-000000000006",
  listAlerts: "A0000000-0000-4000-8000-000000000007",
  listUnknown: "A0000000-0000-4000-8000-000000000008",
  subActive: "B0000000-0000-4000-8000-000000000001",
  subDigest: "B0000000-0000-4000-8000-000000000002",
  subDeleted: "B0000000-0000-4000-8000-000000000003",
  subDisabled: "B0000000-0000-4000-8000-000000000004",
  subMedia: "B0000000-0000-4000-8000-000000000005",
  subDuplicate: "B0000000-0000-4000-8000-000000000006",
  subInvalid: "B0000000-0000-4000-8000-000000000007",
  subNoTiming: "B0000000-0000-4000-8000-000000000008",
  subLeftMedia: "B0000000-0000-4000-8000-000000000009",
  artRelease: "C0000000-0000-4000-8000-000000000001",
  artEmergency: "C0000000-0000-4000-8000-000000000002",
  artNewsletter: "C0000000-0000-4000-8000-000000000003",
  artUnresolved: "C0000000-0000-4000-8000-000000000004",
  /** NewsRelease.Id of the release NRMS imported (news_releases.legacy_id). */
  nrmsRelease: "D0000000-0000-4000-8000-000000000001",
} as const;
const G = FIXTURE_GUIDS;

const list = (ListGuid: string, CategoryKey: string, ListKey: string, ListName: string, deleted = false) => ({ ListGuid, CategoryKey, ListKey, ListName, ListDeleted: deleted, CategoryDeleted: false });
const subscriber = (SubscriberGuid: string, EmailAddress: string, o: { self?: boolean; enabled?: boolean; deleted?: boolean; imm?: boolean; dig?: boolean; registered?: string } = {}) => ({
  SubscriberGuid,
  RegisteredDateTime: wall(o.registered ?? "2017-03-01T09:00:00"),
  EmailAddress,
  IsSelfSubscription: o.self ?? true,
  IsEnabled: o.enabled ?? true,
  IsDeleted: o.deleted ?? false,
  ImmediateDelivery: o.imm ?? true,
  DigestDelivery: o.dig ?? false,
});
const sa = (SubscriberGuid: string, imm: boolean, dig: boolean, hard = false) => ({ SubscriberGuid, ImmediateAttempted: imm, DigestAttempted: dig, HardBounced: hard });

export function legacyNodTables(): Record<string, Record<string, unknown>[]> {
  return {
    lists: [
      list(G.listAllNews, "all-news", "all-news", "All News"),
      list(G.listHealth, "ministries", "health", "Health"),
      list(G.listFinanceDeleted, "ministries", "finance", "Finance", true),
      list(G.listVictoria, "media-distribution-lists", "000-0-victoria", "000.0 - Victoria"),
      list(G.listByName, "media-distribution-lists", "old-key", "001.0 - Sample Town"),
      list(G.listServices, "services", "bc-jobs", "Sample programs"),
      { ...list(G.listAlerts, "emergency", "alerts", "Emergency Info BC Alerts", true), CategoryDeleted: true },
      list(G.listUnknown, "ministries", "nowhere", "Nowhere"),
    ],
    subscribers: [
      subscriber(G.subActive, "active@example.test"),
      subscriber(G.subDigest, "digest@example.test", { imm: false, dig: true }),
      subscriber(G.subDeleted, "deleted@example.test", { deleted: true, enabled: false }),
      subscriber(G.subDisabled, "disabled@example.test", { enabled: false }),
      subscriber(G.subMedia, "Journo@Example.test", { self: false }),
      subscriber(G.subDuplicate, " ACTIVE@example.test ", { deleted: true, registered: "2024-01-01T09:00:00" }),
      subscriber(G.subInvalid, "not-an-address"),
      subscriber(G.subNoTiming, "notiming@example.test", { imm: false, dig: false }),
      subscriber(G.subLeftMedia, "left@example.test"),
    ],
    subscriberLists: [
      { SubscriberGuid: G.subActive, ListGuid: G.listAllNews },
      { SubscriberGuid: G.subActive, ListGuid: G.listHealth },
      { SubscriberGuid: G.subActive, ListGuid: G.listFinanceDeleted },
      { SubscriberGuid: G.subActive, ListGuid: G.listServices },
      { SubscriberGuid: G.subDigest, ListGuid: G.listHealth },
      { SubscriberGuid: G.subDeleted, ListGuid: G.listHealth },
      { SubscriberGuid: G.subDisabled, ListGuid: G.listHealth },
      { SubscriberGuid: G.subMedia, ListGuid: G.listVictoria },
      { SubscriberGuid: G.subMedia, ListGuid: G.listByName },
      { SubscriberGuid: G.subDuplicate, ListGuid: G.listHealth },
      { SubscriberGuid: G.subInvalid, ListGuid: G.listHealth },
      { SubscriberGuid: G.subNoTiming, ListGuid: G.listHealth },
      { SubscriberGuid: G.subLeftMedia, ListGuid: G.listHealth },
    ],
    ended: [{ SubscriberGuid: G.subDeleted, EndedAt: wall("2026-05-01T10:00:00") }],
    mediaListLeaves: [
      { SubscriberGuid: G.subLeftMedia, ListGuid: G.listVictoria, LeftAt: wall("2026-04-01T09:00:00") },
      { SubscriberGuid: G.subMedia, ListGuid: G.listVictoria, LeftAt: wall("2025-01-01T09:00:00") },
    ],
    unconfirmedSignups: [{ Signups: 26 }],
    digestEnd: [{ ConfigValue: "2026-10-06T00:02:41.8472105+00:00" }],
    articles: [
      { ArticleGuid: G.artRelease, ArticleSourceID: `uuid:${G.nrmsRelease.toLowerCase()}`, RelativeUri: "news.example.test/1", PublishDateTimeUtc: new Date("2026-10-01T17:00:00Z"), IsDeleted: false, Title: "Sample release" },
      { ArticleGuid: G.artEmergency, ArticleSourceID: "https://emergency.example.test/?p=77", RelativeUri: "https://emergency.example.test/alerts/77", PublishDateTimeUtc: new Date("2026-10-02T17:00:00Z"), IsDeleted: false, Title: "Sample alert" },
      { ArticleGuid: G.artNewsletter, ArticleSourceID: "newsletter-1", RelativeUri: null, PublishDateTimeUtc: new Date("2026-10-03T17:00:00Z"), IsDeleted: false, Title: "Sample newsletter" },
      { ArticleGuid: G.artUnresolved, ArticleSourceID: "uuid:ffffffff-ffff-4fff-8fff-ffffffffffff", RelativeUri: null, PublishDateTimeUtc: new Date("2026-10-04T17:00:00Z"), IsDeleted: false, Title: "Unknown release" },
    ],
    articleLists: [
      { ArticleGuid: G.artRelease, ListGuid: G.listHealth },
      { ArticleGuid: G.artRelease, ListGuid: G.listVictoria },
      { ArticleGuid: G.artEmergency, ListGuid: G.listAlerts },
      { ArticleGuid: G.artNewsletter, ListGuid: G.listServices },
      { ArticleGuid: G.artUnresolved, ListGuid: G.listHealth },
    ],
    [`subscriberArticles:${G.artRelease.toLowerCase()}`]: [
      sa(G.subActive, true, false),
      sa(G.subDigest, true, true),
      sa(G.subMedia, true, false),
      sa(G.subDuplicate, true, false),
      sa(G.subNoTiming, true, true),
      sa(G.subLeftMedia, true, false, true),
    ],
    [`subscriberArticles:${G.artEmergency.toLowerCase()}`]: [sa(G.subDigest, true, true)],
  };
}

export function legacyNodSource(tables: Record<string, Record<string, unknown>[]> = legacyNodTables()): LegacySource {
  return createFakeSource(tables);
}

/** The NoD lists Core and NRMS would already have sent by the time the importer runs. */
export async function seedNodListsForImport(db: Db): Promise<void> {
  await db
    .insert(lists)
    .values([
      { listKey: "ministries:health", category: "ministries", key: "health", name: "Health" },
      { listKey: "media-distribution-lists:000-0-victoria", category: "media-distribution-lists", key: "000-0-victoria", name: "000.0 - Victoria" },
      { listKey: "media-distribution-lists:sample-town", category: "media-distribution-lists", key: "sample-town", name: "001.0 - Sample Town" },
    ])
    .onConflictDoNothing();
}
```

- [ ] **Step 3: Write the failing stage tests**

`apps/nod/src/import/subscribers.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { FIXTURE_GUIDS as G, legacyNodSource, legacyNodTables, seedNodListsForImport } from "../../test/legacy-nod-fixture";
import { subscriberHistory, subscribers, subscriptions } from "../db/schema";
import { addMediaMember, OptedOutError } from "../media-members";
import { importLists, NodNotReadyError } from "./lists";
import { NodImportReport } from "./report";
import { importSubscribers } from "./subscribers";

const TZ = "America/Vancouver";
const RUN_AT = new Date("2026-11-20T18:00:00Z");
const id = (g: string) => g.toLowerCase();

describe("importing legacy subscribers", () => {
  let tdb: TestDatabase;
  async function run(tables = legacyNodTables()) {
    const report = new NodImportReport();
    const source = legacyNodSource(tables);
    const lists = await importLists(tdb.db, source, report);
    const imported = await importSubscribers(tdb.db, source, { report, timeZone: TZ, lists, runAt: RUN_AT });
    return { report, imported };
  }
  const subscriber = async (g: string) => (await tdb.db.select().from(subscribers).where(eq(subscribers.id, id(g))))[0];
  const listsOf = async (g: string) => (await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, id(g)))).map((s) => s.listKey).sort();

  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    await tdb.db.execute(sql`DELETE FROM subscriber_history; DELETE FROM subscriptions; DELETE FROM subscribers; DELETE FROM legacy_subscriber_imports; DELETE FROM lists WHERE category IN ('ministries', 'media-distribution-lists');`);
    await seedNodListsForImport(tdb.db);
  });

  it("refuses to start before Core's lists have reached NoD", async () => {
    await tdb.db.execute(sql`DELETE FROM lists WHERE category = 'ministries'`);
    await expect(importLists(tdb.db, legacyNodSource(), new NodImportReport())).rejects.toBeInstanceOf(NodNotReadyError);
  });

  it("maps statuses, timing, sources, addresses and dates", async () => {
    await run();
    expect(await subscriber(G.subActive)).toMatchObject({ email: "active@example.test", status: "active", asItHappens: true, digest: false, source: "self", createdAt: new Date("2017-03-01T17:00:00Z"), verifiedAt: new Date("2017-03-01T17:00:00Z"), endedAt: null });
    expect(await subscriber(G.subDigest)).toMatchObject({ status: "active", asItHappens: false, digest: true });
    expect(await subscriber(G.subDeleted)).toMatchObject({ status: "deleted", endedAt: new Date("2026-05-01T17:00:00Z") });
    expect(await subscriber(G.subDisabled)).toMatchObject({ status: "disabled" });
    expect(await subscriber(G.subMedia)).toMatchObject({ email: "journo@example.test", source: "manual-media", mediaHubContactId: null });
    expect(await subscriber(G.subNoTiming)).toMatchObject({ status: "active", asItHappens: false, digest: false });
    expect(await subscriber(G.subDuplicate)).toBeUndefined();
    expect(await subscriber(G.subInvalid)).toBeUndefined();
  });

  it("memberships: carried lists only, '*' for All news, none for a deleted subscriber", async () => {
    await run();
    expect(await listsOf(G.subActive)).toEqual(["*", "ministries:health"]);
    expect(await listsOf(G.subMedia)).toEqual(["media-distribution-lists:000-0-victoria", "media-distribution-lists:sample-town"]);
    expect(await listsOf(G.subDeleted)).toEqual([]);
    expect(await listsOf(G.subDisabled)).toEqual(["ministries:health"]);
  });

  it("a legacy media-list leave becomes opt-out history, and staff are asked before re-adding", async () => {
    await run();
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, id(G.subLeftMedia)));
    expect(history.map((h) => [h.action, h.detail, h.actor])).toContainEqual(["media-list-opted-out", "media-distribution-lists:000-0-victoria", "Legacy import"]);
    await expect(addMediaMember(tdb.db, "000-0-victoria", { email: "left@example.test", source: "manual-media" }, "staff:jamie")).rejects.toBeInstanceOf(OptedOutError);
    const journo = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, id(G.subMedia)));
    expect(journo.some((h) => h.action === "media-list-opted-out")).toBe(false);
  });

  it("the report balances, groups skips by reason and holds no address", async () => {
    const { report, imported } = await run();
    const json = report.toJSON();
    expect(json.balanced).toBe(true);
    expect(json.tables).toMatchObject({
      List: { legacy: 8, imported: 4, skipped: 4 },
      Subscriber: { legacy: 9, imported: 7, skipped: 2 },
      SubscriberList: { legacy: 13, imported: 8, skipped: 5 },
    });
    expect(json.skipped.map((s) => [s.table, s.reason, s.count])).toEqual(
      expect.arrayContaining([
        ["Subscriber", "duplicate address: another legacy record with it was imported", 1],
        ["Subscriber", "invalid email address", 1],
        ["SubscriberList", "subscriber not imported", 2],
        ["SubscriberList", "subscriber deleted in legacy: memberships not kept", 1],
      ]),
    );
    expect(JSON.stringify(json)).not.toContain("@");
    expect(imported.get(id(G.subMedia))?.mediaKeys).toEqual(new Set(["media-distribution-lists:000-0-victoria", "media-distribution-lists:sample-town"]));
  });

  it("re-run: unchanged records stay put and nothing is duplicated", async () => {
    await run();
    const historyBefore = (await tdb.db.select().from(subscriberHistory)).length;
    const { report } = await run();
    expect((await tdb.db.select().from(subscriberHistory)).length).toBe(historyBefore);
    expect(report.toJSON()).toMatchObject({ balanced: true, tables: { Subscriber: { imported: 7, skipped: 2 } } });
  });

  it("re-run: a change made in NoD wins; an untouched record picks up legacy's change", async () => {
    await run();
    await tdb.db.update(subscribers).set({ status: "disabled" }).where(eq(subscribers.id, id(G.subDigest)));
    const tables = legacyNodTables();
    tables.subscribers = tables.subscribers!.map((s) =>
      s.SubscriberGuid === G.subActive ? { ...s, ImmediateDelivery: false, DigestDelivery: true } : s.SubscriberGuid === G.subDigest ? { ...s, DigestDelivery: false, ImmediateDelivery: true } : s,
    );
    const { report } = await run(tables);
    expect(await subscriber(G.subDigest)).toMatchObject({ status: "disabled", digest: true });
    expect(await subscriber(G.subActive)).toMatchObject({ asItHappens: false, digest: true });
    expect(report.toJSON().skipped).toContainEqual({ table: "Subscriber", reason: "changed in NoD since the last import (NoD's record kept)", count: 1, sample: [id(G.subDigest)] });
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, id(G.subActive)));
    expect(history.filter((h) => h.action === "legacy-imported").map((h) => h.detail).sort()).toEqual(["status active", "updated from legacy: status active"]);
  });

  it("an address a NoD subscriber already has is left to NoD", async () => {
    await tdb.db.insert(subscribers).values({ email: "notiming@example.test", status: "active", source: "self" });
    const { report } = await run();
    expect(await subscriber(G.subNoTiming)).toBeUndefined();
    expect(report.toJSON().skipped).toContainEqual(expect.objectContaining({ table: "Subscriber", reason: "address already in NoD (NoD's record kept)" }));
  });

  it("a record removed in NoD (purged) isn't brought back by a re-run", async () => {
    await run();
    await tdb.db.delete(subscribers).where(eq(subscribers.id, id(G.subDeleted)));
    const { report } = await run();
    expect(await subscriber(G.subDeleted)).toBeUndefined();
    expect(report.toJSON().skipped).toContainEqual(expect.objectContaining({ table: "Subscriber", reason: "removed in NoD since the last import" }));
  });
});
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/import/subscribers.test.ts`
Expected: FAIL, "Cannot find module './lists'".

- [ ] **Step 4: Implement `lists.ts`**

```ts
import type { Db } from "@gcpe/db-kit";
import type { LegacySource } from "@gcpe/legacy-import";
import { lists } from "../db/schema";
import { guidKey, mapLists, type LegacyListRow, type ListMapping } from "./map";
import { Q_LISTS } from "./queries";
import type { NodImportReport } from "./report";

export class NodNotReadyError extends Error {
  constructor() {
    super("NoD has no ministry lists yet: import Core's reference data and let it reach NoD before importing subscribers");
    this.name = "NodNotReadyError";
  }
}

/** Maps legacy lists onto NoD's own (writes nothing: Core and NRMS own list rows). "Imported"
 * in the report means carried to a NoD list. */
export async function importLists(db: Db, source: LegacySource, report: NodImportReport): Promise<ListMapping> {
  const nod = await db.select({ listKey: lists.listKey, category: lists.category, name: lists.name }).from(lists);
  if (!nod.some((l) => l.category === "ministries")) throw new NodNotReadyError();
  const legacy = await source.query<LegacyListRow>(Q_LISTS);
  const mapping = mapLists(legacy, nod);
  report.count("List", "legacy", legacy.length);
  for (const l of legacy) {
    const guid = guidKey(l.ListGuid);
    if (mapping.byGuid.has(guid)) report.count("List", "imported");
    else report.skip("List", mapping.skipped.get(guid)!, guid);
  }
  return mapping;
}
```

- [ ] **Step 5: Implement `subscribers.ts`**

```ts
import { eq, sql } from "drizzle-orm";
import { wallClockToInstant } from "@gcpe/config";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import type { LegacySource } from "@gcpe/legacy-import";
import { legacySubscriberImports, subscribers, subscriptions, type SubscriberSource, type SubscriberStatus } from "../db/schema";
import { lockAddress } from "../locks";
import { writeHistory } from "../subscribe/history";
import { fingerprintOf, guidKey, mapSubscriber, pickWinners, type LegacySubscriberRow, type ListMapping, type MappedList, type MappedSubscriber, type SubscriberState } from "./map";
import { Q_ENDED, Q_MEDIA_LIST_LEAVES, Q_SUBSCRIBERS, Q_SUBSCRIBER_LISTS } from "./queries";
import type { NodImportReport } from "./report";

export const IMPORT_ACTOR = "Legacy import";
const BATCH = 500;

export interface ImportedSubscriber {
  asItHappens: boolean;
  digest: boolean;
  /** NoD media list keys the legacy record was on (articles use them to spot a media send). */
  mediaKeys: Set<string>;
}

export interface SubscriberStageContext {
  report: NodImportReport;
  timeZone: string;
  lists: ListMapping;
  /** The database clock when the run began. */
  runAt: Date;
}

type Outcome = { kind: "imported" | "updated" | "unchanged" } | { kind: "skipped"; reason: string };
const skipped = (reason: string): Outcome => ({ kind: "skipped", reason });

interface CurrentRow {
  id: string;
  email: string;
  status: SubscriberStatus;
  as_it_happens: boolean;
  digest: boolean;
  source: SubscriberSource;
  list_keys: string[] | null;
  fingerprint: string | null;
}

async function currentRows(db: DbOrTx, ids: string[], emails: string[]): Promise<CurrentRow[]> {
  const { rows } = await db.execute<CurrentRow>(sql`
    SELECT s.id, lower(s.email) AS email, s.status, s.as_it_happens, s.digest, s.source,
           (SELECT array_agg(x.list_key ORDER BY x.list_key) FROM subscriptions x WHERE x.subscriber_id = s.id) AS list_keys,
           li.fingerprint
      FROM subscribers s LEFT JOIN legacy_subscriber_imports li ON li.subscriber_id = s.id
     WHERE s.id = ANY(${sql.param(ids)}::uuid[]) OR lower(s.email) = ANY(${sql.param(emails)}::text[])`);
  return rows;
}

const stateOf = (r: CurrentRow): SubscriberState => ({ email: r.email, status: r.status, asItHappens: r.as_it_happens, digest: r.digest, source: r.source, listKeys: r.list_keys ?? [] });

async function insertSubscriber(tx: Tx, m: MappedSubscriber): Promise<void> {
  await tx.insert(subscribers).values({
    id: m.id,
    email: m.state.email,
    status: m.state.status,
    asItHappens: m.state.asItHappens,
    digest: m.state.digest,
    source: m.state.source,
    createdAt: m.createdAt,
    verifiedAt: m.createdAt,
    endedAt: m.endedAt,
  });
  if (m.state.listKeys.length > 0) await tx.insert(subscriptions).values(m.state.listKeys.map((listKey) => ({ subscriberId: m.id, listKey })));
  await writeHistory(tx, m.id, IMPORT_ACTOR, "legacy-imported", `status ${m.state.status}`);
  await tx.insert(legacySubscriberImports).values({ subscriberId: m.id, fingerprint: m.fingerprint });
}

async function updateSubscriber(tx: Tx, m: MappedSubscriber, currentEmail: string): Promise<void> {
  await tx
    .update(subscribers)
    .set({
      email: m.state.email,
      status: m.state.status,
      asItHappens: m.state.asItHappens,
      digest: m.state.digest,
      source: m.state.source,
      endedAt: m.endedAt,
      // A new address must not keep the old one's unsubscribe links working.
      ...(currentEmail !== m.state.email ? { unsubscribeVersion: sql`${subscribers.unsubscribeVersion} + 1` } : {}),
    })
    .where(eq(subscribers.id, m.id));
  await tx.delete(subscriptions).where(eq(subscriptions.subscriberId, m.id));
  if (m.state.listKeys.length > 0) await tx.insert(subscriptions).values(m.state.listKeys.map((listKey) => ({ subscriberId: m.id, listKey })));
  await writeHistory(tx, m.id, IMPORT_ACTOR, "legacy-imported", `updated from legacy: status ${m.state.status}`);
  await tx.update(legacySubscriberImports).set({ fingerprint: m.fingerprint, importedAt: sql`now()` }).where(eq(legacySubscriberImports.subscriberId, m.id));
}

/** Legacy media-list leaves for lists the subscriber isn't on now: written as opt-outs (insert
 * if absent), so staff are asked before re-adding them. Legacy can't tell an opt-out from a
 * staff removal; asking is the safe side. */
async function keepLegacyOptOuts(tx: Tx, m: MappedSubscriber, leaves: { listKey: string; at: Date }[]): Promise<void> {
  for (const l of leaves) {
    if (m.state.listKeys.includes(l.listKey)) continue;
    const at = l.at.toISOString();
    await tx.execute(sql`
      INSERT INTO subscriber_history (subscriber_id, at, actor, action, detail)
      SELECT ${m.id}::uuid, ${at}::timestamptz, ${IMPORT_ACTOR}, 'media-list-opted-out', ${l.listKey}
       WHERE NOT EXISTS (SELECT 1 FROM subscriber_history
                          WHERE subscriber_id = ${m.id}::uuid AND action = 'media-list-opted-out' AND detail = ${l.listKey} AND at = ${at}::timestamptz)`);
  }
}

/**
 * One batch, one transaction, holding the address lock (the same keyspace as the live journeys)
 * for every address involved, taken in sorted order before anything is read for update. The
 * addresses come from an unlocked read first. An id whose NoD address changed between that read
 * and the locks is skipped and picked up by the next run, never written under the wrong lock.
 */
async function writeBatch(db: Db, batch: MappedSubscriber[], leavesBy: Map<string, { listKey: string; at: Date }[]>): Promise<Map<string, Outcome>> {
  const ids = batch.map((m) => m.id);
  const emails = batch.map((m) => m.state.email);
  const toLock = [...new Set([...emails, ...(await currentRows(db, ids, emails)).map((r) => r.email)])].sort();
  return db.transaction(async (tx) => {
    for (const a of toLock) await lockAddress(tx, a);
    const rows = await currentRows(tx, ids, emails);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const byEmail = new Map(rows.map((r) => [r.email, r]));
    const { rows: importedBefore } = await tx.execute<{ subscriber_id: string }>(
      sql`SELECT subscriber_id FROM legacy_subscriber_imports WHERE subscriber_id = ANY(${sql.param(ids)}::uuid[])`,
    );
    const seen = new Set(importedBefore.map((r) => r.subscriber_id));
    const out = new Map<string, Outcome>();
    for (const m of batch) {
      const mine = byId.get(m.id);
      const holder = byEmail.get(m.state.email);
      let outcome: Outcome;
      if (mine && !toLock.includes(mine.email)) outcome = skipped("changed while importing: run the import again");
      else if (!mine && seen.has(m.id)) outcome = skipped("removed in NoD since the last import");
      else if (!mine && holder) outcome = skipped("address already in NoD (NoD's record kept)");
      else if (!mine) {
        await insertSubscriber(tx, m);
        outcome = { kind: "imported" };
      } else if (mine.fingerprint === null) outcome = skipped("a NoD record already has this id");
      else if (fingerprintOf(stateOf(mine)) !== mine.fingerprint) outcome = skipped("changed in NoD since the last import (NoD's record kept)");
      else if (m.fingerprint === mine.fingerprint) outcome = { kind: "unchanged" };
      else if (holder && holder.id !== m.id) outcome = skipped("address already in NoD (NoD's record kept)");
      else {
        await updateSubscriber(tx, m, mine.email);
        outcome = { kind: "updated" };
      }
      if (outcome.kind !== "skipped") await keepLegacyOptOuts(tx, m, leavesBy.get(m.id) ?? []);
      out.set(m.id, outcome);
    }
    return out;
  });
}

/** Legacy Subscriber + SubscriberList → NoD subscribers, subscriptions and history, in batches of 500. */
export async function importSubscribers(db: Db, source: LegacySource, ctx: SubscriberStageContext): Promise<Map<string, ImportedSubscriber>> {
  const { report, lists } = ctx;
  const legacy = await source.query<LegacySubscriberRow>(Q_SUBSCRIBERS);
  const memberships = await source.query<{ SubscriberGuid: string; ListGuid: string }>(Q_SUBSCRIBER_LISTS);
  const ended = await source.query<{ SubscriberGuid: string; EndedAt: Date }>(Q_ENDED);
  const leaves = await source.query<{ SubscriberGuid: string; ListGuid: string; LeftAt: Date }>(Q_MEDIA_LIST_LEAVES);
  report.count("Subscriber", "legacy", legacy.length);
  report.count("SubscriberList", "legacy", memberships.length);

  const listGuidsOf = new Map<string, string[]>();
  for (const m of memberships) {
    const s = guidKey(m.SubscriberGuid);
    listGuidsOf.set(s, [...(listGuidsOf.get(s) ?? []), guidKey(m.ListGuid)]);
  }
  const endedAt = new Map(ended.map((e) => [guidKey(e.SubscriberGuid), wallClockToInstant(e.EndedAt, ctx.timeZone)]));
  const leavesBy = new Map<string, { listKey: string; at: Date }[]>();
  for (const l of leaves) {
    const mapped = lists.byGuid.get(guidKey(l.ListGuid));
    if (!mapped?.media) continue;
    const s = guidKey(l.SubscriberGuid);
    leavesBy.set(s, [...(leavesBy.get(s) ?? []), { listKey: mapped.listKey, at: wallClockToInstant(l.LeftAt, ctx.timeZone) }]);
  }

  const skipWithLists = (guid: string, reason: string) => {
    report.skip("Subscriber", reason, guid);
    for (const lg of listGuidsOf.get(guid) ?? []) report.skip("SubscriberList", "subscriber not imported", `${guid}/${lg}`);
  };
  const { winners, duplicates, invalid } = pickWinners(legacy);
  for (const g of duplicates) skipWithLists(g, "duplicate address: another legacy record with it was imported");
  for (const g of invalid) skipWithLists(g, "invalid email address");

  const mapped = winners.map((s) => {
    const guid = guidKey(s.SubscriberGuid);
    const own = (listGuidsOf.get(guid) ?? []).map((lg) => lists.byGuid.get(lg)).filter((x): x is MappedList => x !== undefined);
    return mapSubscriber(s, own, endedAt.get(guid) ?? null, ctx);
  });

  const result = new Map<string, ImportedSubscriber>();
  for (let i = 0; i < mapped.length; i += BATCH) {
    const batch = mapped.slice(i, i + BATCH);
    const outcomes = await writeBatch(db, batch, leavesBy);
    for (const m of batch) {
      const o = outcomes.get(m.id)!;
      if (o.kind === "skipped") {
        skipWithLists(m.id, o.reason);
        continue;
      }
      report.count("Subscriber", "imported");
      const own = listGuidsOf.get(m.id) ?? [];
      for (const lg of own) {
        if (m.state.status === "deleted") report.skip("SubscriberList", "subscriber deleted in legacy: memberships not kept", `${m.id}/${lg}`);
        else if (lists.byGuid.has(lg)) report.count("SubscriberList", "imported");
        else report.skip("SubscriberList", lists.skipped.get(lg) ?? "list not in legacy's List table", `${m.id}/${lg}`);
      }
      const mediaKeys = new Set(own.map((lg) => lists.byGuid.get(lg)).filter((x): x is MappedList => x?.media === true).map((x) => x.listKey));
      result.set(m.id, { asItHappens: m.state.asItHappens, digest: m.state.digest, mediaKeys });
    }
  }
  return result;
}
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/import`
Expected: PASS.

Check the SubscriberList arithmetic against the fixture if a count is off. The 13 rows split as:
- **8 imported:** active ×2 (`*`, health), digest, disabled, journo ×2, notiming, left.
- **5 skipped:** active's deleted Finance list and its `services` list (one reason each), the deleted subscriber's one, and the duplicate's and the invalid record's one each ("subscriber not imported").

- [ ] **Step 6: Commit**

```bash
git add apps/nod apps/staff-web/src/screens/subscribers/labels.ts
git commit -m "feat(nod): import legacy subscribers, memberships and media opt-outs; re-runs keep NoD's changes"
```

---
### Task 8: Importer: recent sends, digest continuity, the run and `npm run nod:import`

Covers spec §9's mapping of `Article`/`SubscriberArticle`, "emits a report like the NRMS importer", `npm run nod:import`, acceptance item 13, and R18–R21.

**Files:**
- Create:
  - `apps/nod/src/import/articles.ts`;
  - `apps/nod/src/import/run.ts`, `apps/nod/src/import/run.test.ts`;
  - `apps/nod/src/import/cli.ts`.
- Modify:
  - `apps/nod/package.json`: scripts gain `"import:legacy": "tsx src/import/cli.ts"`;
  - root `package.json`: scripts gain `"nod:import": "npm --workspace @gcpe/nod run import:legacy --"`, after `nrms:import`.

**Interfaces:**
- Consumes:
  - `importLists`, `importSubscribers`, `ImportedSubscriber` (Task 7);
  - `deliveryModes`, `guidKey`, `EMERGENCY_CATEGORY_KEY`, `ListMapping`, `MappedList`, the queries and `NodImportReport` (Task 6);
  - `emergencyItemKey` (Task 2);
  - `POST_KIND` (`@gcpe/nrms-contract`);
  - `createNrmsTestDb` and `newsReleases` (NRMS, tests only; NRMS's own importer test imports Core's helpers the same way).
- Produces:
  - in `articles.ts`: `LEGACY_BATCH_ID`, `nrmsReleaseIndex(nrms)`, `importArticles(db, nrms, source, ctx)`, `importDigestCutoff(db, source, report)`;
  - in `run.ts`:
    - `NOD_IMPORT_LOCK = [0x67637065, 3]`;
    - `ImportAlreadyRunningError`, `ImportStageError`;
    - `redactMessage(raw)`;
    - `runNodImport(db, nrms, source, opts: { timeZone; sinceDays; publicSiteUrl; log? }): Promise<NodImportReport>`;
    - `defaultReportPath(now?)`;
    - `runNodImportCli(opts): Promise<0 | 1 | 2>`;
  - the CLI: `npm run nod:import -- [--report <path>] [--since-days <1..92>]`.

- [ ] **Step 1: Write the failing end-to-end importer tests**

`apps/nod/src/import/run.test.ts`:

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNrmsTestDb } from "../../../nrms/test/helpers";
import { newsReleases } from "../../../nrms/src/db/schema";
import { createNodTestDb } from "../../test/helpers";
import { FIXTURE_GUIDS as G, legacyNodSource, legacyNodTables, seedNodListsForImport } from "../../test/legacy-nod-fixture";
import { emergencyItemKey } from "../as-it-happens";
import { deliveries, items, nodSettings } from "../db/schema";
import { LEGACY_BATCH_ID } from "./articles";
import { NOD_IMPORT_LOCK, redactMessage, runNodImport, runNodImportCli } from "./run";

const OPTS = { timeZone: "America/Vancouver", sinceDays: 30, publicSiteUrl: "https://news.example.test" };
const RELEASE_KEY = "2026HLTH0001-000001";

describe("nod:import on the synthetic legacy database", () => {
  let nod: TestDatabase;
  let nrms: TestDatabase;
  const counts = async () =>
    (
      await nod.db.execute<Record<string, number>>(sql`
        SELECT (SELECT count(*)::int FROM subscribers) AS subscribers, (SELECT count(*)::int FROM subscriptions) AS subscriptions,
               (SELECT count(*)::int FROM subscriber_history) AS history, (SELECT count(*)::int FROM items) AS items,
               (SELECT count(*)::int FROM deliveries) AS deliveries`)
    ).rows[0];
  const reportDir = async () => join(await mkdtemp(join(tmpdir(), "nod-import-")), "report.json");

  beforeAll(async () => {
    nod = await createNodTestDb();
    nrms = await createNrmsTestDb();
    await nrms.db.insert(newsReleases).values({ type: "release", key: RELEASE_KEY, legacyId: G.nrmsRelease.toLowerCase() });
  });
  afterAll(async () => {
    await nod.drop();
    await nrms.drop();
  });
  beforeEach(async () => {
    await nod.db.execute(sql`DELETE FROM deliveries; DELETE FROM items; DELETE FROM subscriber_history; DELETE FROM subscriptions; DELETE FROM subscribers; DELETE FROM legacy_subscriber_imports;`);
    await nod.db.update(nodSettings).set({ lastDigestCutoff: null }).where(eq(nodSettings.id, 1));
    await seedNodListsForImport(nod.db);
  });

  it("imports with a balanced report: items, recent sends by mode, and the digest carries on from legacy's last", async () => {
    const json = (await runNodImport(nod.db, nrms.db, legacyNodSource(), OPTS)).toJSON();
    expect(json.balanced).toBe(true);
    expect(json.tables).toMatchObject({
      Article: { legacy: 4, imported: 2, skipped: 2 },
      SubscriberArticle: { legacy: 7, imported: 5, skipped: 2 },
    });
    expect(json.skipped.map((s) => [s.table, s.reason])).toEqual(
      expect.arrayContaining([
        ["Article", "newsletter or programs-and-services item: not carried over"],
        ["Article", "release not found in NRMS (import NRMS first)"],
        ["SubscriberArticle", "subscriber not imported"],
        ["SubscriberArticle", "no send for this subscriber's timing"],
      ]),
    );
    expect(json.notes.join("\n")).toContain("26 signups were waiting for confirmation in legacy");

    const [release] = await nod.db.select().from(items).where(eq(items.key, RELEASE_KEY));
    expect(release).toMatchObject({
      kind: "release", postKind: "releases", listKeys: ["ministries:health"], mediaListKeys: ["media-distribution-lists:000-0-victoria"],
      title: "Sample release", url: `https://news.example.test/releases/${RELEASE_KEY}`, publishedAt: new Date("2026-10-01T17:00:00Z"),
    });
    const [alert] = await nod.db.select().from(items).where(eq(items.key, emergencyItemKey("https://emergency.example.test/?p=77")));
    expect(alert).toMatchObject({ kind: "emergency", listKeys: ["emergency:alerts"], url: "https://emergency.example.test/alerts/77" });

    const sent = await nod.db.select().from(deliveries);
    const of = (g: string) =>
      sent
        .filter((d) => d.subscriberId === g.toLowerCase())
        .map((d) => [d.itemKey === RELEASE_KEY ? "release" : "alert", d.mode, d.bounceStatus])
        .sort();
    expect(of(G.subActive)).toEqual([["release", "as_it_happens", null]]);
    expect(of(G.subDigest)).toEqual([["alert", "as_it_happens", null], ["release", "digest", null]]);
    expect(of(G.subMedia)).toEqual([["release", "media", null]]);
    expect(of(G.subLeftMedia)).toEqual([["release", "as_it_happens", "legacy"]]);
    expect(sent.every((d) => d.distributionBatchId === LEGACY_BATCH_ID && d.attemptedAt !== null)).toBe(true);
    expect(sent.find((d) => d.bounceStatus === "legacy")?.hardBouncedAt).toEqual(new Date("2026-10-01T17:00:00Z"));

    const [s] = await nod.db.select({ cutoff: nodSettings.lastDigestCutoff }).from(nodSettings).where(eq(nodSettings.id, 1));
    expect(s!.cutoff).toEqual(new Date("2026-10-06T00:02:41.847Z"));
  });

  it("a second full run changes nothing", async () => {
    await runNodImport(nod.db, nrms.db, legacyNodSource(), OPTS);
    const before = await counts();
    const again = (await runNodImport(nod.db, nrms.db, legacyNodSource(), OPTS)).toJSON();
    expect(await counts()).toEqual(before);
    expect(again.balanced).toBe(true);
  });

  it("the digest cutoff only moves forward", async () => {
    const later = new Date("2026-10-20T00:00:00Z");
    await nod.db.update(nodSettings).set({ lastDigestCutoff: later }).where(eq(nodSettings.id, 1));
    await runNodImport(nod.db, nrms.db, legacyNodSource(), OPTS);
    const [s] = await nod.db.select({ cutoff: nodSettings.lastDigestCutoff }).from(nodSettings).where(eq(nodSettings.id, 1));
    expect(s!.cutoff).toEqual(later);
  });

  it("the CLI writes JSON and text reports with no address in either, logs none, and exits 0", async () => {
    const reportPath = await reportDir();
    const lines: string[] = [];
    expect(await runNodImportCli({ db: nod.db, nrms: nrms.db, source: legacyNodSource(), ...OPTS, reportPath, log: (m) => lines.push(m) })).toBe(0);
    const json = await readFile(reportPath, "utf8");
    const text = await readFile(reportPath.replace(/\.json$/, ".txt"), "utf8");
    for (const out of [json, text, lines.join("\n")]) expect(out).not.toContain("@");
  });

  it("a stage failing part-way exits 1, with a partial report naming the stage", async () => {
    const tables = legacyNodTables();
    delete tables.articles;
    const reportPath = await reportDir();
    expect(await runNodImportCli({ db: nod.db, nrms: nrms.db, source: legacyNodSource(tables), ...OPTS, reportPath })).toBe(1);
    const json = JSON.parse(await readFile(reportPath, "utf8"));
    expect(json).toMatchObject({ balanced: false, failed: { stage: "articles" }, tables: { Subscriber: { legacy: 9 } } });
  });

  it("refuses to run while another import holds the lock, and writes nothing", async () => {
    const client = await nod.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1, $2)", [...NOD_IMPORT_LOCK]);
      const lines: string[] = [];
      expect(await runNodImportCli({ db: nod.db, nrms: nrms.db, source: legacyNodSource(), ...OPTS, reportPath: await reportDir(), log: (m) => lines.push(m) })).toBe(1);
      expect(lines).toContain("another nod:import is already running");
      expect((await counts())!.subscribers).toBe(0);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [...NOD_IMPORT_LOCK]);
      client.release();
    }
  });

  it("failure messages lose bound values and anything shaped like an address", () => {
    expect(redactMessage("Failed query: insert into subscribers\nparams: someone@example.test,x\nduplicate key someone@example.test")).toBe(
      "Failed query: insert into subscribers\nduplicate key (address)",
    );
  });
});
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/import/run.test.ts`
Expected: FAIL, "Cannot find module './articles'".

- [ ] **Step 2: Implement `articles.ts`**

```ts
import { eq, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { LegacySource } from "@gcpe/legacy-import";
import { POST_KIND, type ReleaseType } from "@gcpe/nrms-contract";
import { emergencyItemKey } from "../as-it-happens";
import { items, nodSettings } from "../db/schema";
import { deliveryModes, EMERGENCY_CATEGORY_KEY, guidKey, type ListMapping, type MappedList } from "./map";
import { qArticleLists, qArticles, qSubscriberArticles, Q_DIGEST_END } from "./queries";
import type { NodImportReport } from "./report";
import type { ImportedSubscriber } from "./subscribers";

/** Stamped on every imported delivery as its Distribution batch: the reports count it as handed
 * off (legacy sent it), and no delivery.bounced event can ever carry it. */
export const LEGACY_BATCH_ID = "00000000-0000-4000-8000-0000001e9ac7";
const INSERT_CHUNK = 5_000;

/** NRMS's release key and post kind for each legacy Article id: the AtomId, or "uuid:" + the
 * legacy NewsRelease.Id (Hub's GetAtomId). Read-only. */
export async function nrmsReleaseIndex(nrms: Db): Promise<Map<string, { key: string; postKind: string }>> {
  const { rows } = await nrms.execute<{ key: string; type: ReleaseType; atom_id: string | null; legacy_id: string | null }>(
    sql`SELECT key, type, atom_id, legacy_id FROM news_releases WHERE key IS NOT NULL`,
  );
  const index = new Map<string, { key: string; postKind: string }>();
  for (const r of rows) {
    const v = { key: r.key, postKind: POST_KIND[r.type] };
    if (r.atom_id) index.set(r.atom_id.trim().toLowerCase(), v);
    if (r.legacy_id) index.set(`uuid:${r.legacy_id.toLowerCase()}`, v);
  }
  return index;
}

interface LegacyArticleRow {
  ArticleGuid: string;
  ArticleSourceID: string;
  RelativeUri: string | null;
  PublishDateTimeUtc: Date | null;
  IsDeleted: boolean;
  Title: string | null;
}

interface ItemPlan {
  row: typeof items.$inferInsert & { publishedAt: Date };
  kind: "release" | "emergency";
  mediaListKeys: string[];
}

export interface ArticleStageContext {
  report: NodImportReport;
  lists: ListMapping;
  subscribers: Map<string, ImportedSubscriber>;
  sinceDays: number;
  publicSiteUrl: string;
}

function planItem(a: LegacyArticleRow, listGuids: string[], releases: Map<string, { key: string; postKind: string }>, ctx: ArticleStageContext): ItemPlan | { skip: string } {
  if (a.IsDeleted) return { skip: "deleted in legacy" };
  if (!a.PublishDateTimeUtc) return { skip: "never published" };
  const categories = listGuids.map((g) => ctx.lists.categoryOf.get(g));
  const mapped = listGuids.map((g) => ctx.lists.byGuid.get(g)).filter((m): m is MappedList => m !== undefined);
  const publicKeys = [...new Set(mapped.filter((m) => !m.media).map((m) => m.listKey))].sort();
  const mediaKeys = [...new Set(mapped.filter((m) => m.media).map((m) => m.listKey))].sort();
  const title = (a.Title ?? "").replace(/\s+/g, " ").trim();
  if (categories.includes(EMERGENCY_CATEGORY_KEY)) {
    const url = (a.RelativeUri ?? "").trim();
    if (!/^https?:\/\/\S+$/i.test(url)) return { skip: "emergency alert without a link" };
    return {
      kind: "emergency",
      mediaListKeys: [],
      row: { key: emergencyItemKey(a.ArticleSourceID), kind: "emergency", postKind: null, listKeys: ["emergency:alerts"], title: title || "Emergency alert", summary: "", url, publishedAt: a.PublishDateTimeUtc, toSubscribers: true },
    };
  }
  const release = releases.get(a.ArticleSourceID.trim().toLowerCase());
  if (!release) {
    return { skip: categories.some((c) => c === "newsletters" || c === "services") ? "newsletter or programs-and-services item: not carried over" : "release not found in NRMS (import NRMS first)" };
  }
  return {
    kind: "release",
    mediaListKeys: mediaKeys,
    row: {
      key: release.key,
      kind: "release",
      postKind: release.postKind,
      listKeys: publicKeys,
      mediaListKeys: mediaKeys,
      title: title || release.key,
      summary: "",
      url: `${ctx.publicSiteUrl.replace(/\/$/, "")}/releases/${encodeURIComponent(release.key)}`,
      publishedAt: a.PublishDateTimeUtc,
      toSubscribers: publicKeys.length > 0,
    },
  };
}

async function importRecipients(db: Db, source: LegacySource, articleGuid: string, plan: ItemPlan, ctx: ArticleStageContext): Promise<void> {
  const rows = await source.query<{ SubscriberGuid: string; ImmediateAttempted: boolean; DigestAttempted: boolean; HardBounced: boolean }>(qSubscriberArticles(articleGuid));
  ctx.report.count("SubscriberArticle", "legacy", rows.length);
  const ids: string[] = [];
  const modes: string[] = [];
  const hard: boolean[] = [];
  for (const r of rows) {
    const sid = guidKey(r.SubscriberGuid);
    const sub = ctx.subscribers.get(sid);
    if (!sub) {
      ctx.report.skip("SubscriberArticle", "subscriber not imported", `${sid}/${articleGuid}`);
      continue;
    }
    const ms = deliveryModes(r, sub, plan);
    if (ms.length === 0) {
      ctx.report.skip("SubscriberArticle", "no send for this subscriber's timing", `${sid}/${articleGuid}`);
      continue;
    }
    ctx.report.count("SubscriberArticle", "imported");
    for (const m of ms) {
      ids.push(sid);
      modes.push(m);
      hard.push(r.HardBounced);
    }
  }
  const at = plan.row.publishedAt.toISOString();
  for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
    await db.execute(sql`
      INSERT INTO deliveries (item_key, subscriber_id, mode, attempted_at, distribution_batch_id, hard_bounced_at, bounce_status)
      SELECT ${plan.row.key}, t.s, t.m, ${at}::timestamptz, ${LEGACY_BATCH_ID}::uuid,
             CASE WHEN t.h THEN ${at}::timestamptz END, CASE WHEN t.h THEN 'legacy' END
        FROM unnest(${sql.param(ids.slice(i, i + INSERT_CHUNK))}::uuid[], ${sql.param(modes.slice(i, i + INSERT_CHUNK))}::text[],
                    ${sql.param(hard.slice(i, i + INSERT_CHUNK))}::boolean[]) AS t(s, m, h)
      ON CONFLICT DO NOTHING`);
  }
}

/** Legacy articles from the last `sinceDays`, as NoD items, with their recipients as deliveries.
 * NoD's own item for the same key wins; a delivery already recorded is left alone. */
export async function importArticles(db: Db, nrms: Db, source: LegacySource, ctx: ArticleStageContext): Promise<void> {
  const releases = await nrmsReleaseIndex(nrms);
  const articles = await source.query<LegacyArticleRow>(qArticles(ctx.sinceDays));
  const articleLists = await source.query<{ ArticleGuid: string; ListGuid: string }>(qArticleLists(ctx.sinceDays));
  ctx.report.count("Article", "legacy", articles.length);
  ctx.report.note(`Sends: articles published in legacy's last ${ctx.sinceDays} days, with their recipients; older sends are not imported.`);
  const listsOf = new Map<string, string[]>();
  for (const al of articleLists) {
    const a = guidKey(al.ArticleGuid);
    listsOf.set(a, [...(listsOf.get(a) ?? []), guidKey(al.ListGuid)]);
  }
  for (const a of articles) {
    const guid = guidKey(a.ArticleGuid);
    const plan = planItem(a, listsOf.get(guid) ?? [], releases, ctx);
    if ("skip" in plan) {
      ctx.report.skip("Article", plan.skip, guid);
      continue;
    }
    await db.insert(items).values(plan.row).onConflictDoNothing({ target: items.key });
    ctx.report.count("Article", "imported");
    await importRecipients(db, source, guid, plan, ctx);
  }
}

/** NoD's next digest starts where legacy's last one ended, never earlier than NoD's own. */
export async function importDigestCutoff(db: Db, source: LegacySource, report: NodImportReport): Promise<void> {
  const [row] = await source.query<{ ConfigValue: string | null }>(Q_DIGEST_END);
  // SQL Server writes seven fractional digits; a JS date takes three.
  const at = row?.ConfigValue ? new Date(row.ConfigValue.trim().replace(/(\.\d{3})\d+/, "$1")) : null;
  if (!at || Number.isNaN(at.getTime())) {
    report.note("Legacy's last daily digest time wasn't found: NoD's digest window is unchanged.");
    return;
  }
  await db
    .update(nodSettings)
    .set({ lastDigestCutoff: sql`GREATEST(${nodSettings.lastDigestCutoff}, ${at.toISOString()}::timestamptz)`, updatedAt: sql`now()` })
    .where(eq(nodSettings.id, 1));
  report.note(`NoD's daily digest carries on after legacy's last one (${at.toISOString()}).`);
}
```

- [ ] **Step 3: Implement `run.ts`**

```ts
import { writeFile } from "node:fs/promises";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { LegacySource } from "@gcpe/legacy-import";
import { importArticles, importDigestCutoff } from "./articles";
import { importLists } from "./lists";
import { Q_UNCONFIRMED_SIGNUPS } from "./queries";
import { NodImportReport } from "./report";
import { importSubscribers } from "./subscribers";

// The "gcpe" two-int advisory lock space (packages/db-kit's MIGRATION_LOCK is 1, nrms:import is 2).
export const NOD_IMPORT_LOCK = [0x67637065, 3] as const;

export class ImportAlreadyRunningError extends Error {
  constructor() {
    super("another nod:import is already running");
    this.name = "ImportAlreadyRunningError";
  }
}

const MAX_MESSAGE = 2_000;

/** A failure message for the report and the console: drizzle's `params:` lines (bound values)
 * are dropped, anything shaped like an address is masked, and the length is capped. */
export function redactMessage(raw: string): string {
  const kept = raw
    .split("\n")
    .filter((l) => !/^\s*params:/.test(l))
    .join("\n")
    .replace(/[^\s@]+@[^\s@]+/g, "(address)")
    .trim();
  return kept.length > MAX_MESSAGE ? `${kept.slice(0, MAX_MESSAGE)}… [truncated]` : kept;
}

export class ImportStageError extends Error {
  constructor(
    public readonly stage: string,
    public readonly report: NodImportReport,
    cause: unknown,
  ) {
    const message = redactMessage(cause instanceof Error ? cause.message : String(cause));
    super(`nod:import failed during ${stage}: ${message}`);
    this.name = "ImportStageError";
    report.markFailed(stage, message);
  }
}

/** A session-level try-lock on a dedicated connection for the whole run, as nrms:import does. */
async function withImportLock<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const client = (db as Db & { $client: pg.Pool | pg.Client }).$client;
  const conn = client instanceof pg.Pool ? await client.connect() : client;
  const release = (broken: boolean) => {
    if ("release" in conn && typeof conn.release === "function") conn.release(broken);
  };
  const { rows } = await conn.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS locked", [...NOD_IMPORT_LOCK]);
  if (!rows[0]?.locked) {
    release(false);
    throw new ImportAlreadyRunningError();
  }
  let broken = false;
  try {
    return await fn();
  } finally {
    await conn.query("SELECT pg_advisory_unlock($1, $2)", [...NOD_IMPORT_LOCK]).catch(() => {
      broken = true; // closing the connection releases the lock anyway
    });
    release(broken);
  }
}

export interface RunNodImportOptions {
  timeZone: string;
  sinceDays: number;
  publicSiteUrl: string;
  log?: (message: string) => void;
}

/** lists → subscribers → recent sends → digest cutoff. Each stage consumes only what earlier
 * ones produced. A failure carries the partial report. */
export async function runNodImport(db: Db, nrms: Db, source: LegacySource, opts: RunNodImportOptions): Promise<NodImportReport> {
  const report = new NodImportReport();
  const log = opts.log ?? (() => {});
  return withImportLock(db, async () => {
    let stage = "lists";
    try {
      const { rows } = await db.execute<{ now: string }>(sql`SELECT now() AS now`);
      const runAt = new Date(rows[0]!.now);
      const lists = await importLists(db, source, report);
      log("[nod:import] lists mapped");
      stage = "subscribers";
      const subscribers = await importSubscribers(db, source, { report, timeZone: opts.timeZone, lists, runAt });
      log(`[nod:import] subscribers: ${subscribers.size} in NoD from legacy`);
      stage = "articles";
      await importArticles(db, nrms, source, { report, lists, subscribers, sinceDays: opts.sinceDays, publicSiteUrl: opts.publicSiteUrl });
      log("[nod:import] recent sends imported");
      stage = "settings";
      await importDigestCutoff(db, source, report);
      const [signups] = await source.query<{ Signups: number }>(Q_UNCONFIRMED_SIGNUPS);
      report.note(`${signups?.Signups ?? 0} signups were waiting for confirmation in legacy and were not imported: those people must sign up again.`);
      return report;
    } catch (e) {
      throw new ImportStageError(stage, report, e);
    }
  });
}

/** `nod-import-<UTC timestamp>.json`. */
export function defaultReportPath(now: Date = new Date()): string {
  return `nod-import-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.json`;
}

async function writeReportFiles(report: NodImportReport, jsonPath: string): Promise<void> {
  await writeFile(jsonPath, JSON.stringify(report.toJSON(), null, 2));
  await writeFile(jsonPath.endsWith(".json") ? `${jsonPath.slice(0, -5)}.txt` : `${jsonPath}.txt`, report.toText());
}

export interface RunNodImportCliOptions extends RunNodImportOptions {
  db: Db;
  nrms: Db;
  source: LegacySource;
  reportPath: string;
}

/** The CLI minus env and argv: 0 balanced, 2 not balanced, 1 on any error (a partial report is
 * still written) or when another run holds the lock. */
export async function runNodImportCli(opts: RunNodImportCliOptions): Promise<0 | 1 | 2> {
  const log = opts.log ?? (() => {});
  try {
    const report = await runNodImport(opts.db, opts.nrms, opts.source, opts);
    await writeReportFiles(report, opts.reportPath);
    log(report.toText());
    return report.balanced() ? 0 : 2;
  } catch (e) {
    if (e instanceof ImportStageError) {
      await writeReportFiles(e.report, opts.reportPath);
      log(e.message);
      return 1;
    }
    log(e instanceof ImportAlreadyRunningError ? e.message : redactMessage(e instanceof Error ? e.message : String(e)));
    return 1;
  }
}
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/import`
Expected: PASS.

- [ ] **Step 4: The CLI and scripts**

`apps/nod/src/import/cli.ts`:

```ts
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assertTimeZoneRules, loadTenantConfig, parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { createMssqlSource } from "@gcpe/legacy-import";
import { MAX_SINCE_DAYS } from "./queries";
import { defaultReportPath, runNodImportCli } from "./run";

const env = parseEnv(
  z.object({
    DATABASE_URL: z.string().url(),
    // NRMS's database, read-only: legacy articles resolve to release keys through it.
    NRMS_DATABASE_URL: z.string().url(),
    // Imported release items link here, as NoD's own items do.
    PUBLIC_SITE_URL: z.string().url(),
    LEGACY_SQL_SERVER: z.string().min(1),
    LEGACY_SQL_DATABASE: z.string().default("Gcpe.NewsOnDemand"),
    LEGACY_SQL_USER: z.string().min(1),
    LEGACY_SQL_PASSWORD: z.string().min(1),
    LEGACY_SQL_TRUST_CERT: z.enum(["true", "false"]).default("false"),
    TENANT_CONFIG: z.string().default(fileURLToPath(new URL("../../../../config/tenants/bc.json", import.meta.url))),
  }),
);

function parseArgs(argv: string[]): { reportPath?: string; sinceDays: number } {
  let reportPath: string | undefined;
  let sinceDays = 30;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--report") reportPath = argv[++i];
    else if (arg === "--since-days") sinceDays = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > MAX_SINCE_DAYS) throw new Error(`--since-days must be a whole number from 1 to ${MAX_SINCE_DAYS}`);
  return { reportPath, sinceDays };
}

const { reportPath, sinceDays } = parseArgs(process.argv.slice(2));
const tenant = loadTenantConfig(env.TENANT_CONFIG);
assertTimeZoneRules(tenant);

const { db, pool } = createDb(env.DATABASE_URL);
const { db: nrms, pool: nrmsPool } = createDb(env.NRMS_DATABASE_URL, { max: 2 });
await runMigrations(db, fileURLToPath(new URL("../../migrations", import.meta.url)));
const source = await createMssqlSource({
  server: env.LEGACY_SQL_SERVER,
  database: env.LEGACY_SQL_DATABASE,
  user: env.LEGACY_SQL_USER,
  password: env.LEGACY_SQL_PASSWORD,
  trustServerCertificate: env.LEGACY_SQL_TRUST_CERT === "true",
});

try {
  process.exitCode = await runNodImportCli({
    db,
    nrms,
    source,
    timeZone: tenant.timeZone,
    sinceDays,
    publicSiteUrl: env.PUBLIC_SITE_URL,
    reportPath: reportPath ?? defaultReportPath(),
    log: console.log,
  });
} finally {
  await source.close();
  await pool.end();
  await nrmsPool.end();
}
```

Add the two `package.json` scripts listed under **Files**. Then check that the server bundle can't reach the importer:

Run: `grep -rn "import/" apps/nod/src --include=*.ts | grep -v "^apps/nod/src/import/" | grep -v test`
Expected: no output. Nothing outside `src/import/` imports it.

Run: `DATABASE_URL= npx -y -p node@24 -- npm run nod:import`
Expected: exits non-zero naming `DATABASE_URL` and the other missing variables, never a value.

- [ ] **Step 5: Type-check and commit**

Run both `tsc` commands. Expected: no errors.

```bash
git add apps/nod package.json
git commit -m "feat(nod): npm run nod:import: recent sends, digest continuity, report and exit codes"
```

---

### Task 9: End to end, parity lists, runbook and running notes

Covers acceptance items 5, 12 and 13 end to end; spec §10's exit ("open questions and changes updated; running notes"); the carry-forward cleanup; and the runbook steps the new migrations, feed and importer need.

**Files:**
- Create: `tests/e2e/emergency-purge.spec.ts`.
- Modify:
  - `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`;
  - `docs/manuals/running-notes.md`;
  - `docs/deploy/siteground.md`;
  - `README.md` (NoD env rows: `EMERGENCY_FEED_URL`; the root scripts list gains `nod:import`);
  - `docs/superpowers/plans/phase-4-carry-forward.md`.

**Interfaces:**
- Consumes:
  - the stack's fake feed (`/fake-emergency-feed/__fake/alerts`, Task 2);
  - `GET`/`PUT /nod/api/operations[/purge]` (Task 4);
  - `runPurgeIfDue` (Task 3);
  - `nodDb()`, `apiCall`, `loginForCookie`, `ensureSubscriber`, `tick`, `waitForMessageTo`, `fetchSentMessages`, `signInAs`, `expectNoSeriousA11yViolations`, `uniqueHeadline` and `TENANT_TIME_ZONE` (`tests/e2e/playwright-support.ts`).

- [ ] **Step 1: Write the e2e spec**

`tests/e2e/emergency-purge.spec.ts`:

```ts
// Acceptance items 5 and 12 end to end: an alert posted to the (fake) emergency feed reaches an
// Emergency Info BC subscriber once; Operations shows the purge preview, and a night's purge
// removes exactly what it previewed.
import { test, expect } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import { nodSettings, subscribers } from "../../apps/nod/src/db/schema";
import { runPurgeIfDue } from "../../apps/nod/src/purge";
import { ADMIN_PASSWORD, ADMIN_USERNAME } from "./constants";
import {
  apiCall, ensureSubscriber, expectNoSeriousA11yViolations, fetchSentMessages, loginForCookie, nodDb, signInAs, tick, TENANT_TIME_ZONE, uniqueHeadline, waitForMessageTo,
} from "./playwright-support";

/** The feed's 5-minute gate, opened directly (the tick never takes a test clock). */
async function openFeedGate(): Promise<void> {
  await nodDb().update(nodSettings).set({ emergencyFeedCheckedAt: null }).where(eq(nodSettings.id, 1));
}

test.describe("emergency feed and retention purge", () => {
  test("an alert added to the feed reaches an Emergency Info BC subscriber, once", async () => {
    const adminCookie = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
    const email = `alerts-${Date.now()}@example.test`;
    await ensureSubscriber(adminCookie, email, ["emergency:alerts"]);

    // The first read of the feed records what is already there and sends nothing.
    await openFeedGate();
    await tick();

    const title = uniqueHeadline("Evacuation order");
    await apiCall(adminCookie, "/fake-emergency-feed/__fake/alerts", { method: "POST", body: { title, html: "<p>Leave now.</p><p>Route: Highway 1.</p>" } });
    await openFeedGate();
    await tick();
    const mail = await waitForMessageTo(`Emergency Info BC - ${title}`, email);
    expect(mail.text).toContain("Leave now.");
    expect(mail.text).toContain("Route: Highway 1.");
    expect(mail.headers["reply-to"]).toBeUndefined();

    await openFeedGate();
    await tick();
    await tick();
    expect((await fetchSentMessages()).filter((m) => m.subject === `Emergency Info BC - ${title}`)).toHaveLength(1);
  });

  test("Operations previews the purge; a night with it on removes exactly that, and nothing while off", async ({ page, context }) => {
    const adminCookie = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
    const db = nodDb();
    const email = `ended-${Date.now()}@example.test`;
    const [gone] = await db
      .insert(subscribers)
      .values({ email, status: "deleted", endedAt: sql`now() - interval '91 days'`, createdAt: sql`now() - interval '400 days'` })
      .returning({ id: subscribers.id });

    const before = await apiCall<{ purge: { enabled: boolean; preview: { endedSubscribers: number } } }>(adminCookie, "/nod/api/operations");
    expect(before.purge.enabled).toBe(false);
    expect(before.purge.preview.endedSubscribers).toBe(1);

    await signInAs(context, "admin");
    await page.goto("/hub/subscribers/operations");
    const section = page.getByRole("region", { name: "Retention purge" });
    await expect(section).toContainText("1 ended subscriber");
    await expectNoSeriousA11yViolations(page, "Operations with the purge section");

    // Off: a night passes and the record stays.
    const nextNight = () => {
      const t = new Date(Date.now() + 24 * 3_600_000);
      return () => t;
    };
    await db.update(nodSettings).set({ purgeDoneCutoff: null }).where(eq(nodSettings.id, 1));
    await runPurgeIfDue(db, TENANT_TIME_ZONE, { now: nextNight() });
    expect(await db.select().from(subscribers).where(eq(subscribers.id, gone!.id))).toHaveLength(1);

    await section.getByRole("button", { name: "Turn on the retention purge" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("can’t be undone");
    await dialog.getByRole("button", { name: "Turn on purge" }).click();
    await expect(section.getByText("On", { exact: true })).toBeVisible();

    await db.update(nodSettings).set({ purgeDoneCutoff: null }).where(eq(nodSettings.id, 1));
    const result = await runPurgeIfDue(db, TENANT_TIME_ZONE, { now: nextNight() });
    expect(result.result?.counts.endedSubscribers).toBe(before.purge.preview.endedSubscribers);
    expect(await db.select().from(subscribers).where(eq(subscribers.id, gone!.id))).toHaveLength(0);

    await apiCall(adminCookie, "/nod/api/operations/purge", { method: "PUT", body: { enabled: false } });
  });
});
```

The second test leans on two things about the shared e2e database. **No other spec leaves a subscriber ended 90 days ago**, which is true because the database is fresh. And **the test clock is a day ahead.** A day ahead turns nothing else into a candidate: no spec writes an `ended_at` or `created_at` 89 days back. If a later spec ever does, it will show up as a count mismatch here.

Run: `npx -y -p node@24 -- npm run test:e2e -- tests/e2e/emergency-purge.spec.ts`
Expected: PASS. If the alert never arrives:
- Check `nod_settings.emergency_feed_result` in the e2e database. `error: "network"` means the stack's in-process fetch didn't route `self:` (check `resolveSelfUrls`).
- `seeded: true` on the second check means the first tick never ran the feed step.

- [ ] **Step 2: Run the whole suite**

Run:
- `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`;
- both `tsc` commands;
- `npx -y -p node@24 -- npm run test:e2e`.

Expected: all PASS. The axe sweep now meets the Operations sections too.

- [ ] **Step 3: `docs/parity/changes-from-legacy.md`** (NoD and Distribution section)

Re-check the highest C number first. It was C111 at planning. Add:

```markdown
| C112 | EmergencyInfo.exe, run by Windows Task Scheduler (interval outside the source), read the Emergency Info BC WordPress feed and posted each item to NoD (`Program.cs`). | NoD reads `EMERGENCY_FEED_URL` (RSS or Atom) every 5 minutes from the tick, with a 15-second, 2 MB limit. A failed or truncated read records nothing and sends nothing; Operations shows the last check. | One process, no Windows host; a half-downloaded alert can never be sent. | Agreed (spec §9) |
| C113 | Any item with a new id was sent, including on the first run against a feed. | The first successful read of a feed URL records its current alerts without sending; only alerts that appear after that are sent. A changed URL is read the same way once. | Pointing NoD at a live feed must not email every current alert at once. Legacy's alerts list has 0 subscribers today, so cutover loses nothing. | Agreed |
| C114 | Dedupe by `ArticleSourceID` (the feed's guid) only. | Dedupe by guid **or** link; a known alert whose title or text changed is updated in place and never re-sent (as legacy). | A WordPress guid change no longer re-sends an alert. | Agreed |
| C115 | Alert emails: the Emergency Info BC site template and banner, `content:encoded` HTML, Emergency Info BC's own Reply-To. | The BC Gov News email shell with the alert's full content as plain-text paragraphs (links kept as "text (url)"), subject "Emergency Info BC - <title>", no Reply-To. | EMBC-specific branding and Reply-To are out of scope (Paul and Anne, 2026-10-07); the EMCR category and feed stay. | Agreed |
| C116 | The purge never ran; 7.9 M expired links and every ended subscriber were kept. | Retention purge, off by default (Q25). When on, nightly at 03:00 BC: unconfirmed subscribers and unused links older than 10 days; subscribers ended more than 90 days ago, with their deliveries, history, links and subscriptions. In bounded batches, each subscriber in its own transaction under its address lock; anyone who came back meanwhile is kept. Operations shows what it would delete now and the last night's totals; turning it on or off and each night that removed anything are in the operations log. | Spec §9; one selection feeds the preview and the purge (acceptance item 12). | Proposed (Q25) |
| C117 | Every manage link ever emailed was kept. | Links in sent emails are cleared 10 days after they expire, whether the purge is on or off. | They are unusable after 24 hours, grow by about 23,000 a day, and hold an address; they are not signups or consent records. | Agreed |
| C118 | N/A (the purge never ran). | When the purge deletes a subscriber who had opted out of a media list (or, once ended, unsubscribed from everything), each opt-out the live check enforces is kept as a hash of the address (no address), per list or for every list; re-adding that address to such a list asks staff to confirm, as for a subscriber who still exists, even if the address has a new record by then. | A purge must not quietly undo an opt-out. | Proposed (Q44) |
| C119 | Bounce-disabled records stayed (`IsEnabled = 0`). | Disabled subscribers are never purged. | Staff can reactivate them; spec §9 covers only unconfirmed and ended records. | Proposed (Q25) |
| C120 | Legacy NoD data. | `npm run nod:import` imports subscribers (legacy GUIDs kept as ids; deleted → `deleted`, else enabled → `active`, else `disabled`; timing as is), their lists (`all-news` → All news; deleted lists and the Featured Programs, regions and newsletters categories not carried), and one record per address (active > disabled > deleted, then newest). Media-list members who didn't sign up themselves import as "Added by hand" until matched to Media Hub. Unconfirmed signups (only in `SubscriberLink`) aren't imported; the report counts them. | Spec §9; Q21. | Agreed |
| C121 | Media-list removals were only `SysLog` rows (action 106). | Each becomes a "media-list-opted-out" history row (actor "Legacy import") when the person isn't on that list now, so staff are asked before re-adding them. | Legacy can't tell an opt-out from a staff removal; asking is the safe side. | Agreed |
| C122 | `SubscriberArticle` (93.7 M rows), no timestamps. | Only the last 30 days of sends are imported (`--since-days`, at most 92), as delivery records at the article's publish time, marked as sent by legacy; hard bounces carry over. Releases resolve to NRMS keys, so a post-cutover republish never re-sends them. NoD's first digest starts after legacy's last. | Covers the bounce window and a month of reports without importing the whole history; nothing is sent twice across the cutover. | Agreed |
| C123 | N/A. | Re-running the importer is safe: records nobody has changed in NoD take legacy's newer data; records changed in NoD (by staff, bounces, the Media Hub sync) or removed by the purge are left as NoD has them and reported. | Trial runs before cutover, then a final run, on the same database. | Agreed |
```

- [ ] **Step 4: `docs/parity/open-questions.md`**

Re-check the highest Q number. It was Q42.

- **Q25:** append to its Question cell: "Also: should bounce-disabled subscribers (never purged today, C119) have a window?"
- **Add under Open:**

```markdown
| Q43 | What is production's EMCR alerts feed URL? Legacy's was `http://www.emergencyinfobc.gov.bc.ca/category/alerts/feed/?hide_expired=true`. | `NOD_EMERGENCY_FEED_URL` must be set in production; unset, no alerts are read. | The legacy URL over https, once EMCR confirms it still publishes there. | 2026-10-07 |
| Q44 | After the purge deletes someone who opted out of a media list, may we keep a hash of their address (no address) with the list and date, indefinitely? | Without it, staff could re-add a journalist who opted out, with no warning. | Yes (C118). | 2026-10-07 |
| Q45 | Legacy has 7,719 active subscribers with neither as-it-happens nor daily digest; they receive nothing. Import them as they are, or as unsubscribed? | They count as active subscribers in reports. | Import as they are (C120). | 2026-10-07 |
| Q46 | Distribution keeps every sent message's address (`messages.email`) with no retention. Should it follow the NoD purge? | A purged subscriber's address can still sit in Distribution's message history. | Out of 4i; decide with Q25. | 2026-10-07 |
```

- [ ] **Step 5: `docs/manuals/running-notes.md`**

Add a new heading `## Phase 4i — emergency alerts feed, retention purge, legacy import` with:

```markdown
- **Operations** — Emergency alerts come from the EMCR feed every 5 minutes and go to everyone on the
  Emergency Info BC list, whatever their timing. Operations → "Emergency alerts feed" shows the last
  check. A warning there (for example "http-503" or "not-a-feed") means nothing was read; it retries
  by itself.
- **Operations** — The first time NoD reads a feed (or after its address changes), it records the
  alerts already there without emailing anyone. Only alerts posted after that are sent.
- **Operations** — An alert edited on the EMCR site updates our copy but is not sent again.
- **Administrator** — Operations → "Retention purge" is off until the business sets retention rules
  (Q25). It lists what it would delete if it ran now. Turning it on asks first; from then on it
  deletes, every night at 3:00, for good. Turning it off stops further deletions.
- **Administrator** — Links in sent emails are cleared 10 days after they expire whether or not the
  purge is on. They stopped working long before.
- **Editor** — If you add a journalist to a media list and are asked to confirm because they opted
  out, that holds even if their old record was purged: the opt-out is kept without the address.
- **Developer** — `npm run nod:import` (see docs/deploy/siteground.md) loads legacy NoD into NoD.
  Run `nrms:import` first and let Core's lists reach NoD. Read the report before trusting the data:
  every skipped row is grouped by reason. Re-running is safe; records changed in NoD since the last
  import are left alone and listed.
- **Operations** — The NoD migration `0029_purge_indexes` adds indexes to `job_recipients` and
  `subscriber_links`. On a populated database, pre-build them with the CONCURRENTLY steps in
  docs/deploy/siteground.md.
```

- [ ] **Step 6: `docs/deploy/siteground.md`**

- **"Migrations on populated deliveries or messages tables":** add `0029_purge_indexes` to the list of index-only NoD migrations (which already names `0027`), and to the example `TAGS` (`TAGS="0023_report_history_index 0024_report_delivery_indexes 0027_items_emergency_url_index 0029_purge_indexes"`). Note that `0026` and `0028` are not index-only (columns and tables) and run in the normal deploy.
- **New section "Emergency alerts feed (Phase 4i)":**
  - On test sites the stack serves a fake feed at `/fake-emergency-feed/feed.xml`.
  - Add an alert with `curl -X POST -H "Authorization: Bearer <admin token>" -H "content-type: application/json" -d '{"title":"Test alert","html":"<p>Test.</p>"}' https://boxs.ca/fake-emergency-feed/__fake/alerts`, then wait up to 5 minutes (or tick).
  - Production sets `NOD_EMERGENCY_FEED_URL` (Q43). With it unset, no alerts are read, and Operations says so.
- **New section "Retention purge (Phase 4i)":** off by default; the switch is on Operations (NoD.Admin); it runs nightly at 03:00 BC from the tick; expired send links are cleared every night regardless.
- **New section "Importing legacy NoD data (Phase 4i)"**, modelled on the NRMS section:
  - **Env:** `DATABASE_URL` (NoD), `NRMS_DATABASE_URL` (read-only), `PUBLIC_SITE_URL`, `LEGACY_SQL_SERVER`, `LEGACY_SQL_DATABASE` (default `Gcpe.NewsOnDemand`), `LEGACY_SQL_USER`, `LEGACY_SQL_PASSWORD`, `LEGACY_SQL_TRUST_CERT`.
  - **Prerequisites:** Core's reference data reached NoD, NRMS imported, media lists republished.
  - **Command:** `npm run nod:import -- --report nod-import.json [--since-days 30]`.
  - **Behaviour:** the whole-run lock; the report (legacy = imported + skipped per table, skips grouped by reason with sample GUIDs, never an address); exit codes 0/2/1; re-run behaviour (NoD wins on changed records); the same networking assumption as `nrms:import` (run from a machine that can reach both the legacy SQL Server and the target Postgres).
  - **Warning:** run the final import **before** turning the purge on. Legacy's ended subscribers whose end date is unknown get the import time, so they wait 90 days.

- [ ] **Step 7: README and carry-forward**

- **README:** in the NoD env table, after `REPLY_TO`, add:

  `| EMERGENCY_FEED_URL | no | | The EMCR emergency alerts feed (RSS or Atom), read every 5 minutes; unset means no alerts are read. Test sites get the stack's fake feed (set as NOD_EMERGENCY_FEED_URL on the deployed stack). |`

  In the root scripts list, add `nod:import`.
- **`phase-4-carry-forward.md`:** delete the whole "4i" section. The purge switch and preview are Tasks 3–5; send links are R10; Emergency Info BC branding and Reply-To are closed by R2.

- [ ] **Step 8: Final verification**

Run, all under Node 24:
- `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`;
- both `tsc` commands;
- `npx -y -p node@24 -- npm run test:e2e`.

Then check the diff for addresses:
- `git diff 84bb836 | grep -oE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+" | sort -u`. Every result must be at `example.test`, `example.com` or `x.invalid`, or one of the role mailboxes the docs already name (`gcpe.news@gov.bc.ca`, `noreply.newsondemand@gov.bc.ca`).
- `git diff 84bb836 -- apps | grep -n "Task [0-9]\|R[0-9][0-9]\b"` must print nothing (no plan labels in code).

- [ ] **Step 9: Commit**

```bash
git add tests/e2e/emergency-purge.spec.ts docs README.md
git commit -m "test(e2e),docs: emergency alert and purge end to end; parity C112-C123, Q43-Q46, runbook, running notes"
```

---

## Risks and things to watch

- **Decision-relevant: run the final import before turning the purge on.**
  - Legacy deleted subscribers with no SysLog end date get the import time as `ended_at`. Turning the purge on just after a trial import is still safe: they wait 90 days.
  - But if staff turn the purge on, then run another import months later, re-run rules apply ("removed in NoD since the last import"). Purged records are not brought back. That is intended, but staff should know.
- **The feed URL is unconfirmed (Q43).** Legacy's production value is plain `http://`. **Assumed:** the https form serves the same feed. If EMCR moved the alerts feed, production reads nothing until `NOD_EMERGENCY_FEED_URL` is fixed. Operations shows the error.
- **WordPress feed details are inferred, not observed.** The parser follows the RSS 2.0 shape of a WordPress category feed and legacy's `content:encoded` use. It has not been run against today's live EMCR feed. The first boxs.ca check against the real URL (if Paul allows it) is the settling test.
- **`items.url` has no index.** The link dedupe reads `items WHERE kind = 'emergency' AND url = $1`. That is a scan of about 1,500 rows a year, fine for a 5-minute job. Add an index if items ever grows by orders of magnitude.
- **The import's media matching by name** assumes legacy NoD's media list names equal NRMS's (both came from Hub). A renamed list is reported as "no matching NoD list" with its GUID. Staff then fix it in NRMS and re-run.
- **Importing 30 days of sends is about 0.8 M legacy rows** (117 articles at about 7,000 recipients). That is roughly 1.6 M delivery rows on the target. **Inferred** from the Q21 averages, not measured. Lower `--since-days` if the target database is small.
- **Distribution message history keeps addresses (Q46).** The NoD purge doesn't touch Distribution.

## Self-review (done while writing)

- **Spec coverage:**
  - §9 ingester: Tasks 1–2 (schedule R5, env and fake R8, dedupe R6, emergency sends via `recordEmergencyItem`).
  - §9 purge: Task 3 (rules R9; off by default; nightly R13; deliveries and history cascade), Task 4 (Operations API) and Task 5 (screen).
  - §9 importer: Tasks 6–8 (Subscriber, SubscriberList, List/ListCategory, Article/SubscriberArticle; statuses; SubscriberLink-only signups not imported; manual-media; report; synthetic `.sqlproj`-shaped fixture).
  - §5.1 emergency: Task 2 ("reaches a digest-only subscriber") and the e2e.
  - Acceptance item 5: Task 2 and the e2e. Item 12: Task 3's first test and the e2e. Item 13: Task 8.
  - 4g R2 (switch and preview on Operations, one selection function): Tasks 3–5.
  - Carry-forward 4i: Task 9 Step 7 and R2/R10.
- **Placeholders:** none. Two steps reference existing test code without repeating it:
  - Task 2 Step 7 adds to the existing env and stack tests and names the exact expectations;
  - Task 5 Step 2 copies the existing "pause dialog" a11y test with one changed button name.
  Both name exactly what changes.
- **Type consistency:**
  - `PurgeCounts` field names (`pendingSubscribers`, `endedSubscribers`, `unusedLinks`, `expiredSendLinks`) are identical in `purge.ts`, the route test, staff-web `types.ts`, the screen and the e2e.
  - `EmergencyFeedResult` fields (`at`, `ok`, `seeded`, `inFeed`, `created`, `updated`, `skipped`, `error`) are identical in `ingest.ts` and staff-web.
  - `emergencyItemKey` is used by the ingester (Task 2) and the importer (Task 8).
  - `ImportedSubscriber.mediaKeys` (Task 7) feeds `deliveryModes` (Task 6) in Task 8.
  - `getOperations(db, distribution, opts)` matches every caller listed in Task 4.
- **Review Focus:** each of the five items names its pinning test, all present in the owning task's test code.

## Questions for Paul (product decisions only)

1. **Production feed URL (Q43).** Legacy read `http://www.emergencyinfobc.gov.bc.ca/category/alerts/feed/?hide_expired=true`. Is that still EMCR's alerts feed, over https? Can boxs.ca read the real feed once as a test, or should it stay on the fake?
2. **Kept media opt-outs (Q44).** When the purge deletes someone who opted out of a media list, may we keep an address-free hash of them with the list and date indefinitely, so staff are warned before re-adding them?
3. **Active subscribers with no timing (Q45).** 7,719 legacy subscribers are active with neither as-it-happens nor digest, so they receive nothing. Import them as active (the plan's choice), or as unsubscribed?
4. **Bounce-disabled subscribers (Q25 extension).** The purge never deletes them. Should it, after some window?
5. **Distribution's message history (Q46).** It keeps every sent address with no retention. Should it follow the NoD purge, in a later phase?
