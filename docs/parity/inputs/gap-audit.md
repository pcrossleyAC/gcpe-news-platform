# Public site parity audit: news.gov.bc.ca vs the platform's static site

2026-10-27. Legacy: https://news.gov.bc.ca (live) and `/Users/paul/News-Hub/gcpe-news-webapp`. Ours: https://boxs.ca/site/, which now runs `main` at bd9f466 (`feat/site-settings` merged and deployed today), from `/Users/paul/GCPE-Legacy-Hub/gcpe-news-platform`.

**Evidence labels.** **[V-live]**: fetched today. **[V-src]**: read in source, or rendered locally from source with `tsx`. **[I]**: inferred, with the reasoning given. Fetched pages are in `/private/tmp/claude-501/-Users-paul-gcpe-hub-develop-2/36eae3c8-31ee-41d8-91b2-1273cc21c67f/scratchpad/parity/` (`legacy/`, `ours/`). About 130 requests were made in total, at most one a second.

## Verdict

**Final status (plan 5, 2026-10-28, boxs.ca at `main` 7bfb7e7, deploy ad3f5f8): no High or Medium entry is open.** Every one of H1–H6 and M1–M17 is addressed by a commit, some with a recorded deliberate difference beside it (C-rows named in the re-walk table below). Two Low entries stay open: **L5** (web analytics, an operator feature the owner decides, spec §7) and the **`/assets/license` remnant of L3** (boxs.ca answers 404 where legacy 302s to the licence PDF; fix task F-P5-1). The rest of what boxs.ca does not show is data that the cutover import brings: minister biographies, Health factsheets and the 78 legacy releases outside boxs.ca's slice. See "Plan 5 final re-walk".

The original verdict (2026-10-27) follows.

The static site covers the main reading path: home, release pages, ministry/sector/theme/tag pages, a monthly archive, search, RSS, sitemaps and subscribe. Every internal link on the pages I fetched works (37 of 37 checked, 200) [V-live]. It does not yet match what a member of the public gets on news.gov.bc.ca:

- **Six legacy pages or flows a reader reaches from navigation are missing or broken:**
  - Media Contacts.
  - Live Webcast.
  - Minister biographies.
  - Factsheets and the other per-kind listings.
  - The "search <ministry> news" links, which open an empty search.
  - Any unknown URL on boxs.ca, which returns raw JSON instead of the 404 page.
- **Several release-page and ministry-page elements are absent, and two of them are silent code bugs rather than design choices:**
  - Ministry **Media Contacts never render**: the site reads the wrong field names from the News API.
  - Release **backgrounders are dropped**: only the first document is rendered.

One framing point changes how to read everything below. The Phase 6 spec (D1, §1) says BC *keeps* `gcpe-news-webapp` at cutover, and that replacing it, including legacy URL redirects, is out of scope. If the static site is now meant to replace news.gov.bc.ca, decision D1 and the "already decided" items C202 and C206 (no redirects, one URL scheme) need to be reopened. The gaps below are then required work, not optional parity.

boxs.ca holds only about 10 test posts, all from October 2026 [V-live: `/site/archive/` lists one month]. It is not a mirror of news.gov's data, so many content differences could only be checked in source.

## Route table

| Legacy URL pattern | Ours | Status | Notes |
|---|---|---|---|
| `/` | `/site/` | gap (elements) | Page exists [V-live]. Home cards (M8 for home), carousel, Connect With Us and Resources done in plan 2 (d6591b1). M13 (navigation) addressed by plan 4 (81364e0, 7426dd5). Site meta description added in plan 5 (98c2889, C297). Nothing open: structure 8/8 `ok` on boxs.ca at both widths (plan 5 final audit). Carousel: C205, C236. |
| `/releases/<key>` | `/site/releases/<key>/` | addressed (plan 2) | Page rebuilt: M3–M7 done (1868215, 6269b24); remaining differences are C234-C256. The `/releases/<key>/image` endpoint (M5) is not built; `og:image` is the release image or the default. |
| `/factsheets/<slug>`, `/stories/<slug>`, `/updates/<slug>` | `/site/releases/<slug>/` | already decided C206 | One path for every kind. |
| `/releases`, `/factsheets`, `/stories`, `/updates` (listings) | `/site/releases/`, `/site/factsheets/`, `/site/stories/`, `/site/updates/` | **H5 addressed by plan 4** (78c2e57) | Built per kind from the navigation settings' titles (C283). |
| `/{kind}/more-news`, `/{kind}/archive[/y[/m]]`, `/{kind}/morearticles` | `/site/archive/…` | already decided C202 | Legacy redirects these to `/Search` or uses AJAX "Load More News". |
| `/{kind}/feed[/atom]` | `/site/feeds/<kind>.xml`, `.atom.xml` | **M10 addressed by plan 3** (c6667eb, b0f2f87, 2937c26) | Legacy `/<kind>/feed` URLs are served in place with legacy content types. |
| `/releases/<key>/image` | 302 to the default Open Graph image | recorded difference **C260** | og:image endpoint; legacy 200 image/jpeg [V-live]. boxs.ca 302 to `default-og-image-new.jpg` (plan 5 final audit). |
| `/ministries` | `/site/ministries/` | **M8 index addressed by plan 4** (d0008cb, 837f7a7) | Each ministry's latest posts, from one batch call (C292). |
| `/ministries/<key>` | `/site/ministries/<key>/` | addressed (plan 2) | M1 (media contacts render) and M2 (minister card) done in efa17ea and 3881b34; Premier Meet the Team and ministers of state in efa17ea (M15). |
| `/ministries/<key>/biography`, `/office-of-the-premier/biography` | missing | **H2 addressed in plan 2** (3881b34) for `/ministries/<key>/biography/`; legacy paths by plan 3 (dcda081, de7e6ec) | The page is written only while the minister has a bio (`builder.ts`); otherwise the address 301s to the ministry page. boxs.ca has no bio text in Core (data; see the plan 5 re-walk). `/office-of-the-premier/biography` 301s to the ministry's biography, else its page. |
| `/ministries/<parent>/<key>[…]` (ministers of state) | 301 to `/ministries/<key>/`, else the parent | addressed (M15: efa17ea; nested paths: de7e6ec) | Minister-of-state cards on the parent page. |
| `/ministries/<key>/<kind>` (e.g. `/factsheets`) | `/site/ministries/<key>/factsheets/` only | **H5 addressed by plan 4** (ed1f2c3) | Other `/<cat>/<key>/<kind>` paths go to the category page (C284). |
| `/{category}/<key>/feed` | `/site/{category}/<key>/feed.xml` | parity (path differs, D1/C202); M10 addressed by plan 3 | Atom added beside RSS (c6667eb, b0f2f87). No `<category>` element (not in scope). |
| `/{category}/<key>/top\|feature` feeds, `/top/feed`, `/feature/feed` | served in place at the legacy URLs | **M10 addressed by plan 3** (c6667eb, b0f2f87, 2937c26) | Legacy `/top/feed` and `/feature/feed` are served in place. |
| `/office-of-the-premier[/…]` | `/site/ministries/office-of-the-premier/` | addressed (M15, plan 2) | Different path (D1). Premier card, "Meet the Team" links and "More from the Premier" (efa17ea). |
| `/office-of-the-premier/speeches[…]` | — | n/a | Legacy itself returns 404 [V-live]. |
| `/sectors`, `/themes` (index) | `/site/sectors/`, `/site/themes/` | **M16 addressed by plan 4** (d0008cb, 837f7a7) | C292. |
| `/tags` → 302 `/news-subscribe` ("Topics" index) | `/site/tags/` | **M16 addressed by plan 4** (d0008cb, 837f7a7) | C292. |
| `/sectors/<key>`, `/themes/<key>` | `/site/sectors/<key>/`, `/site/themes/<key>/` | parity (structure) | Posts list correctly when data exists (`/site/sectors/services/`) [V-live]. |
| `/tags/<key>` → 302 `/news-subscribe/<key>` | `/site/tags/<key>/` | **L4 addressed by plan 3** (de7e6ec) | `/news-subscribe/<key>` gets a 301 to `/tags/<key>/`, which stays canonical. |
| `/archive`, `/archive/<y>/<m>` | `/site/archive/`, `/site/archive/<y>/<m>/` | already decided C202 | Legacy redirects to `/Search?daterange=…` [V-live]. |
| `/more-news` | — | already decided C202 | Legacy redirects to `/Search`. |
| `/search` (`/Search?q=…&ministry=&sector=&city=&content=&language=&date…`) | `/site/search/` | **M9 addressed by plan 4** (a88a53b, 455354e, 5a8a559); **H6 addressed** (e6b740c) | Language and City are not built (C285). |
| `/feed`, `/feed/atom` | `/site/feed.xml`, `/site/atom.xml` | **M10 addressed by plan 3** | Legacy `/feed` and `/feed/atom` are served in place. Path differs (D1). |
| `/embed[…]` | — | n/a | Legacy 410 [V-live]. |
| `/connect` | `/site/connect/` | **M12 addressed by plan 4** (6febcda, 3fe99ee) | LinkedIn, the RSS list and the policy link (C273, C287). |
| `/subscribe`, `/subscribe/manage` (and Save/Renew POSTs) | `/site/subscribe/`, `/site/subscribe/manage/`, `/site/subscribe/unsubscribe/` | **M14 addressed by plan 4** (bb0ea79, cbe5040) | C288-C290. |
| `/live` (+ `/api/live/playlist`) | `/site/live/` | **H4 addressed by plan 4** (7426dd5, 59526ac) | Consent-first playback; the production stream's https and CORS are owner question 1. |
| `/contacts` | `/site/contacts/` | **H3 addressed by plan 4** (3966eaf) | From the Media contacts settings and the ministries' contacts (C276, C277). |
| `/contact` | 302 to forms.gov.bc.ca | parity | Footer links forms.gov.bc.ca directly [V-live]. |
| `/privacy` | `/site/privacy/` | **L1 addressed by plan 4** (5598052) | From Page text settings, without Reset Preferences (C279, C280). |
| `/sitemap/html` | `/site/sitemap/` (+ `/site/sitemap.xml`) | **L2 addressed by plan 4** (91629ee, 62a9ebe) | Pages, categories and months, not every post (C275). Legacy has no `/sitemap.xml` (404) [V-live]. |
| `/robots.txt` | `/site/robots.txt` | parity | Test site uses `Disallow: /` (C39). |
| `/<digits>` (NEWS- reference permalink) → redirect | NEWS-n references resolved | addressed by plan 3 (url-compat T5: baeddc5, 5c3590b) | `/1123` returned 404 on legacy; the curated URL list's references section passes on boxs.ca (1/1). |
| `/newsletters[/…]` | — | n/a | Legacy 302 to `/` (retired) [V-live]. |
| `/files/*`, `/assets/*`, `/assets/license` | `/files/<key>` (NRMS storage) | gap L3 (licence line addressed by plan 4, 5598052); **`/assets/license` open: fix task F-P5-1** | `/assets/license` 302 to `/files/News_Footage_License_British_Columbia.pdf` (legacy, re-checked 2026-10-28); boxs.ca answers 404. Our licence text and link are Page text settings (C281). `/files/*` is runbook item 2f. |
| `/CarouselImage/<id>`, `/SiteStatus`, `/api/live/granville`, `{controller}/MoreArticles` | — | n/a (internal) | Covered by C204, C202 and the Blue Bridge switch. |
| `/error` | — | n/a | Legacy 500 [V-live]. |
| Unknown path (404) | the site's 404 page, status 404 | **H1 addressed** (c769bd2; text 5598052, C282) | Legacy shows a styled 404 page [V-live]. |
| Legacy redirect middleware (`/ministries/justice` → …, trailing slash, `/sectors/families`) | — | already decided C202 / D1 | |

## Gaps, ranked by public impact

### High

**H1. Unknown URLs show raw JSON, not the 404 page.** Code, S. **Status: addressed** (c769bd2 site 404 for unknown URLs; 5598052 and 67da9ca 404 text, C282): boxs.ca `/this-page-does-not-exist` answers 404 `text/html` with the site chrome (plan 5 re-walk).
- Legacy: `https://news.gov.bc.ca/this-page-does-not-exist` returns a styled 404 page with navigation [V-live].
- Ours: `https://boxs.ca/site/releases/2026HLTH0085-001117/` and `/site/privacy/` return HTTP 404 `application/json` with the body `{"error":"not found"}` [V-live].
- Cause: `404.html` is built (`static-pages.ts`) and is reachable at `/site/404.html` [V-live]. But `apps/stack/src/stack.ts:345` mounts `express.static` with no 404 fallback, so misses fall through to a JSON 404 [V-src].
- Production may sit behind a different web server. Inferred: this needs the same fix there.

**H2. Minister biography pages are missing.** Code, M. (Already known.) **Status: closed by plan 2** (3881b34, 53b4f9c): `/ministries/<key>/biography/` is built. The two legacy URLs below still wait for plan 3.
- Legacy: `https://news.gov.bc.ca/ministries/citizens-services/biography` [V-live] shows the minister's name, photo and full bio. The minister card's "Read Bio" link points to it.
- Ours: `https://boxs.ca/site/ministries/citizens-services/biography/` returns 404 [V-live].
- Mitigation: our ministry page renders `minister.details` inline when it exists (`categories.ts`) [V-src]. On boxs.ca the details are `null` (data) [V-live: `/api/Ministries/citizens-services/Minister`].
- This also covers `/office-of-the-premier/biography` and ministers of state (see M15).

**H3. The Media Contacts directory is missing.** Code (page) plus data, M. **Status: addressed by plan 4** (3966eaf; settings model bff716e, 226ddf6; Hub screen 811e3c5): `/contacts/` is built from the Media contacts settings and the ministries' contacts (C276, C277). The home Resources link points in-site. Named contacts are entered in the Hub (P4-R2).
- Legacy: `https://news.gov.bc.ca/contacts` [V-live] is linked from the Resources box on every listing page. It shows the 24-hour media line (250-883-2951), Chinese and South Asian media contacts, and every ministry's primary and alternate contact with phone, cell and email.
- Ours: no page. The home "Resources" link goes **out to `https://news.gov.bc.ca/contacts`** [V-live]. That link breaks if news.gov.bc.ca is retired.

**H4. Live webcast page and nav item are missing.** Code, M. **Status: addressed by plan 4** (7426dd5 button and `live.json`, 59526ac page, 93ca627, 77a8a77, be9a534 phone icon): `/live/` with consent-first playback and vendored hls.js (C278, C218). The production stream's https and CORS are owner question 1; playback in a real browser is untested.
- Legacy: `https://news.gov.bc.ca/live` [V-live] holds the webcast player and privacy-consent text. "Live Webcast" is in the global nav on every page.
- Ours: `/site/live/` returns 404 [V-live] and there is no nav item.
- Q1 covers where NRMS stores the URLs. Nothing renders them on the public site [V-src].

**H5. Per-kind listing pages are missing: Factsheets, Stories, Updates, Releases, and per-ministry factsheets.** Code, M. **Status: addressed by plan 4** (78c2e57 kind listings, e7c10d2 sector/theme/tag pages, ed1f2c3 per-ministry factsheets): only the ministry factsheets list is built; other `/<cat>/<key>/<kind>` paths go to the category page (C283, C284).
- Legacy [V-live]:
  - `https://news.gov.bc.ca/factsheets` ("Factsheets & Opinion Editorials").
  - `https://news.gov.bc.ca/stories`, `https://news.gov.bc.ca/updates`, `https://news.gov.bc.ca/releases`.
  - `https://news.gov.bc.ca/ministries/health/factsheets`.
- Each is about 12 posts with an RSS feed. "Factsheets" is in the Resources box and in each ministry's "More from this Ministry".
- Ours: nothing in `pageFiles`/`PageId` [V-src]. C206 decides the post URLs, not these listings.

**H6. "Search <ministry> news" links open an empty search.** Code, S–M. **Status: addressed** (e6b740c): a ministry or sector search with no text lists that filter's posts; boxs.ca `/api/v2/search?ministry=citizens-services` answers 200 with 8 results (plan 5 re-walk).
- Where: every ministry and sector page links to `/site/search/?ministry=<key>` or `?sector=<key>` with no `q` [V-live: `ours/min-citz.html`].
- Two reasons it shows nothing:
  - The search script stops at `if (!q) return;` [V-src `search.ts`].
  - The API refuses a search with no query: `https://boxs.ca/api/v2/search?ministry=citizens-services` returns **400** "q must be 1-200 characters" [V-live].
- Legacy: `/Search?ministry=citizens-services` lists that ministry's news with no query. Q82 relies on "search filtered by ministry or sector" working without a query.

### Medium

**M1. Ministry Media Contacts never render, even when the data exists. This is a field-name bug.** Code, S. **Status: closed by plan 2** (efa17ea, bbd6104).
- The News API sends `contactUser: {fullName, phoneNumber, mobileNumber, emailAddress}` [V-live: `https://boxs.ca/api/Ministries/citizens-services?api-version=1.0`; V-src `apps/news-api/src/dto.test.ts:21`].
- The public site reads `name/title/phone/email` (`contactFields`, `pages/categories.ts`, on `main` at bd9f466) [V-src].
- Confirmed live after today's deploy: `https://boxs.ca/site/ministries/citizens-services/` has "More from this Ministry", "Featured Topics" and "Featured Services", but **no "Media Contacts"** [V-live]. A local render with the same API record agrees [V-src].
- Legacy `https://news.gov.bc.ca/ministries/citizens-services` shows two contacts with mailto links [V-live].
- The unit tests use the wrong shape (`categories.test.ts:96`), which is why they pass.

**M2. The minister card is incomplete.** Code, S. (Partly known.) **Status: closed by plan 2** (3881b34, efa17ea); the large-photo link stays out (C238).
- Legacy card [V-src `Minister.cshtml`; V-live]: photo linked to a large photo, the minister's name as a heading, summary, "Read Bio", and "Contact: CITZ.Minister@gov.bc.ca".
- Ours [V-live `ours/min-citz.html`; V-src]:
  - A generic "Minister" heading.
  - The name appears only in the image alt text: `MinisterDto.headline` is never rendered.
  - No Read Bio link.
  - No email, although the API sends `emailHtml` [V-live].
  - The Premier's page also says "Minister".

**M3. Release backgrounders are dropped.** Code, S–M. **Status: closed by plan 2** (1868215).
- Legacy renders `Documents.Skip(1)` under "Backgrounders" [V-src `PostView.cshtml`]. Example: `https://news.gov.bc.ca/releases/2026HLTH0086-001123` has the backgrounder "Booking influenza and COVID-19 immunizations" [V-live].
- Ours renders only one document: `english = documents.find(languageId===4105) ?? documents[0]` in `pages/release.ts` [V-src].
- Our test copy `https://boxs.ca/site/releases/2026HLTH0005-000008/` says "Two backgrounders follow." and shows none [V-live]. On boxs.ca that copy has a single document (data) [V-live API], but the code would drop extra documents anyway.

**M4. Release metadata is thin.** Code, S. **Status: closed by plan 2** (fd04cfd, 1868215).
- Legacy [V-live `legacy/rel3.html`, `legacy/rel1.html`] shows:
  - the post-kind label ("News Release", "Information Bulletin", "Factsheet");
  - the long date with weekday and time ("Monday, September 21, 2026 12:30 PM");
  - the byline;
  - the lead ministry above the headline.
- Ours shows "October 7, 2026 · Victoria · Health": no time, no kind label, no byline [V-live].
- The API already sends `documents[].pageTitle` ("Information Bulletin") and `byline` [V-live API]. Our DTO ignores both [V-src `dto.ts`].

**M5. No share buttons, and no Open Graph or Twitter cards.** Code, M. **Status: closed by plan 2** (6269b24) apart from `/releases/<key>/image` and `twitter:site` (C241); share set per C247.
- Legacy release pages [V-live `legacy/rel1.html`] have:
  - Facebook, X, LinkedIn, Bluesky, email and print share links;
  - `og:title/description/image/type/site_name`, `twitter:card/site`;
  - `/releases/<key>/image`.
- Ours: none on any page [V-live: 0 `og:` tags; V-src: no `og:` in `apps/public-site/src`]. Shared links get no preview card.

**M6. No lead photo or video, and no embedded media players.** Code, M. Partly [I]. **Status: closed by plan 2** (fd04cfd, 6269b24) as links with placeholders (C234).
- Legacy renders `Post.AssetUrl` as a primary asset, and `AssetHelper.RenderAssetsInHtml` turns YouTube and Flickr links in the body into players [V-src].
- [I] The primary-asset `<div>` was empty in the fetched HTML (`legacy/rel3.html`), so it is probably filled client-side through `media.news.gov.bc.ca/embed`. I did not see it render.
- Ours: `assetUrl` is not in the DTO, and C209's sanitiser strips `iframe` [V-src]. Body media show as plain links.

**M7. The release page has no ministry side column and no fallback for Related Articles.** Code, M. **Status: closed by plan 2** (1868215, 6269b24), without a minister card (C246).
- Legacy release pages [V-live `legacy/rel1.html`] show:
  - the minister card;
  - "More from this Ministry" (Factsheets, website, photos, videos);
  - Featured Topics and Featured Services;
  - Media Contacts;
  - "Related Articles" (3 posts);
  - "Connect with the Ministry" (photos, videos);
  - a Subscribe link prefilled with the release's ministry and sectors.
- Ours: the article plus "Related news" from v2 similarity. That is empty on boxs.ca for 2026HLTH0005-000008: `/api/v2/posts/…/related` returns `{"mode":"text","results":[]}` [V-live]. The branch's side column is on ministry pages only [V-src].

**M8. Listings lack thumbnails, translation badges and times, and `/ministries` is just a name list.** Code, M. **Status: partly closed by plan 2** (fd04cfd, d6591b1, efa17ea): PostCards with thumbnails, badges and times on home and ministry pages; the `/ministries` index was unchanged. **Index closed by plan 4** (d0008cb, 837f7a7): `/ministries/`, `/sectors/`, `/themes/` and `/tags/` show each category's latest posts, from one batch call (C292).
- Legacy cards on the home, ministry and sector pages [V-live] have a Flickr thumbnail, a "Translations" badge, "Read More", and a date with time.
- Legacy `/ministries` shows each ministry's latest 3 posts with "Browse More News" and "Search News" [V-live].
- Ours: headline, date and summary; `/ministries` is names plus minister [V-live].

**M9. Search is far narrower.** Code (API and UI), M. **Status: addressed by plan 4** (a88a53b API pageSize and facets, 455354e page, 5a8a559 review fixes): 10 per page, legacy query strings, Ministry/Sector/Content/Date facets in text mode, older-archive links. Language and City are not built (C285, owner question 5); results come before the filters in the DOM (C286).
- Legacy `https://news.gov.bc.ca/search?q=vaccine` [V-live] has facets for:
  - language (13 languages);
  - date ranges, including links to archive.news.gov.bc.ca for 1994–2011;
  - ministry and sector;
  - city;
  - content type (Release, Factsheet, Story).
- Ours [V-live; V-src]:
  - Query plus a ministry dropdown only.
  - `?sector=` works only through a URL, and is lost when the form is resubmitted.
  - No date, type or language filters.
  - Browsing without a query is impossible (H6).

**M10. Feed coverage.** Code, M. **Status: addressed by plan 3** (c6667eb, b0f2f87, 2937c26): Atom beside every RSS feed, per-kind feeds, and the legacy feed URLs (`/feed`, `/feed/atom`, `/<kind>/feed`, `/ministries/<key>/feed`, top and feature) served in place with legacy content types (C265, C270). Per-item `<category>` and `<author>` are not part of this plan.
- Legacy has [V-live]:
  - Atom (`/feed/atom`);
  - per-kind feeds (`/releases/feed`, `/factsheets/feed`);
  - top and feature feeds (`/top/feed`, plus category top/feature feeds);
  - `<category>` (ministry) and `<author>` on each item.
- Ours: RSS 2.0 only, home and category feeds only, items without a category [V-live `ours/feed.xml`].
- Feed URLs differ (`/feed` vs `/feed.xml`). Under D1 there are no redirects, so existing subscribers and ministry websites would break on a switch. [I]

**M11. Footer has no land acknowledgement.** Code or settings, S. **Status: addressed** (524ec15 setting, b502a1e footer band, 1e5b274): the acknowledgement is a footer setting; the strict `landAck` region passes on every page at both widths (plan 5 final audit, max 0.0072).
- Every legacy page's footer says "The B.C. Public Service acknowledges the territories of First Nations around B.C. …" [V-live].
- The live footer (`https://boxs.ca/site/`, deployed today) has the help text, two link columns and the copyright, but no acknowledgement [V-live]. No settings field holds one [V-src].

**M12. Connect page is missing LinkedIn, the RSS list and the policy link.** Code, S–M. **Status: addressed by plan 4** (6febcda Hub fields, 3fe99ee page, 1a0d963 collapse and `sectionBar` token, 0237725 `collapseAfter`, c386cc6, 0e6bdb0): LinkedIn, the RSS list and the policy link (C273, C287).
- Legacy `https://news.gov.bc.ca/connect` [V-live] has sections for Facebook, X, Instagram, Threads, Bluesky, **LinkedIn**, Flickr, YouTube, Blogs and **RSS Feeds** (about 45 feeds), plus the "Social Media policy, collection notice and hours" link.
- Ours `https://boxs.ca/site/connect/` has Facebook, X, Instagram, Threads, Bluesky, Flickr, YouTube and Blogs [V-live]. `NETWORKS` has no `linkedin`, so legacy's `/connect#linkedin` and `#rss` anchors have no target.
- The RSS list is a stated non-goal of the site-settings spec (no C-number).

**M13. Global navigation.** Code, S. **Status: addressed by plan 4** (81364e0 Hub screen, 7426dd5 header, 76dd84b slide labels): header links, labels and the Live Webcast button are Navigation settings.
- Legacy header [V-live]: Live Webcast, "News" mega-menu (ministries with their top posts), Office of the Premier, Subscribe, and a search box.
- Ours: Home, Ministries, Archive, Search [V-live]. Subscribe and Connect are reachable only from the footer, and there is no header search box.

**M14. Subscribe page.** Code, S. **Status: addressed by plan 4** (bb0ea79, cbe5040): subscribe and manage pages with the Notice of Collection, manage link and prefill (C288-C290).
- Legacy `https://news.gov.bc.ca/subscribe` [V-live] shows:
  - a **Notice of Collection** (FOIPPA s.26(c), with the Executive Director's contact details);
  - a "manage your account or unsubscribe" link;
  - an "all ministries and sectors" vs "customize" choice;
  - prefill from the query string (release pages link `/subscribe?ministries=health&sectors=…`).
- Ours `https://boxs.ca/site/subscribe/` [V-live; V-src `subscribe-pages.ts`]:
  - no collection notice;
  - no link to manage;
  - ignores query parameters;
  - shows an empty "Emergency Info BC" group, because `SubscriptionItems/emergency` returns `[]` [V-live].
- The collection notice is likely a compliance requirement [I].

**M15. Office of the Premier and ministers of state.** Code, M. **Status: partly closed by plan 2** (efa17ea): Premier page and minister-of-state cards; nested URLs wait for plan 3.
- Legacy `https://news.gov.bc.ca/office-of-the-premier` [V-live] has "Premier David Eby", "More from the Premier", and **"Meet the Team"**: the Minister of State for Local Governments and Rural Communities, with its own Read Bio link (`/ministries/local-governments-and-rural-communities/biography`).
- Ours `/site/ministries/office-of-the-premier/` [V-live]: "Minister" heading, no ministers of state. `childMinistryKey` and `parentMinistryKey` are unused [V-src].

**M16. Category index pages are missing.** Code, S. **Status: addressed by plan 4** (d0008cb, 837f7a7): the four category index pages exist (C292).
- Legacy [V-live]: `https://news.gov.bc.ca/sectors`, `https://news.gov.bc.ca/themes`, and `https://news.gov.bc.ca/news-subscribe` ("Topics"; `/tags` redirects there). Each lists categories with their latest posts and "Browse More News".
- Ours: `/site/sectors/` returns 404 [V-live].
- The rubric's "page missing" would make this High. I placed it in Medium because legacy itself doesn't link these pages from nav, the home page or release pages [V-live grep].

**M17. Legacy post keys over 100 characters would get no page, and links to them 404.** Code, S. **Status: addressed by plan 3** (e95720f, 464581c): keys up to 200 characters are served at `/releases/<key>/` from a hashed folder.
- `POST_KEY = /^[A-Za-z0-9-]{1,100}$/` (`site-paths.ts:4`) [V-src].
- Legacy's HTML sitemap (28,440 post keys) has 3 keys of 102 characters [V-live]. Example: `canada-and-british-columbia-investments-in-local-infrastructure-help-build-community-connections-for-1`.
- The rubric would put broken links in High. I placed this in Medium because only 3 posts are affected, and only after import.

### Low

**L1. `/privacy` is missing.** Code, S. Legacy `https://news.gov.bc.ca/privacy` is the "B.C. Government Website Privacy Statement" plus a "Reset Preferences" control for embedded-media consent [V-live]. Our footer links the www2 privacy page, as legacy's footer does. **Status: addressed by plan 4** (5598052): `/privacy/` from Page text settings, without Reset Preferences (C279, C280).

**L2. No HTML sitemap.** Code, S. Legacy `/sitemap/html` is a 4 MB list of every post [V-live]. Ours has an XML sitemap index, which legacy lacks: legacy `/sitemap.xml` returns 404 [V-live]. **Status: addressed by plan 4** (91629ee, 62a9ebe): `/sitemap/` lists pages, categories and months, not every post (C275).

**L3. Media assets and translation details.** Code, S. **Status: partly closed by plan 2** (1868215): asset and translation rows. **Licence line closed by plan 4** (5598052): text and link are Page text settings (C281; C243 superseded). [I]: there was no asset or translation data on boxs.ca to compare.
- Legacy shows the asset date, "Download (size)", a "Mirror" link, and "These assets are subject to the News Footage License" (`/assets/license` redirects to a PDF) [V-src; V-live redirect].
- Legacy maps translation labels to language names (e.g. 简体中文) [V-live `legacy/rel1.html`].
- Ours prints the raw label and size, with no licence notice [V-src].

**L4. Tag URLs differ.** **Status: addressed by plan 3** (de7e6ec): `/news-subscribe/<key>` gets a 301 to `/tags/<key>/`, which stays canonical. Legacy's canonical tag URL is `/news-subscribe/<key>`, and `/tags/<key>` 302s there [V-live]. Ours is `/tags/<key>/`. Only matters if redirects are added later (D1).

**L5. No web analytics.** Code, S. Legacy loads `/Scripts/webanalytics.js` on every page [V-live]. Ours loads none. The footer keeps legacy's footer link ids (`footerHome` etc.) but nothing reads them. Readers don't see this; the owner loses statistics. **Status: open** (Low; operator feature): spec P13 puts Snowplow behind an operator flag, and spec §7 leaves production analytics to the owner. Nothing is built.

**L6. No "Connect With Us" icon strip, and Resources only on the home page.** Code, S. **Status: partly closed by plan 2** (d6591b1, efa17ea): strip and Resources on home and ministry pages; LinkedIn and RSS closed by plan 4 (3fe99ee; C240 superseded, C287). Legacy listing pages show social icons, "View all Social Media", and the Resources box [V-live]. Ours has Resources on the home page only, and no icons.

**L7. Related posts depend on similarity.** **Status: closed by plan 2** (6269b24): same-ministry fallback (C251). [I] On a full dataset, text-mode related posts may return results. Legacy always shows 3 posts from the same ministry; ours hides the section when nothing matches (boxs.ca: empty) [V-live].

## Plan 5 final re-walk (2026-10-28)

One request per entry to boxs.ca (deploy ad3f5f8 of `main` 7bfb7e7), plus the full parity harness and the three URL lists run by the controller at the same deploy (`.superpowers/sdd/2026-10-28-parity-5-identity-and-leftovers/parity.txt`, `urls-*.txt`). Four news.gov requests re-checked legacy facts (the Citizens' Services ministry card, the Health factsheets list, `/assets/license`, release 2026HLTH0085-001117). Status: **addressed** (commit), **recorded difference** (C-row), or **open**.

| Entry | boxs.ca request and result | Status |
|---|---|---|
| H1 | `/this-page-does-not-exist`: 404 `text/html`, title "That web page doesn't exist.", header and land acknowledgement present | addressed (c769bd2, 5598052); C282 |
| H2 | `/office-of-the-premier/biography`: 301 to the ministry's biography, else the ministry page (`middleware.ts:353`). `/ministries/citizens-services/biography/` 301s to the ministry page because Core on boxs.ca holds no bio text (the card shows the placeholder name "First Name Last Name"; legacy shows Diana Gibson and "Read Bio"). Harness: biography structure `missing` `.biography-details`, `.minister-bio-picture img` | addressed (3881b34, 53b4f9c; dcda081, de7e6ec). **Data**: the importer reads `MinisterPageHtml`, `MinisterPhotoUrl` and `MinisterName` (`apps/core/src/import/queries.ts:3`), and the builder writes the page only while a bio exists (`apps/public-site/src/builder.ts:365-368`) |
| H3 | `/contacts/`: 200; structure 4/4 | addressed (3966eaf); C276, C277 |
| H4 | `/live/`: 200; structure 3/3 | addressed (7426dd5, 59526ac); C218, C278 |
| H5 | `/factsheets/`: 200, 20 factsheets; structure 6/6. `/ministries/health/factsheets/` shows "Nothing has been published yet." because boxs.ca has no Health factsheets (two legacy Health factsheet keys answer 404 on boxs.ca); harness `missing` `.regular-articles .article` | addressed (78c2e57, ed1f2c3); C283, C284. **Data** for the Health list |
| H6 | `/api/v2/search?ministry=citizens-services`: 200, 8 results with no `q` | addressed (e6b740c) |
| M1 | `/ministries/citizens-services/`: Media Contacts with two named contacts and mailto links | addressed (efa17ea, bbd6104) |
| M2 | Same page: photo, name heading, title, email. No "Read Bio" because no bio (data, H2) | addressed (3881b34, efa17ea); C238 |
| M3 | `/releases/2026HLTH0086-001123/`: 200, "Backgrounders" heading present | addressed (1868215) |
| M4 | `/releases/2026HLTH0085-001117/`: kind label, "Tuesday, September 22, 2026 11:45 AM", ministry | addressed (fd04cfd, 1868215) |
| M5 | Same release: `og:` title/description/image/type/url and `twitter:` card/site/title/description/image. `/releases/<key>/image`: 302 to the default OG image | addressed (6269b24, 98c2889); C242, C247, C260, C298 |
| M6 | Lead media and players | recorded difference C234 (links with placeholders) |
| M7 | Same release: related articles, contacts, connect/share and translate boxes | addressed (1868215, 6269b24); C246 (no minister card) |
| M8 | `/ministries/`: 27 "Browse More News" and 27 "Search News"; structure 4/4 | addressed (fd04cfd, d6591b1, d0008cb, 837f7a7); C292 |
| M9 | `/search/?q=health`: Ministry, Sector, Content and Date facets; structure 5/5 | addressed (a88a53b, 455354e, 5a8a559); C285, C286 |
| M10 | `/feed/atom`: 200 `application/atom+xml`; generated list feeds 40/40 | addressed (c6667eb, b0f2f87, 2937c26); C265, C270 |
| M11 | Every page: strict `landAck` region ok (max 0.0072) | addressed (524ec15, b502a1e) |
| M12 | `/connect/`: LinkedIn and RSS sections and the policy link | addressed (6febcda, 3fe99ee); C273, C287 |
| M13 | `/`: News menu, Office of the Premier, Subscribe, Live Webcast; strict header ≤ 0.0062 | addressed (81364e0, 7426dd5) |
| M14 | `/subscribe/`: Notice of Collection and manage link; structure 4/4 | addressed (bb0ea79, cbe5040); C288-C290 |
| M15 | `/office-of-the-premier/`: 301 to `/ministries/office-of-the-premier/`; premier structure 4/4. Nested `/ministries/<parent>/<key>` 301s to the key, else the parent | addressed (efa17ea, de7e6ec) |
| M16 | `/sectors/`: 200; structure 3/3 + 1 `legacy-absent` | addressed (d0008cb, 837f7a7); C292 |
| M17 | Curated list "long keys" 1/1 | addressed (e95720f, 464581c) |
| L1 | `/privacy/`: 200, "B.C. Government Website Privacy Statement" | addressed (5598052); C279, C280 |
| L2 | `/sitemap/html`: 301 to `/sitemap/` | addressed (91629ee, 62a9ebe); C275 |
| L3 | Release asset rows and translations inside `#assets` (89016db); `/assets/license`: **404** (legacy 302 to the licence PDF) | partly addressed (1868215, 5598052, 89016db; C281, C302). **Open: F-P5-1** |
| L4 | `/news-subscribe/bc-coroners-service`: 301 to `/tags/bc-coroners-service/` | addressed (de7e6ec) |
| L5 | No analytics script | **open** (Low; operator feature, spec P13 and §7) |
| L6 | `/sectors/economy/`: Connect strip, "View all Social Media", Resources | addressed (d6591b1, efa17ea, 3fe99ee); C287 |
| L7 | Release page shows Related Articles | addressed (6269b24); C251 |

## Already decided (not gaps)

| Legacy behaviour | Ours | Decision |
|---|---|---|
| Numbered "Load More News" / `MoreArticles`; `/archive…` and `/more-news` redirect to Search | Monthly archive pages; latest 20 on listings | **C202** |
| Legacy URL redirects (ministry renames, trailing-slash strip, `/sectors/families`, `/feed` paths) | None | **C202**, spec D1 / §1 out of scope |
| Rotating home carousel | Static list of slides | **C205** (Proposed) |
| `/releases/`, `/factsheets/`, `/stories/`, `/updates/` post paths | Everything at `/releases/<key>/` | **C206** (Proposed) |
| No emergency region | "Emergency information" region above slides | **C208** (Proposed) |
| Body HTML published as entered | Allow-list sanitising (strips `iframe`, `script`, …) | **C209** (Proposed). Server-side players from links (M6) are still possible under it. |
| Slide images inline | Slide image URLs | **C204** |
| — | boxs.ca is noindex with `Disallow: /` | **C39** |
| French version of bilingual releases (language toggle) | English only | Spec §1 out of scope (no C-number) |
| Per-category monthly archives | Site-wide archive plus filtered search | **Q82** (answered). Depends on H6 being fixed. |
| BC logo and BC Sans in the header | Text wordmark only | **Q76** (open question) |
| RSS feed list on Connect | Not built | Site-settings spec non-goal (no C-number) |
| `/newsletters…` | — | Legacy retired it (302 to `/`) [V-live] |
| `/embed…` | — | Legacy returns 410 [V-live] |

## Deployed today (`feat/site-settings` merged to `main`)

First checked by rendering the source locally, then re-checked live on boxs.ca after the deploy [V-live]:

- **`/connect/`** with 8 networks and 95 links. Gaps remain: M12.
- **Footer** from settings: help sentence, "Connect with Us" and "More Info" columns, "Contact Us" to forms.gov.bc.ca, © year. Gaps remain: M11.
- **Ministry side column**:
  - "More from this Ministry" (website, photos, videos) renders with real data.
  - Featured Topics (5 links) and Featured Services (3 links) match legacy.
  - The legacy "Factsheets" entry has no counterpart, because H5's page doesn't exist.
  - Media Contacts doesn't render (M1).
- **Scheduled banner and theme colours** come from settings. Legacy's `_Banner.cshtml` matches this model [V-src]. I did not render the banner's timing logic.

## What I could not check

- **Real-content rendering on boxs.ca.** boxs.ca has about 10 test posts (one archive month) and is not seeded from news.gov.bc.ca. So translations, media assets, multiple documents, `assetUrl`, French, thumbnails and long keys were compared only in source.
- **Production hosting.** I could not check production 404 or `robots.txt` handling. boxs.ca serves under `/site/`, so its `robots.txt` isn't at the origin root.
- **Elements legacy fills in with JavaScript**: the primary asset (M6), the Live button's visibility, the carousel. I saw server HTML only.
- **Subscribe and manage flows end to end.** That would need submitting an email, which is out of bounds for a read-only audit.
- **The reference permalink `/<digits>`.** I don't know the reference format; `/1123` returns 404 on legacy.
- **The scheduled banner's timing.** The banner is off in the published settings, so I could not watch it appear or expire.
- **Visual and CSS styling.** Not compared, as instructed.
