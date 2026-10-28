# news.gov.bc.ca Parity, Plan 5: Sectors/Themes/Tags, Release Page Titles, Site Identity, Leftovers and the Final Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last Hub-editability gaps the spec names (§4 D T8–T10), fix the leftovers found in plans 3–4 (site meta description, translations inside `#assets`, Italic in the settings editor, and tel: links behind the owner's answer), then rerun the full parity audit against boxs.ca so spec §6 "Done means" can be checked off.

**Architecture:**
- **T8 (sectors, themes, tags).** Core already has `GET/PUT /api/terms/:kind[/:key]` (Core.Admin writes) and every downstream consumer (News API `applyTerm`, the public site's change feed, NRMS taxonomy, NoD lists) already follows `<kind>.upserted` events. This plan adds the rules a Hub form needs on `PUT` (new-key format, case-insensitive duplicates, a required name) and a Core.Admin Hub screen. No public-site code changes.
- **T9 (release page titles).** NRMS `page_types` is the page-title picklist the New release screen offers; each release copies the chosen title into its own document (`document_languages.page_title`, free text, editable per release), and that copy is what the public release page shows (M4). This plan adds NRMS write routes and a Core.Admin Hub screen. Existing releases keep their stored title.
- **T10 (site identity).** A new site-settings section `siteIdentity` (site description, X account, Blue Bridge banner message and birth date), edited on a new Hub screen `/website/identity`. The public site reads it for `<meta name="description">`, `twitter:site` and the Blue Bridge banner. Site name and logo stay operator-owned (P5, P15).
- **Leftovers.** Release translations move inside `div#assets` as legacy does; the settings rich-text editors gain an Italic button; tel: links in settings HTML and Italic in release bodies/bios are separate tasks that run only if the owner answers yes.
- **Final audit.** The harness, URL lists and the gap audit are rerun against boxs.ca; the parity documents are updated so every §6 line has evidence.

**Tech Stack:** TypeScript, Express 5, zod, drizzle (Postgres), vitest + supertest + jsdom, React + TipTap 3.31.4 (`apps/staff-web`, adding `@tiptap/extension-italic@3.31.4`, MIT), `@bcgov/design-system-react-components`, Playwright parity harness in `tools/parity`.

**Spec:** `docs/superpowers/specs/2026-10-28-news-gov-parity-design.md` (binding; §4 D T8–T10, §5 step 5, §6 "Done means", P5, P14, P15).
- Evidence: `docs/parity/inputs/admin-editability.md` (§1 rows not yet "editable"; §2; §3 T8, T9, T10), `gap-audit.md`, `look-and-feel.md` ("Plan 4 result", including its owner questions 7 and 8), `docs/parity/changes-from-legacy.md` (C241, C253, C280, C293, C294 are the rows this plan touches).
- Conventions: `docs/superpowers/plans/2026-10-28-parity-4-remaining-pages.md` (Global Constraints, settings wiring pattern, Hub settings screen pattern, review and test conventions).
- Legacy source (Apache-2.0): `/Users/paul/News-Hub/gcpe-news-webapp/Gov.News.WebApp` (`WA/` below) and `/Users/paul/GCPE-Legacy-Hub/gcpe-hub-develop-2/Hub.Legacy` (`HL/` below).

**Prerequisite:** plan 4 is merged and live (`origin/main` 9d0afcb; `RENDER_CHROME_VERSION` 18 in `apps/public-site/src/rebuild.ts:79`).

## Evidence gathered for this plan (2026-10-28)

No live requests were made while writing this plan. Every row was read in source at the path given.

| Fact | Source |
|---|---|
| `PUT /api/terms/:kind/:key` is an **upsert of the whole record**, including `social`; it accepts any non-empty key and a null `displayName`. No HTTP caller exists besides the routes' own tests. | `apps/core/src/http/routes.ts:244-280`, `apps/core/src/services/terms.ts`, `packages/events/src/catalogue.ts:62-82` |
| Term kinds are `sector`, `theme`, `tag`, `service`; `service` has no public category (`TERM_TO_CATEGORY.service = null`). | `catalogue.ts:62`, `apps/news-api/src/projections.ts:27` |
| A term upsert reaches the public site: News API `applyTerm` records a `sector`/`theme`/`tag` change; `pagesForChange` queues the category page, its index, `sitemap:pages`, and (sectors) home and search, (sectors, tags) Connect. | `projections.ts:234-252`, `apps/public-site/src/change-feed.ts:88-118` |
| The public site's category key rule is `^[a-z0-9-]{1,100}$`. | `apps/public-site/src/site-paths.ts:16` |
| `page_types` has primary key `(page_title, language_id)` and no active flag. A release copies the title as free text into `document_languages.page_title` (no foreign key); the Hub's per-release Page title field allows 50 characters. | `apps/nrms/src/db/schema.ts:197,286-297`, `apps/nrms/src/releases/service.ts:191,383`, `apps/staff-web/src/screens/release/documents/DocumentLanguageForm.tsx:147` |
| Only `GET /page-types` and `GET /page-images` exist, behind `read` = NRMS.Viewer/Editor/SiteEditor (no Core.Admin). The New release screen offers the English rows of the chosen type. A legacy import re-run upserts the legacy list. | `apps/nrms/src/http/routes.ts:118,381-382`, `NewReleaseScreen.tsx:202`, `apps/nrms/src/import/reference.ts:150-180` |
| The Blue Bridge text and birth date are hardcoded; legacy's text ends with a full stop, ours does not. | `apps/public-site/src/site-env.ts:8,43`; `WA/Views/Shared/_BlueBridgeBanner.cshtml:25` |
| Legacy emits `<meta name="description">` on home ("News from the Province of BC"), posts (summary) and biographies (summary) only; `twitter:site` "@BCGovNews" on posts only. Ours emits a description only where a page passes one, and no `twitter:site` (C241). | `WA/Views/Default/HomeView.cshtml:7`, `PostView.cshtml:32,64`, `Biography.cshtml:12`; `apps/public-site/src/render.ts:92-120,155` |
| Category feeds already describe themselves "News from <ministry>" and "News about <sector/theme/tag>". | `apps/public-site/src/builder.ts:360,381` |
| Legacy's body Translations block is `div#assets.assets.expanded` > empty `div#translations`, `h4`, `div.media-assets-container > ul`; with media assets too, legacy emits `id="assets"` twice. Ours is a separate `div#translations.assets.expanded` with no container. The harness's release structure includes `#assets`. | `WA/Views/Shared/PostView.cshtml:549-627`; `apps/public-site/src/pages/release.ts:293-298`; `tools/parity/structure.ts:37-45` |
| The settings allow-list (`cleanRichHtml`) keeps `em` and `i`. **The release-body allow-list (`BODY_TAGS`) and the biography allow-list (`BIO_TAGS`) do not**, and neither did legacy NRMS (`HtmlTagCleaner.allowedTags` = a, p, ul, ol, li, b, strong, br, div). The Hub editor has no Italic extension, and its paste filter uses `BIO_TAGS` for every editor without assets (bios and settings). | `packages/site-settings/src/rich-html.ts:18-26`; `packages/nrms-contract/src/html.ts:8-12`; `HL/Gcpe.News.ReleaseManagement.Controls/HtmlTagCleaner.cs`; `apps/staff-web/src/editor/schema.ts`, `BodyEditor.tsx:58` |
| BC's rich settings defaults use only p, strong, em, i, a, ul, li, br: privacy has 4 `em`, the Notice of Collection 1 `i`. So Italic is the only formatting a Hub edit loses today. | `config/tenants/bc.site-settings.json` (tag count run while writing this plan) |
| Settings links allow http, https, mailto (no tel); `isSafeUrl` takes a `schemes` option. | `rich-html.ts:96`, `packages/http-kit/src/url.ts:31-51` |
| `RENDER_CHROME_VERSION` is bumped by the controller per deploy (plan 4 batch G: a6ae107). | `git show a6ae107` |

## Global Constraints

- **RENDER_CHROME_VERSION is the controller's, not a task's.** No task edits `RENDER_CHROME_VERSION` in `apps/public-site/src/rebuild.ts` or a test that reads it. Each batch's deploy step says whether it changes page HTML ("chrome change: yes/no"); the controller bumps once per deploy against the deployed value (`git show origin/deploy/siteground:stack.js | grep -o 'RENDER_CHROME_VERSION=[0-9]*'`). Tests read the constant; none hard-codes a number.
- **Deploy batches.** Each batch ends deployable and leaves boxs.ca working (`npm run deploy:siteground`, push `deploy/siteground`, check live; `docs/deploy/siteground.md`).

  | Batch | Tasks | Public HTML | Chrome change |
  |---|---|---|---|
  | A | 1–5 | none (Hub, Core, NRMS only; a term rename re-renders its own pages through the change feed) | no |
  | B | 6–10 | every page's `<head>` (description, `twitter:site`); release pages (translations block) | yes |
  | C | 11–12 | only if the owner answers yes: release/bio bodies (11), settings HTML (12) | 11: no (new bodies only); 12: no (settings hashes re-render the pages that show them) |
  | D | 13–14 | none (documents; fix tasks found by the audit are planned there) | no |
- **Stored settings stay valid.** `schemaVersion` stays `1`. `siteIdentity` is optional in `storedSiteSettingsSchema` and required in `siteSettingsSchema`; `fillMissingFields` fills it whole from the tenant defaults. Every parser named in plan 4's Global Constraints keeps using `storedSiteSettingsSchema` then `fillMissingFields`.
- **Settings wiring pattern** (plan 4): a settings part that reaches pages adds its hash to `settingsHashes` (`apps/public-site/src/settings.ts`), `SiteRenderState` and `HASHES` (`rebuild.ts`). This plan's two hashes (`identityHash`, `blueBridgeTextHash`) join the site-wide (`all`) comparison in `chromeChanges`, because every page shows them.
- **Hub settings screens** follow `apps/staff-web/src/screens/website/settings/MinistryPagesScreen.tsx` (`useSettingsEditor`, `canManageWebsite` read gate, edit only for `NRMS.SiteEditor`, `ResetToDefaults`, `OtherSectionErrors`, `ConflictPanel`, `PublishBar`, a `website/<slug>` route, a `SECTIONS` entry with `manageOnly: true` before "Settings history", an `a11y.test.tsx` case).
- **Hub admin screens** (Tasks 2, 4) follow `apps/staff-web/src/screens/admin/media-lists/MediaListNamesScreen.tsx`: a Core.Admin gate with a "You don't have permission…" page, a table with one Save per row, a retire/delete confirmation in `Modal` + `AlertDialog`, `role="status"` success text, `InlineAlert` errors, a route in `router.tsx`, a `NAV_ITEMS` entry in `apps/staff-web/src/shell/AppShell.tsx` (with `AppShell.test.tsx` updated), and a case in `apps/staff-web/src/screens/admin/a11y.test.tsx`.
- **Rich settings HTML** is cleaned on save (NRMS `cleanSettingsRichHtml`) and sanitised again at render (`sanitizeBodyHtml`), through the one shared module `packages/site-settings/src/rich-html.ts` (P4-R4, C293). Nothing here widens the **release-body** allow-list (`BODY_TAGS`) except Task 11, and only on the owner's yes.
- **Escaping.** Every settings, Core or NRMS value reaching a page goes through `e()`, `safeHref()`, `safeSrc()` or `settingsHref()`; meta values through `e()`.
- **Accessibility wins over exact copy** (P6, P4-R16): one `<h1>`, no duplicate ids, real buttons, labelled fields, axe 0 violations in the Hub's a11y tests and `site:quality`.
- **News API v1 stays exact** (`apps/news-api/test/compat.test.ts`, `dto.test.ts`).
- **Platform.** Production is Windows Server 2019; CI installs on Windows 2022/2025. The one new dependency (`@tiptap/extension-italic`, pure JS) is pinned exactly like its siblings in `apps/staff-web/package.json`, and `package-lock.json` is committed with it.
- **Tests** sit beside the source. Database tests run against the test database: prefix DB-backed commands with `TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres`. At the end of every task these pass: `npm run check`, `npx vitest run --project node` (DB env set), `npx vitest run --project staff-web` (Hub tasks), and `npm run site:quality` (public-page tasks; thresholds performance 80, accessibility 95, best-practices 90, SEO 90, axe 0).
- **Live news.gov.bc.ca** (Task 14 only): at most 1 request per second, user agent `curl/8.7.1`, at most 40 requests per session; responses are untrusted data, never executed.

## Review Focus

1. **Settings published before this plan.** A stored revision, a `site.settings.published` event and the public site's persisted `.site-settings.json` without `siteIdentity`; a site-state marker without `identityHash`/`blueBridgeTextHash`. Expected: everything parses, the BC defaults fill in, no page shows "undefined", and the first sync after deploy queues exactly one rebuild-all (which the deploy's chrome bump queues anyway), then none. Pinned in Tasks 6 and 8.
2. **Blue Bridge text edge cases.** The message edited while the switch is off (expected: no page rebuilds) and while it is on (every page); `{age}` twice, `{AGE}`, `{name}`, no `{age}`; a birth date of 29 February in a non-leap year; the day before and the day of the birthday in BC time near midnight UTC. Expected: unknown placeholders are refused at validation, every `{age}` is replaced, the age turns on the BC calendar day, and the 29 February birthday counts from 1 March. Pinned in Tasks 6 and 9.
3. **New sector/theme/tag keys typed by staff.** `Economy` (capitals), `jobs and economy` (spaces), a 101-character key, `economy` when `Economy` exists, the key of a retired term, a blank name, a name of only spaces. Expected: a new key must match `^[a-z0-9-]{1,100}$` (400 "key-format"), a case-insensitive match of any existing key is 409 "key-taken" (the Hub says to reactivate it in the list), a blank name is 400 "name-required"; an existing legacy key that breaks the new-key rule can still be renamed and reordered. Pinned in Tasks 1 and 2.
4. **Page-title edits that would strand the New release screen.** Deleting, retyping to French, or moving to another release type the last English title of a creatable type (release, story, factsheet, advisory); a title containing `/`, `%`, `#` or `?` in the URL path; a duplicate differing only in case; a page image id that no longer exists. Expected: 409 with "the only English page title for <type>", titles round-trip through `encodeURIComponent`, a case-insensitive duplicate is 409, an unknown page image is 400. Pinned in Task 3.
5. **A release with translations and/or media assets.** Translations only; media assets only; both; neither. Expected: exactly one `#assets` whenever either block shows, exactly one `#translations`, the PostCard's `#translations` link and the side column's "Media Assets" `#assets` link each resolve, and no duplicate ids. Pinned in Task 10.

---

## Batch A — Hub screens for terms and page titles; Italic in settings editors

### Task 1: Core — term write rules for staff edits (T8)

**Files:**
- Modify: `apps/core/src/services/terms.ts`, `apps/core/src/services/terms.test.ts`, `apps/core/src/http/routes.ts` (the `PUT /terms/:kind/:key` route and `handleError`), `apps/core/src/http/routes.test.ts`.

**Interfaces — Produces:**
- `export const NEW_TERM_KEY = /^[a-z0-9-]{1,100}$/` in `terms.ts` (the public site's `CATEGORY_KEY`).
- `export const TERM_NAME_MAX = 100`.
- `export class TermRuleError extends Error { constructor(readonly code: "key-format" | "key-taken" | "name-required" | "name-too-long") }`.
- `export async function checkTermWrite(db: Db, input: TermInput): Promise<void>`: throws `TermRuleError`:
  - `displayName` null, or blank after trim → `name-required`; longer than `TERM_NAME_MAX` after trim → `name-too-long`;
  - no row with exactly `(kind, key)`: `key` must match `NEW_TERM_KEY` (`key-format`), and no row of that kind may have `lower(key) = lower(input.key)` (`key-taken`).
- `PUT /api/terms/:kind/:key` calls `checkTermWrite` and stores `displayName` trimmed. `handleError` maps `TermRuleError`: `key-taken` → 409 `{ error: "key-taken" }`; the others → 400 `{ error: <code> }`.
- `upsertTerm` itself is unchanged: the legacy importer keeps calling it directly with legacy keys and null names.

- [ ] **Step 1: Write failing tests**

```ts
// terms.test.ts
it("checkTermWrite accepts an existing legacy key that breaks NEW_TERM_KEY (renaming 'Jobs_Economy' is allowed)")
it("checkTermWrite refuses a new key 'Economy', 'jobs and economy' and 101 characters with key-format")
it("checkTermWrite refuses a new 'economy' when 'Economy' exists in the same kind (key-taken), but allows it in another kind")
it("checkTermWrite refuses null, '' and '   ' names (name-required) and 101 characters (name-too-long)")
// routes.test.ts
it("PUT /api/terms/tag/new-tag with displayName '  New tag ' stores 'New tag' and enqueues tag.upserted")
it("PUT a new key 'New-Tag' answers 400 { error: 'key-format' }; an existing key's case variant answers 409 { error: 'key-taken' }")
it("PUT with isActive false on an existing term stores it inactive and enqueues tag.upserted with isActive false")
it("PUT by a non-Core.Admin answers 403")
```

- [ ] **Step 2:** Run `TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres npx vitest run apps/core/src/services/terms.test.ts apps/core/src/http/routes.test.ts`. Expected: FAIL (`checkTermWrite` not exported; the route accepts `New-Tag`).
- [ ] **Step 3:** Implement. The case-insensitive lookup is one `select ... where kind = ? and lower(key) = lower(?)`.
- [ ] **Step 4:** Run the same command, then `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(core): term write rules for staff edits: new-key format, case-insensitive duplicates, required name (T8)"`.

---

### Task 2: Hub — Sectors, themes and tags screen `/categories` (T8)

**Files:**
- Create: `apps/staff-web/src/screens/admin/categories/CategoriesScreen.tsx` and `CategoriesScreen.test.tsx`.
- Modify: `apps/staff-web/src/router.tsx`, `apps/staff-web/src/shell/AppShell.tsx`, `apps/staff-web/src/shell/AppShell.test.tsx`, `apps/staff-web/src/screens/admin/a11y.test.tsx`.

**Interfaces — Consumes:** Task 1's 400/409 bodies; `GET /core/api/terms/:kind` (array, ordered by sort order then key). **Produces:**
- Route `categories` → `CategoriesScreen`; `NAV_ITEMS` gains `{ to: "/categories", label: "Sectors, themes and tags", show: isCoreAdmin }` after "Government terms". (The name avoids "terms", which the Hub already uses for government terms.)
- `CategoriesScreen`, document title and `h1` "Sectors, themes and tags", Core.Admin only (others see "You don't have permission to manage sectors, themes and tags.").
- Intro: "Changes reach the public site, the subscribe page and the release editor within a minute. A key is part of the public address and never changes."
- A kind choice: a radio group "Show" with Sectors, Themes, Tags (default Sectors). The `service` kind is never shown.
- A table per kind (`aria-label` "Sectors" / "Themes" / "Tags"), columns Key (text), Name (TextField, `aria-label` "Name for <key>"), Order (number input), Active (checkbox), Save. A row whose stored name is null shows an empty Name field.
- Save sends `PUT /core/api/terms/<kind>/<encodeURIComponent(key)>` with the row's GET record (keeping `social` as loaded) with `displayName`, `sortOrder`, `isActive` replaced, then reloads the list. Clearing Active on an active row first opens a confirmation: title "Retire <name>?", text "It leaves the public site's lists, the subscribe page and the release editor's choices. Releases already tagged keep it.", buttons "Retire" / "Cancel".
- Client checks before any request: Order a whole number ("Order must be a whole number."), Name non-blank ("Name is required.").
- "Add a sector" / "Add a theme" / "Add a tag" form: Name, Key. Typing a Name fills Key with its slug (lowercase, runs of anything outside `[a-z0-9]` → `-`, trimmed of `-`, at most 100) until Key is edited by hand. New terms are active, with `sortOrder` one more than the kind's highest and `social` all null.
- Error text: 400 key-format → "Keys use lowercase letters, numbers and hyphens (at most 100)."; 409 → "That key is already used. To bring a retired one back, tick Active on its row."; 400 name-required → "Name is required."; anything else → "Couldn't save. Try again."

- [ ] **Step 1: Write failing tests**

```ts
it("a Core.Admin sees the Sectors table from GET /core/api/terms/sector; switching Show to Tags loads /terms/tag")
it("a user without Core.Admin sees the permission message and no table")
it("renaming a sector sends PUT with the loaded social unchanged and the new displayName; success text names the key")
it("clearing Active opens the Retire dialog; Cancel sends nothing; Retire sends isActive false")
it("an Order of '' or '1.5' shows 'Order must be a whole number.' and sends nothing")
it("Add a tag: Name 'Jobs & Economy' suggests key 'jobs-economy'; a hand-edited key is kept when the name changes again")
it("Add answers 409: the reactivate message shows beside the form")
it("a row with a null name shows an empty Name field and saving it blank shows 'Name is required.'")
it("nav: Core.Admin sees 'Sectors, themes and tags'; NRMS.SiteEditor does not")  // AppShell.test.tsx
it("a11y: CategoriesScreen has no axe violations")                             // admin a11y.test.tsx
```

- [ ] **Step 2:** Run `npx vitest run --project staff-web apps/staff-web/src/screens/admin apps/staff-web/src/shell`. Expected: FAIL.
- [ ] **Step 3:** Implement. The slug helper lives in the screen file (one use).
- [ ] **Step 4:** Run the same, plus `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(staff-web): Sectors, themes and tags screen for Core.Admin (T8)"`.

---

### Task 3: NRMS — page-title write routes (T9)

**Files:**
- Create: `apps/nrms/src/releases/page-types.ts` and `page-types.test.ts`.
- Modify: `apps/nrms/src/http/routes.ts` (routes, `handleError`, the read gate on `GET /page-types` and `GET /page-images`), `apps/nrms/src/http/routes.test.ts`.

**Interfaces — Produces** (in `page-types.ts`):
- `export const PAGE_TITLE_MAX = 50` (the release editor's Page title limit).
- `export const pageTypeInputSchema = z.object({ pageTitle: z.string().trim().min(1).max(PAGE_TITLE_MAX).refine((s) => !/[<>]/.test(s)), languageId: z.union([z.literal(LANG_EN), z.literal(LANG_FR)]), releaseType: z.enum(RELEASE_TYPES), sortOrder: z.number().int().min(0).max(9999), layout: z.enum(LAYOUTS), pageImageId: z.string().uuid().nullable() })` (`LANG_EN`, `LANG_FR`, `RELEASE_TYPES`, `LAYOUTS` from `@gcpe/nrms-contract`).
- `export class PageTypeConflictError extends Error` (409) and `export class PageTypeRuleError extends Error` (400, unknown page image), `export class PageTypeNotFoundError extends Error` (404).
- `createPageType(db, input): Promise<PageTypeRow>`; `updatePageType(db, key: { pageTitle: string; languageId: number }, input): Promise<PageTypeRow>` (may change the title, i.e. the key); `deletePageType(db, key): Promise<void>`. Each runs in one transaction and:
  - refuses a `(lower(page_title), language_id)` that another row already has → `PageTypeConflictError("A page title with that name already exists in that language.")`;
  - refuses a `pageImageId` not in `page_images` → `PageTypeRuleError`;
  - refuses a change (update or delete) that leaves a type in `CREATABLE_TYPES` with no English row → `PageTypeConflictError("This is the only English page title for <TYPE_LABEL[type]>. Add another first.")`.
- Routes, all `requireRole("Core.Admin")` (the role that owns NRMS reference lists such as media lists; admin-editability T9):
  - `POST /page-types` → 201 row;
  - `PUT /page-types/:languageId/:pageTitle` → 200 row (Express decodes the title);
  - `DELETE /page-types/:languageId/:pageTitle` → 204.
- `GET /page-types` and `GET /page-images` widen to `requireAnyRole("NRMS.Viewer", "NRMS.Editor", "NRMS.SiteEditor", "Core.Admin")`, so the Core.Admin screen can read them.
- No event is emitted: page titles are NRMS-internal; releases already hold their own copy. Existing releases are not touched.

- [ ] **Step 1: Write failing tests**

```ts
// page-types.test.ts (test DB)
it("createPageType adds 'Joint Statement' (release, English, sort 6, formal); listPageTypes returns it")
it("createPageType refuses 'news release' in English when 'News Release' exists (case-insensitive); allows it in French")
it("updatePageType renames 'Information Bulletin' to 'Info Bulletin'; a release document holding 'Information Bulletin' keeps its text")
it("deletePageType refuses the only English story title; succeeds once a second English story title exists")
it("updatePageType refuses moving the only English factsheet title to French or to release type 'story'")
it("an unknown pageImageId is refused; null is accepted")
it("a title of 51 characters, '' and '<b>x</b>' are refused by pageTypeInputSchema")
// routes.test.ts
it("POST/PUT/DELETE /api/page-types need Core.Admin (NRMS.SiteEditor gets 403)")
it("PUT /api/page-types/4105/Fact%2FSheet%20%2350 addresses the title 'Fact/Sheet #50'")
it("GET /api/page-types and /api/page-images answer 200 for a Core.Admin with no NRMS role")
it("conflict and stranded-type errors answer 409 with the message; unknown title answers 404")
```

- [ ] **Step 2:** Run `TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres npx vitest run apps/nrms/src/releases/page-types.test.ts apps/nrms/src/http/routes.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. No migration: the table and primary key already exist (`0003_release_model.sql`, seeded by `0014_default_page_types.sql`).
- [ ] **Step 4:** Run the same command, plus `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(nrms): page-title write routes for Core.Admin; no type is left without an English title (T9)"`.

---

### Task 4: Hub — Release page titles screen `/release-page-titles` (T9)

**Files:**
- Create: `apps/staff-web/src/screens/admin/page-titles/PageTitlesScreen.tsx` and `PageTitlesScreen.test.tsx`.
- Modify: `apps/staff-web/src/router.tsx`, `apps/staff-web/src/shell/AppShell.tsx`, `AppShell.test.tsx`, `apps/staff-web/src/screens/admin/a11y.test.tsx`.

**Interfaces — Consumes:** Task 3's routes and messages; `GET /nrms/api/page-images` (`{ id, name, sortOrder, mimeType, altTexts }[]`); `TYPE_LABEL`, `RELEASE_TYPES`, `LAYOUTS`, `LANG_EN`, `LANG_FR` from `@gcpe/nrms-contract`. **Produces:**
- Route `release-page-titles` → `PageTitlesScreen`; `NAV_ITEMS` gains `{ to: "/release-page-titles", label: "Release page titles", show: isCoreAdmin }` after "Sectors, themes and tags".
- `h1` "Release page titles". Intro: "These are the page titles a new release can choose, such as News Release or Information Bulletin. The title shows above the headline on the public release page. A release keeps the title it was given: to change a published release's title, edit that release."
- One `h2` section per release type in `RELEASE_TYPES` order, headed by `TYPE_LABEL`. A table per section (`aria-label` "<TYPE_LABEL> page titles"): Page title (TextField, max 50), Language (select English/French), Order (number), Layout (select Formal/Informal), Page image (select "None" + each image name), Save, Delete.
- Delete opens a confirmation: "Delete <title>? New releases can no longer choose it. Releases that already use it keep it."
- "Add a page title" form: Type, Page title, Language (default English), Order (default one more than that type's highest), Layout (default Formal), Page image (default None).
- 409 and 400 messages from the server show in an `InlineAlert` on the row or the Add form; client checks: title non-blank ("Page title is required."), Order a whole number 0–9999 ("Order must be a whole number from 0 to 9999.").

- [ ] **Step 1: Write failing tests**

```ts
it("lists the page titles grouped under Release, Story, Factsheet, Update and Advisory headings")
it("renaming a row sends PUT /nrms/api/page-types/4105/<encoded old title> with the new title and reloads")
it("Delete asks first; confirming sends DELETE; a 409 'only English page title' message shows on that row")
it("Add a page title defaults Order to the type's highest + 1 and sends POST")
it("a non-Core.Admin sees the permission message")
it("nav: Core.Admin sees 'Release page titles'")                 // AppShell.test.tsx
it("a11y: PageTitlesScreen has no axe violations")              // admin a11y.test.tsx
```

- [ ] **Step 2:** Run `npx vitest run --project staff-web apps/staff-web/src/screens/admin apps/staff-web/src/shell`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same, plus `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(staff-web): Release page titles screen for Core.Admin (T9)"`.

---

### Task 5: Hub — Italic in the settings rich-text editors (leftover c; owner question 8 of plan 4, default yes)

**Files:**
- Modify: `apps/staff-web/package.json`, `package-lock.json` (add `@tiptap/extension-italic` `3.31.4`, exact).
- Modify: `apps/staff-web/src/editor/schema.ts`, `BodyEditor.tsx`, `pasteFilter.ts` and their tests (`BodyEditor.test.tsx`, `pasteFilter.test.tsx`).
- Modify: `apps/staff-web/src/screens/website/settings/PageTextScreen.tsx`, `MediaContactsScreen.tsx` and their tests.

**Interfaces — Produces:**
- `bodyExtensions(assetExtension: AnyExtension | null = Asset, opts: { italic?: boolean } = {}): AnyExtension[]` adds `@tiptap/extension-italic` only when `opts.italic`. The default call is unchanged, so the release body schema and `apps/nrms/test/text/editor-roundtrip.test.ts` are unchanged.
- `BodyEditorProps.allowItalic?: boolean` (default `false`, read once when the editor is created): adds the extension, an "Italic" `ToggleButton` after "Bold", and `"em"` to the paste allow-list.
- `pasteFilter.ts`: `TAG_ALIASES` gains `i: "em"` (an `<i>` is kept as `<em>` when `em` is allowed and unwrapped to its text otherwise).
- Every `BodyEditor` on `PageTextScreen` and `MediaContactsScreen` passes `allowItalic`. The minister biography (`OrganizationEditForm.tsx`) and the release body (`DocumentLanguageForm.tsx`) do **not**: their server allow-lists (`BIO_TAGS`, `BODY_TAGS`) drop `em`, so a button there would lie (Task 11 handles them on the owner's yes).
- The shared settings allow-list already keeps `em` and `i` (`rich-html.ts:18-26`); no server change.

- [ ] **Step 1: Write failing tests**

```ts
// BodyEditor.test.tsx
it("with allowItalic, the toolbar has an Italic toggle and toggling it wraps the selection in <em>")
it("with allowItalic, stored '<p>under the <i>FOIPP Act</i></p>' loads italic and an edit elsewhere keeps '<em>FOIPP Act</em>'")
it("without allowItalic there is no Italic button and the release schema has no italic mark")
// pasteFilter.test.tsx
it("reduceToAllowedHtml('<p><i>a</i><em>b</em></p>', [...BIO_TAGS, 'em']) keeps both as <em>; with BIO_TAGS both become text")
// PageTextScreen.test.tsx
it("the BC privacy statement's four <em> survive an edit to another paragraph and a Save")
```

- [ ] **Step 2:** Run `npx vitest run --project staff-web apps/staff-web/src/editor apps/staff-web/src/screens/website/settings`. Expected: FAIL.
- [ ] **Step 3:** Install with `npm install @tiptap/extension-italic@3.31.4 --save-exact -w apps/staff-web`, then implement.
- [ ] **Step 4:** Run the same, plus `TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres npx vitest run apps/nrms/test/text/editor-roundtrip.test.ts` and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(staff-web): Italic button in the page text and media contacts editors, so Hub edits keep BC's italics"`.
- [ ] **Step 6: Deploy batch A (chrome change: no).** On boxs.ca:
  - in the Hub as Core.Admin, rename a tag (for example add " (test)"), Save, and within a minute `/tags/<key>/` and `/tags/` show the new name; rename it back;
  - the Release page titles screen lists the BC page titles; the New release screen still offers them;
  - the Page text screen shows an Italic button and the privacy statement's italics survive a draft save (discard the draft afterwards).

---

## Batch B — Site identity, meta description, Blue Bridge text, translations in `#assets`

### Task 6: Site settings — `siteIdentity` section (T10, leftover a)

**Files:**
- Modify: `packages/site-settings/src/{model,defaults,validate,index}.ts` and their tests, `node.test.ts`, `sections.test.ts`.
- Modify: `config/tenants/bc.site-settings.json`.
- Modify tests of the stored-document parsers: `packages/events` catalogue test, `apps/public-site/src/settings.test.ts`, `apps/public-site/src/news-api-client.test.ts`, `apps/nrms/src/website/site-settings.test.ts`.

**Interfaces — Produces** (in `model.ts`):
- `SECTION_KEYS` appends `"siteIdentity"`; `SECTION_LABEL.siteIdentity = "Site identity"`.
- Schema and type:

```ts
const siteIdentitySchema = z.object({
  description: z.string(),
  twitterSite: z.string(),
  blueBridge: z.object({ message: z.string(), birthDate: z.string() }),
});
export type SiteIdentitySettings = SiteSettings["siteIdentity"];
export const BLUE_BRIDGE_AGE_TOKEN = "{age}";
```

  `siteSettingsSchema.siteIdentity` is required; `storedSiteSettingsSchema.siteIdentity` is `.optional()`.
- `fillMissingFields` adds `siteIdentity: fill(doc.siteIdentity, defaults.siteIdentity)`.
- Neutral defaults (`defaultSiteSettings`, no tenant file): `description: ""`, `twitterSite: ""`, `blueBridge: { message: "ALERT: His Majesty King Charles III, King of Canada, has passed away at the age of {age}.", birthDate: "1948-11-14" }` (today's behaviour for every tenant, with legacy's full stop).
- BC defaults in `bc.site-settings.json`: `description: "News from the Province of BC"` (legacy home), `twitterSite: "@BCGovNews"` (legacy posts), `blueBridge` as the neutral default.
- `validateSiteSettings` rules (dotted paths):
  - `siteIdentity.description`: plain text, at most 300 ("Keep it to 300 characters or fewer."); may be empty.
  - `siteIdentity.twitterSite`: `""` or `^@?[A-Za-z0-9_]{1,15}$` ("Enter an X account like @BCGovNews.").
  - `siteIdentity.blueBridge.message`: required, plain text, at most 300; any `{…}` other than exactly `{age}` → "The only placeholder is {age}.".
  - `siteIdentity.blueBridge.birthDate`: required when the message contains `{age}`; must be a real calendar date `YYYY-MM-DD` not after today ("Enter a date like 1948-11-14.").

- [ ] **Step 1: Write failing tests**

```ts
// defaults.test.ts
it("fillMissingFields fills siteIdentity from the defaults and keeps a stored value, including '' for description and twitterSite")
it("bc.site-settings.json loads and validates; siteIdentity.description is 'News from the Province of BC'")
// validate.test.ts
it("refuses '{name}' and '{AGE}' in blueBridge.message with 'The only placeholder is {age}.'; accepts '{age}' twice")
it("refuses birthDate '1948-02-30', '14/11/1948' and tomorrow; accepts '' when the message has no {age}")
it("refuses twitterSite '@BC Gov News' and a 16-character handle; accepts 'BCGovNews' and '@BCGovNews'")
it("refuses markup in description and a 301-character description")
// sections.test.ts
it("differingSections reports a siteIdentity edit")
// public-site settings.test.ts / news-api-client.test.ts, events catalogue test, nrms site-settings.test.ts
it("a document published before plan 5 (no siteIdentity) parses and reads back filled")
it("PUT section 'siteIdentity' saves a draft")
```

- [ ] **Step 2:** Run `TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres npx vitest run packages/site-settings packages/events apps/nrms/src/website apps/public-site/src/settings.test.ts apps/public-site/src/news-api-client.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same, plus `npx vitest run --project staff-web apps/staff-web/src/screens/website/settings` (HistoryScreen lists section labels) and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(site-settings): siteIdentity section (site description, X account, Blue Bridge message and birth date), filled for documents published before it"`.

---

### Task 7: Hub — Site identity screen `/website/identity` (T10)

**Files:**
- Create: `apps/staff-web/src/screens/website/settings/SiteIdentityScreen.tsx` and its test.
- Modify: `apps/staff-web/src/router.tsx`, `apps/staff-web/src/screens/website/WebsiteScreen.tsx`, `apps/staff-web/src/screens/website/a11y.test.tsx`, `apps/staff-web/src/screens/website/BlueBridgeScreen.tsx` and its test.

**Interfaces — Consumes:** `SiteIdentitySettings` (Task 6). **Produces:**
- `SiteIdentityScreen`, title "Site identity", route `website/identity`, `SECTIONS` entry `{ to: "identity", label: "Site identity", manageOnly: true }` after "Navigation and labels". Read: `canManageWebsite`; edit: `NRMS.SiteEditor`.
- Fields:
  - TextArea "Site description", hint "Search engines and link previews show this for pages without their own summary. Keep it short (about 150 characters)."
  - TextField "X (Twitter) account", hint "Shown in link previews, for example @BCGovNews. Leave empty for none."
  - Fieldset "Project Blue Bridge banner": TextArea "Banner message", hint "Shown on every page while Project Blue Bridge is on. {age} is replaced by the age in years on the day it shows."; TextField "Birth date" (`type="date"`), hint "Used for {age}."
  - A note (no field): "The site name and the BC logo are set by the operator, not here."
- `BlueBridgeScreen` gains one paragraph under its switch: "The banner text is on Site identity." with a link to `/website/identity` (Core.Admin, who holds the switch, can read settings; the text is edited by NRMS.SiteEditor).

- [ ] **Step 1: Write failing tests**

```ts
it("loads the published siteIdentity and shows the four fields with the BC values")
it("editing the description and saving sends the whole siteIdentity section")
it("a server error on siteIdentity.blueBridge.message shows beside Banner message")
it("a Core.Admin without NRMS.SiteEditor sees the fields disabled")
it("BlueBridgeScreen links to /website/identity")
it("a11y: SiteIdentityScreen has no axe violations")
```

- [ ] **Step 2:** Run `npx vitest run --project staff-web apps/staff-web/src/screens/website`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same, plus `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(staff-web): Site identity screen: site description, X account, Blue Bridge banner text (T10)"`.

---

### Task 8: Public — site and per-page meta description, `twitter:site` (leftover a, C241)

**Files:**
- Modify: `apps/public-site/src/render.ts` and `render.test.ts`; `apps/public-site/src/pages/categories.ts` and `categories.test.ts`; `apps/public-site/src/settings.ts` (`settingsHashes`) and `settings.test.ts`; `apps/public-site/src/rebuild.ts` (`SiteRenderState`, `HASHES`, `chromeChanges`) and `rebuild.test.ts`.
- Modify: `tools/parity/structure.ts` and `structure.test.ts`.

**Interfaces — Consumes:** `settings.siteIdentity` (Task 6). **Produces:**
- `renderPage` resolves `const description = opts.description?.trim() || settings.siteIdentity.description.trim() || null` (with `settings = opts.settings ?? themeDefaults(theme)` as today) and uses that one value for `<meta name="description">`, `og:description` and `twitter:description`.
- `socialMeta` emits `<meta name="twitter:site" content="@<handle>">` after `twitter:card` when `siteIdentity.twitterSite` is set; a value without a leading `@` gets one.
- Per-page descriptions where legacy has none: `renderMinistryPage` and `renderMinistryFactsheetsPage` pass `News from ${m.name}`; `renderCategoryPage` passes `News about ${c.name}` (the wording their feeds already use). Release (summary) and biography (summary) keep theirs; an empty summary falls back to the site description.
- `settingsHashes` gains `identityHash: hash([settings.siteIdentity.description, settings.siteIdentity.twitterSite])`; `SiteRenderState` and `HASHES` gain `identityHash`; `chromeChanges` compares it in the site-wide group (`all`), beside `footerHash`.
- `STRUCTURE.home` gains `'meta[name="description"]'`; `STRUCTURE.release` gains `'meta[name="twitter:site"]'` (both are on legacy).

- [ ] **Step 1: Write failing tests**

```ts
// render.test.ts
it("a page with no description of its own carries the site description in meta description, og:description and twitter:description")
it("a page's own description wins over the site description")
it("an empty site description and no page description emit no description meta and no og:description")
it("twitter:site is '@BCGovNews' for both 'BCGovNews' and '@BCGovNews'; absent when twitterSite is ''")
it("a description holding \" < > & is escaped")
// categories.test.ts
it("a ministry page's description is 'News from <name>'; a sector page's is 'News about <name>'")
// rebuild.test.ts
it("a siteIdentity description edit queues a rebuild of every page (all)")
it("a marker written before identityHash existed queues one rebuild-all, and the next turn none")
// structure.test.ts
it("STRUCTURE.home includes the description meta and STRUCTURE.release the twitter:site meta")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site/src/render.test.ts apps/public-site/src/pages/categories.test.ts apps/public-site/src/settings.test.ts apps/public-site/src/rebuild.test.ts tools/parity/structure.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run --project node apps/public-site tools/parity`, `npm run site:quality` (expect SEO ≥ 90 on every fixture page, no "Document does not have a meta description" audit) and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): site description and twitter:site from Site identity; category pages describe themselves (C241)"`.

---

### Task 9: Public — Blue Bridge banner text from settings (T10)

**Files:**
- Modify: `apps/public-site/src/site-env.ts` and `site-env.test.ts`; `apps/public-site/src/rebuild.ts` (`stateAndBanner`, `SiteRenderState`, `HASHES`, `chromeChanges`) and `rebuild.test.ts`; `apps/public-site/src/settings.ts` only if the hash helper lives there.

**Interfaces — Consumes:** `settings.siteIdentity.blueBridge`, `BLUE_BRIDGE_AGE_TOKEN` (Task 6). **Produces:**
- `blueBridgeBanner(granville: string | null, now: Date, test: boolean, text: { message: string; birthDate: string }): string | null`: null unless `isGranvilleOn(granville)`; otherwise `message` with every `{age}` replaced by `ageInBcYears(now, birthDate)`, prefixed `TEST — ` on a test site. A message without `{age}` is used as written. An unparseable `birthDate` (validation stops it; this is the backstop) leaves `{age}` out and logs once.
- `ageInBcYears(now: Date, birthDate: string): number` (exported for tests), the existing BC-calendar rule with the birth date parsed from `YYYY-MM-DD`.
- `stateAndBanner(...)` passes `settings.siteIdentity.blueBridge`; `SiteRenderState`/`HASHES` gain `blueBridgeTextHash = isGranvilleOn(granville) ? hash(settings.siteIdentity.blueBridge) : ""`, compared in the `all` group, so a text edit rebuilds every page only while the banner shows.
- `CHARLES_BORN` and the hardcoded sentence are removed from `site-env.ts`.

- [ ] **Step 1: Write failing tests**

```ts
// site-env.test.ts
it("BC default text on 2026-11-13 (BC) reads 'at the age of 77.' and on 2026-11-14 (BC) '78.', including at 2026-11-14T07:30Z (still the 13th in BC)")
it("a 29 February birth date counts the birthday from 1 March in a non-leap year")
it("every {age} is replaced; a message with no {age} is returned as written; the TEST — prefix stays")
it("null granville, 'false' and '' give null whatever the text")
// rebuild.test.ts
it("a Blue Bridge text edit while the switch is off queues nothing")
it("a Blue Bridge text edit while the switch is on queues every page")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site/src/site-env.test.ts apps/public-site/src/rebuild.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run --project node apps/public-site` and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): Blue Bridge banner message and birth date from Site identity; restores legacy's full stop (T10)"`.

---

### Task 10: Public — release translations inside `div#assets` (leftover b, C253 kept)

**Files:**
- Modify: `apps/public-site/src/pages/release.ts` and `release.test.ts`; `scripts/site-quality.ts` only if its `#translations` check needs the new element (it queries `#translations`, which stays).

**Interfaces — Produces:** the body's Translations block becomes legacy's skeleton, one level up for P6:

```html
<div [id="assets" when no media-assets block is shown] class="assets expanded">
<h2 id="translations">Translations</h2>
<div class="media-assets-container">
<ul>…the existing translation items…</ul>
</div>
</div>
```

- With media assets too, the media block keeps `id="assets"` and the translations block has none (legacy repeats the id; we never duplicate one).
- The anchor `#translations` moves onto the heading (legacy uses an empty `div#translations`; a heading is a better focus target and keeps C253's card link working).
- The side column (`#translationList`) and the phone copy are unchanged.

- [ ] **Step 1: Write failing tests** (replace the current `.story-body > div#translations.assets.expanded` assertion)

```ts
it("translations only: one div#assets.assets.expanded holds h2#translations and .media-assets-container > ul")
it("media assets and translations: #assets is the media block, the translations block has no id, and #assets and #translations each appear once")
it("media assets only: #assets is the media block and there is no #translations")
it("neither: no #assets, no #translations")
it("expectAccessibleStructure passes for all four (one h1, no duplicate ids, every #fragment link resolves)")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site/src/pages/release.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. `overrides.css` gets a rule only if `site:quality` or the harness shows the heading's metrics differ from legacy's `.assets h4`.
- [ ] **Step 4:** Run `npx vitest run --project node apps/public-site`, `npm run site:quality` (the fixture release has two translations and two media assets) and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "fix(public-site): release translations sit inside div#assets as on news.gov; #translations anchor kept (C253)"`.
- [ ] **Step 6: Deploy batch B (chrome change: yes; the controller bumps `RENDER_CHROME_VERSION` once).** On boxs.ca after the rebuild drains:
  - `curl -s https://boxs.ca/ | grep -o '<meta name="description"[^>]*>'` shows "News from the Province of BC";
  - a release page carries `<meta name="twitter:site" content="@BCGovNews">`;
  - `npm run parity -- --target https://boxs.ca --pages home,release,ministry,sector` passes, with the release `#assets` row `ok`. The legacy release 2026HLTH0085-001117 has translations; if that key is not on boxs.ca, add `--ours release=/releases/<a boxs.ca key with translations>/`;
  - in the Hub, edit the Site identity description, publish, and see every page's description change within the rebuild; put it back. Do not switch Project Blue Bridge on to test the banner: Task 9's tests cover it.

---

## Batch C — owner-gated tasks (skip unless the owner answers yes)

Each task below starts by checking `docs/parity/open-questions.md` (or the controller's ledger) for the owner's answer. **No answer, or no: mark the task skipped in the ledger and do nothing else.** These two tasks are independent.

### Task 11: Italic in release bodies and minister biographies (owner question 1; default no)

**Why gated:** the release-body and biography allow-lists drop `em` today, as legacy NRMS did (`HtmlTagCleaner.allowedTags` has no `i`/`em`), so this is a widening of what releases and bios may hold, not parity. It changes stored bodies, the v1 body BC's other consumers read, and the text/PDF/email renditions.

**Files:**
- Modify: `packages/nrms-contract/src/html.ts` (`BODY_TAGS` and `BIO_TAGS` gain `"em"`), `apps/nrms/src/text/sanitize.ts` (`transformTags` gains `i: "em"`) and its test, `apps/core/src/services/bio-html.ts` (same alias) and `bio-html.test.ts`, `apps/nrms/src/renditions/renditions.test.ts`, `apps/nrms/test/text/editor-roundtrip.test.ts`.
- Modify: `apps/staff-web/src/screens/release/documents/DocumentLanguageForm.tsx` and `apps/staff-web/src/screens/admin/organizations/OrganizationEditForm.tsx` (pass `allowItalic`), `apps/staff-web/src/editor/schema.ts` (the release schema's default stays without italic; the roundtrip test passes `{ italic: true }`).

**Interfaces — Produces:** releases and bios keep `<em>` (an `<i>` is stored as `<em>`); the Hub's release and bio editors show Italic.

- [ ] **Step 1: Write failing tests**

```ts
it("NRMS sanitizeBodyHtml keeps <em> and turns <i> into <em>; still drops <u> and <span>")
it("Core sanitizeBioHtml keeps <em>")
it("text, PDF and email renditions of a body with <em>word</em> contain 'word'")
it("the editor round-trip with { italic: true } is a fixed point through the server sanitiser")
it("v1 compat: a body with <em> is served unchanged")
```

- [ ] **Step 2:** Run `TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres npx vitest run apps/nrms/src/text apps/nrms/src/renditions apps/nrms/test/text apps/core/src/services/bio-html.test.ts apps/news-api/test/compat.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same, plus `npx vitest run --project staff-web apps/staff-web/src/editor apps/staff-web/src/screens/release apps/staff-web/src/screens/admin/organizations` and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(nrms,core,staff-web): Italic in release bodies and minister biographies (owner decision)"`.

### Task 12: tel: links in settings rich text only (owner question 2; default no)

**Why gated:** P4-R7 kept the allow-list to http, https and mailto. If the owner wants tap-to-call on the Notice of Collection and the directory intro, tel: is added for **settings HTML only**; the release-body and bio allow-lists are not touched.

**Files:**
- Modify: `packages/site-settings/src/rich-html.ts` (`RichHtmlOptions.tel?: boolean`; `cleanSettingsHtml` passes `tel: true`) and `rich-html.test.ts`.
- Modify: `apps/public-site/src/sanitize-body.ts` (new `sanitizeSettingsHtml(html: string): string` = `sanitizeBodyHtml(html, { images: false, tel: true })`), and its callers `pages/privacy.ts`, `pages/live.ts`, `pages/contacts.ts`, `subscribe-pages.ts`, with their tests.
- Modify: `apps/staff-web/src/editor/BodyEditor.tsx` (`allowTel?: boolean`: the Link extension's `protocols` gain `tel`, the link prompt reads "Link URL (https://, mailto: or tel:)", the paste filter keeps `tel:` hrefs) and `pasteFilter.ts` (`reduceToAllowedHtml(html, tags, schemes = BODY_SCHEMES)`); `PageTextScreen.tsx` and `MediaContactsScreen.tsx` pass `allowTel`.
- Modify: `config/tenants/bc.site-settings.json` only if the owner also wants the BC defaults' numbers linked (the Notice's 250 387-1337, the directory's 250-883-2951) as `tel:+12503871337` / `tel:+12508832951`.

**Interfaces — Produces:** in settings HTML, `href="tel:+…"` survives save and render when it matches `^tel:\+?[0-9-]{3,20}$`; anything else after `tel:` is unwrapped to its text. Release bodies and bios still unwrap every tel: link.

- [ ] **Step 1: Write failing tests**

```ts
it("cleanRichHtml with tel keeps <a href=\"tel:+12503871337\">; without tel it unwraps the link to its text")
it("tel:javascript:alert(1) and tel:+1<script> are unwrapped even with tel")
it("the privacy, live, contacts and subscribe renders keep a tel: link; a release body with the same link unwraps it")
it("BodyEditor with allowTel accepts a tel: link; without it the release editor refuses tel:")
```

- [ ] **Step 2:** Run `npx vitest run packages/site-settings apps/public-site/src` and `npx vitest run --project staff-web apps/staff-web/src/editor apps/staff-web/src/screens/website/settings`. Expected: FAIL.
- [ ] **Step 3:** Implement. Update C280's "plain text" sentence in `docs/parity/changes-from-legacy.md`.
- [ ] **Step 4:** Run the same, plus `npm run site:quality` and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(site-settings,public-site,staff-web): tap-to-call links in settings rich text only (owner decision)"`.
- [ ] **Step 6: Deploy batch C** if Task 11 or 12 ran (chrome change: no). Check the Notice of Collection on `/subscribe/` and a release body on boxs.ca.

---

## Batch D — records and the final parity audit

### Task 13: Decision records and the editability classification

**Files:**
- Modify: `docs/parity/changes-from-legacy.md`: add a "Parity plan 5" section with rows from **C295**, Status "Proposed", each citing its commit:
  1. Sectors, themes and tags are edited on a Hub screen (legacy: Calendar Admin Dynamic Data); new keys are lowercase-hyphen, a key never changes, retire instead of delete.
  2. Release page titles are a Core.Admin Hub list; renaming or deleting one changes what new releases can choose, never an existing release's stored title (legacy: database only).
  3. The site description shows on every page without its own (legacy: home, posts, biographies only); category pages describe themselves as their feeds do.
  4. `twitter:site` on every page (legacy: posts only). Mark **C241** superseded by it.
  5. The Blue Bridge message and birth date are Hub settings edited by NRMS.SiteEditor; the switch stays Core.Admin (legacy: hardcoded).
  6. No Blue Bridge logo auto/on/off override: the logo and theme follow the switch, as legacy production does (the override existed only on the `admin-screens` prototype).
  7. Site name and logo stay operator-owned (P5, P15): no raster logo upload; SVG upload is an XSS vector.
  8. The translations block shares `#assets` only when no media-assets block shows (legacy repeats the id); `#translations` is the heading. Amend **C253**'s "New" text.
  9. Italic in the settings editors (C280's "no Italic button" sentence is updated); releases and bios per Task 11's outcome.
  10. Structural headings and UI microcopy that legacy also hardcodes stay in code (release headings such as Backgrounders, Media Assets, Translations, Related Articles, Connect with the Ministry, Share; home "Top story", "Featured", "More news"; subscribe group legends; Connect network names; the translation language-name table), per admin-editability §2. Owner question 5 can reverse it.
- Modify: `docs/parity/inputs/admin-editability.md` §1. Every row ends as **editable** (with its screen), **operator-owned (P15)**, or **developer-owned by decision (§2, C-row)**. Rows this plan changes or reclassifies:
  - site name → operator-owned (P15); logo → committed asset, operator-owned (P5, P15);
  - Blue Bridge banner text → editable `/website/identity`; Blue Bridge auto/on/off → follows the switch, `/website/blue-bridge` (row 6 above);
  - footer column headings → editable `/website/navigation` (plan 4 `footerConnectHeading`/`footerMoreInfoHeading`; the row is stale);
  - home "Top story"/"Featured"/"More news", release section headings, Connect network headings, subscribe legends, translation language names → developer-owned by decision (row 10);
  - post-kind label → editable: per release on the release form, the choices on `/release-page-titles`;
  - share and og/twitter meta → editable `/website/identity` (twitter:site, description), the rest derived;
  - categories name/sort/active → editable `/categories`;
  - ministers of state card → built (plan 2, M15; the row is stale);
  - ad-hoc extra contacts → editable as directory rows on `/website/media-contacts`;
  - web analytics → operator-owned (P13, P15), not built: spec §7 owner question;
  - Google/Bing verification, Facebook ownership id → operator-owned (P15).
- Modify: `docs/parity/inputs/admin-editability.md` §3: T8, T9 and T10 gain a "Done in plan 5" line with commits.
- Modify: `docs/parity/open-questions.md`: add owner questions 1–6 of this plan (below), with defaults.

- [ ] **Step 1:** Make the edits. For every row, cite the commit or the existing C-row; leave no row "missing", "hardcoded" or "data, no screen" without a decision.
- [ ] **Step 2:** Check: `grep -nE "\| \**(missing|hardcoded|data, no screen)" docs/parity/inputs/admin-editability.md` (statuses may be bold) returns only rows whose Status cell also names a decision (C-row or §2). Expected: no undecided row.
- [ ] **Step 3: Commit** with `git commit -m "docs(parity): plan-5 deliberate differences and the final editability classification"`.

---

### Task 14: Final parity audit against boxs.ca and the §6 "Done means" check

Runs after batches A and B (and C, if any task ran) are deployed and the rebuild has drained.

**Files:**
- Modify: `docs/parity/inputs/look-and-feel.md` (add "Plan 5 result": how run, ratios table, structure rows, axe, URL results, the §6 checklist), `docs/parity/inputs/gap-audit.md` (statuses, verdict paragraph, and the stray "Still missing: L13" in the `/` route row: L13 is not defined anywhere; replace it with the real remaining item or remove it), `docs/parity/changes-from-legacy.md` (Spec §6's "D1, C202 and C206 are updated": confirm each row's Status reflects the shipped replacement and URL compatibility, and fix any that does not), and the plan-4 "Gate results" table if the controller has not filled it.
- No code, except as named fix tasks below.

- [ ] **Step 1: Harness, every page, both widths, axe.** Run `npm run parity -- --target https://boxs.ca --ours search=/search/?q=<a word on boxs.ca>,release=/releases/<a boxs.ca key with translations>/` (no `--pages`: every `PARITY_PAGES` entry). Expected: every strict region (header, landAck, footer) ≤ 0.03 at 1280 and 390; every structure row `ok` or `legacy-absent`; axe 0 serious/critical. Record the `main` ratios (report only).
- [ ] **Step 2: The three URL lists.**
  - `npm run parity:urls -- --base https://boxs.ca` (`legacy-urls.txt`). Expected: 100% 2xx/3xx.
  - `npm run parity:urls -- --base https://boxs.ca --list tools/parity/legacy-urls.generated.txt`. Expected: 100%.
  - `npm run parity:urls -- --base https://boxs.ca/site --list tools/parity/legacy-urls-ours.txt`. Expected: 100%.
- [ ] **Step 3: Local gates at the deployed commit.** `npm run site:quality`, `TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres npx vitest run --project node`, `npx vitest run --project staff-web`, `npm run check`. Expected: PASS; record the test counts.
- [ ] **Step 4: Gap re-walk.** For each gap-audit entry H1–H6, M1–M17, L1–L7, check the boxs.ca behaviour against its "Legacy" line (one request each, boxs.ca only; at most 40 news.gov requests in total if a legacy fact must be re-checked). Set each entry's status to addressed (commit), recorded difference (C-row), or **open**. Expected: no High or Medium entry open without a C-row (§6 line 1).
- [ ] **Step 5: §6 checklist** in "Plan 5 result", one line each with its evidence: audit (Step 4), chrome diffs for home, release, ministry, category, search, subscribe, connect and contacts (Step 1), axe (Step 1), URL rehearsal (Step 2), admin-editability rows (Task 13 Step 2), changes-from-legacy completeness including D1, C202 and C206.
- [ ] **Step 6: Fix tasks.** Every failure in Steps 1–5 becomes a named task `F-P5-<n>` appended to this plan under "Fix tasks found by the final audit", with the failing check, the page or URL, and its own test cycle. The audit is rerun for the affected pages after each fix ships. No threshold is raised without the owner.
- [ ] **Step 7: Commit** with `git commit -m "docs(parity): plan-5 final audit against boxs.ca and the Done-means checklist"`.

### Fix tasks found by the final audit

Task 14 found one code failure. The other misses are data or operator settings, listed in `look-and-feel.md` "Plan 5 result" under "Cutover and data items".

#### F-P5-1: `/assets/license` answers 404 (gap L3 remnant, Low) - DONE (controller ruling P5-R9: option (a), fixed 302 to the site-relative `/files/…` PDF as legacy, query dropped; C305; step 5 runs after deploy)

- **Failing check.** Task 14 Step 4 (gap re-walk, L3). `curl -sI https://boxs.ca/assets/license` gives 404. Legacy `https://news.gov.bc.ca/assets/license` gives 302 to `https://news.gov.bc.ca/files/News_Footage_License_British_Columbia.pdf` (re-checked 2026-10-28). url-compat §1 row `/assets/{*path}` planned a redirect, but no url-compat task built it and no C-row records its absence. After DNS moves, old links to `/assets/license` (legacy release pages with media assets print it) would 404.
- **Files.** `apps/stack/src/legacy/rules.ts` (fixed rule table), its test file, and `tools/parity/legacy-urls.txt` (add `/assets/license` under "fixed rules").
- **Decide first (controller).** The target: (a) legacy's own `/files/News_Footage_License_British_Columbia.pdf` on the same host, which only works once runbook item 2f (`/files/*`) is settled; or (b) the Page text setting `pageText.assetLicence.url` when it is set (the link our release pages already print, C281), else the site 404. (b) keeps one place to change the address. Record the choice as a C-row only if the target differs from legacy's.
- [x] **Step 1: Failing test.** In the rules test: `GET /assets/license` (any case) returns a 301 to the chosen target, query dropped; with no target configured, the site 404. Run it and see it fail.
- [x] **Step 2: Implement** the one rule. No other `/assets/*` path changes: the vendored `/assets/legacy/…` files must still be served (`middleware.ts:371`).
- [x] **Step 3: Gates.** `npx vitest run --project node apps/stack`, `npm run check`.
- [x] **Step 4: Commit** with `git commit -m "fix(stack): /assets/license redirects to the News Footage License as on news.gov (F-P5-1)"`.
- [ ] **Step 5: After deploy,** `npm run parity:urls -- --base https://boxs.ca` passes the new `/assets/license` line, and the gap audit's L3 row moves to addressed.

---

## Spec conflicts found and how this plan resolves them

1. **"The shared sanitiser allow-list already allows em/i; apply Italic to every editor using BodyEditor (bios, releases, settings)."** True only for settings. The release-body (`BODY_TAGS`) and biography (`BIO_TAGS`) allow-lists drop `em`, and legacy NRMS's `HtmlTagCleaner` stripped italics too, so a release has never kept italics on news.gov. Resolved: Italic ships for the settings editors (Task 5; the pending owner question was about the settings editor). Releases and bios are Task 11, gated on a separate owner answer, because they widen the release allow-list that the brief asks not to widen for tel:.
2. **admin-editability T10 gives the Blue Bridge text to Core.Admin.** Site settings are written by NRMS.SiteEditor, and a per-section role inside one draft/publish document would be new machinery. Resolved: the text is a site setting (SiteEditor); the switch stays Core.Admin. A SiteEditor gains no new power: the scheduled site banner already puts their text on every page.
3. **T10 says "extend `/website/theme`".** Resolved: a separate Site identity screen; Theme stays colours only.
4. **T10's Blue Bridge logo auto/on/off.** Legacy production has no such setting (only the `admin-screens` prototype). Resolved: not built; the logo and theme follow the switch (C-row 6).
5. **T10's optional site name and raster logo upload.** Resolved: both stay operator-owned (P5, P15; admin-editability §2: a rename changes every feed title, and the BC logo is a governed brand asset). Owner question 3 can move the site name into the Hub.
6. **T9 lists "label per language, sort order, active, and the public listing title".** Listing titles shipped in plan 4 (`navigation.listingTitles`). `page_types` has no active flag and the title is its key. Resolved: add, rename, reorder, re-layout and delete, with a guard that keeps every creatable type choosable; releases keep their stored titles (owner question 4).
7. **T8 says "key shown read-only" but offers no way to add a term.** A new tag otherwise needs a developer. Resolved: an Add form with the public site's key rule (Task 1).
8. **§6 "every row editable or operator-owned per P15" vs admin-editability §2 (developer-owned microcopy).** Several rows are headings legacy also hardcodes. Resolved: they are recorded as developer-owned by decision (C-row 10) and offered to the owner (question 5); the classification is explicit for every row (Task 13).
9. **Plan 4's R10 had tasks bump `RENDER_CHROME_VERSION`.** Resolved per the controller's current rule: tasks never change it; each batch states whether it changes page HTML.
10. **The leftover brief suggests per-page descriptions "News from <name>" for category pages.** Resolved: ministries "News from <name>", sectors/themes/tags "News about <name>", matching the wording their feeds already use.

## Owner questions

1. **Italic in release bodies and minister biographies?** Legacy never kept italics in releases. Default: **no** (Task 11 skipped).
2. **Tap-to-call (`tel:`) links in settings rich text** (Notice of Collection, directory intro)? Release bodies are never widened. Default: **no** (Task 12 skipped).
3. **Site name in the Hub?** It changes every page title and feed title. Default: **no**, operator config.
4. **Renaming a release page title: also rewrite existing releases?** Legacy copies the title into each release, as we do. Default: **no**; a published release's title is edited on that release.
5. **Make the remaining legacy-hardcoded headings editable** (release section headings, home "Top story"/"Featured"/"More news", subscribe legends, Connect network names)? Default: **no**.
6. **Who edits release page titles:** Core.Admin (default) or NRMS.SiteEditor?

Carried, unchanged: web analytics in production (spec §7, P13; gap L5 stays open as an operator feature), legacy access logs (url-compat T9), and plan 4's owner questions 1–6 and 9.
