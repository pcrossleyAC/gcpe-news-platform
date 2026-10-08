# Corporate Calendar Parity (Phase 5) — Design Addendum

**Status:** decisions approved by Paul, 2026-10-07 (§2), revised the same day with three changes from the business contact (R5 deferred, R13, R14); this document awaits written review.
**Parent spec:** `docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md` (§8 Corporate Calendar, §10 testing, §11 roadmap). Where this addendum and the parent disagree, this addendum wins for Phase 5. The parent items it supersedes are listed in §17.
**Companion lists (kept current as work proceeds):**
- `docs/parity/changes-from-legacy.md`: every deliberate departure from legacy behaviour. This phase adds C124 onward (§14).
- `docs/parity/open-questions.md`: questions for the business, each with a working assumption. This phase adds Q48 onward (§15).
- `docs/manuals/running-notes.md`: staff-facing notes for the deferred manuals. Each Phase 5 sub-plan adds role-tagged lines.

**Legacy sources:** `gcpe-hub-develop/Hub.Legacy`.
- Calendar website: `Gcpe.Hub.Legacy.Website/Calendar`.
- Libraries: `Gcpe.Calendar.Library` and `Gcpe.Calendar.Data`.
- Authoritative schema: `Gcpe.Hub.Database/calendar`. `db-scripts` is a stale 2018 snapshot; it is the only place `Priority` and `ActivityServices` still exist.
- Reports: the RDLC files in `Calendar/Reports`.

**Other sources:**
- the Phase 5 Calendar research notes (2026-10-07, session scratchpad), with file:line references into legacy;
- the legacy survey workbook `docs/parity/legacy-survey/results/Hub/04-Hub-Calendar_Queries.xlsx` (query file `04-hub-calendar.sql`), cited below as "SV n.n". It holds counts only.

Legacy references below are relative to `Calendar/` unless they name another project.

## 1. Goal and scope

Bring the Corporate Calendar to full parity with the legacy Calendar module, on the platform built in Phases 0–4, and link it to NRMS. Nothing in the legacy Calendar is dropped except the dead items Paul named (R9) and the security holes (R10).

**In scope:**
- **Core:** ministry-scoped Calendar roles, user ministries, HQ organisations, users without email (§4).
- **A new `calendar` app** with its own database (§5), and a Calendar section in the staff app (§8).
- **Activity behaviour:**
  - the activity rules: validation, needs-review, change freeze, edit locks, concurrency, field history (§7);
  - the list, the editor, attachments, the lookup and user admin screens, and Transfer (§8).
- **Feeds and reports:**
  - the updates feed (§9);
  - the Look Ahead, Exec Look Ahead, 30/60/90 and Planning reports, each as PDF and Word, plus the Excel export (§10).
- **NRMS link:** `activity.*` and `release.status_changed`, release status on the activity, and the Forecast tab. This closes C15 except its iCal feed (§11).
- **Migration:** the legacy Calendar importer for a scoped set of activities (R13), and the side-by-side report parity check (§12).

**Out of scope:**
- **Entra sign-in.** It plugs into Core later. Imported users stay matched by email until then (R12).
- **Production data and the production cutover** (Phase 7). The importer is built and tested against synthetic fixtures shaped by the `.sqlproj` schema. The parity check (5i) needs a legacy environment (Q50).
- **The legacy `NewsFeed` table** (R8), the `Priority` and `ActivityServices` tables (R9), and legacy's Snowplow analytics calls (C154).
- **Bulk delete.** Legacy's `DeleteSelected` handler had no screen that called it, so it is not built (C138).
- **iCal feeds,** both the Calendar's and NRMS's Forecast feed. They are deferred (R5, C131), and their design is kept in Appendix A.
- **Activities outside the import scope** (R13): older activities stay readable only in legacy, through the read-only access kept for one year after cutover (R14, a Phase 7 item).

**Stand-ins**, following the earlier phases' pattern. None ever holds real personal data:
- synthetic legacy fixtures for the importer;
- generated users and activities on boxs.ca.

## 2. Decisions (Paul, 2026-10-07)

| # | Decision | Legacy behaviour it changes | Rows |
|---|---|---|---|
| Scope | Full parity. Keep all fields, all three reports plus Exec Look Ahead, edit locks, the change freeze, the 23 needs-review flags, and attachments. iCal was in the original scope and is now deferred (R5). | None. Only the R9 dead tables, the R10 holes and the deferred iCal go. | — |
| Hosting | A new `calendar` app with its own database, and a Calendar section in the existing staff app. It follows the NRMS and NoD app patterns: Express, Drizzle, the outbox event catalogue, and staff-web conventions. | ASP.NET WebForms pages over the shared Hub database. | — |
| Roles | Core gains ministry-scoped Calendar roles (ReadOnly < Editor < Advanced < Administrator < SysAdmin) and HQ organisations. | Legacy kept roles and ministries in `calendar.SystemUser`/`SystemUserMinistry`. It had two settings, `ApplicationOwnerOrganizations` ("see all") and `HQAdmin` (one ministry), which are now one HQ flag. | C124, C125 |
| R1 | Change freeze from 16:00 to 17:00 Pacific, configurable, enforced on the server. Members of an HQ organisation at Editor or above are exempt. | The server blocked 04:05–17:00 by mistake (`ChangeFreezeWindowHandler.ashx.cs:46`). The browser compared times as strings, so the freeze was in effect about 16:05–17:00 and about 04:05–05:00. Saves were never checked. | C126 |
| R2 | Confidential items are filtered everywhere by one visibility rule: the list, the activity page, the updates feed, reports, the Excel export, search by ID, and attachments. | The activity page, iCal, the updates feed and quick search by ID (>10,000) leaked confidential items. The Look Ahead filter parameter bypassed the list rule. | C127 |
| R3 | Edit locks stay visible, with a 15-minute idle timeout. Optimistic concurrency through a version column applies to everyone. | A lock was the latest `calendar.Log` "Edit" row. It had no expiry, anyone's cancel deleted it, and the idle timer closed the tab. An HQ Administrator's edit to another ministry's activity left `LastUpdatedDateTime` alone, so it could be overwritten silently. | C128, C129 |
| R4 | Needs-review flags work exactly as legacy: the same 23 fields and triggers, cleared by HQ. | None. The keyword-count bug is fixed separately (C130). | — |
| R5 (revised) | **iCal is not built initially.** Legacy usage is unknown; it can be added later. The approved design (a tokenized per-user URL with reset, title, city and link only, confidential items left out) is kept in Appendix A. This also defers NRMS's Forecast iCal. | Legacy offered "Connect to Outlook" (Windows auth, no token, confidential items included) and a Forecast iCal. | C131 |
| R6 | Every report is available as PDF and as Word, built from HTML templates: Look Ahead (all 7 sections), Exec Look Ahead (HQ Administrator and above), 30/60/90, and Planning (Legal landscape). Layouts and filters match legacy. Every report uses the current list filter. | RDLC through ReportViewer. The UI offered PDF only; Word worked only by editing the URL (`&format=Word`). | C132 |
| R7 | Field history gets a "View changes" screen. | `calendar.Log` was written for 7 fields and never displayed. The link was commented out (`Activity.aspx.cs:689-691`). | C133 |
| R8 | Import `calendar.Log` as field history. Do not import `NewsFeed`, a derived notification log full of personal information. | Not applicable (migration). | C134, C135 |
| R9 | Import and keep Potential Dates and Records. Show Potential Dates in the UI. Drop `Priority` and `ActivityServices`. | Potential Dates was always hidden (`Activity.aspx:1201,2332`). | C136, C137 |
| R10 | Fix the security holes listed in the next cell. | The holes: attachment download with no access check (`ActivityFile.ashx.cs:11-26`); `ReviewSelected`, `DeleteSelected` and `ClearLAStatus` with no server role check; admin pages hidden only by their menu link; saved filters with no owner check; release PDF download with no check. | C138–C141 |
| R11 | Forecast is confirmed, non-confidential, future activities whose category starts with "Approved", as in legacy. NRMS emits `release.status_changed`, and the Calendar shows release status on the activity. The release editor's lookup also requires that the activity has not ended, as legacy's did. | NRMS read `calendar.*` directly. Nothing was pushed back to the Calendar. | C142, C143 |
| R12 | Users without an email are imported as inactive. They keep ownership of their activities, and an admin can link them to Entra later. | Not applicable (migration). | C144 |
| R13 | **Import scope.** Import only (a) activities on or after a configurable cutoff, the date the new government is sworn in after the 2026 election (not yet set), and (b) every historical awareness-date activity, at any date, so staff can clone recurring events. Legacy ids are kept. Field history is imported only for imported activities. Users are imported only when referenced or currently active. | Legacy holds every activity since 2012. Older activities, their history, and the release links to them are not carried. | C157, C158 |
| R14 | **Legacy stays readable.** One HQ administrator keeps read-only access to the legacy Corporate Calendar for one year after cutover. This is a Phase 7 decommissioning requirement, not a build item. | Not applicable (decommissioning). | §17 |

Legacy data bugs fixed (Paul, 2026-10-07): new activities lose their NR date and Translations (C145); the keyword change check compares only counts (C130); cloning with a new keyword crashes (C146); `ActiveActivities` drops activities that have no comm contact (C147); the "Fact Sheet" release code never matches (C148).

## 3. Sub-plans

Each sub-plan is planned, built, reviewed and deployed to boxs.ca in turn. Each exits when its check passes, its parity rows and questions are updated, and its running-notes lines are written.

| Sub | What | Exit check |
|---|---|---|
| 5a | **Core:** Calendar roles and levels; `user_organizations`; the HQ flag on organisations; users without email; `user.upserted` with Calendar access; Core admin screens for all of these (§4) | A role × own/shared/other-ministry × HQ matrix test on Core's grants and events. A Calendar.Administrator can't grant SysAdmin. An inactive no-email user can't sign in. |
| 5b | **Calendar app skeleton:** schema (§5), lookups with legacy ids, the generic lookup admin with legacy lock-down, the Calendar users screen, the Core projections, the event schemas in `packages/events`. Plus the **report spike** (§10.1). | Lookup admin end to end on boxs.ca. Event contract tests. A spike report recorded in the plan folder, covering both formats, both page sizes, and both hosts. |
| 5c | **Activity API and rules:** create, update, clone, delete, review, review-selected, Clear LA Status, Transfer; server-side validation; needs-review; status; field history; locks and versioning; change freeze; visibility; `activity.*` outbox (§6, §7) | Rule tests generated from the legacy trigger table (§7.3). Lock and concurrency tests on real Postgres. Freeze clock tests, including the BC switch to permanent UTC−7 on 2026-11-01. The visibility function and its SQL predicate agree on a generated matrix. |
| 5d | **List screen:** filters, display modes, quick search, saved filters, watchlist, column preferences, calendar view, corporate queries, the Look Ahead admin filter, review-selected, Excel export (§8.1) | Axe on every state. A visibility e2e for each role. A legacy saved-filter fixture migrates with a report. The list query takes under 500 ms on a 50,000-activity fixture, several years' growth over the imported set (assumed target, measured in 5d). |
| 5e | **Editor screen:** fieldsets, Look Ahead inference and override, HQ-only fields, release badges, lock and conflict UX, "View changes", attachments (§8.2–§8.4) | An editor e2e for each role. Attachment authorisation tests: another ministry's confidential file gives 404. A lock-expiry e2e. |
| 5f | **Updates feed:** latest 5, today, date range with type and keyword, per activity (§9) | Feed visibility tests for each role, including confidential and deleted items. Each mode returns the expected items from a fixture. |
| 5g | **Reports:** Look Ahead, Exec Look Ahead, 30/60/90 and Planning as HTML templates rendered to PDF and Word (§10) | Golden HTML per section from fixtures. Text extracted from both PDF and Word matches the golden activity order. Every report built on boxs.ca. |
| 5h | **NRMS link and Forecast:** `release.status_changed`, Calendar's release projection, NRMS's activity projection, the activity lookup and pre-fill in the release editor, the Forecast tab (§11) | Parent §10.2 e2e: Calendar activity → Forecast → draft → approve → schedule → publish → release status shown on the activity. |
| 5i | **Importer and parity check** (§12) | On the fixture: exactly the in-scope activities are imported with their legacy ids (post-cutoff ones, deleted included, plus every non-deleted awareness date); out-of-scope activities, their history and their favourites are not; only referenced or active users are imported; the report balances and a re-run changes nothing. On a legacy snapshot (Q50), every report matches legacy's for a date range after the cutoff (§12.3). |

## 4. Core: Calendar roles, ministry scope, HQ (5a)

- **Roles.**
  - `Calendar.ReadOnly`, `Calendar.Editor`, `Calendar.Advanced`, `Calendar.Administrator`, `Calendar.SysAdmin`, with levels 1–5 as legacy's `SecurityRole` enum (`Gcpe.Calendar.Library/Security/CustomPrincipal.cs:14`).
  - A user holds at most one Calendar role, as in legacy (`SystemUser.RoleId`). Granting one replaces the other.
  - Every check is "level ≥ n". Legacy's always-true `IsInRole(string)` overload is not ported.
- **Ministry scope:** a new `user_organizations` table (user id, organisation id), replacing `SystemUserMinistry`. These are the user's ministries, M(u) below. It applies only to Calendar roles; the NRMS and NoD roles stay flat.
- **HQ organisations:**
  - `organizations.is_hq` (boolean, default false), set by Core.Admin and carried on `org.upserted`.
  - A user is **HQ** when any organisation in M(u) has `is_hq` set.
  - This one flag replaces both legacy settings (C124). The BC seed sets it on GCPEHQ, GCPEMEDIA and PREM (Q49).
- **Who grants what:**
  - Core.Admin grants anything.
  - A Calendar.Administrator may set a user's Calendar role up to Administrator, and their ministries. Only a Calendar.SysAdmin or Core.Admin may grant SysAdmin (C125).
  - These grants go through Core's API. The Calendar users screen (§8.5) calls it.
- **Users without email (R12):**
  - `users.email` becomes nullable. A check constraint requires an email on every active user: `is_active = false OR email IS NOT NULL`. The unique index applies only where the email is set.
  - A user with no email can't sign in and can't be activated until one is set.
  - The admin "link" action on an inactive user sets the email and activates the user. Matching to Entra later uses that email.
- **Legacy ids:** a new `user_legacy_ids` table (system `calendar`, legacy `SystemUser.Id`, user id). It is unique per legacy id. Several legacy ids may point to one user when legacy emails repeat.
- **Calendar contact details** (phone, mobile, job title, description) belong to Calendar, not Core, because only the Calendar shows them (§5.4).
- **Event:** Core emits `user.upserted` on every user, grant or ministry change. The aggregate is the user id. The payload: id, email (nullable), display name, active, `calendarRole` (nullable), `organizationKeys` (organization keys, as every other event names organizations; `OrgRecord` carries no id). The Calendar keeps a projection of it.
- **Per-request checks in the Calendar:**
  - The session cookie gives the user id.
  - The Calendar's projection gives the role and ministries, so a revoked grant takes effect when its event arrives (normally seconds).
  - A user missing from the projection has no Calendar access.

## 5. Calendar app and data model (5b)

### 5.1 App

- **Location:** `apps/calendar`, mounted by the stack at `/calendar`, with its API under `/calendar/api`.
- **Conventions:** the same conventions as NRMS and NoD:
  - Express, Drizzle and zod, with its own database and migrations;
  - the outbox and dispatcher on the stack tick, and inbox dedupe;
  - the Core session cookie and the `X-GCPE-Request` CSRF header;
  - no local-admin route: the Calendar refuses bearer tokens, so staff reach it only through the Core session;
  - a dead-letter page.
- **Tick:** it registers a dispatch step, plus the lock-expiry sweep (§7.5).
- **Attachments:** stored through `packages/storage` under `CALENDAR_STORAGE_DIR`, outside the deploy folder. They are never under a public path. Downloads go through an authorised route (§8.4).
- **Rule 3 of the parent spec:** the Calendar starts and serves with Core and NRMS absent. Its projections are then empty, so nobody holds a Calendar role yet.
- **Tenant config** (`packages/config`, `calendar` section). BC values come from legacy and are listed so no legacy id or name is hard-coded in rules:
  - the freeze window and time zone (`16:00`, `17:00`, `America/Vancouver`);
  - release categories requiring Origin, Distribution and Comm Materials: ids 12 and 58;
  - City "Other…": id 311;
  - the comm material that marks an unconfirmed issue: id 61;
  - categories by name: "Awareness" (id 2, hidden from the default list), "HQ Placeholder", and "CONFIDENTIAL or EMBARGOED";
  - the consultations ministry: CITENG;
  - contact-ministry exclusions: UNK and BCWS (`Activity.aspx.cs:405-410`);
  - `SharedWithExcludes`;
  - the 25-language Translations default list (`Activity.aspx.cs:372`);
  - required-field switches: Significance and Scheduling on, Strategy off;
  - `ShowHqCommentsField` (off) and `ShowRecordsSection` (off) (Q51);
  - the Look Ahead cover image (`Resources/BC/LookAheadCover.jpg`);
  - the report banner text ("Province of BC", "DRAFT AND CONFIDENTIAL").

### 5.2 Tables

**Ids and formats:**
- Activities and every lookup keep their legacy integer ids. Sequences start above the imported maximum.
- Ministries, sectors, themes and tags are named by Core key (as every event names them), held
  in local projections (`orgs`, `terms`).
- Core keys are stored byte for byte; never case-folded. Legacy ministry keys are uppercase GUIDs,
  and Core matches keys exactly.
- People are Core user ids.
- Every time is stored in UTC and shown in BC time.

- **`activities`** (one row per legacy `calendar.Activity`, 64 columns, mapped as follows):
  - **Dates:**
    - `start_at`, `end_at`, `nr_at`;
    - `potential_dates` (≤70);
    - `is_all_day`, `is_confirmed`.
  - **Text:**
    - `title` (≤500 stored);
    - `details` (≤700), `schedule` (≤500), `significance` (≤500), `strategy` (≤500);
    - `comments` (≤4000, "Internal notes"), `hq_comments` (≤2000, "Executive Summary");
    - `lead_organization` (≤100), `venue` (≤150), `other_city` (≤150);
    - `translations` (text array of language names; legacy CSV).
  - **Classification:**
    - `status` (`new` | `changed` | `reviewed`; legacy ids 7, 1, 2);
    - `hq_status` (null | `new` | `changed`);
    - `hq_section` (`issues_and_reports` | `events_and_speeches` | `in_the_news` | `not_on_la`; legacy 1–4);
    - `long_term_outlook` (boolean; legacy negative `HqSection`);
    - `nr_distribution_id`, `premier_requested_id`.
  - **People and places:**
    - `contact_ministry_id`;
    - `government_representative_id`, `comm_contact_id`, `event_planner_id`, `videographer_id`;
    - `city_id`.
  - **Flags:** `is_issue`, `is_at_legislature`, `is_confidential` (labelled "Not for Look Ahead"), `is_cross_government`, `is_milestone` (labelled "Key activity").
  - **Deletion:** `deleted_at`, `deleted_by`. Legacy `IsActive = 0` is a deleted activity.
  - **Needs review:** `needs_review`, a set of the 23 field keys in §7.3, with a check constraint.
  - **Bookkeeping:**
    - `created_at`, `created_by`;
    - `last_updated_at`, `last_updated_by`, the displayed "updated X ago by", following legacy's rule (§7.5);
    - `version` (integer, incremented on every write).
- **Join tables.** Each is keyed (activity, value). Field history replaces legacy's per-row audit columns.
  - `activity_categories` (UI single-select; up to 2 imported);
  - `activity_comm_materials`, `activity_initiatives`;
  - `activity_keywords` ("HQ Tags");
  - `activity_nr_origins` (UI single-select);
  - `activity_sectors`, `activity_themes`, `activity_tags` ("News Subscribe"), all Core terms;
  - `activity_shared_with` (Core organisations).
- **`activity_files`:** id, activity, file name, content type, length, SHA-256, storage key, uploaded at and by. Legacy kept bytes and an MD5 in the database.
- **`favourites`:** user × activity (legacy `FavoriteActivity`, the watchlist).
- **Lookups.** Each has id, name, sort order and active, plus:
  - `categories`;
  - `cities`;
  - `comm_materials`;
  - `event_planners` (phone, job title);
  - `government_representatives` (description);
  - `initiatives` (short name);
  - `keywords` (free-form, created on save);
  - `nr_distributions`, `nr_origins`, `premier_requested`;
  - `videographers` ("Digital"; job title).

  Legacy junk header rows such as "LIST BELOW NOW OPTIONAL:" are imported as they are.
- **`comm_contacts`:** id, user, ministry, rank (1 Comm Director … 6 Other, `Admin/User.aspx.cs:16-25`), sort order, active. There is one per user × ministry, as legacy `CommunicationContact`.
- **`user_profiles`:** user id; phone (free text, legacy `NVARCHAR(20)`; no format check), mobile (legacy CHECK: empty, or 12 characters of `[0-9-]`), job title, description; the list "Display" choice (legacy `FilterDisplayValue`) and hidden columns (legacy `HiddenColumns`).
- **`saved_filters`:** id, owner, name (≤200), filter (JSON in the §8.1 filter model), sort order, active.
- **History:**
  - `activity_changes`: id, activity, at, actor (Core user id, nullable for legacy rows without one), actor name at the time, action (`created` | `updated` | `cloned` | `reviewed` | `deleted` | `transferred` | `la_status_cleared`), source (`calendar` | `legacy_log`), the contact ministry at the time;
  - `activity_change_fields`: change, field key, old display value, new display value.
- **`activity_locks`:** activity (primary key), user, tab id, acquired at, last active at (§7.5).
- **`release_links`:** the projection of `release.status_changed` (§11): release id, activity id, type, status, publish at, released at, reference, English headline, last sequence.
- **Projections:** `orgs` and `terms` (from `org.*`, `sector.*`, `theme.*`, `tag.*`); `users` (from `user.upserted`).
- **Not carried over:** `Priority`, `ActivityServices`, `NewsFeed`, `Role` (now Core), `Status` (now an enum), the `TimeStamp` rowversion and `RowGuid` columns, and the `ActiveActivities` view and `GetActivity*` functions. The list query (§8.1) replaces the view without its INNER JOIN (C147).

### 5.3 Lookup admin

- One generic screen lists, adds, edits, reorders and deactivates rows of any lookup.
- **Lock-down as legacy** (`Admin/DynamicData/PageTemplates/ListDetails.aspx.cs:34-70`):
  - SysAdmin only: categories, cities, comm materials, government representatives, NR distributions, NR origins, premier requested.
  - Administrator and above: event planners, initiatives, keywords, videographers.
- Comm contacts are edited on the users screen (§8.5).
- Ministries, sectors, themes and tags are Core's, edited in Core (C152).
- Every route checks the role on the server (C140).

### 5.4 Events added to `packages/events`

| Event | Producer → consumer | Payload |
|---|---|---|
| `user.upserted` | Core → Calendar | §4 |
| `org.upserted` (extended) | Core → all | adds `isHq` |
| `activity.created` / `activity.updated` | Calendar → NRMS | **For a non-confidential activity:** id, title, details, start, end, NR at, is all day, is confirmed, is deleted, contact ministry key, shared ministry keys, category names, city name, theme, tag and sector keys, translations. **For a confidential one:** only `{ id, isConfidential: true, isDeleted }`, so no confidential text leaves the Calendar (R2). |
| `activity.deleted` | Calendar → NRMS | id |
| `release.status_changed` | NRMS → Calendar | release id, key, reference, type, `activityId` (nullable), `previousActivityId` (nullable), status, publish at, released at, English headline |

`org.upserted` (extended) also adds `isPublic` (Q54).

The aggregate for `activity.*` is the activity id, and for `release.status_changed` the release id. Ordering uses the per-aggregate `sequence` (parent §4.1).

## 6. Access (one visibility rule)

Definitions:
- M(u) is the user's ministries.
- HQ(u) is true when u belongs to an HQ organisation.
- L(u) is the user's Calendar level, 1–5, or none.
- `shared(a)` is the activity's shared-with ministries.

```
inScope(u, a)      = HQ(u) or a.contact_ministry ∈ M(u) or shared(a) ∩ M(u) ≠ ∅
seesConfidential(u, a) = (HQ(u) and L(u) ≥ Advanced) or a.contact_ministry ∈ M(u) or shared(a) ∩ M(u) ≠ ∅
visible(u, a)      = L(u) is set
                     and inScope(u, a)
                     and (not a.is_confidential or seesConfidential(u, a))
                     and (a not deleted or (HQ(u) and L(u) ≥ Administrator))
```

- **Where it comes from:**
  - The matrix is legacy's list rule (`ActivityListProvider.ashx.cs:214-244`, `ActivityDAO.cs:261-291`).
  - Deleted activities are visible to HQ Administrators only, for review, as in legacy's default query (`ActivityDAO.cs:176-193`). They open in a read-only view with Review as the only action. Legacy redirected deleted activities to "does not exist".
  - "Cross-government" does not widen visibility, as in legacy.
- **One implementation, two forms:**
  - `visible()` is written once, as a TypeScript function and as a Drizzle SQL predicate.
  - A test checks that the two agree on a generated matrix.
  - Every reader uses one of them. No reader filters in memory after paging.
- **The readers:**
  - the list and its quick search, including search by numeric ID (C127);
  - the activity page;
  - the updates feed;
  - reports, the Excel export and attachments;
  - the history screen;
  - the favourites tooltip.
- **Not visible means 404,** never 403, so an id can't be probed.

**Capabilities.** Every one is checked on the server (C138–C141).

| Action | Who |
|---|---|
| Create | L ≥ Editor. Contact ministry ∈ M(u), or any active ministry if HQ (`Activity.aspx.cs:390-410`). |
| Edit, clone, add or remove attachments | L ≥ Editor and (HQ or contact ministry ∈ M(u)). Shared-with ministries can view only (`Activity.aspx.cs:1651-1683`). |
| Delete | L ≥ Administrator, with edit rights (`Activity.aspx.cs:1537-1544`). |
| Review (activity page) | HQ and L ≥ Advanced (`Activity.aspx.cs:1685-1686`). |
| Review selected (list) | HQ and L ≥ Administrator (`UCFlexiGrid.ascx.cs:21-27`). |
| Clear LA Status | HQ and L ≥ Editor (`Default.aspx.cs:44-53`). |
| Look Ahead fieldset (Executive Summary, LA status, section override, Long Term Outlook) | HQ and L ≥ Editor, or everyone with edit rights when `ShowHqCommentsField` is on. |
| Needs-review markup | Activity page: HQ and L ≥ Editor. List: HQ and L ≥ Administrator (`ActivityListProvider.ashx.cs:47-50`). |
| Look Ahead admin filter; corporate queries | HQ and L ≥ Advanced (`Default.aspx.cs:28-32`). |
| Exec Look Ahead | HQ and L ≥ Administrator. |
| Lookups, users, Transfer | L ≥ Administrator; locked lookups need SysAdmin (§5.3). |
| Saved filters | Owner only (C141). |
| Reports, Excel export, favourites | Any Calendar role; data limited by `visible()`. |

**"HQ" in these rules.** Legacy split it in two:
- **App owners** see all ministries and get the HQ report variant.
- **The HQAdmin ministry** (GCPEHQ) at Editor and above gets the freeze exemption, the Look Ahead fieldset, the "HQ Placeholder" category, relief from required Details, Significance and Scheduling, and the review markup.

Both now come from the one HQ flag (C124).

## 7. Activity rules (5c)

### 7.1 Actions

- **Create:**
  - Status becomes `new`.
  - Every field is saved, including NR date and Translations, which legacy's `Insert()` dropped (C145).
  - When the creator is neither HQ nor Administrator and above, `hq_comments` is set to `**`, as legacy does, to draw HQ's attention (`Activity.aspx.cs:1098-1102`).
  - A history entry `created` lists every set field.
- **Update:**
  - Applies the needs-review rules (§7.3).
  - Writes one `updated` change with a row for every field that changed. That covers every field, not legacy's seven (C133).
- **Clone** (`ActivityWebService.cs:72-140`):
  - Copies the activity, with `nr_at` cleared, `comments` empty and `hq_comments` set to `**`.
  - News Subscribe tags are dropped. Only the "30-60-90" keyword is kept.
  - Status becomes `new`.
  - A keyword that does not exist yet is created rather than crashing (C146).
  - The history entry `cloned` names the source id.
- **Delete:**
  - Sets `deleted_at` and the `active` needs-review flag (`ActivityManager.cs:77-92`).
  - Writes history.
- **Review** (`ActivityManager.cs:21-75`):
  - On a live activity, it checks the version, sets status `reviewed`, and clears the 22 field flags.
  - On a deleted activity, it clears only the `active` flag.
  - Writes history.
- **Review selected:**
  - The list sends each row's version. Rows changed since the list loaded are skipped and reported back, as legacy skipped rows changed after the grid loaded (`ActivityHandler.ashx.cs:177-193`).
- **Clear LA Status:**
  - Clears `hq_status` on every visible activity whose start is on or before today plus N days, including past ones, as legacy does (`ActivityHandler.ashx.cs:1258-1274`).
  - Writes one `la_status_cleared` history entry per changed activity.
- **Transfer** (`Admin/Transfer.aspx.cs:29-90`):
  - Moves every active activity from comm contact A to comm contact B, and sets the contact ministry to B's comm-contact ministry by id, not by parsing display text.
  - Writes a `transferred` history entry per activity. As legacy, it sets no needs-review flags and no status (C150).
- **Events:** every write also puts an `activity.*` event in the outbox in the same transaction.

### 7.2 Validation (server-side, one zod schema shared with the form; C156)

Legacy ran every rule below in the browser only.

- **Required on every save:**
  - Category, contact ministry, title, comm contact, start and end;
  - start and end times, unless all-day.
- **Required unless HQ:** Details. Significance and Scheduling are also required when their tenant switches are on (BC: on). Strategy is not (`Activity.aspx.cs:156-160,224-230`).
- **Cross-field rules:**
  - Categories 12 and 58 (Proposed and Approved Release) require Origin, Distribution and Comm Materials (`Activity.aspx:144-186`).
  - End ≥ start. On a single day, the start time ≤ the end time.
  - NR date ≤ end date.
  - Times fall on 5-minute steps.
  - Potential Dates may not contain TBC, TBD or any digit (`Activity.aspx:302-307`).
  - A confidential activity whose Look Ahead section is overridden needs an Executive Summary (`Activity.aspx:2419-2421`).
- **Length limits:**
  - Title 100, Summary 700, Executive Summary 2000, Internal notes 4000, Venue 55, Other City 55, Lead Org 80, and Significance, Scheduling and Strategy 500 each (`Activity.aspx:2630-2668,2788-2798`).
  - Limits apply to new values only. An imported value over a limit that the save does not change is accepted, because legacy data reaches 217 characters in Title (SV 4.5).
- **Imported data that breaks a rule:**
  - An activity with no comm contact (19), or one that ends before it starts (108), can be opened and read.
  - Its next save must fix the rule.
- **Warnings:** a start or end date in the past is a warning that doesn't block the save (`Activity.aspx:731`).
- **Text clean-up:** the title has line breaks replaced by spaces. Legacy's `ReplaceSpecialCharacters` clean-up applies on create as on update (C145).

### 7.3 Needs-review and status (R4; `Activity.aspx.cs:1125-1215`, `ActivityManager.cs:97-254`)

Any saving user can set flags and status, including HQ. Only HQ clears flags, through Review. Each row below is a test case.

| Change | Flag set | Status → `changed` |
|---|---|---|
| Title | `title` | yes |
| Details | `details` | yes |
| Representative | `representative` | yes |
| City or Other City | `city` | yes |
| Start | `start_date` | yes |
| Potential Dates | `start_date` | yes |
| End | `end_date` | yes |
| Category, Issue or Confidential | `categories` | yes |
| Comm materials | `comm_materials` | yes |
| Significance | `significance` | yes |
| Internal notes | `internal_notes` | yes |
| Scheduling | `scheduling_considerations` | yes |
| Strategy | `strategy` | yes |
| Lead organization | `lead_organization` | yes |
| Venue | `venue` | yes |
| Initiatives | `initiatives` | yes |
| HQ Tags (keywords): **the set** changes | `tags` | yes |
| NR Origin (including to empty) | `origin` | yes |
| Translations | `translations_required` | yes |
| Premier Requested **to a new non-empty value** | `premier_requested` | yes |
| Premier Requested cleared | none | yes |
| NR Distribution **to a new non-empty value** | `distribution` | yes |
| NR Distribution cleared | none | yes |
| Event planner **to a new non-empty value** | `event_planner` | yes |
| Digital (videographer) **to a new non-empty value** | `digital` | yes |
| Event planner or Digital cleared | none | no |
| Dates Confirmed, All Day, Cross-Government | none | yes |
| Contact ministry, comm contact, NR date, Look Ahead fields, At Legislature, Key activity, sectors, themes, News Subscribe tags, shared-with, attachments | none | no |
| Delete | `active` | no |

- The 23 flag keys:
  - `title`, `details`, `representative`, `city`, `start_date`, `end_date`, `categories`, `comm_materials`, `active`;
  - `significance`, `strategy`, `scheduling_considerations`, `internal_notes`, `lead_organization`, `initiatives`, `tags`, `origin`, `distribution`, `translations_required`, `premier_requested`, `venue`, `event_planner`, `digital`.
- The one change from legacy: keywords compare as sets. Legacy compared counts, so swapping one keyword for another raised nothing (C130).
- Create sets status `new` and no flags.
- Text comparisons use trimmed values, as legacy trims Significance, Scheduling and Strategy before comparing.

### 7.4 Change freeze (R1; C126)

- **When it applies:** every content write by a user who is not exempt:
  - create, update, clone and delete;
  - adding or removing an attachment;
  - taking an edit lock.
- **The window:** if the current BC time falls in `[CALENDAR_FREEZE_START, CALENDAR_FREEZE_END)`, the write is refused with HTTP 423 and legacy's message, using the configured times: "You cannot make content changes between 4pm-5pm…".
  - The default is `16:00`–`17:00`.
  - Equal start and end turn the freeze off.
  - It applies every day; legacy has no weekday or holiday rules.
- **Time zone:** evaluated in the tenant's IANA zone (`America/Vancouver`) with Node 24's tzdata (≥ 2026b), so BC's permanent UTC−7 from 2026-11-01 is handled.
- **Exempt:** HQ and L ≥ Editor.
- **Checked when saving,** not only when the page loads. An edit started at 15:58 and saved at 16:01 is refused. Legacy let it through.
- **Not frozen:** favourites, saved filters, column preferences, Review, Clear LA Status and Transfer. The last three are HQ or Administrator actions; legacy froze only the activity page.
- **UI:** the list shows a standing banner with the configured window, as legacy's grid did (`UCFlexiGrid.ascx:124`). During the window, the editor opens read-only for users who are not exempt.

### 7.5 Edit locks and concurrency (R3; C128, C129)

- **Taking a lock:** the first changed field in the editor calls `POST /activities/:id/lock` with the tab id. When nobody holds a live lock, the caller gets it.
- **Live lock:** one whose `last_active_at` is within 15 minutes.
- **Heartbeat:** while the user types or clicks, the editor sends a heartbeat at most once a minute. With no input for 15 minutes, the lock lapses.
- **Release:** on save, on cancel, on tab close (`navigator.sendBeacon`), or on lapse. The tick deletes lapsed rows. Only the holder's own release deletes a lock. Legacy deleted the latest "Edit" row, whoever owned it.
- **Someone else holds the lock:**
  - The editor shows "<display name> is editing this activity (since hh:mm)" and stays read-only.
  - It does not close the tab, as legacy did.
  - When the lock lapses, editing becomes available without a reload.
- **The same user in another tab:** the editor offers "Continue here", which moves the lock to this tab. Legacy locked the user out.
- **Saving while someone else holds a live lock:** refused with HTTP 423.
- **Idle for 15 minutes with unsaved changes:**
  - The lock lapses, and the editor says so.
  - The changes stay on the page, and Save still works if the version is unchanged. Legacy closed the tab and lost them.
- **Version:**
  - Every write sends the version it loaded. A stale one gets HTTP 409, "Someone else changed this activity — reload to see their changes".
  - Every write, including Review, Clear LA Status, Transfer and HQ edits, increments `version`. Bulk actions ignore locks, so an open editor's next save gets 409.
  - The staff app uses `useVersionedSave` and `UnsavedChangesBar`.
- **"Last updated by" display:** as legacy (`Activity.aspx.cs:1246-1252`), an HQ Administrator's edit to another ministry's activity does not change `last_updated_at`/`by`. The edit still increments `version`, so it can no longer be overwritten silently (C129).
- **After save:** the editor returns to where the user came from (list, feed or report link). Legacy closed the tab (C149).

### 7.6 Look Ahead section inference (`Activity.aspx:2466-2521`)

- **The rules,** in order. They run in a shared module used by the form and the server:
  1. Awareness category → Awareness Dates. Fixed; no override.
  2. Contact ministry is the consultations ministry → Consultations and Dialogues. Fixed.
  3. Confidential → Not on LA.
  4. Issue, and not an Approved, Proposed or Speech category → Issues & Reports.
  5. Unconfirmed, with the configured comm material (id 61) → Issues & Reports.
  6. Confirmed, or ending within 2 days → In the News. For the Approved, Proposed, Speech and HQ Placeholder categories → Events & Speeches.
- **Who sets the stored section:**
  - Users who see the Look Ahead fieldset may choose a different section, shown as an "override" in gold, and may tick Long Term Outlook.
  - For everyone else the server stores the inferred section on every save, as legacy's hidden fieldset did.
- **Mapping:** legacy `HqSection` 1–4 maps to the four sections. A negative value maps to that section plus `long_term_outlook`. The 3,034 rows at −4 (SV 4.3) become `not_on_la` with Long Term Outlook set.

## 8. Staff screens (5d, 5e; 5a–5c admin)

The Calendar section is part of `apps/staff-web` under `/hub/calendar`. It has the same shell, BC design system, React Router, per-section `access.ts` role helpers, and axe and Playwright standards as Phases 3 and 4. The section appears for users with a Calendar role.

### 8.1 List (`Default.aspx`, `ActivityListProvider.ashx.cs`, `UCFlexiGrid.ascx(.cs)`)

- **Filters** (`Default.aspx:524-620`):
  - **Dates:** from and to, and "This day only". Dates before 2011 are clamped (`ActivityDAO.cs:172-173`).
  - **Quick search:** a number matches the ID, within `visible()`. Otherwise it searches Title, Details, City, Translations, Significance, Comments, Lead Org, Strategy, Executive Summary, Schedule and Venue (`ActivityDAO.cs:101-117`).
  - **HQ Tags:** keywords, OR logic.
  - Issue; Date Confirmed, which always includes timed single-day items (`ActivityDAO.cs:198`); Status; Category; Lead Ministry; Comm Contact; Representative; Initiative; Premier Requested; Distribution.
  - The default list hides the Awareness category and the consultations ministry unless a filter names them (`ActivityListProvider.ashx.cs:90-91`).
- **Display:** Show All, My Ministries' Only, My Activities Only (as comm contact), My Watchlist. The choice is saved per user.
- **Columns** (`UCFlexiGrid.ascx.cs:255-274`):
  - **Activity Id cell:** icons for watched, reviewed, shared and release, then `MIN-Id`, "updated X ago by" and "created <date>";
  - HQ Tags, Ministry, Status (+ LA status), Date & Time, Title & Summary (significance on hover), Categories, Comm Materials (origins and distribution on hover), Premier, Lead Org, Translations, City (+ venue), Comm Contact (name and phone), Govt Rep;
  - HQ Tags, Ministry, Status and Translations are hidden by default. Each user's column choice is saved.
- **Sorting and loading:** sort by any sortable column, with the start date as the secondary sort. Rows load 30 at a time as the user scrolls, as legacy did. Visibility is part of the SQL query.
- **Saved filters ("My Queries"):** save, apply, rename, reorder and delete, by the owner only. A filter is stored in the list's own filter model. Imported legacy query strings are converted (§12).
- **Watchlist:** add or remove from the activity page. The star tooltip lists the display names of the watchers, as legacy does (`Activity.aspx.cs:1519-1535`).
- **Calendar view:** a month and week view of the current filter, replacing legacy's FullCalendar toggle (`Default.aspx:191-262`).
- **Corporate queries** (HQ, L ≥ Advanced): status, LA status, deleted, and the next N days (`Default.aspx:628-660`, `ActivityDAO.cs:306-368`).
- **Look Ahead admin filter:** show all, Look Ahead only, or Not for Look Ahead only, applied inside `visible()` (C127).
- **Toolbar:** Review selected; Clear LA Status; Excel Export; Look Ahead, Exec Look Ahead, 30/60/90 and Planning, each as PDF or Word.
- **Excel export** (`ActivityHandler.ashx.cs:392-527`):
  - an `.xlsx` workbook with legacy's header lines ("Province of BC. Corporate Calendar DRAFT & CONFIDENTIAL", the date range, "Printed:");
  - the same 16 columns;
  - the red confidentiality footer;
  - visible rows only, with formula-like cells made inert (C151).

### 8.2 Editor (`Activity.aspx`, `Activity.aspx.cs`, `Scripts/activityhelper.ts`)

One page with legacy's fieldsets, in legacy's order:
- **Overview:** Category, Not for Look Ahead, Title, Summary, Issue, Significance, Lead Organization, HQ Initiatives & Leads, HQ Tags.
- **Planning:** Comm Contact, Key activity, Strategy, Comm Materials, Internal notes.
- **Ministry:** Lead Ministry, Cross-Government, Shared With (every active ministry minus the excludes; saving replaces the whole set).
- **Look Ahead:** Executive Summary, LA Status, LA Section with inferred value and override, Long Term Outlook. Shown per §6.
- **Schedule:**
  - Start and End date and time in 5-minute steps, defaulting to 8:00 AM–6:00 PM;
  - All Day, Dates Confirmed;
  - **Potential Dates**, now shown (C136);
  - Scheduling considerations.
- **Release:**
  - Release Time (NR date and time), Origin, Distribution, Translations Required, Sectors, Themes, News Subscribe;
  - "BC Gov News", the linked releases (§11).
  - The fieldset is hidden for the categories legacy hides it for (`activityhelper.ts:170-196`).
- **Event:** Premier Requested, Representative, At BC Legislature, City, Other City (when City is "Other…"), Venue, Event Planner, Digital.
- **Records:** attachments (§8.4). Shown when `ShowRecordsSection` is on or the activity already has files, as legacy (`Activity.aspx.cs:261-262,880-886`; Q51).

**Behaviour:**
- **Actions:** Save, Review, Delete, Clone, Watchlist, Cancel, and View changes.
- **Markup:** HQ users see changed fields marked as legacy does (`Markup()` at `Activity.aspx.cs:1071-1074`).
- **Freeze and lock:** the editor shows the freeze state and the lock state (§7.4, §7.5).
- **Validation:** the editor runs the shared validation and shows server errors against their fields.

### 8.3 View changes (R7; C133)

- Opens from the editor. It lists the activity's `activity_changes`, newest first.
- Each entry shows when, who, the action, and each field's old → new value.
- Imported legacy entries are marked "from legacy log".
- Visible to anyone who can see the activity.

### 8.4 Attachments (Records)

- **Upload:**
  - several files per save;
  - empty files refused;
  - legacy's extension blocklist kept (`Activity.aspx.cs:1274-1391`);
  - content checked against the claimed type (`packages/storage` sniffing, as NRMS);
  - 25 MB per file (C153);
  - a file with the same name replaces the old one, as legacy (`Activity.aspx.cs:1436-1437`).
- **Delete:** removing a file from the list.
- **Download:** `GET /calendar/api/activities/:id/files/:fileId`, checked against `visible()`. A file of an activity the user can't see is a 404 (C138). It is served with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
- **History:** adding and removing files write history. They raise no needs-review flag, as legacy.

### 8.5 Users and Transfer (L ≥ Administrator)

- **User list:** active user × ministry rows, as legacy `Admin/UserList.aspx.cs:15-39`: "Full name (Abbreviation) (comm-contact rank)". Inactive users, including the no-email ones, appear under a filter.
- **User page:**
  - **Edited here** (`user_profiles`): phone, mobile, job title, description.
  - **Edited through Core's API:** the Calendar role, ministries, and active.
  - **Per ministry:** the comm-contact rank, which creates or updates the `comm_contacts` row (`Admin/User.aspx.cs:346-640`).
  - **Deactivating** lists the user's open activities first, as legacy (`User.aspx:183-223`).
  - **Link:** sets the email of an imported no-email user and activates them (R12).
  - Legacy's AD/LDAP "Verify" button is not built (C155).
- **Transfer:** pick comm contact A and comm contact B, preview the count, confirm (§7.1).

## 9. Updates feed (5f)

### 9.1 Updates feed (`History.aspx`, `CorporateCalendarUpdateWebService.asmx.cs`)

- **Source:** built from `activity_changes` with source `calendar`, so it starts empty at cutover (C135).
- **Modes, as legacy:**
  - **Latest 5 updates.**
  - **Today's updates.**
  - **Date range,** with a type filter (added, changed, reviewed, deleted, cloned) and a keyword search over title and details. A number above 10,000 in the keyword box switches to that activity's feed, within `visible()`.
  - **Per activity.**
  - At most 1,000 rows per request.
  - Legacy had no "since last visit" mode, and none is built (§17).
- **Each item:** the action, the `MIN-Id` link, the title, start and end, the actor's display name, and the time. The details appear in the tooltip.
- **Not shown:** the actor's email. Legacy embedded a `mailto` link in stored HTML (C135).
- **Scope:** `visible()`, which drops confidential items legacy showed (C127).

## 10. Reports (5g; R6)

Every report:
- **Input:** takes the list's current filter and sort, applies `visible()`, and orders by start date, then end date, then start time (`ActivityHandler.ashx.cs:36-53`).
- **Output:** renders one HTML template per report, and converts it to PDF or Word on request: `GET /calendar/api/reports/:report?format=pdf|docx&<filter>`.
- **Links:** links each `MIN-Id` to the activity in the staff app.
- **Times:** shows them in BC time.
- **Per request:** builds the report from per-request state. Legacy's static `isDetailedLookAheadReport` let concurrent requests race (`ActivityHandler.ashx.cs:20,112`).

### 10.1 Rendering spike (in 5b, before 5g is planned)

- **The question:** how to turn one HTML template into both PDF and Word on both hosts, SiteGround (boxs.ca) and an OpenShift-like container.
- **Candidates to test:**
  - headless Chromium printing for PDF;
  - an HTML→DOCX converter for Word.
- **Assumed, not verified:**
  - Chromium runs on SiteGround's Node hosting.
  - Chromium honours `@page :first` margins and a different first-page header.
  - The DOCX converter supports running headers and footers with "Page X of Y".
- **The spike renders three samples:** a Look Ahead cover and legend, one Events day table, and one Planning page.
- **What it must show** for each sample:
  - Letter portrait and Legal landscape (35.56 × 21.59 cm);
  - a page-1 header that differs from later pages;
  - "Page X of Y";
  - coloured header cells and alternating row shading;
  - forced page breaks;
  - the time taken for a 60-day Look Ahead from a 1,106-activity fixture, the live window's size (SV 4.2).
- **The result** is a short report in the plan folder.
- **If either format fails on either host,** the measured alternatives go to Paul before 5g is planned. The HTML templates stay the source either way.

### 10.2 Look Ahead (`Reports/LookAheadReport.rdlc` and its subreports; Letter portrait)

- **Range:**
  - Starts at the filter's from date, or today.
  - With no to date, it runs 60 days (start + 59) and includes the Long Term Outlook.
  - "This day only" gives a single day.
- **Title:** "dddd, MMM. d[, yyyy] to dddd, MMM. d, yyyy".
- **Running text:**
  - **Page 1:** "DRAFT ONLY - NOT FOR CIRCULATION / Information is confidential and subject to change".
  - **Later pages:** "DRAFT AND CONFIDENTIAL" in brown, with the province name.
  - **Footer:** "Updated dddd, MMM d, yyyy h:mm tt"; the note '"CHANGED" applies to major detail or date changes only (not time switches)'; "Page X of Y".
- **Sections, in order:**
  1. **Cover:** the cover image, the title, and the "Contents:" legend with colours: Events, Speeches and Releases (Inside Government) `#558abd`; Issues and Reports `#ccc0d9`; Consultations and Dialogues `#daeef3`; In the News (Outside Government) `#e8f3a9`; Awareness Dates `#eaf1dd`; Long Term Outlook `#edf2f8`, when included.
  2. **"Inside Government":** per day, **Events, Speeches & Releases**.
     - Columns: Date (+ flag) | Lead | Activity/Details | RLS | CC ID#.
     - Header `#558abd`; alternate rows light grey; "No Activities for <date>" on an empty day.
     - **Page breaks:** for HQ, a break after every day except Saturday, unless more than 16 rows have accumulated. For everyone else, only at the end (`ActivityHandler.ashx.cs:721-726`).
  3. **Issues and Reports:** Date | CC ID# | Activity/Details | Category | Rls. Header `#f2dbdb`; Issue rows purple.
  4. **Consultations and Dialogues:** confirmed activities of the consultations ministry. The date column shows "Ongoing" when the end is a year or more away, otherwise "Closes <date>".
  5. **"Outside Government":** per day, **In the News**. The Category column shows Issue, FYI or TV-Radio.
  6. A page break, then **Awareness Dates:** activities in the Awareness category, showing the title only.
  7. **Long Term Outlook:** activities starting after from + 60 days. For HQ, only those marked Long Term Outlook. Header `#9e3a38`.
- **Selection** (`ActivityHandler.ashx.cs:899-1068`):
  - Rows are skipped when they belong to Awareness, Consultations or Outlook, or when they are confidential and `not_on_la`.
  - `events_and_speeches` → Events; `in_the_news` → In the News.
  - **Issues:** for HQ, `issues_and_reports`. For everyone else: not Not-for-Look-Ahead, not confirmed, and spanning 5 days or more.
  - **Order within a day:** time-TBD and multi-day items go first in Events and last in In the News.
- **Row text:**
  - **HQ:** the Executive Summary, with `**bold**` and `_italic_`.
  - **Everyone else:** "**City - Title**: Details", with a red "Not for Look Ahead" prefix where it applies, and initiative short names in sea-green.
- **Flag:** NEW or CHANGED (LA status) in orange, on the start day only.
- **RLS column** (`ActivityHandler.ashx.cs:1176-1257`). The first match wins:
  - **Comm material:** News Release → NR; Information Bulletin → IB; Opinion Editorial → OpEd; Report → Report (In the News only); Statement → STMT; Traffic Advisory → TA; News You Can Use → NYCU; **Fact Sheet or Factsheet → Fact Sheet** (C148); Newsletter → e-news (In the News only).
  - **Origin**, shown above the material: Ministry → BCGov; Joint → Joint; 3rd party → 3rd party; Federal → Fed.
  - **NR time** is added when it differs from the start and falls on that day.
  - An empty cell shows "-".
- **Cover image:** the tenant's Look Ahead cover (BC: legacy `LookAheadCover.jpg`).

### 10.3 Exec Look Ahead (HQ, L ≥ Administrator)

- The Look Ahead with `Detailed` on, over one month (`ActivityHandler.ashx.cs:640-661`).
- Row text is the Title + Details + Significance + "City: Venue" + "Last updated today/yesterday at …".
- Issues are highlighted (`ActivityHandler.ashx.cs:984-1035,1061`).

### 10.4 30/60/90 (`Reports/Main30_60_90Report.rdlc`, `Monthly30_60_90Subreport.rdlc`; Letter)

- **Range:** the start snaps to the first of the month and the end is start + 90 days. One group per month while the month start is on or before the end, so 3 or 4 months, as legacy.
- **Title:** "30 / 60 / 90 REPORT", with legacy's never-set ministry prefix left blank.
- **Running text:** "DRAFT AND CONFIDENTIAL", "Updated …", "Page X of Y".
- **Per month:** the month heading, then a table with a teal `#35989d` header:
  - DATE (friendly range);
  - TOPIC: bold "City - Title: details", then "*Significance:* …" at 9 pt;
  - STRATEGY/COMM MATERIALS;
  - ID/CONT: `MIN-Id`, the comm contact, "created/updated X ago".
- **Rows:** Issue rows are purple. An activity spanning two months appears once, in its first month.

### 10.5 Planning (`Reports/PlanningReport.rdlc`; Legal landscape)

- **Title:** "GCPE Corporate Calendar: Schedule of Activities", with "DRAFT AND CONFIDENTIAL", "Updated <time>" and "Page X of Y".
- **Columns** (`ActivityHandler.ashx.cs:545-610`):
  - **Schedule:** date range, scheduling notes, Premier Requested, and HQ Tags sorted with "HQ…" tags first.
  - **Title & Summary:** "**City - Title**", the red "Not for Look Ahead" prefix, and the details.
  - **Significance:** "**Issue**" or "FYI Only", then the significance.
  - **CC ID#:** `MIN-Id`, then "created/updated X ago" at 9 pt.
- **Rows** follow the list's order.

## 11. NRMS link and Forecast (5h; R11)

- **`release.status_changed`:**
  - **When NRMS emits it:** at every status write (`apps/nrms/src/releases/workflow.ts`, `publisher.ts`, `service.ts` delete) and whenever a release's `activity_id` changes. In the second case `previousActivityId` lets the Calendar drop the old link.
  - **Backfill:** a one-off `npm run nrms:replay-activity-links` sends it for every release with an activity id: 19,046 at legacy volume (SV 4.17). Only those linked to imported activities create links in the Calendar.
- **On the activity:**
  - The "BC Gov News" list and the list's release icon read `release_links`. Each entry shows the type colour, the document type, the status and its date.
  - Users with an NRMS role also get a link to the release in the staff app. Everyone else sees no link and no download.
  - Legacy streamed the release PDF to anyone (`ReleaseDownloadHandler.ashx.cs:17-51`; C143).
- **NRMS's activity projection:**
  - `calendar_activities` is fed by `activity.*`. Confidential activities are held as id-only records, kept so that typed ids still resolve.
  - The `activity.*` replay for imported data is `npm run calendar:replay-to-nrms` (§12).
- **Activity lookup in the release editor** (`News/Services.asmx.cs:76-140`):
  - Entering an activity id looks it up in the projection.
  - **Pre-fill:** when the activity is not deleted, not confidential, has not ended (end ≥ today), and has a category starting with "Approved", the editor offers legacy's pre-fill: publish date from the start, location from the city, lead ministry, shared ministries, themes, tags and sectors (`News/ReleaseManagement/New.aspx:625-700`).
  - The release shows the activity's Translations as "translations required" (`ReleaseModel.cs:530-541`).
  - **Saving an id:** any id the projection knows can be saved, as legacy's text box allowed. Unknown ids are refused. Legacy saved any number (C142).
  - The "not deleted" check is new; legacy's lookup didn't check it (C142).
- **Forecast tab** (NRMS; `News/ReleaseManagement/ReleasesModel.cs:144-230`; closes C15 except the Forecast iCal):
  - **Future releases:** every non-deleted release with `publish_at ≥ now`.
  - **Eligible activities:** start ≥ now, not confidential, confirmed, not deleted, a category starting with "Approved", and not linked to one of those future releases. Each is shown at `nr_at`, or at its start when there is none.
  - Sorted by time, with the release or activity title, ministry, location and status.
  - The rule is evaluated by NRMS at read time, because "future" changes by the minute.
- **Forecast iCal:** deferred with the Calendar's iCal (R5, C131); its design is in Appendix A.
- **Releases linked to activities that weren't imported** (R13, C158):
  - NRMS keeps the number it imported in Phase 3, so search by activity id still finds the release.
  - The release editor shows it as "Legacy activity <id>, not migrated", with no lookup or pre-fill. A new unknown id is still refused (C142); the stored one stands until someone changes it.
  - The Calendar ignores `release.status_changed` for an activity it doesn't hold, and counts it in the replay's report.

## 12. Importer and parity check (5i)

### 12.1 Import (`npm run calendar:import -- --cutoff <date>`, run from a full checkout like `nrms:import`)

**Scope (R13, C157).** An activity is imported when either of these holds:
1. **Post-cutoff:** it ends on or after 00:00 BC time on the cutoff date (or starts on or after it, when it has no end). Deleted ones are included, so HQ can still review deletions.
   - `--cutoff` is required and has no default; the date is the swearing-in after the 2026 election, still to be set (Q53).
   - Ending on or after the cutoff brings in activities that started before it and are still running.
2. **Awareness history:** it carries the awareness category "Awareness Day / Week / Month" (id 2; `ActivityHandler.ashx.cs:857`, `Activity.aspx:2471`), at any date, and is not deleted. The category list is a tenant setting (Q52).

Everything below is limited to that set. Every imported activity keeps its legacy id.


- **Reading:** reads SQL Server through `@gcpe/legacy-import` (`LegacySource`, `-- name:` queries, a fake source for tests). Legacy local times convert with `wallClockToInstant` (Pacific).
- **Order:**
  1. **Users into Core.** A `SystemUser` is imported only when it is:
     - currently active; or
     - referenced by an imported activity (creator, last updater, comm contact), by an imported comm contact, by an imported saved filter, or by an imported favourite.

     Log actors who are not otherwise imported keep their name on the history entry, with no user.
     - **Matching:** a `SystemUser` is matched to an existing Core user by email, case-insensitive. Otherwise a user is created. `SystemUserMinistry` rows become `user_organizations`, and `RoleId` becomes the Calendar role. Every legacy id goes into `user_legacy_ids`.
     - **Active:** only when legacy `IsActive` is set and there is an email. An imported user with no email is imported inactive (R12, C144).
     - **Duplicate legacy emails** map to one Core user, and the report lists them.
  2. **Lookups,** all of them, keeping their ids. **Comm contacts:** active ones, and those referenced by imported activities.
  3. **Activities, keeping their ids:**
     - every in-scope activity, including any of the 19 with no comm contact (C147);
     - the needs-review flags become the `needs_review` set;
     - `HqSection` maps per §7.6.
  4. **Join rows:**
     - ministries, sectors, themes and tags map by their legacy GUIDs to Core;
     - a GUID Core doesn't know stops the run, naming it ("fix Core first"). The survey shows two such ministry GUIDs (SV 4.11).
  5. **Favourites** on imported activities; **profiles** of imported users; **active saved filters:**
     - Legacy query strings are converted to the new filter model. The 91 stale `ActivityListProvider.aspx…`-prefixed keys have the prefix stripped.
     - An unmappable parameter is dropped. The filter is kept and reported.
  6. **Attachments** of imported activities: the bytes go into storage. The legacy MD5 is checked against the bytes.
  7. **History** (R8, C134):
     - Only for imported activities. Each `calendar.Log` row with Operation "Update" becomes a field change. Rows with the same activity, user and second form one `updated` change.
     - Id values (city, comm contact, ministry) are resolved to names. An unknown id keeps its raw value.
     - **Skipped and counted:** "Edit" rows (lock noise; 116,031) and the 2,095 rows for the dropped `PriorityId`.
- **Sequences:** set above the maximum id in each table.
- **Not imported:** `NewsFeed` (R8); `Priority` and `ActivityServices` (R9).
- **Safety:**
  1. The import writes no outbox events.
  2. `npm run calendar:replay-to-nrms` then sends `activity.updated` for every imported activity, in batches, so NRMS's projection fills.
  3. A re-run upserts by legacy id. It skips rows changed in the Calendar since the last import (version above the imported version) and lists them.
  4. Every run writes a report:
     - legacy and Calendar counts per table, with out-of-scope rows counted separately (activities, their history, favourites and attachments, release links);
     - skipped rows with reasons;
     - activities that break the new validation (imported anyway; fixed on next save).

### 12.2 Fixtures

Synthetic rows shaped by the `.sqlproj` schema, using real legacy values:
- status ids 1, 2 and 7;
- `HqSection` −4 to 4;
- City 311; categories 2, 12 and 58;
- the junk lookup rows;
- a 217-character title;
- an activity with no comm contact, and one that ends before it starts;
- a user with no email, and two users sharing an email;
- Edit and Priority log rows;
- a stale saved filter;
- a confidential activity shared with another ministry;
- activities on both sides of a cutoff, one spanning it, and awareness dates before it (one deleted);
- a release linked to an activity before the cutoff;
- inactive users who are and aren't referenced by in-scope data.

They hold no real names or addresses.

### 12.3 Report parity check

`npm run calendar:report-parity -- --from <date> --to <date> --filter <json> --legacy-dir <folder>`. The range must start on or after the import cutoff, so both sides hold the same activities. The awareness history adds only Awareness Dates rows, which legacy also shows. The check:
- builds every report as PDF and Word from the imported data;
- extracts the text of each, and of legacy's PDFs for the same range and filter;
- compares, per section, the sequence of `MIN-Id`s, the date headings, each row's flag and RLS code, and the row text with whitespace normalised;
- writes a diff report.

Layout is compared by eye, side by side, against Q48's standard.

**What it needs:** the legacy PDFs and a legacy database snapshot taken at the same moment, because "Updated" times and live edits would otherwise differ (Q50).

**Passes when:** every activity appears in the same section, order, flag and RLS code as legacy, and every text difference is explained by a C-row.

### 12.4 Legacy read-only access (R14; Phase 7)

- **The requirement:** one HQ administrator keeps read-only access to the legacy Corporate Calendar for one year after cutover. It is the only way to see activities, history and release links outside the import scope.
- **Who owns it:** Phase 7 decommissioning. Phase 5 builds nothing for it.
- **What Phase 5 does:** the 5i exit notes the requirement in the running notes and in the cutover checklist.

## 13. Data volumes (legacy survey counts)

Counts only; these size the design. "Live window" means an activity that started 30 days ago or later. All counts are of the whole legacy database. The imported set (R13) is estimated in the first row.

| What | Count | Design consequence |
|---|---|---|
| **Imported set (estimate)** | About 7,800 activities at most: about 1,100 post-cutoff (the live window today is 1,106, SV 4.2) plus about 6,700 awareness dates. The awareness count is 6,737 category links in SV 4.10. Those links include deleted activities and some in the live window, so the true figure is lower. The exact number depends on the cutoff (Q53) and is counted in the first import report. | Small enough that list and report timings are set by growth, not by the import. |
| Activities | 83,607 in total. 71,171 active and 12,436 deleted. Reviewed 75,888, Changed 5,726, New 1,993 (SV 4.1). | The whole table is the legacy side of the parity check and the source of the import; only R13's subset is imported. Visibility and paging run in SQL, with indexes on start, end and contact ministry. |
| Activities per year | About 6,000–8,200 a year in 2012–2018; about 4,100–4,700 a year in 2020–2025; 3,699 in 2026 so far (SV 4.1) | A 60-day Look Ahead covers about 700–800 activities. Growth of about 4,500 a year sizes the 50,000-row list fixture (5d). |
| Live window | 1,106 activities, 37 of them confidential (SV 4.2) | The report spike's fixture size. |
| Confidential | 2,547 (3.0%) all time; 148 (1.7%) in the last 2 years | — |
| Needs-review flags still set | Title 932, Details 1,820, Start 1,474, End 1,535; every other flag under 300 (SV 4.4) | Imported as they are. |
| `HqSection` | 2 → 43,894; 3 → 21,604; 4 → 7,619; 1 → 6,768; negatives → 3,722, of which −4 → 3,034 (SV 4.3) | §7.6 mapping. |
| Multi-value fields (max) | Comm materials 35; shared-with 32; themes 15; keywords 10 (40,077 activities have any); sectors 7; tags 6; initiatives 5; NR origins 5; categories 2 (SV 4.9) | Join tables, not CSV strings. |
| Data quirks | 108 end before they start; 19 have no comm contact; Title up to 217 characters; 145 have Potential Dates; 16,197 have an NR date (SV 4.5) | §7.2, §12.1. |
| Lookups | Categories 56 (14 active); cities 330; comm contacts 2,768 (1,201 active); keywords 336 (81 active); government representatives 335 (105 active) (SV 4.7) | Imported with ids. |
| Users | 1,251 in total, 471 active; about 470 or more will be imported (the active users plus inactive users referenced by in-scope data). Active by role: ReadOnly 132, Editor 233, Advanced 69, Administrator 29, SysAdmin 8. 429 users have 1 ministry, 38 have 2, one has 23 (SV 4.13). | Core grants and `user_organizations`. |
| Saved filters | 1,018 (682 active), 91 with stale keys (SV 4.14) | Converted with a report. |
| Favourites | 3,872, from 121 users | — |
| `calendar.Log` | 588,969 rows: 472,938 Update and 116,031 Edit; about 50,000 a year recently (SV 4.15) | Only rows of imported activities become history. Their count per activity isn't surveyed, so it is counted in the first import report. |
| `NewsFeed` | 888,404 rows (SV 4.16) | Not imported. |
| Attachments | 12 files, 2.0 MB; largest 580,989 bytes (SV 4.12) | Storage is trivial. The 25 MB cap is far above use. |
| Linked releases | 19,046 releases linked to 16,612 activities, with no orphans (SV 4.17, 4.18) | The size of the backfill replay. Most link to pre-cutoff activities, so those links are lost (C158). |

**Not surveyed:**
- `SystemUser` rows with no email or a duplicate email;
- the minimum and maximum activity id;
- comm contacts pointing at inactive users;
- awareness-date activities that are not deleted, and log rows per activity.

The importer's report counts them on its first run.

## 14. Changes from legacy (rows for `docs/parity/changes-from-legacy.md`, new "Corporate Calendar (Phase 5)" section)

| # | Legacy | New | Why | Status |
|---|---|---|---|---|
| C124 | Two settings: `ApplicationOwnerOrganizations` (a CSV whose members see every ministry and get the HQ report variant) and `HQAdmin` (one ministry, GCPEHQ, whose Editor-and-above members get the freeze exemption, the Look Ahead fieldset, relaxed required fields and review markup). | One `is_hq` flag on Core organisations. A member of any HQ organisation gets all of these. | One concept for staff and admins. Paul's decision R1 defines the exemption by HQ membership. | Agreed (Q49) |
| C125 | Roles and ministries lived in `calendar.SystemUser`. Any admin page user could set any role, including SysAdmin, and the admin pages had no server gate. | Calendar roles and ministries are Core grants. Calendar.Administrator grants up to Administrator; only SysAdmin or Core.Admin grants SysAdmin. | One user store; no self-escalation to SysAdmin. | Agreed |
| C126 | Freeze 04:05–17:00 on the server by mistake. The browser compared times as strings, giving about 16:05–17:00 and 04:05–05:00. Never checked on save. | 16:00–17:00 BC time (configurable), every day, checked on every content write on the server, including saves. HQ Editor+ exempt. | R1; parent §8.2. | Agreed |
| C127 | Confidential items leaked through the activity page, the iCal feed (now deferred, C131), the updates feed, quick search by ID (>10,000, which also skipped ministry scope), the Excel export, and the Look Ahead filter parameter. | One `visible()` rule applied by every reader; not visible means 404. | R2. | Agreed |
| C128 | A lock was the latest "Edit" `Log` row, with no expiry. Anyone's cancel deleted it. A second tab locked out its own user. Idle closed the tab and lost changes. | A lock row with owner, tab and last activity. It lapses after 15 minutes without input, is released only by its holder, and can be moved between the holder's tabs. Idle keeps unsaved changes. | R3. | Agreed |
| C129 | Concurrency used `LastUpdatedDateTime`, which HQ Administrators' edits to other ministries skipped, so a ministry user could overwrite them silently. | A `version` on every write, for everyone (HTTP 409 when stale). The displayed "last updated by" still follows legacy's HQ rule. | R3. | Agreed |
| C130 | The keyword (HQ Tags) needs-review check compared counts only (`Activity.aspx.cs:1178`). | Compares the sets. | Legacy data bug (Paul, 2026-10-07). | Agreed |
| C131 | "Connect to Outlook" gave a Windows-auth iCal feed of the user's activities (confidential included), and NRMS had a Forecast iCal. | Not built initially; legacy usage unknown; can be added later. The design is kept in Appendix A. | R5 (revised, Paul, 2026-10-07). | Agreed |
| C132 | Reports as RDLC through ReportViewer. The UI offered PDF; Word only by editing the URL. | Each report offered as PDF and Word, from HTML templates. Layouts and filters as legacy. | R6. | Agreed (Q48) |
| C133 | `calendar.Log` recorded 7 fields and was never shown. | Every field change is recorded with actor and old and new values, shown on "View changes". | R7; parent §8.3. | Agreed |
| C134 | — | `calendar.Log` "Update" rows of imported activities are imported as history. "Edit" rows (116,031) and `PriorityId` rows (2,095) are not. | R8, R13. | Agreed |
| C135 | The updates feed read `NewsFeed`, pre-rendered HTML with the actor's name and `mailto` email. | The feed is built from structured history: no stored HTML, no email. `NewsFeed` is not imported, so the feed starts at cutover. Older changes stay on each activity's "View changes". | R8: a derived log full of personal information. | Agreed |
| C136 | Potential Dates was always hidden in the UI (`Activity.aspx:1201,2332`). | Shown and editable in Schedule, with legacy's validation and needs-review rule. | R9. | Agreed |
| C137 | `Priority` and `ActivityServices` tables (stale script only). | Not built or imported. | R9: dead. | Agreed |
| C138 | Attachments downloaded by id with no check. `DeleteSelected` had no role check (and no screen). | Downloads checked against `visible()`. Bulk delete not built. | R10. | Agreed |
| C139 | `ReviewSelected` and `ClearLAStatus` had no server role check. | HQ Administrator+ and HQ Editor+ respectively, on the server. | R10. | Agreed |
| C140 | Admin pages (users, Transfer, lookups) were hidden only by their menu link. | Every admin route checks the role on the server. | R10. | Agreed |
| C141 | Saved filters could be renamed or deleted by anyone (`ActivityFilter.asmx.cs:59-115`). | Owner only. | R10. | Agreed |
| C142 | The release form's activity id was a free number. The lookup didn't check deletion. | The lookup also requires a non-deleted activity. Unknown ids are refused. | A link to an id that matches no activity shows nowhere in the Calendar; a deleted activity can't be planned against. | Agreed |
| C143 | NRMS read the Calendar database directly. The release PDF downloaded for anyone (`ReleaseDownloadHandler.ashx.cs`). | `release.status_changed` keeps a release list per activity. Links only for users with an NRMS role. The Forecast tab is built in NRMS, closing C15 except its iCal (C131). | R11; parent §3.1 rule 2; R10. | Agreed |
| C144 | — | Only users who are active or referenced by imported data are imported. Those without email become inactive Core users; they keep their activities, and an admin links them later. | R12, R13. | Agreed |
| C145 | `Insert()` never saved NR date and Translations, and skipped `ReplaceSpecialCharacters`. | Every field is saved on create, cleaned as on update. | Legacy data bug. | Agreed |
| C146 | Cloning with a new keyword threw (`ActivityWebService.cs:430`). | The keyword is created and the clone succeeds. | Legacy data bug. | Agreed |
| C147 | `ActiveActivities` INNER JOINed comm contact and ministry, hiding 19 activities everywhere. | Any in scope are imported and shown. A comm contact is required on their next save. | Legacy data bug. | Agreed |
| C148 | The RLS code "Fact Sheet" never matched the lookup name "Factsheet" (`ActivityHandler.ashx.cs:1210`). | Matches both spellings. | Legacy data bug. | Agreed |
| C149 | Save and Review closed the browser tab. | The editor returns to where the user came from. | A single-page app can't reliably close tabs, and the lock no longer depends on it. | Agreed |
| C150 | Transfer wrote no history, parsed the ministry from display text, and had no role check. | Writes history per activity, uses the comm contact's ministry id, Administrator+ on the server. Still raises no needs-review flags. | R10; accountability. | Agreed |
| C151 | The Excel export was an HTML table served as `.xls`, unfiltered for confidential items. | A real `.xlsx` with the same header, columns and footer, `visible()` rows only, formula-like cells inert. | R2; safe to open. | Agreed |
| C152 | Calendar admin edited `dbo.Ministry`, Sector, Theme and Tag. | Edited in Core only. | Core owns them (parent §3.1). | Agreed |
| C153 | Attachments as database blobs with MD5; 2 GB request limit. | Object storage, SHA-256, content sniffing, 25 MB per file. Legacy's blocklist and same-name replace are kept. | Platform storage pattern (NRMS); the largest legacy file is 0.58 MB. | Agreed |
| C154 | Snowplow analytics calls on the list. | Not built. | No analytics service on the platform. | Agreed |
| C155 | The user page's "Verify" pulled name, phone, email and title from AD/LDAP. | Not built. Identity comes from Core, and from Entra later. | No LDAP on the platform. | Agreed |
| C156 | Every editor rule (required fields, categories 12/58, dates, 5-minute steps, Potential Dates text, lengths) ran in the browser only; the server re-validated nothing. | One zod schema shared by the form and the API; the API refuses what the form refuses. Imported over-length values stand until changed. | R10; the API is reachable without the form. | Agreed |
| C157 | Every activity since 2012 (83,607) is in the Calendar. | Only activities ending on or after the cutoff (the post-election swearing-in date), plus every non-deleted awareness-date activity, are imported, with legacy ids. Older activities, their history, favourites and attachments stay in legacy, which stays readable for one year after cutover (R14). | R13: a clean start for the new government, with the awareness dates staff clone every year. | Agreed (Q52, Q53) |
| C158 | Every release linked to an activity showed it, and the activity showed the release. | A release linked to an activity that wasn't imported keeps the number for search but shows it as "Legacy activity <id>, not migrated". The Calendar has no record of it. Legacy stays readable for one year (R14). | Follows from R13. | Agreed |

## 15. Open questions (rows for `docs/parity/open-questions.md`)

| # | Question | Why it matters | Working assumption until answered | Raised |
|---|---|---|---|---|
| Q48 | How faithful must the **Word** reports be: "similar layout" or "pixel match"? | Legacy offered no Word export in its UI, so there is no Word layout to match. | **Answered (2026-10-07):** similar layout is fine — same sections, order, columns, colours, headers and footers, and the same text; page breaks may fall differently. | 2026-10-07 |
| Q49 | Which organisations are **HQ** (app owners) in production? | C124 merges `ApplicationOwnerOrganizations` and `HQAdmin` into one `is_hq` flag, so every HQ organisation gets the cross-ministry view, the freeze exemption (Editor+), the Look Ahead fieldset and the HQ-only privileges. | **Answered (2026-10-07):** GCPEHQ, GCPEMEDIA and PREM (the Office of the Premier, as in legacy's `ApplicationOwnerOrganizations` default). All three get `is_hq`; GCPEMEDIA and PREM members therefore also get the HQ privileges legacy gave only GCPEHQ (C124). | 2026-10-07 |
| Q50 | Who can produce legacy **report PDFs** (Look Ahead, Exec, 30/60/90, Planning), and a database snapshot taken at the same moment, for the 5i parity check? Which ranges? | The side-by-side check needs the same data on both sides. | Two ranges: the next 14 days and the next 60 days, with no filter and with one ministry, from a snapshot taken right after the PDFs. | 2026-10-07 |
| Q51 | What are production's values for `ShowRecordsSection`, `ShowHqCommentsField` and `SharedWithExcludes`, and for the Significance, Scheduling and Strategy required switches? | They decide whether staff see Records and the Look Ahead fieldset, and which fields are required. Only the template's values are in source. | The template's values: Records and the Look Ahead fieldset off for non-HQ; Significance and Scheduling required; Strategy optional; no shared-with exclusions. | 2026-10-07 |
| Q52 | Is "Awareness Day / Week / Month" (id 2) the only category that marks awareness dates? Should deleted awareness activities be left out? | R13 imports every awareness date regardless of age; the category list decides how many come across. "Conference / AGM / Forum" (3,490 links, SV 4.10) is the only other all-day-style category, and it isn't treated as an awareness date. | Only "Awareness Day / Week / Month", non-deleted. To confirm with Carolynn. | 2026-10-07 |
| Q53 | What is the import cutoff date, and does an activity that started before it but ends on or after it count as post-cutoff? | Fixes the imported set (R13) and the earliest date the parity check can use. | The swearing-in date after the 2026 election, passed as `--cutoff`. Activities ending on or after it are imported. | 2026-10-07 |

## 16. Testing and acceptance

**Tests by sub-plan** (Vitest, Node 24):
- **Unit:**
  - the §7.3 trigger table, row by row;
  - validation, including categories 12 and 58, 5-minute steps, Potential Dates text, limits on changed fields only;
  - Look Ahead inference;
  - freeze boundaries (15:59:59, 16:00:00, 16:59:59, 17:00:00) across the 2026-11-01 time zone change;
  - the RLS codes;
  - report selection and ordering;
  - the saved-filter converter;
  - the import scope rule (cutoff boundaries, spanning activities, awareness category, deleted rows).
- **Real Postgres:**
  - `visible()` and its SQL predicate on a generated matrix (role × HQ × own/shared/other × confidential × deleted);
  - locks (take, heartbeat, lapse, move tab, someone else's save refused);
  - version conflicts on every write path;
  - review-selected skipping changed rows;
  - importer upsert and re-run.
- **Event contracts:** `user.upserted`, `org.upserted` with `isHq`, `activity.*` (including the id-only confidential form), and `release.status_changed`, validated by the producer and by consumer tests.
- **Reports:** golden HTML per section from fixtures; the text extracted from PDF and Word matches the golden order.
- **Staff app:** component tests, axe on every Calendar screen, and Playwright against the full local stack.

**Acceptance list.** Phase 5 exits when all of these pass automatically. Items marked * are also checked by hand on boxs.ca.

1. *A Calendar.Administrator sets a user's role and ministries. The user sees their own and shared ministries' activities, not others'. An HQ user sees all.
2. *A confidential activity is invisible to an HQ Editor outside its ministries: not in the list, quick search by id, the activity URL (404), the feed, reports, the Excel export or its attachment URL. The owning ministry and HQ Advanced see it.
3. *A non-HQ Editor's save at 16:00 BC time is refused with the freeze message, and one at 17:00 succeeds. An HQ Editor saves at 16:30.
4. *Two users open one activity. The second sees "<name> is editing" and can't save. After 15 idle minutes the lock lapses and the second can edit. A stale save gets 409.
5. Every §7.3 row raises exactly its flag and status. HQ Review clears them. Review on a deleted activity clears only `active`.
6. Creating an activity keeps its NR date and Translations. Cloning with a new keyword succeeds. Swapping one keyword raises `tags`.
7. Every editor rule refuses bad input through the API as well as the form.
8. *"View changes" shows each field change with actor and old and new values, including imported legacy entries.
9. *The updates feed's modes return the expected items, with no email in any item.
10. *Each report downloads as PDF and as Word, from the current filter. Exec Look Ahead is offered only to HQ Administrators. The Look Ahead has all 7 sections, the legend colours and the page-break rule.
11. Attachments: upload, same-name replace, blocked extension refused, download refused (404) to a user who can't see the activity.
12. Review selected, Clear LA Status, Transfer, the lookup admin and saved-filter rename are each refused on the server to a role below their threshold.
13. *An NRMS release linked to an activity shows its status on the activity within one dispatch. Publishing it updates the status. Users without NRMS roles see no release link. A release linked to an activity that wasn't imported shows "Legacy activity <id>, not migrated".
14. *An eligible activity appears in NRMS Forecast. The release editor's lookup pre-fills from it. Linking it removes it from Forecast. Parent §10.2 end to end.
15. The importer, given a cutoff, brings in exactly the in-scope activities of the synthetic fixture with their legacy ids, and only their history, favourites and attachments. It imports only active or referenced users; no-email users are inactive and keep their activities. The report balances, and a re-run changes nothing.
16. An imported awareness date from before the cutoff clones into a new activity on a new date.
17. The report parity check passes on the fixture's own golden output. On the legacy snapshot, for a range after the cutoff, it passes once Q50 is answered.
18. Every Calendar screen passes axe with no serious or critical violations.

Exit for Phase 5: the list above green; the parity rows and questions updated; the running-notes Phase 5 lines written, including R14's one-year legacy read-only access for the Phase 7 cutover checklist; deployed to boxs.ca.

## 17. Changes to the parent spec

- **§8.1 field and flag counts:** "~50 fields" and "nine per-field needs-review flags" → 64 legacy columns and 23 flags (§5.2, §7.3).
- **§8.1 lookups and joins:** Priority, services and `NewsFeed` are not carried (R8, R9). `NewsFeed` was never a lookup. Status is an enum.
- **§8.2 HQ:** "HQ (application-owner organizations)" → one HQ flag on Core organisations, replacing both legacy settings (C124).
- **§8.2 confidential:** the rule is legacy's matrix (§6). HQ sees confidential items only at Advanced and above, unless the item is in its own or shared ministries.
- **§8.3 updates feed:** "since last visit" is not built; legacy never had it (§9.1).
- **§8.3 iCal:** "per-user tokenized iCal feed" is deferred, and so is NRMS's Forecast iCal (R5, C131, Appendix A).
- **§8.3 Look Ahead:** "4 sub-sections" → legacy's 7 sections plus the Exec version (§10).
- **§8.3 Look Ahead inference:** "inferred in the browser" → computed and stored by the server on every save, by legacy's own rules (a confidential activity keeps its section, an HQ override stays through a ministry save, Awareness and the consultations ministry keep theirs), so a direct API call can't bypass it (C168).
- **§8.4 import:** "imports all `calendar.*` tables" → imports activities on or after the cutoff plus the awareness-date history, keeping legacy ids, with their history; users only when active or referenced (R13, C157). Releases linked to activities that weren't imported lose the link (C158).
- **§8.4 user matching:** "matched to Entra accounts by email/IDIR" → by email. Users without email are imported inactive (R12).
- **§11 Phase 7 (cutover):** add a decommissioning requirement. One HQ administrator keeps read-only access to the legacy Corporate Calendar for one year after cutover (R14, §12.4).
- **§4.3 catalogue:**
  - Core's `role.granted`/`role.revoked` → one `user.upserted` carrying the Calendar role and ministries (§4).
  - `activity.*` carries the Forecast fields. There is no "needs-release flag": NRMS applies the Forecast rule.
  - Confidential activities are sent as id-only records (§5.4).
- **§3.1 and §5 step 1:** NRMS's projection is all activities (confidential ones id-only), and Forecast applies legacy's rule rather than a flag (R11).
- **§3.4:** the Calendar UI follows staff-web (esbuild, the BC design system), as Phase 3 did, not Vite and Tailwind.

## Appendix A. Deferred: iCal feeds (R5, C131)

The design approved before R5 was revised. It is kept so the feeds are cheap to add later. Nothing here is built in Phase 5.

- **Calendar feed:**
  - **URL and token:** one per user, `webcal://<host>/calendar/ical/<token>.ics`. "Connect to Outlook" shows a copy button and **Reset**.
  - **Storage and reset:** the table `ical_tokens` holds the user, the SHA-256 of a 32-byte random token, created at and last used at. Only the hash is stored, so the URL is shown once after creation or reset. Reset makes the old URL return 404 at once.
  - **Access:** the token is the only auth; the route never accepts the session cookie. An inactive user, or one without a Calendar role, gets 404. The limit is 60 requests per hour per token.
  - **Contents** (`Calendar.ashx.cs:20-87`, `ActivityDAO.cs:351-363`): activities that are visible to the user, never confidential, not deleted, New, Changed or Reviewed, and ending after 00:00 today BC time.
  - **Each event:** SUMMARY title, LOCATION city, DESCRIPTION the activity URL; TENTATIVE when unconfirmed; 8:00–18:00 as all-day; all-day and multi-day events FREE.
  - **The calendar:** UTC times and DATE values; the name is "Corporate Calendar" plus " (<env>)" off production; `X-PUBLISHED-TTL` PT1M.
  - **Freeze:** token reset is not a content write.
- **Forecast feed** (NRMS; `News/ReleaseManagement/Forecast.ashx.cs:19-94`):
  - **Auth:** the same per-user token design, held by NRMS for users with an NRMS role.
  - **Events:** the Forecast items. A release, or an activity without an end, lasts 5 minutes. 8:00–18:00 becomes all-day. Unconfirmed activities are TENTATIVE.
  - **Labels:** DESCRIPTION is the staff-app link. The name is "Release Forecast" plus " (<env>)" off production.
- **Tests when built:** ICS golden files; a reset token returns 404; no confidential item in any feed.
