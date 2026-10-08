# Phase 5 carry-forward

Items one sub-plan leaves for a later one. Delete an item when the plan that takes it is written.

## 5d

- **Pin the tenant-config start-up refusal with an integration test.** `startCalendar` must refuse to start when the tenant file has no `calendar` section (spec addendum §5.1); only unit coverage exists today.
- **Add a barrier to the concurrent-lock race test** (`activity-locks.test.ts`, "two people taking it at once"), so both requests are provably in flight together.
- **History on an imported dirty title/details:** isolate the All-Day status-only row in its own test. (The raw-to-cleaned title entry is pinned in the curly-quote test.)
- **The class-22 (and class-23) log lines carry no method or path.** `sendActivityError`'s two `console.error` calls (`apps/calendar/src/http/errors.ts:27,32`) log only `safeErrorLabel(e)`; add the request's method and path so a logged data-exception or constraint hit can be traced back to the call that caused it.
- **Accepted race: a target deactivated during a long Transfer run still receives the remaining batches.** `runTransfer` (`apps/calendar/src/transfer.ts`) checks the target contact, its ministry and its person once, before the first batch; each batch re-checks only the activity. A target made inactive mid-run keeps what the later batches move. Re-check the target per batch if this ever matters.

- **The list reads through `visibleSql(actor)`** (`apps/calendar/src/visibility.ts`), unaliased `activities`; never filter in memory after paging (spec addendum §6).
- **Review selected** posts `{ items: [{ id, version }] }` (≤ 500) to `POST /calendar/api/activities/review-selected` and shows the `skipped` list; **Clear LA Status** posts `{ days }` to `POST /calendar/api/activities/clear-la-status`.
- **The freeze banner** reads `GET /calendar/api/config`'s `freeze`.
- **Review selected and Clear LA Status can answer 207 with `{ failed: true }`:** a later batch rolled back after earlier ones committed. Staff-web must check `body.failed`, not only the status, and tell the user what did and didn't commit.

## 5e

- **`CALENDAR_STORAGE_DIR`** for attachments, outside the deploy folder (spec addendum §5.1, §8.4).
- **The editor round-trips `ActivityView.fields`** (`@gcpe/calendar-contract`) and runs `checkActivity` and `inferLookAhead` itself; it sends `lookAhead` only when `GET /calendar/api/config`'s `lookAheadFieldset` is true.
- **Lock release on tab close uses `fetch(…, { keepalive: true })` with the `X-GCPE-Request` header**, not `navigator.sendBeacon`, which can't send the header `requireBearer` demands (C169) — the keepalive release must send this CSRF header or the server refuses it.
- **"View changes"** reads `GET /calendar/api/activities/:id/changes`.
- **Attachments are content writes:** call `assertNotFrozen` and check `can.edit` (spec addendum §7.4, §8.4).

## 5g

- **Report rendering:** build on the spike's recommendation (`docs/superpowers/plans/2026-10-08-phase-5b-report-rendering-spike.md`); its "Risks and what wasn't checked" list is 5g's to close. Wait for Q57's answer before planning 5g: the spike's boxs.ca SSH and runtime legs couldn't run (the gcpe-siteground SSH key isn't authorised), so whether Chromium runs on SiteGround's Node hosting is still unverified; re-run those two legs once the key is authorised, before committing 5g's rendering seam to Chromium as the default.
- **Look Ahead: don't build "Consultations and Dialogues".** That section hasn't been used in years (Paul, 2026-10-07). 5g does **not** build it. Record it in `docs/parity/changes-from-legacy.md` as dropped: "dropped: unused for years, Paul 2026-10-07". Update the spec's "all 7 sections" (R6, §10.2) and the cover legend to match. Check whether the §7 category rule "contact ministry is the consultations ministry → Consultations and Dialogues" still matters without the section.
- **Legacy report fixes** (from `docs/parity/legacy-report-layouts.md`'s discrepancies): drop the doubled "updated updated" wording in the Executive Look Ahead's "Last updated" line; drop the raw, unparsed `**CONFIDENTIAL**` markdown marker from a row's title. "Consultations and Dialogues" is dropped entirely, per the item above.

## 5h and later

- **The News API must never gain an `activity.*` handler.** Confidential Calendar content must stay inside the Calendar (C127); only the id-only confidential form of `activity.*` and `release.status_changed` cross that boundary (spec addendum §5.4). The Calendar → NRMS `activity.*` route exists since 5c-1 (`apps/stack/src/env.ts`); 5h adds NRMS's handler. A test in `apps/stack/src/env.test.ts` pins that no route carries `activity.*` to the News API.
- **NRMS's `activity.*` handler must not bring a deleted activity back.** Reviewing a deleted activity, or clearing its LA status, emits `activity.updated` with `isDeleted: true` after the `activity.deleted` already sent. The handler must treat `isDeleted: true` as deleted, never as an upsert of a live activity.
- **If service tokens with Calendar roles ever exist, Core's `actorIsHq` should apply only to session callers.** `actorIsHq` (`apps/core/src/services/calendar-access.ts`) today only ever sees a session actor; before a service token could carry a Calendar role, re-check that it still reads HQ membership only for a session caller, not for a bearer/service subject.
- **The NRMS → News API event route is `"*"`** (`apps/stack/src/env.ts`, the `NRMS`→`NEWSAPI` entry). Before NRMS emits `release.status_changed`, make that route list its types explicitly, or at least exclude `release.status_changed`, so the event goes only to the Calendar. The Calendar's `projectionHandler` (`apps/calendar/src/projections.ts`) also accepts only `core` today: it must accept the `nrms` source for `release.status_changed`.
- **Re-check NRMS "email me a copy" if service tokens ever carry NRMS roles.** `POST /nrms/api/releases/:id/email-copy` (`apps/nrms/src/http/routes.ts`) sends to the bearer's `email` claim. A service token with an NRMS role could then send a release to whatever address its claims name.

## 5i

- **Sequences:** re-base every legacy-id identity (`activities`, every lookup, `comm_contacts`, `saved_filters`, `activity_files`) above the imported maximum (spec addendum §12.1).
- **Lookup names:** legacy allows a NULL `Name`; the Calendar's `name` is NOT NULL, so map NULL to `""`.
- **Keys, not ids:** legacy ministry GUIDs map to Core organization keys (`contact_ministry_key`, `ministry_key`, `activity_shared_with.ministry_key`), and sectors, themes and tags to term keys.
- **`comm_contacts` is unique on (user, ministry).** Merge the contacts of duplicate-email legacy users onto one, and remap `activities.comm_contact_id` to the surviving contact.
- **Legacy join tables:** keep only `IsActive` rows, and de-duplicate them (a legacy join table can hold more than one active row for the same pair).
- **Null legacy timestamps and status:** map a null legacy `CreatedDateTime`, `LastUpdatedDateTime` and `StatusId` to a value — none of the three is nullable here.
- **Null `Log.CreatedBy`:** give it a fallback actor name rather than importing a null actor.
- **`SortOrder`** maps to `rank`.
- **Empty mobile values:** a blank legacy mobile number imports as an empty string. `user_profiles.mobile`'s CHECK allows that (empty, or 12 characters of digits and hyphens), so don't map it to null or reject it.
- **The legacy log importer must map Look Ahead changes onto exactly the `LOOK_AHEAD_HISTORY_FIELDS` keys** (`hq_comments`, `hq_status`, `hq_section`, `long_term_outlook`) — a deny-list filter, not an allow-everything-else one, so an importer bug can't smuggle an HQ-only field into a ministry viewer's history under an unexpected key.
- **Check legacy end dates and NR years against 1900–2199 too.** The activity API refuses a year outside 1900–2199 on create and update (spec addendum §12.1's int4/NUL/year checks); the importer should reject and report a legacy row whose end date or NR year falls outside that same range, rather than importing a value the Calendar's own API would never accept.

## Entra sign-in (later phase)

- **Entra/OIDC matching must never match on a null email.** When Entra/OIDC sign-in is built, matching an incoming identity to a Core user by email must treat `email IS NULL` as "no match", never as a wildcard — a user imported without an email (spec addendum §4, "Users without email") must stay unmatched until an admin links a real address.
