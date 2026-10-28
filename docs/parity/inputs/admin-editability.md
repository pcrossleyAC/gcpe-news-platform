# Admin editability inventory: news.gov.bc.ca → platform public site

2026-10-27. Owner rule: **every value the public sees that staff might ever need to change is editable by an admin in the Hub, without a developer.**

Sources read:
- Legacy public webapp: `/Users/paul/News-Hub/gcpe-news-webapp` (checked out on `admin-screens`; `develop` compared).
- Legacy Hub: `/Users/paul/GCPE-Legacy-Hub/gcpe-hub-develop-2`, which matches `LegacyHub/gcpe-hub` and `HUB/gcpe-hub-develop` for these files. It has `Hub.Legacy` (NRMS, Calendar admin) and `Gcpe.Hub.WebApp` (Media Requests).
- Platform: `/Users/paul/GCPE-Legacy-Hub/gcpe-news-platform`, `main` at bd9f466.
- `/Users/paul/GCPE-Legacy-Hub/parity-audit-2026-10-27.md`; gap IDs H1–H6, M1–M17 and L1–L7 below come from it.

**Labels.** **[V]**: I read it in source at the path given. **[I]**: inferred; the reasoning is given. I made no live requests in this pass; "live" facts are quoted from the audit.

**Two framing facts:**
1. **Legacy production is mostly "developer only".** On `develop` (production), the banner, footer, social accounts and theme are hardcoded in `_Layout.cshtml`, `_Banner.cshtml` and `DefaultController.cs` [V: `git diff develop admin-screens`]. The `admin-screens` branch, where Gov.News.Admin edits Banner, Footer, Social and Theme, lives on the `pcrossleyAC` fork. That makes it our own prototype, not something BC staff use today [I: remote is `github.com/pcrossleyAC/gcpe-news-webapp`]. Our platform's site settings are its port.
2. **Legacy's ministry, sector, theme and tag editor was the Calendar "Admin" ASP.NET Dynamic Data scaffold** (`Hub.Legacy/Gcpe.Hub.Legacy.Website/Calendar/Admin`, `Global.asax.cs:41` `ScaffoldAllTables = true`) [V]. `Gcpe.Calendar.Data/Metadata.cs:228-311` **hides** these Ministry columns [V]:
   - `MinisterPageHtml` (the biography), `MinisterEmail`, `MinisterAddress`;
   - `TwitterUsername`, `FlickrUrl`, `YoutubeUrl`, `AudioUrl`;
   - `MiscHtml` and the embed HTML columns.

   So legacy staff could edit name, abbreviation, sort, active, URL, minister name, summary, photo URL, weekend number, additional name and the contact users. Everything hidden was database or developer only. C152 records this ("Calendar admin edited `dbo.Ministry`, Sector, Theme and Tag → Edited in Core only").

**Status key:**
- **editable**: a Hub screen edits it today.
- **data, no screen**: the platform stores it, but no Hub screen writes it.
- **missing**: neither the data nor its page exists.
- **hardcoded**: text in platform code.
- **config**: tenant config or environment, owned by the operator.

---

## 1. Inventory

### 1.1 Site chrome (every page)

| Value / block | Legacy source | Legacy edit today | Platform source | Hub edit today | Status |
|---|---|---|---|---|---|
| Site name in `<title>`, wordmark, feed titles ("BC Gov News") | Hardcoded `_Layout.cshtml:38` `<title>BC Gov News</title>`; `PostView.cshtml:51` og:site_name [V] | Developer | `config/tenants/bc.json` `siteName`, overridable by env `SITE_NAME` (`apps/public-site/src/env.ts:59`) [V] | None | config (see §2) |
| Logo | Static SVGs `~/Content/Images/Gov/BCID_*.svg`, with a Blue Bridge variant (`_Layout.cshtml:174-178`) [V] | Developer | `bc.json` `site.theme.logo.path` plus the file in `config/site/assets`; shown only if the file exists (`static-pages.ts` `logoFor`) [V] | None | config (see §2) |
| Header nav items (Live Webcast, News mega-menu, Office of the Premier, News Archive, Subscribe, search box) | Hardcoded `_Layout.cshtml:207-300`; archive link from appsetting `ArchiveHostUri` [V] | Developer (archive URL: operator) | Hardcoded `render.ts:98-101`: Home, Ministries, Archive, Search [V] | None | **hardcoded** (M13) |
| Theme colours | admin-screens: `SiteSettings.Theme.Colors` (Primary, Text, Link, BannerInfo, BannerEmergency, FooterBackground); develop: CSS [V] | Developer (prod) | Site settings `theme.colors`, 10 keys (`packages/site-settings/src/model.ts`) [V] | `/website/theme` (ThemeScreen) | **editable** |
| Font | CSS; admin-screens `Theme.FontFamily` [V] | Developer | `bc.json` `site.theme.font` [V] | None | config (see §2) |
| Blue Bridge logo/theme switch (`BridgeLogo` auto/on/off) | admin-screens `ThemeSettings.BridgeLogo`; `granville-bridge-theme.css` [V] | Developer | Not implemented; only a text banner (`site-env.ts`) [V] | None | missing (low) |
| Scheduled site banner (style, message, links, dismissible, start/end) | admin-screens `_Banner.cshtml` from settings; develop: hardcoded per event (e.g. commit `701a071 post-election period banner`) [V] | Developer (prod) | Site settings `banner` → `assets/site-banner.json` (`settings.ts` `bannerJson`) [V] | `/website/banner` | **editable** |
| Project Blue Bridge switch | `ApplicationSetting` `granville`, set by `News/ProjectBlueBridge.aspx` [V] | Legacy Hub page | NRMS `/site/blue-bridge`, `Core.Admin` only (`site-routes.ts:352-366`) → News API `home.granville` [V] | `/website/blue-bridge` (switch: Core.Admin) | **editable** |
| Blue Bridge banner **text** ("His Majesty King Charles III … age N") | Hardcoded `_BlueBridgeBanner.cshtml`; DOB `_Layout.cshtml:13` [V] | Developer | Hardcoded `apps/public-site/src/site-env.ts:8,43` (name and DOB) [V] | None | **hardcoded**. A change of Sovereign needs a developer. |
| Footer help sentence and links, "Connect with Us" and "More Info" links, copyright holder | admin-screens settings `Footer`; develop: hardcoded `_Layout.cshtml` [V] | Developer (prod) | Site settings `footer` (`render.ts` `renderFooter`) [V] | `/website/footer` | **editable** |
| Footer column headings "Connect with Us" / "More Info" | Hardcoded `_Layout.cshtml` [V] | Developer | Hardcoded `render.ts:134` [V] | None | hardcoded (low) |
| Land acknowledgement | Hardcoded `_Layout.cshtml:362-365` [V] | Developer | Not rendered; no settings field [V] | None | **missing** (M11) |
| Contact Us (`/contact` → forms.gov.bc.ca) | appsetting `ContactUri` (`DefaultController.cs:325`) [V] | Operator | A footer settings link [V per audit] | `/website/footer` | **editable** |
| Skip link and other accessibility strings | Hardcoded | Developer | Hardcoded `render.ts:91` | None | hardcoded. **OK to keep** (see §2). |

### 1.2 Home page

| Value / block | Legacy source | Legacy edit today | Platform source | Hub edit today | Status |
|---|---|---|---|---|---|
| Top story, Feature story | `ApplicationSetting` `HomeTopReleaseId`/`HomeFeatureReleaseId` [V: `Carousel.aspx.cs` keys]; set from the release page | Legacy release page (Top/Feature) | NRMS features → News API `home.top/feature_post_key` [V schema] | Release editor → Top/Feature switches (`screens/release/sections/FeatureSwitches.tsx`) | **editable** |
| Carousel slides (headline, summary, action URL, Facebook post URL, justify, image, go-live time) | `dbo.Carousel`/`CarouselSlide`/`Slide` (`02-hub-reference.sql` 2.9) [V] | `News/Carousel.aspx` [V] | NRMS carousel → News API `slides` [V] | `/website/carousel` | **editable** |
| Slide action **label** ("Learn more") | Legacy view prints `item.ActionLabel` (`HomeCarousel.cshtml:25`). Legacy `Slide` has no such column (2.9 SELECT) [V]. [I] the closed News API supplies it. | Unknown / developer | NRMS emits `actionLabel: null` (`apps/nrms/src/website/events.ts:61`); public falls back to hardcoded "Learn more" (`pages/home.ts`) [V] | None | **hardcoded** |
| Emergency pins (2 slots: headline, summary, URL, image, pinned) | `ApplicationSetting` `PinnedSlideId`/`IsPinnedSlide`…; `News/EmergencySlideManagement.aspx` [V] | Legacy Hub page | NRMS pins → slides with `emergency: true` [V] | `/website/pins` | **editable** |
| Resources box (home) | `dbo.ResourceLink`, with no screen (C22, Q3) [V] | Database only | NRMS links → News API `resource_links` [V] | `/website/links` | **editable** |
| Section headings ("Latest news", "Top story", "Featured", "Highlights", "Emergency information", "More news", "Resources") | Hardcoded views [V] | Developer | Hardcoded `pages/home.ts` [V] | None | hardcoded (low–med) |
| Live Webcast button (shown when M3U set) | `home.LiveWebcastM3uPlaylist` (`BaseController.cs:68`) [V] | Legacy `LiveFeedManagement.aspx` switch only (Q1) [V] | NRMS live-feed → News API `home.live_webcast_*` [V] | `/website/live-feed` (URLs + switch) | **data, no page** (H4) |
| Google/Bing site verification meta | appsettings `GoogleSiteVerification`/`BingSiteVerification` (`HomeView.cshtml:8-9`) [V] | Operator | Not implemented [I: no `google-site-verification` in `apps/public-site/src`] | None | config (see §2) |

### 1.3 Posts (release pages, listings)

| Value / block | Legacy source | Legacy edit today | Platform source | Hub edit today | Status |
|---|---|---|---|---|---|
| Headline, body, summary, location, contacts, assets, translations, categories | NRMS release tables | Legacy release editor | NRMS → News API posts | Release editor | **editable** |
| Post-kind label ("News Release", "Information Bulletin", "Factsheet") | `dbo.NewsReleaseType.PageTitle` per language (2.6) [V]. No screen [I: only release-editor code references `NewsReleaseType`] | Database only | NRMS `page_types` table; `GET /page-types` only, no write route [V] | None (picked per release, list not editable) | **data, no screen**. Not rendered yet (M4). |
| Per-kind listing titles ("Factsheets & Opinion Editorials", "Speeches") | Hardcoded `MenuContent.cshtml`, `Sector.cshtml:46-50` [V] | Developer | Pages missing (H5) | None | missing |
| Media-assets licence notice and link | appsetting `MediaAssetsLicenseUri` (`AssetsController.cs:49`) + hardcoded text `PostView.cshtml` [V] | Operator | Not rendered (L3) [V] | None | missing |
| Share buttons and og/twitter meta (`og:site_name`, `twitter:site @BCGovNews`) | Hardcoded `PostView.cshtml:51,64` [V]; `FacebookOwnershipId` appsetting [V] | Developer / operator | None (M5) | None | missing |
| Release-page section headings ("Backgrounders", "Quotes", "Learn More", "Related Articles", "Connect with the Ministry") | Hardcoded `PostView.cshtml` [V] | Developer | Partly hardcoded `pages/release.ts` ("Contacts", "Media assets", "Translations", "Related news") [V] | None | hardcoded (low) |
| Translation language display names (简体中文 …) | `dbo.Language` [V 2.3] | Database only | Raw label printed (L3) | None | missing (low) |

### 1.4 Ministries, ministers, contacts

| Value / block | Legacy source | Legacy edit today | Platform source | Hub edit today | Status |
|---|---|---|---|---|---|
| Ministry name, sort order, active, parent (minister of state), abbreviation | `dbo.Ministry` [V] | Calendar Admin (Dynamic Data) [V] | Core `organizations` [V] | `/organizations` (name, sort: SiteEditor+Admin; parent/active/abbrev: Core.Admin; `organizations.ts:175-210`) [V] | **editable** |
| Public / HQ flags | n/a (C124, Q54) | n/a | Core `isPublic`, `isHq` [V] | `/organizations` row toggles (Core.Admin) [V] | **editable** |
| Minister name (card heading), summary, photo URL, email | `Ministry.MinisterName/Summary/PhotoUrl` (editable), `MinisterEmail` (hidden) [V] | Calendar Admin; email: database only [V] | Core `minister.name/summary/photoUrl/email` [V] | `/organizations` edit form (photo is a URL, uploaded via `/website/files`) [V] | **editable**. Name not rendered as heading (M2). |
| **Minister biography** (bio page, `MinisterPageHtml`) | `Ministry.MinisterPageHtml`, hidden in Dynamic Data [V] | **Database only** [V] | Core `minister.detailsHtml`; profile PATCH accepts **only `null`** (`organizations.ts:192-193` "v1 has no biography editor") [V] | None (can only remove) | **data, no screen**. Page missing (H2). |
| Minister "large photo" link | Hardcoded URL pattern on www2 built from the name (`Minister.cshtml`) [V] | Developer | Not implemented | None | missing (low) |
| Ministry website, Flickr, YouTube links ("More from this Ministry") | `Ministry.MinistryUrl` (editable), `FlickrUrl`/`YoutubeUrl` (hidden) [V] | Calendar Admin / database [V] | Core `url`, `social.flickrUrl/youtubeUrl` [V] | `/organizations` edit form [V] | **editable** |
| Featured Topics / Featured Services links | `dbo.MinistryTopic` / `dbo.MinistryService` [V 2.3]; no screen [V grep: only entity classes reference them] | **Database only** | Core `topicLinks`/`serviceLinks` [V] | `/organizations` edit form [V] | **editable** |
| Ministry Newsletters links | `dbo.MinistryNewsletter` → `NewsLetterLinks.cshtml` "Newsletters" box [V] | Database only | Not carried (no field in OrgRecord) [V] | None | missing. [I] probably drop: legacy `/newsletters` is retired. |
| Side-column labels ("More from this Ministry", "Featured Topics", "Media Contacts", …) | Hardcoded `MoreFromThis.cshtml`, `PopularTopics.cshtml` [V] | Developer | Site settings `ministryPages` (7 labels) [V] | `/website/ministry-pages` | **editable** |
| **Media contacts (primary, alternate: name, phone, cell, email)** | `Ministry.ContactUserId/SecondContactUserId` → Hub `User` (phone/mobile in `Calendar/Admin/User.aspx:55-64`) [V] | Media Requests app "Ministry Contacts" (`Gcpe.Hub.WebApp/Views/MediaRequests/_EditMinistryContacts.cshtml`, `MinistriesApiController.cs:120-156`) [V] | Core `contact`/`secondContact` JSON snapshot `{fullName, phoneNumber, mobileNumber, emailAddress}` written only by the legacy import (`import/map.ts:96-97`) [V]. Core users have no phone fields (`db/schema.ts` users) [V] | **None.** The edit form says contacts are "untouched" (`OrganizationEditForm.tsx:55`) [V] | **data, no screen**. Also never renders (M1). |
| After-hours (weekend) contact number | `Ministry.WeekendContactNumber` [V] | Media Requests "Ministry Contacts" and Calendar Admin [V] | Core `weekendContactNumber`; in DTO, not rendered [V] | None | **data, no screen** |
| Additional display name (e.g. "(Child Care)") | `Ministry.DisplayAdditionalName` [V] | Calendar Admin [V] | Core `displayAdditionalName` [V] | None | **data, no screen** |
| Ad-hoc extra contacts (e.g. commented "Child Care Media Contacts") | Hardcoded `Ministry.cshtml:97-111` [V] | Developer | None | None | missing. Covered by the proposal in §3. |
| Office of the Premier "Meet the Team" links; "More from the Premier" heading | Hardcoded `MoreFromThis.cshtml` (3 www2 links) [V] | Developer | None (M15) | None | missing |
| Ministers of state card ("Meet the Team") | Derived from `ParentId` [V] | Calendar Admin | Core `parentKey` (unused by site, M15) [V] | `/organizations` (Core.Admin) | data exists; page missing |
| Minister's Twitter, Audio, `MiscHtml`, embed HTML | Hidden columns [V] | Database only | Core `social.twitterUsername/audioUrl`; no embeds [V] | None | not rendered. [I] drop. |

### 1.5 Categories (sectors, themes, tags)

| Value / block | Legacy source | Legacy edit today | Platform source | Hub edit today | Status |
|---|---|---|---|---|---|
| Name, sort order, active | `dbo.Sector/Theme/Tag` [V] | Calendar Admin Dynamic Data [V] | Core `terms` (`displayName`, `sortOrder`, `isActive`) [V]; API `PUT /terms/:kind/:key` and `/deactivate` (Core.Admin) [V] | **None.** No `terms` call in `apps/staff-web/src` [V grep] | **data, no screen** (queued per memory) |
| Category Top/Feature story | `Sector.TopReleaseId` etc. [V] | Legacy release page | NRMS features [V] | Release editor Top/Feature switches | **editable** |
| Category index pages (`/sectors`, `/themes`, Topics) | Generated | n/a | Missing (M16) | n/a | missing (no editable values) |

### 1.6 Subscribe and notices

| Value / block | Legacy source | Legacy edit today | Platform source | Hub edit today | Status |
|---|---|---|---|---|---|
| Subscribe page heading ("Subscribe to BC Gov News On Demand") | Hardcoded `Subscribe/Index.cshtml` [V] | Developer | Hardcoded `subscribe-pages.ts:164`. The BC brand name is in shared code [V] | None | **hardcoded** |
| Which lists and topics are offered | NoD lists | NoD admin (`EditList.aspx`, C92) | NoD lists, names from Core/NRMS | `/subscribers/lists` ("Lists and categories") [V] | **editable** |
| Category group legends ("Ministries", "Sectors", "Themes", "Tags", "Emergency Info BC") | Hardcoded | Developer | Hardcoded `subscribe-pages.ts:9-13` [V] | None | hardcoded (low; "Emergency Info BC" is a BC brand) |
| **Notice of Collection** (FOIPPA s.26(c), Executive Director, 250 387-1337) | Hardcoded `Subscribe/Index.cshtml` [V] | Developer | Not rendered (M14) [V] | None | **missing**. [I] compliance text. |
| Status and confirmation messages ("Check your email…") | Hardcoded | Developer | Hardcoded `subscribe-pages.ts` script [V] | None | hardcoded. **OK to keep** (see §2). |

### 1.7 Live webcast

| Value / block | Legacy source | Legacy edit today | Platform source | Hub edit today | Status |
|---|---|---|---|---|---|
| Stream URLs (manifest, M3U) | News API home record; unknown setter (Q1) [V] | Switch only (`live_webcast_enabled`) [V] | NRMS live-feed; env defaults `LIVE_WEBCAST_*_URL_DEFAULT` [V] | `/website/live-feed` | **editable** (data) |
| Live page heading, player, privacy-consent text ("content from wowza.com … Privacy statement") | Hardcoded `LiveView.cshtml`, `LiveVideoPlayer.cshtml` [V] | Developer | Page missing (H4) | None | **missing** |

### 1.8 Media Contacts directory (`/contacts`)

| Value / block | Legacy source | Legacy edit today | Platform source | Hub edit today | Status |
|---|---|---|---|---|---|
| Header "Government Communications and Public Engagement", 24-hour line **250-883-2951**, intro text, non-media links (ministries page, Service BC) | Hardcoded `Default/CommContacts.cshtml` [V] | **Developer** | Page missing (H3); home links out to news.gov.bc.ca/contacts | None | **missing** |
| Multicultural media contacts (Chinese Media, South Asian Media: named staff, cell, email) | **Hardcoded** names, phones and emails, `CommContacts.cshtml` [V] | **Developer** | None | None | **missing** |
| Per-ministry rows (name, additional name, minister, primary, alternate, after hours) | `Ministry` + contact users [V] | Media Requests "Ministry Contacts" | Core org fields (see 1.4) | None | data, no screen |
| Special case "hide minister for Intergovernmental Relations Secretariat" | Hardcoded name check `CommContacts.cshtml` [V] | Developer | None | None | missing. A per-org flag is proposed in §3 T2. |

### 1.9 Connect page

| Value / block | Legacy source | Legacy edit today | Platform source | Hub edit today | Status |
|---|---|---|---|---|---|
| Social accounts for Facebook, X, Instagram, Threads, Bluesky, Flickr, YouTube, Blogs | admin-screens settings `Connect`; develop: controller code [V] | Developer (prod) | Site settings `connect` (8 networks) [V] | `/website/social` | **editable** |
| **LinkedIn** accounts | Hardcoded in `DefaultController.cs:368-373`, even on admin-screens [V] | Developer | `NETWORKS` has no `linkedin` [V] | None | **missing** (M12) |
| Network headings ("Find us on Facebook" …) | Hardcoded `ConnectView.cshtml` [V] | Developer | `NETWORKS[].name` constant [V] | None | hardcoded (low) |
| Social Media policy, collection notice and hours link | Hardcoded `ConnectView.cshtml:22` [V] | Developer | None [V] | None | **missing** |
| RSS feed list (~45) | Generated from categories (`DefaultController.cs:355-366`) [V] | Automatic | Not built (non-goal) | n/a | derived, nothing to edit |

### 1.10 Privacy, 404, search, archive

| Value / block | Legacy source | Legacy edit today | Platform source | Hub edit today | Status |
|---|---|---|---|---|---|
| `/privacy` statement (123-line page) + "Reset Preferences" | Hardcoded `PrivacyView.cshtml` [V] | Developer | Missing (L1); footer links the www2 privacy page | Footer link: `/website/footer` | missing. The link is editable. |
| 404 page text | `SearchView.cshtml` "That web page doesn't exist…" [V] | Developer | Hardcoded `static-pages.ts:10-15` [V] (and not served, H1) | None | **hardcoded** |
| Error page | Hardcoded `ErrorView.cshtml` [V] | Developer | n/a (static) | — | n/a |
| Search UI text and old-archive links (archive.news.gov.bc.ca 1994–2011) | Hardcoded `SearchView.cshtml` [V] | Developer | Hardcoded `pages/search.ts` [V]; no archive links | None | hardcoded. Archive links missing. |
| Archive page text ("Nothing has been published yet.") | n/a | — | Hardcoded `pages/archive.ts` | None | hardcoded. **OK to keep** (see §2). |

### 1.11 Feeds, sitemaps, analytics

| Value / block | Legacy source | Legacy edit today | Platform source | Hub edit today | Status |
|---|---|---|---|---|---|
| Feed channel title/description ("BC Gov News: latest news", "News from <ministry>") | Code | Developer | Derived from `siteName` and category names (`builder.ts:106-149`) [V] | Names editable (orgs, terms) | derived. OK. |
| RSS cutoff date | appsetting `RssFeedCutoffDate` [V] | Operator | n/a | — | config |
| Sitemaps, robots.txt | Code | Developer | Generated; test sites `Disallow: /` (C39) [V] | — | config (keep) |
| Web analytics (Snowplow collector `spt.apps.gov.bc.ca`, `appId`) | Hardcoded `wwwroot/Scripts/webanalytics.js` [V] | Developer | None (L5) | None | missing. Should be config (see §2). |
| Footer link analytics ids (`footerHome` …) | Hardcoded ids | Developer | Settings `LinkSetting.id` [V] | `/website/footer` | **editable** |

---

## 2. Values that should stay developer- or operator-owned

| Value | Where | Why it stays config |
|---|---|---|
| Public base URL, News API URL, time zone, default language | `bc.json` `publicSiteBaseUrl`, `timeZone`, `defaultLanguageId`; env `PUBLIC_SITE_URL` [V] | Changing any of these rewrites every canonical URL, feed GUID and date. That is a deployment event, not an edit. |
| Test-site flag, noindex, `robots.txt` | C39, `static-pages.ts` `renderRobots` [V] | If an admin could turn noindex off, a test site would get indexed. It must follow the environment. |
| Analytics collector, app id, on/off | New env/config (L5) | Differs per environment. Injecting script is a CSP and privacy (PIA) decision, and a typo silently loses statistics. |
| Search-engine verification tokens, Facebook ownership id | Legacy appsettings [V] | Account credentials of the domain owner, set once per domain. |
| Font family and stylesheet URL | `bc.json` `site.theme.font` [V] | The stylesheet URL is validated against CSP (`render.ts:73`). BC Visual Identity governs it. |
| Logo file | `config/site/assets` [V] | Brand asset; SVG upload is an XSS vector. A P3 option is in §3 T10. |
| Live webcast URL defaults | env `LIVE_WEBCAST_*_URL_DEFAULT` [V] | Only a fallback. The real values are editable at `/website/live-feed`. |
| Site name | `bc.json` `siteName` / `SITE_NAME` [V] | Rare rebrand. It changes feed titles for every subscriber. Keep in config unless the owner wants it in settings (T10). |
| Generic UI microcopy: skip link, form labels, error and status messages, pagination, "No results." | Code | Accessibility and behavioural text tied to code paths, and tested. Making it editable risks breaking a11y wording with no business need. |
| Generated lists (RSS list, sitemaps, feed descriptions) | Code | Derived from editable data (category names), so editing the source edits them. |

---

## 3. Proposed Hub screens (each one implementable task)

Existing roles [V `packages/auth/src/roles.ts`; `site-routes.ts:214-219`; `core/http/routes.ts`]:
- **Site settings**: read by `NRMS.SiteEditor` or `Core.Admin`; written by `NRMS.SiteEditor`.
- **Organization profile** (`PATCH /organizations/:key/profile`): `Core.Admin` or `NRMS.SiteEditor`. Parent, active and abbreviation are `Core.Admin` only.
- **Terms**: `Core.Admin`.
- **Blue Bridge switch**: `Core.Admin`.
- **NoD lists**: `NoD.Admin` [I from the roles.ts comment].

No new roles are needed.

Cheapest mechanism: most text blocks fit as **new site-settings sections**, using the same model (`SECTION_KEYS`), draft/publish/history, `settingsHashes` rebuild trigger and Hub screen pattern (`screens/website/settings/*`). Ministry-specific data belongs on the **Core organization** (profile PATCH, `org.upserted` → News API → rebuild).

**T1. Minister biography and premier's team (Organizations).** Priority P1; unblocks H2.
- Fields:
  - `minister.detailsHtml`: rich text with the C209 allow-list, sanitised on save as well.
  - Read-only preview of the bio page.
  - New `teamLinks: [{text, url}]`, for the Premier's "Meet the Team" and similar.
- Change: `orgProfilePatchSchema.minister.detailsHtml` goes from `z.null()` to a sanitised string. Add the link list to `orgRecordSchema` and the News API DTO.
- Roles: `NRMS.SiteEditor`, `Core.Admin`.
- Consumers: `/ministries/<key>/biography/` (new), `/ministries/office-of-the-premier/`, and the ministry page minister card (Read Bio link).

**T2. Ministry media contacts (Organizations, new "Media contacts" fieldset).** Priority P1; fixes M1's data side and H3.
- Fields:
  - Primary and alternate contact, each with name, title (optional), phone, cell and email. Stored as Core `contact`/`secondContact` with the existing shape.
  - After-hours number (`weekendContactNumber`).
  - Additional display name (`displayAdditionalName`).
  - "Show minister on directory" flag, replacing the hardcoded IGRS check.
  - Optional `extraContacts: [{heading, name, phone, email}]` for cases like Child Care.
- Decision needed: legacy picked Hub users; Core users have no phone, so free-text contacts fit our model. [I] Free text is simpler, and media relations staff are the editors (Media Requests "Ministry Contacts").
- Roles: `NRMS.SiteEditor`, `Core.Admin`. Possibly a narrower role for media relations staff (open question).
- Consumers: ministry page "Media Contacts" (after the M1 field-name fix), the release side column (M7), `/contacts/`.

**T3. Media Contacts directory page settings (new settings section `contactsPage`, screen `/website/media-contacts`).** Priority P1; H3.
- Fields:
  - heading;
  - intro text;
  - 24-hour line number;
  - non-media help links `[{text,url}]`;
  - `generalContacts: [{group (e.g. "Chinese Media"), name, phone, email}]`.
- Per-ministry rows come from T2.
- Roles: `NRMS.SiteEditor` (write), `Core.Admin` (read).
- Consumers: `/contacts/`, and the home Resources link once it points in-site.

**T4. Notices and page text (new settings section `pageText`, screen `/website/page-text`).** Priority P1 for the first two items, P2 for the rest. Covers M11, M14, H1, L1 and H4's text.
- Fields:
  - land acknowledgement (plain text);
  - subscribe Notice of Collection (text, contact title, phone, email);
  - 404 heading and body;
  - privacy page: body (allow-listed HTML) or an external URL;
  - Live page heading and consent/privacy text;
  - media-assets licence text and URL (L3);
  - old-archive links `[{text,url}]` for search (1994–2011).
- Roles: `NRMS.SiteEditor`.
- Consumers: the footer on every page, `/subscribe/`, `404.html`, `/privacy/`, `/live/`, release pages (assets), `/search/`.

**T5. Navigation and home headings (new settings section `navigation`, screen `/website/navigation`).** Priority P2; M13.
- Fields:
  - header nav items `[{text,url}]`. Live Webcast stays automatic (shown when the live feed is on) but its label is editable.
  - search-box toggle;
  - home section headings (Top story, Featured, Highlights, Emergency information, More news, Resources);
  - the default slide action label.
- Roles: `NRMS.SiteEditor`.
- Consumers: every page header, home page.

**T6. Carousel and pin action label.** Priority P2.
- Fields: `actionLabel` per slide and per pin, on `/website/carousel` and `/website/pins`. NRMS currently emits `actionLabel: null`.
- Roles: `NRMS.SiteEditor`.
- Consumers: home slides and emergency region.

**T7. Connect page completion (extend `/website/social`).** Priority P2; M12.
- Fields:
  - add a `linkedin` network to `NETWORKS` and the schema (schemaVersion bump);
  - social-media policy link `{text,url}`;
  - optional intro text.
- Roles: `NRMS.SiteEditor`.
- Consumers: `/connect/`, and footer "Connect with Us" anchors.

**T8. Sectors, themes and tags screen (`/terms`, Admin nav).** Priority P1. The API exists and the work is already queued.
- Fields per kind: display name, sort order, active (deactivate). Key is shown read-only.
- Roles: `Core.Admin`.
- Consumers: `/sectors|themes|tags/<key>/`, the index pages (M16), subscribe page groups, search filters and feed titles.

**T9. Release kinds / page titles (`/admin/page-types`).** Priority P3; M4, H5.
- Fields per page type: label per language (e.g. "News Release", "Information Bulletin"), sort order, active, and the public listing title (e.g. "Factsheets & Opinion Editorials").
- Needs an NRMS write route; today only `GET /page-types` exists.
- Roles: `Core.Admin`, or `NRMS.SiteEditor` if the owner prefers.
- Consumers: release-page kind label, per-kind listings and feeds.

**T10. Site identity (optional, extend `/website/theme`).** Priority P3.
- Fields:
  - Blue Bridge banner message template, with an `{age}` token and the Sovereign's name and birth date;
  - Blue Bridge logo mode (auto/on/off, parity with admin-screens `BridgeLogo`);
  - optionally site name and a raster logo upload.
- Roles: Blue Bridge text `Core.Admin` (same as the switch); the rest `NRMS.SiteEditor`.
- Consumers: every page.
- Reason: today `site-env.ts` hardcodes "King Charles III" and 1948-11-14, so a demise-of-the-Crown change needs a developer, as legacy did.

**Not proposed:**
- The ministry Newsletters box [I: retired with `/newsletters`].
- Sector social links and embed HTML: never rendered on our site.
- Generic UI microcopy (§2).

---

## 4. Checks behind the keystone claims

- **Minister biography has no editor anywhere.** Checked by three routes:
  - legacy Dynamic Data `[ScaffoldColumn(false)] MinisterPageHtml` (`Metadata.cs`);
  - Core `detailsHtml: z.null()` (`organizations.ts:192-193`);
  - the Hub form only offers "Remove the previous minister's biography" (`OrganizationEditForm.tsx:287-310`) [V].
- **Contacts have no platform editor.**
  - `orgProfilePatchSchema` has no `contact`/`secondContact`/`weekendContactNumber` (`organizations.ts:175-206`) [V].
  - The only writer is the importer (`import/map.ts:96-97`) [V].
- **Terms have no screen.** `grep -rn "terms" apps/staff-web/src` (excluding tests) finds no call; the router has no route for it (`router.tsx:72-157`) [V].
- **Hardcoded directory contacts.** `CommContacts.cshtml` contains literal names, cells and emails for the Chinese and South Asian media contacts, and the 24-hour line [V].

**Not checked:**
- The roles that gate legacy Calendar Admin and Media Requests (assumed sysadmin and media-relations staff).
- Whether legacy's closed News API fills `ActionLabel`.
- Whether BC prefers free-text contacts over linking Core users (an open decision for T2).
