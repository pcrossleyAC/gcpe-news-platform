import type { SiteTheme } from "@gcpe/config";
import { escapeHtml, isSafeUrl } from "@gcpe/http-kit";
import type { LinkSetting, SiteSettings } from "@gcpe/site-settings";
import { SITE_BANNER_SCRIPT } from "./banner-script";
import { DEFAULT_TIME_ZONE, settingsHref, themeDefaults, yearIn } from "./settings";
import { DEFAULT_THEME } from "./theme-css";

export type { PostDocument, PostDto } from "./dto";

export interface SiteInfo {
  name: string;
  baseUrl: string;
  /** Tenant `site.theme`; DEFAULT_THEME when absent. */
  theme?: SiteTheme;
  /** Set by start.ts only when the logo file exists under SITE_ASSETS_DIR (static-pages.ts's logoFor). */
  logo?: { src: string; alt: string } | null;
  /** The tenant's IANA time zone (the footer's copyright year); DEFAULT_TIME_ZONE when absent. */
  timeZone?: string;
}

export interface PageOptions {
  /** A test site gets `<meta name="robots" content="noindex, nofollow">` (@gcpe/config's isTestSite). */
  test?: boolean;
  /** Project Blue Bridge's banner text (site-env.ts's blueBridgeBanner), or null/absent for none. */
  banner?: string | null;
  description?: string | null;
  /** The page's RSS feed, linked as an alternate. */
  feed?: { href: string; title: string } | null;
  /** The site settings this turn applies (settings.ts's currentSettings): footer, connect page,
   * theme colours, banner JSON, ministry page headings. Absent ⇒ derived from the site's theme. */
  settings?: SiteSettings;
}

export const e = (s: string | null | undefined): string => escapeHtml(s ?? "");

/**
 * `e()` for text and attribute values written into an RSS feed or sitemap (`feeds.ts`,
 * `sitemaps.ts`). `escapeHtml`'s five entities are all valid XML, but XML 1.0's `Char`
 * production additionally excludes the C0 control characters other than tab, LF and CR, and the
 * U+FFFE/U+FFFF noncharacters — a document containing one of those is not well-formed, and
 * `escapeHtml` alone would let it through. The underlying value (a headline, a summary, a path)
 * can be arbitrary NRMS free text, so every such value is stripped before it's escaped.
 */
const XML_ILLEGAL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
export const ex = (s: string | null | undefined): string => e((s ?? "").replace(XML_ILLEGAL_CHARS, ""));

/** Gates every `href` built from News API data (a ministry URL, a resource link, an asset or
 * translation file, a slide's action link) before it's escaped with `e()`. `isSafeUrl`
 * (`@gcpe/http-kit`, shared with `@gcpe/config`'s theme validation) is the single source of
 * truth for what's safe — see its doc comment for why a bare "starts with / and not //" check
 * isn't enough (the backslash-as-separator bypass). */
export const safeHref = (u: string | null | undefined): string | null => (isSafeUrl(u, { mailto: true }) ? (u as string) : null);

/** Gates every `src` built from News API data (an asset image, the minister's photo) before it's
 * escaped with `e()` — same as {@link safeHref} but never `mailto:`, which cannot load as an
 * image. */
export const safeSrc = (u: string | null | undefined): string | null => (isSafeUrl(u) ? (u as string) : null);

/** The base URL's path with no trailing slash: "" at a root base, "/site" on boxs.ca. */
export function basePath(site: Pick<SiteInfo, "baseUrl">): string {
  return new URL(site.baseUrl).pathname.replace(/\/+$/, "");
}

/** Every page's chrome (spec §6.3): skip link, header with brand and nav, main, footer. */
/** The head's inline script: marks `<html>` as `.js` before any CSS applies, so stylesheets can
 * keep no-JS fallbacks under `html:not(.js)` without a flash. A constant: nothing is interpolated. */
export const HTML_JS_MARKER = 'document.documentElement.classList.add("js")';

export function renderPage(title: string, site: SiteInfo, canonicalPath: string, body: string, opts: PageOptions = {}, bodyAttr = ""): string {
  const base = basePath(site);
  const theme = site.theme ?? DEFAULT_THEME;
  const robots = opts.test ? `\n<meta name="robots" content="noindex, nofollow">` : "";
  const description = opts.description ? `\n<meta name="description" content="${e(opts.description)}">` : "";
  // Defence in depth: the tenant config schema (`@gcpe/config`'s siteThemeSchema) already
  // restricts stylesheetUrl to https:/relative, but render time doesn't re-trust config-time
  // validation for anything else that reaches an href/src — this shouldn't either.
  const fontHref = theme.font.stylesheetUrl && isSafeUrl(theme.font.stylesheetUrl, { schemes: ["https:"] }) ? theme.font.stylesheetUrl : null;
  const font = fontHref ? `\n<link rel="stylesheet" href="${e(fontHref)}">` : "";
  const feed = opts.feed ? `\n<link rel="alternate" type="application/rss+xml" title="${e(opts.feed.title)}" href="${e(opts.feed.href)}">` : "";
  // Legacy loads the Granville Bridge theme only while Project Blue Bridge is on.
  const bridgeCss = opts.banner ? `\n<link rel="stylesheet" href="${e(base)}/assets/legacy/Content/granville-bridge-theme.css">` : "";
  const banner = opts.banner ? `\n<div class="blue-bridge-banner" role="alert">${e(opts.banner)}</div>` : "";
  const brand = site.logo
    ? `<img class="logo" src="${e(site.logo.src)}" alt="${e(site.logo.alt)}"><span class="wordmark">${e(site.name)}</span>`
    : `<span class="wordmark">${e(site.name)}</span>`;
  const settings = opts.settings ?? themeDefaults(theme);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} | ${e(site.name)}</title>
<link rel="canonical" href="${e(new URL(site.baseUrl).origin + canonicalPath)}">${robots}${description}
<link rel="icon" href="${e(base)}/favicon.ico">
<script>${HTML_JS_MARKER}</script>
<link rel="stylesheet" href="${e(base)}/assets/legacy/lib/bootstrap5/css/bootstrap.min.css">
<link rel="stylesheet" href="${e(base)}/assets/legacy/Content/site.css">
<link rel="stylesheet" href="${e(base)}/assets/legacy/Content/custom.css">
<link rel="stylesheet" href="${e(base)}/assets/legacy/Content/transforms.css">
<link rel="stylesheet" href="${e(base)}/assets/legacy/Content/accessibility-styles.css">
<link rel="stylesheet" href="${e(base)}/assets/legacy/Content/print.css" media="print">${bridgeCss}
<link rel="stylesheet" href="${e(base)}/assets/site/overrides.css">
<link rel="stylesheet" href="${e(base)}/assets/theme.css">${font}${feed}
</head>
<body${bodyAttr}>
<a class="skip-link" href="#main">Skip to main content</a>${banner}
<div id="site-banner" hidden data-base="${e(base)}"></div>
<script>${SITE_BANNER_SCRIPT}</script>
<header class="site-header">
<a class="brand" href="${e(base)}/">${brand}</a>
<nav aria-label="Site">
<ul>
<li><a href="${e(base)}/">Home</a></li>
<li><a href="${e(base)}/ministries/">Ministries</a></li>
<li><a href="${e(base)}/archive/">Archive</a></li>
<li><a href="${e(base)}/search/">Search</a></li>
</ul>
</nav>
</header>
<main id="main" tabindex="-1">
${body}
</main>
${renderFooter(settings, site)}
</body>
</html>
`;
}

/** A settings link: an anchor (with its analytics id) when the URL is safe, else its text. */
export function settingsLink(l: LinkSetting, site: Pick<SiteInfo, "baseUrl">): string {
  const href = settingsHref(l.url, site);
  const id = l.id ? ` id="${e(l.id)}"` : "";
  return href ? `<a${id} href="${e(href)}">${e(l.text)}</a>` : e(l.text);
}

/** The links in news.gov's help sentence: all but the last two followed by ",", the
 * second-last by ", or", the last by "." */
function helpSentence(links: LinkSetting[], site: SiteInfo): string {
  return links.map((l, i) => settingsLink(l, site) + (i === links.length - 1 ? "." : i === links.length - 2 ? ", or" : ",")).join(" ");
}

const linkList = (links: LinkSetting[], site: SiteInfo) => links.map((l) => `<li>${settingsLink(l, site)}</li>`).join("\n");

/** Every page's footer, from the site settings (spec "Delivery": a change rebuilds every page). */
function renderFooter(settings: SiteSettings, site: SiteInfo): string {
  const f = settings.footer;
  const help = [f.helpText ? e(f.helpText) : "", helpSentence(f.helpLinks, site)].filter(Boolean).join(" ");
  const column = (cls: string, heading: string, links: LinkSetting[]) => (links.length ? `<div class="${cls}">\n<h2>${heading}</h2>\n<ul>\n${linkList(links, site)}\n</ul>\n</div>` : "");
  const columns = [column("footer-connect", "Connect with Us", f.connectLinks), column("footer-more-info", "More Info", f.moreInfoLinks)].filter(Boolean).join("\n");
  const year = yearIn(site.timeZone ?? DEFAULT_TIME_ZONE, new Date());
  return `<footer class="site-footer">
${help ? `<p class="footer-help">${help}</p>\n` : ""}${columns ? `<div class="footer-columns">\n${columns}\n</div>\n` : ""}<p class="copyright">© ${e(year)} ${e(f.copyrightHolder)}</p>
</footer>`;
}
