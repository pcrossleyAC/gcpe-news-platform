# news.gov.bc.ca Parity, Plan 4: Remaining Pages, New Pages and Their Hub Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build every news.gov.bc.ca page that is still missing or still in the old look, and give staff the Hub screens that edit them (spec §4 B "remaining pages and new pages", §4 D T3, T4 rest, T5, T6, T7, and the listing-title part of T9). The pages are: Media Contacts `/contacts/`, Live webcast `/live/` with its header button, `/privacy/`, an HTML sitemap, the per-kind listings, per-ministry factsheets, sector/theme/tag pages, the category indexes, search, archive, subscribe/manage and Connect.

**Architecture:**
- **Site settings** gain three sections and extend one, all in `packages/site-settings`:
  - `contactsPage` (T3);
  - `pageText` (T4: 404, privacy, live, Notice of Collection, subscribe help, media-assets licence, old-archive links);
  - `navigation` (T5: header links and labels, page labels, listing titles);
  - `connect.linkedin`, `connect.policyLink` and `connect.intro` (T7).

  Stored documents published before this plan still parse: a new `storedSiteSettingsSchema` keeps the new parts optional, and `fillMissingFields` fills them from the tenant defaults. Every consumer sees a complete `SiteSettings`.
- **Hub:** four new or extended settings screens, using the existing `useSettingsEditor` pattern. Two smaller changes: the slide/pin action label in NRMS (T6), and the ministry "Additional display name" on the Organizations form (T2 remainder).
- **Public site:**
  - New `PageId`s: `contacts`, `privacy`, `live`, `kind:<kind>` and `index:<sectors|themes|tags>`.
  - Two new files on existing pages: `ministries/<key>/factsheets/index.html` (a ministry page file) and `sitemap/index.html` (a `sitemap:pages` file).
  - Each settings part reaches only the pages that show it, through its own hash in the site-state marker.
  - The Live button is driven by a small `assets/live.json` that `site.js` polls, so switching the webcast on or off rebuilds no page.
- **News API:** `GET /api/v2/search` gains `pageSize` (10 or 20) and optional facet counts. Results gain `hasTranslations`/`hasMediaAssets`.

**Tech Stack:** TypeScript, Express 5, zod, drizzle (NRMS and Core migrations via `drizzle-kit generate`), vitest + supertest + jsdom, React + TipTap (`apps/staff-web`), `@bcgov/design-system-react-components`, `hls.js` (new public-site dependency, Apache-2.0, vendored into the site output), and the Playwright parity harness in `tools/parity`.

**Spec:** `docs/superpowers/specs/2026-10-28-news-gov-parity-design.md` (binding; §4 B remaining and new pages, §4 D T3–T7, P6, P9, P11, P12, P14, P15).
- Evidence: `docs/parity/inputs/gap-audit.md` (H3, H4, H5, M8, M9, M12, M13, M14, M16, L1, L2, L3, L6), `look-and-feel.md` §2.3–2.16 and §5, `admin-editability.md` §1 and §3 (T2–T7, T9), `url-compat.md`. Read the copies on `feat/parity-2`: plan 2 updated their statuses.
- Conventions: `docs/superpowers/plans/2026-10-28-parity-2-home-release-ministry.md` (on `feat/parity-2`).
- Coordination: `docs/superpowers/plans/2026-10-28-parity-3-url-compat.md` (on `feat/parity-3`).
- Legacy source (Apache-2.0): `/Users/paul/News-Hub/gcpe-news-webapp/Gov.News.WebApp` at `3fdf3e6` (`WA/` below). Views used: `Views/Default/{CommContacts,LiveView,PrivacyView,SearchView,ConnectView}.cshtml`, `Views/Shared/{PostsView,CategoriesView,Sector,Ministry,CommContact,ConnectSocialMedia,ResourceLinks}.cshtml`, `Views/Subscribe/{Index,Manage,_SelectionPartial}.cshtml` and `Components/WebCast/LiveVideoPlayer.cshtml`. Controllers used: `Controllers/{DefaultController,CategoryController,Shared/IndexController}.cs`.

**Prerequisite:** plan 2 batches C and D (`feat/parity-2`) are merged into `main`, and `feat/parity-4` has merged `origin/main` after that (`RENDER_CHROME_VERSION` reads 10 or more). Plan 3 may still be in flight. Only Task 23 needs it (see "Plan 3 coordination").

## Evidence gathered for this plan (2026-10-28)

Live probes used 15 requests at 1 request per second with `curl/8.7.1`: 13 GETs (`/contacts`, `/live`, `/privacy`, `/factsheets`, `/stories`, `/ministries/health/factsheets`, `/ministries`, `/sectors`, `/themes`, `/news-subscribe`, `/search?q=vaccine`, `/subscribe`, `/connect`) and 2 HEADs. The responses are kept in the scratchpad and were never executed.

| Fact | Label | Source |
|---|---|---|
| `/contacts` lists, in order: two multicultural rows, then each ministry with a `ContactUser`, in the menu (API) order, then a hardcoded "Office of the Premier / Premier David Eby / Media Line / Premier.Media@gov.bc.ca" row. No row is indented today. | V | live + `CommContacts.cshtml` |
| Kind listings (`/factsheets`, `/stories`) render `PostsView`. The side column holds Connect With Us, 9 icons including LinkedIn and RSS. The body holds `h3 {title}`, 13 PostCards (3 shown, 10 `hidden-article`), and a news-control with Search News `/Search?content=<title lowercased>` and "Load More". The collapsible regions hold only Resources: `<vc:top-sectors>` is emitted as a literal, unrendered tag. | V | live |
| The `/factsheets` title is "Factsheets & Opinion Editorials". The others are "Releases", "Stories" and "Updates". | V | live + `IndexController.cs:189-193` |
| `/ministries/health/factsheets` is the `Ministry.cshtml` skeleton with `.fact-sheets`, an `h3 "Factsheets"` and no top/feature posts. Its Search News link is `?content=factsheets&ministry=health`. Its feed is the ministry feed. | V | live + `CategoryController.cs:54-60` |
| `/ministries` (25 groups), `/themes` (15) and `/news-subscribe` use `CategoriesView`: per category, top + feature + first latest, then "Browse More News" and Search News (ministries and sectors only). `/sectors` (4) shows the latest 3 per sector. The headings are "News by Ministry", "News by Sector", "News by Theme" and "News by Topic". | V | live + `CategoriesView.cshtml` |
| Sector pages (`Sector.cshtml`) have the top/feature cards commented out. The v1 Latest call excludes the index's top/feature posts, so on legacy those two posts appear nowhere on the sector page. | V | source |
| Search facets: Language (13), Date (government terms `Date=2024-2028`, custom `fromDate`/`toDate` as `yyyy/MM/dd`, and 4 links to `archive.news.gov.bc.ca`), Ministry and Sector (`Ministry=<Name>`), City, Content (`Release`/`Factsheet`/`Story`). It shows 10 results per page, "Showing results 1 - 10 of 585" and `Page=n`. | V | live |
| Live header: one `a.btn.btn-primary-blue.live_button.live_button_hide.d-none.d-lg-block[href=/live]` "Live Webcast", which JS shows when the webcast is on. | V | live + `_Layout` |
| `/assets/license` redirects with a 302 to `https://news.gov.bc.ca/files/News_Footage_License_British_Columbia.pdf`. | V | live HEAD |
| `/sitemap/html` answers 200 (a no-layout list of every post). | V | live HEAD |
| The Connect policy link is "BC Government News Social Media policy, collection notice and hours of operation", pointing at `https://news.gov.bc.ca/stories/bc-government-news-social-media-moderation-policy-hours-of-operation-and-collection-notice`. | V | live |
| The Connect RSS list is "BC Gov News" (`/feed`), "Factsheets & Opinion Editorials" (`/factsheets/feed`), then ministries, sectors and tags merged and sorted by name. There are no themes. | V | `DefaultController.cs:355-366` |
| LinkedIn accounts: "Government of BC" first, then BC Public Service, British Columbia Geological Survey, Trade & Invest BC and WorkBC, each with its `linkedin.com/company/...` URL. | V | `DefaultController.cs:368-373` |
| The Subscribe Notice of Collection text, the Executive Director address and phone 250 387-1337, the "manage your account or unsubscribe" link and the "contact us" help line. | V | live + `Subscribe/Index.cshtml` |
| The search API takes `q`, `ministry`, `sector`, `type`, `from`, `to` and `page`, with a fixed page size of 20 and a maximum page of 50. Results have no translation or asset flags. | V | `apps/news-api/src/search/query.ts`, `service.ts` |
| NRMS emits `actionLabel: null` for every slide and pin. The News API already stores and serves `actionLabel`. | V | `apps/nrms/src/website/events.ts:61`, `apps/news-api/src/db/schema.ts:201` |
| The webcast is on when NRMS sends `liveWebcastM3uPlaylist` in the home record. The public `HomeDto` ignores it today. | V | `apps/nrms/src/website/events.ts:34-35`, `apps/public-site/src/dto.ts:43` |

## Global Constraints

- **Chrome version rule (R10): one bump per deploy.** A task that changes HTML baked into existing pages, or adds a page id (a new page is written only by a rebuild-all), checks the deployed version first:

  ```bash
  git fetch origin deploy/siteground && git show origin/deploy/siteground:stack.js | grep -o 'RENDER_CHROME_VERSION=[0-9]*'
  ```

  - If that equals `RENDER_CHROME_VERSION` in `apps/public-site/src/rebuild.ts`, bump it by 1 and add a line to its doc comment.
  - Otherwise write "RENDER_CHROME_VERSION stays N (R10)" in the commit message.

  Tests read the constant; none hard-codes a number.
- **Deploy batches.** Each batch leaves boxs.ca working. Deploy with `npm run deploy:siteground`, push `deploy/siteground` (`docs/deploy/siteground.md`), and check the site live.

  | Batch | Tasks | Page HTML | R10 |
  |---|---|---|---|
  | A | 1–3 | Connect gains a LinkedIn section from the tenant defaults (a `connect` hash change; no chrome change) | no |
  | B | 4–7 | new `/contacts/` and `/privacy/`; 404 text; release licence line; home Resources hrefs | bump |
  | C | 8–11 | header on every page (labels, Live button); home labels; new `/live/` | bump |
  | D | 12–13 | Connect page; Connect With Us strip on home | bump |
  | E | 14–17 | new kind listings, ministry factsheets and category indexes; sector/theme/tag pages; Factsheets entry in ministry and release side columns | bump |
  | F | 18–21 | search, archive, subscribe/manage | bump |
  | G | 22–24 | new `/sitemap/` (Task 22); stack rules (Task 23, no page) | bump (22) |
- **Visual-task gate.** Every task that renders a page ends with these:
  - `npm run site:quality`, with the new page in `FIXTURE_PAGES`. Thresholds: performance 80, accessibility 95, best-practices 90, seo 90; axe 0 violations.
  - After its batch deploys, `npm run parity -- --target https://boxs.ca --pages <names>` passes:
    - header, landAck and footer ≤ 0.03 at 1280 and 390;
    - every `structure` row is `ok` or `legacy-absent`;
    - axe reports 0 serious/critical.

    `main` is reported only. The threshold is not raised without the owner. A failure becomes a named fix task before the next batch.
- **Stored settings stay valid.**
  - `schemaVersion` stays `1`.
  - Every parser of a *stored or published* document uses `storedSiteSettingsSchema` and then `fillMissingFields(doc, tenantDefaults)`: `packages/events/src/catalogue.ts:307`, `apps/public-site/src/settings.ts` `readPersisted`, `apps/public-site/src/news-api-client.ts:39`, `packages/site-settings/src/defaults.ts` and `apps/nrms/src/website/site-settings.ts`.
  - Section edits still parse with `siteSettingsSchema.shape[section]`.
- **Settings wiring pattern** (Tasks 6, 7, 10, 11, 13, 14, 19, 21). A settings part that reaches pages adds:
  - `<name>Hash` to `settingsHashes` (`apps/public-site/src/settings.ts`), to `SiteRenderState` and to `HASHES` (`rebuild.ts`);
  - a `SectionPages` value that `chromeChanges` returns when that hash differs;
  - its page ids in `enqueueChromeChanges` (`rebuild-all.ts`).

  A marker written before the hash existed reads `""`, which triggers one section rebuild. Each task's `rebuild.test.ts` case is named "a <part> edit queues exactly <ids>".
- **Hub settings screens** (Tasks 4, 5, 8, 12) follow `apps/staff-web/src/screens/website/settings/MinistryPagesScreen.tsx`:
  - `useSettingsEditor<"<section>">`;
  - a `canManageWebsite` read gate, with edit only for `NRMS.SiteEditor` (P9);
  - field errors matched by `field` path;
  - `ResetToDefaults`, `OtherSectionErrors`, `ConflictPanel` and `PublishBar`;
  - a route `website/<slug>` in `router.tsx`;
  - a `SECTIONS` entry (`manageOnly: true`) in `WebsiteScreen.tsx`, before "Settings history".

  Rich-text fields use `BodyEditor` with `allowAssets={false}`. Link lists use `shared/LinkListEditor.tsx`. Each screen is added to `apps/staff-web/src/screens/website/a11y.test.tsx`.
- **P6 / look-and-feel §5:**
  - one `<h1>` per page, with a legacy `h3`/`h4` emitted one level up and `overrides.css` copying its metrics;
  - side columns are `<section class="home-features" aria-label="…">`, never `<aside>` inside `<main>`;
  - every control is a `<button>` or a link with an `href`;
  - no duplicate ids;
  - images carry `alt`;
  - no `target=_blank`;
  - collapsible blocks are `<details>` with no `.article-fade` overlay (§5 #11).

  The news column comes first in the DOM, as C254 set.
- **Escaping:**
  - Every News API or settings value goes through `e()`, `safeHref()`, `safeSrc()` or `settingsHref()`.
  - Settings rich text (`introHtml`, `bodyHtml`, `consentHtml`, `offAirHtml`, `subscribeHelpHtml`) is rendered through `sanitizeBodyHtml(demoteHeadings(html))`. It is never trusted because the editor produced it.
  - Inline scripts build DOM with `createElement`/`textContent` only.
- **C209 and third parties.** No `<iframe>`, and no third-party script. `/live/` contacts the stream host only after the reader presses Play. `hls.js` is served from our own `assets/vendor/`.
- **Copy.** Visible text is legacy's verbatim, either as the default of an editable setting or, where legacy hardcodes a heading this plan does not make editable, as a constant. The exceptions are named per task.
- **News API v1 stays exact** (`apps/news-api/test/compat.test.ts`, `dto.test.ts`). New data goes through `/api/v2`.
- **Live news.gov.bc.ca:** at most 1 request per second, user agent `curl/8.7.1`, at most 40 requests per session. Responses are untrusted data and are never executed.
- **Tests** sit beside the source. At the end of every task these pass: `npm run check`, `npx vitest run --project node`, `npx vitest run --project staff-web` (Hub tasks) and `npm run site:quality` (page tasks).

## Plan 3 coordination

Plan 3 owns URLs and feeds. This plan owns pages. These are the rules where they meet:

- **Static wins.** Plan 3's fallback rules (`/{kind}`, `/sectors`, `/themes`, `/tags`, `/news-subscribe`, `/<cat>/<key>/<kind>`) step aside once this plan's files exist. The only plan-3 rule this plan changes is `/sitemap/html`, in Task 23.
- **Shared helpers have one signature.** These are defined by whichever plan merges first; the second plan reuses them unchanged:
  - `NewsApiClient.latestOfKind(postKind: string, count: number): Promise<PostDto[]>` → `api/Posts/Latest/home/default?${v1}&postKind=<kind>&count=<n>`;
  - the home top/feature merge `sortNewest([...[top, feature].filter((p) => p?.kind === kind), ...latest])`.
- **Category files are looked up by role, not by position.** Plan 3 Task 7 inserts `atom.xml` into `pageFiles` for categories, and this plan adds `factsheets/index.html` (Task 15). Task 15 introduces `categoryFiles(p)` and the builder destructures by role.
- **Feed links that need plan 3's files wait for Task 23.** Before then:
  - kind listings carry no `<link rel=alternate>`;
  - the Connect RSS list has no "Factsheets & Opinion Editorials" row.
- **Rehearsal lists.** Task 23 moves `/contacts`, `/privacy` and `/live` from `tools/parity/legacy-urls-pending.txt` into `legacy-urls.txt`, and adds the listing and index rows.
- **This plan never edits `apps/stack/src/legacy/*`** outside Task 23.

## Review Focus

1. **Settings published before this plan.** Cases:
   - a stored document or `site.settings.published` event without `contactsPage`, `pageText`, `navigation`, `connect.linkedin`, `connect.policyLink` or `connect.intro`;
   - a persisted `.site-settings.json` from before.

   Expected: NRMS, the events catalogue and the public site parse it. The missing parts come from the tenant defaults, and nothing renders "undefined". The Hub shows the defaults. Pinned in Task 2.
2. **Rich text pasted into the privacy body, the directory intro or the Notice of Collection,** carrying `<script>`, `<iframe>`, `onclick=`, `<h1>`, `javascript:` hrefs or `<img>`. Expected: the page keeps exactly one `<h1>`, and none of those reach the output. Pinned in Tasks 6, 7 and 21.
3. **The webcast switched on or off in the Hub** (`/website/live-feed`). Expected:
   - the header button appears or disappears within one poll (≤ 60 s), with no page rebuild;
   - `/live/` shows the player or the off-air text after the home change is drained;
   - an `http:`, `javascript:` or relative stream URL is treated as off air and never reaches a `src`;
   - with `live.json` missing or the fetch failing, the button stays hidden.

   Pinned in Tasks 10 and 11.
4. **Directory data shapes.** Cases:
   - a ministry with no primary contact (left out, as legacy);
   - only an alternate (left out);
   - a child ministry (indented, under its parent);
   - a blank minister name;
   - an inactive ministry (left out);
   - a settings contact with no email or phone;
   - a malformed email in Core data.

   Expected: rows render without empty `Direct:`/`Cell:` lines, and a bad email shows as text, not as a `mailto:`. Pinned in Task 6.
5. **Legacy search query strings arriving at `/search/`.** Cases:
   - `?content=factsheets%20%26%20opinion%20editorials`;
   - `?Ministry=Health`;
   - `?Content=Story`;
   - `?fromDate=2020/11/26&toDate=2024/11/17`;
   - `?Date=2024-2028`;
   - `?Page=3`;
   - `?Language=French`;
   - an unknown ministry name.

   Expected: the known ones map to `ministry`/`type`/`from`/`to`/`page`. The unknown ones are dropped. The page never shows the API's 400 for a filter it built itself. Pinned in Task 19.

---

## Batch A — harness, settings model, ministry display name

### Task 1: Harness — plan-4 pages and structure selectors

**Files:**
- Modify: `tools/parity/pages.ts`, `tools/parity/structure.ts` and `tools/parity/structure.test.ts`.

**Interfaces — Produces:**
- `PARITY_PAGES` gains these entries (`path` legacy, `oursPath` ours):
  - `contacts` `/contacts` → `/contacts/` (the existing entry gains `oursPath`);
  - `live` `/live` → `/live/`;
  - `privacy` `/privacy` → `/privacy/`;
  - `factsheets` `/factsheets` → `/factsheets/`;
  - `stories` `/stories` → `/stories/`;
  - `ministry-factsheets` `/ministries/health/factsheets` → `/ministries/health/factsheets/`;
  - `ministries` `/ministries` → `/ministries/`;
  - `sectors` `/sectors` → `/sectors/`;
  - `themes` `/themes` → `/themes/`;
  - `topics` `/news-subscribe` → `/tags/`;
  - `archive` `/stories` → `/archive/2026/10/`. Legacy has no archive page; this pairs chrome and the listing look (spec conflict 1).
- `STRUCTURE` gains these entries. Every selector is class-based, because the heading levels differ by design.
  - `contacts`: `.comm-contacts`, `.comm-contacts .header`, `.comm-contacts .row .contact-name`, `.comm-contacts .row a[href^="mailto:"]`
  - `live`: `.connect .home-body`, `.wowza-wrapper.asset.video`, `.placeholder-container img`
  - `privacy`: `.connect .home-body`, `.connect .home-body h1`, `#body p`
  - `factsheets`, `stories` and `archive`: `.home-body .other-articles .regular-articles .article h2 a`, `.regular-articles .article .item-date`, `.news-control .read-more`
  - `factsheets` and `stories` also: `.home-features .resource-links.connect`, `.collapsible-regions .resource-links`, `.news-control .load-more`
  - `ministry-factsheets`: `.ministry-listing.fact-sheets`, `.home-features .resource-links.minister`, `.regular-articles .article`, `.collapsible-regions .resource-links`
  - `ministries`, `sectors`, `themes` and `topics`: `.news-listing .home-features .resource-links.connect`, `.news-listing .home-body .grouped-articles a`, `.grouped-articles .article`, `.news-control .load-more`
  - `sector` (existing page): `.ministry-listing.sector-listing`, `.home-features .resource-links.connect`, `.regular-articles .article`, `.collapsible-regions .resource-links`
  - `search`: `.search .search-body`, `.search-panel.search-filters .search-filter`, `.search-results .search-panel-bar`, `.search-results .search-numbers`, `.search-results .article`
  - `subscribe`: `.connect.subscribe .home-body`, `#noticeOfCollection`, `.expandable-section`, `a[href*="/subscribe/manage"]`
  - `connect`: `.connect .home-body`, `.expandable-section.facebook`, `.expandable-section.linkedin`, `.expandable-section.rss`, `.home-body > p a`

- [ ] **Step 1: Write failing tests** in `structure.test.ts`:

```ts
it("every PARITY_PAGES name has a STRUCTURE entry")
it("every new selector parses in jsdom (document.querySelector does not throw)")
it("oursPath of every plan-4 page ends with '/'")
```

- [ ] **Step 2:** Run `npx vitest run tools/parity`. Expected: FAIL.
- [ ] **Step 3:** Implement the entries.
- [ ] **Step 4:** Run `npx vitest run tools/parity`. Expected: PASS. Then run `npm run parity -- --target https://boxs.ca --pages contacts,factsheets,ministries,search,subscribe,connect`. Expected: it completes, with `missing` rows (exit 1). Keep the output as the baseline.
- [ ] **Step 5: Commit** with `git commit -m "feat(parity): plan-4 page pairs and structure selectors"`.

---

### Task 2: Site settings — `contactsPage`, `pageText`, `navigation`, Connect LinkedIn/policy/intro

**Files:**
- Modify: `packages/site-settings/src/{model,defaults,validate,index}.ts` and their tests, plus `node.test.ts`.
- Modify: `config/tenants/bc.site-settings.json` (BC defaults, legacy text verbatim).
- Modify the parsers named in Global Constraints, and `apps/nrms/src/website/site-settings.test.ts`.

**Interfaces — Produces** (in `model.ts`):
- `NETWORKS` inserts `{ key: "linkedin", name: "LinkedIn" }` after `bluesky` (legacy Connect order).
- `SECTION_KEYS` appends `"contactsPage"`, `"pageText"` and `"navigation"`. `SECTION_LABEL` gives them "Media contacts page", "Page text" and "Navigation and labels".
- New types:

```ts
type DirectoryContact = { group: string; groupUrl: string; subgroup: string; name: string; phone: string; cell: string; email: string; placement: "top" | "bottom" };
type ContactsPageSettings = { heading: string; lineHeading: string; introHtml: string; listHeading: string; contacts: DirectoryContact[] };
type PageTextSettings = {
  notFound: { heading: string; text: string };
  privacy: { label: string; title: string; bodyHtml: string };
  live: { heading: string; consentHtml: string; offAirHtml: string };
  collectionNotice: { heading: string; bodyHtml: string };
  subscribeHelpHtml: string;
  assetLicence: { text: string; linkText: string; url: string };
  searchArchiveLinks: LinkSetting[];
};
const LABEL_KEYS = ["connectWithUs", "viewAllSocialMedia", "resources", "newsBySector", "emergencyInformation", "highlights", "latestNews", "loadMoreNews", "searchNews", "browseMoreNews", "slideActionLabel"] as const;
const LISTING_KINDS = ["releases", "stories", "factsheets", "updates"] as const;
type NavigationSettings = {
  newsLabel: string; liveLabel: string; headerLinks: LinkSetting[]; showHeaderSearch: boolean;
  footerConnectHeading: string; footerMoreInfoHeading: string;
  labels: Record<(typeof LABEL_KEYS)[number], string>;
  listingTitles: Record<(typeof LISTING_KINDS)[number], string>;
};
// connect gains: linkedin: Network; policyLink: { text: string; url: string }; intro: string
```

- Schemas:
  - `storedSiteSettingsSchema` has the three new sections, `connect.linkedin`, `connect.policyLink` and `connect.intro` all `.optional()`.
  - `siteSettingsSchema` is the same with all of them required.
  - `type StoredSiteSettings = z.infer<typeof storedSiteSettingsSchema>`; `SiteSettings` stays complete.
- `fillMissingFields(doc: StoredSiteSettings, defaults: SiteSettings): SiteSettings` fills each missing part whole (section, `connect.linkedin`, `policyLink`, `intro`) and keeps the existing `landAcknowledgement` rule.
- `defaultSiteSettings` neutral defaults (no tenant file):
  - `contactsPage`: heading "Media contacts", lineHeading "", introHtml "", listHeading "Contacts", contacts `[]`;
  - `pageText`:
    - notFound `{ "Page not found", "The page you asked for isn't here. It may have moved or been removed." }` (today's text);
    - privacy `{ "Privacy", "Privacy", "" }`;
    - live `{ "Live", "", "" }`;
    - collectionNotice `{ "Notice of Collection", "" }`;
    - subscribeHelpHtml "";
    - assetLicence `{ "", "", "" }`;
    - searchArchiveLinks `[]`;
  - `navigation`: the BC values below, minus anything BC-specific;
  - connect: `linkedin` empty, `policyLink { "", "" }`, `intro ""`.
- **BC defaults** in `bc.site-settings.json`, verbatim from the evidence table:
  - `contactsPage`:
    - heading "Government Communications and Public Engagement";
    - lineHeading "24 hours Media Relations Contact Line";
    - listHeading "Contact List for Media";
    - `introHtml`: the two `CommContacts.cshtml` paragraphs, with "250-883-2951" and the two www2 links (no `target`);
    - `contacts`: Media Relations / Chinese Media / Catherine Chan / cell 778-686-7925 / Catherine.Chan@gov.bc.ca / top; South Asian Media / Haroon Ghaffar / cell 604-312-6470 / Haroon.Ghaffar@gov.bc.ca / top; Office of the Premier (`/ministries/office-of-the-premier/`) / Premier David Eby / Media Line / Premier.Media@gov.bc.ca / bottom.
  - `pageText`:
    - notFound `{ heading: "That web page doesn't exist.", text: "The URL may be misspelled or the page you're looking for is no longer available. Search for it below." }`;
    - privacy `{ label: "Privacy", title: "B.C. Government Website Privacy Statement", bodyHtml: <WA PrivacyView.cshtml #body minus #media-asset-preferences> }`;
    - live `{ heading: "Live", consentHtml: "<p>Press play to view content from <strong>{host}</strong>. For more information, please read our <a href=\"/privacy/\">Privacy</a> statement.</p>", offAirHtml: "<p>There is no live webcast right now.</p>" }`;
    - collectionNotice `{ heading: "Notice of Collection", bodyHtml: <Subscribe/Index.cshtml #noticeOfCollection paragraph and contact block, tel link kept> }`;
    - subscribeHelpHtml `"<p>If you have difficulties subscribing, please <a href=\"https://forms.gov.bc.ca/\">contact us</a>.</p>"`;
    - assetLicence `{ text: "These assets are subject to the terms of the", linkText: "News Footage License - British Columbia", url: "https://news.gov.bc.ca/files/News_Footage_License_British_Columbia.pdf" }`;
    - searchArchiveLinks: the four `SearchView.cshtml` links, as `https://archive.news.gov.bc.ca/…` [A: the host answers https, since live Resources links it so; Task 19 Step 6 checks one].
  - `navigation`:
    - newsLabel "News", liveLabel "Live Webcast";
    - headerLinks `[{ text: "Subscribe", url: "/subscribe/" }]`, showHeaderSearch `true`;
    - footer headings "Connect with Us" / "More Info";
    - labels "Connect With Us", "View all Social Media", "Resources", "News by Sector", "Emergency information", "Highlights", "Latest news", "Load More News", "Search News", "Browse More News", "Learn more";
    - listingTitles "Releases", "Stories", "Factsheets & Opinion Editorials", "Updates".
  - `connect.linkedin`: featured "Government of BC" `https://www.linkedin.com/company/bcgov/`; accounts BC Public Service, British Columbia Geological Survey, Trade & Invest BC, WorkBC (trimmed), with the legacy URLs.
  - `connect.policyLink`: the live text and URL.
  - `connect.intro`: "".
- **`validateSiteSettings` rules.** Field paths are dotted, as today.
  - **Plain text** (`hasMarkup` → "Use plain text."):
    - every `navigation` string;
    - `contactsPage.heading`/`lineHeading`/`listHeading`;
    - `pageText.notFound.*`, `privacy.label`/`title`, `live.heading`, `collectionNotice.heading`;
    - `assetLicence.text`/`linkText`;
    - `connect.intro`;
    - every `DirectoryContact` string.
  - **Required non-empty** ("Enter text for this field."): `navigation.newsLabel`, `liveLabel` and every `labels.*`/`listingTitles.*`; `pageText.notFound.heading`; `privacy.title`; `contactsPage.heading`.
  - **Lengths** ("Keep it to N characters or fewer."):
    - labels and listing titles 60 (`HEADING_MAX`); `newsLabel`/`liveLabel` 40;
    - `notFound.text` 300; `connect.intro` 300; `assetLicence.text` 200; `assetLicence.linkText` 100;
    - each HTML field 50,000;
    - each `DirectoryContact` field 100, phones 50.
  - **List sizes** ("Keep the list to N or fewer."): `headerLinks` ≤ 4, `contacts` ≤ 30, `searchArchiveLinks` ≤ 10.
  - **Links:**
    - `headerLinks`, `searchArchiveLinks` and the LinkedIn lists go through `validateLinks`;
    - `connect.policyLink` and `assetLicence.url` are either both text and URL empty, or a safe URL ("Must start with https:// or / (a page on this site).");
    - `DirectoryContact.groupUrl` is "" or safe;
    - `DirectoryContact.email` is "" or matches `^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$` ("Enter an email address like name@gov.bc.ca.");
    - `DirectoryContact.group` and `name` are required.
  - **HTML fields** are length-checked only; the public site sanitises them at render (Global Constraints).

- [ ] **Step 1: Write failing tests**

```ts
// defaults.test.ts
it("fillMissingFields fills contactsPage, pageText, navigation, connect.linkedin/policyLink/intro from defaults and keeps a stored value, including ''")
it("bc.site-settings.json loads (loadSiteSettingsDefaults) and validates; contactsPage.contacts has 2 top and 1 bottom row")
it("neutral defaults validate")
// validate.test.ts
it("refuses markup in navigation.labels.resources with 'Use plain text.' on that path")
it("refuses a 5th headerLink, a 31st directory contact, an 11th archive link")
it("refuses contactsPage.contacts[0].email 'x@' and groupUrl 'javascript:alert(1)'; accepts '' for both")
it("assetLicence: url without text is refused; all three empty is accepted")
it("connect.policyLink with an http:// url is refused")
// model / sections tests
it("NETWORKS puts linkedin after bluesky; policyLink and intro are not networks")
it("differingSections reports contactsPage/pageText/navigation edits")
// public-site settings.test.ts / news-api-client.test.ts
it("a published document without the plan-4 parts parses and currentSettings returns it filled")
// packages/events catalogue test
it("a site.settings.published event recorded before plan 4 still parses")
// apps/nrms site-settings.test.ts
it("PUT section 'pageText' saves a draft; a stored revision without pageText reads back filled")
```

- [ ] **Step 2:** Run `npx vitest run packages/site-settings packages/events apps/nrms/src/website apps/public-site/src/settings.test.ts apps/public-site/src/news-api-client.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Copy the privacy and notice HTML from `WA/` by hand, and keep the wording byte for byte.
- [ ] **Step 4:** Run the same command, plus `npx vitest run --project staff-web apps/staff-web/src/screens/website/settings` and `npm run check`. Expected: PASS. The Social screen now shows a LinkedIn network with the BC defaults.
- [ ] **Step 5: Commit** with `git commit -m "feat(site-settings): contactsPage, pageText and navigation sections; Connect LinkedIn, policy link and intro, filled for documents published before them"`.

---

### Task 3: Core + Hub — "Additional display name" on the ministry profile (T2 remainder)

**Files:**
- Modify: `apps/core/src/services/organizations.ts` (`orgProfilePatchSchema`), `organizations.test.ts` and `apps/core/src/http/routes.test.ts`.
- Modify: `apps/staff-web/src/screens/admin/organizations/OrganizationEditForm.tsx` and its test.

**Interfaces — Produces:**
- `orgProfilePatchSchema.displayAdditionalName: trimmedOrNull`, at most 100 characters ("Keep it to 100 characters or fewer."). It is not in `ADMIN_ONLY_PROFILE_FIELDS`.
- The form adds a TextField "Additional display name" after "Name", with the hint "Shown in brackets under the ministry on the Media Contacts page, for example (Child Care)." It is sent only when changed; blank sends `""`, which Core stores as null.
- `INLINE_FIELD` also matches `displayAdditionalName`.

- [ ] **Step 1: Write failing tests**

```ts
it("PATCH displayAdditionalName trims and stores; '' stores null; 101 characters is refused on displayAdditionalName")
it("NRMS.SiteEditor may PATCH displayAdditionalName")
it("form: editing Additional display name sends displayAdditionalName; untouched is not sent")
```

- [ ] **Step 2:** Run `npx vitest run apps/core/src/services/organizations.test.ts apps/core/src/http/routes.test.ts` and `npx vitest run --project staff-web apps/staff-web/src/screens/admin/organizations`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same commands, plus `npx vitest run apps/news-api/test/compat.test.ts` and `npm run check`. Expected: PASS. The v1 `displayAdditionalName` already flows.
- [ ] **Step 5: Commit** with `git commit -m "feat(core,staff-web): ministry Additional display name editable on the Organizations form"`.
- [ ] **Step 6: Deploy batch A.** On boxs.ca:
  - `/connect/` shows a LinkedIn section;
  - the Hub Social screen lists LinkedIn;
  - `curl -s 'https://boxs.ca/api/Ministries/education-and-child-care?api-version=1.0' | jq .displayAdditionalName` matches what was entered.

---

## Batch B — Media Contacts, page text, privacy, 404, licence

### Task 4: Hub — Media contacts page screen `/website/media-contacts` (T3)

**Files:**
- Create: `apps/staff-web/src/screens/website/settings/MediaContactsScreen.tsx` and its test, and `apps/staff-web/src/screens/website/settings/DirectoryContactsEditor.tsx` and its test.
- Modify: `apps/staff-web/src/router.tsx`, `WebsiteScreen.tsx` and `a11y.test.tsx`.

**Interfaces — Consumes:** `ContactsPageSettings` and `DirectoryContact` (Task 2). **Produces:**
- `MediaContactsScreen`, titled "Media contacts page", with these fields:
  - TextFields "Page heading", "Contact line heading" and "List heading";
  - a `BodyEditor` "Introduction" (hint: "Include the 24-hour media line number here.");
  - `DirectoryContactsEditor` "Other media contacts".
- `DirectoryContactsEditor({ value, onChange, errors, pathPrefix: "contactsPage.contacts", disabled })`. One fieldset per row, with legend "Contact {n}". It holds:
  - Group, Group link, Subgroup, Name, Phone (`type=tel`), Cell (`type=tel`), Email (`type=email`);
  - a Placement radio group ("Above the ministries" / "Below the ministries");
  - Move up, Move down and Remove buttons (`reorder.ts`).

  "Add contact" appends a blank `top` row.
- The help text above the editor reads: "Ministry contacts come from each ministry's Organizations form."

- [ ] **Step 1: Write failing tests**

```ts
it("loads the published contactsPage and shows the three BC rows with their placement")
it("adds, edits, moves and removes a contact; Save sends the whole contactsPage section")
it("a server error on contactsPage.contacts[1].email shows beside row 2's Email")
it("a Core.Admin without NRMS.SiteEditor sees the fields disabled")
it("a11y: MediaContactsScreen has no axe violations")
```

- [ ] **Step 2:** Run `npx vitest run --project staff-web apps/staff-web/src/screens/website`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same, plus `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(staff-web): Media contacts page settings screen (T3)"`.

---

### Task 5: Hub — Page text screen `/website/page-text` (T4)

**Files:**
- Create: `apps/staff-web/src/screens/website/settings/PageTextScreen.tsx` and its test.
- Modify: `router.tsx`, `WebsiteScreen.tsx` and `a11y.test.tsx`.

**Interfaces — Consumes:** `PageTextSettings` (Task 2). **Produces:** `PageTextScreen`, titled "Page text", with one fieldset per page, in this order:
1. **"Page not found":** Heading, Text.
2. **"Privacy page":** Label, Title, `BodyEditor` "Statement".
3. **"Live webcast page":** Heading; `BodyEditor` "Before play", with the hint "{host} is replaced by the stream's host name."; `BodyEditor` "When not live".
4. **"Subscribe page":** "Notice heading", `BodyEditor` "Notice of Collection", `BodyEditor` "Help line".
5. **"Media assets licence":** Text, Link text, Link URL.
6. **"Search: older archives":** `LinkListEditor` with `pathPrefix="pageText.searchArchiveLinks"` and `reorderable`.

- [ ] **Step 1: Write failing tests**

```ts
it("shows the six fieldsets with the published values")
it("editing the privacy statement and saving sends pageText with bodyHtml from the editor")
it("a server error on pageText.assetLicence.url shows beside Link URL")
it("adds an older-archive link; an unsafe URL error shows on that row")
it("a11y: PageTextScreen has no axe violations")
```

- [ ] **Step 2:** Run `npx vitest run --project staff-web apps/staff-web/src/screens/website`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same, plus `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(staff-web): Page text settings screen — 404, privacy, live, subscribe notice, assets licence, older archives (T4)"`.

---

### Task 6: Public — Media Contacts directory `/contacts/` (H3) and in-site Resources links

**Files:**
- Create: `apps/public-site/src/pages/contacts.ts` and its test, and `apps/public-site/src/pages/comm-contact.ts` (moved from `categories.ts`: `commContact`, `mailtoLink`, `contactValue`).
- Modify: `site-paths.ts` (and its test), `builder.ts`, `change-feed.ts` (and its test), `dto.ts` (`MinistryDto.displayAdditionalName?: string | null`), `settings.ts`, `rebuild.ts`, `rebuild-all.ts` and their tests.
- Modify: `pages/home.ts` (the Resources href), `pages/categories.ts` (import from `comm-contact.ts`), `assets/site/overrides.css`, `scripts/fixture-site.ts` and `test/fake-news-api.ts`.

**Interfaces — Produces:**
- `PageId { type: "contacts" }`, with id `contacts`, files `["contacts/index.html"]` and URL `${base}/contacts/`.
- `commContact(c: MinistryContactDto | null): string` emits legacy `CommContact.cshtml`. A settings `DirectoryContact` is first mapped to `{ fullName: name, phoneNumber: phone, mobileNumber: cell, emailAddress: email }` (blanks as null). The output is:
  - `span.contact-name`;
  - `div` with `Direct:` and `Cell:` spans, joined by `<br>` only when both exist;
  - an email `a[href=mailto]`, or the plain text when `safeHref("mailto:"+email)` fails.
- `resourceHref(uri: string, site): string | null`: a `/…` path gets the base path (`settingsHref` rules). Home's Resources box uses it.
- `renderContactsPage(ministries: MinistryDto[], cp: ContactsPageSettings, site, opts): string`. The body is `div.comm-contacts` holding, in order:
  - `h1.comm-contacts-title{heading}` and `div.clear`;
  - `div.header` with `h2{lineHeading}` (when non-empty) and `div.row > div.col{introHtml, sanitised}`;
  - `div.header` with `h2{listHeading}`;
  - `div.row.d-none.d-md-flex.contact-columns[aria-hidden=true]` with three `div.col` ("", "Primary Contact", "Alternate Contact");
  - rows: `top` contacts, then ministries, then `bottom` contacts.

  A row is `div.row.contact-row`:
  - `div.col-xs-12.col-sm-4.contact-org`: `a[href]{name}` (a ministry page or a safe `groupUrl`; else a `span`), plus `div > i ({displayAdditionalName})` and `div{ministerName}` when non-empty, or `div{subgroup}` for settings rows;
  - `div.col-xs-12.col-sm-4` with `<span class="visually-hidden">Primary contact: </span>` and `commContact(primary)`;
  - the same block for the alternate when present;
  - with an after-hours number, `div.text-center.after-hours > div > span > strong "After hours:" {number}`.

  Ministries are active, have a `contactUser`, and come in News API order. A child (`parentMinistryKey` set) follows its parent and gets `.child` on `.contact-org`. A child whose parent is absent keeps its place.
- `overrides.css`:
  - `.comm-contacts-title` gets legacy `.comm-contacts h3` metrics, and `.comm-contacts .header h2` gets `h4` metrics;
  - `.contact-org.child{margin-left:25px}`;
  - `@media (min-width:768px){.after-hours span{padding-left:200px}}`.
- Wiring:
  - `contactsPageHash` → `SectionPages "contacts"` → `["contacts"]`;
  - `pagesForChange` for `ministry` adds `contacts`;
  - `aggregatePageIds` adds `contacts`;
  - `sitemap:pages` lists `/contacts/`.
- Builder: `case "contacts"` writes `renderContactsPage(await ministries(run), opts.settings.contactsPage, …)`.

- [ ] **Step 1: Write failing tests**

```ts
// contacts.test.ts (JSDOM)
it("one h1 (heading); the intro keeps its links and the 24-hour number; no target=_blank")
it("rows in order: two top settings rows, ministries in API order with children after their parent (.child), the bottom Premier row")
it("a ministry without contactUser, or inactive, is left out; a blank ministerName adds no empty div")
it("contact with phone only shows Direct: and no <br>; cell only shows Cell:; a bad email renders as text")
it("after hours row only with weekendContactNumber; displayAdditionalName in brackets and italics")
it("introHtml with <script>, <iframe>, onclick and <h1> renders one h1 and none of them")
it("each contact cell carries a visually-hidden Primary/Alternate label; the column header row is aria-hidden")
// site-paths.test.ts
it("parsePageId('contacts') round-trips; pageFiles is contacts/index.html")
// change-feed.test.ts
it("a ministry change queues contacts")
// rebuild.test.ts
it("a contactsPage edit queues exactly contacts")
// home.test.ts
it("a '/contacts/' resource link gets the base path; an https link is unchanged")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `/contacts/` to `FIXTURE_PAGES`. The fixture holds two ministries with contacts, one of them a child, and uses the BC settings. Apply R10.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): Media Contacts directory at /contacts/ (H3); in-site Resources links get the base path"`.

---

### Task 7: Public — `/privacy/` (L1), 404 text from settings, media-assets licence line (L3)

**Files:**
- Create: `apps/public-site/src/pages/privacy.ts` and its test.
- Modify: `site-paths.ts`, `builder.ts`, `static-pages.ts`, `pages/release.ts`, `settings.ts`, `rebuild.ts`, `rebuild-all.ts`, their tests and `overrides.css`.
- Vendor: nothing.

**Interfaces — Produces:**
- `PageId { type: "privacy" }`, with files `["privacy/index.html"]` and URL `${base}/privacy/`.
- `renderPrivacyPage(p: PageTextSettings["privacy"], site, opts)` emits `div.connect > div.home-body#main-content-release`, holding:
  - `p.page-label{label}` (legacy `h3`, styled by overrides);
  - `h1{title}`;
  - `div#body{sanitizeBodyHtml(demoteHeadings(bodyHtml))}`.

  There is no "Reset Preferences" block (spec conflict 9).
- `renderNotFoundPage` takes `h1{notFound.heading}` and `p{notFound.text}` from `opts.settings.pageText`. The prefilled search form stays.
- Release `#assets`: after the list, `p.assets-licence{text} <a href>{linkText}</a>.` appears when `text` is non-empty. The href comes from `settingsHref(url)`; an unsafe URL renders the link text plain.
- Wiring:
  - `privacyHash` → `"privacy"` → `["privacy"]`;
  - `notFoundHash` → `"static"`;
  - `assetLicenceHash` → `"releaseLicence"`, added to `RELEASE_SECTIONS` (every post, at bulk priority);
  - `aggregatePageIds` and `sitemap:pages` add privacy.

- [ ] **Step 1: Write failing tests**

```ts
// privacy.test.ts
it("one h1 (title); label paragraph; body paragraphs kept with their links")
it("bodyHtml with <h1>, <script>, <iframe>, <img onerror> → still one h1, none of the others")
// static-pages.test.ts
it("404.html shows the settings heading as h1 and the text; the search form is still prefilled from the path")
// release.test.ts
it("licence line after the assets list with the settings text and link; empty text → no line; javascript: url → link text only")
// rebuild.test.ts
it("a privacy edit queues exactly privacy; a notFound edit queues exactly static; an assetLicence edit queues every post and nothing else")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `/privacy/` to `FIXTURE_PAGES`. Apply R10; batch B bumps at most once.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): /privacy/ page, 404 and media-assets licence text from Page text settings (L1, L3)"`.
- [ ] **Step 6: Deploy batch B, then verify:**
  1. In the Hub's `/website/links`, set the Resources "Media Contacts" URL to `/contacts/`. This is a data change. "Factsheets" waits for batch E, when its page exists.
  2. Run `npm run parity -- --target https://boxs.ca --pages contacts,privacy`. Expected: the visual-task gate passes.
  3. `curl -s https://boxs.ca/ | grep -c 'href="https://news.gov.bc.ca/contacts'` prints `0`.
  4. Check Intergovernmental Relations Secretariat on `/contacts/`. Legacy hides its minister name. If boxs.ca shows one, raise owner question 4.

---

## Batch C — navigation and labels, action label, Live webcast

### Task 8: Hub — Navigation and labels screen `/website/navigation` (T5, T9 listing titles)

**Files:**
- Create: `apps/staff-web/src/screens/website/settings/NavigationScreen.tsx` and its test.
- Modify: `router.tsx`, `WebsiteScreen.tsx` and `a11y.test.tsx`.

**Interfaces — Consumes:** `NavigationSettings`, `LABEL_KEYS` and `LISTING_KINDS` (Task 2). **Produces:** `NavigationScreen`, titled "Navigation and labels", with these fieldsets:
- **"Header":**
  - "News menu label" and "Live webcast button label";
  - `LinkListEditor` "Header links" (`navigation.headerLinks`, reorderable, max 4);
  - Checkbox "Show the search box in the header".
- **"Footer headings":** two text fields.
- **"Page labels":** one TextField per `LABEL_KEYS` entry, labelled for example "Connect With Us heading" and "Slide link label (when a slide has none)".
- **"Listing titles":** four fields, "Releases page title" … "Updates page title".

- [ ] **Step 1: Write failing tests**

```ts
it("shows header, footer headings, page labels and listing titles from the published navigation")
it("unchecking 'Show the search box' and saving sends showHeaderSearch: false")
it("a server error on navigation.labels.loadMoreNews shows beside its field")
it("a11y: NavigationScreen has no axe violations")
```

- [ ] **Step 2:** Run `npx vitest run --project staff-web apps/staff-web/src/screens/website`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same, plus `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(staff-web): Navigation and labels settings screen (T5; listing titles from T9)"`.

---

### Task 9: NRMS + Hub — action label per slide and per pin (T6)

**Files:**
- Modify: `apps/nrms/src/db/schema.ts`, `apps/nrms/src/website/carousel.ts`, `apps/nrms/src/website/events.ts`, `apps/nrms/src/http/site-routes.ts` and their tests.
- Create: the next NRMS migration, generated (`npm --workspace @gcpe/nrms run db:generate`) and renamed `<next>_slide_action_label.sql`. It holds `ALTER TABLE "slides" ADD COLUMN "action_label" text DEFAULT '' NOT NULL;` and the same for `"emergency_pins"`.
- Modify: `apps/staff-web/src/screens/website/CarouselScreen.tsx`, `PinsScreen.tsx`, `types.ts` and their tests.

**Interfaces — Produces:**
- The slide and pin inputs and views gain `actionLabel: string`: trimmed, at most 40 characters, no `<`/`>`. The NRMS error is "Keep the action label to 40 characters or fewer, in plain text."
- `slideRecord` emits `actionLabel: s.actionLabel.trim() || null`.
- The Hub adds a TextField "Action label" beside "Action URL" on each slide and pin, with the hint: "The link text. Leave empty for the default set in Navigation and labels."

- [ ] **Step 1: Write failing tests**

```ts
// apps/nrms carousel.test.ts / events.test.ts
it("saves a slide's actionLabel and emits it; '' emits null")
it("refuses a 41-character or '<b>' action label")
it("pins carry actionLabel the same way")
// staff-web
it("CarouselScreen edits a slide's Action label and sends actionLabel")
it("PinsScreen edits a pin's Action label")
```

- [ ] **Step 2:** Run `npx vitest run apps/nrms/src/website` and `npx vitest run --project staff-web apps/staff-web/src/screens/website`. Expected: FAIL.
- [ ] **Step 3:** Implement and generate the migration.
- [ ] **Step 4:** Run the same, plus `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(nrms,staff-web): action label per carousel slide and emergency pin (T6)"`.

---

### Task 10: Public — header from settings, Live Webcast button, page labels

**Files:**
- Modify: `apps/public-site/src/header.ts`, `render.ts` (footer headings), `pages/home.ts`, `pages/post-card.ts` (`latestCards` label), `pages/categories.ts` (labels), `site-script.ts`, `settings.ts`, `rebuild.ts`, `rebuild-all.ts`, `dto.ts` (`HomeDto`), `overrides.css` and their tests.

**Interfaces — Produces:**
- `HomeDto` adds `liveWebcastM3uPlaylist?: string | null`.
- `liveStreamUrl(home: HomeDto): string | null` returns the URL only when `isSafeUrl(u, { relative: false, schemes: ["https:"] })`. Anything else is null, with one log per process: `[public-site] live webcast URL is not https; shown as off air`.
- `liveJson(home): string` → `{"live":true}` or `{"live":false}`. No URL goes in the file.
- Header:
  - The News label comes from `navigation.newsLabel`.
  - `navigation.headerLinks` render as `li.nav-item > a.nav-link`, with hrefs via `settingsHref` and their ids kept.
  - The desktop search form and the phone search toggle and drawer render only when `showHeaderSearch`. The search page's `pageSearchInput` rule is unchanged.
  - After `#sm-nav-container`: `<a id="live-button" href="{base}/live/" class="btn btn-primary-blue live_button live_button_hide d-none d-lg-block">{liveLabel}</a>`.
- Footer column headings come from `navigation.footerConnectHeading`/`footerMoreInfoHeading`.
- Labels:
  - home: Connect With Us, View all Social Media, Resources, News by Sector, Emergency information, the Highlights `aria-label`, the visually hidden `h1`, Load More News, Search News and the slide fallback;
  - ministry pages: Load More News and Search News.
- `latestCards(site, latest, o?: { loadMoreLabel?: string }): { cards; loadMore }`.
- `site.js`: on load and every 60 s, `fetch(base + "/assets/live.json", { cache: "no-store" })`. `live: true` swaps `live_button_hide`→`live_button_show` on `#live-button`. Anything else, or a failure, leaves it hidden. It polls only when `#live-button` exists.
- Wiring:
  - `headerHash` = hash of `newsLabel`, `liveLabel`, `headerLinks`, `showHeaderSearch` and the footer headings. It joins the `all` comparison in `chromeChanges`, like `footerHash`.
  - `labelsHash` = hash of `labels` and `listingTitles` → `"labels"` → `builder.aggregatePageIds()`.

- [ ] **Step 1: Write failing tests**

```ts
// header.test.ts
it("News label, header links (base path, ids) and the Live button (hidden class, base path, settings label)")
it("showHeaderSearch false: no header search form, no phone toggle or drawer")
// render.test.ts
it("footer column headings come from navigation")
// home.test.ts
it("every home label comes from navigation.labels; a slide without actionLabel uses labels.slideActionLabel")
// site-script.test.ts
it("live.json {live:true} shows #live-button; {live:false}, a 404 and a network error leave it hidden; it polls every 60 s")
// settings/live
it("liveStreamUrl: https URL kept; http:, javascript:, '/x.m3u8' and null → null")
// rebuild.test.ts
it("a headerLinks edit is a rebuild-all; a labels edit queues aggregatePageIds and no post")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site`. Expected: FAIL.
- [ ] **Step 3:** Implement. Apply R10.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): header and labels from Navigation settings, Live Webcast button driven by assets/live.json (M13)"`.

---

### Task 11: Public — Live webcast page `/live/` (H4)

**Files:**
- Create: `apps/public-site/src/pages/live.ts` and its test.
- Modify: `site-paths.ts`, `builder.ts`, `change-feed.ts`, `site-script.ts`, `site-assets.ts` (copy `hls.js`), `settings.ts`, `rebuild.ts`, `rebuild-all.ts`, their tests, `apps/public-site/package.json` (`hls.js`, exact version pin) and `assets/legacy/NOTICE.md`.
- Vendor: `WA/wwwroot/Content/Images/Gov/Live_Webcast.png` (69,997 B). Update the vendored count test.

**Interfaces — Produces:**
- `PageId { type: "live" }`, with files `["live/index.html", "assets/live.json"]` and URL `${base}/live/`.
- `writeBuiltinAssets` copies `node_modules/hls.js/dist/hls.light.min.js` to `assets/vendor/hls.light.min.js`. `NOTICE.md` names it, with its licence.
- `renderLivePage(stream: string | null, t: PageTextSettings["live"], site, opts)` emits `div.connect > div.home-body#main-content-release` with `h1.page-label{heading}`, then `div#body.container.live-body` holding:
  - **Live:** `div.wowza-wrapper.asset.wowza.video[data-stream={stream}]` holding:
    - `div.placeholder-container`, with `img[src={base}/assets/legacy/Content/Images/Gov/Live_Webcast.png][alt=""][width=768][height=432]` and `div.overlay-container > div.outer > div.inner`, which holds `button.play-button[type=button][aria-describedby=live-consent]` ("Play the live webcast", visually hidden) and `div#live-consent.play-instructions.preface{consentHtml}`;
    - `video[controls][preload=none][playsinline][hidden]`;
    - `p#live-status[role=status]`;
    - `p.live-stream-link > a[href={stream}] "Open the stream in your media player"`.

    `{host}` in `consentHtml` is replaced, after sanitising, with the escaped host of `stream`.
  - **Off air:** `div.wowza-wrapper.asset.video.off-air` with the same image and `{offAirHtml}`.
- `site.js`, on `.play-button` click:
  1. hide the placeholder and show the video;
  2. if `video.canPlayType("application/vnd.apple.mpegurl")`, set `video.src = stream`;
  3. otherwise load `{base}/assets/vendor/hls.light.min.js` once (a `script` element) and run `new Hls().loadSource(stream)` and `attachMedia(video)`;
  4. call `video.play()`.

  Any error sets `#live-status` to "The webcast can't play here. Use the stream link below." No request goes to the stream host before the click.
- Builder:
  - `case "live"` reads `newsApi.home()`, then writes the page and `assets/live.json` (`liveJson`).
  - `pagesForChange("home")` adds `live`.
  - `aggregatePageIds` and `sitemap:pages` add it.
  - `liveTextHash` → `"live"` → `["live"]`.

- [ ] **Step 1: Write failing tests**

```ts
// live.test.ts
it("live: one h1, the placeholder with alt='', a play button described by the consent text with {host} replaced, video preload=none hidden, stream link")
it("off air: the off-air text, no video, no data-stream")
it("no src or data-stream ever holds a non-https URL (http:, javascript:)")
it("consentHtml with <script> or onclick renders without them")
// site-script.test.ts
it("play: native HLS sets video.src; otherwise appends one script for assets/vendor/hls.light.min.js; error → status text")
it("no fetch or src for the stream host before the click")
// builder.test.ts
it("renders live/index.html and assets/live.json; a home change queues live")
// rebuild.test.ts
it("a pageText.live edit queues exactly live")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `/live/` to `FIXTURE_PAGES`; the fixture home carries an https stream. Apply R10; batch C bumps at most once.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): Live webcast page /live/ with consent-first playback and vendored hls.js (H4)"`.
- [ ] **Step 6: Deploy batch C, then verify:**
  1. Run `npm run parity -- --target https://boxs.ca --pages home,live,ministry`. Expected: the gate passes.
  2. In the Hub's `/website/live-feed`, switch on with an https test stream. Within 60 s plus one drain, `curl -s https://boxs.ca/assets/live.json` prints `{"live":true}` and the header button shows at 1280 px.
  3. Press Play in Chrome and Safari. Expected: it plays (hls.js in Chrome, native in Safari).
  4. Switch off. The button hides and `/live/` shows the off-air text.
  5. Run a keyboard pass on the Play button.

---

## Batch D — Connect

### Task 12: Hub — Social screen: policy link and intro (T7)

**Files:**
- Modify: `apps/staff-web/src/screens/website/settings/SocialScreen.tsx` and its test.

**Interfaces — Produces:** above the network tabs, a "Connect page" fieldset holding:
- "Policy link text" and "Policy link URL" (`connect.policyLink.text`/`url`);
- "Introduction" (`connect.intro`, a plain-text textarea).

The LinkedIn tab comes from `NETWORKS` (Task 2).

- [ ] **Step 1: Write failing tests**

```ts
it("shows the LinkedIn network with Government of BC featured")
it("edits the policy link and intro and sends them in the connect section")
it("a server error on connect.policyLink.url shows beside Policy link URL")
```

- [ ] **Step 2:** Run `npx vitest run --project staff-web apps/staff-web/src/screens/website/settings`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same, plus `a11y.test.tsx` and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(staff-web): Connect page policy link and introduction on the Social links screen (T7)"`.

---

### Task 13: Public — Connect page look, LinkedIn, RSS list, policy link (M12); shared Connect With Us strip (L6)

**Files:**
- Create: `apps/public-site/src/pages/connect-strip.ts` and its test (moved from `home.ts` `connectBox`), and `apps/public-site/src/pages/resources.ts` (`resourcesBox`, moved from `home.ts`).
- Modify: `pages/connect.ts`, `pages/home.ts`, `builder.ts`, `change-feed.ts`, `rebuild-all.ts`, `overrides.css`, `scripts/fixture-site.ts` (`/connect/` in `FIXTURE_PAGES`) and their tests.

**Interfaces — Produces:**
- `connectStrip(settings: SiteSettings, base: string): string` emits legacy `ConnectSocialMedia`:
  - `div.resource-links.connect > h2{labels.connectWithUs}`;
  - one `ul` with `li > a[id=connect{Name}][href={base}/connect/#{key}] > img[alt={Name}][width=22][height=22]` for Facebook, X, Instagram, Threads, Bluesky, LinkedIn, Flickr and YouTube (each only with accounts), then RSS (`#rss`, `rss-logo.svg`, alt "RSS"), which is always present;
  - `a#connectAllSocialMedia.read-more[href={base}/connect/]{labels.viewAllSocialMedia}`.

  Legacy's two-row split is replaced by one `ul` that wraps, as live now shows (9 icons, one list). Legacy ids are kept, with `connectThread` spelled as legacy.
- `resourcesBox(site, heading, links: ResourceLinkDto[]): string` uses `resourceHref` (Task 6).
- `renderConnectPage(site, opts, feeds: { title: string; href: string }[], links: ResourceLinkDto[])`:
  - Body: `div.connect#connect-content > div.home-layout`, holding `div.home-body#main-content-release` and `section.home-features[aria-label="Resources"]{resourcesBox}`.
  - The home-body holds `h1 "Connect"`, `p > a{policyLink}` (when set), `p.connect-intro{intro}` (when non-empty), then one block per network.
  - A network block is `<details class="expandable-section {cls} expanded" id="{key}" open><summary><h2>{NETWORK_HEADING[key]} {icon}</h2></summary><div class="expandable-section-content"><div class="expander-body"><ul class="external-links"><li><a>{text}</a> <span>{summary}</span></li>…</ul></div></div></details>`.
  - `cls` is `twitter` for `x` (legacy CSS), else the key.
  - `NETWORK_HEADING`: "Find us on Facebook", "Follow us on X", "Find us on Instagram", "Find us on Threads", "Find us on Bluesky", "Find us on LinkedIn", "See Photos in Flickr", "Watch us on YouTube", "Blogs and Engagement Sites".
  - Then `details.expandable-section.rss#rss` "RSS Feeds" listing `feeds`.
  - A network with no links is left out. The `#{key}` ids stay, so `/connect/#x` lands.
- Builder `connect`: `feeds` = `{ site.name, feedUrl(home) }`, then active ministries, sectors and tags (no themes) merged, sorted by name with `localeCompare("en")`, each with `feedUrl(category)`. The factsheets row waits for Task 23. `links` = `newsApi.resourceLinks()`.
- Wiring:
  - `pagesForChange` for `ministry`, `sector` and `tag` adds `connect`;
  - `resource_links` adds `connect`;
  - the `connect` section mapping stays `["connect", "home"]`. Task 14 extends it.
- Home uses `connectStrip` and `resourcesBox`.

- [ ] **Step 1: Write failing tests**

```ts
// connect.test.ts
it("one h1; policy link and intro from settings; a details block per network with links, ids facebook…blogs and rss")
it("x uses class twitter; headings are the legacy ones; no target=_blank; no .article-fade")
it("RSS Feeds: site feed first, then ministries, sectors and tags by name with base-path feed URLs; no themes")
it("Resources section beside the body from resource links")
// connect-strip.test.ts
it("lists networks with accounts plus RSS; LinkedIn appears with BC defaults; RSS alt is 'RSS'; labels from navigation")
// change-feed.test.ts
it("ministry, sector and tag changes and resource_links queue connect")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site`. Expected: FAIL.
- [ ] **Step 3:** Implement. Apply R10.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): news.gov Connect page with LinkedIn, RSS feeds and policy link; shared Connect With Us strip with LinkedIn and RSS (M12, L6)"`.
- [ ] **Step 6: Deploy batch D.** Run `npm run parity -- --target https://boxs.ca --pages connect,home`. Expected: the gate passes. `https://boxs.ca/connect/#linkedin` and `#rss` land on their sections.

---

## Batch E — listings and indexes

### Task 14: Public — per-kind listings `/releases/`, `/stories/`, `/factsheets/`, `/updates/` (H5)

**Files:**
- Create: `apps/public-site/src/pages/listing.ts` and its test.
- Modify: `site-paths.ts`, `builder.ts`, `news-api-client.ts`, `rebuild-set.ts`, `post-index.ts` (`kind` in `Membership`), `change-feed.ts`, `rebuild-all.ts`, `overrides.css`, `scripts/fixture-site.ts`, `test/fake-news-api.ts` and their tests.

**Interfaces — Produces:**
- `LISTING_KINDS` is re-exported from `@gcpe/site-settings`. `PageId { type: "kind"; kind: ListingKind }` has id `kind:<kind>`, files `[`${kind}/index.html`]` and URL `${base}/${kind}/`.
- `NewsApiClient.latestOfKind` (signature under "Plan 3 coordination").
- Builder:
  - `kindPosts(run, kind): Promise<PostDto[]>` = the plan-3 merge of the home top/feature (`RunCache.homeFeatured`) with `latestOfKind(kind, LATEST_COUNT)`.
  - `case "kind"` writes `renderKindListing(kind, settings.navigation.listingTitles[kind], posts, await newsApi.resourceLinks(), site, opts)`.
- `renderKindListing(...)` emits `div.home-layout`:
  - `div.home-body#main-content-release`, holding:
    - `h1.listing-title{title}`;
    - `div.other-articles > div#regular-articles.regular-articles{latestCards(…, { loadMoreLabel: "Load More " + title })}`;
    - `div.news-control`, with the Load More button and `a.read-more[href={base}/search/?type={kind}]{labels.searchNews}`;
    - with no posts, `p.listing-empty "Nothing has been published yet."`.
  - `section.home-features[aria-label="Connect and resources"]{connectStrip}` + `div.collapsible-regions{resourcesBox}`.
- `Membership.kind?: string`. `dependentPages` adds `kind:<kind>` for a listing kind, before and after.
- `pagesForChange`: `home` and `resource_links` add the four kind ids.
- The `connect` section mapping adds the four kind ids.
- `aggregatePageIds` and `sitemap:pages` add them.
- `overrides.css`: `.listing-title` gets legacy `.home-body h3` metrics.

- [ ] **Step 1: Write failing tests**

```ts
// listing.test.ts
it("one h1 with the settings title; 3 cards shown, the rest hidden, 'Load More Factsheets & Opinion Editorials' button; Search News → /search/?type=factsheets")
it("strip and Resources in a labelled section after the body; no <aside>")
it("no posts → empty message, no Load More")
// builder.test.ts
it("factsheets listing includes a factsheet that is the home top post, newest first, no duplicates")
// rebuild-set.test.ts
it("a factsheet post queues kind:factsheets; a post moving from stories to releases queues both")
// site-paths.test.ts
it("parsePageId('kind:factsheets') round-trips; 'kind:advisories' and 'kind:x' are null")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site`. Expected: FAIL.
- [ ] **Step 3:** Implement. The fixture gets posts of kind factsheets and stories. Add `/factsheets/` and `/stories/` to `FIXTURE_PAGES`. Apply R10.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): per-kind listing pages /releases/, /stories/, /factsheets/, /updates/ (H5)"`.

---

### Task 15: Public — per-ministry factsheets `/ministries/<key>/factsheets/` and the Factsheets side link

**Files:**
- Modify: `site-paths.ts` (`categoryFiles`), `builder.ts`, `news-api-client.ts`, `pages/categories.ts`, `pages/side-links.ts`, `pages/release.ts` (caller of `ministryLinkGroups`), `scripts/fixture-site.ts` and their tests.

**Interfaces — Produces:**
- `categoryFiles(p: { type: "category" } & PageId): { page: string; feed: string; bio?: string; factsheets?: string }`. Ministries get `bio` and `factsheets` (`ministries/<key>/factsheets/index.html`). `pageFiles` returns `Object.values` of it. If plan 3 Task 7 has merged, its `atom` role is kept.
- `factsheetsUrl(site, key)` → `${base}/ministries/<key>/factsheets/`.
- `NewsApiClient.latest(kind, key, count, o?: { postKind?: string })` appends `&postKind=`.
- `renderMinistryFactsheetsPage(m, minister, posts: PostDto[], site, opts, ctx: MinistryPageContext)` reuses the ministry page skeleton with these differences:
  - `div.pt-2.ministry-listing.fact-sheets`;
  - `h1.ministry-name-mobile{m.name}`, then `h2.listing-title "Factsheets"`;
  - no top or feature article;
  - Search News → `/search/?type=factsheets&ministry=<key>`;
  - Load More is labelled "Load More";
  - the side column and collapsible regions are unchanged;
  - title "Factsheets: {m.name}", and the feed is the ministry feed (legacy).
- Builder: the ministry render also fetches `latest("ministries", key, LATEST_COUNT, { postKind: "factsheets" })`, merges the ministry's top/feature factsheets, and always writes the factsheets file. A vanished ministry removes it.
- `ministryLinkGroups(site, m, labels)` puts `{ text: "Factsheets", url: factsheetsUrl(site, m.key) }` first under More from this Ministry. That reaches ministry, biography and release side columns, and reverses C239. "Factsheets" stays a hardcoded legacy heading.
- `sitemap:pages` lists every ministry's factsheets URL.

- [ ] **Step 1: Write failing tests**

```ts
it("categoryFiles(ministries:health) has page, feed, bio and factsheets; a sector has page and feed only")
it("factsheets page: one h1 (ministry name), Factsheets heading, cards, minister card in the side column, Search News with type and ministry")
it("no factsheets → empty message; the page is still written")
it("More from this Ministry starts with Factsheets on ministry and release pages")
it("removing the ministry removes its factsheets page")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `/ministries/health/factsheets/` to `FIXTURE_PAGES`. Apply R10.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): per-ministry factsheets page and the Factsheets entry in More from this Ministry (H5)"`.

---

### Task 16: Public — sector, theme and tag pages in the news.gov look (`Sector.cshtml`)

**Files:**
- Modify: `pages/categories.ts` (`renderCategoryPage`), `builder.ts` (resource links), `change-feed.ts`, `rebuild-all.ts`, `overrides.css` and their tests.

**Interfaces — Produces:** `renderCategoryPage(kind, c, posts, links: ResourceLinkDto[], site, opts)` emits `div.ministry-listing.sector-listing > div.home-layout`, holding:
- `div.home-body#main-content-release`, with:
  - `h1.ministry-name-mobile{c.name}`;
  - `div.other-articles > div#regular-articles.regular-articles{latestCards(sortNewest([top, feature, ...latest]))}` (spec conflict 11);
  - `div.news-control`, with Load More and, for sectors only, `a.read-more[href=/search/?sector=<key>]{labels.searchNews}`;
  - `p > a "Browse the archive by month"` (kept from plan 2);
  - `div.collapsible-regions{resourcesBox}`.
- `section.home-features[aria-label="About {name}"]`, with `p.ministry-title[aria-hidden=true]{name}` and `connectStrip`.

`resource_links` and the `connect` section queue every sector, theme and tag page (`categoryIds` minus ministries).

- [ ] **Step 1: Write failing tests**

```ts
it("sector page: one h1, .sector-listing, cards in date order including the top and feature posts once each, Search News only for sectors")
it("theme and tag pages have no Search News link; Load More only when more than 3")
it("strip and Resources present; no <aside>")
it("resource_links queues every sector, theme and tag page")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site`. Expected: FAIL.
- [ ] **Step 3:** Implement. Apply R10.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): news.gov sector, theme and tag pages"`.

---

### Task 17: Public — category indexes `/ministries/` (M8), `/sectors/`, `/themes/`, `/tags/` (M16)

**Files:**
- Create: `apps/public-site/src/pages/category-index.ts` and its test.
- Modify: `site-paths.ts`, `builder.ts`, `rebuild-set.ts`, `change-feed.ts`, `rebuild-all.ts`, `pages/categories.ts` (drop `renderMinistriesPage`), `scripts/fixture-site.ts` and their tests.

**Interfaces — Produces:**
- `PageId { type: "category-index"; kind: "sectors" | "themes" | "tags" }` has id `index:<kind>`, files `[`${kind}/index.html`]` and URL `${base}/${kind}/`. The ministries index keeps id `ministries`.
- `type IndexGroup = { key: string; name: string; top: PostDto | null; feature: PostDto | null; latest: PostDto[] }`.
- `renderCategoryIndex(kind: CategoryKind, groups: IndexGroup[], links, site, opts)` emits `div.news-listing > div.home-layout`, holding:
  - `div.home-body#main-content-release`, with `h1 "News by {Ministry|Sector|Theme|Topic}"`, then per group:
    - `div.grouped-articles`, with `h2 > a[href=category page]{name}`, then:
      - for sectors, `div.other-articles` with `div.regular-articles > postCard` for each of up to 3 latest;
      - otherwise `div.top-article{top}`, then `div.other-articles` holding `div.feature-article{feature}` and `div.regular-articles{latest[0]}`;
    - `div.news-control`, with `a.load-more.link-button[href=category page]{labels.browseMoreNews}`, `a.read-more{labels.searchNews}` (ministries `?ministry=`, sectors `?sector=`), and `div.clear`.
  - `section.home-features[aria-label="Connect and resources"]`, with `connectStrip` and `resourcesBox`.
- Builder `indexGroups(run, kind)`:
  - The categories are the active ones (ministries from `ministries(run)`, in API order; the others from `newsApi.categories(kind)`, by `sortOrder` then name).
  - Top and feature come from one `postsByKeys` call.
  - `latest(kind, key, kind === "sectors" ? 3 : 1)` runs with `mapLimit(SECTOR_FETCHES)`.
  - A failed fetch rejects the render, so the queue retries it.
- Dependents:
  - `dependentPages` adds `ministries`, `index:sectors`, `index:themes` and `index:tags` for each category kind the post has, before and after;
  - `pagesForChange` adds the matching index for each category change;
  - `resource_links` and the `connect` section add all four indexes.
- `aggregatePageIds` and `sitemap:pages` add the three new ids.

- [ ] **Step 1: Write failing tests**

```ts
it("ministries index: one h1 'News by Ministry'; a group per active ministry with top, feature and first latest; Browse More News links the ministry page; Search News uses ?ministry=")
it("sectors index: latest 3 per sector; themes and tags: no Search News; tags heading is 'News by Topic'")
it("a category with no posts still lists its heading and Browse More News")
it("a post in health and economy queues ministries and index:sectors; a tag-only post queues index:tags")
it("one failed latest fetch rejects the render")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `/sectors/`, `/themes/` and `/tags/` to `FIXTURE_PAGES`. Apply R10; batch E bumps at most once.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): category indexes /ministries/, /sectors/, /themes/, /tags/ with the latest posts per category (M8, M16)"`.
- [ ] **Step 6: Deploy batch E, then verify:**
  1. Run `npm run parity -- --target https://boxs.ca --pages factsheets,stories,ministry-factsheets,sector,ministries,sectors,themes,topics,release`. Expected: the gate passes.
  2. In the Hub's `/website/links`, set the Resources "Factsheets" URL to `/factsheets/`. It opens the new page.

---

## Batch F — search, archive, subscribe

### Task 18: News API — search `pageSize`, facets and result flags (M9, P11)

**Files:**
- Modify: `apps/news-api/src/search/{query,text-search,service}.ts`, `apps/news-api/src/http/v2/routes.ts` and their tests.

**Interfaces — Produces:**
- `SearchQuery.pageSize: 10 | 20`, defaulting to 20. `pageSize` is `"10"` or `"20"`; otherwise 400 with "pageSize must be 10 or 20".
- `SEARCH_MAX_RESULTS = 1000`. `page` must be at most `SEARCH_MAX_RESULTS / pageSize` (50 at 20, as today; 100 at 10). The message is "page must be a whole number from 1 to {max}".
- `facets=1` asks for `SearchResponse.facets: SearchFacets | null`, where:

  ```ts
  type SearchFacets = { ministries: { key: string; count: number }[]; sectors: { key: string; count: number }[]; types: { key: PostKind; count: number }[]; terms: { slug: string; count: number }[] };
  ```

  - Facets are computed in text mode over the same `where` as the results (all filters applied). They are `null` in semantic mode and when `facets` is absent.
  - Each list is sorted by count descending, then key, with zero counts left out.
  - `terms` uses the public government terms, with one `count(*) filter (where …)` per term in a single query.
  - Everything runs inside the existing `READ_SNAPSHOT` transaction.
- `SearchResult` adds `hasTranslations: boolean` and `hasMediaAssets: boolean`. `SearchResponse` adds `pageSize`.

- [ ] **Step 1: Write failing tests**

```ts
it("pageSize=10 returns 10 rows and pageSize 10; pageSize=15 → 400; page=100 with pageSize=10 is allowed, page=51 with 20 is not")
it("facets=1 in text mode counts ministries, sectors, types and terms over the filtered set; zero counts omitted")
it("facets is null without facets=1 and in semantic mode")
it("results carry hasTranslations and hasMediaAssets")
it("v1 compat tests unchanged")
```

- [ ] **Step 2:** Run `npx vitest run apps/news-api/src/search apps/news-api/src/http/v2/search.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run apps/news-api` and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(news-api): search pageSize 10|20, facet counts in text mode, translation and asset flags on results"`.

---

### Task 19: Public — search page parity (M9, P11)

**Files:**
- Modify: `apps/public-site/src/pages/search.ts`, `search.test.ts`, `builder.ts` (sectors and terms passed in), `change-feed.ts` (`sector` and `government_terms` changes queue `search`), `settings.ts`, `rebuild.ts`, `rebuild-all.ts`, `overrides.css` and their tests.

**Interfaces — Produces:**
- `renderSearchPage(lists: { ministries: MinistryDto[]; sectors: CategoryDto[]; terms: GovernmentTermDto[] }, archiveLinks: LinkSetting[], site, opts, apiBase)` emits:
  - `div.search`, holding `div.search-body > h1 "Search"` and `div.search-panel.search-filters`. The filters panel holds one `div.search-filter > h2.open{facet}` + `div.search-filter-content > ul` for each of Ministry, Sector, Content and Date:
    - the lists are baked as links that add the filter (`?ministry=<key>`, `?sector=<key>`, `?type=<kind>`, `?from=&to=` per term, with labels from `termRangeLabel`);
    - Date also holds `form.date-range` (two labelled `input[type=date]` named `from`/`to`), then the `archiveLinks` (pageText);
    - `a.link-button[href={base}/search/] "Reset search"`.
  - `div.home-body.search-results`, holding:
    - `div.search-panel` with `form#search-form[role=search]` (label "You searched for", `div.search-panel-bar > input#q[name=q] + button.search-trigger[type=submit][aria-label=Search]`);
    - `p.search-numbers#search-status[role=status]`, `p#search-alert[role=alert]` and `div#results`;
    - `nav.search-pagination.bottom[aria-label="Search pages"]`.
- `SEARCH_SCRIPT` changes:
  - It maps legacy parameters before calling the API:
    - `Ministry`/`ministry`, as a key or a case-insensitive name, from the baked lists;
    - `Sector`/`sector`;
    - `Content`/`content`, where a value containing `release`, `factsheet`, `stor` or `update` maps to that kind;
    - `fromDate`/`toDate` (`yyyy/MM/dd`) and `from`/`to` (ISO);
    - `Date=<term slug>`, mapped to that term's `from`/`to`;
    - `Page`/`page`.

    Unknown names and other parameters (`Language`, `City`) are dropped, and the page stays on the mapped URL (`history.replaceState`).
  - It calls `/api/v2/search?…&pageSize=10&facets=1`.
  - Each result is a legacy `div.article` card, built with `createElement`: `h2 > a`, then `div.item-medialink.translations` and `.media-assets` when flagged, then `div.item-date` (long date with time from the wall-clock string), then `div.item-content > div.item-text > p + a.read-more`.
  - `search-numbers` reads "Showing results {a} - {b} of {total}".
  - Pagination shows at most 5 numbered links around the current page, plus "« previous" and "next »", with the current page as `<b aria-current="page">`.
  - With facets, each baked list is reduced to the entries with counts, shown as `: {n}`. Without facets, the baked lists stay. Active filters show a "Remove {name} filter" link.
- `searchTextHash` (pageText.searchArchiveLinks) → `"search"` → `["search"]`.

- [ ] **Step 1: Write failing tests** (JSDOM, `runScripts: "dangerously"`, fetch stubbed)

```ts
it("one h1; filter panel with Ministry, Sector, Content, Date (terms, date inputs, older-archive links); Reset search")
it("?q=x calls /api/v2/search?q=x&page=1&pageSize=10&facets=1")
it("legacy: ?content=factsheets%20%26%20opinion%20editorials → type=factsheets; ?Ministry=Health → ministry=health; ?Content=Story → type=stories")
it("legacy: ?fromDate=2020/11/26&toDate=2024/11/17 → from=2020-11-26&to=2024-11-17; ?Date=2024-2028 → that term's dates; ?Page=3 → page=3")
it("?Language=French and ?Ministry=Nowhere are dropped; no 400 shown")
it("results render as div.article cards with Translations link when flagged, date with time, Read More; headline text never becomes markup")
it("Showing results 11 - 20 of 585 on page 2; pagination next/previous and aria-current")
it("facet counts reduce the lists; facets null keeps the baked lists")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site/src/pages/search.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Apply R10.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): news.gov search page — 10 per page, facets, legacy query strings, older-archive links (M9, P11)"`.
- [ ] **Step 6 (with the batch F deploy):** check one older-archive link with `curl -sI -A "curl/8.7.1" https://archive.news.gov.bc.ca/archive/2005-2009/` (one live request). Expected: 200 or 3xx. If it fails, set the defaults back to `http://` in the Hub and record it (owner question 6).

---

### Task 20: Public — archive pages in the listing look

**Files:**
- Modify: `apps/public-site/src/pages/archive.ts`, `archive.test.ts` and `overrides.css`.

**Interfaces — Produces:**
- `archiveCard(site, p: IndexedPost): string` = `div.article > h2 > a{headline}`, then `div.list-container.ps-0.pb-0 > div.item-date{displayDateTime}`, then `div.item-content > div.item-text > p{summary}` and `a.read-more{caret} Read More<span class="visually-hidden">: {headline}</span>`, then `div.clear`.
- `renderArchiveMonth` and `renderTermPage` emit `div.home-body#main-content-release.archive-page > h1{…}` + `div.other-articles > div.regular-articles{archiveCard × n}` (all visible: no Load More).
- `renderArchiveIndex` and `renderTermsIndex` emit `div.home-body.archive-page > h1` + `div.resource-links` per year (`h2{year}` + `ul` of month links with counts).

There is no side column: archive pages depend only on the post index (spec conflict 1).

- [ ] **Step 1: Write failing tests**

```ts
it("month page: one h1, div.article cards with item-date and read-more, no hidden cards")
it("index: a .resource-links block per year with month links and counts")
it("term page keeps the legacy-archive note")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site/src/pages/archive.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Apply R10.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): archive pages in the news.gov listing look"`.

---

### Task 21: Public — subscribe and manage look, Notice of Collection, manage link, prefill (M14)

**Files:**
- Modify: `apps/public-site/src/subscribe-pages.ts`, `subscribe-pages.test.ts`, `sync.ts` (and its test), `settings.ts`, `rebuild.ts`, `rebuild.test.ts` and `overrides.css`.

**Interfaces — Produces:**
- Subscribe page body: `div.connect.subscribe.mb-3 > div.home-body#main-content-release`, holding:
  1. `h1 "Subscribe"`.
  2. `p` "If you already have a subscription to News On Demand you can " + `a[href={base}/subscribe/manage/] "manage your account or unsubscribe"` + ".".
  3. `form#subscribe-form`, holding:
     - `details.expandable-section#newsOnDemand[open]`, with `summary > h2 "{site.name} On Demand"`;
     - the legacy explainer paragraph;
     - the timing checkboxes with legacy labels ("As soon as it's published.", "In a daily digest after 5 p.m.");
     - a `fieldset` with legend "Let us know what areas of the B.C. government you're interested in." and two radios: `isAllNews` "I would like to receive news from all ministries and sectors." / "I would like to customize the news that I receive.";
     - `div#newsOnDemandCustomOptions` with the category fieldsets, hidden while "all" is chosen.
  4. `div#noticeOfCollection`, with `p > b{collectionNotice.heading}` + `{bodyHtml, sanitised}`.
  5. The email label "What email address would you like to use for notifications?", `input#email`, `button#save.btn "Subscribe"`, the live regions and `{subscribeHelpHtml}`.
- Script changes:
  - a category whose items come back empty removes its fieldset (the Emergency case);
  - query prefill: `ministries`, `sectors`, `tags` (with `topics` as an alias), `themes` and `emergency`, each repeated or comma-separated, check the matching boxes and select "customize";
  - `newsletters` is ignored.
- Manage page: `div.connect.subscribe > div.home-body > h1 "Manage Subscription"`. The rest is unchanged.
- `collectionNoticeHash` (collectionNotice + subscribeHelpHtml) → `SectionPages "subscribe"`. `applyChromeChanges` calls `writeSubscribePages` when it is present, and does not queue it.

- [ ] **Step 1: Write failing tests**

```ts
it("one h1; manage link with base path; details#newsOnDemand open; notice heading and body from settings")
it("notice bodyHtml with <script> or onclick renders without them")
it("?ministries=health&ministries=finance&sectors=economy,services checks those boxes and selects customize")
it("an empty emergency list removes its fieldset")
it("a collectionNotice edit rewrites the subscribe pages and queues nothing")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site/src/subscribe-pages.test.ts apps/public-site/src/sync.test.ts apps/public-site/src/rebuild.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Apply R10; batch F bumps at most once.
- [ ] **Step 4:** Run `npx vitest run apps/public-site`, `npm run check` and `npm run site:quality`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): news.gov subscribe and manage pages with the Notice of Collection, manage link and prefill (M14)"`.
- [ ] **Step 6: Deploy batch F, then verify:**
  1. Run `npm run parity -- --target https://boxs.ca --pages search,subscribe,archive --ours search=/search/?q=<a word boxs.ca holds>`. Expected: the gate passes.
  2. `https://boxs.ca/search/?Ministry=Health` lists Health posts.

---

## Batch G — HTML sitemap, plan-3 coordination, records and gate

### Task 22: Public — HTML sitemap `/sitemap/` (L2)

**Files:**
- Create: `apps/public-site/src/pages/sitemap-html.ts` and its test.
- Modify: `site-paths.ts` (`sitemap-pages` gains `sitemap/index.html`), `builder.ts` and their tests.

**Interfaces — Produces:**
- `type SitemapGroup = { heading: string; entries: { name: string; path: string }[] }`.
- `sitemapGroups(run): Promise<SitemapGroup[]>` is built once in `case "sitemap-pages"`. Both outputs come from it:
  - the XML `renderUrlSet` (paths only, as today);
  - `renderHtmlSitemap(groups, site, opts)` → `div.home-body#main-content-release > h1 "Site map"` + per group `h2{heading}` + `ul > li > a`.
- Groups, in order:
  1. "Pages": Home, Ministries, Sectors, Themes, Topics, the four listings (by their settings titles), Media Contacts, Live Webcast, Connect, Subscribe, Search, Privacy, Archive.
  2. "Ministries": each ministry, with its Biography (when on disk) and Factsheets.
  3. "Sectors", "Themes", "Topics".
  4. "Archive": the months, newest first, then the terms.

  Posts are reached through the archive months (spec conflict 2).

- [ ] **Step 1: Write failing tests**

```ts
it("sitemap/index.html: one h1, the groups in order, base-path links; XML lists the same paths")
it("a bio page appearing re-queues sitemap:pages and both files change")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `/sitemap/` to `FIXTURE_PAGES`. Apply R10.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS. There is no harness pair: legacy `/sitemap/html` has no layout.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): HTML sitemap at /sitemap/ from the same entries as sitemaps/pages.xml (L2)"`.

---

### Task 23: Plan-3 coordination — legacy rules, feed links, rehearsal rows

**Prerequisite:** plan 3 Tasks 1, 7, 8 and 11 are merged into this branch. If they are not, this task waits; Task 24 can run without it, and its gate notes the gap.

**Files:**
- Modify: `apps/stack/src/legacy/rules.ts`, `legacy-urls.test.ts` and `fixture.ts`.
- Modify: `apps/public-site/src/pages/listing.ts`, `pages/connect.ts` and `builder.ts`, with their tests.
- Modify: `tools/parity/legacy-urls.txt` and `tools/parity/legacy-urls-pending.txt`.

**Interfaces — Produces:**
- `fixedRule("/sitemap/html")` → redirect `["/sitemap/", "/archive/!"]`, dropping the query.
- Kind listing `opts.feed` = `{ href: ${base}/${kindFeedFile(kind, "rss")}, title: "{title}: latest news" }`.
- The Connect RSS list gains "{listingTitles.factsheets}" → `kindFeedFile("factsheets","rss")` as its second row (legacy order).
- Rehearsal: a `# section: plan 4 pages` holding `/contacts`, `/privacy`, `/live`, `/releases`, `/stories`, `/factsheets`, `/updates`, `/sectors`, `/themes`, `/news-subscribe`, `/ministries/health/factsheets` and `/sitemap/html`. The first three are removed from `legacy-urls-pending.txt`.

- [ ] **Step 1: Write failing tests**

```ts
// legacy-urls.test.ts (fixture adds sitemap/index.html, factsheets/index.html, sectors/index.html, ministries/health/factsheets/index.html)
it("/sitemap/html → 301 /sitemap/ when it exists; /sitemap/html?count=5 drops the query")
it("/factsheets → 301 /factsheets/; /sectors → 301 /sectors/; /news-subscribe → 301 /tags/ (index exists)")
it("/ministries/health/factsheets → 301 /ministries/health/factsheets/")
// listing.test.ts / connect.test.ts
it("factsheets listing links feeds/factsheets.xml as its alternate; Connect RSS second row is the factsheets feed")
```

- [ ] **Step 2:** Run `npx vitest run apps/stack/src/legacy apps/public-site`. Expected: FAIL.
- [ ] **Step 3:** Implement. Apply R10.
- [ ] **Step 4:** Run `npx vitest run --project node` and `npm run check`. Expected: PASS. Then run `npm run parity:urls -- --base https://news.gov.bc.ca --list tools/parity/legacy-urls.txt` for the new section only (12 requests). Expected: each answers 2xx/3xx live.
- [ ] **Step 5: Commit** with `git commit -m "feat(stack,public-site,parity): /sitemap/html to /sitemap/, kind feed links, plan-4 rehearsal rows"`.

---

### Task 24: Decision records, editability and gap status, the plan-4 gate

**Files:**
- Modify: `docs/parity/changes-from-legacy.md`. Add rows from the next free C-number, Status "Proposed", each citing its commit:
  1. Archive pages use the listing look; legacy has no archive page.
  2. The HTML sitemap lists pages, categories and months, not every post.
  3. Directory contacts are settings rows with a placement; the 24-hour line lives in the rich-text intro.
  4. No directory "hide minister" flag; a blank minister name shows none.
  5. The Live player is consent-first, with no "always allow" cookie, vendored hls.js, https streams only, and a stream link fallback.
  6. Privacy has no "Reset Preferences" (no embed-consent cookies).
  7. The 404 heading and text are legacy's first sentence plus a search box, with status 404.
  8. Kind listings, sector/theme/tag pages and per-ministry factsheets include the top/feature posts in date order.
  9. Only the per-ministry factsheets listing is built; other `/<cat>/<key>/<kind>` paths go to the category page (plan 3).
  10. Search has no Language or City facets; facet counts appear in text mode only; dates use government terms and a custom range.
  11. The Connect sections are always expanded `<details>`, with no fade.
  12. The Connect With Us strip is one wrapping list, and the RSS icon's alt is "RSS".
  13. The subscribe heading uses `site.name` ("BC Gov News On Demand").
  14. The Live button is hidden without JavaScript.
  15. Subscribe has no Newsletters section (retired).
  16. The search page is `/search/` (lower case).
  17. Factsheets in More from this Ministry: C239 → superseded.

  Mark C240 and C243 superseded.
- Modify: `docs/parity/inputs/admin-editability.md` §1. Set these rows to **editable** with their screens:
  - header nav, section headings and the slide label → `/website/navigation`, `/website/carousel`, `/website/pins`;
  - the Notice of Collection, the 404 text, the privacy page, the live page text, the licence and the older-archive links → `/website/page-text`;
  - the directory rows → `/website/media-contacts`;
  - LinkedIn and the policy link → `/website/social`;
  - the additional display name → `/organizations`;
  - per-kind listing titles → `/website/navigation`.
- Modify: `docs/parity/inputs/gap-audit.md`. Mark H3, H4, H5, M8 (index), M9, M12, M13, M14, M16, L1, L2, L3 (licence) and L6 addressed, with commits.
- Modify: `docs/parity/inputs/look-and-feel.md`, adding "Plan 4 result".

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2: Gate.**
  1. Run `npm run parity -- --target https://boxs.ca --pages home,contacts,live,privacy,factsheets,stories,ministry-factsheets,ministries,sectors,themes,topics,sector,search,subscribe,connect,archive --ours search=/search/?q=<word>`. Expected: every strict region ≤ 0.03 at both widths, structure rows `ok`/`legacy-absent`, and axe 0 serious/critical.
  2. Run `npm run site:quality`, `npx vitest run --project node`, `npx vitest run --project staff-web` and `npm run check`. Expected: PASS.
  3. If Task 23 is done, run `npm run parity:urls -- --base https://boxs.ca`. Expected: 100%.

  Record the `main` ratios. Any failure becomes a named fix task.
- [ ] **Step 3: Commit** with `git commit -m "docs(parity): plan-4 deliberate differences, editability and gap status, parity results"`.

---

## Spec conflicts found and how this plan resolves them

1. **Spec §4 B lists "Archive" for the look, but legacy has no archive page** (`/archive` redirects to search; look-and-feel §2.6). Resolved: archive pages take the listing card look with no side column. The harness pairs `/archive/2026/10/` with legacy `/stories` for chrome and card structure only.
2. **L2 asks for an HTML sitemap. Legacy `/sitemap/html` is a 4 MB no-layout list of 28,440 posts, and look-and-feel §2.15 says "nothing to match".** Resolved: `/sitemap/` lists pages, categories and archive months, with posts one click away. Plan 3's rule changes from `/archive/` to `/sitemap/` (Task 23).
3. **admin-editability T3 proposes a separate 24-hour number and `generalContacts: [{group, name, phone, email}]`.** Legacy embeds the number and two links in prose, uses cell numbers, and adds a hardcoded trailing Premier row. Resolved: a rich-text intro holds the number and links. Settings contacts carry `cell`, `subgroup`, `groupUrl` and `placement`.
4. **admin-editability T2 proposes a "Show minister on directory" flag (the IGRS name check).** Resolved: there is no flag. A blank minister name shows none, the same rule plan 2 used for the minister card [A: IGRS has no minister name in Core; Task 7 Step 6 checks, owner question 4].
5. **admin-editability T7 says to bump `schemaVersion` for LinkedIn.** A literal bump would make every stored document and event fail to parse. Resolved: optional parts in `storedSiteSettingsSchema`, filled by `fillMissingFields`; `schemaVersion` stays 1.
6. **Spec §5 puts T9 in plan 5, but the kind listings need their titles now.** Resolved: listing titles are editable in `navigation.listingTitles`. The per-language release kind labels (an NRMS write route) stay in plan 5.
7. **P12 vs legacy 404 text.** Legacy says "See search results below" and returns search results with a 200. Resolved: the BC default keeps legacy's first sentence and ends "Search for it below.", above the prefilled search box, with status 404.
8. **look-and-feel §2.11 says a static site cannot know the live state.** Resolved: `assets/live.json`, rewritten on each home change and polled by `site.js` every 60 s (legacy polled too). No page rebuilds on a toggle.
9. **C209 and plan 2's "no third-party request at page load" vs a live player.** Resolved: no request to the stream host until Play. hls.js is vendored. There is no "always allow" cookie, so the privacy page has no Reset Preferences.
10. **H5 says "per-ministry factsheets", while legacy routes allow `/<category>/<key>/<kind>` for every category and kind.** Resolved: only the ministry factsheets listing is built (the only one legacy links). The others go to the category page through plan 3 Task 5.
11. **Legacy kind listings and sector pages omit the index's top/feature posts** (the v1 Latest call excludes them, and `Sector.cshtml` comments them out). Resolved: they are folded into the date-ordered cards, so nothing disappears. This matches plan 3's kind feeds.
12. **M9 lists Language and City facets.** Our search index has no translation-language or city dimension. Resolved: Ministry, Sector, Content and Date (government terms plus a custom range plus older archives). Facet counts appear only in text mode. Language and City are an owner question.
13. **P11 (10 per page) vs the API default of 20.** Resolved: a `pageSize` parameter (10 or 20); the API default stays 20.
14. **The Connect RSS list was a site-settings non-goal, but M12 requires it.** Resolved: it is derived from the categories and is not editable (admin-editability §2: generated lists).
15. **Plan 2 Global Constraints said Plan 4's T5 would make the PostView and Minister headings editable** ("Backgrounders", "Read Bio", "Meet the Team" …). Resolved: T5 here covers navigation and the listing and home labels only. Release and minister headings stay hardcoded as legacy has them; plan 5 can add them if the owner wants.

## Owner questions

1. **Live webcast.** Is the production stream URL https? Does its host allow cross-origin requests (needed for hls.js in Chrome and Firefox)? Is vendoring hls.js acceptable?
2. **The media-assets licence PDF** lives at `news.gov.bc.ca/files/News_Footage_License_British_Columbia.pdf`. After DNS moves, it depends on plan 3's `/files/*` question. Should the default point somewhere else?
3. **Directory defaults name staff** (two multicultural media contacts with cell numbers), copied from live into `config/tenants/bc.site-settings.json`. Commit them, or enter them only in the Hub?
4. **Intergovernmental Relations Secretariat:** should its minister name stay hidden on `/contacts/`? If Core holds one, the rule needs a per-ministry flag (admin-editability T2).
5. **Search Language and City facets:** needed? Each needs a new search dimension.
6. **Older-archive links:** confirm `archive.news.gov.bc.ca` stays up, and over https, after cutover.
