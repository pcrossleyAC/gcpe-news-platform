import { icon } from "./icons";
import { basePath, e, type PageOptions, type SiteInfo } from "./render";

const LOGO_ALT = "Government of B.C.";

/**
 * Every page's header: the legacy `_Layout` skeleton (look-and-feel §1.2) with the §5 deviations —
 * one News control and one ministry list for both widths (no `#sm-menu`), no `role=menu`, unique
 * ids, real buttons for every toggle, labelled search inputs and no Live button (plan 4 adds it).
 * Legacy's banner toggle — the (i) beside the hamburger on a phone, `#bannerToggleLink` in the nav
 * list from md up — is a pair of real buttons (`data-banner-toggle`, `aria-controls="banner"`)
 * whose wrappers start hidden; site.js shows them once a banner has been shown and they then hide
 * and re-show `#banner`.
 *
 * Without JavaScript "News" is a plain link to the ministries page; `site.js` (site-script.ts)
 * turns it into the `#menu` toggle, and only when `#menu` exists, which needs a non-empty
 * `ministryMenu`. overrides.css shows the collapsed phone nav and search drawer under
 * `html:not(.js)`, so Subscribe and search stay reachable with no script. On the search page
 * (`pageSearchInput`) the phone search control is a plain link to the page's own box, so it works
 * with no script too.
 */
export function renderHeader(site: SiteInfo, opts: PageOptions): string {
  const base = e(basePath(site));
  const gov = `${base}/assets/legacy/Content/Images/Gov`;
  const bridge = opts.banner ? "_bridge" : "";
  const menu = opts.ministryMenu?.length ? opts.ministryMenu : null;
  const news = `<a id="news-dropdown" class="nav-link" href="${base}/ministries/"${menu ? ` data-menu="menu"` : ""}>News</a>`;
  const searchForm = (cls: string, id: string) => `<form class="${cls}" role="search" aria-label="Site search" action="${base}/search/" method="get">
<label class="visually-hidden" for="${id}">Search news</label>
<div class="input-group">
<input name="q" id="${id}" type="text" class="form-control">
<button type="submit" class="input-group-text btn-primary-outline search-trigger" aria-label="Search">${icon("search", base)}</button>
</div>
</form>`;
  const menuPanel = menu
    ? `
<div id="menu" class="container-fluid collapse">
<div class="menu container-xl">
<h2 class="list-title">By Ministry</h2>
<ul>
${menu.map((m) => `<li><a href="${base}/ministries/${e(encodeURIComponent(m.key))}/">${e(m.name)}</a></li>`).join("\n")}
</ul>
</div>
</div>`
    : "";
  // The search page has its own form, so the header's search forms and drawer are left off there,
  // as legacy does. Legacy still shows the phone toggle there (R12): ours keeps it, in the same
  // slot with the same look, as a link to the page's own box; site.js focuses that box on click.
  const pageSearch = opts.pageSearchInput;
  const search = !pageSearch;
  const toggleIcon = icon("search", base);
  const searchToggle = search
    ? `<div class="search-toggle-container d-lg-none">
<button type="button" id="search-md-button" class="input-group-text btn-primary-outline search-md menu-icon" aria-controls="smd-search-container" aria-expanded="false" aria-label="Search">${toggleIcon}</button>
</div>
`
    : `<div class="search-toggle-container d-lg-none page-search">
<a id="search-md-button" class="input-group-text btn-primary-outline search-md menu-icon" href="#${e(pageSearch)}" aria-label="Search" data-page-search>${toggleIcon}</a>
</div>
`;
  const desktopSearch = search ? `${searchForm("d-flex search d-none d-lg-block", "mini-site-search-input")}
` : "";
  const searchDrawer = search
    ? `
<div id="smd-search-container" class="container-fluid collapse d-lg-none">
${searchForm("search", "site-search-input")}
</div>`
    : "";
  const toggleImg = `<img src="${base}/assets/legacy/Content/Images/banner-toggle.svg" alt="">`;
  const toggleAttrs = `type="button" aria-controls="banner" aria-expanded="false" aria-label="Site notices" data-banner-toggle`;
  return `<header id="main-nav" class="container-fluid sm-g-0 header nav-border">
<div id="main-nav-container" class="container-xl sm-g-0">
<nav class="navbar navbar-expand-md" aria-label="Main menu">
<a href="https://gov.bc.ca"><img id="BCGov-logo" class="d-none d-md-block" src="${gov}/BCID_H_rgb_pos_LH_crop${bridge}.svg" alt="${LOGO_ALT}"><img id="sm-BCGov-logo" class="d-md-none" src="${gov}/BC_Mark${bridge}.svg" alt="${LOGO_ALT}"></a>
<a class="navbar-brand ps-3" href="${base}/">${e(site.name)}</a>
<div class="d-md-none banner-toggle-container" hidden><button id="banner-toggle-sm" class="btn btn-link banner-toggle-btn" ${toggleAttrs}>${toggleImg}</button></div>
<button type="button" id="nav-menu-sm" class="navbar-toggler collapse-menu-icon menu-icon" aria-controls="navbarSupportedContent" aria-expanded="false" aria-label="Menu">${icon("bars", base)}</button>
${searchToggle}<div id="sm-nav-container" class="container-fluid">
<div id="navbarSupportedContent" class="collapse navbar-collapse">
<ul id="sm-nav-ul" class="navbar-nav ms-auto mb-2 me-3 mb-lg-0 gap-2">
<li id="ministry-dropdown" class="nav-item ministry-dropdown">${news}</li>
<li class="nav-item"><a class="nav-link" href="${base}/subscribe/">Subscribe</a></li>
<li class="nav-item-link d-none d-md-block" hidden><button id="bannerToggleLink" class="nav-link" ${toggleAttrs}>${toggleImg}</button></li>
</ul>
</div>
${desktopSearch}</div>
</nav>
</div>${searchDrawer}${menuPanel}
</header>`;
}
