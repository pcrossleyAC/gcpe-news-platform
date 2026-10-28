# Look-and-feel parity inputs: news.gov.bc.ca → our public site

Date: 2026-10-27. Research only; no repo changed.

**Bottom line.** Today our public site uses none of news.gov's visual system. It has no BC logo, no BC Sans, no Bootstrap grid, no sidebar or card layout, no land acknowledgement band, and a dark-blue header bar where news.gov has a white header. Of the repaint options, the cheapest one that reproduces news.gov closely is to **vendor the legacy CSS largely as is (Bootstrap 5.3.3 + site/custom/transforms/accessibility/print), emit the legacy class skeleton from our renderers, and keep our semantic and accessibility wins (one skip link, a real `<h1>`, `<main>`/`<footer>` landmarks, escaped output, no auto-rotating carousel)**. jQuery is not needed. Bootstrap's bundle plus a small amount of vanilla JS covers every chrome behaviour.

Labels: **[V]** = verified (I read the file, fetched the page, or measured it in a browser). **[I]** = inferred from verified facts (the reasoning is shown). **[A]** = assumed (unchecked; the check that would settle it is named).

Sources:
- Legacy source: `/Users/paul/News-Hub/gcpe-news-webapp/Gov.News.WebApp`, branch `admin-screens` (abbreviated `WA/` below).
- Our source: `/Users/paul/GCPE-Legacy-Hub/gcpe-news-platform/apps/public-site/src` (abbreviated `PS/`).
- Fetched pages: `/private/tmp/claude-501/-Users-paul-gcpe-hub-develop-2/36eae3c8-31ee-41d8-91b2-1273cc21c67f/scratchpad/lookfeel/{legacy,ours}/*.html`. That is 32 curl fetches plus 8 browser navigations, all ≤1 req/s.
- Screenshots: `/Users/paul/gcpe-hub-develop-2/.playwright-mcp/lookfeel-{legacy,ours}-{home,release,ministry,connect}-{1280,390}.png` (16 files, full page).

Live news.gov runs the `develop`/`master` build. It has **no** `<style id="site-theme">` block, so the admin-screens branch is not deployed there [V: `grep -c site-theme legacy/home.html` = 0]. Live markup otherwise matches `WA/Views` [V: spot-checked header, footer, banner, PostCard and release skeleton].

---

## 0. Visual differences seen in screenshots (4 page types × 2 widths)

| Area | news.gov (legacy) [V screenshots] | boxs.ca/site (ours) [V screenshots] |
|---|---|---|
| Font | BC Sans everywhere. `body` is 13px / 19.5px line-height, colour #2D2D2D [V computed] | Falls back to Verdana. `--font-family: "BC Sans"` is declared, but no `@font-face` or stylesheet loads it [V: theme.css has 0 `@font-face`; head has only theme.css] |
| Site banner | Full-width #013366 band, 16px white text, info icon, × close at right, 88px tall at 1280 [V] | Nothing visible (none is published on our side) |
| Header | **White**, 75px tall, 1px #D9D9D9 bottom border. BC logo (164px) + 2px #013366 divider + "BC Gov News" at 18px/700. Right side: "News ⌄" dropdown, "Subscribe", banner-toggle (i) icon, search input with magnifier. Mobile: BC mark + title + (i) + hamburger + search icon buttons [V] | **Solid #013366 bar**, 48px, white "BC Gov News" wordmark (no logo), underlined text links Home/Ministries/Archive/Search. No search box, no dropdown, no mobile collapse |
| Container | `.container-xl`, max 1140px, 30px padding. Two columns: 232px sidebar (`.home-features`) + 848px body (`.home-body`) [V computed] | `main` max 70rem (1120px), single column, except the ministry page (18rem aside grid) |
| Home | 250px carousel band: slide image left, translucent blue story box right (`rgba(0,51,102,.83)`), prev/next chevrons. The sidebar overlaps the carousel image ("Connect With Us" social icons, Resources list). Top story headline 36px/600 #003366. Each card has date 13px #666, summary, "▸ READ MORE" (14px caps). Then a "LOAD MORE NEWS / SEARCH NEWS" grey bar | H1 "Latest news" plus h2 section headings ("Top story", "Highlights", "More news"). Grey bordered cards, underlined links, plain list |
| Release | Ministry link (h3, 18px) above. Headline 36px/600 #2D2D2D (an **h2**), subheadline 30px/600. Left 248px sidebar: Translations, Share icons, "Information Bulletin" location/date, Media Contacts, More from this Ministry, Featured Topics/Services. Body 821px wide, copy 18px/27px. Print link top right. Grey (#F1F1F1) "Related Articles / BC News image / Connect with the Ministry" band before the footer [V computed + screenshot] | Single column: h1, subheadline paragraph, meta line, body, then "Contacts" and "Related news" sections at the end |
| Ministry | Sidebar: ministry name, minister photo card ("Honourable …", READ BIO, contact email), Media Contacts, More from this Ministry, Featured Topics, Featured Services. Body: top/feature cards with thumbnails and translation badges | Aside with More from / Featured Topics / Featured Services. The Minister photo and summary sit **in the main column** with an h2 "Minister". Media Contacts is absent on boxs.ca (no contactUser data) |
| Connect | Left "Resources" list. Body: "Connect" h2, then one dark-blue (#38598A-ish) heading bar per network with a brand icon. Accounts are collapsed behind "▾ EXPAND … LIST" buttons and the 2nd+ accounts are faded | h1 + plain lists per network |
| Land acknowledgement | #313132 band, 4px #FCBA19 top and bottom borders, white 14px/500 text, on **every** page [V computed] | Absent |
| Footer | White. BC logo + help sentence (flex 2), "Connect with Us" and "More Info" columns (flex 1), `<hr>`, 1px #013366 rule, "© 2026 Government of British Columbia". 16px [V] | Grey surface with a 4px accent top border. Links run inline in rows. No logo |
| Mobile (390) | Header collapses to mark + 3 icon buttons. Carousel story fills the width. Sidebar content ("Resources") is cloned **below** the article list by `_Layout` JS. Footer columns become 2-up. **Long URLs in release bodies overflow horizontally** (visible in legacy-release-390) [V screenshot] | Header links wrap. Everything is a single column |

---

## 1. Chrome

### 1.1 Legacy `<head>` (WA/Views/Shared/_Layout.cshtml:36-154) [V]

The Production order of stylesheets is: `lib/bootstrap5/css/bootstrap.min.css` → `Content/site.css` → `components.css` → `custom.css` → `minimenu.css` → `transforms.css` → `print.css` (media=print) → `Content/css/all.min.css` (FA 6.4.2) → `Content/fontawesome6/css/fontawesome.min.css` + `brands.min.css` (FA 6.7.2) → `covid-banner-style.css` → `accessibility-styles.css` → `granville-bridge-theme.css` (only when Blue Bridge is live) → `covidcategory.css` (only on `/tags/covid-19?embed=true`).

Scripts in head: `Scripts/jquery-1.12.4.min.js`, `lib/bootstrap5/js/bootstrap.bundle.min.js`, `Scripts/jquery.cookie.js`, then `_WebAnalytics` (`Scripts/webanalytics.js`), or `_WebAnalytics_Search` on search.

The admin-screens branch appends `<style id="site-theme">:root{--primary-blue;--info-blue;--theme-text;--theme-link;--theme-footer-background}</style>` after all other CSS (lines 145-153).

The `<title>` is **always** "BC Gov News" [V: all 18 fetched legacy pages]. There is no `<meta charset>` in the layout [V: absent from source].

### 1.2 Legacy body skeleton [V source + live]

```
body
 <!--googleoff: all-->
 div#banner
   (Blue Bridge live)  div#bridge-banner.info-black-banner.container-fluid.sm-g-0 > div.content.container-xl.sm-g-0 > [div>i.fa.fa-info-circle.fa-lg] [div text] [div>a#btnCloseBannerBridge>i.fa.fa-xmark]
   (else, if visible)  div#site-banner.info-blue-banner.container-fluid.sm-g-0[style=background-color:{bannerInfo|bannerEmergency}][data-banner-style][role=alert if emergency]
                         > div.content.container-xl.sm-g-0 > div>i(.fa-solid.fa-circle-exclamation | .fa.fa-info-circle).fa-lg
                                                           > div {message} a.BANNER_NEWS[target=_blank][style=font-weight:700;color:#fff]…
                                                           > div>a#btnCloseBanner[href=#][aria-label="Close banner"]>i.fa.fa-xmark.fa-lg   (if dismissible)
 header#main-nav.container-fluid.sm-g-0.header.nav-border
   div#main-nav-contaier.container-xl.sm-g-0
     nav#main-nav.navbar.navbar-expand-md[aria-label="Main menu"]       (duplicate id main-nav — sic)
       a[href=https://gov.bc.ca] > img#BCGov-logo(.d-none.d-md-block) [BCID_H_rgb_pos_LH_crop.svg], img#sm-BCGov-logo(.d-md-none) [BC_Mark.svg], + two *_bridge variants
       a.navbar-brand.ps-3[href=/] "BC Gov News"
       div.access > ul > li > a.btn.skip-link[href=#main-content-release] "Skip to main content" ; a.btn.skip-link[href=#footer] "Skip to footer"
       div.d-md-none.banner-toggle-container > a.btn.btn-link.banner-toggle-btn > img[banner-toggle.svg]   (no alt, no href)
       button#nav-menu-sm.navbar-toggler.collapse-menu-icon.menu-icon[data-bs-toggle=collapse][data-bs-target=#navbarSupportedContent] > i.fa.fa-bars
       div.d-md-none.search-toggle-container > button#search-md-button.input-group-text.btn-primary-outline.search-md.menu-icon[data-bs-target=#smd-search-container] > i.fa.fa-search
       a.btn.btn-primary-blue.live_button.(live_button_show|live_button_hide) [/live]
       div#sm-nav-container.container-fluid
         div#navbarSupportedContent.collapse.navbar-collapse
           ul#sm-nav-ul.navbar-nav.ms-auto.mb-2.me-3.mb-lg-0.gap-2
             li#ministry-dropdown.nav-item.dropdown.d-none.d-md-block.ministry-dropdown > a#news-dropdown.nav-link[href=#][data-bs-toggle=collapse][data-bs-target=#menu] "News" span#icon-dropdown>i.fa.fa-angle-down
             li.nav-item.dropdown.d-md-none.ministry-dropdown > a#sm-news-dropdown … [data-bs-target=#sm-menu]
             div#sm-menu.container-fluid.collapse.d-md-none > div.menu.container-xl > div.list-unstyled.list-title "By Ministry" + ul > li.list-unstyled[role=menuitem] > a   (top-level ministries)
             li.nav-item > a.nav-link[/subscribe] "Subscribe"
             li.nav-item-link.d-none.d-md-block > a#bannerToggleLink.nav-link > img[banner-toggle.svg]
         form.d-flex.search.d-none.d-lg-block[action=/search GET] > div.input-group > input#mini-site-search-input.form-control[name=q][aria-label=search] + span.input-group-text.btn-primary-outline.search-trigger>i.fa.fa-search
         div.d-none.d-md-block.d-lg-none.search-md-block > button#search-md-button…                  (duplicate id)
         a.live_button … (lg / md variants)
   div#smd-search-container.container-fluid.collapse.d-lg-none > form.search > div.input-group > input#site-search-input + button.input-group-text.search-trigger
   div#menu.container-fluid.collapse > div.menu.container-xl > div.list-title "By Ministry" + ul > li[role=menuitem] > a     (2 CSS columns ≥768px)
 {section Carousel} {section StoryNavigator}
 div#main-content.template.container-xl > main[style=display:flex] > {page} div.clear
 {section AssortedMedia}
 div#landAcknowledgement.container-fluid > div.container-xl > p[style=font-size:14px;font-weight:500] {fixed text}
 div#footer.container-fluid[role=navigation]
   div.top.container-xl
     div.footer-bc > img#BCGov-logo-footer + img#BCGov-logo-footer-bridge ; p {helpText} a… (", or" / ".")
     div.footer-connect > h4 "Connect with Us" > ul[role=menu] > li[role=menuitem] > a#{id}
     div.footer-more-info > h4 "More Info" > ul.pull-left[role=menu] > li[role=menuitem] > a#{id}
     hr
   div.container-xl.bottom > div.copyright "© {year} {copyrightHolder}"
 input#hostingEnv[type=hidden]
 inline jQuery script (behaviours below)
 <!--googleon: all-->
```

**Chrome JS behaviours** (inline, _Layout:432-719) [V]:
1. Bootstrap collapse drives `#menu` (desktop ministry mega-menu), `#sm-menu` (mobile), `#navbarSupportedContent` (hamburger) and `#smd-search-container` (search drawer). jQuery handlers swap icons (`fa-bars`↔`fa-times`, `fa-angle-down`↔`fa-angle-up`, `fa-search`↔`fa-times`), add `.active`, and lock `body` scroll while menus are open.
2. `.search-trigger` click submits the parent form.
3. `#btnCloseBanner`/`#btnCloseBannerBridge` hide `#banner`. `#bannerToggleLink` and `.banner-toggle-btn` toggle `#banner` (the "i" icon re-shows a dismissed banner). Dismissal is not persisted.
4. `.collapsible-regions` children are cloned into `.home-features`. This is how the sidebar gets Resources/News by Sector on wide screens while they still sit below the list on narrow screens. The `<h3>` in each `.resource-links` becomes an accordion toggle.
5. Images taller than wide in `.ministry-listing .article .item-asset img, .story-page .primary-asset img` get `.tall-image`.
6. `.print-document` calls `window.print()`.
7. It polls `/api/live/playlist` and `/api/live/granville` every 60s (or uses SignalR) to show the Live button and to switch to the Blue Bridge theme at runtime.

**Key chrome CSS** (custom.css unless noted) [V]:
- `body{font-family:"BCSans","Noto Sans",Verdana,Arial,sans-serif;font-size:13px;color:var(--theme-text,#2D2D2D);overflow-x:hidden}`
- `.nav-border{border-bottom:1px solid #D9D9D9;height:75px}`
- `.header .navbar-brand{font-size:18px;font-weight:700;border-left:2px solid var(--primary-blue)}`
- `#BCGov-logo{width:164px}`
- `#navbarSupportedContent .navbar-nav li:hover/.active{background:#D7D7D7;border-radius:4px}`
- `#menu{width:100vw;height:calc(100vh - 130px);overflow-y:auto;background:#fff}`
- `.menu ul{columns:2}` (≥768px)
- `.info-blue-banner{background:var(--primary-blue);font-size:16px;color:#fff}`, `.content{padding:20px;display:flex;gap:8px;justify-content:space-between}`
- `#landAcknowledgement{background:#313132;color:#fff;border-top/bottom:4px solid #FCBA19;padding:30px 0 20px}`
- `#footer{background:var(--theme-footer-background,#FFF);padding-top:40px;font-size:16px}`, `#footer .top{display:flex;gap:10px 50px;flex-wrap:wrap;justify-content:flex-end}`, `#footer .bottom{border-top:1px solid #013366;margin:30px 0;padding-top:30px}`
- `.footer-bc{flex:2}` and the link columns `flex:1` (≥1024px); `.footer-bc{flex:0 0 100%}` (768-1023px)
- `#footer h4{font-size:16px;font-weight:600}`
- accessibility-styles.css: `.skip-link`/`.access` off-screen until focus, then `margin-left:320px;background:#fff;border:2px solid #395CCF`.

Breakpoints [V grep]: Bootstrap md 768 / lg 992 / xl 1200. custom.css uses 350/479/767/1023/1024. site.css 480/680/750/916. transforms.css 320/400/480/680/768/860/916/1120 (some with max-height).

### 1.3 Blue Bridge (Granville) [V]
- Markup: `_BlueBridgeBanner.cshtml` (`div#bridge-banner.info-black-banner`, with the King's-death text and age computed from DOB 1948-11-14).
- Swaps: the four `*_bridge.svg` logos are shown and the normal ones hidden.
- Stylesheet: `granville-bridge-theme.css` (4,203 B). It sets a black banner (#252423), `#BCGov-logo.granville-bridge-on{display:none}`, a black Live button with a #FAB919 border, and so on.
- Ours: `render.ts` emits `div.blue-bridge-banner[role=alert]` from `opts.banner` text, and the site-banner script hides itself when that banner is present [V].
- Gap [I]: we swap neither logos nor theme.

### 1.4 Emergency / site banner [V]
- Legacy (admin-screens): server-rendered when `IsVisibleAt(now)`. Background is an inline style with the `bannerInfo`/`bannerEmergency` colour. Links open `target=_blank`.
- Ours: an empty `div#site-banner[hidden]` plus an inline script fetches `assets/site-banner.json` and builds `div.site-banner.site-banner-{info|emergency}` > `p` + `ul>li>a` + `button "Close banner"`.
- To match the look, the script should build the legacy skeleton instead: `div.info-blue-banner.container-fluid.sm-g-0` > `div.content.container-xl.sm-g-0` > icon / message+links / close. Use a **`<button type=button aria-label="Close banner">`** with the × icon, not `<a>`, and keep the background from the CSS variables (see §4).

### 1.5 Skip links
- Legacy: **two copies** per page (header `.access`, plus a second `.access` block in most page views). The target `#main-content-release` is **missing** on 404, search, contacts, privacy, live, manage and factsheets [V: grep per fetched page, target count 0].
- Ours: one `a.skip-link[href=#main]` → `main#main[tabindex=-1]` [V].

### 1.6 Diff: what our render.ts emits today vs legacy [V PS/render.ts]

| Element | Ours now | Needed for look |
|---|---|---|
| head | charset, viewport, `<title>{page} \| {site}`, canonical, robots, description, `assets/theme.css`, optional font link, RSS alternate | Add the vendored CSS bundle (Bootstrap + legacy CSS + BC Sans `@font-face` + icons) before `theme.css` overrides. Keep our title/meta (they are better) |
| banner | `div.blue-bridge-banner` + `div#site-banner[hidden]` + inline script | Wrap both in `div#banner` and emit the legacy classes (§1.4) |
| header | `header.site-header` > `a.brand` (wordmark; logo only if the file exists) + `nav[aria-label=Site]>ul` Home/Ministries/Archive/Search | Legacy skeleton: logo link to gov.bc.ca, `.navbar-brand`, "News" ministry mega-menu (ministry list, needed at render time for **every** page; it changes only when ministries change → rebuild-all trigger), Subscribe, banner toggle, search form (desktop) / drawer (mobile), hamburger. Live Webcast button: hidden by default, so omit it until a live feature exists |
| main | `main#main` with page body | `div#main-content.template.container-xl > main#main` (keep the id). Page bodies use `.home-features` + `.home-body` |
| land ack | none | `div#landAcknowledgement` (fixed text; could later become a site setting) |
| footer | `footer.site-footer` > `p.footer-help`, `div.footer-columns` > `div.footer-connect`/`div.footer-more-info` with `h2`, `p.copyright` | `footer#footer.container-fluid` > `div.top.container-xl` > `div.footer-bc` (logo + help) / `div.footer-connect` / `div.footer-more-info` + `hr`; `div.container-xl.bottom > div.copyright`. Use `h2` styled like `#footer h4` and drop `role=menu` |
| favicon | none (404 on `/favicon.ico` [V console]) | Ship `favicon.ico` (WA/wwwroot/favicon.ico) |

---

## 2. Page types

Legend: **L** = legacy view and key classes, **CSS** = rules that matter, **JS** = behaviour, **O** = ours now.

### 2.1 Home (`Default/HomeView.cshtml`, `HomeCarousel`, `PostCard`, `ResourceLinks`, `TopSectors`, `ConnectSocialMedia`) [V]
- **L**: `@section Carousel` → `div#carousel-holder[role=banner]` > `div.home-banner[style=background-image:url(CarouselImage/{key})]` (display:none except the current one) > `div.home-banner-content > div.stories > div.story.(left|right)[.facebook] > div[onClick=location] > h2 {headline} p.summary div>a.read-more>i.fa-caret-right {actionLabel}` + `div.story-nav.story-previous` + `div.story-nav.story-next`, and `div.bottom-fade`.
- Body: `div#sidebar.home-features[role=complementary]` (ConnectSocialMedia: 9 SVG icons in two `ul`s + "View all Social Media") + `div.home-body#main-content-release[role=main]` > `div.top-article > PostCard`, `div.other-articles > div.feature-article > PostCard`, `div.regular-articles` > PostCard×N (after the first 3: `.article.hidden-article`), `div.news-control > a.load-more.link-button "Load More News" + a.read-more "Search News"`, `div.collapsible-regions > ResourceLinks ("Resources") + TopSectors ("News by Sector": h4 sector + p>a latest headline)`.
- **PostCard**: `div.article > h2>a {headline}` + `div.list-container.ps-0.pb-0 > div.item-date {Long date with time}` + optional `div.item-medialink.media-assets > a[#assets] i.fa-solid.fa-download "Media Assets"` / `div.item-medialink.translations > a[#translationList] i.fa.fa-language "Translations"` + `div.item-content > [div.item-asset.asset.flickr > a>img] div.item-text[.with-image] > p {summary} br a.read-more>i.fa-caret-right "Read More"` + `div.clear`. It also carries an inline `<style>` block per card (sic).
- **CSS** (site.css 835-1010): `.home-features{width≈232px}`, `.home-banner{height:250px;background-size:cover}`, `.story{background:rgba(0,51,102,.83)}`, `.home-body .article h2 a{font-size:24px→top 36px;color:var(--theme-link);font-weight:600}`, `.item-date{13px #666}`, `.read-more{14px uppercase 600}`, `.news-control{background:#F1F1F1}` [V computed for headline/date/read-more sizes].
- **JS**: fade carousel (15s per slide; stops after one loop; prev/next). "Load More" reveals hidden cards and then fetches `/MoreArticles?offset=` (server). YouTube thumbnail placeholders.
- **O**: h1 "Latest news"; sections Emergency information (C208), Top story, Featured, Highlights (static slide cards, C205), More news (`ul.post-list`), Resources [V PS/pages/home.ts].
- **Plan**:
  - Emit `.home-features` + `.home-body` with PostCard markup.
  - Render slides inside `#carousel-holder > .home-banner` with **all slides visible as a static strip, or a single first slide with prev/next buttons and no auto-advance** (C205 stays). Use the slide `imageUrl` as an `<img alt="">` or a background.
  - "Load More News" cannot hit a server. Use a static "More news" link to `/archive/` (or pre-render 20 and hide nothing).
  - Clone sidebar regions with CSS order rather than JS: render them once in `.home-features` and use CSS to reposition at <768px. [I] The legacy JS clone exists only because of the two-column float layout.

### 2.2 Post / release page (`Shared/PostView.cshtml`, 1,031 lines) [V]
- **L**:
  - `@section StoryNavigator`: a fixed blue bar (#38598A) shown on scroll with title, share, search and "More from this Ministry" panels. **[I] Low value, heavy JS; recommend dropping it** (it is `display:none` until scroll [V computed]).
  - Body: `div.story-page.pt-4` > `.access` skip links, `a.print-document "Print"`, `h3 > a {lead ministry}` (or archived-ministry notes), `div.print-title`, **`h2.story-lang.primary {headline}`** (+`h2.story-lang.secondary` French), `div.print-url`, `div.print-date`, `h3.story-lang.primary.subheadline`.
  - `div.story-info` holds the mobile-only rows: translations, `div.mobile-toolbar` (Share), PageTitle ("Information Bulletin"/"News Release"), location and date, assets link.
  - `div.story-features#sidebar` (248px) contains, in order:
    - `div.resource-links.translate#translationList` (links with `i.fa-language`)
    - RelatedSectors
    - ShareSocialMedia (`div.resource-links.connect.share > h3 "Share" ul > li > a.share-{facebook|twitter|instagram|threads|bluesky}` + mailto, each `i.fa-brands … fa-customized-sm`)
    - `div.resource-links.location-and-date` (h3 PageTitle, location, date, media-assets link)
    - `div.resource-links.comm-contacts` ("Media Contacts" from document contacts)
    - MoreFromThis ("More from this Ministry": Factsheets, Ministry Website, Photos, Videos)
    - PopularTopics ("Featured Topics")
    - Resources ("Featured Services")
    - NewsLetterLinks
  - `div.story-body#main-content-release[role=main]` > `div.story-copy.primary-asset` (hero asset: YouTube/Flickr/image) > `p.byline` > `div.language-selector` (EN/FR toggle) > `div.story-copy.story-lang.primary.collapsed > div.story-expander > article {detailsHtml}` > `div.comm-contacts-body-section` (contacts, mobile) > backgrounders (`div.backgrounder > .backgrounder-header.background-control`, `.backgrounder-content`) > `div#assets.assets.expanded > h4 "Media Assets" div.media-assets-container > ul > li > div>b {label} div>a[download] "Download (size)" | "Mirror"` + licence line > `div#assets.assets.expanded > h4 "Translations" …` > `div.share-options > div.share-permalink {permanent URL}`.
  - `@section AssortedMedia` → `div.media-container > div.story-parts > div.related-articles (h3 "Related Articles", div.related-article > h4>a + div.item-date)`, `div.related-image` (latest Flickr or `default-og-meta-image-1.jpg`), `div.connect-with-bc` ("Connect with the Ministry": Photos/Videos).
- **CSS**: `.story-page h2{font-size:36px;font-weight:600}`, `h3.subheadline{30px/600}`, `.story-features{width≈248px}`, `.story-body{≈821px}`, `.story-copy p{18px/27px}`, `.media-container{background:#F1F1F1}`, `.resource-links h3{18px/600}`, `.resource-links ul li a{14px; var(--theme-link)}` with a grey square bullet [V computed]. print.css hides chrome and shows `.print-title/.print-url/.print-date`.
- **JS**: EN/FR language toggle, collapse/expand story (`.collapsed` + `.article-fade`; the live page is not collapsed in practice [V screenshot]), backgrounder toggle, assets expander, share-link URL builders (`share-facebook` etc. → `facebook.com/sharer`, `twitter.com/intent/tweet`, `threads.net/intent/post`, `bsky.app/intent/compose`), print, story navigator, `media-assets.js` (embed consent cookie).
- **O**: `article > h1, p.subheadline, p.meta (date · location · ministry link), sanitized body, section Contacts, Media assets (images as figure, files as links "(PDF, 1.2 KB)"), Translations, Related news` [V PS/pages/release.ts].
- **Plan**:
  - Emit `.story-page` with an **h1** carrying the legacy headline classes, and the sidebar `.story-features` with the same block order.
  - The Share bar needs no JS: build plain `href`s at render time from the canonical URL.
  - Media assets: emit the `#assets` list format. Make the "Show assets" expander a no-op (render it expanded).
  - French docs: the toggle needs a small vanilla script. Without JS, render both languages with `lang="fr"` on the secondary.
  - Add the `.media-container` related band.
  - Hero asset: use the image or a link. Do not embed YouTube iframes without consent ([I] legacy uses consent placeholders; low priority).

### 2.3 Ministries list (`/ministries` → `Shared/CategoriesView.cshtml`) [V]
- **L**: `div.news-listing[role=complementary]#sidebar` (sic, the whole page) > `div.home-features` (ConnectSocialMedia + ResourceLinks) + `div.home-body[role=main]` > `h2 "News by Ministry"` + per ministry `div.grouped-articles > h3>a {name}` + `div.top-article`(PostCard) + `div.other-articles > div.feature-article + div.regular-articles` (first latest) + `div.news-control > a.load-more.link-button "Browse More News" + a.read-more "Search News"`. **Heavy**: about 25 ministries × 3 cards = 203 KB [V].
- **O**: h1 + `ul.post-list` of ministry name — minister [V].
- **Plan** [I]: legacy's look needs per-ministry top/feature/latest at build time (the builder already fetches per-ministry posts for ministry pages; the ministries page would need them too, so it becomes dependent on every ministry's posts → more rebuilds). A cheaper close match is a `grouped-articles` with name + latest headline only. The planner should decide.

### 2.4 Ministry page (`Shared/Ministry.cshtml`, `Minister.cshtml`, `CommContact`, `MoreFromThis`, `PopularTopics`, `Resources`, `NewsLetterLinks`, `MinisterOfState`) [V]
- **L**: `div.pt-2.ministry-listing` > `.access`.
  - Sidebar: `div.home-features[role=complementary]#sidebar` > `h3 {ministry name}` > `div.resource-links.minister` > `a[minister large pic]>img {photo}` `h3 {Honourable name}` `p {summary}` `a.read-more "Read Bio"` `h4 "Contact"` `p.minister-email "Email: …"` (sic: `Html.Raw`).
  - Body: `div.home-body#main-content-release[role=main]` > `h2.ministry-name-mobile` + top-article / feature-article / `div.other-articles > div.regular-articles` + `div.news-control` + `div.collapsible-regions` > "Media Contacts" (`span.contact-name`, Direct/Cell, mailto, "Alternate:", "After hours") + "More from this Ministry" + "Featured Topics" + "Featured Services" + newsletters + Minister of State. These are cloned into the sidebar by JS.
- Biography (`/ministries/{key}/biography`, `Biography.cshtml`): sidebar as above, body `div.biography-details > h2 {name} center.minister-bio-picture>img + details` + "All News From This Ministry".
- **O**: h1 name; `div.ministry-layout` grid with `aside` (Media Contacts / More from / Featured Topics / Featured Services, labels from settings) + content (h2 "Minister" + photo + summary + **full biography inline** + Top story/Featured/Latest news + archive/search links) [V PS/pages/categories.ts].
- **Plan**:
  - Move the minister card into the sidebar (`.resource-links.minister`).
  - Either render a `/ministries/{key}/biography/` page (new page type; legacy URL parity) or keep the inline bio below the cards.
  - Keep the settings-driven labels (`ministryPages`), emitting them in `.resource-links > h3`.
  - Factsheets link: legacy "More from this Ministry" starts with "Factsheets" (`{ministry}/factsheets`). We have no factsheets listing. Omit it.

### 2.5 Sector / theme / tag pages (`Shared/Sector.cshtml`) [V]
- **L**: `div.ministry-listing.sector-listing` > sidebar `h3 {name}` + ConnectSocialMedia; body: **top and feature are commented out** (only `regular-articles` show), news-control, collapsible-regions (Resources + News by Sector).
- `/sectors` index = CategoriesView sector variant (3 cards per sector).
- `/tags` → 302 to `/news-subscribe` [V]. No themes/tags index exists on live.
- **O**: h1 + top/feature/latest + archive/search links; **no `/sectors/` index page** [V site-paths.ts]. (Missing index = a page-type gap, not just look.)

### 2.6 Archive
- **L**: news.gov's nav and Resources link to `https://archive.news.gov.bc.ca/`, a separate site. There is no in-app archive view [V home links].
- **O**: `/archive/` year→month lists and month pages [V]. Style them with `.home-body` + PostCard-lite (`div.article > h2>a + div.item-date`) for consistency. There is no legacy look to match.

### 2.7 Search (`Default/SearchView.cshtml`) [V]
- **L**: `div.search > div.search-body` (h3 "Search", filters panel `div.search-panel.search-filters > div.search-filter > h5.open {facet}` + `div.search-filter-content > ul` checkboxes; date range via **bootstrap-datepicker + glyphicons**) + `div.home-body.search-results > div.search-panel > div.search-panel-bar (input + div.search-trigger)` + `div.search-numbers` + `div.article` PostCards + `div.search-pagination.bottom (a#prev / numbered / a#next)`. Search analytics uses `webanalytics_search.js` (Snowplow `trackSiteSearch`).
- **O**: h1, `form[role=search]` with label/input/select ministry, live regions, `ol#results` (JS builds `li > a + time + p`), prev/next nav [V].
- **Plan**: the script should emit `div.article` result cards and the `.search-panel-bar` look. Facets beyond ministry/sector are not available (§6.1/Q82). Drop the datepicker.

### 2.8 Subscribe + manage (`Views/Subscribe/*`) [V]
- **L**: `div.connect.subscribe` > `div.home-body#main-content-release` > h2 "Subscribe", notice of collection (`#noticeOfCollection`), `_SelectionPartial` (`div.expandable-section.collapsed` blocks "Media Advisories", "BC Gov News On Demand", "Newsletters" with `.expander-body`, `.article-fade`, `a.link-button.expand/collapse`), checkboxes `input.ministries-checkbox`, email `label.sr-only#emailAddress` + `input#emailAddress` (**duplicate id; the label is not programmatically associated** [V live]), `button#save.btn`, `label#message`. Script: `connect.js` (expand/collapse by hash).
- Manage: `div.connect.subscribe > div.home-body > h2 "Manage Subscription"` + buttons.
- **O**: h1, `form#subscribe-form` with a proper `label[for=email]`, `fieldset[data-category]>legend` per category, checkboxes built by JS, status/alert live regions [V].
- **Plan**: wrap in `div.connect.subscribe > div.home-body`. Style fieldsets as `.expandable-section` look-alikes using `<details>`/`<summary>` (no JS, accessible).

### 2.9 Connect (`Default/ConnectView.cshtml`, `Scripts/connect.js`) [V]
- **L**: `div.connect#connect-content` > `div.home-features[role=complementary]` (Resources) + `div.home-body[role=main]` > h2 "Connect" + policy link + per network `div.expandable-section.{network}[.collapsed|.expanded]` > `h3 "Find us on Facebook" i.fa-brands.fa-square-facebook.pull-right` > `div.expandable-section-content > div.expander-body > ul.external-links > li > a + span summary` + `div.article-fade` + `a.link-button.expand "Expand Facebook list"`/`a.link-button.collapse`. The heading bar is dark blue with white text [V screenshot]. `connect.js` expands the section matching `location.hash`.
- **O**: h1, `section[aria-labelledby={network}] > h2#{network} + ul.connect-list > li > a + p summary` [V], from settings.
- **Plan**: emit `.expandable-section` markup using `<details open>` (or all expanded) with the h3 bar style and brand icon. Keep the `id={network}` anchors (footer links use `/connect#x`).

### 2.10 Privacy (`Default/PrivacyView.cshtml`) [V]
- **L**: `div.connect > div.home-body > h3 "Privacy"` + **h1** "B.C. Government Website Privacy Statement" + static text + `#media-asset-preferences` (reset embed-consent cookie via `media-assets.js`).
- **O**: none. Footer "Privacy" links to www2.gov.bc.ca (both sites) [V].
- **[I]** Only needed if `/privacy` URL parity is required; static content page.

### 2.11 Live webcast (`Default/LiveView.cshtml`, `Components/WebCast/LiveVideoPlayer.cshtml`) [V]
- **L**: `div.connect > div.home-body > h3 "Live"` + `div#body.container` + Wowza/Akamai HLS player (`wowzaprod3-lh.akamaihd.net`, **http**), placeholder `Live_Webcast.png`, **moment.js 2.10.6 from cdnjs**. The Live button in the header shows via `/api/live/playlist` polling.
- **O**: none.
- **[I]** A static site cannot poll our own API for live state unless the News API exposes it. Treat as a separate feature, not look-and-feel.

### 2.12 Media contacts (`/contacts`, `Default/CommContacts.cshtml`) [V]
- **L**: `div.comm-contacts > h3.hidden-xs "Government Communications and Public Engagement"` + `div.header > h4 "24 hours Media Relations Contact Line"` + Bootstrap grid rows (`div.row > div.col-xs-12.col-sm-4`) with h4 columns Ministry / Primary Contact / Alternate Contact and `span.contact-name` (49 contacts [V]).
- **O**: none; our home "Resources → Media Contacts" links to `https://news.gov.bc.ca/contacts` [V ours/home.html]. **This breaks after cut-over** [I].

### 2.13 Newsletters (`Views/Newsletters/*`) [V]
- Live `/newsletters` → 302 to `/` [V]. **Retired; drop.**

### 2.14 Error / 404 [V]
- **L**: an unknown URL returns **404 with the search page rendered** (`div.search …`, no h1) [V legacy/404.html]. `ErrorView.cshtml` (500) is a bare page with no layout (`hgroup > h1 "Error" h2`).
- **O**: `404.html` exists (`h1 "Page not found"` + links) [V `/site/404.html` 200]. However, an unknown path under `boxs.ca/site/` returns **JSON `{"error":"not found"}`**, not 404.html [V ours/404.html, 21 bytes]. That is a hosting/mount bug to fix regardless of look.
- **Plan**: keep our 404 body inside the new chrome, with optional search box markup (`.search-panel-bar`) to echo legacy.

### 2.15 Sitemap page
- **L**: `SitemapView.cshtml` (no layout, `ul>li>a`). Live `/sitemap` is a **404** [V]. **Nothing to match**; our XML sitemaps suffice.

### 2.16 Factsheets / Office of the Premier
- `/factsheets` (200) and `/office-of-the-premier` (200) exist live [V], rendered by Sector/Ministry views. Ours has no factsheets listing and no top-level premier path. Flag for URL work (see `parity-inputs/url-compat.md`). They are not look-and-feel items.

---

## 3. Assets

### 3.1 Bring over (needed for the look) — sizes in bytes [V `ls -la`]

| Asset | Path in WA/wwwroot | Size | Notes |
|---|---|---|---|
| Bootstrap 5.3.3 CSS | lib/bootstrap5/css/bootstrap.min.css | 232,805 | MIT [V header]. [I] Could be cut to grid+utilities+navbar+collapse+forms with a Sass build later; vendor whole first |
| Bootstrap 5.3.3 JS bundle | lib/bootstrap5/js/bootstrap.bundle.min.js | 80,721 | MIT. Needed only for collapse (header menus). [I] Could be replaced by ~40 lines of vanilla JS + `aria-expanded` |
| site.css | Content/site.css | 70,060 | Apache-2.0 (repo LICENSE [V]). Many dead selectors (`#menu-container`, `.menu-content-item`, facebook/twitter feed, story-navigator, calendar) |
| custom.css | Content/custom.css | 13,507 | Includes BC Sans `@font-face` (url `../fonts/…`) and `:root` vars |
| transforms.css | Content/transforms.css | 25,641 | responsive overrides |
| accessibility-styles.css | Content/accessibility-styles.css | 1,468 | skip link / `.access` |
| print.css | Content/print.css | 3,751 | media=print; also has its own `@font-face` |
| components.css | Content/components.css | 120 | `.nav-link:hover` bg — trivial; fold into overrides |
| granville-bridge-theme.css | Content/granville-bridge-theme.css | 4,203 | load only when Blue Bridge is on |
| BC Sans woff2 ×6 | fonts/BCSans-{Regular,Italic,Bold,BoldItalic,Light,LightItalic}.woff2 | 253,988 / 201,800 / 209,332 / 215,600 / 223,740 / 200,236 (≈1.30 MB total) | **SIL OFL 1.1** (fonts/LICENSE_OFL.txt + FONTLOG_README.txt must ship alongside [V]). BC Sans 2.0 is derived from Noto Sans. [I] Only woff2 is needed (drop otf/ttf/woff ≈ 8 MB). Our monorepo already bundles the same woff2 for staff-web (`apps/staff-web/dist/assets/BCSans-*.woff2`) [V]. **Blocked by open question Q76** (brand/font licensing: `docs/parity/open-questions.md:70`) |
| BC logo (horizontal) | Content/Images/Gov/BCID_H_rgb_pos_LH_crop.svg | 15,011 | **BC Visual Identity mark: trademark/brand use, not Apache-2.0 content** [A: check with GCPE brand. This is exactly Q76] |
| BC mark (mobile) | Content/Images/Gov/BC_Mark.svg | 21,397 | same |
| Bridge logos | BCID_H_rgb_pos_LH_crop_bridge.svg / BC_Mark_bridge.svg | 18,566 / 21,376 | Blue Bridge only |
| Banner toggle icon | Content/Images/banner-toggle.svg | 1,192 | header (i) |
| Social icons | Content/Images/SocialMedia/{facebook-svg-logo,twitter-X-svg-logo,Instagram_logo_2016,threads_logo,bluesky-logo,linkedin-logo-blue,flickr-svg-logo,youtube,rss-logo}.svg | 442–4,334 each (≈11.3 KB total) | ConnectSocialMedia sidebar block. Third-party brand marks [A: brand-guideline use, as on legacy] |
| Default OG/related image | Content/Images/Gov/default-og-meta-image-1.jpg | 70,524 | release `.related-image` fallback and `og:image` |
| Carousel/story chevrons | Content/Images/arrow-left.png / arrow-right.png | 1,903 / 1,889 | `.story-nav` backgrounds [A: referenced from site.css; confirm with `grep arrow- site.css`] |
| article-fade.png | Content/Images/article-fade.png | 21,731 | only if collapsed sections are kept |
| favicon.ico | favicon.ico | — | |
| Icons | see 3.2 | | |

### 3.2 Font Awesome — two versions loaded at once [V]
- `Content/css/all.min.css` = **FA Free 6.4.2** (102,217 B). It references `Content/webfonts/fa-solid-900.woff2` (150,020), `fa-regular-400.woff2` (24,488), `fa-brands-400.woff2` (109,808) and `fa-v4compatibility.woff2` (4,568).
- `Content/fontawesome6/css/fontawesome.min.css` + `brands.min.css` = **FA Free 6.7.2** (56,777 + 14,574). It references `fontawesome6/webfonts/fa-brands-400.woff2` (118,684). Loaded later, so the 6.7.2 brands win, which supplies `fa-bluesky` [I from load order].
- Licence: icons CC BY 4.0, fonts OFL 1.1, code MIT [V header].
- Icons actually used in views [V grep]: fa-search, fa-times/fa-xmark, fa-angle-down/up, fa-bars, fa-caret-right, fa-download, fa-language, fa-print, fa-info-circle, fa-circle-exclamation/fa-exclamation-circle, fa-envelope, fa-rss, fa-blog, and brands (facebook, square-facebook, square-x-twitter, instagram, threads/square-threads, bluesky/square-bluesky, linkedin, flickr, youtube, weibo). That is about 25 glyphs.
- **Recommendation [I]**: replace both kits with ~25 inline SVG symbols (FA 6.7.2 SVGs, CC BY 4.0 attribution in a comment). This saves ≈ 450 KB of fonts+CSS and avoids icon-font accessibility pitfalls. The fallback is to vendor FA 6.7.2 `fontawesome.min.css` + `solid.min.css` + `brands.min.css` + their 2 woff2 files.

### 3.3 Dead — do not bring over [V unless marked]

| Asset | Why dead |
|---|---|
| covid-banner-style.css (1,394) | `.covid-banner`/`.alert-banner` appear in no view (`grep` hits only the `<link>` in _Layout) |
| covidcategory.css (3,219) | only for `/tags/covid-19?embed=true` |
| minimenu.css (7,161) + Scripts/minimenu.js | no `#mini-menu`/`.level-trigger` markup in any view. Still loaded in Production. It also contains `#BCGov-logo{padding-bottom:0}` inside a media block [V], so check nothing visual depends on it after removal (screenshot diff) |
| Content/bootstrap/* (Bootstrap 3 CSS/JS, bootstrap-theme, glyphicons), wwwroot/fonts/glyphicons-* | the layout uses `lib/bootstrap5`. Glyphicons only appear in SearchView's datepicker |
| bootstrap-datepicker.{js,min.js,min.css} | search date filter; our search has none |
| jquery-1.11.3.*, jquery-1.12.4.min.js | [I] not needed if behaviours are vanilla. **jQuery 1.12.4 has known XSS CVEs (CVE-2015-9251, CVE-2019-11358, CVE-2020-11022/-11023)** [A: CVE list from knowledge, not re-checked] |
| jquery.cookie.js | no `$.cookie(` call anywhere [V grep] |
| jquery.signalR-2.2.1 | only when SignalREnabled; static site cannot use it |
| css/site.min.css, js/site.min.js | 0-byte files |
| lib/bootstrap5/scss, *.map, rtl, grid/reboot/utilities split files | build sources |
| Placeholder/connect-*-banner.png (≈680 KB), Live-Thumbnail.png, BCID_White_Original.png, gov3_bc_logo.png, logo_bcgov_bcsans.png, `default-og-image - Copy.jpg`, legacy PNG sprites (footer_*button, search-ico*, chevron-*-search, media_button_*) | [A] unreferenced by current views/CSS. Confirm with `grep -r <name> Views Content Scripts` before deleting |
| Newsletters views/CSS | `/newsletters` retired (302 → /) |
| social-media.js, `_FacebookCard`, Facebook/Twitter feed CSS | [A] feeds removed from views. Verify with grep |

### 3.4 Third-party loads and analytics [V]
- **Snowplow** (`_WebAnalytics` → `Scripts/webanalytics.js`):
  - It loads `https://www2.gov.bc.ca/StaticWebResources/static/sp/sp-2-14-0.js` and posts to collector `spt.apps.gov.bc.ca`, `appId: "Snowplow_standalone"`.
  - It sets an 18-month cookie (`cookieLifetime: 86400*548`), with activity ping every 30s, link-click tracking and page views. The search variant adds `trackSiteSearch` on `q`.
  - This is BC Government's own Snowplow (not Google).
  - **Static-site action**: ship the same snippet only if GCPE confirms analytics must continue (it is a privacy/consent and continuity decision). Put it behind a tenant config flag (off for test sites). Self-host the snippet file rather than inline it if CSP is added.
- **cdnjs moment.js 2.10.6**: LiveVideoPlayer only. Drop.
- **Akamai/Wowza HLS** over `http:`: live webcast only. Out of scope.
- **Google Calendar iframe** (`EventCalendarPartialView`): [A] unused partial.
- **Share intents** (facebook.com/sharer, twitter.com/intent, threads.net, bsky.app): plain outbound links, no script loaded. Keep them.
- Fonts and CSS are otherwise self-hosted. No Google Fonts [V grep].
- The minister "large photo" link points to `www2.gov.bc.ca/assets/gov/.../minister-large/{first}_{last}_large.jpg` (built from the headline split) [V Minister.cshtml]. It is an outbound link only.

### 3.5 Licence notes
- Legacy repo: Apache-2.0 [V LICENSE]. The CSS/JS/markup can be vendored. Keep the NOTICE/attribution header in vendored files.
- Bootstrap: MIT. FA Free: CC BY 4.0 / OFL / MIT. BC Sans: OFL 1.1 (ship the licence + FONTLOG). jQuery: MIT (if kept).
- **The BC logos and BC Visual Identity are not covered by the code licence.** They are the substance of open question Q76. Until answered, the renderer must keep working without them (`logoFor` already gates on file presence [V static-pages.ts]). The legacy layout should fall back to the "BC Gov News" brand text with the divider.

---

## 4. Mapping our theme colours onto legacy CSS

**Legacy admin-screens model** (6 colours) [V Gov.News.Settings/SiteSettings.cs:110-118, _Layout:145-153]:
- `primary` → `--primary-blue`, `--info-blue`
- `text` → `--theme-text`
- `link` → `--theme-link`
- `footerBackground` → `--theme-footer-background`
- `bannerInfo` and `bannerEmergency` → inline style on `#site-banner`

The branch already replaced hard-coded colours with these variables: 61 `var(--` uses in site.css, 14 in custom.css, 5 in transforms.css, 2 in minimenu.css [V grep]. Mostly `#2d2d2d`→`var(--theme-text,#2D2D2D)` and `#003366`→`var(--theme-link,#003366)`.

**Our model** (10 colours) [V packages/site-settings/src/model.ts]: primary, primaryText, accent, text, mutedText, surface, background, border, bannerInfo, bannerEmergency. The BC tenant defaults are #013366, #FFFFFF, #FCBA19, #2D2D2D, #474543, #F2F2F2, #FFFFFF, #D8D8D8, #013366, #D8292F [V boxs.ca theme.css].

Proposed: `theme.css` keeps emitting our `--color-*` variables, **plus an alias block** that the vendored legacy CSS reads. Vendor the admin-screens versions of the CSS (they already use the variables). Then add the extra variables below for the legacy colours that the branch left hard-coded.

| Legacy variable / hard-coded colour [V] | Used for | Our token | Note |
|---|---|---|---|
| `--primary-blue`, `--info-blue` (#013366) | `.btn-primary-blue`, brand divider, `.info-blue-banner` default | `primary` | exact match on BC defaults |
| `--theme-text` (#2D2D2D) | body, nav, footer, headings | `text` | exact |
| `--theme-link` (#003366) | links, PostCard h2, `.link-button` bg | `primary` | [I] #003366 vs #013366 is visually identical. **Or add a `link` key** for 1:1 parity with the legacy admin (it was a separate field there). Planner's call |
| `--theme-footer-background` (#FFF) | `#footer` | `background` | legacy footer is white. Our current footer uses `surface` (grey), and that changes |
| `#site-banner` inline bg | info/emergency banner | `bannerInfo` / `bannerEmergency` | set the `background-color` from CSS classes (`.site-banner-info{background:var(--color-banner-info)}`) rather than inline style, so the static banner JSON needs no colour |
| `#FCBA19` (rgb 252,186,25) | land-ack borders, `live_button` border in bridge theme | `accent` | **exact match** with our BC accent #FCBA19. Add `var(--color-accent)` in an override |
| `#666` | `.item-date` | `mutedText` | ours is darker (#474543), which is better contrast. [I] #666 on white is 5.7:1, fine either way |
| `#F1F1F1`/`#F2F2F2` | `.news-control`, `.media-container`, mobile menu hover | `surface` | close match |
| `#D9D9D9`/`#D7D7D7` | header bottom border, nav hover | `border` | close match |
| `#FFFFFF` on banners/buttons | text on primary | `primaryText` | |
| `#313132` | land-ack band | — | not themeable in legacy either. Keep fixed (or later add a token) |
| `#38598A`, `rgba(0,51,102,.83)` | connect heading bars, carousel story box | — / `primary` | [I] derive with `color-mix(in srgb, var(--color-primary) 83%, transparent)` |
| `#395CCF` | focus border (skip link, search input) | — | our `:focus-visible{outline:3px solid var(--color-accent)}` should **override** legacy focus styles (keep it last) |

How it is delivered: `themeCss()` appends `:root{--primary-blue:var(--color-primary);--info-blue:var(--color-primary);--theme-text:var(--color-text);--theme-link:var(--color-primary);--theme-footer-background:var(--color-background)}` + a small override sheet. The vendored legacy CSS stays a separate static file (`assets/legacy/*.css`). Only `theme.css` changes when an admin edits colours, so the existing "theme change rewrites theme.css only" path keeps working [V static-pages.ts: theme.css written with the static page]. Load order: legacy bundle → `theme.css` (aliases + overrides).

---

## 5. Accessibility: where verbatim legacy markup would regress us (WCAG 2.1 AA)

All the "Legacy" observations are [V] from the fetched live pages and source. Each "Minimal deviation" keeps the legacy classes so the CSS still applies.

| # | Legacy | WCAG | Minimal deviation |
|---|---|---|---|
| 1 | No `<h1>` on 17 of 18 fetched pages. The release headline is `h2.story-lang.primary`; listing pages start at `h3` | 1.3.1, 2.4.6 | Emit `<h1 class="story-lang primary">` (and `h1.ministry-name-mobile`, etc.). Add `h1` to the selectors in an override (`.story-page h1{font-size:36px;font-weight:600;…}`). Demote staff body headings as today (`demoteHeadings`) |
| 2 | `<title>` is always "BC Gov News" | 2.4.2 | Keep our `{page} \| {site}` titles |
| 3 | `div[role=main]` nested inside `<main>`. `role=complementary` sometimes wraps the whole page (CategoriesView). `#footer` has `role=navigation` | 1.3.1, 4.1.2 | One `<main id="main">`. Put `#main-content-release` as an id on the inner `.home-body` div without a role. Use `<aside>` for `.home-features`, `<footer id="footer">` with a `<nav aria-label="Footer">` around the link columns |
| 4 | Two skip-link blocks per page. The target `#main-content-release` is missing on 7 page types. Skip-to-footer uses `onclick="window.scrollTo(0,0)"` | 2.4.1 | Keep our single `a.skip-link[href=#main]`, styled with legacy accessibility-styles.css |
| 5 | `role="menu"`/`role="menuitem"` on footer lists and ministry mega-menu (60 per page) without the arrow-key menu pattern | 4.1.2 | Plain `ul/li/a` |
| 6 | `img` without `alt`: banner-toggle.svg, live-cast-button.svg (2–3 per page; 23 on /ministries) | 1.1.1 | `alt=""` inside a labelled button (`aria-label="Show site notice"`) |
| 7 | Controls that are not focusable or are not buttons: `a#bannerToggleLink`, `a.banner-toggle-btn`, `a#btnCloseBannerBridge` (no href); live `a#btnCloseBanner` had no href [V live]; `span.search-trigger` as submit; carousel story `div[onClick]`; `div.story-nav` prev/next; `.language-selector a`, `.print-document a`, `.search-panel-trigger` without href | 2.1.1, 4.1.2 | `<button type="button">` (or `type=submit` for search) with the same classes. Make the carousel story a real `<a>` around the headline |
| 8 | "News" dropdown is `<a href="#" data-bs-toggle="collapse">` without `aria-controls`. Duplicate ids (`main-nav`, `search-md-button`, `ministry-dropdown`, subscribe `emailAddress`) | 4.1.1/4.1.2 | `<button aria-expanded aria-controls="menu">`, unique ids |
| 9 | Auto-rotating carousel (15s, no pause) | 2.2.2 | Already decided: C205 (static slides) [V docs/parity/changes-from-legacy.md:277] |
| 10 | Subscribe email: `label.sr-only#emailAddress` not associated with `input#emailAddress` | 1.3.1, 3.3.2, 4.1.2 | Keep our `label[for=email]` |
| 11 | Connect page collapses lists behind a gradient (`.article-fade`). The 2nd+ links render faded (very low contrast) yet are still focusable [V screenshot] | 1.4.3, 2.4.7 | `<details>` per network, open by default or closed with **no** fade overlay |
| 12 | Long URLs in release bodies overflow at 390px [V legacy-release-390] | 1.4.10 | `.story-copy a{overflow-wrap:anywhere}` |
| 13 | Footer and sidebar headings are h4/h3 with no h2 parent | 1.3.1 | `h2` with legacy class styling (`#footer h2` added to the `#footer h4` rule) |
| 14 | Focus styles suppressed: `.nav-link:focus{background-color:transparent!important}`, `#site-search-input:focus{box-shadow:none!important}` | 2.4.7 | Keep our `:focus-visible` outline rule loaded **after** the legacy CSS |
| 15 | Body text 13px | (not a fail; 1.4.4 resize works) | Keep for parity. The release copy is already 18px |
| 16 | Translations links `target=_blank download` with no warning; `aria-lable` typo on print | 3.2.5 advisory | Drop `target=_blank` for downloads |
| 17 | Banner links `target=_blank` | advisory | Same-window links. Keep `role=alert` only for emergency (as now) |
| 18 | `<!--googleoff/on-->` comments | n/a | Harmless. Omit |

---

## 6. Recommended approach and chunks

**Approach.** Vendor the legacy CSS under `config/site/assets/legacy/` (or a package the builder copies into `assets/`):
- Bootstrap 5.3.3 min, site, custom, transforms, accessibility, print, granville, plus a tiny `overrides.css`.
- BC Sans woff2 + licence (pending Q76).
- An SVG icon sprite.

Change `renderPage` to emit the legacy chrome skeleton, and change each `pages/*.ts` to emit the legacy body skeleton with the §5 deviations. Write ~1 small vanilla JS file (menu/search/banner toggles, FR toggle, banner builder) instead of jQuery. `theme.css` = our vars + legacy aliases + overrides (§4).

[I] This is less work and closer to the original than re-authoring the CSS, because the 3.5k-line site.css encodes dozens of measured spacings that are hard to reproduce by eye.

Chunks ordered by visibility (each chunk independent once chunk 1 lands):

1. **Asset pipeline + head.**
   - Copy the vendored CSS/fonts/icons into the site's `assets/` on build. Add the `<link>`s in `renderPage` in legacy order, then `theme.css`. Add favicon.
   - Verify:
     - Unit test that the head contains the links in that order.
     - `curl` each asset URL on boxs.ca returns 200 with the right content-type.
     - Font loads (DevTools: `document.fonts.check('16px BCSans')` true).
2. **Header + footer + land acknowledgement chrome.**
   - Legacy skeleton (§1.2) with the §5 deviations. Ministry list in the mega-menu from the ministries DTO (needs a rebuild-all when the ministry set changes).
   - Search form posts to `/search/`. Logo is optional until Q76 is answered.
   - Verify:
     - HTML structure tests (`header#main-nav .navbar-brand`, `#menu ul li a` count = active top-level ministries, single `main#main`, one skip link, `footer#footer .footer-bc/.footer-connect/.footer-more-info`, no `role=menu`).
     - Screenshot diff vs news.gov at 1280 and 390 (header and footer crops).
     - Keyboard pass: Tab reaches News/Subscribe/search, Enter opens the menu, Esc/2nd press closes, focus visible.
3. **Theme mapping (§4).**
   - `themeCss` emits the aliases and overrides. Banner colours come from classes.
   - Verify:
     - theme-css.test: aliases present.
     - Change `primary` in the admin → only `theme.css` changes; computed colour of `.navbar-brand` border and PostCard h2 links follows.
     - Contrast check still enforced.
4. **Site banner + Blue Bridge.**
   - The banner script builds the `.info-blue-banner` skeleton with a `<button>` close and the (i) toggle. Blue Bridge emits `#bridge-banner.info-black-banner`, loads granville-bridge-theme.css, and swaps logos when available.
   - Verify:
     - jsdom tests (existing banner-script.test pattern) for the class skeleton and button.
     - Screenshot of a published info and an emergency banner vs news.gov.
5. **Home page.**
   - `.home-features` (Connect icons, Resources) + `.home-body` PostCards (top/feature/regular). Static carousel strip in `#carousel-holder`. "More news"/"Search news" `.news-control` (no AJAX). Collapsible regions after the list on mobile via CSS.
   - Verify:
     - Structure tests (`.top-article .article h2 a`, `.item-date`, `.read-more`, exactly one h1).
     - Screenshot diff at 1280/390.
     - axe-core run: 0 serious/critical.
6. **Release page.**
   - `.story-page` header (ministry link, h1, subheadline), `.story-features` sidebar (Translations, Share hrefs, PageTitle/location/date, Media Contacts, More from / Topics / Services), `.story-body` copy, `#assets` lists, `.media-container` related band. FR toggle script only when a French doc exists. Print link as a button.
   - Verify:
     - Structure tests (share hrefs URL-encoded; translations list).
     - Screenshot diff for 2026HLTH0085-style post with translations.
     - Print preview shows the legacy print layout.
     - Reflow at 320px has no horizontal scroll.
7. **Ministry page (+ biography).**
   - Sidebar minister card + labelled side blocks from settings. Body cards. Optionally a `/ministries/{key}/biography/` page.
   - Verify:
     - categories.test structure.
     - Screenshot diff vs `/ministries/health`.
8. **Ministries index, sector/theme/tag pages, `/sectors/` index.**
   - `.grouped-articles` / `.sector-listing` markup.
   - Verify: structure tests, screenshot diff vs `/ministries` and `/sectors/economy`.
9. **Connect, subscribe/manage, search, archive, 404 restyle.**
   - Wrappers `div.connect…`, `<details>`-based expandable sections, search result cards (`div.article`), archive lists in `.home-body`, 404 inside chrome.
   - Verify:
     - Existing tests updated.
     - axe run.
     - Screenshot diff for connect and subscribe.
     - **Fix `/site/<unknown>` returning JSON instead of 404.html** (host mount) and check `curl -o /dev/null -w %{http_code}` = 404 with an HTML body.
10. **Cleanup and optional extras.**
    - Analytics flag (Snowplow, if GCPE confirms). Media-contacts page (`/contacts`) to replace the link to news.gov. Privacy page if `/privacy` parity is wanted. Trim unused CSS (PurgeCSS against rendered pages) once the look is approved.
    - Verify: Lighthouse a11y ≥ current score, total CSS transfer size reported before and after.

Suggested verification harness (all chunks): a Playwright script that loads the same 6 URLs on news.gov and the local build at 1280×900 and 390×844, saves full-page PNGs, and reports a pixel-diff percentage per region (header, banner, main, footer). It also runs `@axe-core/playwright` on ours only. Expect content-driven differences in `main` (different posts), so diff chrome regions strictly and main loosely.

---

## Risks / not checked

- **Q76 is the blocking decision.** Without BC Sans and the BC logo, the site will not look like news.gov regardless of CSS. I verified that the files exist and their licences (OFL for the font; the logo licence is unknown). Their legal clearance is unverified.
- **Not measured:**
  - legacy pages at 768–1023px (tablet layout); only 1280 and 390 were captured;
  - subscribe, search, privacy and contacts were not screenshotted (HTML only);
  - computed styles were captured for home and release only.
- **Dead-asset claims marked [A]** need the stated `grep` before deletion.
- **Live news.gov is not on admin-screens**, so the live colours are the hard-coded defaults. The admin-screens CSS variables were read from source, not seen rendered.
- **Ministry mega-menu on every page** makes every page depend on the ministry list: a ministry rename means a full rebuild (C207 tick-based) [I].
- **jQuery CVEs** are from memory [A]. They are moot if jQuery is dropped as recommended.
