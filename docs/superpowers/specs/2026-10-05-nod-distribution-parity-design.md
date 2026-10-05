# NoD + Distribution Parity (Phase 4) — Design Addendum

**Status:** design approved section by section in conversation, 2026-10-05; this document awaits written review.
**Parent spec:** `docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md` (§7 NoD and Distribution, §10 testing, §11 roadmap). Where this addendum and the parent disagree, this addendum wins for Phase 4. The parent's items it supersedes are listed in §11 below.
**Companion lists (kept current as work proceeds):**
- `docs/parity/changes-from-legacy.md`: every deliberate departure from legacy behaviour (C47 onward).
- `docs/parity/open-questions.md`: questions for the business, each with a working assumption (Q21 onward).
- `docs/manuals/running-notes.md`: staff-facing notes for the deferred manuals. Phase 4 adds its block at exit.

**Legacy sources:**
- `~/HUB/Subscribe`: NewsOnDemand.* and NewsDistribution.*. Six projects listed in `Subscribe.sln` are missing from disk, including BounceManager's own project; the bounce code is in `NewsOnDemand.Library/Legacy/BounceManager.cs`.
- `gcpe-hub-develop/Hub.Legacy`: the Hub schedules the digest and pushes releases to NoD (`ReleasePublisher.cs`). It also holds `MediaDistributionList` and the Contacts module, which writes journalists into NoD.

**Other sources:**
- **Media Hub 2.0:** `~/media-hub-app`, the contacts system (see §5.3).
- **Research notes:** the legacy NoD/Distribution inventory and the Media Hub contacts survey, both 2026-10-05, from the session. Facts are carried into this document with legacy file:line references where they matter.

## 1. Goal and scope

Bring News On Demand (subscriber email) and Distribution (sending) to parity with legacy, on the platform built in Phases 0–3. This builds on Phase 2's thin slice:
- NoD: verified-only subscribers, as-it-happens sends chunked to Distribution;
- Distribution: batches, priority queue with `FOR UPDATE SKIP LOCKED`, backoff, age backstop, non-prod redirect.

**In scope:**
- the subscriber data model and journeys;
- the legacy Subscribe API (behind the existing News API proxy);
- minimal subscribe/manage pages on the test site;
- as-it-happens, daily digest and emergency sends; media distribution lists;
- the Media Hub contacts contract and a fake Media Hub;
- Distribution rate cap and capacity measurement;
- bounces;
- the staff Subscribers section;
- the emergency RSS ingester, the retention purge (off by default), and the legacy NoD importer.

**Out of scope:**
- the Media Hub side of the contacts contract (a follow-up in the Media Hub repo, §5.3);
- the real Graph app registration and bounce mailbox, the relay's real rate limit, and legacy data (Q21–Q23: built against stand-ins);
- Newsletters and Media Requests (out of the product, parent §1);
- the full public site (Phase 6);
- Entra sign-in.

**Stand-ins**, following Phase 3's fake Flickr pattern. None ever holds real personal data:
- a fake Media Hub;
- a fake bounce mailbox;
- a fake emergency feed;
- Mailpit or the test-site redirect for mail.

## 2. Sub-plans

Each sub-plan is planned, built, reviewed and deployed to boxs.ca in turn.

| Sub | What | Main check |
|---|---|---|
| 4a | Data model (§3); the legacy Subscribe API and journeys (§4); minimal subscribe/manage pages on the test site | Every journey end to end on boxs.ca through the News API proxy |
| 4b | As-it-happens on the new model, daily digest, emergency items, pause/resume, delivery records (§5.1–5.2) | Digest and no-duplicate tests |
| 4c | Media lists, the Media Hub contract and fake, media-list sends, the legacy membership endpoint (§5.3–5.5) | A media-list send; a contact email change synced |
| 4d | Distribution rate cap, concurrency, capacity measurement (§6) | A measured send rate recorded beside Q21/Q22 |
| 4e | Bounces (§7) | Bounce parsing, matching and threshold tests |
| 4f | Staff Subscribers section and roles (§8) | Acceptance list, e2e and axe checks |
| 4g | Emergency RSS ingester, retention purge, legacy NoD importer (§9) | Purge and importer tests |

## 3. Data model (NoD)

Extends the Phase 2 tables (`apps/nod/src/db/schema.ts`). Migrations are additive; existing Phase 2 subscribers migrate as `active`, `self`, as-it-happens only.

- **`subscribers`**:
  - Phase 2 columns: id (uuid), email (unique, case-insensitive), created/registered at.
  - Adds `status` (`pending` | `active` | `disabled` | `deleted`), `as_it_happens` and `digest` (booleans; at least one true for an `active` self-subscriber).
  - Adds `source` (`self` | `admin` | `media-hub` | `manual-media`), `media_hub_contact_id` (integer, nullable; Media Hub ids are serial integers), `ended_at` (unsubscribed, deleted or email changed; drives purge), and `unsubscribe_token_hash`.
  - Delivery timing lives on the subscriber, as in legacy (`Subscriber.ImmediateDelivery` / `DigestDelivery`). Phase 2's per-subscription `as_it_happens` column is migrated up and dropped.
- **`list_categories`**: key, name, enabled, sort order. Seeded: `ministries`, `sectors`, `themes`, `tags`, `media-distribution-lists`, `emergency`.
- **`lists`**: category, key, name, active, sort order, topic URL.
  - The first four categories are created and renamed from Core events, as now.
  - Media lists come from NRMS events (§5.3); emergency lists are seeded.
  - "All news" (`*`) keeps its legacy meaning: items in the ministries category only (`DistributionProvider.cs:296`).
- **`subscriptions`**: subscriber × list; shape unchanged.
- **`subscriber_links`**: one-time links.
  - Columns: token hash (SHA-256 of a 32-byte random token), purpose (`verify` | `manage` | `change-email`), subscriber id (nullable while pending), pending preferences (jsonb), `expires_at` (24 h, legacy `AuthenticationTimeout`), `used_at`.
  - Only hashes are stored.
- **Unsubscribe token:** stable per subscriber, separate from the 24-hour links. It is used in every email's `List-Unsubscribe` header, so one-click unsubscribe works after links expire. Rotated on email change.
- **`deliveries`**: item × subscriber × mode (`as_it_happens` | `digest` | `media`).
  - Columns: attempted at, delivered at, hard-bounced at, Distribution message id.
  - Replaces Phase 2's release × subscriber rows, which migrate as `as_it_happens`, delivered.
- **`items`**: what NoD sends: release key or emergency item id, kind, lists, publish time, title, and summary/text for rendering.
- **`subscriber_history`**: subscriber id, at, actor, action, detail. Replaces legacy `SysLog`; feeds the History screen and reports.
- **`nod_settings`**: global pause, the purge switch, last digest run, and the bounce and summary addresses (§8).

## 4. Subscriber journeys

Served by NoD at the legacy Subscribe API paths and JSON shapes, through the existing News API proxy (`apps/news-api/src/http/v1/subscribe.ts`), so gcpe-news-webapp works unchanged:
- `SubscriptionItems/{categoryKey}`
- `CreateNewsOnDemandEmailSubscriptionWithPreferences`
- `ConfirmUpdateCreateSubscription/{token}`
- `UpdateNewsOnDemandEmailSubscriptionWithPreferences/{token}`
- `ManageNewsOnDemandEmailSubscription/{email}`
- `CheckEmailActivationToken/{token}`
- `UnsubscribeSubscriber/{token}`

The plan pins each request and response shape from `docs/contracts/news-api-v1.swagger.json` and the legacy controllers.

1. **Subscribe.** Preferences go into a `verify` link, and a verification email goes out at priority 100. Subject and wording follow legacy: "BC Gov News On Demand Email Verification", "Confirm your request … click here".
   - Confirming creates or activates the subscriber and writes history.
   - If the email already belongs to an active subscriber, the response is identical and a manage-link email goes out instead (anti-enumeration).
2. **Manage.** A manage-link email ("BC Gov News On Demand Subscription Management") carries a 24-hour link. The link shows and updates the preferences. The response never reveals whether the email exists.
3. **Change email.** The new address gets a `change-email` link. The switch happens only when it is confirmed (C49). If the new address already belongs to a subscriber, the confirmation merges nothing: it unsubscribes the old record, matching legacy's silent anti-enumeration outcome (`SubscriptionProvider.cs:468-472`).
4. **Unsubscribe.** By token, or by RFC 8058 one-click `POST` to the `List-Unsubscribe` URL. It is idempotent and returns success even for an unknown or used token (C50). The subscriber becomes `deleted`, with `ended_at` set.
5. **Staff-added subscribers and media-list members** are `active` at once, with no verification email (C51).

**Test-site pages.** The public site gains `/subscribe/`, `/subscribe/manage/` and an unsubscribe confirmation page. They are static pages whose small script calls the News API's Subscribe endpoints, the same path the real webapp uses. They are accessible and work at phone width. They are a test harness until the full public site (Phase 6), and are not a design for it.

**Rate limiting:** the proxy's existing per-IP limit, plus a per-email limit on emails sent (at most 3 verify/manage emails per address per hour), so nobody can mail-bomb an address.

## 5. Sending

### 5.1 Subscriber sends

- **As-it-happens:**
  - Trigger: `release.published` with `toSubscribers` (exists), and emergency items.
  - Audience: active subscribers with `as_it_happens` on a matching list.
  - Content: one email per subscriber, priority 30. Subject is "BC Gov News - <title>" for a single item (legacy `NodTask.cs:247-251`).
  - Each email carries its own manage link (a fresh 24-hour `manage` link substitution, as legacy did per email) plus `List-Unsubscribe` and `List-Unsubscribe-Post` headers.
- **Daily digest:**
  - Runs from the scheduled `/stack/tick` at 17:00 Pacific (tenant time zone). If the last run is older than the previous 17:00, it runs immediately as a catch-up (legacy `NodTask.cs:91-109`).
  - Each digest subscriber gets one email, "BCNews - Daily Digest", priority 20, grouping their matching items published since the last run.
  - Advisories are excluded, as are items only on non-news lists (`NodTask.cs:133,253,333`).
  - Exactly one digest per subscriber per run, enforced by `deliveries`.
- **Emergency:** items on an emergency list go as-it-happens to everyone on that list, whatever their timing preference (parent §7.2; legacy sends non-news sites to every subscriber regardless of mode, `DistributionProvider.cs:308-310`).
- **No duplicates:** recipients are selected and `deliveries` rows inserted in one transaction, guarded by the unique key (item, subscriber, mode). A retried job never re-sends to a delivered row.
- **Pause/resume:**
  - A global switch in `nod_settings`. Paused, NoD still records items and builds sends, but holds them; nothing is dropped.
  - Each change writes history and emails the configured operations address (legacy `ManageDistributionService.aspx.cs:90-110`).
  - Distribution has its own pause too (§6).
- **Templates:** HTML and text, with placeholders matching legacy subjects and wording until real samples arrive (Q24). Every email has a plain-text part.

### 5.2 Rendering

One rendering per item × mode. Per-subscriber values are filled in through Distribution's substitutions (manage link, unsubscribe URL), so a release to 20,000 subscribers is rendered once (parent §7.2).

### 5.3 Media lists and the Media Hub contract

- **NRMS keeps the list names and keys** (Phase 3). It emits `media_list.created`, `media_list.updated` and `media_list.deactivated`. NoD mirrors them as lists in the `media-distribution-lists` category, so there are no hand-matched keys (legacy matched Hub keys to NoD keys by hand).
- **NoD holds the members.** Each member is a subscriber with source `media-hub` (contact id + chosen email) or `manual-media` (an email typed by staff, for people not in Media Hub). Members are always as-it-happens.
- **Media Hub contacts API.** This is the contract the Media Hub repo implements later, tracked there.
  - Service token: Entra client credentials in production; a locally minted token on test.
  - `GET /api/service/contacts?q=&page=&pageSize=` searches name, email and outlet. Each result: `{ id, firstName, lastName, outlet, emails: [{ address, kind: "personal"|"workplace", organization, preferred }], deletedAt }`.
  - `GET /api/service/contacts/:id` includes soft-deleted contacts.
  - `GET /api/service/contacts/changes?since=<ISO>&cursor=` lists contacts changed or deleted since then, including workplace email changes. It returns a next cursor.
  - Today Media Hub has none of this: no search, no paging, no service auth, no change feed, and no audit of workplace email changes (survey 2026-10-05). Q26 tracks adoption.
- **Choosing and syncing:**
  - Staff search, pick a contact, then pick which of its emails to use.
  - A nightly sync calls `changes?since=` and handles three cases:
    - chosen email changed: the member is updated;
    - chosen email gone: flagged "needs attention" and kept, never switched silently;
    - contact deleted: the member is removed, with history written.
  - Webhooks (`contact.updated`/`contact.deleted`, parent §7.3) can replace polling later; the sync stays as reconciliation.
- **Fake Media Hub:** implements the contract with generated contacts (several emails each, some deleted, some changing between syncs). It is served on boxs.ca and used in tests. It never uses the real contact export.

### 5.4 Media-list sends

- On `release.published` with `toMediaLists`, each recipient on the release's selected lists gets the full text. Each email is sent individually, at priority 40, and never grouped (legacy `NodTask.cs:230,303`).
- Advisories drop the title and the Gov News link, and "MEDIA ADVISORY - EVENT REMINDER" is stripped (`NodTask.cs:240-265`). No Flickr photo (Q5, as built in Phase 3).
- A recipient on several selected lists gets one copy.
- NRMS's media contact count (deferred in Phase 3) uses NoD's count endpoint with media list keys.

### 5.5 Legacy membership endpoint

Media Hub's Membership tab calls the legacy NoD API today: `NOD_API_URL + email`, Basic Auth, reading `SubscribedCategories["media-distribution-lists" | "media-subscription-services" | "tags"]` (`media-hub-app/server/routes.ts:7397-7509`).
- NoD serves a compatible endpoint, so the tab keeps working at cutover.
- Credentials are a configured service user name and password, stored hashed.
- Basic Auth is kept for compatibility only (C55). The exact legacy path is pinned in the 4c plan (Q27).

## 6. Distribution

Already built (Phase 2): batches, priority claiming with `FOR UPDATE SKIP LOCKED`, escalating backoff, the age backstop, the non-prod redirect (`DIST_MAIL_REDIRECT_TO`, a comma-separated list), and `X-Original-To` with the `[to: …]` subject prefix.

Phase 4 adds:
- **Rate cap:** `MAIL_RATE_PER_MINUTE`, enforced across all workers through the database (a per-minute counter row claimed in the same transaction as the messages), plus `MAIL_CONCURRENCY`. Default 60/minute until the relay's limit is known (Q22).
- **Priorities as specified:** system 100, media 40, immediate 30, digest 20, plus 2 for recipients in configured internal domains (`gov.bc.ca`, `leg.bc.ca`, legacy `CommonMethods.cs:113-120`).
- **A `Message-ID` per message,** recorded on the message row, so bounces match exactly (§7).
- **Pause/resume** for Distribution as a whole (legacy `IsNewsDistributionEnabled`), staff-controlled through NoD's admin with `NoD.Admin` (§8).
- **Retries:** permanent errors (a malformed address, a 5xx refusal of the recipient) fail at once. Transient errors back off with the existing escalation and age backstop. Legacy retried forever (C53).
- **Capacity measurement:** a scripted load run queues N synthetic recipients (default 20,000) into Mailpit and records sends per minute and time to drain at several caps. The result is written into `docs/parity/open-questions.md` beside Q21/Q22, closing the parent §7.6 check as far as it can be without the real inputs.

## 7. Bounces

- **Bounce source interface** in Distribution: `fetchNew(limit)` returns raw messages with ids; `markProcessed(ids)`.
  - **Graph source** for production: reads one mailbox, with app permission limited to it by an application access policy (parent §7.5). Built and unit-tested against recorded Graph responses; not run live until Q23 is answered.
  - **Fake mailbox** for tests and boxs.ca: a stored inbox that operators feed by pasting or uploading a bounce message (`.eml`) on an admin screen. On boxs.ca every email is redirected, so real bounces never occur.
- **Schedule:** every 15 minutes from the tick (C54; legacy ran Sunday and Wednesday 12:00–13:00 only).
- **Parsing:**
  - RFC 3464 delivery-status reports first: recipient, status code, and the original `Message-ID`.
  - Fallback: legacy's heuristic of an "Undeliverable:" subject, the first address in the body, and a 5.x.x or 5xx code (`BounceManager.cs:101-156`).
  - A status starting with 5 is a hard bounce. Others are recorded as soft and don't count.
- **Matching:** by `Message-ID`, which identifies the message, batch and app. Fallback for messages without one: recipient email within 4 days. Distribution emits `delivery.bounced { appId, batchId, email, messageId, hard, at }` to the originating app.
- **NoD:** marks the matching delivery hard-bounced. If a subscriber's last 10 deliveries within 15 days are all hard-bounced, they are disabled and `deleted`, with history (legacy `DistributionProvider.cs:465-506`). Media-list members are flagged "needs attention" instead of deleted.
- **Summary email:** daily, when there was anything to report, to a configured address (legacy hard-coded Carolynn.Hunter@gov.bc.ca). Subject "News On Demand - Bounce Manager - <date>", with media-list members highlighted.

## 8. Staff Subscribers section

Added to the existing staff app (`apps/staff-web`): the same sign-in, shell, design system, and accessibility and e2e standards as Phase 3.

- **Subscribers:**
  - Search by email (substring) and filter by status.
  - Edit timing, lists and status; change email (staff-initiated, no verification, history written); delete (unsubscribe).
  - History (from `subscriber_history`).
  - Bulk activate/deactivate/delete on a search result, with confirmation.
  - Add a subscriber (active immediately, C51).
- **Lists & categories:** enable/disable categories and lists, order them, see subscriber counts. Names of ministry/sector/theme/tag lists come from Core and are read-only here; media list names come from NRMS.
- **Media lists:** members per list; add from Media Hub search (choose the email) or manually; remove; "needs attention" flags with a resolve action; last sync time and result.
- **Reports**, each with CSV export:
  - active subscribers by list;
  - recent unsubscribes (90 days);
  - per-release sends (as-it-happens and media, with counts delivered/bounced);
  - digest runs;
  - Distribution sent vs bounced.
- **Operations:** NoD pause/resume, Distribution pause/resume, purge on/off (and next-run preview count), bounce summary address, the fake bounce mailbox upload (test sites only).
- **Roles** (Core, granted by `Core.Admin`):
  - `NoD.Viewer`: reports, lists, subscriber search (read-only). Legacy `LOB_USRS` roughly.
  - `NoD.Editor`: subscribers and media lists. Legacy `EDTRS`.
  - `NoD.Admin`: everything above plus Operations and categories. Legacy `ADMNS`.
  - The existing `NoD.Admin` service use (Phase 2) and `NoD.SubscriberCount` stay.

## 9. Emergency feed, retention, importer

- **Emergency RSS ingester** (replaces `EmergencyInfo.exe`):
  - Scheduled from the tick every 5 minutes.
  - `EMERGENCY_FEED_URL` is configured; a fake feed is used on boxs.ca and in tests.
  - New items (deduplicated by GUID/link) become `items` on the `emergency/alerts` list and go out as §5.1 emergency sends.
- **Retention purge:**
  - Built; **off by default** (`nod_settings`, Q25). Legacy's purge never ran: its loop is commented out and nothing calls the API.
  - When on, nightly:
    - delete `pending` subscribers and unused links older than 10 days;
    - permanently delete subscribers whose `ended_at` is over 90 days old;
    - delete their deliveries and history.
  - The preview count shows what the next run would remove.
- **Legacy NoD importer** (`npm run nod:import`, run from a full checkout like `nrms:import`):
  - Maps `Subscriber`, `SubscriberList`, `List`/`ListCategory` and `Article`/`SubscriberArticle` into the new model.
  - Statuses come from `IsEnabled`/`IsDeleted`; unverified signups living only in `SubscriberLink` JSON are not imported.
  - Media-list members (legacy subscribers in the media category) import as `manual-media` until matched to Media Hub contacts by email.
  - Emits a report like the NRMS importer.
  - Tested on synthetic fixtures shaped by the legacy `.sqlproj` schema; real data waits for Phase 7 (Q21).

## 10. Testing and acceptance

Unit and integration tests per sub-plan (Vitest, Node 24). Browser tests with Playwright plus axe through the staff app and the test-site subscribe pages. Event contract tests for every new event (`media_list.*`, `delivery.bounced`).

Acceptance list; `*` = also hand-checked on boxs.ca:
1. *Subscribe → verification email → confirm → manage link → change preferences → unsubscribe by link and by one-click `POST`. Every step goes through the News API proxy, and every email arrives at the redirect addresses.
2. Subscribing with an existing address gives the same response and sends a manage email; nothing reveals that the address exists.
3. *A published release reaches as-it-happens subscribers once. A second `release.published` for it sends nothing new.
4. *The 17:00 digest groups the day's items per subscriber and leaves out advisories. A missed tick catches up on the next one; a second run the same day sends nothing.
5. An emergency item reaches every subscriber on its list regardless of timing.
6. *A release with media lists reaches each member once, full text. An advisory has no title or Gov News link.
7. *Adding a media-list member from the fake Media Hub; the fake changes that contact's email and the nightly sync updates the member; deleting the contact removes the member.
8. Media Hub's Membership tab call returns the expected `SubscribedCategories` shape.
9. *A pasted hard bounce counts toward the threshold. Ten in 15 days removes a subscriber; the summary email lists it.
10. *Pause holds sends without dropping them; resume releases them. Each sends the operations email.
11. The rate cap holds across two concurrent workers, and the capacity run produces its numbers.
12. Purge removes exactly the rows its preview counted, and nothing while it is off.
13. The importer maps the synthetic legacy fixture with a reconciled report.
14. *Viewer/Editor/Admin each see exactly their parts of the Subscribers section.

Exit for Phase 4: the list above green; open questions and changes updated; the running notes Phase 4 block written; deployed to boxs.ca.

## 11. Changes to the parent spec

- §7.3 "NoD owns media lists" → NRMS owns list names and keys; NoD owns members, mirrored by events (§5.3).
- §7.3 "staff add journalists by searching Media Hub through its API" → the API doesn't exist yet. This addendum defines the contract (§5.3), builds against a fake, and keeps manual entry as a fallback.
- §7.1 retention → built but off by default (§9, Q25); legacy never ran it.
- §7.5 bounces "read via Microsoft Graph" → behind a bounce source interface. Graph is the production implementation; a fake mailbox is used until Q23 is answered.
- §7.6 capacity → measured against Mailpit (§6); the real inputs remain Q21/Q22.
- §7.2 adds that a digest-delivered item is never later sent as-it-happens to the same subscriber (legacy rule).
- Phase 2's per-subscription `as_it_happens` moves to the subscriber (§3).
