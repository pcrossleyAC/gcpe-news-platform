# URL compatibility: news.gov.bc.ca legacy -> platform public site

Scope: every URL that works on https://news.gov.bc.ca today must keep working after cutover (serve the equivalent page, or 301 to it). This reverses C202 (no legacy redirects, monthly archives instead of numbered pages) and C206 (every post under /releases/<key>/) in `docs/parity/changes-from-legacy.md` (both verified present, lines 274 and 278).

Labels: **[V]** verified (read in source or observed live with curl on 2026-10-27/28), **[I]** inferred (reasoning shown), **[A]** assumed/unchecked (check named).

Sources read: `/Users/paul/News-Hub/gcpe-news-webapp/Gov.News.WebApp/{RouteConfig.cs, Middleware/RedirectMiddlewarecs.cs, Startup.cs, web.config, Controllers/*, Views/Default/SitemapView.cshtml, wwwroot/}`; platform `apps/public-site/src/{site-paths.ts, static-pages.ts, subscribe-pages.ts, pages/search.ts, feeds.ts}`, `apps/stack/src/stack.ts`, `deploy/windows/Install-Gcpe.ps1`. Live probes: 40 requests, HEAD (`curl -A "curl/8.7.1" -I`), 1 req/s, except one GET each of `/` and `/robots.txt`.

## 0. Headline findings (read these first)

1. **One implementation covers both hosts.** On Windows, IIS only forwards everything to the Node stack (`web.config` has two rules: https redirect, rewrite to 127.0.0.1:port) [V: Install-Gcpe.ps1 lines 302-326]. So a single Express middleware in `apps/stack`, mounted at the site root before the static mount, serves SiteGround and Windows identically. IIS `web.config` rewrite rules are optional (only worth it for the few trivial prefix rules, and then they must be kept in sync). Recommended: Node only.
2. **Mount point.** The stack serves the site at `/site` (`app.use("/site", ... express.static(outputDir))`) [V: stack.ts:345]; nothing mounts it at `/`. Cutover needs a root mount and `PUBLIC_SITE_URL=https://news.gov.bc.ca` (no path, so `basePath()` = "") [V: render.ts basePath; bc.json publicSiteBaseUrl is already https://news.gov.bc.ca]. This is a prerequisite for everything below [I: no root mount found by grep of stack.ts; confirm nothing in main.ts does it].
3. **Legacy canonical form has NO trailing slash and is case-insensitive; ours is directory style with trailing slash and case-sensitive on SiteGround (Linux).** Live: `/releases/2026TT0105-001130` 200; `/releases/2026tt0105-001130` 200; `/Releases/2026TT0105-001130` 200; `/releases/2026TT0105-001130/` 302 -> lowercased no-slash [V live]. Legacy middleware 302-redirects any trailing-slash path to the slash-less one, lowercasing it, and uses 302 not 301 (`context.Response.Redirect(..., false)`) [V: RedirectMiddlewarecs.cs]. Slash-less to slash is free via express.static's directory redirect (301) [I from stack.ts comment lines 333-337]. Case-insensitive lookup is NOT free on Linux: needs a lowercase->actual-key resolver (task T2). IIS on NTFS is case-insensitive for static files but the Node static mount underneath is what serves, so same issue [I].
4. **The repo copy of the legacy app is older than production.** Live home page links ministries that no rule or redirect in the repo knows: `transportation-and-transit`, `tourism-arts-culture-and-sport`, `mining-and-critical-minerals`, `environment-and-parks`, `energy-and-climate-solutions`, `infrastructure` [V live home HTML]; the repo's rename table ends at `transportation-and-infrastructure`, `housing-and-municipal-affairs`, etc. Also live `/archive/2026/10` 302s to `/Search?daterange=2026-10-01..2026-10-31` and `/releases/more-news` to `/Search?content=releases` [V live], which the repo's routes alone do not show. Consequence: the redirect table below is a floor, not the complete list. Task T9 gets the real, current list (ask the owner for the production build's source/branch, or diff against live behaviour using the ministry list from the News API).
5. **Legacy subscription tokens will not work against NoD as-is.** Legacy manage link target is `GET /subscribe/manage?token=<t>` where `<t>` is a URL-token-encoded GUID (`UrlTokenDecode`: base64 with '-'/'_' and a trailing pad-count digit) [V: SubscribeController.cs:117,169-200]. Platform NoD expects its own 43-char base64url link tokens or `<uuid>.<version>.<mac>` unsubscribe tokens; `findLink` looks the token up in its own table [V: recipient-links.ts:21-27, journeys.ts:136]. Import-GcpeLegacy.ps1 has no mention of tokens/GUIDs [V grep]. So an old email's link will currently show "This link isn't valid. Request a new one below." [V: subscribe-pages.ts:~109]. That is a graceful failure, not a break, but it is not "keeps working". Needs an owner decision (section 4, T7).
6. **Post keys longer than 100 chars** exist in legacy and are skipped by us (`POST_KEY = /^[A-Za-z0-9-]{1,100}$/`) [V: site-paths.ts:4]. Count is unknown [A]. Proposed fix: serve the same URL from a hashed directory (T3).

## 1. Legacy URL inventory and proposed handling

Notation: "ours" = path under the site root after cutover. "Static" = could be produced as files by the builder; "Node" = needs the middleware (works on both SiteGround and IIS because IIS forwards to Node). **Rule of thumb used:** pages -> 301 to our equivalent; feeds, images, files and embeds -> serve in place (rewrite, 200), because RSS readers, hotlinked images and `<iframe>`s follow redirects unreliably.

### 1a. Posts

| Legacy pattern | Example (live status) | Shows | Ours today | Proposed handling | Layer |
|---|---|---|---|---|---|
| `/releases/{key}` | `/releases/2026TT0105-001130` 200 [V] | news release | `/releases/{key}/` (exact-case key, <=100 chars) | Serve; slash-less -> 301 slash (express.static). Add case-insensitive resolver and long-key mapping | Node (T2,T3) |
| `/stories/{key}`, `/factsheets/{key}`, `/updates/{key}` | `/stories/2026TT0105-001130` 200 [V] (kind-agnostic: same post served under wrong kind) | same post | none; all posts at `/releases/` (C206) | 301 -> `/releases/{key}/` (keys unique across kinds per C206 [A: confirm no key collides across kinds]) | Node (T1) |
| `/{kind}/{key}/` trailing slash | `/releases/2026TT...001130/` 302 -> lowercase [V] | same | `/releases/{key}/` | Serve (we are slash-style); just resolve case | Node |
| `/{kind}/{key}/image` | `/releases/2026TT0105-001130/image` 200 image/jpeg [V] | post's lead image (used for og:image / cards) | none | Serve in place if the builder has a stored image, else 301 to the image's file URL. Needs check whether PostDto exposes the image [A] | Node + data (T6) |
| `/{digits}` NEWS reference | `/1234` 404 [V, number likely unused]; route `{reference}`=`\d+` -> `GetKeyFromReferenceAsync("NEWS-n")` -> redirect [V: DefaultController.cs:38-47] | short link to a post | none | 301 -> `/releases/{key}/`. Needs reference->key map (generated from News API/NRMS reference column at build time, written to a JSON file read by the middleware). Whether the platform stores NEWS-<n> references is [A]: check NRMS schema | Node + data (T5) |
| Old newsroom `/{yyyy}/{mm}/{key}.html`, `/ministries/{m}/factsheets/{key}.html` | only reachable via host newsroom.gov.bc.ca in code [V RedirectFromNewsroom] | post | none | Only if newsroom.gov.bc.ca DNS also lands on us (section 3). 301 -> `/releases/{key}/` | Node (T8) |
| Translations / language variants | no separate URL: post page carries `#translationList` [V live home: `.../releases/2026HLTH0085-001117#translationList`]; files at `/files/...` | translations of a post | translations attached to the release page | Nothing to map. The language files must remain at their legacy `/files/` URLs (1f) | - |
| Post `RedirectUri` (PostsController.Details) | per-post | post whose record carries a redirect target | none | Needs data: posts with RedirectUri are an inventory item (T9 query). 301 to target | Node + data |

### 1b. Home, kind indexes, archive

| Legacy pattern | Example | Shows | Ours | Handling | Layer |
|---|---|---|---|---|---|
| `/` | 200 [V] | home | `/` | serve | static |
| `/releases`, `/stories`, `/factsheets`, `/updates` | all 200 [V] | latest of a kind | none (kind-less) | 301 -> `/` for all four except note `/factsheets` is linked from the live nav [V]; if our posts carry a kind, new kind index pages are better (T6) | Node |
| `/{kind}/more-news`, `/{kind}/archive`, `/more-news`, `/{kind}/morearticles` (AJAX) | `/releases/archive` 302 -> `/Search?content=releases` [V] | pagination/archive | `/archive/` | 301 -> `/archive/` (content= filter has no equivalent) | Node |
| `/archive` | 302 -> `/Search` [V live] | archive | `/archive/` | serve our `/archive/` (slash-less -> 301) | static |
| `/archive/{yyyy}` | 302 -> `/Search?daterange=2026-01-01..2026-12-31` [V] | year | none | 301 -> `/archive/` (we have no year page; alternative: add one, T6) | Node |
| `/archive/{yyyy}/{mm}` (constraint `\d{4}` / `(\d{2})?`) | 302 -> `/Search?daterange=2026-10-01..2026-10-31` [V] | month | `/archive/{yyyy}/{mm}/` [V site-paths.ts] | serve (slash-less -> 301 slash). Months in legacy not yet built: 404 -> see T9 | static |
| `/{kind}/archive/{yyyy}/{mm}` and `/ministries/{key}/archive/{yyyy}/{mm}` (also sectors, tags, themes) | `/ministries/health/archive/2026/10` 302 -> `/Search?ministry=health&daterange=...` [V] | month for a category | none (archive is global) | 301 -> `/search/?ministry={key}` for ministries/sectors (our search supports `ministry`, `sector`) [V search.ts:20-24]; for tags/themes -> `/{kind}/{key}/` | Node |
| `/{category}/{key}/more-news` | `/ministries/health/more-news` 302 -> `/Search?ministry=health` [V] | pagination | `/ministries/{key}/` | 301 -> `/ministries/{key}/` (or `/search/?ministry=`, same as legacy) | Node |
| `/sitemap/html` | 200 HTML list of post links [V] | HTML sitemap (`?count=&skip=`) | none (we have `/sitemap.xml`, `/sitemaps/*.xml`) | 301 -> `/archive/` (human link list) | Node |
| `/sitemap.xml` | 404 on legacy [V] | n/a | `/sitemap.xml` | nothing to preserve; keep ours | static |

### 1c. Categories (ministries, sectors, themes, tags), feeds

| Legacy pattern | Example | Shows | Ours | Handling | Layer |
|---|---|---|---|---|---|
| `/ministries` | 200 [V] | ministry list | `/ministries/` | serve | static |
| `/ministries/{key}` | `/ministries/health` 200; with slash 302 -> no slash [V] | ministry page | `/ministries/{key}/` | serve; lowercase redirect for uppercase | static + Node |
| `/ministries/{parent}/{key}` (nested; route allows `parentKey`) | pattern only [V RouteConfig] | child org | `/ministries/{key}/` only (flat; CATEGORY_KEY has no slash) | 301 -> `/ministries/{key}/` if key exists, else parent. Needs check that nested keys exist in the API [A] | Node (T4) |
| `/ministries/{key}/{kind}` and `/{category}/{key}/{kind}` | pattern only | posts of kind in category | none | 301 -> `/ministries/{key}/` | Node |
| `/ministries/{key}/biography`, `/{premier}/biography` | `/ministries/health/biography` 200 [V] | minister bio | **served in plan 2** at `/ministries/{key}/biography/` (3881b34; old ministries redirect to the successor's ministry page, 53b4f9c) | serve `/ministries/{key}/biography/` (plan 2); plan 3 maps `/office-of-the-premier/biography` there and `/ministries/{parent}/{key}/biography` to the child's page. Replaces "301 to the ministry page". | Node (plan 3) |
| `/office-of-the-premier[/{kind}]` | linked from live nav [V] | premier's page (special route, `key=office-of-the-premier`) | `/ministries/office-of-the-premier/` [I: key exists in our ministries if API lists it as ministry] | 301 -> `/ministries/office-of-the-premier/` (or serve in place; legacy canonical is `/office-of-the-premier`) | Node |
| `/office-of-the-premier/speeches[/...]`, `/tags/speeches[/...]` | special route; middleware rewrites `/tags/speeches*` -> `/office-of-the-premier/*` [V] | speeches tag | `/tags/speeches/` | 301 -> `/tags/speeches/` | Node |
| `/ministries/office-of-the-premier[/...]` | middleware 302 -> `/office-of-the-premier...` [V] | legacy old path | | same target as above | Node |
| `/sectors`, `/sectors/{key}`, `/themes/{key}` | `/sectors` has no index route (falls to 404 unless via redirect); `/sectors/{key}` via Categories controller [V RouteConfig] | | `/sectors/{key}/`, `/themes/{key}/` | serve; `/sectors` -> 301 `/ministries/` or `/`. Rule `/sectors/families*` -> `/sectors/services*` [V] | static + Node |
| `/tags/{key}` | middleware 302 `/tags/...` -> `/news-subscribe/...` [V]; `news-subscribe` is a category constraint [V] | tag page | `/tags/{key}/` | serve `/tags/{key}/`; `/news-subscribe/{key}` -> 301 `/tags/{key}/` [A: that news-subscribe is an alias of tags; verify via one live GET] | Node |
| Renamed ministries | e.g. `/ministries/justice` -> `/ministries/attorney-general` [V code] | | | Data-driven rename table (~50 entries in RedirectMiddleware, two places: `redirectMappings` in `RedirectFromNewsroom` and the `path.StartsWith` chain in `Redirect`). Resolve chains to the FINAL name in one hop (e.g. `jobs-economic-recovery-and-innovation` -> `jobs-economic-development-and-innovation` -> `jobs-and-economic-growth`; `forests-lands-...` -> `forests`). Apply to category pages and to their sub-paths/feeds. Table is incomplete vs production, see 0.4 | Node (T4) |
| Feeds: `/feed` | 200 `application/rss+xml` [V]; `/feed/atom` 200 `application/atom+xml` [V]; `/feed/rss` 500 [V, bug, do not replicate] | all-news feed | `/feed.xml` (RSS 2.0 only) [V feeds.ts/site-paths] | Serve `/feed` and `/feed/rss` in place from `feed.xml` (readers keep their subscription, no format change); `/feed/atom` needs an Atom renderer (T6) or falls back to RSS body with correct content-type (readers generally sniff RSS) | Node + builder |
| `/{kind}/feed[/rss|atom]` | `/releases/feed` 200 rss [V] | feed of a kind | none | New per-kind feed if posts carry a kind (T6); else serve `/feed.xml` | Node |
| `/{category}/{key}/feed[/atom]`, `/{category}/{key}/{kind}/feed` | `/ministries/health/feed` 200, `/ministries/health/releases/feed` 200 [V] | category feed | `/ministries/{key}/feed.xml`, same for sectors/themes/tags [V] | serve in place from `{kind}/{key}/feed.xml`; ignore kind segment; apply rename table | Node |
| `/embed`, `/{...}/embed[/rss|atom]`, `/top/{type}`, `/feature/{type}`, `/categorytop|categoryfeature/...` (`Feed|Embed|Top|Feature` constraint) | route-only [V RouteConfig]; not probed | embeddable feed HTML / "top" and "featured" feeds | none | Needs owner decision: who embeds these? Cheapest: serve `/embed` as a minimal static list HTML (T6) or 301 to the feed. Do not invest until usage is confirmed from IIS/Kestrel logs (T9) | Node |
| `?newsOnDemand=1` on a feed | read in IndexController [V:34] | NoD-flavoured feed (used by the legacy emailer) | n/a | ignore the query on feeds | Node |
| Old: `/rss.xml`, `/rss/...`, `/atom.xml`, `/iframe.html` | middleware: `/rss.xml` -> `/feed`; `/rss/*` -> `/connect#rss`; `.../atom.xml` -> `.../feed/atom`; `.../iframe.html` -> `.../embed` [V code, host www.news / newsroom only] | | | include in the table (cheap) | Node |

### 1d. Search, connect, utility pages

| Legacy | Example | Ours | Handling |
|---|---|---|---|
| `/search?q=&page=&ministry=&sector=&date=&city=&content=&language=&fromDate=&toDate=` | `/search?q=test&page=2` 200 [V]; `/Search` case variants all in robots Disallow [V] | `/search/` with client-side `q`, `ministry`, `sector`, `page` (max 50) [V search.ts:20-24] | serve `/search/`; `/search` slash-less 301 keeps the query string [A: express.static redirect preserves query? Express/serve-static redirect does append `url.search`; confirm in test T1]. Unsupported filters are ignored. Case variant `/Search` -> needs the case-insensitive layer (legacy canonicalised a `Search?content=...` target with capital S, so inbound links with `/Search` exist [V]) |
| Old Google-appliance `/search/?q=x&resultspagenum=2` | code only | same | strip `resultspagenum`, 301 `/search/?q=x` |
| `/connect` (+ `#rss` etc.) | 200 on nav [V] | `/connect/` | serve |
| `/contact` | -> 302 to configured `ContactUri` [V code] | none | 301 to the contact URL. Value is in legacy `appsettings` (blank in repo) [A: ask owner] |
| `/contacts`, `/privacy`, `/live` | nav links `/contacts`, `/live` [V live home] | `/contacts` (Media contacts) static? `/privacy`, `/live`: not in site-paths | need new static pages or redirect (T6): `Contacts`, `Privacy`, `Live` (webcasts) pages are CMS content from the News API [A: not examined] |
| `/subscribe`, `/subscribe/index|manage|save|renew` | `/subscribe/manage?token=abc` 200 [V] | `/subscribe/`, `/subscribe/manage/`, `/subscribe/unsubscribe/` [V subscribe-pages.ts] | serve `/subscribe/` and `/subscribe/manage/` (slash-less 301 keeps `?token=`); `/subscribe/save`, `/renew` are POST targets -> 301 `/subscribe/manage/` |
| `/subscribe?newsletters=&newsletters=<key>` (many) | middleware targets [V] | none (NoD has no newsletters on our site) | 301 `/subscribe/` dropping params [A: newsletters feature is out of scope for us; confirm] |
| `/newsletters`, `/newsletters/{key}`, `/newsletters/{key}/{edition}/{article}`, `/newsletters/{file|image}/{guid}` | `/newsletters` 302 -> `/` [V]; several specific ones also -> `/` [V code] | none | 301 -> `/` for `/newsletters*`; the guid binaries (images/files embedded in old newsletter emails) are an open item (T9) |
| `/SiteStatus`, `/hc`, `/error`, `/CarouselImage/{slideId}` | ops/health; carousel image proxy [V RouteConfig] | `/stack/health` | `/hc` and `/SiteStatus`: tell ops monitors to change (not public content). `/CarouselImage/{id}` -> 404 unless an old email/OG tag hot-links it (T9 log check) |
| `/robots.txt` | 200 [V]: Disallow `/assets`, `/error`, `/files`, `/search`, `/Search`, `/SEARCH`, `/subscribe`; no Sitemap line [V] | `User-agent: *\nAllow: /\nSitemap: .../sitemap.xml` [V static-pages.ts:20] | Port the Disallows; keep our Sitemap line (new, harmless). NOTE: legacy blocks `/files` from crawling; keep for parity unless owner wants PDFs indexed |
| `/google790b0529c8dcfaff.html` (Search Console ownership file in wwwroot) | file exists in repo [V]; not probed | none | Must be served at the same path at cutover or Search Console ownership is lost. Static file copy (T1). Also copy `favicon.ico`; meta-tag verifications come from `GoogleSiteVerification`/`BingSiteVerification` settings [V DefaultController.cs:Index], so the platform home needs those two `<meta>` tags [A: not checked] |

### 1e. Subscription links in emails already sent

| What we know | Status |
|---|---|
| Manage link: `GET /subscribe/manage?token=<UrlToken(GUID)>`; invalid/expired token redirects to `/subscribe` [V SubscribeController.cs:117-129]. `UrlTokenDecode` = ASP.NET `HttpServerUtility.UrlTokenEncode` format: base64 with `+`->`-`, `/`->`_`, padding replaced by one trailing digit [V code] | |
| Unsubscribe is not a one-click GET in the web app: Manage page shows a POST form (antiforgery + referer check) that calls `UnsubscribeSubscriber(token)` [V SubscribeController.cs:282-310]. Emails sent by legacy News API/NoD may also carry a `List-Unsubscribe` header pointing to the API, not the web app | [V web app side; I for the email templates: they live in the legacy API/Admin repos, not read, grep of Admin/Settings for `subscribe/manage` found nothing] |
| Old-old links: `/subscribe.aspx?guid=X` -> `/subscribe/manage?token=X` [V RedirectFromNewsroom], `/enewsletters/unsubscribe.aspx` -> `/subscribe/manage`, `newsletters.*/unsubscribe*.aspx` -> `/subscribe/manage` [V] | |
| Platform emails use `/subscribe/manage/?token=` with 43-char base64url tokens [V start.ts:165, recipient-links.ts] | |

Handling: path/query compat is trivial (`/subscribe/manage` slash-less -> 301 with query; `/subscribe.aspx?guid=` -> `/subscribe/manage/?token=`). Token compat is the real problem; see T7.

### 1f. Files, assets, static

| Legacy | Example | Ours | Handling |
|---|---|---|---|
| `/files/{*path}` (case-insensitive: Azure blob lowercased first, then as-is; or UNC folder) | `/files/Media_Contacts.pdf` 404 live [V]; legacy has `/files/newsroom/downloads/media_contacts.pdf` -> `/files/Media_Contacts.pdf` redirect [V code] | `/files/<key>` from NRMS storage dir [V stack.ts:354]; key scheme differs | Import legacy files (the Azure `files` container / `ContentFilesUnc`) into the new storage under the SAME path, case-insensitively resolved (lowercase fallback like legacy). Hundreds of thousands of release attachments and translations hang off these URLs; this is the largest single non-page surface [A: size unknown]. Task T6/T9 |
| `/assets/{*path}` | Azure blob, or redirect to `NewsMediaHostUri` (media.news.gov.bc.ca) [V code] | none | if media host is unchanged: 301 `/assets/*` -> `https://media.news.gov.bc.ca/*` (same as legacy non-Azure branch); `/assets/license` -> media-license URL [A: value in config] |
| `/images/*`, `/downloads/*`, `/factsheets/downloads/*`, `/{x}.pdf|jpg|gif|docx|mp3|png` | -> `/files/Newsroom/...` [V code] | | 301 per legacy rule |
| `/Content/*`, `/lib/*`, `/css/*`, `/js/*`, `/fonts/*`, `/Content/Images/Gov/default-og-image-new.jpg` | default OG image hot-linked from social cards [I] | `/assets/theme.css` etc. | 404 for CSS/JS is fine; keep the OG image URL alive (copy the file) |
| `/areas/newsroom/images/social/default-og-meta-image.jpg` | -> `/Content/Images/Gov/default-og-image-new.jpg` [V code] | | same file |

### 1g. Conventions to preserve or not

- **Lowercasing**: only applied by the legacy redirect for trailing-slash paths; actual route matching is case-insensitive [V live]. Category keys are lowercased on disk in ours [V CATEGORY_KEY]. Resolver must be case-insensitive for post keys and category keys.
- **Query strings**: legacy copies the query on every redirect (`+ query`) [V]. Keep. Exceptions (`/archive`-style rules) drop it.
- **Numbered pages**: `?page=` exists only on `/search` (50-page cap on ours) [V]. Category/kind listing pagination is AJAX (`more-news`, `morearticles`) [V route names], so there are no crawlable `?page=` category URLs to preserve [I].
- **Redirect status**: legacy uses 302 mostly (`IsPermanent=false`) [V]. We should use 301 for permanent moves; this is a deliberate improvement.
- **Redirect loops**: legacy comments warn about prefix collisions (`/ministries/environment` vs `/ministries/environment-and-...`) [V]. Our table must match whole path segments, not `StartsWith`.

## 2. Static vs dynamic summary and how to do each on both hosts

| Class | Static possible? | SiteGround (Node) | Windows (IIS -> Node) |
|---|---|---|---|
| Our own pages (home, post, ministries, categories, archive months, search, connect, subscribe, feeds, sitemap) | yes (already) | express.static at `/` | same Node process; IIS forwards |
| Prefix rewrites (`/stories|factsheets|updates/{k}` -> `/releases/{k}/`, `/tags` -> ..., `/newsletters*`) | no (unbounded key space; stub files would be 100k+ meta-refresh pages with no true 301) | middleware | same middleware; optionally mirrored as IIS `<rule>` entries (regex rules map 1:1) |
| Fixed maps (ministry renames, newsletter dlids/nids, a few pages) | yes: a JSON map checked into the repo | middleware loads `legacy-redirects.json` at start | same |
| Per-post maps (NEWS-n references, RedirectUri, long keys) | yes: builder writes `legacy/refs.json`, `legacy/long-keys.json` into OUTPUT_DIR | middleware loads/reloads (mtime) | same |
| Case-insensitive key lookup | no | in-memory `Map(lowerKey -> key)` built from `releases/` directory listing (or post-index) and refreshed by the builder | same (IIS static handler never sees the request) |
| Feeds under legacy paths | rewrite, not redirect | middleware `req.url = '/feed.xml'` before static | same |
| `/files`, `/assets` | files copied/imported | existing `/files` mount + legacy-path fallback | same |
| Host-based rules (www.news., newsroom., archive.news., enewsletters. hosts) | no | middleware checks `req.hostname` | IIS passes `HTTP_X_FORWARDED_HOST` (set by the rewrite rule) [V Install-Gcpe.ps1]; Node `trust proxy` is set [V stack.ts:283] |

IIS caution: if any IIS-level rule is added, the existing rule "to the stack" has `stopProcessing=true` and appends no query (`appendQueryString="false"` with `{UNENCODED_URL}` which already includes it); new redirect rules must be placed BEFORE it and use `appendQueryString="true"` for redirects [V: web.config text]. Keep IIS-level rules to zero unless a performance reason appears.

Also: with ARR the redirect `Location` host must be the public host; the stack already uses `trust proxy` + `HTTP_X_FORWARDED_HOST` [V], so build redirects as root-relative paths (`Location: /releases/x/`) to avoid host mistakes.

## 3. Hosts other than news.gov.bc.ca (question for owner)

Legacy middleware also handles `www.news.gov.bc.ca`, `newsroom.gov.bc.ca` (+ www), `enewsletters.gov.bc.ca` (+ www) [V code]. The `archive.news.gov.bc.ca` host is separate and stays; legacy sends `/archive/2005-2009/*`, `/archive/2001-2005/*`, `/archive/pre2001/*`, `/default.aspx`, `/list.aspx`, `/?organisation_obj_id=` from `www.news` to it [V code]. Question: will DNS for these hosts also point at the new server? If yes: add host-conditional rules (T8). If no: nothing, but the owner should confirm those hostnames' DNS stays where it is. Same-domain `/archive/2005-2009/...` on news.gov.bc.ca itself: in code only the www host branch sends these to archive; on the news host they hit `/archive/...` routes [I]. Not probed (budget).

## 4. Proposed tasks (TDD: write the test first; each is independently verifiable)

Common test harness: a table-driven test `legacy-urls.test.ts` in `apps/stack/src/` that builds a throwaway OUTPUT_DIR (few posts, one ministry, feed.xml, a long-key post), starts the stack app (existing `stack.test.ts` shows the pattern) with root mount, and asserts `(request path, headers) -> (status, location | content-type | body marker)`. The table is the spec; every row of section 1 becomes a row. Plus a "no loops, no chains" property test: for every table row, following Location once yields 200 (or an external host).

- **T0 Root mount + base URL.** Mount the site at `/` (keep `/site` as alias during transition), set `PUBLIC_SITE_URL` to the origin. Test: `GET /` 200 home; `GET /releases/{k}/` 200; sitemap/canonical/feed links have no `/site` prefix. Depends: none. Risk: everything else.
- **T1 Core redirect middleware (`legacy-redirects.ts`) + static files.** Data-driven table (JSON + regex rules) mounted before static. Covers: kind-less post paths (`stories|factsheets|updates`), `/newsletters*`, `/sitemap/html`, `/archive/{yyyy}`, `more-news/archive/morearticles`, `/contact`, `/subscribe*` (incl. `.aspx?guid=` -> `?token=`), `/search` variants and `resultspagenum`, `/tags|news-subscribe`, premier/speeches, `/sectors/families`, `/rss.xml`, `/files/newsroom/downloads/media_contacts.pdf`. Copy `google790b0529c8dcfaff.html`, favicon, default OG image into the output. Tests: one row per rule incl. query-string preserved; slash-less `/search?q=x` 301 keeps `q`; `Disallow` lines in robots.txt (extend `static-pages.ts` robots, whose current output lacks them [V]).
- **T2 Case-insensitive resolver.** `Map(lowercase -> exact)` for post keys (from `releases/` dir listing, refreshed after a build tick) and category keys. `/Releases/2026tt0105-001130` -> 200 or 301 to exact-case `/releases/2026TT0105-001130/`. Choose 301 (single canonical URL for search engines). Tests: upper/lower/mixed; unknown key -> falls through to 404.html (verify 404 status, not 200).
- **T3 Long keys (>100).** In `site-paths.ts` allow keys up to N chars by storing `releases/_k/<sha1(key)>/index.html` for keys over 100 and having the middleware serve that dir at `/releases/{longkey}/` unchanged (no redirect). First, count them (T9 query) and check the real maximum length (NTFS component limit 255; Windows total path limit 260 is the binding constraint on the IIS box [A: path of OUTPUT_DIR not checked]). Tests: 101-char and 250-char keys round-trip; hash collision impossible by construction; `POST_KEY` still rejects path traversal (`../`).
- **T4 Ministry rename table + nested keys.** Extract all rules from RedirectMiddlewarecs.cs into `ministry-renames.json` (old -> final), transitive closure computed at load, segment-exact matching (tests for the `environment` vs `environment-and-parks` collision, and for `justice` -> `attorney-general`). Applies to `/ministries/{old}`, `/ministries/{old}/feed[/atom]`, `/ministries/{old}/{kind}/...`. Test that no target is itself a source (no chains). Source of truth is incomplete (0.4): list from production (T9).
- **T5 NEWS-n references.** Builder emits `legacy/refs.json` (`{ "1234": "key" }`); middleware 301s `/{digits}` (3+ digits to avoid colliding with `/2026`-style paths: legacy `\d+` route comes before archive routes) to the post. Test: known ref -> 301; unknown -> 404.
- **T6 Missing pages/feeds (needs owner priority call):** (a) Atom feeds `/feed/atom`, `/{cat}/{key}/feed/atom`; (b) per-kind feeds and kind index pages if posts carry a kind; (c) `/embed` minimal; (d) `/privacy`, `/contacts`, `/live`; (e) post `/image` endpoint; (f) `/archive/{yyyy}` year page. Each gets a page-id in `site-paths.ts` `parsePageId`/`pageFiles` with tests in `site-paths.test.ts` following existing patterns. Default if not funded: 301/rewrite fallbacks listed in section 1.
- **T7 Subscription token compatibility (owner decision required).** Options: (1) accept loss: old links land on "request a new link" page (current behaviour, verified in code); add `/subscribe/manage` copy that explains and offers the email box (exists). (2) Import legacy tokens: if legacy keeps GUIDs per subscriber in SQL, import `(guid -> subscriber)` into NoD and teach `findLink`/`unsubscribe` to accept the UrlToken-encoded GUID (decode as in `SubscribeController.UrlTokenDecode`, 36-char uuid after decode). Test: decode known vector, valid -> manage view, unknown -> invalid-link page, and that decoding never throws on garbage. Recommend option 2 if legacy SQL still has the GUIDs, since the request says manage/unsubscribe links in already-sent emails must keep working (an unsubscribe that fails is also a CASL/compliance risk [I]). Also confirm legacy emails' `List-Unsubscribe` target (lives in the API, not read).
- **T8 Other hosts (only if DNS moves).** Host-conditional rules from section 3 with tests that set `Host:` / `X-Forwarded-Host`.
- **T9 Evidence gathering before cutover (read-only, no code):** (a) pull 90 days of Kestrel/IIS access logs (legacy logs every request: `RedirectMiddleware` writes `... METHOD url` lines [V]) and rank paths by hit count against the middleware table to find unhandled traffic; (b) count post keys >100 chars and their max length via `GET Posts/GetAllKeys` on the legacy API; (c) list posts with `RedirectUri`; (d) get the production ministry/sector/theme/tag key list and diff against ours; (e) get the production RedirectMiddleware source (repo is behind, 0.4); (f) size and path-case of `ContentFilesUnc`/Azure `files` container; (g) confirm newsroom/enewsletters/www host DNS plan.
- **T10 Cutover rehearsal script.** A script (`npm run url-compat:check -- https://<staging-host>`) that reads the list of top-N legacy URLs (from T9a logs) plus the fixed table and requests each at ≤1 req/s (or locally in-process), failing on any 404 or on a chain of >1 redirect. Run against boxs.ca before switching DNS.

Priority: T0, T1, T2, T4, T7, T9 are cutover-blocking; T3, T5 next; T6, T8 by traffic evidence.

## Status (2026-10-28, plan 3)

Built on `feat/parity-3`. Batch A is live as PR #56, batches B and C as PR #58, and batches D and E are on the branch, waiting to deploy. The gate results are in `docs/parity/url-cutover-runbook.md`.

| Task | State | Commits |
|---|---|---|
| T1 Redirect middleware, robots, Search Console | Done | dcda081, 3acf797, 9de49e7 (unsafe targets are the site 404); robots and verification: 52994d4, 8dd5e2e |
| T2 Case-insensitive resolver | Done | 3c19083, d025535 |
| T3 Long keys (over 100 characters) | Done | e95720f, 464581c |
| T4 Ministry rename table and nested keys | Done | de7e6ec, 119bb01 |
| T5 NEWS-n references | Done | baeddc5, 5c3590b |
| T6 Feeds | Feeds done: Atom, per-kind, legacy feed URLs. Pages stay in plan 4 (`/contacts`, `/privacy` shipped there; `/live` pending). `/embed` is 404 and `/image` is a 302 (C261, C260). | c6667eb, b0f2f87, c6cc0fb, 2937c26 |
| T7 Subscription token compatibility | Done: legacy tokens accepted; unexpired links imported | fe91b58, fca2b85 |
| T8 Other hosts | Not built (needs DNS decision) | none |
| T9 Evidence gathering | Open: owner supplies it (runbook section 2) | none |
| T10 Rehearsal script | Done | 7d7dd67 |

The decision records are C257-C272 in `changes-from-legacy.md`.

## 5. Risk / what I did not check

- Not probed (budget of 40 requests): `/office-of-the-premier/speeches`, `/news-subscribe/x`, `/sectors/{k}`, `/themes/{k}`, `/embed`, `/top/...`, `/contact`, `/contacts`, `/privacy`, `/live`, `/assets/...`, `/CarouselImage/...`, nested ministry URLs, `www.`/`newsroom.`/`enewsletters.` hosts. Their handling above is [V from code] or [I].
- Router fall-through order: ASP.NET's first matching route wins; I treated each pattern independently. Collisions such as `/archive/{y}/{m}` vs category routes were not worked through exhaustively.
- The repo copy of the legacy app is behind production (0.4), so redirect rules and routes may differ in production. Section 1 tables are verified against code, and where possible spot-checked live (the discrepancies found are noted inline).
- I did not read the emailer templates (legacy News API / Admin, outside the web app repo), so what exact URLs sent emails carry is [I] from the web app's controller contract.
- Whether the platform's post DTO carries a kind, a NEWS reference, an image, and a `RedirectUri` was not checked [A]; T5/T6 depend on it.
- Verified count of live requests: 40 (limit 40), all HEAD except the two GETs noted.

## Rename table vs live (2026-10-28)

`tools/parity/ministry-renames-live.ts`: HEAD `https://news.gov.bc.ca/ministries/<key>` for each of the 29 one-segment keys, 1 request/s, once. Live answers one edge per hop (a 302 with an absolute Location); the table is the closure of those edges. Result: every live 302 Location equals the table's direct edge (or the next step of the same chain, which the closure follows), so no edge changed and no test row was added (P16). Live 404 keys are kept in the table (code-derived edges): ours redirects only when the final page exists, so they cost nothing.

| key | live status | live Location | table (closed value) |
|---|---|---|---|
| justice | 302 | /ministries/attorney-general | attorney-general |
| technology-innovation-and-citizens-services | 302 | /ministries/citizens-services | citizens-services |
| labour-citizens-services-and-open-government | 404 | - | citizens-services |
| energy-and-mines | 302 | /ministries/energy-mines-and-petroleum-resources | energy-mines-and-petroleum-resources |
| natural-gas-development | 404 | - | energy-mines-and-petroleum-resources |
| environment | 302 | /ministries/environment-and-climate-change-strategy | environment-and-climate-change-strategy |
| forests-lands-and-natural-resource-operations | 302 | /ministries/forests-lands-natural-resource-operations-and-rural-development | forests |
| forests-lands-natural-resource-operations-and-rural-development | 302 | /ministries/forests | forests |
| land-water-and-resource-stewardship | 302 | /ministries/water-land-and-resource-stewardship | water-land-and-resource-stewardship |
| aboriginal-relations-and-reconciliation | 302 | /ministries/indigenous-relations-and-reconciliation | indigenous-relations-and-reconciliation |
| jobs-tourism-and-skills-training | 302 | /ministries/jobs-trade-and-technology | jobs-trade-and-technology |
| international-trade | 302 | /ministries/trade | jobs-and-economic-growth |
| trade | 302 | /ministries/jobs-and-economic-growth | jobs-and-economic-growth |
| social-development-and-social-innovation | 302 | /ministries/social-development-and-poverty-reduction | social-development-and-poverty-reduction |
| social-development-social-innovation | 404 | - | social-development-and-poverty-reduction |
| social-development-social-and-social-innovation | 404 | - | social-development-and-poverty-reduction |
| community-sport-and-cultural-development | 302 | /ministries/tourism-arts-and-culture | tourism-arts-and-culture |
| education | 302 | /ministries/education-and-child-care | education-and-child-care |
| child-care | 302 | /ministries/education-and-child-care | education-and-child-care |
| agriculture-food-and-fisheries | 302 | /ministries/agriculture-and-food | agriculture-and-food |
| jobs-economic-recovery-and-innovation | 302 | /ministries/jobs-economic-development-and-innovation | jobs-and-economic-growth |
| jobs-economic-development-and-innovation | 302 | /ministries/jobs-and-economic-growth | jobs-and-economic-growth |
| infrastructure-and-transit | 302 | /ministries/transportation-and-infrastructure | transportation-and-infrastructure |
| workforce-development | 302 | /ministries/post-secondary-education-and-future-skills | post-secondary-education-and-future-skills |
| advanced-education | 404 | - | post-secondary-education-and-future-skills |
| advanced-education-and-skills-training | 404 | - | post-secondary-education-and-future-skills |
| municipal-affairs | 302 | /ministries/housing-and-municipal-affairs | housing-and-municipal-affairs |
| mental-health-and-addictions | 302 | /ministries/health | health |
| intergovernmental-relations-secretariat-1 | 404 | - | intergovernmental-relations-secretariat |

Live 404 (edge kept, from the legacy code): labour-citizens-services-and-open-government, natural-gas-development, social-development-social-innovation, social-development-social-and-social-innovation, advanced-education, advanced-education-and-skills-training, intergovernmental-relations-secretariat-1. Two-segment keys were not probed (the brief checks one-segment keys only).
