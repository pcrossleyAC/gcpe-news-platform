# Phase 5 carry-forward

Items one sub-plan leaves for a later one. Delete an item when the plan that takes it is written.

## 5h and later

- **The News API must never gain an `activity.*` handler.** Confidential Calendar content must stay inside the Calendar (C127); only the id-only confidential form of `activity.*` and `release.status_changed` cross that boundary (spec addendum §5.4). The Calendar → NRMS `activity.*` route exists since 5c-1 (`apps/stack/src/env.ts`); 5h adds NRMS's handler. A test in `apps/stack/src/env.test.ts` pins that no route carries `activity.*` to the News API.
- **NRMS's `activity.*` handler must not bring a deleted activity back.** Reviewing a deleted activity, or clearing its LA status, emits `activity.updated` with `isDeleted: true` after the `activity.deleted` already sent. The handler must treat `isDeleted: true` as deleted, never as an upsert of a live activity.
- **If service tokens with Calendar roles ever exist, Core's `actorIsHq` should apply only to session callers.** `actorIsHq` (`apps/core/src/services/calendar-access.ts`) today only ever sees a session actor; before a service token could carry a Calendar role, re-check that it still reads HQ membership only for a session caller, not for a bearer/service subject.
- **The NRMS → News API event route is `"*"`** (`apps/stack/src/env.ts`, the `NRMS`→`NEWSAPI` entry). Before NRMS emits `release.status_changed`, make that route list its types explicitly, or at least exclude `release.status_changed`, so the event goes only to the Calendar. The Calendar's `projectionHandler` (`apps/calendar/src/projections.ts`) also accepts only `core` today: it must accept the `nrms` source for `release.status_changed`.
- **Re-check NRMS "email me a copy" if service tokens ever carry NRMS roles.** `POST /nrms/api/releases/:id/email-copy` (`apps/nrms/src/http/routes.ts`) sends to the bearer's `email` claim. A service token with an NRMS role could then send a release to whatever address its claims name.

## 5i

- **Report parity:** run `npm run calendar:report-compare` (scripts/calendar-report-compare.ts) on each past-period legacy PDF against ours for the same range and filter, with `--out` outside the repo. Settle there what the samples couldn't:
  - whether legacy's Awareness Dates rows carried "Last updated" in the Exec Look Ahead (discrepancy 6; legacy's code says no);
  - whether legacy showed In the News for a day with no rows (we skip such days);
  - where legacy broke pages around "Outside Government" and the Long Term Outlook;
  - Q63.
- Survey 08 (2026-10-10, aggregates in `docs/parity/legacy-survey/results/Hub/08-CalendarParity_Queries-aggregates.xlsx`): legacy category 16 is stored as `Speech /  Remarks` (two spaces) while `bc.json` and `inferLookAhead` use `Speech / Remarks` and compare names exactly, so imported activities in it (5,758 links all-time) would infer the wrong Look Ahead section. Normalise whitespace in the comparison or the import, or match by id.
- Survey 08: `UNK` in `contactMinistryExcludedAbbreviations` matches no legacy ministry; legacy `HqStatusId` uses the Status table's 7 (New) and 1 (Changed) only, so map 7 → `new` and 1 → `changed`; 43 active activities have a blank Significance (required for BC), so a non-HQ save of one is refused until it's filled in; query 8.20 (linked releases) is missing from the export and needs re-running; Excel turned 129 of 336 keyword names into dates, so re-export keywords as text.
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
- **Surface `overCap` in the saved-query migration report.** `migrateLegacySavedFilters` (`apps/calendar/src/list/legacy-filters.ts`) keeps every legacy saved query, even past the 200-per-user cap, and returns the owners over it in `overCap`; the import report must list them.
- **`ConvertedFilter.filter` can be null** (`convertLegacyQuery`, when the final schema check refuses the converted filter); an importer calling it directly must handle a null filter, as `migrateLegacySavedFilters` does.
- **`skippedNoOwner` also holds rows whose owner id the resolver couldn't turn into a valid user id**, not only rows with no owner; the report should say so.
- **Check legacy end dates and NR years against 1900–2199 too.** The activity API refuses a year outside 1900–2199 on create and update (spec addendum §12.1's int4/NUL/year checks); the importer should reject and report a legacy row whose end date or NR year falls outside that same range, rather than importing a value the Calendar's own API would never accept.
- **Saved queries:** call `migrateLegacySavedFilters` (`apps/calendar/src/list/legacy-filters.ts`) with resolvers backed by Core's organizations and `user_legacy_ids`, and put its report in the import report.
- **List preferences:** for each imported user, write `user_profiles.list_display` with `legacyDisplay(FilterDisplayValue)` and `hidden_columns` with `legacyHiddenColumns(HiddenColumns)`, both together: a null `list_display` means no choice yet.
- **Attachments:** write each legacy file through the Calendar's `ObjectStore` under `activities/<id>/<16 hex>-<safeFileName>` (`randomFileKey`), with the name through `attachmentName` (`apps/calendar/src/activities/files.ts`). Check legacy's MD5 against the bytes first. Store the content type from `ATTACHMENT_TYPES` when `checkAttachment` accepts the file; otherwise keep legacy's type, which `downloadContentType` serves as `application/octet-stream`. An import may exceed 50 files on an activity; the cap applies only to new uploads.
- **Count imported activities with two or more categories.** The editor infers the Look Ahead section from its single category choice (`categoryId`), but while that choice is unchanged the server infers from every category the activity holds (`apps/calendar/src/activities/update.ts`, `categoryIds`). An HQ save of such an activity can send a section inferred from a different input than the server's, which is then stored as an override. Report how many there are, so the import or the editor can settle it.
- **Count imported values the shared check refuses on every save** (`checkActivity`, `packages/calendar-contract/src/validate.ts`, which runs on each save whether or not the field changed): Potential Dates containing a digit, TBC or TBD; start, end or NR years outside 1900–2199; and start, end or NR times off the 5-minute grid. Each forces a fix on the activity's next save. Fixing an off-grid start or end time moves `startAt`/`endAt`, which sets the `start_date`/`end_date` needs-review flags (`apps/calendar/src/activities/review-rules.ts`); a Potential Dates fix sets `start_date` too. Put the counts in the import report.
- **No sweeper for orphaned attachment bytes.** When a Calendar attachment is replaced or removed and the matching object-store delete then fails after the database change has committed, the bytes are left behind; today that failure is only logged, by activity id and file id (`deleteQuietly`, `apps/calendar/src/activities/files.ts` — never a name or storage key). Nothing yet walks the store to find and remove bytes with no surviving row.

## Platform hardening (no phase yet)

- **`apps/nrms`'s site-files and page-images upload routes still take the file name in `?name=`**, so the name lands in every proxy's access logs, the same leak the Calendar's upload route carried until it moved to the `X-GCPE-File-Name` header (5e-1). Move NRMS's two routes to a header the same way.
- Updates feed at volume: with 2M history rows, Latest 5 for a ministry with no recent entries, or an open-ended range, takes 2–3.4 s (EXPLAIN ANALYZE, 2026-10-10). The bounded paths are under 60 ms. The feed starts empty at cutover. Once history grows, add a default date floor, or an index (pg_trgm on title/details for keyword search, and a covering index for the latest-N scan).

## Entra sign-in (later phase)

- **Entra/OIDC matching must never match on a null email.** When Entra/OIDC sign-in is built, matching an incoming identity to a Core user by email must treat `email IS NULL` as "no match", never as a wildcard — a user imported without an email (spec addendum §4, "Users without email") must stay unmatched until an admin links a real address.
