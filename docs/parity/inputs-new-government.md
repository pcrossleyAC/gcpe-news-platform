# New government (election / swearing-in): manual steps and what to automate

Date: 2026-10-27. Sources: owner's PDF "Province of B.C. News Archives"; 17 live requests to archive.news.gov.bc.ca and news.gov.bc.ca (curl/8.7.1, ≤1 req/s, 2026-10-28 03:54 UTC); legacy Hub source (`gcpe-hub-develop-2`, `LegacyHub/gcpe-hub`, `HUB/*`); platform `gcpe-news-platform` at `bd9f466`.
Labels: **[V]** = verified (I read the code, fetched the page or counted it, and the artifact is cited). **[I]** = inferred from verified facts, with the reasoning shown. **[A]** = assumed, not checked; the note says what check would settle it.

## 0. The answer

1. **The biggest issue is cutover, not elections.** archive.news.gov.bc.ca gets each new release because the **legacy Hub's publisher writes it there**. `PublishManager.PublishInMediaGallery` → `ConvertNewsRelease.GenerateFiles` writes `<Key>.htm/.pdf/.txt` into `news_releases_<collection>/`, and `DeployFiles` copies them to the UNC `DeployLocations` [V `Hub.Legacy/Gcpe.News.ReleaseManagement.Legacy/PublishManager.cs:131-190, 18-66`; `ConvertNewsRelease.cs:78-80`; `ReleasePublisher.cs:159,172`]. The platform has nothing that does this [V: grep for `archive.news|news_releases_|DeployLocations` in `apps/`, `packages/` finds only unrelated table names]. **Once the legacy Hub stops publishing, the archive's "current" collection stops growing.** The owner has to choose before go-live: freeze the archive and make the platform's public site the archive from cutover on (recommended, §3-C), or build a writer that produces legacy-format files.
2. **Each election today is about 8 manual steps across 3 teams (§2).** With the build list below, it becomes **one Hub form (Start new government term: enter the swearing-in date) plus one guided Cabinet change**. Corporate Search does nothing per election, after a one-time change to their crawler entry points.
3. **Recommended build list, in priority order:**
   1. **C. Archive continuity decision + term entry point.** Owner decision and a one-time Corporate Search change. Size S, but it blocks cutover.
   2. **A. Government terms as dated data + "Start new government term".** Size S–M.
   3. **B. Public archive by term:** stable `/archive/terms/` entry point, per-term index pages and a `current` alias. Size M.
   4. **D1. Successor ministry:** redirects, subscriber move and a re-homing checklist when a ministry is deactivated. Size M.
   5. **D2. Staged cabinet change, published at once.** Size L.
   6. **E. Pre-2012 archive:** keep linking archive.news.gov.bc.ca. Size S. Mirror or import only if that server is being retired.

## 1. Findings

### 1.1 How archive.news.gov.bc.ca is built

- **Stack.** IIS 10 + ASP.NET 4 (`Server: Microsoft-IIS/10.0`, `X-AspNet-Version: 4.0.30319`, `ASP.NET_SessionId` cookie) [V headers].
  - Three kinds of page:
    - **Dynamic search and list:** `/Default.aspx?archive=<collection>`. It shows the "Search Newswire" form and the latest releases [V].
    - **Static collection indexes:** `/releases/index_<collection>.htm` and `index_current.htm`. Each is one bare HTML page of absolute links, with no layout. These are the crawler entry points [V].
    - **Static release pages:** `/releases/news_releases_<collection>/<Key>.htm` (plus `.pdf` and `.txt`). The file name is the release **Key**. That is normally `2026WLRS0042-000965`, but a key-editable release can have a slug, e.g. `building-momentum-through-forestry-trade-mission.htm` (Nov 19, 2025) [V fetched].
  - Older collections use other paths:
    - `releases/archive/2001-2005/<Key>.htm`
    - `releases/archive/pre2001/1994/nr16-02-94.asp`
    - On the `/archive/` page, `2005-2009/` and `2001-2005/` are relative folders, and pre-2001 links to `pre2001/default.htm` [V].
- **Same keys and same IDs as news.gov.** Release `2026WLRS0042-000965` exists on both sites with the same headline ("Salmon River" appears 10× in the news.gov page) [V]. The archive release page carries `<meta name="prime_organization_obj_id" content="72aeafc8-…">`, and the archive search ministry dropdown uses the same GUIDs [V]. Those are legacy Hub `Ministry.Id` values, which the platform keeps as `organizations.legacy_id` [V `apps/core/src/db/schema.ts`]. **The archive is fed from the Hub database. It is a by-product of Hub publishing, not a separate import.**
- **Collections are a Hub table.** `dbo.NewsReleaseCollection(Id, Name)` holds rows such as `2017-2021` [V `Gcpe.Hub.Database/dbo/Tables/NewsReleaseCollection.sql`; seed `db-scripts/gcpe.hub-data-01-dbo.sql:29-32`].
  - The 2018 seed stops at `2017-2021`, so `2020-2024` and `2024-2028` were added later [I: probably by hand-run SQL; the "Cabinet Shuffles 101" page would confirm].
  - "Current" is the row whose Name sorts highest **as text** [V `PublishManager.cs:74,110`].
  - A release gets its collection **when its draft is created**, not when it is published [V `NewModel.cs:299-300`]. The code has the comment `//TODO: Set Collection based on current date`. So a draft started before the swearing-in but published after it is filed in the old collection [I].
  - Hardcoded fallback `"news_releases_2024-2028"` [V `PublishManager.cs:78`]. Someone has to edit that code after every election [I].
  - New collection folders are created automatically on first deploy (`if (!directory.Exists) directory.Create()`) [V `PublishManager.cs:44-45`].
- **Collections and counts.** Links per index page [V counted 2026-10-28]:

  | Collection | Links |
  |---|---|
  | pre2001 | 10,813 |
  | 2001-2005 | 3,234 |
  | 2005-2009 | 6,172 |
  | 2009-2013 | 6,720 |
  | 2013-2017 | 9,205 |
  | 2017-2017 | 80 |
  | 2017-2021 | 5,881 |
  | 2020-2024 | 6,304 |
  | current (2024-2028) | 1,756 |
  | **Total** | **50,165** |

  This matches the PDF's "50,000+" and the Elastic document count of 50,562 in the PDF screenshot [V by recount; the gap of about 400 is assumed to be non-index pages such as the root and search pages].
- **The index pages are refreshed by something outside our repos.** No repo contains `index_current`, `index_all_archives` or `?archive=` [V grep over HUB, LegacyHub, gcpe-hub-develop-2, gcpe-parity-private]. Last-Modified dates:

  | Page | Last-Modified |
  |---|---|
  | `index_2020-2024.htm` | 2024-11-28 20:00:02 (10 days after the Nov 18, 2024 swearing-in) |
  | `index_2017-2021.htm` | 2021-01-27 (2 months after Nov 26, 2020) |
  | `index_all_archives.htm` | 2024-11-28 |
  | Older indexes | 2019-05-29 (a regeneration in 2019) |

  [V headers]. This is consistent with an index generator on the archive server that someone runs after each election [I].
- **`index_current.htm` is stale today.** Last-Modified 2026-08-28. Its highest release is `…-000966` (about Aug 19-20, 2026). The archive home page already lists `2026TT0105-001130` [V]. So about 160 recent releases are reachable only from `Default.aspx`, not from the `index_current.htm` entry point [I: the year serial runs 966 → 1130]. It is worth telling the owner: the regeneration seems to have stopped or been missed.
- **Hand-typed labels.** The `/archive/` "Archive List" text is hand-typed and has boundary errors:
  - "June 12, 2017 to July 17, 2017" and "July 17, 2017 to November 25, 2020" overlap on July 17.
  - "1994 to June 5, 2001" and "June 5, 2001 to May 17, 2005" overlap on June 5 [V page text].
- **Collection names are guesses.** Names like `2024-2028` carry an *expected* end year, which was wrong twice: `2017-2021` actually ended in Nov 2020, and `2017-2017` lasted 5 weeks [V list]. Names are URL slugs, not date ranges.
- **Hardcoded term start in the search form.** The archive search form defaults to "Nov 18 2024 →" and says "Click here to search for news releases issued before Nov. 18, 2024" [V]. Whether that is config or code on the archive app is unknown [A: needs the archive app's source].
- **Corporate Search.** The Elastic index `search-hnr_prod` has domain `https://archive.news.gov.bc.ca` with 11 entry points: the root, `index_current`, `index_all_archives`, and one per closed collection [V PDF p.4 screenshot]. The domain screen also has a **"Site maps"** tab [V same screenshot]. Testing is prod-only, and PDFs are excluded [V PDF].
- **news.gov links.** news.gov.bc.ca links to the archive host only: `href="https://archive.news.gov.bc.ca/" … >News Archive` [V live]. That target does not change per election. The legacy news.gov also forwards `/archive/2005-2009/*`, `/archive/2001-2005/*`, `/archive/pre2001/*`, `/default.aspx`, `/list.aspx` and `?organisation_obj_id=` from `www.news` to the archive host [V per `parity-inputs/url-compat.md` §3].

### 1.2 What the platform knows today

- **A term table exists, with no dates.** `apps/nrms` has `government_terms(id, name unique, is_current, legacy_id)`, with a partial unique index that allows only one `is_current` row [V `apps/nrms/src/db/schema.ts:51-60`]. It has **no start date, no label and no Hub screen or API** [V: grep finds it only in `releases/workflow.ts` and the importer].
  - The importer turns `NewsReleaseCollection` into `government_terms` and picks current by highest year (`newestTerm()`) [V `import/reference.ts:214-264`, `import/map.ts:30-47`].
  - Approval stamps `termId = (is_current term)` [V `releases/workflow.ts:98-102`].
  - Parity change C11 ("explicit current term setting") is agreed [V `docs/parity/changes-from-legacy.md:27`], but nothing sets it except the importer [I].
- **Nothing downstream uses the term.** news-api and public-site never read `termId` [V grep]. The public archive is by month only: `/archive/` and `/archive/YYYY/MM/` [V `apps/public-site/src/site-paths.ts:19-20,77-78`; `pages/archive.ts`]. A sitemap index with per-month sitemaps exists [V `apps/public-site/src/sitemaps.ts`].
- **Release numbering ignores terms.** It is calendar year in BC time, as in legacy (`{year}{ABBR}{nnnn}-{nnnnnn}`). The ministry counter is keyed by (year, ministry key) [V `workflow.ts:88-96`, `numbering.ts:11-16`; legacy `ReleaseModel.cs:868-876` keys it by MinistryId]. **Numbering needs no per-election step** [V both].
- **Ministries.** The Hub → Organizations screen exists:
  - Add a ministry, with the key derived from the name and immutable [V].
  - Edit the name, minister name/summary/email/photo URL, sort order and **abbreviation** (Core.Admin only, uniqueness enforced) [V `staff-web/src/screens/admin/organizations/*`, `core/src/services/organizations.ts:150-172`].
  - Deactivate and Reactivate [V routes `core/src/http/routes.ts`].
  - Changes go live one save at a time [V plan Decisions §2].
- **Gaps noted as "Out of scope (v2)"** [V `docs/superpowers/plans/2026-10-27-organization-edit-form.md:173-178`]:
  - successor ministry and subscriber move;
  - draft and publish a whole cabinet at once;
  - rich minister bio;
  - contacts, social and topic links.
- **Abbreviations can't move to a successor.** Abbreviation uniqueness covers **inactive ministries too**: the check has no `isActive` filter [V `organizations.ts:164-172`]. A successor ministry cannot take over the abbreviation of the ministry it replaces (e.g. a renamed "HLTH") unless the old one's abbreviation is cleared first [I].
- **Approval needs an abbreviation.** A new ministry can't approve releases until it has one ("The lead ministry has no abbreviation in Core; add one before approving.") [V `workflow.ts:93`].
- **NoD subscriptions are keyed by ministry key.** The key is `ministries:<key>` [V `apps/nod/src/db/schema.ts:58-73`]. Deactivating a ministry deactivates its list (`onOrgGone`) [V `apps/nod/src/lists.ts:31-33`]. **Subscribers to a deactivated ministry silently stop getting that ministry's news.** The UI warns about this [V plan Task 5 copy]. A move is a keyed `UPDATE … ON CONFLICT DO NOTHING` on `subscriptions` [I].
- **Ministry key appears in other places:**
  - Core `user_organizations` (staff ↔ ministry, used for Calendar access) [V `core/src/db/schema.ts:98-110`];
  - Calendar activities and comm contacts (`ministryKey`; `transfer.ts` already moves a contact's activities) [V `apps/calendar/src/transfer.ts:18-30`];
  - NRMS drafts (`leadMinistryKey`) [V `workflow.ts`].
- **Old ministry URLs.** Legacy news.gov returns **404** for a defunct ministry: `/ministries/advanced-education-and-skills-training` → 404 "no longer" [V live]. Redirecting them would be an improvement over legacy, not parity. The platform's public `/ministries/` list hides inactive ministries [V `pages/categories.ts:99`]. Whether `/ministries/<inactive>/` itself still builds is **not checked** [A: build an inactive ministry in `builder.test.ts`].
- **Election-related settings.** An election banner is already admin-editable (site settings) [V `docs/superpowers/specs/2026-10-27-site-settings-design.md:16,118`]. Resource links (incl. "News Archive") are data, not code [V `apps/nrms/src/website/links.ts`; PDF p.1 shows it under Resources].

### 1.3 Legacy Hub, per election

- A word-boundary search for `election|cabinet|shuffle|swearing|sworn` across the legacy repos finds **nothing** except a jQuery icon class [V]. Legacy has no election feature; it is all hand work plus the "Cabinet Shuffles 101" page, which we don't have.
- **Hub work tied to ministries** [V schema `Ministry.sql`, `MinistryNewsletter.sql`, `MinistryTopic.sql`, `MinistrySector.sql`; calendar `SystemUserMinistries`; contacts `AddEditContact.ascx.cs:251`]:
  - `Ministry` rows: DisplayName, Abbreviation (unique), MinisterName/Email/Photo/PageHtml, SortOrder, IsActive, ParentId, contacts;
  - ministry newsletters, topics and sectors;
  - Calendar user↔ministry (`SystemUserMinistries`);
  - minister contacts in Media Contacts (lists ministries with a MinisterName);
  - a config list of ministries excluded from "Shared with" [V `README.md:469`, `Hub.Legacy.Template.config:94`].
- No code moves NoD subscribers between ministries [V grep for `migrat|successor|renam` in HUB/Subscribe and Hub.Legacy].

## 2. Every manual step a new government entails, and what to do with it

Steps are inferred from the PDF plus the evidence in §1. "Cabinet Shuffles 101" was not available, so the list may be incomplete [A].

| # | Step today | Where | Evidence | Disposition |
|---|---|---|---|---|
| 1 | Insert a new `NewsReleaseCollection` row (e.g. `2028-2032`) | Legacy Hub DB (SQL) | [V] table; 2018 seed lacks the last 2 rows | **Automate**: Feature A (a term is a date row; becomes current on its date) |
| 2 | Edit hardcoded `news_releases_2024-2028` fallback and redeploy | Legacy code | [V `PublishManager.cs:78`] | **Gone** on the platform (no folder per term) |
| 3 | Watch for drafts started before swearing-in that get filed in the old collection | Implicit | [V `NewModel.cs:300` assigns at creation] | **Automate**: the term is derived from the publish date (Feature A) |
| 4 | Create the archive folder `news_releases_<new>` | Archive server | [V auto-created by `DeployFiles`] | Already automatic; gone with Feature B |
| 5 | Regenerate the closing collection's `index_<old>.htm` and a fresh `index_current.htm` | Archive server job | [I from Last-Modified dates; current one is 2 months stale, V] | **Automate**: Feature B (term index pages rebuilt by the static site on every publish) |
| 6 | Add the closed collection to `index_all_archives.htm` | Archive server | [V content] | **Automate**: Feature B (`/archive/terms/` lists every term from data) |
| 7 | Edit the `/archive/` "Archive List" labels and links | Archive app | [V; hand-typed, overlapping dates] | **Automate**: labels computed from start dates (end = next start − 1 day) |
| 8 | Update archive search (`Default.aspx?archive=` value, default date "Nov 18 2024", "issued before Nov. 18, 2024" text, ministry dropdown) | Archive app | [V page; source not available] | **Leave manual on the old app / freeze it** (Feature C). The platform's own search uses live data |
| 9 | Add an Elastic crawler entry point for the closed collection's index; test in prod only | Corporate Search team | [V PDF p.4] | **Leave to Corporate Search, once**: after Feature B, a single entry point `https://news.gov.bc.ca/archive/terms/` (and/or the sitemap) never changes, so no per-election request |
| 10 | news.gov "News Archive" link | news.gov | [V points at host root] | No per-election change. Becomes `/archive/terms/` if C1 is chosen (resource link, editable) |
| 11 | Rename, create or abolish ministries; minister names, photos, bios; sort order; abbreviations; parent | Hub | [V platform screen; one save at a time] | **Guided Hub action**: Feature D2 (stage, preview, publish at once). Rich bio stays a separate v2 item |
| 12 | Move NoD subscribers from abolished ministries to successors | NoD | [V none in legacy; platform out of scope] | **Guided Hub action**: Feature D1 (offered with counts; staff confirm) |
| 13 | Old ministry URLs | Public site | [V legacy 404s] | **Automate**: Feature D1 (successor redirect) |
| 14 | Re-assign comms staff to the new ministries (Calendar access) | Core users | [V `user_organizations`] | **Guided**: D1/D2 checklist ("12 users on Health → move to Health and Wellness?") |
| 15 | Re-home future Calendar activities and comm contacts of abolished ministries | Calendar | [V `transfer.ts` exists per contact] | **Guided**: D1 offers a bulk move of *future* activities; past ones keep history |
| 16 | Re-point NRMS drafts whose lead ministry was abolished | NRMS | [V `leadMinistryKey`] | **Guided**: D1 lists them; approval already blocks a missing abbreviation |
| 17 | Minister contact records in Media Contacts | Media Hub | [V legacy contacts] | **Leave manual** (people data; changes daily anyway) |
| 18 | Post-election notice on the home page | Public site | [V site-settings banner] | Already a Hub action |
| 19 | Calendar "excluded from Shared with" ministry list | Legacy config | [V README:469] | Check whether the platform carried it over [A: grep `apps/calendar` config]; if so, make it data |
| 20 | Release numbering | — | [V calendar year] | Nothing to do |

## 3. Features worth building

### A. Government terms as dated data + "Start new government term" (S–M)

- **Model** (NRMS):
  - Add `start_date date NOT NULL UNIQUE` (BC calendar date of the swearing-in), `slug text UNIQUE` and `label text NULL` (e.g. "Eby government") to `government_terms`.
  - Make **current** derived: the term with the greatest `start_date <= today (BC)`. Drop `is_current`, or keep it only as a cache.
  - At publish (not approval), stamp `termId = term_for(publishAt in BC time)`.
  - Imported releases keep their legacy collection, even where its date disagrees (legacy assigned at draft creation).
- **Backfill.** The 9 legacy collections get start dates from the archive list [V]:

  | Collection | Start date |
  |---|---|
  | pre2001 | 1994-01-01 [A: sentinel date] |
  | 2001-2005 | 2001-06-05 |
  | 2005-2009 | 2005-05-18 |
  | 2009-2013 | 2009-06-11 |
  | 2013-2017 | 2013-06-10 |
  | 2017-2017 | 2017-06-12 |
  | 2017-2021 | 2017-07-18 [A: list says July 17 twice; confirm with owner] |
  | 2020-2024 | 2020-11-26 |
  | 2024-2028 | 2024-11-18 |

  Imported terms keep their legacy names as slugs, so archive-era names stay recognizable.
- **New term slug** = ISO start date (`2028-11-20`): unique and known on the day. This avoids guessing an end year, which legacy got wrong twice [V].
- **Hub action:** Admin → Government terms, Core.Admin only. The list shows date range and release count. "Start new government term" asks for the swearing-in date and an optional label. A **future date is allowed**, so staff can enter it when the date is announced and the rollover happens by itself at BC midnight. Terms with releases can't be deleted. Emits `term.upserted` (or `government_term.upserted`) to news-api and public-site.
- **Dependencies:** none. news-api needs `termSlug` on its post DTO for B.
- **Tests that prove it:**
  - With a fake clock and term starting 2028-11-20: a release published 2028-11-19 23:59 BC is filed in the old term, and one published 2028-11-20 00:00 BC in the new one (DST/UTC boundary).
  - A future term does not change `current` before its date.
  - A duplicate start date → 409.
  - The importer leaves imported rows' terms alone, and the backfill sets all 9 dates.
  - The role guard returns 403 for SiteEditor.
  - Delete is refused for a term with releases.

### B. Public archive grouped by term, with crawler-stable URLs (M)

- **Pages** (static, public-site):
  - `/archive/terms/`: **the single permanent entry point**. Lists every term with a computed date range ("November 18, 2024 to current date") and count, and links to each term page. Rows for pre-2012 terms link to the archive.news.gov.bc.ca index pages (see E).
  - `/archive/terms/<slug>/`: plain list of every post in that term (like `index_*.htm`, which is 1.2 MB for 6,304 links today [V]). One page, or chunked by month if size matters [A: check crawler limits with Corporate Search].
  - `/archive/terms/current/`: an alias of the current term. It is a duplicate page with `<link rel=canonical>`, or a 302 at the stack.
  - The existing monthly pages stay.
- **Rebuild triggers.** `post.upserted` queues its term's page. `term.upserted` queues `/archive/terms/`, the old and new term pages and `current`. A daily tick handles a term whose date arrives with no event.
- **Corporate Search, one time:**
  - Add the entry point `https://news.gov.bc.ca/archive/terms/` (it follows links, so new terms are found with no change), and/or give them `sitemap.xml` (their "Site maps" tab exists [V screenshot]).
  - **Exclude PDFs**, as the PDF requires.
- **Dependencies:** A; news-api exposing the term.
- **Tests that prove it:**
  - The renderer: date ranges come from start dates and the newest says "to current date".
  - `pagesForChange(post.upserted)` includes the term page.
  - **Adding a term changes `/archive/terms/` to link the new term with no other config change.** This test proves Corporate Search needs no per-election step.
  - The `current` alias moves on rollover (fake clock).
  - A post in an imported term appears under its legacy term even when its date falls in another.

### C. Archive continuity at cutover (owner decision; S for C1, M for C2)

- **C1 (recommended): freeze archive.news.gov.bc.ca at cutover.**
  - Its current collection ends on the cutover date. The platform's `/archive/terms/` becomes the archive from then on; it already holds every release since March 2012, via the import.
  - Corporate Search adds the news.gov entry point once and keeps the old domain for 1994–2012.
  - Cost: one owner sign-off, one Corporate Search ticket, one resource-link edit.
  - Risk: the archive app's "current" label then lies ("to current date"). Ask the archive owner to change one label line, or accept it [A].
- **C2: write legacy-format files to `DeployLocations`.**
  - Keeps the old site complete, but keeps every per-election step in §2 rows 5–9.
  - It also needs UNC/file-share access from the platform host and a byte-compatible renderer for the htm/pdf/txt files.
  - Recommended only if the owner says archive.news.gov.bc.ca must stay the single source.
- **Test (C1):** a release published after cutover appears at `/archive/terms/<slug>/`, and nothing is written outside the platform's storage. Plus a check that every 2012+ key in archive `index_2020-2024.htm` exists in news-api: diff the link list (6,304 keys) against news-api.

### D1. Successor ministry on deactivate (M)

- **Data.** Add `organizations.successor_keys text[]` in Core. One key means a rename or merge target; several mean a split. It is set when a ministry is deactivated.
- **On deactivate with a successor**, Hub shows impact counts and offers each move separately, all opt-in:
  - (a) **Redirect** `/ministries/<old>/` → first successor. This needs a redirect stub page or a stack 301 table (`url-compat.md` proposes the harness).
  - (b) **Move NoD subscribers** from `ministries:<old>` to each successor, deduplicated. The count is shown first.
  - (c) **Move staff** `user_organizations` links.
  - (d) **Move future Calendar activities** and active comm contacts.
  - (e) **List NRMS drafts** whose lead is the old ministry.
  - (f) Let the successor **take over the abbreviation**: relax the uniqueness rule to "unique among active, or transferred from a predecessor". Also seed the successor's year counter from the predecessor's, so `2028HLTH0001` isn't reissued in the same year [I: otherwise only the -nnnnnn year serial differs].
- **Dependencies:** NoD, Calendar and NRMS each need an idempotent "re-key ministry" command, driven by a Core `org.succeeded` event or a Hub call per service.
- **Tests that prove it:**
  - A subscriber on both old and successor ends with exactly one successor subscription, and the next release for the successor reaches them.
  - A split puts the subscriber on both successors.
  - Running it twice is a no-op.
  - `/ministries/<old>/` answers with the redirect.
  - Past Calendar activities keep the old ministry (history intact); future ones move.
  - The successor can be given `HLTH` while the old one holds it, and the first approved release that year doesn't repeat a ministry number.

### D2. Cabinet change: stage, preview, publish at once (L)

- **Model.** A `cabinet_changes` draft in Core, with operations:
  - rename (in place: keeps key, URL and subscribers);
  - create;
  - merge A+B→C;
  - split A→B+C;
  - abolish;
  - and per ministry: name, abbreviation, minister name/photo, sort order, parent.
- **Preview** shows:
  - a diff table;
  - a rendered `/ministries/` preview;
  - D1 impact counts per abolished ministry (subscribers, staff, future activities, drafts);
  - validation (abbreviation clashes, every abolished ministry has a successor or "none" ticked).
- **Publish.** One Core transaction applies everything. It can be **scheduled for the swearing-in time**, so it lines up with A. Then it runs the D1 moves the admin ticked. The public site rebuilds once (batch events), not 25 times.
- **Dependencies:** D1 and the organization edit form (exists).
- **Tests that prove it:**
  - A publish with one invalid operation writes nothing (atomic).
  - Two concurrent drafts: the second publish is refused as stale.
  - Scheduled publish fires at the time (fake clock).
  - Field preservation as in the existing plan's Review Focus 1.
  - The public `/ministries/` page shows the new cabinet after exactly one rebuild batch.

### E. Pre-2012 archive (S now; M/L only if the archive server is retired)

- **Keep linking archive.news.gov.bc.ca** for terms before March 2012: rows on `/archive/terms/` and the search page's "old archive" links, which `admin-editability.md:149` says are missing today [V that doc].
- **Scale of anything else.** Pre-2012 is about 20,219 pages in pre2001 + 2001-2005 + 2005-2009, plus the pre-March-2012 part of 2009-2013's 6,720 [V counts]. Formats are mixed (`.asp` from 1994, two folder layouts).
- **If the server must go:**
  - A **static mirror**: copy the files as-is to platform storage, serve them under the archive host or `/legacy-archive/`, keep URLs. Size M.
  - **Importing into the release model**: parse HTML for date, ministry and headline. Size L+. Low value for traffic the PDF calls "not high".
- **Test (mirror):** for a sample of 50 URLs taken from each `index_*.htm`, the mirror returns 200 with an identical body hash.

## 4. Risks, open items, things not checked

- **Decision needed first:** C1 vs C2. Until it is made, the cutover plan has a silent gap: the archive stops at cutover [V that the feed is the legacy Hub; I that nothing else feeds it].
- **"Cabinet Shuffles 101" was not seen.** The step list is reconstructed from evidence and may miss steps such as the archive app's own config or IIS bindings [A].
- **The archive app's source (`Default.aspx`) is not in any repo we have** [V grep]. How its date default and collection list are set is unknown [A].
- **`index_current.htm` is 2 months stale** [V]. Under C1 this ends; under C2 someone has to find the job.
- **The term boundary is a date, not a moment.** Releases issued on swearing-in morning before the ceremony go to the new term. That matches the PDF's rule ("first day of each collection = the day … sworn in") [V PDF].
- **"2026 election" may be a wrong label.** `docs/superpowers/specs/2026-10-07-calendar-parity-design.md` R13/Q53 calls the Calendar cutoff "the swearing-in date after the 2026 election". The archive names the current term `2024-2028`, and the last swearing-in was 2024-11-18 [V archive]. BC's fixed-date law points to Oct 2028 for the next election [A: general knowledge, not checked here]. If Q53 means the current government, the cutoff is probably **2024-11-18** [I]. Worth confirming with the owner.
- **Not checked:** whether `/ministries/<inactive>/` still builds on the platform, and whether the platform's Calendar carried over the legacy "excluded ministries" list [A both; each is one test or one grep].
