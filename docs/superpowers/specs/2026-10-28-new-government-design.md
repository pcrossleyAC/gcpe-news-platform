# New government: dated terms, archive by term, successor ministries, staged cabinet change — Design

Date: 2026-10-28. Branch: `feat/new-government` (from `main` at `63689c0`).
Research input: `docs/parity/inputs-new-government.md` (with the owner's PDF summary). Reference only: `docs/superpowers/specs/2026-10-28-news-gov-parity-design.md` on `feat/parity`.
Labels: **[V]** verified in code or the input's cited artifact; **[I]** inferred, reasoning shown; **[A]** assumed, with the check that settles it. **[call]** = a ruling the owner can overturn.

## Why

Today a new government (election, swearing-in, cabinet change) takes about 8 manual steps across 3 teams: a hand-run SQL row, a code edit and redeploy, hand-typed archive labels, an archive-server index job, a Corporate Search crawler ticket per term, and one-save-at-a-time ministry edits with no way to move subscribers (input §2). The target: **one Hub form ("Start new government term", enter the swearing-in date) plus one guided ministry hand-over (or one staged cabinet change)**. Corporate Search does nothing per election.

There is also a cutover gap that is not election-specific: archive.news.gov.bc.ca grows only because the legacy Hub's publisher writes files there [V input §1.1, `PublishManager.cs`]. Nothing in the platform does [V input grep]. When the legacy Hub stops, that archive stops.

## Goals

1. Government terms are dated records. "Current" is derived from the date, and a term can be entered before its swearing-in day.
2. A public, crawlable archive by term, with a single permanent entry point and generated, non-overlapping date labels.
3. Retiring a ministry in favour of a successor moves what should move (URLs, subscribers, staff, future Calendar work, drafts, abbreviation), with counts shown first.
4. A whole cabinet change can be staged, previewed and published at once, optionally at a set time.

## Non-goals

- A writer of legacy-format files for archive.news.gov.bc.ca (C1).
- Mirroring or importing the pre-2012 archive. It stays linked.
- Minister contact records in Media Hub (people data, stays manual).
- Rich minister biographies, ministry contacts and social links. These are parity workstream D (T1, T2).
- Changing release numbering. It is calendar-year based and needs no per-election step [V `releases/numbering.ts`, `workflow.ts:88-96`].

## Decisions

| # | Decision | Why |
|---|---|---|
| C1 | **[call] Archive continuity.** From cutover, the platform's own archive by term **is** the news archive for 2012 onward. archive.news.gov.bc.ca is frozen as the pre-cutover and pre-2012 archive and is linked from the new archive pages. No legacy-format writer. Corporate Search makes **one** change: add the stable entry point `https://news.gov.bc.ca/archive/terms/` (and the sitemap `https://news.gov.bc.ca/sitemap.xml`), with PDFs excluded. Nothing changes per election after that. **Owner confirmation open (Q-NG1).** | The platform already holds every release since March 2012 via the import [input §3-C, not re-verified here]. The alternative keeps every per-election step. |
| C2 | **[call] Terms are dated.** Extend NRMS `government_terms` with `start_date` (BC calendar date of the swearing-in), `label` and `legacy_archive_url`. Range labels are generated, never typed. Hub action **Start new government term**, schedulable in advance, **Core.Admin only**. | Removes steps 1–3 and 7 of input §2. |
| C3 | **[call] Public archive by term.** `/archive/terms/` (index), `/archive/terms/<slug>/` (one per term), and `/archive/terms/current/` (stable alias). Generated and crawlable, with no overlap between terms. Earlier collections link to the frozen legacy archive. | Removes steps 5, 6 and 9. Fixes the legacy overlap ("…to July 17, 2017" / "July 17, 2017 to…") [V input §1.1]. |
| C4 | **[call] Successor ministry**, a guided action on Organizations. Marking B as successor of A: A's URLs 301 to B; subscribers of A move to B (count shown first; the admin can untick); staff, future Calendar work and drafts are re-homed; B may take A's abbreviation once A is inactive. | Removes steps 12–16. |
| C5 | **[call] Staged cabinet change**: stage several ministry changes, preview, publish all at once, optionally scheduled. Designed here; **built last**, after C2–C4. | Largest piece; C4 gives most of the value first. |
| C6 | Pre-2012 content: keep linking archive.news.gov.bc.ca. No mirror. | Traffic is "not high" (owner's PDF). |
| N1 | **[call] Term membership on the public site is by BC publish date**, not by a stored term id: a post belongs to the term with the latest `startDate` on or before the post's BC calendar day. | One rule, no overlap, no per-post field in News API or the importer. Legacy filed a release by its *draft* date [V input `NewModel.cs:299-300`], so a few imported posts move to the date-correct term. Recorded as a deliberate difference. |
| N2 | **[call]** A term whose start date is in the future is shown in the Hub as **Scheduled** and is invisible on the public site until that BC day begins. | Staff can enter it when the date is announced. Nothing leaks early. |
| N3 | **[call]** A new term's start date must be later than every existing term's. Its slug is the ISO start date (`2028-11-20`). While a Hub-created term is still scheduled, its slug follows its date; once started, the slug is frozen. Imported terms keep their legacy names as slugs (`2024-2028`). | Unique on the day it is known. Never guesses an end year, which legacy got wrong twice [V input §1.1]. |
| N4 | **[call]** Only a scheduled term can be deleted. A started term's dates can be corrected, but only strictly between its neighbours. | Deleting a started term would silently re-file every post in it. |
| N5 | **[call]** One HTML page per term, with no pagination. | Matches legacy `index_*.htm` (6,304 links, about 1.2 MB) [V input]. Crawler limits are [A] (Q-NG5). |
| N6 | **[call]** `/archive/terms/current/` is a static duplicate of the current term's page with `rel=canonical` to the slug page, not a redirect. | Static site; no middleware needed. |
| N7 | **[call]** `successorKeys` is an ordered list. The first key is the redirect target and receives Calendar work and drafts. Subscribers are added to **every** successor (a split). | C4 names one successor; splits happen. This costs one array. |
| N8 | **[call]** Each move is a checkbox, on by default, with its count beside it. Subscribers are **not** emailed about the move in v1 (Q-NG6). | The admin keeps control. The subscriber can still manage their own lists. |
| N9 | **[call]** Calendar: only activities starting on or after the hand-over date (or with no start date) move. Past activities keep the old ministry (history). A comm contact moves unless that person already has one on the successor; then the old one is deactivated. | History stays true. Respects `comm_contacts_user_ministry_idx` [V]. |
| N10 | **[call]** NRMS: only releases in status `draft` are re-pointed (lead ministry and ministry tag). Approved, scheduled and published ones are listed in the preview but not changed. | They already carry a number with the old abbreviation. |
| N11 | **[call]** Abbreviation uniqueness applies among **active** ministries only. When B takes A's abbreviation through a hand-over, NRMS seeds B's ministry counter for the current year from A's, so `2028HLTH0001` is not issued twice. | Ruling C4. Today the check ignores `isActive` [V `organizations.ts:164-172`]. Counters are keyed by ministry key [V `numbering.ts:11-16`]. |
| N12 | **[call]** Reactivating A clears its `successorKeys`, which stops the redirect. Moves are not undone. | Undoing moves would need a log of every row. A reactivation is rare. |
| N13 | **[call]** NRMS stamps `news_releases.term_id` at **first publish** (by the BC day of `publish_at`), not at approval. | Fixes input §2 row 3 for NRMS's own data. Nothing downstream reads it [V grep], so the change is contained. |

## 1. Archive continuity (C1)

- No new code beyond §3. Cutover adds three one-time actions:
  - an owner sign-off (Q-NG1);
  - a Corporate Search ticket (entry point and sitemap above, PDFs excluded, keep the `archive.news.gov.bc.ca` domain for older content);
  - a Hub edit of the "News Archive" resource link to `/archive/terms/`. Resource links are data [V input §1.2].
- **Coverage check before cutover:** a script reads the release keys from the legacy `index_<collection>.htm` files and reports any key the News API lacks. The input proposes diffing `index_2020-2024.htm` (6,304 keys) [V input §3-C]. This is the evidence that "the platform's archive is the archive" is true.
- Known wart: the frozen archive's last collection label says "to current date" [A input §3-C]. Ask the archive owner to change that one label line, or accept it (Q-NG1).

## 2. Government terms (C2)

**Model (NRMS).** `government_terms` today is `(id, name unique, is_current, legacy_id)`, with a partial unique index allowing one `is_current` [V `apps/nrms/src/db/schema.ts:51-60`]. Add:

- `start_date date` (nullable at the database level, unique where not null). An undated row is shown in the Hub as **Needs a start date** and is ignored by the archive and by "current".
- `label text` (optional, e.g. "Eby government").
- `legacy_archive_url text` (optional link to the frozen archive's index for that collection).

`name` remains the slug. `is_current` remains, but becomes a **cache written only by the rollover** (below). The importer stops touching it: it no longer runs `newestTerm()`, which was C11's text-sort problem [V `import/reference.ts:214-264`, `changes-from-legacy.md:27`].

**Backfill** (migration). Start dates for the 9 legacy collections are from input §3-A:

| Slug | Start date |
|---|---|
| pre2001 | 1994-01-01 (sentinel) |
| 2001-2005 | 2001-06-05 |
| 2005-2009 | 2005-05-18 |
| 2009-2013 | 2009-06-11 |
| 2013-2017 | 2013-06-10 |
| 2017-2017 | 2017-06-12 |
| 2017-2021 | 2017-07-18 |
| 2020-2024 | 2020-11-26 |
| 2024-2028 | 2024-11-18 |

- The `pre2001` and `2017-2021` dates are [A] (Q-NG4). Either can be corrected in the Hub.
- `legacy_archive_url` is set to `https://archive.news.gov.bc.ca/releases/index_<slug>.htm`, except `2024-2028`, which gets `…/index_current.htm` [A: the `index_<collection>.htm` pattern is V in the input; that a file exists per slug is not checked]. Each URL is editable.

**Derived spans** (pure function, the one place ranges are computed):

- Dated terms are sorted by start date.
- `endDate` = the next dated term's `startDate − 1 day`.
- Status is `past`, `current` (latest start ≤ today BC), `scheduled` (start > today) or `undated`.
- The public payload contains only `past` and `current` terms, so a scheduled term never shows (N2). For the newest public term, `endDate` is null.

**Rollover.** `syncGovernmentTerms(now)` runs after every term write and on every NRMS site-loop tick (the loop that already switches carousels, `website/carousel.ts:369`):

- It computes the public payload.
- It sets `is_current` to the derived current term.
- When the payload's hash differs from the last one published (a single-row `government_terms_published` table), it enqueues `government_terms.published` in the same transaction. An advisory lock serialises writers.

So a term entered weeks ahead goes live at the first tick after 00:00 Pacific on its date, with nobody at a keyboard. The first deploy publishes once, because no hash is stored yet.

**Event** `government_terms.published` (NRMS → News API):

```
{ publishedAt, currentSlug: string|null,
  terms: [{ slug, label|null, startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD"|null, legacyArchiveUrl|null }] }   // newest first
```

- The name avoids the existing "term" event family, which means sectors, themes and tags [V `catalogue.ts:56,334`].
- News API applies a payload only if its `publishedAt` is newer than the stored one.

**Hub: Admin → Government terms** (`/government-terms`, nav visible to Core.Admin; NRMS routes require `Core.Admin`, as Blue Bridge does [V `site-routes.ts:220`]):

- The table shows the generated range ("November 18, 2024 to current date"), the label, the status and the count of releases filed.
- The **Start new government term** form asks for:
  - the swearing-in date;
  - an optional label.

  Hint: "The new term starts at 12:00 a.m. Pacific time on this date. You can enter a date in the future; the archive switches over by itself."

  The confirmation names the closing range ("The current term will end November 19, 2028"). A date that is not later than every existing term's start is refused, with the message: "A new term must start after {latest start, long form}."
- Row edits: label, legacy archive URL, and start date. A started term's date must stay strictly between its neighbours' dates, or the edit is refused with the message: "Must be after {prev} and before {next}." A scheduled term can be deleted. 409s carry the message shown.

**NRMS stamping** (N13). `approve()` stops setting `termId` [V `workflow.ts:98-102`]. On first go-live the publisher sets `termId` to the term covering the BC day of `publishAt` [V go-live block `publisher.ts:82-100`].

## 3. Public archive by term (C3)

**Delivery.**

1. NRMS emits `government_terms.published`.
2. News API stores it (single row, like site settings [V `projections.ts:276-290`]) and records change kind `government_terms`. It serves the payload at `GET /api/v2/government-terms` (404 until the first payload arrives).
3. The public site reads it through `newsApiClient.governmentTerms()`.

**Pages** (new page ids; files under the existing `archive/` tree, beside `archive/YYYY/MM/` [V `site-paths.ts`]):

| Page id | File | Content |
|---|---|---|
| `archive-terms` | `archive/terms/index.html` | h1 "News archive by government term". One row per public term, newest first: generated range, label, post count, link. A term with 0 posts on the platform and a `legacyArchiveUrl` links **only** to the legacy index (pre-2012 terms). A term with both posts and a legacy URL also gets "Earlier releases from this term are on the legacy news archive." A closing line reads "Releases from before 2012 are on the legacy news archive (archive.news.gov.bc.ca)." |
| `archive-term:<slug>` | `archive/terms/<slug>/index.html` | h1 = range ("News from November 18, 2024 to current date"), the label if set, then every post in the range, newest first: headline link plus date. Nothing else. With no posts: "Nothing has been published in this term yet." |
| `archive-term:current` | `archive/terms/current/index.html` | The current term's page, canonical to `/archive/terms/<slug>/` (N6). |

- Slugs match `/^[a-z0-9-]{1,40}$/`. `current` can never be a slug, because new slugs are ISO dates and legacy slugs are names.
- Membership is N1: `startDate ≤ substr(publish_date,1,10) < nextStartDate`. `publish_date` is already BC-local text [V `public-site/src/db/schema.ts:17-18`].
- Range copy:
  - open term: "{Month D, YYYY} to current date";
  - closed term: "{start} to {end}", e.g. "November 26, 2020 to November 17, 2024".
- `/archive/` (the month index) gains one link: "Browse by government term". Rendering uses `renderPage` only. No change to `render.ts`, the header or the footer.

**Rebuild triggers.**

- **Post change:** the existing dependent set [V `rebuild-set.ts:36`] also gets `archive-terms`, plus `archive-term:<slug>` for the term of the post's day before and after the change, plus `archive-term:current` when that is the current term.
- **`government_terms` change:** queues `archive-terms`, `archive-term:current`, every public term's page and `sitemap:pages`.
- **Pages for deleted terms:** these can only be scheduled terms, so they were never built.
- **Full rebuild:** includes them all.

**Sitemap.** `sitemaps/pages.xml` lists `/archive/terms/` and every term page. The per-month post sitemaps are unchanged.

**Crawler (C1).** The entry point `/archive/terms/` links each term page, and each term page links every post. A new term appears as a new link on a page the crawler already follows. **This is the property that removes Corporate Search's per-election step, and a test pins it** (Testing §8).

## 4. Successor ministry (C4)

**Data (Core).**

- `organizations.successor_keys text[] NOT NULL DEFAULT '{}'`.
- `OrgRecord` gains `successorKeys: string[]`, defaulted `[]` so stored envelopes still parse, as `isHq` and `isPublic` were [V `catalogue.ts:44-51`].
- News API keeps it in `categories.ministry` and serves `GET /api/v2/ministry-successors`: `{ successors: { "<old>": "<final active key>" } }`. Chains are resolved to the final active ministry; a cycle or a dead end is omitted.

**Hub flow.** On Organizations:

- The **Deactivate** button on an active ministry opens a panel titled "Deactivate {A}". It offers "Has a successor?" with an ordered picker of active ministries.
- Inactive rows get **Set successor…**, which opens the same panel without the deactivation.
- With a successor chosen, the panel shows (each line is a checkbox, on by default, N8):
  - "Send {A}'s web pages to {B}" (always on when a successor is set; it *is* the succession).
  - "Move {n} subscribers to {B[, C]}." — NoD `GET /subscribers/count?lists=ministries:<a>` (Core.Admin added to its roles) [V route `nod/src/http/routes.ts:94-106`].
  - "Move {n} staff from {A} to {B}." — Core `user_organizations` [V `core/src/db/schema.ts:98-110`].
  - "Move {n} upcoming Calendar activities and {m} comm contacts to {B}." — new Calendar endpoint.
  - "Move {n} draft releases to {B}." The panel also lists approved and scheduled releases that will not move, with links (N10). — new NRMS endpoint.
  - "Let {B} use the abbreviation {ABBR}." This line shows only when B has none, or the admin confirms the replacement.
- A count that fails to load shows "count unavailable" and does not block.
- Button: "Deactivate and hand over". Success text: "{A} is deactivated. Its pages now send visitors to {B}. Moves finish within a minute." The last sentence is [A]: dispatcher latency is not measured, so soften it if tests show otherwise.

**Apply.** `POST /organizations/:key/succeed` (Core.Admin). Body: `{ successorKeys, moveSubscribers, moveStaff, moveCalendar, moveDrafts, takeAbbreviation }`. One Core transaction:

1. Validate. Each successor must exist, be active and differ from A. No successor may itself have A in its chain.
2. Set A inactive and set its `successorKeys`.
3. If `moveStaff`, move `user_organizations` rows to the first successor, skipping duplicates. This is followed by `emitUserUpserted` for each affected user, as Calendar access edits already do; `user.upserted` carries `organizationKeys` [V `core/src/services/calendar-access.ts:8,205-206`, `catalogue.ts:230`].
4. If `takeAbbreviation`, copy the abbreviation to B (the uniqueness check now ignores inactive ministries, N11).
5. Emit `org.upserted` for A, and for B if it changed, then `org.succeeded`.

Event `org.succeeded`: `{ key, successorKeys, moveSubscribers, moveCalendar, moveDrafts, takeAbbreviation, at }`. It is published on its own aggregate, `org-succession:<key>`, never on A's `org:<key>` (NG-R16): on one aggregate a receiver that applied it first would drop A's `org.upserted`/`org.deactivated` as stale. The dispatcher also delivers each transaction's events in write order. It is routed Core → NoD, Calendar and NRMS in `INTERNAL_EVENT_ROUTES` [V `apps/stack/src/env.ts:339-377`]. Each handler is idempotent (it moves rows still keyed to A):

| Service | Effect |
|---|---|
| NoD | If `moveSubscribers`: for each subscriber of `ministries:<a>`, insert `ministries:<b>` for every successor (on conflict, do nothing), delete the old row, and write `subscriber_history` action `list-moved`, detail `ministries:<a> → ministries:<b>`. |
| Calendar | If `moveCalendar`: activities with `contact_ministry_key = a` and (`start_at ≥ at` or null) → first successor; `activity_shared_with` rows for those activities likewise; comm contacts per N9. Each moved activity gets a history line through the existing change writer. |
| NRMS | If `moveDrafts`: drafts (`status = 'draft'`) with lead `a` → first successor; their `release_categories` `(ministries, a)` → first successor. If `takeAbbreviation`: `number_counters(ministry, thisYear, b) = greatest(own, a's)`. |
| News API | Nothing new from `org.succeeded`. `org.upserted` already carries `successorKeys`. |

**Redirects.**

- The public site gets a new page id `legacy-redirects`. It writes `legacy/ministry-successors.json`, the same `legacy/` convention as url-compat's per-post maps [V parity `url-compat.md:124`], from `/api/v2/ministry-successors`. It is queued by any `ministry` change.
- A stack middleware mounted before the static site answers `/ministries/<old>` and anything beneath it with **301** to `/ministries/<new>/…`. It keeps the query string, matches whole segments only, and reloads the file when it changes on disk.
- An inactive ministry's page still builds today, because News API's `getMinistry` has no active filter [V `news-api/src/read.ts:53-58`]. The middleware wins because it runs first.

**Reactivate** clears `successorKeys` (N12) and so stops the redirect.

## 5. Staged cabinet change (C5) — built last

- **Model (Core):** `cabinet_changes(id, status draft|scheduled|published|cancelled, scheduled_for, operations jsonb, created_by, published_at, error)`. Operations:
  - `update {key, expectedUpdatedAt, patch}`: the existing profile patch plus abbreviation. This is a rename in place, which keeps the key, URL and subscribers.
  - `create {ref, displayName, abbreviation?, sortOrder?, minister?}`.
  - `succeed {key, expectedUpdatedAt, successors: (key|ref)[], moves}`.

  A merge is two `succeed` operations into one `create`. A split is one `succeed` with two successors. Abolishing is a `succeed` with no successor: a plain deactivate, which needs "No successor" ticked.
- **Preview:**
  - a diff table, old → new;
  - the resulting ministry list in sort order;
  - per-`succeed` counts as in §4;
  - validation: abbreviation clashes among the *resulting* active set, every abolished ministry either has a successor or is ticked "No successor", and no cycles.
- **Publish:** one Core transaction applies all operations through the same service functions as §4 and §2 of the org-edit plan. Any `expectedUpdatedAt` mismatch refuses the whole change as stale, naming the ministry. Any validation error writes nothing.
- **Scheduling:** Core gains a worker in its existing loop set [V `core/src/start.ts:79-86`] that publishes due `scheduled` changes. The intended use is "at the swearing-in time", matching C2's date.
- **Rebuild:** the public site's queue already de-duplicates page ids, so N org events rebuild `/ministries/` once per drain [I: `rebuild()` collects ids into a `Set`, `builder.ts:200-205`; a test confirms it].
- **Hub:** Organizations → **Cabinet change**. One draft is open at a time [call]. It offers "Add change", Preview, "Publish now" and "Schedule…".

## 6. What admin staff do for a new government

| When | Who | Action |
|---|---|---|
| Swearing-in date announced | Core.Admin | Government terms → Start new government term → enter the date. |
| Before swearing-in | Core.Admin | Organizations → Cabinet change: stage renames, new ministries and hand-overs, then schedule for the swearing-in time. Until C5 ships, do the hand-overs and renames on the day, one at a time. |
| Swearing-in day | nobody | The term rolls over at 00:00 Pacific. The archive pages, `current` alias and sitemap update themselves. The scheduled cabinet change publishes, redirects start, and subscribers move. |
| After | Site editors | Minister photos and bios, and the election banner (site settings, already editable). Media Hub minister contacts by hand. |
| Never again | Corporate Search, developers | No crawler change, no code edit, no SQL. |

A short admin manual, `docs/manuals/new-government.md`, carries this table and the screens' names.

## 7. Overlap with `feat/parity`

Rule: this work changes **no** `render.ts`, header, footer, theme or `RENDER_CHROME_VERSION`. Public-site changes are limited to archive pages and redirect data.

| Area | Parity work | Overlap and resolution |
|---|---|---|
| `apps/stack` mount | Plan 1 Task 2 replaces the `/site` block with `site-mount.ts`/`mountSite` | Our redirect middleware mounts **inside `mountSite`, before `express.static`**. The task runs after parity plan 1 has merged to `main`. If it hasn't, mount where the `/site` static mount is today and tell parity. |
| Redirect middleware | Plan 3 (url-compat T1 `legacy-redirects.ts`, T4 `ministry-renames.json`) | Same job, different data. Ours exposes `resolveMinistrySuccessor(key)` from a builder-written file. Whichever lands second composes them: static renames first, then successors, one hop. Parity must not drop the `legacy/ministry-successors.json` source. |
| `/archive/` styling | Workstream B "Archive" restyle | Our term pages use `renderPage` with plain `ul.post-list` markup, the same as the month pages. The parity restyle must cover `archive/terms/*` too. |
| `public-site/src/dto.ts`, `sync.ts`, `builder.ts` | Plan 1 Tasks 4–5 (ministry menu) also edit them | Textual merge conflicts only. No shared behaviour. |
| Parity P9 "Terms are edited by Core.Admin" | Means sectors, themes and tags | Different thing. Ours is always "government terms" in code, routes and copy. |
| 404s for old ministry URLs | url-compat makes renames 301 | Succession supplies the data for future renames, so parity's static table stops growing. |

## 8. Testing (the tests that prove it)

- **Boundary:** terms starting 2028-11-20. A post at 2028-11-19T23:59-08:00 lists under the old term, and one at 2028-11-20T00:00-08:00 under the new. The NRMS stamp agrees for the same instants given as UTC.
- **Scheduled:** a future term is absent from the public payload and from `current` until the TestClock passes Pacific midnight. Then the site-loop tick (no human action) emits exactly one event.
- **Crawler property:** adding a term changes `/archive/terms/` to link the new term page with no other change, and the term page links every post in range.
- **No overlap:** for consecutive terms, `end(prev) = start(next) − 1 day`, and a post on a boundary day appears on exactly one term page.
- **Succession:** a subscriber on both A and B ends with one B subscription. Running the handler twice changes nothing. A split adds both. A chain A→B, then B→C, redirects A to C in one hop. A cycle is omitted. `/ministries/a/feed.xml?x=1` → 301 `/ministries/c/feed.xml?x=1`.
- **Abbreviation:** B takes `HLTH` while inactive A holds it. The first approved release that year for B gets ministry number (A's last + 1).
- **Cabinet change:** an invalid operation writes nothing, a stale `expectedUpdatedAt` refuses the whole change, and a scheduled change publishes at its time.

## 9. Open questions for the owner

- **Q-NG1** Confirm C1: freeze archive.news.gov.bc.ca at cutover; the platform archive by term is the archive from 2012. Who asks the archive owner to fix the "to current date" label on the frozen last collection, or is that accepted?
- **Q-NG2** Calendar import cutoff (Q53). The Calendar spec says "the swearing-in date after the 2026 election", but the current term began with the 2024-11-18 swearing-in [V archive, per input]. Is the cutoff 2024-11-18?
- **Q-NG3** Access to the "Cabinet Shuffles 101" page, to catch steps the reconstruction in input §2 missed.
- **Q-NG4** Confirm the backfill dates: `pre2001` sentinel 1994-01-01; `2017-2021` start 2017-07-18 (the legacy list shows July 17 twice).
- **Q-NG5** Corporate Search: is one page of about 9,000 links acceptable to their crawler, or should term pages be split by month? Do they prefer the sitemap or the entry-point page?
- **Q-NG6** Should subscribers be told by email when their ministry subscription moves? (v1: no.)
- **Q-NG7** Media Hub minister contact records stay manual. Confirm.

## 10. Risks and things not checked

- **Silent if wrong:** the start date entered for a new term decides where every post is listed. The confirmation repeats the date in long form and names the closing day.
- Calendar hand-over relies on `org.succeeded` reaching the Calendar. A dead-lettered event leaves activities on A, visible on the Calendar dead-letters screen [V the screen exists]. The Hub panel's success text should not claim completion.
- The `index_<slug>.htm` URLs for the backfill are [A] per slug. They are editable, and the coverage-check script fetches each one.
- `contactMinistryExcludedAbbreviations` and `consultationsMinistryAbbreviation` are tenant config keyed by abbreviation [V `config/tenants/bc.json:38-39`]. A hand-over that keeps the abbreviation needs no change. A new abbreviation for those roles is a config edit (input §2 row 19, now answered: carried over as config).
