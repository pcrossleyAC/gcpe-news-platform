# news.gov.bc.ca Parity, Plan 1: Harness and Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the parity harness (workstream E) and repaint every public page's frame to match news.gov.bc.ca: root mount, vendored legacy CSS, BC Sans, logo, icons, legacy `<head>`, header with the ministry menu, footer with an editable land acknowledgement, banners and a styled 404 (workstream A, spec §5 step 1).

**Architecture:** The stack serves the static site at `/`. Once `PUBLIC_SITE_URL` is the origin, `/site/*` 301s to the root. The legacy CSS, images and logos are vendored byte-for-byte under `apps/public-site/assets/legacy/`. BC Sans comes from `@bcgov/bc-sans`. All of these are copied into the output folder's `assets/` on every start (`writeBuiltinAssets`) and by the build scripts.

`renderPage` emits the legacy class skeleton, adjusted for look-and-feel §5. One vanilla `assets/site/site.js` replaces jQuery and Bootstrap JS. `theme.css` keeps our `--color-*` tokens and adds the legacy variable aliases. Every chrome change bumps `RENDER_CHROME_VERSION`, so each deploy queues exactly one rebuild-all. The ministry menu adds a `ministryMenuHash` to the site-state marker.

**Tech Stack:** TypeScript, Express 5, vitest + supertest + jsdom, Playwright + `@axe-core/playwright` (already root devDeps), `pixelmatch` + `pngjs` (new root devDeps), `@fortawesome/fontawesome-free@6.7.2` (new devDep, icon source only), `@bcgov/bc-sans@2.1.2`, zod, React + `@bcgov/design-system-react-components` (Hub).

**Spec:** `docs/superpowers/specs/2026-10-28-news-gov-parity-design.md` (binding). Evidence: `docs/parity/inputs/look-and-feel.md` (§1 chrome skeleton, §3 assets, §4 theme mapping, §5 accessibility deviations), `url-compat.md` (§0, T0), `admin-editability.md`. Legacy source (Apache-2.0): `/Users/paul/News-Hub/gcpe-news-webapp/Gov.News.WebApp`, branch `admin-screens`, commit `3fdf3e6b6faa92172ba60f8bd2951bce96dbe2de` (`WA/` below).

**Prerequisite:** PR #46 (`fix/public-site-bugs`) is merged into `feat/parity` before Task 2 starts. It adds `apps/stack/src/site-not-found.ts` (`siteNotFound(outputDir)`), the `/site` 404 test in `stack.test.ts`, `MinistryContactDto` in `apps/public-site/src/dto.ts`, and changes to `pages/categories.ts` and `pages/search.ts`. Tasks 2 and 5 build on those files. No task here edits `categories.ts` or `search.ts`.

## Global Constraints

- **Owner decision 2026-10-28 (Q76 answered; supersedes spec P5):** commit the four BC logo SVGs from `WA/wwwroot/Content/Images/Gov/` (`BCID_H_rgb_pos_LH_crop.svg`, `BC_Mark.svg`, `BCID_H_rgb_pos_LH_crop_bridge.svg`, `BC_Mark_bridge.svg`) and always render them in the header and footer, as legacy does. The font stays BC Sans from `@bcgov/bc-sans` (P4). The `logoFor`/`SiteInfo.logo` file-presence gate is removed.
- P2: the site is served at `/`. `/site/<rest>?<query>` → `301 /<rest>?<query>` once `PUBLIC_SITE_URL`'s path is `/`. New env files set `SITE_PUBLIC_SITE_URL` and `NOD_PUBLIC_SITE_URL` to the bare origin.
- P3: vendor these legacy files unmodified: Bootstrap 5.3.3 CSS, `site.css`, `custom.css`, `transforms.css`, `accessibility-styles.css`, `print.css` and `granville-bridge-theme.css`. Our own changes go only in `assets/site/overrides.css`.
  - Do not vendor these dead files (look-and-feel §3.3): `covid-banner-style.css`, `covidcategory.css`, `minimenu.css`, Bootstrap 3, datepicker, jQuery, `jquery.cookie`, SignalR or Font Awesome CSS/fonts.
  - Do not ship Bootstrap JS.
  - Fold `components.css`'s one rule into `overrides.css`.
- P6: one `<h1>` per page, which comes from the page body and never the chrome. One `<main id="main" tabindex="-1">`. One skip link (`a.skip-link[href=#main]`). No `role="menu"`/`menuitem`. Every image has an `alt`. Every control is a `<button>` or a link with an `href`. Toggles carry `aria-expanded` + `aria-controls`. No duplicate ids. Footer headings are `h2`. Our `:focus-visible` rule loads after all legacy CSS. Banner links open in the same window. `role="alert"` only on the emergency banner and the Blue Bridge banner. No `<!--googleoff-->`.
- Landmarks: every visible chrome block sits in a landmark, because `npm run site:quality` fails on any axe violation, including the best-practice `region` rule.
  - The banner wrapper is `<section id="banner" aria-label="Site notices">`.
  - The land acknowledgement band is `<aside id="landAcknowledgement" aria-label="Land acknowledgement">`.
  - The skip link is exempt.
- P7: legacy variables alias our tokens:
  - `--primary-blue` and `--info-blue` → `--color-primary`;
  - `--theme-text` → `--color-text`;
  - `--theme-link` → `--color-primary`;
  - `--theme-footer-background` → `--color-background`.

  An admin colour edit changes only `theme.css`.
- Every escaped value goes through `e()`, `safeHref()` or `settingsHref()` (render.ts/settings.ts). Nothing from the News API or settings becomes markup unescaped. `site.js` builds DOM with `textContent` only.
- Asset URLs are always `${basePath(site)}/assets/...`, so they work both before and after the `PUBLIC_SITE_URL` flip.
- Every task that changes markup or CSS baked into pages bumps `RENDER_CHROME_VERSION` by exactly 1. Today's value is 4. After this plan it is 9.
- The harness runs locally and on demand, never in CI. Requests to news.gov.bc.ca are made at most 1 per second.
- Tests sit beside the source. `npm run check` and `npx vitest run --project node` (plus `--project staff-web` for Task 7) pass at the end of every task.
- Vendored files keep their licences: `apps/public-site/assets/legacy/LICENSE` (Apache-2.0, copied from the legacy repo) and `NOTICE.md`, which lists the source commit, each file and its sha256. BC Sans ships with `LICENSE_OFL.txt`. The icon sprite carries a Font Awesome Free CC BY 4.0 attribution comment.

## Review Focus

1. **A `/site/...` link from an email already sent** (`/site/subscribe/manage/?token=abc`), after the flip. Expected: one 301 to `/subscribe/manage/?token=abc`, with the query preserved byte-for-byte, then a 200. Pinned in Task 2 (`siteAliasRedirect` tests).
2. **The News API's ministries call fails during a turn.** Expected: no page is rendered with an empty "News" menu, and the failure does not cause a rebuild-all that flaps back on the next turn. Pinned in Task 5 (`syncSite` rejects the turn; `selfHeal` falls back to a working `/ministries/` link; repeat turns are stable).
3. **A settings document published before `landAcknowledgement` existed** (the live boxs.ca document, and the News API's stored copy). Expected: it parses, the band shows the tenant's default text and is not empty, and the Hub field opens prefilled with that text. Pinned in Tasks 7 and 8.
4. **An admin picks a pale primary colour**, which is now also the link colour (P7). Expected: publishing is refused with a contrast message and links stay readable. Pinned in Task 4 (new `primary`-on-`background` contrast rule).
5. **JavaScript is off or `site.js` fails to load.** Expected: the "News" control is still a working link to `/ministries/`, and the phone header still shows Subscribe and a search box. Pinned in Task 6 (`html:not(.js)` fallbacks and the server-rendered link).

---

### Task 1: Parity harness (`tools/parity/`)

**Files:**
- Create: `tools/parity/pages.ts`, `tools/parity/regions.ts`, `tools/parity/diff.ts`, `tools/parity/diff.test.ts`, `tools/parity/capture.ts`, `tools/parity/url-check.ts`, `tools/parity/url-check.test.ts`, `tools/parity/legacy-urls.txt`
- Modify: `package.json` (devDeps `pixelmatch@7.1.0`, `pngjs@7.0.0`, `@types/pngjs`; scripts `"parity": "tsx tools/parity/capture.ts"` and `"parity:urls": "tsx tools/parity/url-check.ts"`), `vitest.config.ts` (add `"tools/**/*.test.ts"` to the node project's `include`), `tsconfig.json` (add `"tools"` to `include`), `.gitignore` (add `/parity-out/`)

**Interfaces — Produces:**
- `PARITY_PAGES: { name: string; path: string; oursPath?: string }[]` lists `home` `/`, `ministry` `/ministries/health`, `sector` `/sectors/economy`, `release` `/releases/2026HLTH0085-001117`, `search` `/search?q=housing`, `subscribe` `/subscribe`, `connect` `/connect` and `contacts` `/contacts`. Ours defaults to the same path. `--pages` filters by name.
- `VIEWPORTS = [{ width: 1280, height: 900 }, { width: 390, height: 844 }]`.
- `REGIONS: Record<"banner" | "header" | "landAck" | "footer" | "main", { selector: string; strict: boolean }>` with selectors `#banner`, `header#main-nav`, `#landAcknowledgement`, `#footer` and `#main-content`. Only `main` is not strict.
- `STRICT_MAX = 0.03`: the largest mismatch ratio a strict region may have [call; Task 11 records the measured noise floor].
- `regionMismatch(a: PNG, b: PNG): { ratio: number; diff: PNG }`:
  1. Compare the overlapping `min(w) × min(h)` area with `pixelmatch` (`threshold: 0.1`).
  2. Count every non-overlapping pixel as a mismatch.
  3. Set `ratio = (mismatched + (areaA + areaB − 2·overlap)) / max(areaA, areaB)`.
- `capture.ts` CLI takes `--target <base URL>` (required; page paths are appended to it), `--legacy <origin>` (default `https://news.gov.bc.ca`), `--pages a,b`, `--regions a,b` and `--out <dir>` (default `parity-out/<timestamp>`).
  - It writes `<page>-<width>-{legacy,ours}.png`, `<page>-<width>-<region>-diff.png` and `report.json`, then prints one row per page×width×region.
  - A region missing on either side reports `missing` and fails if strict, except `banner`, which is `skipped` when either side lacks it.
  - It runs `AxeBuilder` with `AXE_TAGS` from `scripts/site-quality.ts` on **ours only**, and fails on any `serious`/`critical` violation.
  - It exits 1 on any failure.
- `checkUrls(base: string, paths: string[], fetchImpl = fetch): Promise<{ path: string; status: number; location: string | null; ok: boolean; reason?: string }[]>`:
  - `redirect: "manual"`;
  - follows at most one hop;
  - a path passes when the first response is 2xx, or is a 3xx whose single followed hop is 2xx or points to another host;
  - more than one hop fails with `reason: "redirect chain"`.

  The `url-check.ts` CLI reads `--list` (default `tools/parity/legacy-urls.txt`, one path per line, `#` comments) and exits 1 on any failure. Requests are spaced ≥1 s apart when the host is `news.gov.bc.ca`.
- Seed `legacy-urls.txt` (plan 3 extends it): `/`, `/ministries`, `/ministries/health`, `/connect`, `/subscribe`, `/search?q=housing`, `/archive`, `/site/`, `/site/ministries/`.

- [ ] **Step 1: Write failing tests**

```ts
// tools/parity/diff.test.ts
it("identical images have ratio 0", ...)                     // 10×10 solid #013366 vs same → 0
it("one differing pixel in 100 is 0.01", ...)
it("a size difference counts as mismatch", ...)              // 10×10 vs 10×12 → ratio 20/120
// tools/parity/url-check.test.ts (fake fetch)
it("200 passes; 404 fails with its status", ...)
it("a 301 to a 200 passes and records the location", ...)
it("301 → 301 fails as a redirect chain", ...)
it("a 301 to another host passes without fetching it", ...)
it("preserves the query string when following a relative Location", ...)  // Location "/x?q=a b" resolved against base
```

- [ ] **Step 2:** Run `npx vitest run tools/parity`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement `diff.ts`, `url-check.ts`, `pages.ts`, `regions.ts` and `capture.ts` per the Interfaces. `capture.ts` launches `chromium` from `@playwright/test`. For each page and viewport it calls `page.goto(...)` and waits for `networkidle`. It then calls `document.fonts.ready` and takes an element screenshot of each region with `locator.first().screenshot()`.
- [ ] **Step 4:** Run `npx vitest run tools/parity`. Expected: PASS.
- [ ] **Step 5: Baseline.** Run `npm run parity -- --target https://boxs.ca/site --pages home,ministry`. Expected: it completes and writes `report.json`. Strict regions are `missing` on ours, because the chrome is not ported yet, so the exit code is 1. Run `npm run parity -- --target https://news.gov.bc.ca --pages home`, which compares legacy with itself. Expected: every region's ratio is ≤ 0.005. Record that noise floor in the commit message.
- [ ] **Step 6: Commit** with `git commit -m "feat(parity): screenshot/region-diff/axe harness and URL rehearsal runner"`.

---

### Task 2: Root mount, `/site` → `/` 301s, origin `PUBLIC_SITE_URL` (spec P2, url-compat T0)

Builds on PR #46's `siteNotFound`.

**Files:**
- Create: `apps/stack/src/site-mount.ts`, `apps/stack/src/site-mount.test.ts`
- Modify: `apps/stack/src/stack.ts`, which currently has the `app.use("/site", …, siteNotFound(outputDir))` block and `publicDirs`. Replace that block with `mountSite`, and add `rootSiteNotFound` immediately before `app.use(newsApi.app)`.
- Modify: `apps/stack/src/stack.test.ts`. PR #46's test "an unknown /site/ URL answers 404 …" asserts `GET /no-such-page-xyz/` returns JSON. That now expects the HTML 404. The `/api/v2/...` JSON 404 assertion stays.
- Modify: `scripts/siteground-env.ts:78` and `scripts/windows-env.ts:127,129` (origin with no `/site`), `tests/siteground-env.test.ts`, `tests/windows-env.test.ts`, `scripts/build-siteground.mjs` (`--check` env: `https://news.example.invalid`), `scripts/siteground-smoke.sh:82,95` and `scripts/siteground-website-walkthrough.sh` (`$BASE/site/` → `$BASE/`), and `tests/siteground-website-walkthrough.test.ts` if it asserts the path.
- Modify: `docs/deploy/siteground.md` and `docs/deploy/windows.md`. Change `/site/` URLs to `/`, and add an "Upgrading an existing install" note: set `SITE_PUBLIC_SITE_URL` and `NOD_PUBLIC_SITE_URL` to the origin and restart. The base-URL marker then queues one rebuild-all.

**Interfaces — Produces:**
- `mountSite(app: express.Express, opts: { outputDir: string; basePath: string }): void`:
  - `basePath` is `new URL(siteEnv.PUBLIC_SITE_URL ?? tenant.publicSiteBaseUrl).pathname` with trailing slashes stripped.
  - When `basePath !== ""`, it keeps today's prefix mount on `basePath` (with `noStoreOnRedirect`, `express.static` and `siteNotFound`).
  - When `basePath === ""`, it mounts `app.use("/site", siteAliasRedirect)`.
  - In both cases it then mounts `noStoreOnRedirect` + `express.static(outputDir, { index: "index.html", maxAge: SITE_MAX_AGE_MS, dotfiles: "deny" })` at the root, inside an `express.Router()`. Call it where the `/site` mount is today, so the static file's own `Cache-Control` stands.
- `siteAliasRedirect(req, res, next)`:
  - handles GET/HEAD only (other methods call `next()`);
  - answers `301` with `Location` = `req.originalUrl` minus its leading `/site` (`"/site"` and `"/site/"` → `"/"`);
  - sends `Cache-Control: no-store`.
- `rootSiteNotFound(outputDir: string, passThrough: readonly string[]): RequestHandler` behaves like `siteNotFound(outputDir)`, but calls `next()` when `req.path === p` or starts with `p + "/"` for any `p` in `passThrough`.
- `STACK_OWNED_PREFIXES` is exported from `stack.ts`. It contains `["/api", "/health", "/events", "/updates", "/core", "/nrms", "/nod", "/calendar", "/distribution", "/site-builder", "/stack", "/hub", "/files", FAKE_FLICKR_PATH, FAKE_MEDIA_HUB_PATH, FAKE_EMERGENCY_FEED_PATH, FAKE_ENTRA_PATH]`.

- [ ] **Step 1: Write failing tests** (`site-mount.test.ts`, supertest on a bare express app, temp `outputDir` containing `index.html`, `releases/k/index.html`, `404.html` and `.site-state.json`):

```ts
it("base '' — GET / serves index.html; /releases/k/ serves the page; /releases/k → 301 /releases/k/ with no-store")
it("base '' — /site/subscribe/manage/?token=a%2Bb → 301 Location '/subscribe/manage/?token=a%2Bb', one hop, no-store")
it("base '' — /site and /site/ → 301 '/'")
it("base '' — POST /site/x falls through (next)")
it("base '/site' — /site/ serves index.html and / serves it too; /site/x is not redirected")
it("/.site-state.json is refused at the root and under /site")
it("rootSiteNotFound — GET /no-such/ → 404 text/html 404.html; GET /api/v2/x and /health/nope and /updates/x call next()")
```

In `stack.test.ts`, add: `GET ${stackUrl}/` returns 200 with the home `index.html` planted in `outputDir`, and `GET /no-such-page-xyz/` returns 404 `text/html`.

- [ ] **Step 2:** Run `npx vitest run apps/stack/src/site-mount.test.ts apps/stack/src/stack.test.ts tests/siteground-env.test.ts tests/windows-env.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `site-mount.ts`, wire it into `stack.ts`, and update the scripts, tests and docs listed above. Relabel `publicDirs` to `"SITE_OUTPUT_DIR (served at / and /site)"`.
- [ ] **Step 4:** Run the same command. Expected: PASS. Then run `npm run check`.
- [ ] **Step 5: Commit** with `git commit -m "feat(stack): serve the public site at / with /site/ 301s once PUBLIC_SITE_URL is the origin"`.
- [ ] **Step 6: Operator flip (boxs.ca), after this task is deployed:**
  1. In Site Tools, set `SITE_PUBLIC_SITE_URL=https://boxs.ca` and `NOD_PUBLIC_SITE_URL=https://boxs.ca`, then restart.
  2. After the next ticks, run `npm run parity:urls -- --base https://boxs.ca`. Expected: every seed URL passes, and `/site/` → `301 /` → 200.
  3. Run `curl -sI https://boxs.ca/site/ministries/`. Expected: `301`, `location: /ministries/`.

  Pages are not repainted yet. The base-URL change makes `chromeChanges` queue one rebuild-all.

---

### Task 3: Vendored assets, BC Sans, logos, favicon, icon sprite (no chrome change)

**Files:**
- Create the following under `apps/public-site/assets/`. Every vendored file is byte-identical to its `WA/wwwroot/` source:
  - `legacy/lib/bootstrap5/css/bootstrap.min.css`.
  - `legacy/Content/{site,custom,transforms,accessibility-styles,print,granville-bridge-theme}.css`.
  - `legacy/Content/Images/` holds 26 files:
    - the 21 images the vendored CSS references that exist in legacy: `Gov/media_background_audio.png`, `SocialMedia/20x20-white-close.png`, `SocialMedia/32x32-bc-logo.png`, `arrow-{down,left,right,up}.png`, `article-fade.png`, `bg-splitter.png`, `chevron-{down,up}{,-search}.png`, `link-arrow-{bl,wh}.png`, `link-out-icon.png`, `media_button_{close,play,play_alt}.png` and `search-ico.png`;
    - `banner-toggle.svg`;
    - the four logo SVGs under `Gov/` (owner decision).
  - `legacy/favicon.ico`, `legacy/LICENSE` (copied from `/Users/paul/News-Hub/gcpe-news-webapp/LICENSE`) and `legacy/NOTICE.md` (source repo, branch, commit, and each file with its sha256).
  - `site/icons.svg`, which is generated.
- Create: `apps/public-site/src/site-assets.ts` and `site-assets.test.ts`, `apps/public-site/src/icons.ts` and `icons.test.ts`, `apps/public-site/scripts/build-icons.ts`, and `scripts/lib/public-site-assets.mjs` with `tests/public-site-assets.test.ts`.
- Modify: `apps/public-site/package.json` (devDep `"@fortawesome/fontawesome-free": "6.7.2"`, dependency `"@bcgov/bc-sans": "2.1.2"`, script `"icons:build": "tsx scripts/build-icons.ts"`).
- Modify: `apps/public-site/src/self-heal.ts`, which calls `writeBuiltinAssets(storage)` first in its turn, before `tryHome`.
- Modify: `apps/public-site/src/static-pages.ts`, where `writeStaticPages` also calls `writeBuiltinAssets`.
- Modify: `scripts/build-siteground.mjs`, which calls `copyPublicSiteAssets(outDir)` after "copying config". Windows inherits this via `dist/siteground`.
- Modify: `scripts/build-app.mjs`, which calls `copyPublicSiteAssets(join(appDir, "dist"))` when the app is `public-site` or `stack`.
- Modify: `scripts/fixture-site.ts`, adding `TYPES` for `.woff2` (`font/woff2`), `.ico` (`image/x-icon`), `.png` (`image/png`) and `.json`.

**Interfaces — Produces:**
- `BUNDLED_SITE_ASSETS = "public-site-assets"`.
- `builtinAssetSources(here: string = import.meta.url, exists = existsSync): { root: string; fontsDir: string }`:
  - In a bundle, `root` is `<dir of here>/public-site-assets` and `fontsDir` is `<root>/legacy/fonts`.
  - In a source checkout, `root` is `apps/public-site/assets` and `fontsDir` is `@bcgov/bc-sans`'s `fonts/` directory, resolved with `createRequire(here)`.

  This mirrors `reportAssets` in `apps/calendar/src/reports/render/assets.ts`.
- `BC_SANS_FILES = ["BCSans-Regular.woff2", "BCSans-Italic.woff2", "BCSans-Bold.woff2", "BCSans-BoldItalic.woff2", "BCSans-Light.woff2", "BCSans-LightItalic.woff2"]`. `LICENSE_OFL.txt` is copied alongside them.
- `writeBuiltinAssets(storage: SiteStorage, sources = builtinAssetSources()): Promise<void>` writes:
  - every file under `root` to `assets/<same relative path>` (so `assets/legacy/**`, including `LICENSE` and `NOTICE.md`, and `assets/site/**`);
  - a second copy of `legacy/favicon.ico` at the output root as `favicon.ico`;
  - `assets/legacy/fonts/<BC_SANS_FILES>` and `assets/legacy/fonts/LICENSE_OFL.txt`.

  `custom.css` and `print.css` reference `../fonts/` relative to `Content/`, so the fonts must sit in `assets/legacy/fonts/`. Task 6 adds `assets/site/site.js` to what this writes.
- `ICONS: Record<IconId, string>` maps an id to its FA 6.7.2 source path. The ids and sources are:
  - solid: `search`→`solid/magnifying-glass`, `xmark`, `angle-down`, `angle-up`, `bars`, `caret-right`, `download`, `language`, `print`, `circle-info`, `circle-exclamation`, `envelope`, `rss`, `blog`;
  - brands: `facebook`, `square-facebook`, `x-twitter`, `square-x-twitter`, `instagram`, `threads`, `square-threads`, `bluesky`, `square-bluesky`, `linkedin`, `flickr`, `youtube`, `weibo`.

  The sprite's symbol ids are `i-<id>`.
- `icon(id: IconId, base: string, cls = "icon"): string` returns `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="${base}/assets/site/icons.svg#i-${id}"></use></svg>`.
- `copyPublicSiteAssets(outDir: string): void` copies `apps/public-site/assets` to `<outDir>/public-site-assets` and the BC Sans files plus licence to `<outDir>/public-site-assets/legacy/fonts/`.

- [ ] **Step 1: Write failing tests**

```ts
// site-assets.test.ts
it("source checkout: root is apps/public-site/assets and fonts come from @bcgov/bc-sans")
it("bundle layout: public-site-assets beside the bundle wins when it exists")
it("writeBuiltinAssets writes favicon.ico at the root, the six woff2 + LICENSE_OFL.txt under assets/legacy/fonts, the four logo SVGs, every vendored CSS, LICENSE and NOTICE.md")
it("every url(...) in the vendored CSS resolves to a written file, except the allow-listed files legacy itself lacks")
//   allow-list: Images/24x24-facebook.png, Images/24x24-share.png, Images/SocialMedia/24x24-{blogs,facebook-feed,pinterest,twitter-feed,ustream}.png,
//   and the .otf/.ttf/.woff font fallbacks (woff2 is listed first in every @font-face)
it("no dead legacy file is written: minimenu.css, covid-banner-style.css, covidcategory.css, jquery*, bootstrap.bundle*")
// icons.test.ts
it("icons.svg has a <symbol id='i-<id'> with a viewBox for every ICONS id, and the CC BY 4.0 attribution comment")
it("icon() is aria-hidden, not focusable, and carries the base path")
// tests/public-site-assets.test.ts
it("copyPublicSiteAssets lays out public-site-assets/ as builtinAssetSources expects for a bundle")
// self-heal.test.ts (add)
it("writes the builtin assets even when the News API is down")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site/src/site-assets.test.ts apps/public-site/src/icons.test.ts tests/public-site-assets.test.ts apps/public-site/src/self-heal.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Copy the vendored files and write `NOTICE.md`. Run `npm --workspace @gcpe/public-site run icons:build`, which reads `@fortawesome/fontawesome-free/svgs/<path>.svg`, keeps each `viewBox` and `<path d>`, and writes `<symbol>`s. Implement the modules and wire them in.
- [ ] **Step 4:** Run the same tests. Expected: PASS. Run `node scripts/build-siteground.mjs`. Expected: `dist/siteground/public-site-assets/legacy/fonts/BCSans-Regular.woff2` exists, the leak scan passes and `--check` passes.
- [ ] **Step 5:** After deploying, run `curl -sI https://boxs.ca/assets/legacy/Content/site.css` (expect 200 `text/css`), `…/assets/legacy/fonts/BCSans-Regular.woff2` (expect 200 `font/woff2`) and `…/favicon.ico` (expect 200).
- [ ] **Step 6: Commit** with `git commit -m "feat(public-site): vendor legacy CSS, BC logos, favicon, BC Sans and an FA icon sprite into site assets"`.

---

### Task 4: Legacy `<head>`, theme aliases, `overrides.css` (chrome v5)

**Files:**
- Modify: `apps/public-site/src/render.ts` (`renderPage` head) and `apps/public-site/src/theme-css.ts` (`themeCss`).
- Create: `apps/public-site/assets/site/overrides.css`.
- Modify: `apps/public-site/src/rebuild.ts` (`RENDER_CHROME_VERSION = 5`), `packages/site-settings/src/validate.ts`, and the tests `render.test.ts`, `theme-css.test.ts` and `packages/site-settings/src/validate.test.ts`.

**Interfaces — Consumes:** Task 3's asset paths. **Produces:**
- The head order after `<title>`, canonical, robots and description:
  1. `<link rel="icon" href="{base}/favicon.ico">`
  2. `<script>document.documentElement.classList.add("js")</script>`
  3. `assets/legacy/lib/bootstrap5/css/bootstrap.min.css`
  4. `assets/legacy/Content/site.css`
  5. `custom.css`
  6. `transforms.css`
  7. `accessibility-styles.css`
  8. `print.css` with `media="print"`
  9. `granville-bridge-theme.css`, only when `opts.banner` is non-null
  10. `assets/site/overrides.css`
  11. `assets/theme.css`
  12. the optional font link and feed alternate, as today
- `themeCss(theme, colors?)` keeps the `:root` `--color-*` block and `--font-family`. It adds the alias block `:root{--primary-blue:var(--color-primary);--info-blue:var(--color-primary);--theme-text:var(--color-text);--theme-link:var(--color-primary);--theme-footer-background:var(--color-background)}`. It ends with `:focus-visible { outline: 3px solid var(--color-accent); outline-offset: 2px; }`, which stays the last rule. Every other rule moves out of `themeCss` into `overrides.css`.
- `overrides.css` holds:
  - the rules moved from `themeCss`, so today's `.site-header`, `.site-footer`, `.card`, `.post-list`, `.ministry-layout`, `.connect-list` and `.site-banner*` still render until Tasks 6–9 and plan 2 replace them;
  - `components.css`'s `.nav-link:hover` rule;
  - `.icon{width:1em;height:1em;fill:currentColor;vertical-align:-0.125em}`;
  - `.story-copy a, main a{overflow-wrap:anywhere}` (§5 #12).

  It uses token-based colours only.
- New validation rule in `validateSiteSettings`: `checkContrast("theme.colors.primary", c.primary, c.background, "as link text", errors)`. The message is "Too faint to read as link text (x.x:1, needs 4.5:1). Pick a darker shade."

- [ ] **Step 1: Write failing tests**

```ts
// render.test.ts
it("head links the legacy CSS in legacy order, then overrides.css, then theme.css last", ...)  // indexOf chain strictly increasing
it("print.css is media=print; granville-bridge-theme.css only with a Blue Bridge banner")
it("favicon and the html.js marker script are in the head, before any stylesheet")
// theme-css.test.ts
it("aliases the five legacy variables to our tokens")                       // exact alias block string
it(":focus-visible is the last rule")
// validate.test.ts
it("a primary too pale to read as link text on the background is refused")  // primary #8FB3E8 on #FFFFFF → field theme.colors.primary
it("the bc and nb tenant defaults still validate")
// rebuild/sync: existing tests reference RENDER_CHROME_VERSION; add
it("RENDER_CHROME_VERSION is 5")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site packages/site-settings`. Expected: FAIL.
- [ ] **Step 3:** Implement the changes. Update the existing `theme-css.test.ts` cases that read rules from `themeCss` ("has a visible focus style and a skip link…") to read `overrides.css` from disk where the rule moved.
- [ ] **Step 4:** Run the same command, `npm run check`, `npx vitest run tests/fixture-site.test.ts` and `npm run site:quality`. Expected: PASS. axe reports 0 violations and Lighthouse stays at or above its thresholds (performance 90, accessibility 95).
- [ ] **Step 5:** After deploying, in DevTools on `https://boxs.ca/`, `document.fonts.check("13px BCSans")` returns `true` and the body's computed `font-family` starts with `BCSans`.
- [ ] **Step 6: Commit** with `git commit -m "feat(public-site): legacy head and stylesheet order, theme aliases, overrides.css"`.

---

### Task 5: Ministry menu data and its rebuild trigger (no visual change)

Builds on PR #46's `dto.ts`.

**Files:**
- Modify: `apps/public-site/src/dto.ts` (`MinistryDto.parentMinistryKey?: string | null`), `apps/public-site/src/render.ts` (`PageOptions.ministryMenu`), `apps/public-site/src/rebuild.ts`, `apps/public-site/src/sync.ts`, `apps/public-site/src/self-heal.ts` and `scripts/fixture-site.ts` (pass `ministryMenu` to `buildAll`).
- Create: `apps/public-site/src/ministry-menu.ts` and `ministry-menu.test.ts`.
- Test: `sync.test.ts`, `self-heal.test.ts`.

**Interfaces — Produces:**
- `interface MenuMinistry { key: string; name: string }`.
- `ministryMenu(ministries: MinistryDto[]): MenuMinistry[]` (the legacy `_Layout` and `DefaultController` rule):
  - keep entries where `isActive` is true, `parentMinistryKey` is null or absent, and `categoryPageId("ministries", key)` is non-null (the key is lowercased);
  - order "Office of the Premier" first, then by `name` with `localeCompare("en")`.
- `ministryMenuHash(menu: MenuMinistry[] | null): string` returns the sha256 of `JSON.stringify(menu)`. `null` hashes to `""`.
- `PageOptions.ministryMenu?: MenuMinistry[] | null`. Absent or null means "unavailable", and Task 6's header then renders "News" as a plain link to `/ministries/`.
- `SiteRenderState.ministryMenuHash: string`, added to `HASHES` in rebuild.ts. `chromeChanges` returns `all: true` when it differs.
  - A marker with no `ministryMenuHash` field, written before this task, reads as matching the current state. This task's deploy must not queue a rebuild-all; Task 6's version bump does that.
- `stateAndBanner(granville, test, now, settings, site, menu: MenuMinistry[] | null)`.
- `turnOptions(deps, granville, menu: MenuMinistry[] | null)` puts `ministryMenu: menu` into `pageOpts`.
- `syncSite` calls `ministryMenu(await deps.newsApi.ministries())` after `home()`. A rejection rejects the turn, as `home()` does.
- `selfHeal` uses a tolerant fetch (`null` on failure, logged with `safeErrorLabel`). If `home` or the menu is null, it writes the subscribe pages with what it has (`ministryMenu: null`) and returns `null` without touching the marker, exactly like today's `home` outage path.

- [ ] **Step 1: Write failing tests**

```ts
// ministry-menu.test.ts
it("keeps active top-level ministries only; Office of the Premier first, then by name")
it("drops a key that isn't a safe category key")
it("hash is stable for the same menu and changes when a name or the set changes")
// sync.test.ts
it("a ministry renamed since the marker queues one rebuild-all; the next identical turn queues nothing")
it("a ministries() failure rejects the turn and leaves the marker untouched")
it("a marker written before ministryMenuHash existed does not queue a rebuild-all by itself")
// self-heal.test.ts
it("ministries() down: subscribe pages written with ministryMenu null, marker untouched, returns null")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site/src/ministry-menu.test.ts apps/public-site/src/sync.test.ts apps/public-site/src/self-heal.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the changes. Update `stateAndBanner`'s callers.
- [ ] **Step 4:** Run the same command, `npm run check` and `npx vitest run apps/public-site tests/fixture-site.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): ministry menu in every turn's page options; a ministry set change rebuilds every page"`.

---

### Task 6: Header skeleton, logo, "News" menu, Subscribe, search, mobile drawer, `site.js` (chrome v6)

**Files:**
- Create: `apps/public-site/src/header.ts`, `header.test.ts`, `site-script.ts` and `site-script.test.ts` (jsdom, following the `banner-script.test.ts` pattern).
- Modify: `apps/public-site/src/render.ts`. `renderPage` replaces `header.site-header` with `renderHeader(...)`, wraps the body in `<div id="main-content" class="template container-xl"><main id="main" tabindex="-1">…</main></div>`, and adds `<script src="{base}/assets/site/site.js" defer></script>` before `</body>`. Remove `SiteInfo.logo`.
- Modify: `apps/public-site/src/static-pages.ts` (remove `logoFor`), `apps/public-site/src/start.ts` (remove the `site.logo = logoFor(…)` line), `scripts/fixture-site.ts` (drop `logo: null`), `apps/public-site/src/site-assets.ts` (`writeBuiltinAssets` also writes `assets/site/site.js` from `SITE_SCRIPT`), `overrides.css` (header rules plus the no-JS fallbacks) and `rebuild.ts` (`RENDER_CHROME_VERSION = 6`).
- Modify the tests `render.test.ts` and `static-pages.test.ts`: remove the logo tests ("shows the logo when one is set…" and "logoFor: …") and add the ones below.

**Interfaces — Consumes:** `icon()` from Task 3, `PageOptions.ministryMenu` from Task 5, and `opts.banner` (Blue Bridge on ⇔ non-null). **Produces:**
- `renderHeader(site: SiteInfo, opts: PageOptions): string` emits the look-and-feel §1.2 skeleton with the §5 deviations:
  - `<header id="main-nav" class="container-fluid sm-g-0 header nav-border">`, then `div#main-nav-container.container-xl.sm-g-0`, then `<nav class="navbar navbar-expand-md" aria-label="Main menu">`. The nav element has no id.
  - `<a href="https://gov.bc.ca">` contains `img#BCGov-logo.d-none.d-md-block` (`BCID_H_rgb_pos_LH_crop.svg`) and `img#sm-BCGov-logo.d-md-none` (`BC_Mark.svg`), each with `alt="Government of B.C."`. When `opts.banner` is non-null, the `_bridge` variants are used instead.
  - `<a class="navbar-brand ps-3" href="{base}/">{site.name}</a>`.
  - The phone controls: `button#nav-menu-sm.navbar-toggler[aria-controls=navbarSupportedContent][aria-expanded=false][aria-label="Menu"]` (icon `bars`) and `button#search-md-button.search-md.menu-icon[aria-controls=smd-search-container][aria-label="Search"]` (icon `search`).
  - `div#navbarSupportedContent.collapse.navbar-collapse > ul#sm-nav-ul.navbar-nav…` holds `li#ministry-dropdown.nav-item.ministry-dropdown`, whose content is the server-rendered `<a id="news-dropdown" class="nav-link" href="{base}/ministries/" data-menu="menu">News</a>`. `site.js` swaps it for `<button type="button" id="news-dropdown" class="nav-link" aria-expanded="false" aria-controls="menu">News{icon angle-down}</button>`, and only when `#menu` exists. That element exists only when `ministryMenu` is non-empty.
  - `li.nav-item > a.nav-link[href={base}/subscribe/]` "Subscribe".
  - `button#bannerToggleLink.nav-link[hidden][aria-controls=banner][aria-label="Show site notice"] > img[src=…/banner-toggle.svg][alt=""]`.
  - `<form class="d-flex search d-none d-lg-block" role="search" action="{base}/search/" method="get">` contains `<label class="visually-hidden" for="mini-site-search-input">Search news</label>`, `input#mini-site-search-input.form-control[name=q]` and `button.input-group-text.btn-primary-outline.search-trigger[type=submit][aria-label="Search"]` (icon `search`).
  - `div#smd-search-container.container-fluid.collapse.d-lg-none` holds the same form with ids `site-search-input` and label `Search news`.
  - `div#menu.container-fluid.collapse > div.menu.container-xl > h2.list-title "By Ministry" + ul > li > a[href={base}/ministries/{key}/]`. There is no `role=menu` or `menuitem`. It is rendered only for a non-empty menu. The legacy `#sm-menu` duplicate is not emitted: one list serves both widths.
  - No Live button (look-and-feel §1.6; plan 4 H4 adds it).
- `SITE_SCRIPT: string` must not contain `</script>`. It is an IIFE that:
  1. turns `#news-dropdown[data-menu]` into the button described above;
  2. makes each `[aria-controls]` toggle button flip `aria-expanded`, toggle `.show` on its target, and swap its icon's `<use href>` (`#i-bars`↔`#i-xmark`, `#i-angle-down`↔`#i-angle-up`, `#i-search`↔`#i-xmark`);
  3. adds `menu-open` to `body` while `#menu` is open (overrides: `body.menu-open{overflow:hidden}`);
  4. on Escape, closes the open panel and returns focus to its button;
  5. leaves the banner close/toggle and the 404 prefill as no-ops until Tasks 9 and 10 add them.
- `overrides.css` no-JS fallbacks: `html:not(.js) #navbarSupportedContent, html:not(.js) #smd-search-container{display:block}`.
- `.navbar-brand` must not be an `h1`.

- [ ] **Step 1: Write failing tests**

```ts
// header.test.ts
it("logo pair links to gov.bc.ca with alt text; bridge variants when Blue Bridge is on")
it("the News link goes to /ministries/ with the base path; #menu lists exactly the menu's ministries, escaped, in order")
it("no #menu and no data-menu when ministryMenu is null or empty")
it("no role=menu or menuitem anywhere; every id in the header is unique")
it("both search forms are role=search, GET {base}/search/ with input name q and an associated label")
it("every toggle is a <button type=button> with aria-controls pointing at an element that exists")
// render.test.ts
it("one skip link, one main#main inside div#main-content.template.container-xl, no h1 in the chrome")
it("site.js is loaded deferred with the base path")
// site-script.test.ts (jsdom, evaluated against a renderPage() document)
it("upgrades News to a button that opens #menu: aria-expanded true, .show, angle-up icon, body.menu-open")
it("Escape closes the open panel and returns focus to its button")
it("the hamburger and search toggles open their targets and swap icons")
it("without #menu the News link stays a link")
// rebuild
it("RENDER_CHROME_VERSION is 6")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site`. Expected: FAIL.
- [ ] **Step 3:** Implement `header.ts`, `site-script.ts`, the `render.ts` wiring, the removals and the header rules in `overrides.css`. Delete the old `.site-header` rules, and keep the classes the page bodies still use.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS.
- [ ] **Step 5: Visual (after the boxs.ca deploy and its rebuild-all):** Run `npm run parity -- --target https://boxs.ca --pages home,ministry,subscribe,connect --regions header`. Expected: every `header` ratio is ≤ 0.03 at 1280 and 390, and axe reports 0 serious/critical. Manual keyboard pass:
  - Tab reaches News, Subscribe and search.
  - Enter opens the menu and Escape closes it.
  - Focus stays visible.
- [ ] **Step 6: Commit** with `git commit -m "feat(public-site): news.gov header — logo, News ministry menu, Subscribe, search, phone drawer, vanilla site.js"`.

---

### Task 7: Land acknowledgement setting and Hub Footer field (no public change)

**Files:**
- Modify: `packages/site-settings/src/model.ts`, `validate.ts` and `defaults.ts` (plus `index.ts` export), and their tests. Modify `config/tenants/bc.site-settings.json`, and `apps/nrms/src/website/site-settings.ts` (`getSettingsState`).
- Modify: `apps/staff-web/src/screens/website/settings/FooterScreen.tsx` and `FooterScreen.test.tsx`.
- Test: `apps/nrms/src/website/site-settings.test.ts` (or the existing settings route test), and `screens/website/a11y.test.tsx` if it renders the footer screen.

**Interfaces — Produces:**
- `footer.landAcknowledgement: z.string().optional()` in `siteSettingsSchema`. It is optional so that every stored document and `site.settings.published` event written before this task still parses.
- Validation:
  - `> 1000` characters gives field `footer.landAcknowledgement` with the message "Keep the land acknowledgement to 1000 characters or fewer.";
  - markup gives the same field with the message "Use plain text.";
  - empty is allowed and hides the band.
- `defaultSiteSettings` derived defaults: `landAcknowledgement: ""`.
- `bc.site-settings.json` `footer.landAcknowledgement` gets the legacy text verbatim (`WA/Views/Shared/_Layout.cshtml:362-365`, whitespace collapsed): `The B.C. Public Service acknowledges the territories of First Nations around B.C. and is grateful to carry out our work on these lands. We acknowledge the rights, interests, priorities, and concerns of all Indigenous Peoples - First Nations, Métis, and Inuit - respecting and acknowledging their distinct cultures, histories, rights, laws, and governments.`
- `fillMissingFields(doc: SiteSettings, defaults: SiteSettings): SiteSettings` returns a new document. Its `footer.landAcknowledgement` is `doc`'s value when that is defined, else `defaults`'. It is the single place a later optional field gets its default.
- NRMS `getSettingsState(db, actor, defaults)` returns `fillMissingFields(document, defaults)`, so the Hub opens prefilled.
- The `FooterScreen` field goes after the copyright holder: `<TextArea label="Land acknowledgement" description="Shown in a band above the footer on every page. Plain text. Leave it empty to hide the band." value={value.landAcknowledgement ?? ""} …errorOf("landAcknowledgement")>`. `toRequest` passes the value through.

- [ ] **Step 1: Write failing tests**

```ts
// packages/site-settings
it("a document without footer.landAcknowledgement parses")                  // fixture without the key
it("landAcknowledgement over 1000 chars or with < > is refused on footer.landAcknowledgement")
it("bc defaults carry the legacy land acknowledgement text verbatim")       // toBe(LEGACY_TEXT)
it("fillMissingFields takes the default only when the field is absent; an explicit \"\" is kept")
// nrms
it("getSettingsState fills a live document's missing land acknowledgement from the tenant defaults")
// FooterScreen.test.tsx
it("shows the land acknowledgement, prefilled, and saves an edit with the footer section")
it("a SiteEditor-less Core.Admin sees the field disabled")
```

- [ ] **Step 2:** Run `npx vitest run packages/site-settings apps/nrms/src/website` and `npx vitest run --project staff-web apps/staff-web/src/screens/website/settings`. Expected: FAIL.
- [ ] **Step 3:** Implement the changes.
- [ ] **Step 4:** Run the same commands and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(site-settings): editable land acknowledgement in the footer section, BC default from legacy"`.

---

### Task 8: Footer skeleton and land acknowledgement band (chrome v7)

**Files:**
- Modify: `apps/public-site/src/render.ts` (`renderFooter`), `apps/public-site/src/settings.ts` (`currentSettings` applies `fillMissingFields` to a fetched or persisted document using `deps.defaults`), `overrides.css` (footer and band rules) and `rebuild.ts` (`RENDER_CHROME_VERSION = 7`).
- Test: `render.test.ts`, `sync.test.ts` and `self-heal.test.ts` (settings fill).

**Interfaces — Consumes:** `fillMissingFields` from Task 7. **Produces** (`renderFooter(settings, site, opts)`):
- When `settings.footer.landAcknowledgement?.trim()` is non-empty, emit `<aside id="landAcknowledgement" class="container-fluid" aria-label="Land acknowledgement"><div class="container-xl"><p>{e(text)}</p></div></aside>`, with no inline style (overrides: `#landAcknowledgement p{font-size:14px;font-weight:500}` and `#landAcknowledgement{border-color:var(--color-accent)}`).
- Then emit `<footer id="footer" class="container-fluid">` containing `div.top.container-xl`, which holds:
  - `div.footer-bc`, with `img#BCGov-logo-footer[src=…BCID_H_rgb_pos_LH_crop.svg][alt="Government of B.C."]` (the `_bridge` file when `opts.banner` is set) and `<p>{help sentence}</p>`;
  - `<nav aria-label="Footer">`, styled `display:contents` so the legacy flex row holds, containing `div.footer-connect > h2 "Connect with Us" + ul` and `div.footer-more-info > h2 "More Info" + ul.pull-left`;
  - `hr`.
- Then `div.container-xl.bottom > div.copyright "© {year} {holder}"`.
- Empty columns are omitted, as today. Overrides add `#footer h2` to legacy's `#footer h4` metrics (`font-size:16px;font-weight:600`).
- The footer hash still covers the whole `footer` object. Filling the default changes it once, in the same turn as the version bump, so the deploy queues one rebuild-all.

- [ ] **Step 1: Write failing tests**

```ts
it("renders #landAcknowledgement with the settings text, escaped, above footer#footer")
it("no band when the text is empty or whitespace")
it("a published document without the field shows the tenant default text")       // sync turn with a fetched doc lacking the key + bc defaults
it("footer#footer has .footer-bc (logo + help), nav[aria-label=Footer] with two h2 columns, hr, .bottom .copyright; no role=navigation or menu")
it("bridge footer logo when Blue Bridge is on")
it("deploying v7 with a filled default queues exactly one rebuild-all; the next turn queues nothing")
it("RENDER_CHROME_VERSION is 7")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site`. Expected: FAIL.
- [ ] **Step 3:** Implement the changes. Remove the old `.site-footer` rules from `overrides.css`.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS.
- [ ] **Step 5: Visual (after deploy):** Run `npm run parity -- --target https://boxs.ca --pages home,ministry,subscribe,connect --regions landAck,footer`. Expected: both regions ≤ 0.03 at both widths, and axe reports 0 serious/critical. Then edit the text in the Hub Footer screen and publish. Expected: the band changes on `https://boxs.ca/` after the rebuild.
- [ ] **Step 6: Commit** with `git commit -m "feat(public-site): news.gov footer with the editable land acknowledgement band"`.

---

### Task 9: Site banner and Blue Bridge skeletons (chrome v8)

**Files:**
- Modify: `apps/public-site/src/banner-script.ts` (`SITE_BANNER_SCRIPT`), `banner-script.test.ts`, `render.ts` (the banner block), `site-script.ts` (banner toggle), `overrides.css` and `rebuild.ts` (`RENDER_CHROME_VERSION = 8`).

**Interfaces — Produces** (look-and-feel §1.3–1.4):
- `renderPage` emits `<section id="banner" aria-label="Site notices">` right after the skip link. It holds:
  - when `opts.banner` is set, `<div id="bridge-banner" class="info-black-banner container-fluid sm-g-0" role="alert"><div class="content container-xl sm-g-0"><div>{icon circle-info}</div><div>{e(text)}</div><div><button type="button" id="btnCloseBannerBridge" aria-label="Close banner">{icon xmark}</button></div></div></div>`;
  - then `<div id="site-banner" hidden data-base="{base}" data-icons="{base}/assets/site/icons.svg"></div>` and the inline script.
- The script returns early when `#bridge-banner` exists, replacing the `.blue-bridge-banner` check. It builds `div.info-blue-banner.container-fluid.sm-g-0.site-banner-{info|emergency}`, with `role="alert"` only for emergency. Inside is `div.content.container-xl.sm-g-0` holding:
  - `div > svg.icon > use[href=#i-circle-info | #i-circle-exclamation]`, created with `createElementNS`;
  - `div > p{message} + ul > li > a` (same-window links; the existing `safeHref` rules stay);
  - when dismissible, `div > button#btnCloseBanner[type=button][aria-label="Close banner"] > svg xmark`.

  The text is still set with `textContent` only.
- Overrides: `.site-banner-info{background:var(--color-banner-info)}`, `.site-banner-emergency{background:var(--color-banner-emergency)}` and white text, so the banner JSON carries no colour. Remove the old `.site-banner` and `.blue-bridge-banner` rules.
- `site.js`:
  - Either close button hides its banner and un-hides the header `#bannerToggleLink`, setting `aria-expanded=false`.
  - The toggle re-shows the banner (`aria-expanded=true`).
  - The toggle stays hidden when no banner was ever shown.
  - Dismissal is not persisted, as in legacy.

- [ ] **Step 1: Write failing tests**

```ts
// banner-script.test.ts (existing jsdom harness)
it("builds .info-blue-banner > .content with an info icon, message, links and a close <button> labelled 'Close banner'")
it("emergency: site-banner-emergency, role=alert, exclamation icon")
it("never runs when #bridge-banner is present")
it("a message with markup stays text")
// render.test.ts
it("Blue Bridge: #banner > #bridge-banner.info-black-banner[role=alert] with a close button; granville CSS linked; bridge logos")
// site-script.test.ts
it("closing a banner reveals the header toggle; the toggle re-shows it and flips aria-expanded")
it("RENDER_CHROME_VERSION is 8")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site/src/banner-script.test.ts apps/public-site/src/render.test.ts apps/public-site/src/site-script.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the changes.
- [ ] **Step 4:** Run `npx vitest run apps/public-site` and `npm run check`. Expected: PASS.
- [ ] **Step 5: Visual (after deploy):**
  1. In the Hub, publish an info banner on boxs.ca with live news.gov's current message and links copied.
  2. Run `npm run parity -- --target https://boxs.ca --pages home --regions banner`. Expected: ≤ 0.03 at both widths.
  3. Switch the banner to emergency and run axe. Expected: 0 serious/critical.
  4. Unpublish the banner.
  5. Run `scripts/siteground-website-walkthrough.sh https://boxs.ca`. Expected: it still passes, and it toggles Blue Bridge.
- [ ] **Step 6: Commit** with `git commit -m "feat(public-site): legacy banner and Blue Bridge skeletons with button controls and the header notice toggle"`.

---

### Task 10: Styled 404 inside the chrome, search prefilled from the path (spec P12) (chrome v9)

**Files:**
- Modify: `apps/public-site/src/static-pages.ts` (`renderNotFoundPage`), `static-pages.test.ts`, `site-script.ts`, `site-script.test.ts`, `overrides.css` and `rebuild.ts` (`RENDER_CHROME_VERSION = 9`).

**Interfaces — Produces:**
- The `renderNotFoundPage(site, opts)` body is `<div class="home-body not-found">`, containing:
  - `<h1>Page not found</h1>`;
  - `<p>The page you asked for isn't here. It may have moved or been removed.</p>`;
  - `<form class="search-panel-bar" role="search" action="{base}/search/" method="get" data-prefill-from-path>` with `<label for="not-found-q">Search for the page</label><input id="not-found-q" name="q" type="search"><button type="submit">Search</button>`;
  - `<p><a href="{base}/">Go to the home page</a> or <a href="{base}/archive/">browse the archive</a>.</p>`.

  The text stays today's. Plan 4's T4 makes it editable. The 404 status itself comes from the stack (Task 2 and PR #46).
- `pathWords(pathname: string, base: string): string`, defined inside `SITE_SCRIPT` and also exported from `site-script.ts` for unit tests (one source string, evaluated in both):
  1. strip `base`;
  2. `decodeURIComponent`, falling back to the raw text on error;
  3. split on `/[\/\-_.+\s]+/`;
  4. drop empty tokens and `index`/`html`/`htm`/`aspx`;
  5. join with spaces and cap at 100 characters.

  `site.js` sets `#not-found-q`'s value only when the form has `data-prefill-from-path` and the input is empty.

- [ ] **Step 1: Write failing tests**

```ts
it("404 renders inside the full chrome: header#main-nav, one h1, footer#footer, a labelled search form posting to {base}/search/")
it("pathWords('/releases/2026hlth0085-housing-plan/', '') is '2026hlth0085 housing plan'")
it("pathWords strips the base path and file extensions: ('/site/ministries/Health.aspx', '/site') is 'ministries Health'")
it("pathWords survives malformed percent-encoding and caps at 100 chars")
it("site.js fills #not-found-q from location.pathname on a 404 page; leaves other pages' inputs alone")
it("RENDER_CHROME_VERSION is 9")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site/src/static-pages.test.ts apps/public-site/src/site-script.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the changes.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS.
- [ ] **Step 5: After deploy:**
  1. `curl -s -o /dev/null -w '%{http_code} %{content_type}' https://boxs.ca/releases/no-such-housing-plan/` prints `404 text/html; charset=UTF-8`.
  2. In a browser, the search box shows `releases no such housing plan`. Submitting it lands on `/search/?q=releases+no+such+housing+plan`.
  3. Run `npm run parity -- --target https://boxs.ca --pages home --regions header,footer`, with `oursPath` pointed at `/no-such-page` for a one-off run. Expected: chrome ≤ 0.03.
- [ ] **Step 6: Commit** with `git commit -m "feat(public-site): styled 404 inside the site chrome with a search prefilled from the missing path"`.

---

### Task 11: Decision records and the plan-1 parity gate

**Files:**
- Modify: `docs/superpowers/specs/2026-10-11-public-site-ai-design.md` (lines 17 and 39, D1). Mark D1 "Superseded 2026-10-28 by `2026-10-28-news-gov-parity-design.md` P1: the static site replaces news.gov.bc.ca", and keep the original text struck through or quoted.
- Modify: `docs/parity/changes-from-legacy.md`:
  - Mark C202 (line 274) and C206 (line 278) "Superseded by the parity design (P1, url-compat); legacy URLs resolve or 301".
  - Mark C205 "Agreed (parity P-non-goals)".
  - Add C212 onward, one row each, Status "Proposed":
    - per-page `<title>`;
    - one skip link;
    - buttons instead of `href`-less anchors, and no `role=menu`;
    - a single ministry list for both widths;
    - no Bootstrap/jQuery JS (vanilla `site.js`);
    - no Live button until H4;
    - Font Awesome replaced by an SVG sprite;
    - the land acknowledgement is editable;
    - a 404 is a real 404 with a prefilled search box instead of a 200 search page;
    - `/site/` 301s.
- Modify: `docs/superpowers/specs/2026-10-28-news-gov-parity-design.md`:
  - P5 becomes "Owner decision 2026-10-28: BC logo SVGs are committed (from legacy `wwwroot/Content/Images/Gov`) and always rendered."
  - P15 drops "logo" from the operator-owned files.
  - §7 removes the Q76 bullet.
- Modify: `docs/parity/open-questions.md` (Q76, line 70). Mark it "Answered 2026-10-28 (owner): commit the BC logo SVGs and always render them; BC Sans from `@bcgov/bc-sans` (OFL-1.1)".
- Modify: `docs/parity/inputs/admin-editability.md` (line 48). Land acknowledgement → **editable** (`/website/footer`).

- [ ] **Step 1:** Make the edits. Each one cites this plan's commit.
- [ ] **Step 2: Gate.**
  1. Run `npm run parity -- --target https://boxs.ca --pages home,ministry,sector,release,search,subscribe,connect`. Expected: every strict region (header, landAck, footer, and banner where present) is ≤ 0.03 at 1280 and 390, and axe reports 0 serious/critical on every page. `main` is reported only. `contacts` is excluded until plan 4.
  2. Run `npm run parity:urls -- --base https://boxs.ca`. Expected: 100% pass.
  3. Run `npm run site:quality`. Expected: PASS.

  Record the measured ratios and the legacy-vs-legacy noise floor in `docs/parity/inputs/look-and-feel.md` under a new "Plan 1 result" heading. If any strict region is over 0.03, open a fix task that names the region and the cause before plan 2 starts. The threshold is not raised without the owner.
- [ ] **Step 3: Commit** with `git commit -m "docs(parity): D1/C202/C206 superseded, Q76 answered, plan-1 parity results"`.
