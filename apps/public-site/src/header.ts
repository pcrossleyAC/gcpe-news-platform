import { icon } from "./icons";
import { basePath, e, type PageOptions, type SiteInfo } from "./render";
import { settingsHref, themeDefaults } from "./settings";

const LOGO_ALT = "Government of B.C.";

/**
 * The broadcast glyph of legacy's phone/tablet Live button (`Content/Images/live-cast-button.svg`,
 * Apache-2.0: its five white paths verbatim, in the 16px box they sit in), drawn in currentColor so the button's
 * themed background shows behind it instead of the file's fixed #013366 square.
 */
const LIVE_GLYPH = `<svg class="live-glyph" viewBox="12 12 16 16" aria-hidden="true" focusable="false" fill="currentColor"><path d="M14.6327 17.1333C14.2884 17.9825 14.0983 18.9104 14.0983 19.8874C14.0983 20.8644 14.2884 21.7923 14.6327 22.6415C14.8491 23.1792 14.59 23.789 14.0524 24.0087C13.5147 24.2283 12.9049 23.9661 12.6852 23.4284C12.2426 22.3333 12 21.1366 12 19.8874C12 18.6382 12.2426 17.4415 12.6852 16.3465C12.9049 15.8088 13.5147 15.5497 14.0524 15.7661C14.59 15.9825 14.8491 16.5956 14.6327 17.1333ZM28 19.8888C28 18.6396 27.7574 17.4429 27.3148 16.3478C27.0951 15.8101 26.4853 15.5478 25.9476 15.7675C25.41 15.9872 25.1509 16.597 25.3673 17.1347C25.7116 17.9839 25.9017 18.9117 25.9017 19.8888C25.9017 20.8658 25.7116 21.7937 25.3673 22.6428C25.1509 23.1805 25.41 23.7936 25.9476 24.01C26.4853 24.2264 27.0984 23.9674 27.3148 23.4297C27.7574 22.3346 28 21.1379 28 19.8888ZM24.6425 20.1833C24.6425 19.3728 24.4618 18.598 24.1351 17.8948C23.9131 17.4121 23.3138 17.1945 22.8 17.4031C22.2862 17.6117 22.0516 18.1749 22.2767 18.6576C22.4924 19.1225 22.6129 19.638 22.6129 20.1833C22.6129 20.7286 22.4924 21.2441 22.2767 21.709C22.0516 22.1917 22.2862 22.7519 22.8 22.9635C23.3138 23.1751 23.91 22.9545 24.1351 22.4718C24.4618 21.7686 24.6425 20.9938 24.6425 20.1833ZM17.2982 20.1846C17.2982 19.6393 17.4187 19.1238 17.6343 18.6589C17.8595 18.1762 17.6248 17.616 17.111 17.4044C16.5973 17.1928 16.0011 17.4133 15.7759 17.8961C15.4493 18.5993 15.2685 19.3741 15.2685 20.1846C15.2685 20.9951 15.4493 21.7698 15.7759 22.4731C15.9979 22.9558 16.5973 23.1733 17.111 22.9648C17.6248 22.7562 17.8595 22.193 17.6343 21.7102C17.4187 21.2454 17.2982 20.7299 17.2982 20.1846ZM21.2514 20.1839C21.2514 20.8609 20.7026 21.4096 20.0257 21.4096C19.3488 21.4096 18.8 20.8609 18.8 20.1839C18.8 19.507 19.3488 18.9583 20.0257 18.9583C20.7026 18.9583 21.2514 19.507 21.2514 20.1839Z"/></svg>`;

/**
 * Every page's header: the legacy `_Layout` skeleton (look-and-feel §1.2) with the §5 deviations —
 * one News control and one ministry list for both widths (no `#sm-menu`), no `role=menu`, unique
 * ids, real buttons for every toggle and labelled search inputs. The News label, the header links
 * (after News), the search controls and the Live button's label come from `navigation` in the site
 * settings; a header link with an unsafe URL is plain text. The Live button (legacy's phone/tablet icon button right after the brand, named by the label, and the desktop `#live-button` after `#sm-nav-container`) is hidden until site.js
 * finds `assets/live.json` saying the webcast is on (`live_button_hide` → `live_button_show`).
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
  const nav = (opts.settings ?? themeDefaults(site.theme)).navigation;
  const news = `<a id="news-dropdown" class="nav-link" href="${base}/ministries/"${menu ? ` data-menu="menu"` : ""}>${e(nav.newsLabel)}</a>`;
  const headerLinks = nav.headerLinks
    .map((l) => {
      const href = settingsHref(l.url, site);
      const id = l.id ? ` id="${e(l.id)}"` : "";
      return `<li class="nav-item">${href ? `<a${id} class="nav-link" href="${e(href)}">${e(l.text)}</a>` : e(l.text)}</li>`;
    })
    .map((li) => `\n${li}`)
    .join("");
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
  const search = !pageSearch && nav.showHeaderSearch;
  const toggleIcon = icon("search", base);
  // Search off: no toggle at all, except the search page's own link to its own box.
  const searchToggle = !nav.showHeaderSearch && !pageSearch
    ? ""
    : search
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
<a href="${base}/live/" class="btn btn-primary-blue live_button live_button_hide live-icon-button d-lg-none">${LIVE_GLYPH}<span class="visually-hidden">${e(nav.liveLabel)}</span></a>
<div class="d-md-none banner-toggle-container" hidden><button id="banner-toggle-sm" class="btn btn-link banner-toggle-btn" ${toggleAttrs}>${toggleImg}</button></div>
<button type="button" id="nav-menu-sm" class="navbar-toggler collapse-menu-icon menu-icon" aria-controls="navbarSupportedContent" aria-expanded="false" aria-label="Menu">${icon("bars", base)}</button>
${searchToggle}<div id="sm-nav-container" class="container-fluid">
<div id="navbarSupportedContent" class="collapse navbar-collapse">
<ul id="sm-nav-ul" class="navbar-nav ms-auto mb-2 me-3 mb-lg-0 gap-2">
<li id="ministry-dropdown" class="nav-item ministry-dropdown">${news}</li>${headerLinks}
<li class="nav-item-link d-none d-md-block" hidden><button id="bannerToggleLink" class="nav-link" ${toggleAttrs}>${toggleImg}</button></li>
</ul>
</div>
${desktopSearch}</div>
<a id="live-button" href="${base}/live/" class="btn btn-primary-blue live_button live_button_hide d-none d-lg-block">${e(nav.liveLabel)}</a>
</nav>
</div>${searchDrawer}${menuPanel}
</header>`;
}
