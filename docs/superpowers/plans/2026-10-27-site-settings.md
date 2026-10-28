# Site Settings (banner, footer, social links, theme, history) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SiteEditors edit the public site's banner, footer, Connect-page social links, colours and ministry-page section headings in the Hub, with per-editor drafts, conflict-safe publishing and restorable history; each ministry's own side-column links are edited in the Organizations form; the public site shows all of it.

**Architecture:** A browser-safe `@gcpe/site-settings` package defines the document, validation and defaults. NRMS stores revisions and drafts and publishes `site.settings.published` through its outbox; the News API keeps the newest revision and serves it; the public site applies each section the cheapest correct way (theme.css, a banner JSON read by a tiny inline script, a footer rebuild, a new Connect page). Hub screens live under Website.

**Tech Stack:** TypeScript, zod, Express, drizzle-orm + drizzle-kit migrations on Postgres, vitest + supertest, React + `@bcgov/design-system-react-components` + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-27-site-settings-design.md` (read it first; it carries every user-facing string and rule). Behavioural reference: `/Users/paul/News-Hub/gcpe-news-webapp`, branch `admin-screens` (e.g. `Gov.News.Settings/SettingsValidator.cs`, `defaults.json`, `Gov.News.Admin/Pages/*`).

## Global Constraints

- Every user-facing string and validation message: verbatim from the spec.
- Website writes require `NRMS.SiteEditor`; reads `NRMS.SiteEditor` or `Core.Admin` (existing `canManageWebsite` / `requireRole` rules).
- Staff-web imports only browser-safe modules: `@gcpe/site-settings` must not import node built-ins or `@gcpe/config`'s root.
- Nothing an editor types renders as markup: escape with the public site's `e()`/`safeHref()`; banner/footer text is plain.
- Times: stored as ISO instants; entered and shown in the tenant time zone (`America/Vancouver` for bc).
- Migrations: drizzle-kit generated (`npx drizzle-kit generate` in the app), never hand-numbered over an existing file.
- Tests beside the source (`*.test.ts(x)`); DB tests via each app's `test/helpers.ts`; Website screens get an axe check in `screens/website/a11y.test.tsx`.
- `npm run check` and the affected test projects pass at the end of every task.

## Review Focus

1. Two editors publishing from the same base: exactly one wins, the other sees the conflict and keeps their draft — pinned in Task 3 (concurrent publishes).
2. A scheduled banner appears and disappears on time with no rebuild — pinned in Task 6 (script evaluates `startsAt`/`endsAt` against the visitor's clock; the JSON carries ISO instants).
3. Hostile input (markup in a message, `javascript:` URLs, a forged link id) never reaches a public page — pinned in Task 1 (validation) and Task 6 (rendering escapes even an unvalidated document).
4. The News API or settings fetch failing must not blank the footer or drop the banner — pinned in Task 6 (keeps last applied; 404 ⇒ defaults).
5. BC wall-clock entry around the 2026-11-01 permanent UTC-7 change: `2026-03-01T09:00` stores −08:00, `2026-11-02T09:00` stores −07:00 — pinned in Task 4.

---

### Task 1: `@gcpe/site-settings` package — model, validation, defaults

**Files:**
- Create: `packages/site-settings/package.json` (name `@gcpe/site-settings`, `"type":"module"`, exports `.` → `./src/index.ts`, dependency `zod` at the repo's version), `packages/site-settings/src/{index.ts,model.ts,validate.ts,urls.ts,contrast.ts,defaults.ts,sections.ts}`, tests beside them.
- Create: `config/tenants/bc.site-settings.json`
- Modify: root `tsconfig.json` / `apps/staff-web/tsconfig.json` paths if packages are listed there; `apps/staff-web/package.json`, `apps/nrms/package.json`, `apps/news-api/package.json`, `apps/public-site/package.json`, `packages/events/package.json` (dependency `"@gcpe/site-settings": "0.0.0"`).

**Interfaces — Produces:**
- Types `SiteSettings`, `BannerSettings`, `ThemeColors`, `FooterSettings`, `ConnectSettings`, `MinistryPageLabels`, `NetworkKey` (`"facebook"|"x"|"instagram"|"threads"|"bluesky"|"flickr"|"youtube"|"blogs"`), `LinkSetting`, `SectionKey` (`"banner"|"theme"|"footer"|"connect"|"ministryPages"`), `FieldError {field: string; message: string}`.
- `siteSettingsSchema` (zod, structural only: shapes and types; rules live in `validate`).
- `NETWORKS: readonly {key: NetworkKey; name: string}[]` in the spec's order; `SECTION_LABEL: Record<SectionKey,string>` = Banner, Theme, Footer, Social links, Ministry pages.
- `validateSiteSettings(doc: SiteSettings): FieldError[]` — every rule and message in the spec, field paths as there (`footer.moreInfoLinks[2].url`, `connect.x.accounts[0].summary`, `theme.colors.text`).
- `isSafeUrl(url: string): boolean`; `contrastRatio(a: string, b: string): number`.
- `bannerVisibleAt(b: BannerSettings, now: Date): boolean`.
- `connectDisplayOrder(n: {featured: LinkSetting[]; accounts: LinkSetting[]}): LinkSetting[]` (featured, then accounts sorted by text, case-insensitive `localeCompare`).
- `differingSections(a: SiteSettings, b: SiteSettings): SectionKey[]`; `withSection(doc, key, value): SiteSettings` (returns a new document).
- `defaultSiteSettings(tenantTheme: {colors: {...8 colours}; footerLinks: {label: string; url: string}[]}, tenantDefaults?: unknown): SiteSettings` — parses and returns `tenantDefaults` when given (throws if it doesn't parse/validate), else derives per the spec.

- [ ] **Step 1: Write the failing tests** (`validate.test.ts`, `defaults.test.ts`, `sections.test.ts`), porting `Gov.News.Settings.Tests/SettingsValidatorTests.cs`:
  - defaults (both the derived ones and `config/tenants/bc.site-settings.json`) validate with `[]`; bc defaults: banner disabled, 6 more-info links with `id`s `footerHome`…`footerContact`, holder "Government of British Columbia", 83 social links, X display order starts "@BCGovNews".
  - `contrastRatio("#000000","#FFFFFF")` ≈ 21.0, `#FFFFFF/#FFFFFF` 1.0, `#013366/#FFFFFF` ≈ 12.6 (1 dp), `#CE3E39/#FFFFFF` ≈ 4.8.
  - `isSafeUrl` true for `https://gov.bc.ca`, `/contact`; false for `http://x.ca`, `javascript:alert(1)`, `data:text/html,x`, `//evil.example`, `/\evil.example`, `" https://gov.bc.ca"`, `gov.bc.ca`, `""`.
  - an http more-info link ⇒ exactly `[{field:"footer.moreInfoLinks[2].url", message:"Must start with https:// or / (a page on this site)."}]`.
  - banner: markup ⇒ `banner.message` "Use plain text. Add links below instead of HTML."; enabled + whitespace ⇒ "Enter a message, or turn the banner off."; 301 chars ⇒ length message; `endsAt <= startsAt` ⇒ `banner.endsAt`.
  - `bannerEmergency: "#F08080"` ⇒ one error on `theme.colors.bannerEmergency` containing "(2.4:1, needs 4.5:1)"; malformed `013366`, `#013`, `#01336G`, `red` on `theme.colors.text` ⇒ "Use a colour like #013366."
  - summary with `<script>` on `connect.x.accounts[0].summary`; id `x" onclick="alert(1)` ⇒ id message.
  - `bannerVisibleAt`: hidden 1 s before start, visible at start, hidden at exactly end; disabled ⇒ hidden.
  - `differingSections` ignores nothing but section JSON; `withSection` doesn't mutate its input.
  - `ministryPages`: defaults are the seven news.gov headings; blank ⇒ "Enter a heading."; 61 chars or `<b>` ⇒ "Use plain text, 60 characters or fewer."
- [ ] **Step 2:** `npx vitest run packages/site-settings` → FAIL (module missing).
- [ ] **Step 3:** Implement. `bc.site-settings.json`: copy `footer` and `connect` from `/Users/paul/News-Hub/gcpe-news-webapp/Gov.News.Settings/defaults.json` (connect is `{featured, accounts}` per network there), banner `{enabled:false, style:"info", message:"", links:[], dismissible:true, startsAt:null, endsAt:null}`, theme colours = `config/tenants/bc.json` `site.theme.colors` + `bannerInfo:"#013366"`, `bannerEmergency:"#D8292F"`, `schemaVersion:1`.
- [ ] **Step 4:** tests PASS; `npm run check`.
- [ ] **Step 5:** commit `feat(site-settings): settings document, validation and defaults`.

### Task 2: Event `site.settings.published` and its route

**Files:** Modify `packages/events/src/catalogue.ts` (schema + `eventDataSchemas` entry), `apps/stack/src/env.ts` (`newsApiEventTypesFromNrms()` includes it), `apps/news-api/src/projections.ts` (`SOURCE_EVENT_TYPES` accepts it from nrms; handler stub added in Task 5); tests in `packages/events/src/catalogue.test.ts`, `apps/stack/src/env.test.ts`.

**Interfaces — Produces:** `siteSettingsPublishedSchema = z.object({ revision: z.number().int().positive(), publishedAt: z.string().datetime({offset:true}), document: siteSettingsSchema })`; event type string `"site.settings.published"`.

- [ ] Step 1: tests — the schema accepts a bc-defaults document at revision 1 and rejects revision 0; the stack routes the type NRMS → news-api.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS + `npm run check`. Step 5: commit `feat(events): site.settings.published`.

### Task 3: NRMS storage and service

**Files:** Modify `apps/nrms/src/db/schema.ts` (tables `siteSettingsRevisions` → `site_settings_revisions`, `siteSettingsDrafts` → `site_settings_drafts`; add `"settings"` to `SiteLogArea` and its CHECK); generate the migration; Create `apps/nrms/src/website/site-settings.ts` + `site-settings.test.ts`.

**Interfaces — Produces** (`actor` is the existing `Actor`; `defaults` is the tenant's `SiteSettings`):
- `getSettingsState(db, actor, defaults): Promise<SettingsState>` where `SettingsState = { live: LiveInfo | null; document: SiteSettings; draft: { baseRevision: number | null; updatedAt: string } | null; baseRevision: number | null; errors: FieldError[] }`, `LiveInfo = { revision; publishedAt; publishedBy; note }`. `document` = draft ?? live ?? defaults; `baseRevision` = draft's base if a draft exists, else live revision (null if none); `errors` = `validateSiteSettings(document)`.
- `saveDraft(db, actor, defaults, input: { baseRevision: number|null; section: SectionKey; value: unknown }): Promise<SettingsState>` — parses `value` with the section's zod schema (ZodError ⇒ 400), overlays it on draft ?? live ?? defaults, upserts the draft with `input.baseRevision`.
- `publishSettings(db, actor, defaults, subs, input: { baseRevision; section; value; note?: string }): Promise<{ result: "published"; revision: number } | { result: "invalid"; errors: FieldError[] } | { result: "conflict"; live: LiveInfo; differing: SectionKey[] }>` — saves the draft first (so nothing is lost), then in one transaction with `pg_advisory_xact_lock` on a fixed key: validate ⇒ invalid; live revision ≠ base ⇒ conflict; else insert revision live+1 (note trimmed, blank ⇒ null), delete this actor's draft, `writeSiteLog(tx, actor, "settings", "Published revision N[: note]")`, `enqueueEvent(tx, {type:"site.settings.published", source:"nrms", aggregateId:"site:settings", data}, subs)`. `differing` = `differingSections(myDocument, newLive)`.
- `discardDraft(db, actor)`; `rebaseDraft(db, actor, defaults, input: { section; value }): Promise<SettingsState & { setAside: SectionKey[] }>`.
- `listHistory(db): Promise<LiveInfo[]>` newest first; `getRevision(db, n): Promise<{ info: LiveInfo; document: SiteSettings; differing: SectionKey[] } | null>` (differing vs live); `restoreRevision(db, actor, defaults, subs, { revision; baseRevision })` ⇒ same result union as publish plus `{ result: "not-found" }`, note `Restored revision N`.

- [ ] Step 1: tests (`createNrmsTestDb()`; truncate the two tables, `site_log`, outbox tables in `beforeEach`), porting `BlobSiteSettingsStoreTests.cs`:
  - first publish ⇒ revision 1, `publishedBy` = actor name, draft gone, one history row with the note, one `site.settings.published` outbox row with the document.
  - stale base ⇒ conflict carrying the other editor's live info; history [2,1]; the loser's draft still there.
  - 8 concurrent publishes from the same base ⇒ exactly one `published`, live revision 2.
  - drafts are per editor; another editor's publish leaves mine.
  - invalid (a `javascript:` URL) ⇒ `invalid` with the field, no revision, no outbox row, draft kept.
  - restore 1 when 2 is live ⇒ revision 3 with r1's document and note "Restored revision 1"; restore 99 ⇒ `not-found`.
  - rebase ⇒ base = live revision, other changed sections reported in `setAside`.
  - accented name and note round-trip ("André", "Feux de forêt — mise à jour").
- [ ] Step 2 FAIL → Step 3 implement → Step 4 PASS + check → Step 5 commit `feat(nrms): site settings revisions, drafts and publishing`.

### Task 4: NRMS routes

**Files:** Modify `apps/nrms/src/http/site-routes.ts` (+ `AREAS` gets `settings`), `apps/nrms/src/app.ts`/`start.ts` only to pass the tenant `SiteSettings` defaults and time zone into `siteRoutes` deps (load `config/tenants/<tenantId>.site-settings.json` beside `TENANT_CONFIG` if present); tests in `site-routes.test.ts`.

**Interfaces — Produces** (all under `/nrms/api/site/settings`, read guard for GET, `NRMS.SiteEditor` for writes, `x-gcpe-request` on writes as today):
- `GET /` ⇒ `SettingsState`.
- `PUT /draft` body `{ baseRevision: number|null; section: SectionKey; value }` ⇒ `SettingsState`.
- `POST /publish` body `{ baseRevision; section; value; note? }` ⇒ 200 `{ revision, state: SettingsState }`; 422 `{ errors: string[] /* "field: message" */, fieldErrors: FieldError[] }`; 409 `{ error: "published", code: "published", live: LiveInfo, differing: SectionKey[] }`.
- `DELETE /draft` ⇒ 204. `POST /rebase` body `{ section; value }` ⇒ `SettingsState & { setAside }`.
- `GET /history` ⇒ `{ live: number|null; revisions: LiveInfo[] }`; `GET /history/:revision` ⇒ `{ info, document, differing }` or 404; `POST /restore` body `{ revision; baseRevision }` ⇒ 200 `{ revision }` / 409 as publish / 404 / 422.
- Banner `value` from the Hub carries `startsAtLocal`/`endsAtLocal` (`localDateTime` from `@gcpe/nrms-contract`, or null) instead of `startsAt`/`endsAt`; the route converts them with the workflow time zone (reuse the carousel's conversion helper) before calling the service.

- [ ] Step 1: tests — 403 for NRMS.Editor on every write and for anyone without manage roles on GET; Core.Admin reads but gets 403 on publish; 422 shape for an http link; 409 shape from a stale base; `startsAtLocal: "2026-03-01T09:00"` stores `2026-03-01T17:00:00.000Z`, `endsAtLocal: "2026-11-02T09:00"` stores `2026-11-02T16:00:00.000Z`; restore 404.
- [ ] Steps 2–5 as usual; commit `feat(nrms): site settings API`.

### Task 5: News API — store and serve the live settings

**Files:** Modify `apps/news-api/src/db/schema.ts` (`siteSettings` → `site_settings`: `id` 1 CHECK, `revision`, `published_at`, `document` jsonb; add `"site_settings"` to `CHANGE_KINDS` and the `changes` CHECK); generate the migration; `projections.ts` (handler: upsert only if `revision` > stored; `recordChanges(tx, [{kind:"site_settings", key:null}])`); `http/v2/routes.ts` (`GET /site-settings`, same no-store header); tests in `projections.test.ts`, `http/v2/*.test.ts`.

**Interfaces — Produces:** `GET /api/v2/site-settings` ⇒ 200 `{ revision, publishedAt, document }` or 404 `{ error: "not found" }`.

- [ ] Step 1: tests — revision 2 then a late revision 1 leaves 2 stored; a change row of kind `site_settings` is recorded once per applied revision; the route returns the stored document, 404 before any.
- [ ] Steps 2–5; commit `feat(news-api): store and serve published site settings`.

### Task 6: Public site — apply the settings

**Files:** Modify `apps/public-site/src/news-api-client.ts` (`siteSettings(): Promise<{revision; document} | null>`, null on 404), `dto.ts`, `sync.ts`, `self-heal.ts`, `rebuild.ts` (marker fields), `render.ts` (footer, banner placeholder + script, `PageOptions.settings: SiteSettings`), `theme-css.ts` (`themeCss(theme, colors?)` uses settings colours and adds `--color-banner-info`, `--color-banner-emergency` and banner rules), `static-pages.ts` (writes `assets/site-banner.json`), `change-feed.ts` (`site_settings` ⇒ queue nothing itself: the next sync turn decides), `builder.ts` + a new `pages/connect.ts` (page id `connect`, path `/connect/`, listed in `rebuildAllItems` and the sitemap), `start.ts` (load tenant defaults like NRMS); tests beside each and `test/fake-news-api.ts` gains `siteSettings`.

**Interfaces — Consumes:** `GET /api/v2/site-settings`; `@gcpe/site-settings` (`connectDisplayOrder`, `NETWORKS`, `bannerVisibleAt` not used server-side for the banner).
**Produces:** `SiteRenderState` gains `footerHash: string` (hash of `footer` JSON + the current year in the tenant time zone) — a change triggers `enqueueRebuildAll`; `themeHash`, `connectHash` and `ministryPagesHash` changes enqueue only `static` / `connect` / every ministry page; bump `RENDER_CHROME_VERSION` (layout changed). `PageOptions.settings` carries `ministryPages` for Task 12.

- [ ] Step 1: tests:
  - each sync fetches settings; 404 ⇒ tenant defaults; a fetch error ⇒ last applied settings kept (logged), never defaults.
  - footer: help sentence "…options. Call, email or text us, or find a service centre." (comma rule from the spec: all but the last two get ",", the second-last ", or", the last "."); "Connect with Us" and "More Info" lists with `id`s; `© {year} {holder}`; `/subscribe` renders as `{base}/subscribe`; a document with `<b>` text and a `javascript:` URL (bypassing validation) renders escaped / without the link.
  - footer change ⇒ rebuild-all queued; theme-only change ⇒ only `static`; connect-only ⇒ only `connect`.
  - `assets/theme.css` carries the settings colours and the banner variables.
  - `assets/site-banner.json` = `{ visible: enabled, style, message, links, dismissible, startsAt, endsAt }`; every page has `<div id="site-banner" hidden>` and the inline script; the script (exported as a string and also unit-tested by evaluating it in jsdom against a fixed `Date.now`) renders nothing before `startsAt`, renders at `startsAt`, nothing at `endsAt`; emergency gets `role="alert"`; dismissible shows a "Close banner" button that hides it; nothing renders while `.blue-bridge-banner` is on the page; message and links inserted as text/`href` (no `innerHTML` of document text).
  - Connect page: networks in order with featured then sorted accounts and summaries; `expectAccessibleStructure` passes.
- [ ] Steps 2–5; commit `feat(public-site): banner, footer, Connect page and colours from site settings`.

### Task 7: Hub — shared editor pieces and the Banner screen

**Files:** Create `apps/staff-web/src/screens/website/settings/{api.ts,useSettingsEditor.ts,PublishBar.tsx,ConflictPanel.tsx,OtherSectionErrors.tsx,LinkListEditor.tsx,BannerScreen.tsx}` + tests; Modify `WebsiteScreen.tsx` (`SECTIONS` gains Banner, Footer, Social links, Theme, Settings history — `manageOnly`), `router.tsx` (routes `banner`, `footer`, `social`, `theme`, `settings-history`), `types.ts` (`SiteLogArea` + `settings`), `LogScreen.tsx` (`AREA_LABEL.settings = "Site settings"`).

**Interfaces — Produces:**
- `useSettingsEditor<K extends SectionKey>(section: K)` ⇒ `{ state: SettingsState | null; loadError; value; setValue; saveDraft(); publish(note); discard(); rebase(); status: string | null; fieldErrors: FieldError[]; conflict: {live; differing} | null; busy }`. Field errors for this section are those whose `field` starts with `"<section>."`; the rest feed `OtherSectionErrors`. Statuses and messages verbatim from the spec. Successful actions reload the state and announce via `useAnnouncer`.
- `LinkListEditor({ legend, links, onChange, errors, pathPrefix, reorderable, withSummary })` — rows with Link text / Web address / Description (optional), Move up/down (reorder pattern of `LinksScreen`: `moveItemBy`, `useMoveFocusRestore`, announcements), Remove, "+ Add a link"; ids carried invisibly; errors per row by index.
- Banner screen per the spec (type radio Off/Information/Emergency — Off keeps style; Message with counter; links; Show from / Hide after as `datetime-local` in tenant time, sent as `startsAtLocal`/`endsAtLocal`; checkbox; preview).

- [ ] Step 1: tests (fetch stubs as `PinsScreen.test.tsx`): loads and shows "Nothing published yet; the site uses its built-in defaults."; Save draft PUTs only the banner section and shows "Draft saved. It isn't live until you publish."; Publish with a note shows "Published revision 1. Visitors see it within a few minutes."; 422 puts "Use plain text. Add links below instead of HTML." under Message and errors from another section in the other-sections list; 409 shows the conflict panel with "Revision 2 was published by Sam" and "Your draft differs from it in: Banner"; "Keep my banner, on top of their version" POSTs rebase and shows "Your banner changes now build on revision 2. Check them, then publish."; Off keeps style emergency in the PUT body; SiteEditor-less Core.Admin sees disabled inputs; document title = h1 ("Site banner"); axe clean.
- [ ] Steps 2–5; commit `feat(staff-web): site banner editor`.

### Task 8: Hub — Footer and Social links screens

**Files:** Create `settings/FooterScreen.tsx`, `settings/SocialScreen.tsx` + tests.

- [ ] Step 1: tests — Footer shows help text, the three lists (reorderable; moving a link moves its id; the PUT body keeps `id`s), copyright holder with the hint; publishing an edited "Contact Us" leaves other sections untouched (only `section: "footer"` sent). Social: a tab per network labelled "{Name} {count}" (`?network=` in the URL, unknown ⇒ facebook); featured reorderable with Description; accounts listed sorted; adding "BC Parks" to Bluesky accounts publishes them sorted ["BC Parks", "Trade and Invest British Columbia"]; only the open network changes in the sent `connect` value; markup in a featured summary shows "Use plain text, 200 characters or fewer." on that row; titles = h1 ("Footer links", "Social links"); axe clean.
- [ ] Steps 2–5; commit `feat(staff-web): footer and social links editors`.

### Task 9: Hub — Theme, Ministry pages and Settings history screens

**Files:** Create `settings/ThemeScreen.tsx`, `settings/MinistryPagesScreen.tsx`, `settings/HistoryScreen.tsx` + tests.

- [ ] Step 1: tests — Theme shows a colour input per colour with hex and badge ("Readable 12.6:1"; "Too faint 2.4:1" for a faint banner colour); publishing `#1a5a96` sends `#1A5A96`; "Reset to defaults" changes the form only (no request) and shows "Colours reset to the defaults. Save or publish to keep them."; a 422 contrast error shows under that colour. History lists revisions newest first with "Live" on the live one and Restore… on others; Restore… shows "Restore revision 1?" and "Compared with what is live now, this changes: Banner" (or the identical-to-live sentence); confirming POSTs `{revision, baseRevision}` and shows "Revision 1 is live again, as revision 3."; a 409 shows "Nothing was restored: revision 3 was published while you were looking. Check it and try again."; times in BC time; axe clean (with the confirm open). Ministry pages: seven labelled text fields with the current headings; publishing sends only `section: "ministryPages"`; "Reset to defaults" fills the form only; a blank heading shows "Enter a heading." under it; title = h1 ("Ministry page headings").
- [ ] Steps 2–5; commit `feat(staff-web): theme editor and settings history`.

### Task 10: Core and the Organizations form — each ministry's side-column links

**Files:** Modify `apps/core/src/services/organizations.ts` (`orgProfilePatchSchema` gains `url`, `topicLinks`, `serviceLinks`, `social: {flickrUrl, youtubeUrl}` partial-strict; https / safe-URL checks; ≤ 20 per list), its tests and `apps/core/src/http/routes.test.ts`; `apps/staff-web/src/screens/admin/organizations/OrganizationEditForm.tsx` + test (new fieldset "Ministry page links"); move `LinkListEditor` from `screens/website/settings/` to `apps/staff-web/src/shared/LinkListEditor.tsx` if both need it (update Task 7's imports).

**Interfaces — Consumes:** `LinkListEditor` (Task 7); Core's existing `patchOrganizationProfile` merge + `staffEditedAt` stamping.

- [ ] Step 1: tests — PATCH with `topicLinks` replaces the list in order and emits `org.upserted` carrying it; `social.flickrUrl` merges without clearing `twitterUsername`/`audioUrl`; an `http:` topic link ⇒ 400 `{error:"invalid request", issues}`; 21 links ⇒ 400; NRMS.SiteEditor allowed; the form shows the current links, sends only changed fields (lists whole when changed), reorder and remove work, and a server issue shows inline.
- [ ] Steps 2–5; commit `feat: edit each ministry's side-column links in the Organizations form`.

### Task 11: Public site — ministry page side column

**Files:** Modify `apps/public-site/src/dto.ts` (`MinistryDto` gains `topicLinks`, `serviceLinks` (`{text, url}[]`), `flickrUri`, `youtubeUri` — already in the News API's DTO, `apps/news-api/src/dto.ts:44-55`), `pages/categories.ts` (`renderMinistryPage` side column), `theme-css.ts` (two-column layout ≥ 48rem, single column below); tests in `pages/categories.test.ts` and `test/fixtures.ts`.

**Interfaces — Consumes:** `PageOptions.settings.ministryPages` (Task 6).

- [ ] Step 1: tests — the side column lists, in order, Media Contacts, More from this Ministry (Ministry Website / Ministry Photos / Ministry Videos, each only when set), Featured Topics, Featured Services, with headings from `ministryPages` (a renamed heading shows); empty groups are omitted; `javascript:` or `http:` links are dropped (`safeHref`); text is escaped; `expectAccessibleStructure` passes; a ministry with no links has no `<aside>`; an `org.upserted` with new topic links re-renders that ministry's page (follow the existing org → page path; add a test if none covers it).
- [ ] Steps 2–5; commit `feat(public-site): ministry page side column`.

### Task 12: Docs

**Files:** Modify `docs/deploy/siteground.md` (a "Site settings" section: where it's edited, who can, what a publish rebuilds, the defaults file) and `docs/manuals/` if a staff manual covers the Website section.

- [ ] Write it; commit `docs: site settings`.
