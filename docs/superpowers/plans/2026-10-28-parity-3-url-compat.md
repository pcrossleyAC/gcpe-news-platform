# news.gov.bc.ca Parity, Plan 3: URL Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every news.gov.bc.ca URL that works today either serves its page on the new site or 301s to it in one hop. That covers posts, ministries, categories, feeds, search, subscribe links in sent emails, NEWS-n short links, the robots rules and the Search Console file. A rehearsal script proves it against boxs.ca (spec §4 C, P1, P2, P10, P16).

**Architecture:**
- **One Express middleware** in `apps/stack` (`legacyUrls`) runs inside `mountSite`, ahead of `express.static`. It runs at the root and under the `/site` base path. It is Node-only, and IIS forwards every request to Node, so SiteGround and Windows behave the same (url-compat §0.1).
- **The middleware never builds pages.** It does one of three things:
  - answers a 301 (302 in one case) whose Location is root-relative and points at a page that exists;
  - rewrites `req.url` so the static mount serves a file in place (feeds, the legacy OG image, long post keys);
  - falls through to the static mount and the site 404.
- **The data it needs:**
  - post-key case comes from a cached listing of `releases/`;
  - long keys come from a hashed directory the builder writes;
  - ministry renames come from a committed JSON table, composed with the existing `resolveMinistrySuccessor`;
  - NEWS-n references come from an in-process News API lookup.
- **Feeds:**
  - The public site gains Atom files beside every RSS file.
  - It also gains per-kind feeds. The kind listing pages themselves are plan 4.
- **Legacy manage tokens:**
  - NoD accepts legacy manage-link tokens: the UrlTokenEncoded `LinkGuid`, or a bare GUID.
  - `nod:import` copies the legacy links that are still unexpired.

**Tech Stack:** TypeScript, Express 5, vitest + supertest, drizzle (NoD), `node:crypto`, the `tools/parity` url-check runner.

**Spec:** `docs/superpowers/specs/2026-10-28-news-gov-parity-design.md` (binding: §4 C, P1, P2, P10, P15, P16).
- Evidence: `docs/parity/inputs/url-compat.md` (tasks T0–T10; T0 shipped in plan 1) and `gap-audit.md` (M17, L4, M10).
- Legacy source (Apache-2.0): `/Users/paul/News-Hub/gcpe-news-webapp/Gov.News.WebApp` at `3fdf3e6` (`WA/` below): `RouteConfig.cs`, `Middleware/RedirectMiddlewarecs.cs`, `Controllers/SubscribeController.cs`.
- Legacy NoD source: `/Users/paul/GCPE-Legacy-Hub/HUB/Subscribe` (`NOD/` below): `Gcpe.NewsOnDemand.Library/Legacy/{SubscriptionProvider,NodTask}.cs` and `Gcpe.NewsOnDemand.Database/dbo/*/SubscriberLink.sql`.

**Prerequisite:** plan 2 batches C and D (`feat/parity-2`) are merged into `main` before Task 1 starts. This plan relies on what they add:
- `biographyUrl`;
- the third ministry page file `ministries/<key>/biography/index.html`;
- the `/biography` → ministry-page rule in `ministry-successors.ts`;
- `DEFAULT_OG_IMAGE` vendored at `assets/legacy/Content/Images/Gov/default-og-image-new.jpg`;
- `RENDER_CHROME_VERSION = 10`.

## Evidence gathered for this plan (2026-10-28)

Live probes used 20 requests: 17 HEAD and 3 GETs (`/`, `/robots.txt`, `/sitemap/html?count=5`), at 1 request per second with `curl/8.7.1`. The rows below are what the tasks rely on:

| Fact | Label | Source |
|---|---|---|
| `/ministries/justice` → 302 `/ministries/attorney-general`; `/ministries/jobs-economic-development-and-innovation` → 302 `/ministries/jobs-and-economic-growth` | V | live |
| `/ministries/transportation-and-infrastructure` and `/ministries/environment-and-climate-change-strategy` both answer **404**. Production does not chain old names onward. | V | live |
| `/34336` → 302 `/releases/2026TT0103-001121` (the NEWS-n short link) | V | live |
| `/office-of-the-premier/biography` 200; `/ministries/office-of-the-premier` → 302 `/office-of-the-premier`; `/sectors` 200 | V | live |
| `/factsheets/feed` 200 `application/rss+xml`; `/ministries/health/factsheets/feed/atom` 200 `application/atom+xml` | V | live |
| `/google790b0529c8dcfaff.html` 200; home has `<meta name="google-site-verification" content="ss-eO0gSqB1_GY5aWryEXVmGQBHJgpe9-hdwcskzjss">` | V | live |
| `/contact` → 302 `https://forms.gov.bc.ca/` | V | live |
| robots: `Disallow` `/assets` `/error` `/files` `/search` `/Search` `/SEARCH` `/subscribe`, no Sitemap line | V | live |
| `/news-subscribe/speeches` 404 (speeches tag is dead on legacy) | V | live |
| Legacy `?token=` is `HttpServerUtility.UrlTokenEncode(LinkGuid.ToByteArray())`, where `LinkGuid` is a `SubscriberLink` row that expires after `AuthenticationTimeout` | V | NOD `SubscriptionProvider.cs:337,380-415` |
| `AuthenticationTimeout` is `1.00:00:00` (one day) in every config in the repo. The production value is unknown. | V / A | NOD `App.config:45`, `Web.config:216` |
| An expired or unknown token makes legacy redirect to `/subscribe` | V | WA `SubscribeController.cs:117-129` |
| Per-email manage links put a **bare** GUID in `newsroom.gov.bc.ca/subscribe.aspx?guid=<guid>` (the repo default template) | V (template) / A (prod template is in the DB) | NOD `NodTask.cs:408-418`, `Settings.settings:41` |
| NoD subscriber ids are the legacy `SubscriberGuid`, lowercased | V | `apps/nod/src/import/map.ts:150` |
| News API posts carry `reference` (indexed `lower(reference)`), and `getPostByReference` exists | V | `apps/news-api/src/db/schema.ts:16,64`, `posts.ts:100` |
| Post keys are unique case-insensitively (`posts_key_lower_idx`), so C206's single `/releases/` path cannot collide | V | `apps/news-api/src/db/schema.ts:63` |
| Long legacy keys: 3 of 28,440, each 102 characters | V | gap-audit M17 |
| boxs.ca still has `PUBLIC_SITE_URL=https://boxs.ca/site`. Both `/` and `/site/` answer 200. `/ministries/Health`, `/stories/x` and `/feed` answer 404. | V | boxs.ca |

## Global Constraints

- **Redirects:**
  - Status 301. The one exception is the post `/image` placeholder, which is 302.
  - Every redirect sends `Cache-Control: no-store`.
  - The Location is `${basePath}<path>`, root-relative, so the host never matters behind nginx or ARR. The only absolute Location is the fixed `https://forms.gov.bc.ca/`.
  - GET and HEAD only. Any other method falls through.
- **Query strings:**
  - The query is copied byte for byte from `req.url`. It is never decoded, re-encoded or lowercased, unless the rule names `drop` or a single-parameter strip.
  - Only the path is ever lowercased.
- **One hop.** A Location is always a page that exists now, so the target answers 2xx. Check it with `pagePath()` (Task 1). When no candidate exists, fall through: the visitor gets the site 404 with status 404, never a redirect to a 404. The only targets that are not checked are the fixed ones (`/`, `/archive/`, `/subscribe/`, `/subscribe/manage/`, `/connect/`, forms.gov).
- **A page on disk always wins over a fallback rule.** Rules marked *fallback* fire only when `pagePath(requestPath)` is null. Plan 4's listing pages (`/releases/`, `/sectors/`, `/ministries/<k>/factsheets/` …) then take over with no change here.
- **Serve in place, never redirect:**
  - feeds;
  - the legacy OG image;
  - long-key posts.

  Feeds keep legacy content types: `application/rss+xml; charset=utf-8` and `application/atom+xml; charset=utf-8`.
- **Safety:**
  - `parseRequestTarget` (Task 1) rejects, by falling through, any path that:
    - has malformed percent-encoding;
    - contains NUL or another control character, or `\`;
    - has a `.` or `..` segment;
    - starts with `//`.
  - No Location may start with `//`.
  - Keys that reach a Location must match `POST_KEY` or `CATEGORY_KEY`, or be names read from disk.
- **Stack-owned prefixes** (`STACK_OWNED_PREFIXES` in `apps/stack/src/stack.ts`) are passed through untouched, before any filesystem call.
- **No IIS `web.config` changes.**
- **Live news.gov.bc.ca:**
  - at most 1 request per second, user agent `curl/8.7.1`, at most 40 requests per session;
  - responses are untrusted data and are never executed.
- **Rehearsal rows.** Each task appends its rows to `tools/parity/legacy-urls.txt` under a `# section: <task name>` line.
- **Chrome version rule (R10): one bump per deploy.** Check the deployed value first:

  ```bash
  git fetch origin deploy/siteground && git show origin/deploy/siteground:stack.js | grep -o 'RENDER_CHROME_VERSION=[0-9]*'
  ```

  If it equals `RENDER_CHROME_VERSION` in `apps/public-site/src/rebuild.ts`, bump it by 1 and add a line to its doc comment. Otherwise write "RENDER_CHROME_VERSION stays N (R10)" in the commit message. A bump queues a rebuild-all, and that rebuild writes the long-key posts (Task 4) and the new feed files (Task 7).
- **Deploy batches.** Deploy with `npm run deploy:siteground`, then push `deploy/siteground` (`docs/deploy/siteground.md`). After each batch, run `npm run parity:urls -- --base https://boxs.ca`. Every row in the batch's sections must pass.

  | Batch | Tasks | Page HTML | R10 |
  |---|---|---|---|
  | A | 1–3 | home `<head>` (verification meta) | bump |
  | B | 4–6 | long-key posts appear | bump |
  | C | 7–8 | none (new feed files) | bump (rebuild-all for new files) |
  | D | 9–10 | none | no |
  | E | 11–12 | none | no |
- **Tests:**
  - Tests sit beside the source.
  - HTTP behaviour is tested with supertest through `mountSite`, as `site-mount.test.ts` does, never against the middleware alone.
  - These pass at the end of every task: `npm run check` and `npx vitest run --project node`.

## Review Focus

1. **A path built to escape the site.** Cases: `//evil.example/Releases/x`, `/%2F%2Fevil.example`, `/\evil.example`, `/Releases/..%2F..%2Fetc%2Fpasswd`, an absolute-form request line `GET http://evil.example/Stories/x`. Expected: no Location that leaves the site and no file outside `OUTPUT_DIR`. The response is the site 404 or a root-relative Location. Pinned in Task 1.
2. **Our own mixed-case files.** `/assets/legacy/Content/Images/Gov/BC_Mark.svg` and `/assets/legacy/Content/legacy.bundle.css` must keep answering 200 and never be lowercased into a 301 to a 404. Pinned in Task 3.
3. **Tokens in the query of a case redirect.** `/Subscribe/Manage?token=MyIRAFVEd2aImaq7zN3u_w2` → `301 /subscribe/manage/?token=MyIRAFVEd2aImaq7zN3u_w2`, with the token's case intact. Pinned in Task 3.
4. **A rename chain that ends where no page exists.** `/ministries/environment` → `environment-and-climate-change-strategy`, which has no page and no successor. That URL is 404 on live today. Expected: status 404 (the site 404), no redirect. Pinned in Task 5.
5. **A post published after the key cache was built.** A post directory created after the first request must resolve case-insensitively on the next request, because the cache is keyed by the `releases/` directory's mtime. A deleted post must stop resolving and not 301 to a 404. Pinned in Task 3.

---

## Task map (url-compat → tasks)

| url-compat | Here |
|---|---|
| T1 middleware, static files, robots | Tasks 1, 2 |
| T2 case-insensitive resolver | Task 3 |
| T3 long keys | Task 4 |
| T4 rename table + nested keys (P16) | Task 5 |
| T5 NEWS-n | Task 6 |
| T6 feeds (Atom, per kind). Pages are plan 4. | Tasks 7, 8 |
| T7 legacy subscription tokens (P10) | Tasks 9, 10 |
| T8 other hosts | not built; runbook + owner question (Task 12) |
| T9 owner evidence | documented in the runbook (Task 12) |
| T10 rehearsal | Tasks 11, 12 |

---

### Task 1: `legacyUrls` middleware core and the fixed rule table

**Files:**
- Create: `apps/stack/src/legacy/safe-path.ts`, `apps/stack/src/legacy/safe-path.test.ts`
- Create: `apps/stack/src/legacy/site-files.ts`
- Create: `apps/stack/src/legacy/rules.ts`
- Create: `apps/stack/src/legacy/middleware.ts`
- Create: `apps/stack/src/legacy/fixture.ts`, a test helper that builds a throwaway `OUTPUT_DIR`
- Create: `apps/stack/src/legacy/legacy-urls.test.ts`
- Modify: `apps/stack/src/site-mount.ts`
- Modify: `apps/stack/src/stack.ts` (around line 371): pass `passThrough: STACK_OWNED_PREFIXES`.
- Modify: `tools/parity/legacy-urls.txt`

**Interfaces — Produces:**
- `parseRequestTarget(rawUrl: string): { rawPath: string; path: string; query: string } | null`
  - `rawPath` is still percent-encoded.
  - `path` is decoded segment by segment.
  - `query` is `""` or begins with `?`, byte for byte.
  - Absolute-form scheme and host are stripped first.
- `pagePath(outputDir: string, urlPath: string): Promise<string | null>`
  - For a file: returns the URL path of the file.
  - For a directory holding `index.html`: returns the path with one trailing slash.
  - Otherwise returns null.
  - It never stats anything under a dot-segment.
- `type LegacyAction`, one of:
  - `{ do: "redirect"; to: string[]; query: "keep" | "drop"; status?: 301 | 302; fallback?: boolean }` — the first `to` that `pagePath` finds wins. A last entry ending `!` is unconditional; the `!` is stripped.
  - `{ do: "serve"; file: string; type: string }`
- `fixedRule(path: string, query: string): LegacyAction | null` (pure). It matches the lowercased path with one trailing slash stripped, on whole segments.
- `interface LegacyUrlOptions`:

  ```ts
  {
    outputDir: string;
    basePath: string;
    passThrough: readonly string[];
    lookupReference?: (reference: string) => Promise<string | null>;
  }
  ```
- `legacyUrls(opts: LegacyUrlOptions): RequestHandler`
- `mountSite(app, opts: { outputDir: string; basePath: string; passThrough?: readonly string[]; lookupReference?: LegacyUrlOptions["lookupReference"] })`
- `createLegacySiteFixture(): Promise<string>`. It writes `index.html`, `404.html` and `feed.xml`, plus an `index.html` for each of these pages:
  - `releases/2026TT0105-001130/`
  - `archive/` and `archive/2026/10/`
  - `search/`, `subscribe/`, `subscribe/manage/`, `connect/`
  - `ministries/health/`
  - `sectors/services/`
  - `tags/speeches/`

  It also writes `assets/legacy/Content/Images/Gov/default-og-image-new.jpg` (bytes `JPEGDATA`) and `.site-state.json`. Later tasks add to it.

**The fixed rules** (`rules.ts`; paths compared lowercased):

| Request path | Action |
|---|---|
| `/more-news`; `/{kind}/more-news`, `/{kind}/morearticles`, `/{kind}/archive`, `/{kind}/archive/{yyyy}` (kind = releases\|stories\|factsheets\|updates) | redirect `["/archive/!"]`, drop |
| `/{kind}/archive/{yyyy}/{mm}` | redirect `["/archive/{yyyy}/{mm}/", "/archive/!"]`, drop |
| `/archive/{yyyy}` | redirect `["/archive/!"]`, drop |
| `/{kind}` (kind index, H5) | redirect `["/!"]`, drop, **fallback** |
| `/sectors`, `/themes`, `/tags`, `/news-subscribe` (index, M16) | redirect `["/tags/" (news-subscribe only), "/!"]`, drop, **fallback** |
| `/sitemap/html` | redirect `["/archive/!"]`, drop |
| `/contact` | redirect `["https://forms.gov.bc.ca/!"]`, drop |
| `/subscribe/index` | redirect `["/subscribe/!"]`, keep |
| `/subscribe/save`, `/subscribe/renew`, `/enewsletters/unsubscribe.aspx` | redirect `["/subscribe/manage/!"]`, drop |
| `/subscribe` when the query contains `newsletters`; `/newsletters/subscribe`; `/enewsletters/subscribe.aspx` | redirect `["/subscribe/!"]`, drop |
| `/subscribe.aspx` with `guid=<g>` | redirect `/subscribe/manage/?token=<g>`. `<g>` is copied raw from the query; nothing else is kept. |
| `/newsletters`, `/newsletters/…` | redirect `["/!"]`, drop |
| `/rss/…` | redirect `["/connect/!"]`, drop |
| `/search` or `/search/` with a `resultspagenum` parameter | redirect `/search/` plus the query without that one parameter |
| `/content/images/gov/default-og-image-new.jpg`, `/areas/newsroom/images/social/default-og-meta-image.jpg` | serve `assets/legacy/Content/Images/Gov/default-og-image-new.jpg`, `image/jpeg` |

- [ ] **Step 1: Write the failing tests.**

  `safe-path.test.ts`:
  - `it("splits path and query, keeping the query bytes: /a%20b?x=A%2Bb → path '/a b', query '?x=A%2Bb'")`
  - `it("strips absolute-form: http://evil.example/Stories/x → path '/Stories/x'")`
  - `it.each(["//evil.example", "/%2F%2Fevil.example", "/\\evil.example", "/a/../b", "/a/%2e%2e/b", "/%zz", "/a%00b"])("rejects %s")` → `null`

  `legacy-urls.test.ts`: build the app the way `site-mount.test.ts` does, with `mountSite(app, { outputDir, basePath, passThrough: ["/api", "/hub"] })`, `rootSiteNotFound`, and a JSON catch-all. Write one `it` per fixed-rule row, asserting status, `location` and `cache-control: no-store`. Then these:
  - `it("/Releases/Archive/2026/10 → 301 /archive/2026/10/ (month page exists); /stories/archive/2026/09 → 301 /archive/")`
  - `it("/subscribe.aspx?guid=00112233-4455-6677-8899-AABBCCDDEEFF → 301 /subscribe/manage/?token=00112233-4455-6677-8899-AABBCCDDEEFF")`
  - `it("/search/?q=wild%20fire&resultspagenum=2&ministry=health → 301 /search/?q=wild%20fire&ministry=health")`
  - `it("/search?q=x → 301 /search/?q=x (express.static keeps the query)")`
  - `it("/Content/Images/Gov/default-og-image-new.jpg → 200 image/jpeg, body JPEGDATA, no redirect")`
  - `it("fallback: /releases → 301 /; after writing releases/index.html, /releases → 301 /releases/ and /releases/ → 200")`. This is "static wins".
  - `it("under basePath '/site': /site/newsletters → 301 /site/")`
  - `it("root mount with basePath '/site' (boxs.ca today): /newsletters → 301 /")`
  - `it("POST /newsletters falls through (no redirect)")`
  - `it("/api/x and /hub/X are never touched: the catch-all sees them")`
  - `it.each(["//evil.example/newsletters", "/%2F%2Fevil.example", "/\\evil.example"])("%s never yields a Location starting with // or a host")`
  - `it("X-Forwarded-Host: news.gov.bc.ca does not change the root-relative Location")` (IIS/ARR)
  - `it("HEAD /newsletters → 301 with the same Location")`

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run apps/stack/src/legacy`. Expected: FAIL, because the modules don't exist yet.

- [ ] **Step 3: Implement.**
  - **`middleware.ts`.**
    - Order: method check, then `passThrough` (lowercased prefix match, as `rootSiteNotFound` does), then `parseRequestTarget`, then `fixedRule`.
    - A *fallback* rule first checks `pagePath(path)`. Non-null means `next()`.
    - A redirect picks its first existing candidate, then calls `res.setHeader("Cache-Control","no-store"); res.redirect(status, basePath + to + query)`. The basePath is not prepended to the forms.gov URL. For rules whose target depends on the query (`/subscribe.aspx`, `resultspagenum`), `fixedRule` returns the finished target in `to` with `query: "drop"`.
    - A serve stats the file. Missing means `next()`. Otherwise it sets `Content-Type` and `req.url = "/" + file + query`, then calls `next()`. `send` keeps a Content-Type that is already set.
    - Errors go to `next(err)`.
  - **`site-mount.ts`.** Put `legacyUrls({ outputDir, basePath: <mount's base> , passThrough, lookupReference })` first in the root router and in the basePath chain, ahead of `ministrySuccessorRedirects`. That middleware stays until Task 5. The `/site` alias chain (basePath "") is unchanged.

- [ ] **Step 4: Run the tests and confirm they pass.** Run `npx vitest run apps/stack/src`. Expected: PASS. `site-mount.test.ts` and `ministry-successors.test.ts` pass unchanged.

- [ ] **Step 5: Add the rehearsal rows.** Under `# section: fixed rules`, add `/more-news`, `/releases/archive`, `/archive/2026`, `/sitemap/html`, `/contact`, `/newsletters`, `/subscribe/save`, `/Content/Images/Gov/default-og-image-new.jpg` and `/search?q=housing&resultspagenum=2`.

- [ ] **Step 6: Commit.**

  ```bash
  git add apps/stack/src/legacy apps/stack/src/site-mount.ts apps/stack/src/stack.ts tools/parity/legacy-urls.txt
  git commit -m "feat(stack): legacy URL middleware with the fixed news.gov rule table (url-compat T1)"
  ```

---

### Task 2: robots.txt Disallows and Google Search Console verification

**Files:**
- Modify: `apps/public-site/src/static-pages.ts` (`renderRobots`, `writeStaticPages`) and its tests
- Modify: `apps/public-site/src/env.ts`, `apps/public-site/src/start.ts` (around line 80, `SiteInfo`), and `apps/public-site/src/render.ts` (`SiteInfo` and the home `<head>`)
- Modify: `apps/public-site/src/pages/home.ts` (pass the meta through)
- Modify: `scripts/siteground-env.ts` (set both variables for boxs.ca)
- Modify: `apps/public-site/src/rebuild.ts` (R10)

**Interfaces — Produces:**
- `SiteInfo.verification?: { googleFile: string | null; googleMeta: string | null }`
- Env, prefixed `SITE_` in the stack and operator-owned per P15. Both are optional; empty means none:
  - `GOOGLE_VERIFICATION_FILE`: `^google[0-9a-f]{16}\.html$`
  - `GOOGLE_SITE_VERIFICATION`: `^[A-Za-z0-9_-]{20,100}$`

- [ ] **Step 1: Write the failing tests.**
  - `it("renderRobots (not test) is exactly the legacy Disallows without /assets, plus our Sitemap line")`. Expected:

    ```
    User-agent: *
    Disallow: /error
    Disallow: /files
    Disallow: /search
    Disallow: /Search
    Disallow: /SEARCH
    Disallow: /subscribe
    Sitemap: https://news.gov.bc.ca/sitemap.xml
    ```
  - `it("renderRobots (test) is still Disallow: /")`
  - `it("writeStaticPages writes google790b0529c8dcfaff.html containing 'google-site-verification: google790b0529c8dcfaff.html' when set, and nothing when unset")`
  - `it("home <head> carries <meta name=\"google-site-verification\" content=\"…\"> only when set; other pages never")`
  - `it("env rejects GOOGLE_VERIFICATION_FILE='../x.html' and a meta value with a quote")`

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run apps/public-site/src/static-pages.test.ts apps/public-site/src/env.test.ts apps/public-site/src/pages/home.test.ts`.
- [ ] **Step 3: Implement.** In `scripts/siteground-env.ts`, add `SITE_GOOGLE_VERIFICATION_FILE=google790b0529c8dcfaff.html` and `SITE_GOOGLE_SITE_VERIFICATION=ss-eO0gSqB1_GY5aWryEXVmGQBHJgpe9-hdwcskzjss`. Both values are public; the file proves nothing for boxs.ca, but it lets the rehearsal cover the path. Apply R10.
- [ ] **Step 4: Run the tests and confirm they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Add the rehearsal rows.** Under `# section: robots and verification`, add `/robots.txt` and `/google790b0529c8dcfaff.html`.
- [ ] **Step 6: Commit.** Use `git commit -m "feat(public-site): legacy robots Disallows and operator-set Search Console verification (url-compat §1d)"`.

---

### Task 3: Case-insensitive resolution and kind-less post paths (url-compat T2)

**Files:**
- Modify: `apps/stack/src/legacy/site-files.ts`, `apps/stack/src/legacy/middleware.ts`, `apps/stack/src/legacy/fixture.ts`
- Test: `apps/stack/src/legacy/legacy-urls.test.ts`, plus a new `apps/stack/src/legacy/site-files.test.ts`

**Interfaces — Produces:**
- `resolvePostKey(outputDir: string, key: string): Promise<string | null>`
  - Returns the on-disk directory name whose lowercase equals `key.toLowerCase()`, or null.
  - It reads from a `Map<lower, exact>` built by `readdir(releases)`, keeping only names matching `POST_KEY` (imported from `apps/public-site/src/site-paths.ts`).
  - The map is cached per `outputDir` and rebuilt when the `releases` directory's `mtimeMs` changes.
  - It never stats the requested name. That keeps it deterministic on case-insensitive NTFS.
- **Post rule** in the middleware. It applies to `/(releases|stories|factsheets|updates)/<key>[/]`, matched in any case:
  1. `exact = await resolvePostKey(key)`. If null, `next()`.
  2. The canonical path is `/releases/<exact>/`. If `pagePath` doesn't find it (an empty directory left after a delete), `next()`.
  3. If the request path equals the canonical path, `next()`. Otherwise answer 301 to the canonical path and keep the query.
- **Image rule:** `/(releases|stories|factsheets|updates)/<key>/image` → **302** `DEFAULT_OG_IMAGE`, drop. It applies when the key resolves. **[call]** This is a placeholder until a real per-post image endpoint is worth building.
- **General case rule** (runs last): when the decoded path has an uppercase letter and `pagePath(path)` is null, try `pagePath(path.toLowerCase())`. If that finds a page, answer 301 to it with the query kept. The Location is built from `rawPath.toLowerCase()`, normalised to the trailing-slash form `pagePath` returned, and is never re-encoded.

- [ ] **Step 1: Write the failing tests.**
  - `it("/Releases/2026tt0105-001130 → 301 /releases/2026TT0105-001130/")`
  - `it("/stories/2026TT0105-001130, /factsheets/…/ and /UPDATES/… → 301 /releases/2026TT0105-001130/ (one hop: the target answers 200)")`
  - `it("/releases/2026TT0105-001130/ → 200, no redirect")`
  - `it("/releases/NOPE-1 and /stories/NOPE-1 → 404 with the site 404 body")`
  - `it("/releases/2026TT0105-001130/image → 302 /assets/legacy/Content/Images/Gov/default-og-image-new.jpg")`
  - `it("/Search?q=Wild%20Fire → 301 /search/?q=Wild%20Fire")`
  - `it("/Ministries/Health → 301 /ministries/health/")`
  - `it("/assets/legacy/Content/Images/Gov/BC_Mark.svg → 200 (exact case exists, never lowercased)")`
  - `it("/Subscribe/Manage?token=MyIRAFVEd2aImaq7zN3u_w2 → 301 /subscribe/manage/?token=MyIRAFVEd2aImaq7zN3u_w2")`
  - `it("a post directory created after the first request resolves on the next one; one whose index.html was removed no longer redirects")`. This test sets the `releases` dir mtime forward with `utimes`.
  - `it("under basePath '/site': /site/Stories/2026TT0105-001130 → 301 /site/releases/2026TT0105-001130/")`
  - `site-files.test.ts`: `it("resolvePostKey ignores names that fail POST_KEY (e.g. '_long', '.x')")`

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run apps/stack/src/legacy`.
- [ ] **Step 3: Implement.** The post rule runs before the general case rule. In the fixture, add `assets/legacy/Content/Images/Gov/BC_Mark.svg`.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `npx vitest run apps/stack/src`. Expected: PASS.
- [ ] **Step 5: Add the rehearsal rows.** Under `# section: posts and case`, add `/releases/2026TT0105-001130`, `/Releases/2026tt0105-001130`, `/stories/2026TT0105-001130`, `/releases/2026TT0105-001130/image`, `/Search?q=housing` and `/Ministries/Health`. These need that post on boxs.ca [A]; Task 11 swaps in a key boxs.ca has if not.
- [ ] **Step 6: Commit.** Use `git commit -m "feat(stack): case-insensitive legacy post, kind and page paths in one 301 (url-compat T2)"`.

---

### Task 4: Post keys over 100 characters, served at the same URL (url-compat T3, M17)

**Files:**
- Modify: `apps/public-site/src/site-paths.ts` and `site-paths.test.ts`, `apps/public-site/src/builder.test.ts`
- Modify: `apps/news-api/src/search/similar.ts:26` (`excludeKey` max 100 → 200)
- Modify: `apps/stack/src/legacy/middleware.ts`, `fixture.ts`, `legacy-urls.test.ts`
- Modify: `apps/public-site/src/rebuild.ts` (R10, batch B)

**Interfaces — Produces** (in `site-paths.ts`; the stack imports it the way `ministry-successors.ts` imports `CATEGORY_KEY`):
- `POST_KEY = /^[A-Za-z0-9-]{1,200}$/`. 200 matches `RELATED_MAX_KEY_CHARS`.
- `SHORT_POST_KEY_MAX = 100`
- `LONG_POST_DIR = "releases/_long"`
- `postDir(key: string): string`
  - A key of 100 characters or fewer: `releases/<key>`.
  - Otherwise: `releases/_long/<first 32 hex chars of sha256(key.toLowerCase())>`, using `node:crypto`.
- `postPath(key) = postDir(key) + "/index.html"`. `pageUrl` for a post is unchanged: `/releases/<encodeURIComponent(key)>/`.
- **Middleware:** in the post rule, a key longer than 100 that matches `POST_KEY` is checked against `postDir(key)` instead of `resolvePostKey`.
  - The canonical request `/releases/<key>/`, in any case, is served in place: `req.url = "/" + postDir(key) + "/" + query`, then `next()`.
  - A slash-less request, or one under another kind, gets a 301 to `/releases/<key as requested>/`.
  - The exact case is not stored. The page's canonical link carries it.

- [ ] **Step 1: Write the failing tests.**
  - `site-paths.test.ts`:
    - `it("postPath of the 102-char M17 key is releases/_long/106422386aca9cfd948a818d5a9a92f5/index.html")`. The key is `canada-and-british-columbia-investments-in-local-infrastructure-help-build-community-connections-for-1`.
    - `it("a 100-char key keeps releases/<key>/index.html")`
    - `it("POST_KEY accepts 200 chars, rejects 201, '../x', 'a/b' and '_long'")`
    - `it("pageUrl of the long key is /releases/<key>/")`
  - `builder.test.ts`: `it("renders a post with a 102-char key to the hashed dir, and allPostKeys still lists it")`
  - `legacy-urls.test.ts`:
    - `it("GET /releases/<102-char key>/ → 200 serving the hashed page")`
    - `it("/RELEASES/<KEY UPPERCASED>/ → 200 (same dir)")`
    - `it("/releases/<key> → 301 /releases/<key>/")`
    - `it("/stories/<key> → 301 /releases/<key>/")`
    - `it("an unknown 150-char key → 404")`

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run apps/public-site/src/site-paths.test.ts apps/public-site/src/builder.test.ts apps/stack/src/legacy`.
- [ ] **Step 3: Implement.** Confirm that `allPostKeys`' `storage.listDirs("releases")` skips `_long`: the underscore fails `POST_KEY`.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `npx vitest run --project node`. Expected: PASS.
- [ ] **Step 5: Add the rehearsal row.** Under `# section: long keys`, add `/releases/canada-and-british-columbia-investments-in-local-infrastructure-help-build-community-connections-for-1`. It needs that post imported on boxs.ca [A].
- [ ] **Step 6: Commit.** Use `git commit -m "feat(public-site,stack): post keys up to 200 chars served at /releases/<key>/ from a hashed dir (url-compat T3, M17)"`.

---

### Task 5: Ministries, categories, the Premier and nested keys (url-compat T4, L4, P16)

**Files:**
- Create: `apps/stack/src/legacy/ministry-renames.json`, `apps/stack/src/legacy/ministry-renames.ts`, `ministry-renames.test.ts`
- Create: `tools/parity/ministry-renames-live.ts` (one-off live check)
- Modify: `apps/stack/src/legacy/middleware.ts`, `fixture.ts`, `legacy-urls.test.ts`
- Modify: `apps/stack/src/site-mount.ts` (drop `ministrySuccessorRedirects` from the root and basePath chains; keep it on the `/site` alias chain)

**The table.** Direct edges extracted from `WA/Middleware/RedirectMiddlewarecs.cs`: `Redirect()` lines 141–264, `RedirectFromNewsroom` lines 453–506, `RedirectFromConfig` lines 358–361. The legacy prefix matching is replaced by whole-segment keys.

```json
{
  "ministries": {
    "justice": "attorney-general",
    "technology-innovation-and-citizens-services": "citizens-services",
    "labour-citizens-services-and-open-government": "citizens-services",
    "energy-and-mines": "energy-mines-and-petroleum-resources",
    "natural-gas-development": "energy-mines-and-petroleum-resources",
    "environment": "environment-and-climate-change-strategy",
    "forests-lands-and-natural-resource-operations": "forests-lands-natural-resource-operations-and-rural-development",
    "forests-lands-natural-resource-operations-and-rural-development": "forests",
    "forests-lands-natural-resource-operations-and-rural-development/lands-and-natural-resource-operations": "land-water-and-resource-stewardship",
    "land-water-and-resource-stewardship": "water-land-and-resource-stewardship",
    "aboriginal-relations-and-reconciliation": "indigenous-relations-and-reconciliation",
    "jobs-tourism-and-skills-training": "jobs-trade-and-technology",
    "jobs-tourism-and-skills-training/minister-of-state-for-tourism-and-small-business": "tourism-arts-and-culture",
    "jobs-tourism-and-skills-training/state-small-business": "tourism-arts-and-culture",
    "international-trade": "trade",
    "trade": "jobs-and-economic-growth",
    "social-development-and-social-innovation": "social-development-and-poverty-reduction",
    "social-development-social-innovation": "social-development-and-poverty-reduction",
    "social-development-social-and-social-innovation": "social-development-and-poverty-reduction",
    "community-sport-and-cultural-development": "tourism-arts-and-culture",
    "education": "education-and-child-care",
    "education-and-child-care/child-care": "education-and-child-care",
    "child-care": "education-and-child-care",
    "agriculture-food-and-fisheries": "agriculture-and-food",
    "jobs-economic-recovery-and-innovation": "jobs-economic-development-and-innovation",
    "jobs-economic-recovery-and-innovation/trade": "jobs-economic-recovery-and-innovation",
    "jobs-economic-development-and-innovation": "jobs-and-economic-growth",
    "jobs-economic-development-and-innovation/trade": "jobs-and-economic-growth",
    "transportation-and-infrastructure/infrastructure": "transportation-and-infrastructure",
    "transportation-and-infrastructure/infrastructure-and-transit": "transportation-and-infrastructure",
    "infrastructure-and-transit": "transportation-and-infrastructure",
    "post-secondary-education-and-future-skills/workforce-development": "post-secondary-education-and-future-skills",
    "workforce-development": "post-secondary-education-and-future-skills",
    "advanced-education": "advanced-education-and-skills-training",
    "advanced-education-and-skills-training": "post-secondary-education-and-future-skills",
    "municipal-affairs": "housing-and-municipal-affairs",
    "mental-health-and-addictions": "health",
    "intergovernmental-relations-secretariat-1": "intergovernmental-relations-secretariat"
  },
  "sectors": { "families": "services" }
}
```

**Interfaces — Produces:**
- `loadRenames(json: unknown): { ministries: ReadonlyMap<string, string>; sectors: ReadonlyMap<string, string> }`
  - Values are closed transitively at load. Every value is a single segment.
  - It throws on a cycle, on a key or value that fails `CATEGORY_KEY` (a two-segment key checks each segment), or on a value that is itself a key after closure.
- `resolveCategory(outputDir: string, cat: CategoryKind, segments: string[]): Promise<{ key: string; consumed: 1 | 2; moved: boolean } | null>`. For ministries the order is:
  1. A two-segment rename `a/b` → its closed value, `consumed: 2`.
  2. Else, if `ministries/a/` has a page → `a`. If `ministries/a/` has no page and `a` is renamed → the closed value, `moved`.
  3. Nested: if `b` exists, is not a reserved word, and `ministries/b/` has a page → `b`, `consumed: 2`, `moved`. Reserved words are `biography`, `feed`, `atom`, `embed`, `more-news`, `morearticles`, `archive`, `releases`, `stories`, `factsheets`, `updates`, `top`, `feature`.
  4. `resolveMinistrySuccessor(outputDir, key)`. If it returns a key, use it and mark `moved`.
  5. If `ministries/<key>/` has no page → null.

  `news-subscribe` is an alias of `tags`. Sectors use only the sectors rename map. Keys are lowercased.
- **Category rule** in the middleware. It handles `/(ministries|sectors|themes|tags|news-subscribe)/<a>[/<b>][/rest]` and `/office-of-the-premier[/rest]` (read as `/ministries/office-of-the-premier[/rest]`). The rest after the consumed segments maps like this:

  | rest | target |
  |---|---|
  | `""`, `/` | `/<cat>/<key>/` |
  | `/biography[/]` (ministries) | `moved` ? `/<cat>/<key>/` : `/<cat>/<key>/biography/`. A missing bio page also gives `/<cat>/<key>/`. |
  | `/(releases\|stories\|factsheets\|updates)[/]` | `["/<cat>/<key>/<kind>/", "/<cat>/<key>/!"]` (plan 4 listing first) |
  | `/(more-news\|morearticles\|archive)…`, `/<kind>/(more-news\|morearticles\|archive)…` | `/<cat>/<key>/`, drop query |
  | `/feed…`, `/<kind>/feed…`, `/embed…` | untouched here (Task 8 handles feeds; embed falls through) |
  | anything else | `[pagePath("/<cat>/<key><rest>"), "/<cat>/<key>/!"]` |

  If the computed target path equals the request path, call `next()`. Otherwise answer 301, keeping the query except where the table drops it.

- [ ] **Step 1: Write the failing tests.** In the fixture, add pages for `attorney-general`, `forests`, `jobs-and-economic-growth`, `education-and-child-care`, `citizens-services`, `transportation-and-transit`, `office-of-the-premier` (plus `biography/`), `health/biography/` and `tags/x/`. Add `legacy/ministry-successors.json` with `{ "successors": { "transportation-and-infrastructure": "transportation-and-transit" } }`.

  `ministry-renames.test.ts`:
  - `it("closes chains: international-trade → jobs-and-economic-growth; forests-lands-and-natural-resource-operations → forests; advanced-education → post-secondary-education-and-future-skills")`
  - `it("no closed value is a key; a cycle throws; a bad key throws")`
  - `it("the committed JSON loads")`

  `legacy-urls.test.ts`:
  - `it("/ministries/justice → 301 /ministries/attorney-general/")`
  - `it("/ministries/justice/biography → 301 /ministries/attorney-general/")`
  - `it("/ministries/environmental-assessment-office is not caught by the 'environment' rename (segment-exact) → 404")`
  - `it("/ministries/environment → 404, no redirect (the chain ends at a key with no page; live 404 too)")`
  - `it("/ministries/transportation-and-infrastructure/infrastructure → 301 /ministries/transportation-and-transit/ (rename then successor, one hop)")`
  - `it("/ministries/jobs-economic-recovery-and-innovation/trade?x=1 → 301 /ministries/jobs-and-economic-growth/?x=1")`
  - `it("nested: /ministries/health/attorney-general → 301 /ministries/attorney-general/; /ministries/health/attorney-general/biography → 301 /ministries/attorney-general/biography/ if it exists, else /ministries/attorney-general/")`
  - `it("/office-of-the-premier → 301 /ministries/office-of-the-premier/; /office-of-the-premier/biography → 301 /ministries/office-of-the-premier/biography/; /ministries/office-of-the-premier/ → 200")`
  - `it("/ministries/health/factsheets → 301 /ministries/health/ until ministries/health/factsheets/index.html exists, then 301 /ministries/health/factsheets/")`
  - `it("/ministries/health/more-news?page=2 → 301 /ministries/health/ (query dropped)")`
  - `it("/news-subscribe/x → 301 /tags/x/; /sectors/families/ → 301 /sectors/services/")`
  - `it("/ministries/health/ → 200 (no redirect)")`

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run apps/stack/src/legacy apps/stack/src/ministry-successors.test.ts`.
- [ ] **Step 3: Implement.**
  - Move the old `/ministries/<old>` successor behaviour into `resolveCategory`. The plan-2 `/biography` rule is kept through `moved`.
  - Keep `ministrySuccessorRedirects` exported and mounted on the `/site` alias chain only. The `ministry-successors.test.ts` cases that go through `mountSite` must still pass, now via `legacyUrls`.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `npx vitest run apps/stack/src`. Expected: PASS.
- [ ] **Step 5: Check the table against live (P16).**
  - `tools/parity/ministry-renames-live.ts` sends HEAD `https://news.gov.bc.ca/ministries/<key>` for each **one-segment** key, 29 requests at 1 request per second with `throttledFetch()` from `url-check.ts`. It prints `key  status  location`.
  - Run it once, then record the output under a "Rename table vs live (date)" heading in `docs/parity/inputs/url-compat.md`.
  - Where live 302s somewhere the closed table does not: change the edge (live wins, P16) and add a test row.
  - Where live answers 404: keep the edge and record it. Our version only redirects when the target page exists, so a 404 stays a 404 unless the Hub has a successor.
  - Expected from the probes already run: `justice` and `jobs-economic-development-and-innovation` match.
- [ ] **Step 6: Add the rehearsal rows.** Under `# section: ministries`, add `/ministries/justice`, `/ministries/jobs-economic-development-and-innovation`, `/office-of-the-premier`, `/office-of-the-premier/biography`, `/ministries/office-of-the-premier`, `/ministries/health/more-news` and `/ministries/health/factsheets`.
- [ ] **Step 7: Commit.** Use `git commit -m "feat(stack): ministry rename table (segment-exact, closed) chained with successors; nested, Premier and category sub-paths (url-compat T4, L4)"`.

---

### Task 6: NEWS-n short links (url-compat T5)

**Files:**
- Modify: `apps/news-api/src/start.ts` (`AppHandle`), plus a test in `apps/news-api/src/posts.test.ts` (or the nearest existing `getPostByReference` test)
- Modify: `apps/stack/src/stack.ts` (pass `lookupReference` to `mountSite`)
- Modify: `apps/stack/src/legacy/middleware.ts`, `legacy-urls.test.ts`

**Interfaces:**
- Consumes: `getPostByReference(db, reference)` in `apps/news-api/src/posts.ts:100`. It covers published posts only and compares `lower(reference)`.
- Produces: `AppHandle.postKeyByReference(reference: string): Promise<string | null>`.
- **Reference rule:** a request for `/^\/(\d{1,9})\/?$/` does this:
  1. `key = await lookupReference("NEWS-" + n)`.
  2. If the key is null or fails `POST_KEY`, `next()`.
  3. Find the target: `pagePath("/releases/" + key + "/")`, or the long-key directory for a long key. Missing means `next()`.
  4. Answer 301 `/releases/<key>/` and keep the query.

  A throw is logged once per message (`[stack] reference lookup failed: …`) and then calls `next()`. Without `lookupReference`, the rule is off.

- [ ] **Step 1: Write the failing tests.**
  - `it("postKeyByReference('news-34336') finds the published post; an unpublished one → null")` (news-api)
  - `it("/34336 → 301 /releases/2026TT0103-001121/")`. Use a stub lookup and add that page to the fixture.
  - `it("/34336/ → same")`
  - `it("/99999 → 404")`
  - `it("a throwing lookup → 404, logged once across two requests")`
  - `it("/2026 with no reference → 404 (no clash with archive paths, which live under /archive/)")`
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run apps/stack/src/legacy apps/news-api/src/posts.test.ts`.
- [ ] **Step 3: Implement.** In `stack.ts`: `mountSite(app, { …, lookupReference: (r) => newsApi.postKeyByReference(r) })`.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `npx vitest run --project node`.
- [ ] **Step 5: Add the rehearsal row.** Under `# section: references`, add `/34336`. Live 302s it to `/releases/2026TT0103-001121`; on boxs.ca it needs that post imported [A].
- [ ] **Step 6: Commit.** Use `git commit -m "feat(stack,news-api): /<n> NEWS-n short links 301 to the post (url-compat T5)"`.

---

### Task 7: Atom feeds and per-kind feeds (url-compat T6a/b, M10 feeds)

**Files:**
- Modify: `apps/public-site/src/feeds.ts` and `feeds.test.ts`
- Modify: `apps/public-site/src/site-paths.ts` and `site-paths.test.ts`
- Modify: `apps/public-site/src/news-api-client.ts` and its test
- Modify: `apps/public-site/src/builder.ts` and `builder.test.ts`
- Modify: `apps/public-site/src/rebuild-set.ts` and its test
- Modify: `apps/public-site/src/rebuild.ts` (R10, batch C)

**Interfaces — Produces:**
- `renderAtomFeed(channel: { title: string; pagePath: string; feedPath: string; description: string }, posts: PostDto[], site: SiteInfo): string`
  - Atom 1.0: `<feed xmlns="http://www.w3.org/2005/Atom">`.
  - Feed-level elements: `<title>`; `<id>` = the absolute feed URL; `<updated>` = the newest item's publish instant in ISO UTC, or `1970-01-01T00:00:00Z` with no items; `<link rel="self" type="application/atom+xml">`; `<link rel="alternate" type="text/html">`; `<author><name>{site.name}</name></author>`.
  - One `<entry>` per post, up to `LATEST_COUNT`, with `<title>`, `<id>` and `<link href>` = the absolute post URL, `<updated>`, and `<summary>` when there is one.
  - Everything goes through `ex()`.
- `FEED_POST_KINDS = ["releases", "stories", "factsheets", "updates"] as const`
- `kindFeedFile(kind, format: "rss" | "atom"): string` → `feeds/<kind>.xml` or `feeds/<kind>.atom.xml`
- `pageFiles`:
  - home adds `"atom.xml"`;
  - a category adds `` `${kind}/${key}/atom.xml` ``, after `feed.xml` and before the biography file;
  - new `PageId { type: "kind-feeds" }`, id `"kind-feeds"`, with the eight `kindFeedFile` files.
- `NewsApiClient.latestOfKind(postKind: string, count: number): Promise<PostDto[]>` → `api/Posts/Latest/home/default?${v1}&postKind=<kind>&count=<n>`
- `dependentPages` always includes `"kind-feeds"`, and so does `aggregatePageIds`.
- **Builder:**
  - The home and category renders write the Atom file beside the RSS file from the same post list.
  - `kind-feeds` writes, for each kind, `sortNewest([...[home.top, home.feature].filter(p => p?.kind === kind), ...latestOfKind(kind, LATEST_COUNT)])` in both formats. The extra posts are there because the News API's latest list leaves out the home top and feature posts.

- [ ] **Step 1: Write the failing tests.**
  - `it("Atom: one entry per post, ids and links absolute under a /site base, updated = newest instant in UTC")`
  - `it("Atom: a headline with & < \" and a U+0001 control char stays well-formed XML")`. Parse it with jsdom's `DOMParser` (`application/xml`) and expect no `parsererror`.
  - `it("Atom with no posts has updated 1970-01-01T00:00:00Z and an author")`
  - `it("pageFiles(kind-feeds) is the eight feeds/* files; parsePageId('kind-feeds') round-trips")`
  - `it("a post change re-queues kind-feeds")`
  - `it("the factsheets feed holds only factsheets and includes a factsheet that is the home top post")`
  - `it("a ministry render writes ministries/<k>/atom.xml")`
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run apps/public-site/src`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `npx vitest run --project node` and `npm run site:quality`.
- [ ] **Step 5: Commit.** Use `git commit -m "feat(public-site): Atom beside every RSS feed, and per-kind feeds (url-compat T6, M10)"`.

---

### Task 8: Legacy feed URLs served in place (url-compat T6, §1c)

**Files:**
- Modify: `apps/stack/src/legacy/rules.ts`, `middleware.ts`, `fixture.ts`, `legacy-urls.test.ts`
- Modify: `tools/parity/legacy-urls.txt`

**Interfaces:**
- Consumes: `kindFeedFile` and `FEED_POST_KINDS` (Task 7), and `resolveCategory` (Task 5).
- **Feed rules.** All of them serve in place. `fmt` is `rss` when absent. Any query (for example `?newsOnDemand=1`) is ignored.

  | Request (any case, optional trailing slash) | File |
  |---|---|
  | `/feed`, `/feed/rss`, `/rss.xml`, `/(top\|feature)/<any>[/rss]` | `feed.xml` |
  | `/feed/atom`, `/(top\|feature)/<any>/atom` | `atom.xml` |
  | `/<kind>/feed[/rss\|/atom]` | `kindFeedFile(kind, fmt)` |
  | `/<cat>/<a>[/<b>][/<kind>]/feed[/rss\|/atom]`, `/office-of-the-premier[/<kind>]/feed[/…]` | `<cat>/<resolved key>/feed.xml` or `atom.xml`. Renames and successors apply, and there is no redirect. |

  RSS is served as `application/rss+xml; charset=utf-8` and Atom as `application/atom+xml; charset=utf-8`. A missing file means `next()`, which gives a 404.

- [ ] **Step 1: Write the failing tests.** In the fixture, add `atom.xml`, `feeds/factsheets.xml`, `feeds/factsheets.atom.xml`, `ministries/health/feed.xml`, `ministries/attorney-general/feed.xml` and `atom.xml`.
  - `it("/feed → 200 application/rss+xml, body = feed.xml")`
  - `it("/feed/rss → 200 (legacy answered 500)")`
  - `it("/feed/atom → 200 application/atom+xml")`
  - `it("/factsheets/feed and /factsheets/feed/atom → 200 from feeds/")`
  - `it("/ministries/health/releases/feed → 200 serving ministries/health/feed.xml")`
  - `it("/ministries/justice/feed/atom → 200 serving ministries/attorney-general/atom.xml, no redirect")`
  - `it("/office-of-the-premier/feed → 200 if ministries/office-of-the-premier/feed.xml exists")`
  - `it("/top/feed → 200 feed.xml")`
  - `it("/feed?newsOnDemand=1 → 200")`
  - `it("HEAD /feed → 200 with the RSS content type")`
  - `it("/ministries/nope/feed → 404")`
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run apps/stack/src/legacy`.
- [ ] **Step 3: Implement.** The feed rules run before the category rule.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `npx vitest run apps/stack/src`.
- [ ] **Step 5: Add the rehearsal rows.** Under `# section: feeds`, add `/feed`, `/feed/atom`, `/releases/feed`, `/factsheets/feed`, `/top/feed`, `/ministries/health/feed`, `/ministries/health/feed/atom` and `/ministries/health/factsheets/feed/atom`.
- [ ] **Step 6: Commit.** Use `git commit -m "feat(stack): legacy feed URLs served in place with legacy content types (url-compat T6)"`.

---

### Task 9: NoD accepts legacy manage tokens (url-compat T7, P10)

**Files:**
- Create: `apps/nod/src/subscribe/legacy-token.ts`, `legacy-token.test.ts`
- Modify: `apps/nod/src/subscribe/links.ts` (`findLink`) and `links.test.ts`
- Test: `apps/nod/src/http/subscribe-routes.test.ts`

**Interfaces — Produces:**
- `legacyLinkGuid(token: string): string | null`. It returns the lowercase hyphenated GUID, or null. It never throws.
  - **(a) The UrlTokenEncode form** `^[A-Za-z0-9_-]{22}2$`: map `-` → `+` and `_` → `/`, pad with `==`, then base64-decode to 16 bytes. Lay the bytes out as .NET `new Guid(byte[])` does: bytes 0–3, 4–5 and 6–7 are little-endian, and bytes 8–15 are in order.
  - **(b)** A bare GUID `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`, as carried by `subscribe.aspx?guid=`.
- `legacyTokenHash(linkGuid: string): string` = `hashToken("legacy:" + linkGuid)`
- `findLink(db, token)`:
  - unchanged for a 43-character token;
  - otherwise `g = legacyLinkGuid(token)`. If g is null, return null. If not, look up `tokenHash = legacyTokenHash(g)`.

  `confirm`, `update`, `checkToken` and `unsubscribe` all reach legacy links through `findLink`, so none of them changes.

- [ ] **Step 1: Write the failing tests.**
  - `it("decodes the .NET vector: MyIRAFVEd2aImaq7zN3u_w2 → 00112233-4455-6677-8899-aabbccddeeff")`. Bytes `33 22 11 00 55 44 77 66 88 99 aa bb cc dd ee ff`, computed with Node `Buffer.from(…,"hex").toString("base64")`.
  - `it("accepts a bare GUID in any case and lowercases it")`
  - `it.each(["", "abc", "MyIRAFVEd2aImaq7zN3u_w1", "MyIRAFVEd2aImaq7zN3u_w", "!!!!!!!!!!!!!!!!!!!!!!2", "x".repeat(5000)])("returns null for %j without throwing")`
  - `it("findLink resolves a seeded legacy row by either encoding, and reports expired when expires_at <= now()")`
  - HTTP: `it("GET /ConfirmUpdateCreateSubscription/MyIRAFVEd2aImaq7zN3u_w2 returns the subscriber's info for a seeded live legacy link; an unknown legacy token → the same 'invalid' answer as an unknown 43-char token")`
  - HTTP: `it("GET /UnsubscribeSubscriber/<bare guid> ends the subscription for a seeded legacy link")`
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run apps/nod/src/subscribe apps/nod/src/http/subscribe-routes.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Same command, then `npx vitest run --project node`.
- [ ] **Step 5: Commit.** Use `git commit -m "feat(nod): accept legacy manage tokens (UrlTokenEncoded or bare LinkGuid) for imported links (url-compat T7, P10)"`.

---

### Task 10: `nod:import` copies unexpired legacy manage links (url-compat T7)

**Files:**
- Modify: `apps/nod/src/import/queries.ts` (new query, added to `ALL_QUERIES`) and `queries.test.ts`
- Create: `apps/nod/src/import/links.ts`
- Modify: `apps/nod/src/import/run.ts` (a new stage `"links"` after `"subscribers"`) and `run.test.ts`
- Modify: `apps/nod/test/legacy-nod-fixture.ts`

**Interfaces:**
- Consumes: `legacyTokenHash` (Task 9), `guidKey` (`import/map.ts`), `wallClockToInstant` (`@gcpe/config`, used the way `map.ts:152` uses it), and the `subscriberLinks` schema.
- Produces:
  - `Q_LIVE_MANAGE_LINKS`:

    ```sql
    -- name: liveManageLinks
    SELECT LinkGuid, SubscriberGuid, ExpiryDate FROM dbo.SubscriberLink
     WHERE SubscriberGuid IS NOT NULL AND ExpiryDate > GETDATE()
    ```

    It never reads `SubscriberInfo`, which keeps the queries.ts header promise.
  - `importManageLinks(db: Db, source: LegacySource, ctx: { report: NodImportReport; timeZone: string; runAt: Date }): Promise<void>`. For each row:
    - Skip it with reason "subscriber not in NoD" when `subscribers.id = guidKey(SubscriberGuid)` is absent.
    - Skip it with "subscriber ended" when that subscriber's status is ended.
    - Skip it with "expired" when `wallClockToInstant(ExpiryDate, tz) <= runAt`.
    - Otherwise insert `{ tokenHash: legacyTokenHash(guidKey(LinkGuid)), purpose: "manage", origin: "send", email: <the NoD subscriber's email>, subscriberId, expiresAt }`, with `ON CONFLICT (token_hash) DO NOTHING`.
    - Report table `"SubscriberLink"`: legacy, imported and skipped counts. No address appears in the report.

- [ ] **Step 1: Write the failing tests.**
  - Fixture: add four `liveManageLinks` rows: an active subscriber (LinkGuid `00112233-4455-6677-8899-aabbccddeeff`), an ended subscriber, an unknown SubscriberGuid, and one with a past ExpiryDate.
  - `it("imports the active subscriber's link; skips ended, unknown and expired with those reasons; balanced report")`
  - `it("after import, the NoD route ConfirmUpdateCreateSubscription/MyIRAFVEd2aImaq7zN3u_w2 answers with that subscriber")`
  - `it("a second run imports nothing new and leaves the row unchanged")`
  - `it("the report and logs carry no address")` (extend the existing CLI test)
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run apps/nod/src/import`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `npx vitest run --project node`.
- [ ] **Step 5: Commit.** Use `git commit -m "feat(nod): nod:import copies legacy manage links still unexpired, so recent emails' links resolve (url-compat T7, P10)"`.

boxs.ca has no legacy NoD source, so batch D is verified by these tests only. Task 12's runbook makes the final `nod:import`, run after legacy sending stops, a cutover step.

---

### Task 11: Rehearsal tooling — curated and generated legacy URL lists (url-compat T10)

**Files:**
- Modify: `tools/parity/url-check.ts` and `url-check.test.ts`
- Create: `tools/parity/legacy-url-list.ts`, `legacy-url-list.test.ts`
- Create: `tools/parity/legacy-urls.generated.txt` (a committed snapshot)
- Create: `tools/parity/legacy-urls-pending.txt`
- Modify: `package.json` (script `"parity:urls:list": "tsx tools/parity/legacy-url-list.ts"`)

**Interfaces — Produces:**
- `parseList(text): { path: string; section: string }[]`. A `# section: <name>` line sets the section for the lines after it; the default is `"default"`.
- `checkUrls(base, entries, fetchImpl?, timeoutMs?)` keeps its semantics: 2xx passes, and so does one redirect to a 2xx page or to another host. A chain, a 4xx/5xx, or a redirect without a Location fails. Each `UrlResult` gains `section`.
- `main` prints a pass count per section and exits 1 on any failure.
- `throttledFetch(minGapMs = 1000, otherHostGapMs = 200)` adds the gap for hosts other than news.gov.bc.ca.
- `buildLegacyUrlList(fetchText: (path: string) => Promise<string>, opts: { posts: number }): Promise<string[]>`. It uses at most 4 live GETs at 1 request per second:
  - `/` gives every `/ministries/<k>`, `/sectors/<k>` and `/tags/<k>` href, plus the nav links;
  - `/connect` gives every feed href;
  - `/sitemap/html?count=<posts>` gives `/releases/<key>` for the latest posts.
  - For the first 10 posts it also adds `/stories/<key>` and the lowercased `/releases/<key>`.

  Output is de-duplicated, path-only (from news.gov.bc.ca hrefs only; any other host is dropped), and grouped into sections `nav`, `feeds`, `posts` and `post-variants`. Hrefs are parsed with a regex over `href="…"`, and the HTML is never executed.

- [ ] **Step 1: Write the failing tests.**
  - `it("parseList assigns sections")`
  - `it("a result carries its section; main's summary counts per section")`
  - `it("buildLegacyUrlList keeps only news.gov.bc.ca paths, dedupes, and drops javascript: and mailto: hrefs")`. Use canned HTML.
  - `it("buildLegacyUrlList makes at most 4 fetches")`
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run tools/parity`.
- [ ] **Step 3: Implement.** Generate the snapshot with `npm run parity:urls:list -- --posts 150 > tools/parity/legacy-urls.generated.txt`. That is 3–4 live requests. Its header comment names the date and the sources.
- [ ] **Step 4: Fill the pending list.** `legacy-urls-pending.txt` lists the plan-4 pages that 404 until plan 4 ships: `/contacts`, `/privacy`, `/live`. Plan 4 moves them into `legacy-urls.txt`.
- [ ] **Step 5: Validate the curated list against live once.** Run `npm run parity:urls -- --base https://news.gov.bc.ca --list tools/parity/legacy-urls.txt`. That is at most 40 rows. Remove any row live doesn't answer 2xx/3xx, because it is not a URL that "works today". Note it in the commit message.
- [ ] **Step 6: Run the tests and confirm they pass.** Run `npx vitest run tools/parity`.
- [ ] **Step 7: Commit.** Use `git commit -m "feat(parity): sectioned URL rehearsal, live-derived legacy URL list (url-compat T10)"`.

---

### Task 12: Cutover runbook, decision records and the plan-3 gate

**Files:**
- Create: `docs/parity/url-cutover-runbook.md`
- Modify: `docs/parity/changes-from-legacy.md`, `docs/parity/inputs/url-compat.md`, `docs/parity/inputs/gap-audit.md`

- [ ] **Step 1: Write the runbook.** It holds:
  1. **Rehearsal.** The three list runs against boxs.ca and how to read failures by section. The `posts`, `post-variants` and `references` rows depend on the post being imported on that host [A].
  2. **T9 evidence the owner must supply,** each with what it changes:
     - (a) 90 days of IIS/Kestrel logs (`RedirectMiddleware` logs `METHOD url` per request). Rank the paths and run the top 500 through `parity:urls`.
     - (b) the production `RedirectMiddleware`, since the repo is behind (P16).
     - (c) posts with `RedirectUri` (a count). This plan does not redirect them.
     - (d) the production key lists.
     - (e) the production `AuthenticationTimeout`, and whether the bulk-email "Manage your subscription" link carries a token. Both are templates in the DB `Template`/`Site` tables.
     - (f) the legacy `/files` store and whether it is publicly readable.
     - (g) the DNS plan for `www.news.`, `newsroom.` and `enewsletters.`.
  3. **Cutover-day order.**
     - Stop legacy NoD sending.
     - Run the final `npm run nod:import`. That copies the last day's live manage links (Task 10).
     - Set `PUBLIC_SITE_URL` to the origin.
     - Set `SITE_GOOGLE_*`.
     - Switch DNS.
     - Run the rehearsal against `https://news.gov.bc.ca` with the generated list.
  4. **T8, the other hosts.** Not built. If DNS moves:
     - `www.news.gov.bc.ca` needs a 301 to the apex: a small host check placed ahead of `legacyUrls`.
     - `newsroom.gov.bc.ca` needs `RedirectFromNewsroom`, including `/subscribe.aspx?guid=`, which Task 1 already handles on the main host.
- [ ] **Step 2: Add the decision records.** Add `changes-from-legacy.md` rows from the next free C-number, Status "Proposed":
  1. 301 instead of legacy 302.
  2. A trailing slash is canonical, the reverse of legacy.
  3. Wrong-case URLs get a 301 to canonical; legacy served 200 in any case. On Windows/NTFS a wrong-case category path may still serve 200.
  4. `/releases/<key>/image` is a 302 to the default OG image.
  5. `/embed…` is 404; legacy is 410.
  6. `/sitemap/html` goes to `/archive/`.
  7. Kind and category index fallbacks go to `/` until plan 4.
  8. robots keeps `/assets` crawlable (ours holds CSS and fonts).
  9. `/feed/rss` is 200 (legacy 500).
  10. Legacy manage tokens resolve only while unexpired, as in legacy.
  11. A rename never redirects to a page that does not exist.
- [ ] **Step 3: Update the evidence docs.**
  - In `url-compat.md`, mark T1–T7 and T10 done with commit SHAs and record the live rename check (Task 5).
  - In `gap-audit.md`, mark M17, L4 and M10 (feeds) addressed.
- [ ] **Step 4: Gate.** After deploying batch E:
  - `npm run parity:urls -- --base https://boxs.ca`: expect 100%.
  - `npm run parity:urls -- --base https://boxs.ca --list tools/parity/legacy-urls.generated.txt`: expect 100%, except `posts`/`post-variants` rows for posts boxs.ca doesn't hold. List those in the runbook with the reason.
  - Any other failure becomes a named fix task before plan 4.
- [ ] **Step 5: Commit.** Use `git commit -m "docs(parity): URL cutover runbook, plan-3 deliberate differences, url-compat status"`.

---

## Spec conflicts found and how this plan resolves them

1. **P10: "import legacy subscriber tokens so links resolve".** The tokens are 24-hour `SubscriberLink.LinkGuid` rows, not per-subscriber GUIDs. Legacy itself sends an expired link to `/subscribe`. **Resolved:**
   - Import the links that are still unexpired at the final import (Task 10).
   - Accept both encodings (Task 9).
   - Older links land on our "request a new link" page, which matches legacy.
   - The production timeout is an owner question.
2. **url-compat T1 ports every robots Disallow, including `/assets`.** Our `/assets` holds CSS and fonts, and blocking it hurts how search engines render the page. **Resolved [call]:** port everything except `/assets`.
3. **url-compat T1 says "copy the Search Console file", but P15 makes the Search Console token operator-owned.** **Resolved:** two operator env vars, with nothing committed in the site output. boxs.ca sets them so the rehearsal covers the path.
4. **url-compat T5 proposes a builder-written `refs.json`.** **Resolved:** an in-process News API lookup on the indexed `lower(reference)`. There is no 30k-entry file to keep fresh.
5. **url-compat T6 bundles pages:** kind indexes, `/privacy`, `/contacts`, `/live`, the `/archive/{yyyy}` page, `/embed` and `/image`. Spec §5 puts pages in plan 4. **Resolved:**
   - feeds only here;
   - fallback redirects that step aside once plan 4's pages exist (static wins);
   - `/embed` stays 404, since live is 410;
   - `/image` is a 302 placeholder.
6. **url-compat T4 and P16:** the closed rename chains end at keys that 404 on live today (`environment-and-climate-change-strategy`, `transportation-and-infrastructure`). **Resolved:** chain renames into the Hub's successor table, and never redirect to a page that does not exist. Task 5 Step 5 records the live comparison.
7. **Spec §4 C lists "/tags/ vs /news-subscribe/ (L4)".** Legacy canonicalises to `/news-subscribe/<k>`. **Resolved:** ours stays `/tags/<k>/`, and `/news-subscribe/<k>` gets a 301 to it.
8. **url-compat §1f `/files/*`** (legacy release attachments, possibly hundreds of thousands) is not in spec §4 C, and it is not in this plan. It is cutover-blocking if imported posts link there. It is raised as an owner question (Q13, `nrms:import-files` still pending).
9. **The `/ministries/{key}/biography` row in url-compat.** Plan 2 serves it. Here `/office-of-the-premier/biography` and `/ministries/<parent>/<key>/biography` map to it, and an old ministry's bio goes to the successor's ministry page (plan 2's rule, kept).

## Owner questions

1. **Manage links.** What is production NoD's `AuthenticationTimeout`? Does the bulk-email "Manage your subscription" link carry a per-subscriber token? Both live in the DB templates. The answers set how many old-email links Task 10 can save.
2. **`/files/*`.** Is the legacy files store (Azure `files` container or the UNC share) publicly readable? If it is, a fallback 302 for an unknown `/files/<path>` is trivial. If not, an import (Q13) must land before DNS moves.
3. **DNS for `www.news.gov.bc.ca`, `newsroom.gov.bc.ca` and `enewsletters.gov.bc.ca` (T8).** Old NoD templates link `newsroom.gov.bc.ca/subscribe.aspx?guid=…`.
4. **T9 evidence:** access logs, the production redirect source, the `RedirectUri` post count and the key lists (runbook §2).
5. **Old ministries with no page and no successor** (for example `environment-and-climate-change-strategy`, 404 on live today). Should the Hub give them successor records, so their links land somewhere instead of the 404?
6. **robots `/files`.** Keep legacy's Disallow, as planned, or let release PDFs be indexed?
