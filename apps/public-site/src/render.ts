import type { SiteTheme } from "@gcpe/config";
import { escapeHtml, isSafeUrl } from "@gcpe/http-kit";
import type { LinkSetting, SiteSettings } from "@gcpe/site-settings";
import { SITE_BANNER_SCRIPT } from "./banner-script";
// bootstrap, site, custom, transforms and accessibility-styles, in legacy order, as one file.
import { LEGACY_BUNDLE } from "./legacy-bundle";
import { DEFAULT_TIME_ZONE, settingsHref, themeDefaults, yearIn } from "./settings";
import { DEFAULT_THEME } from "./theme-css";
import type { MenuMinistry } from "./ministry-menu";
import { renderHeader } from "./header";
import { icon } from "./icons";

export type { PostDocument, PostDto } from "./dto";

export interface SiteInfo {
  name: string;
  baseUrl: string;
  /** Tenant `site.theme`; DEFAULT_THEME when absent. */
  theme?: SiteTheme;
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
  /** The header's ministries menu (ministry-menu.ts). Null or absent: unavailable. */
  ministryMenu?: MenuMinistry[] | null;
  /** The id of the page's own search input (the search page). The header's search forms and phone
   * drawer are left off, and its phone search control becomes a link to that input (R12). */
  pageSearchInput?: string;
  /** Trusted renderer HTML (a `<section aria-label>` band) between the header and
   * `div#main-content`. Absent or empty ⇒ nothing is emitted. */
  lead?: string;
  /** Trusted renderer HTML right after `div#main-content`. Absent or empty ⇒ nothing is emitted. */
  trail?: string;
  /** The page's Open Graph / Twitter card values where they differ from the defaults
   * ({@link socialMeta}): title (else the page title), description (else `description`), an
   * absolute http(s) image (else the default card image), that image's alt text (only with the
   * given image) and the og:type (else "website"). */
  social?: { title?: string | null; description?: string | null; image?: string | null; imageAlt?: string | null; type?: "website" | "article" };
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

/** The card image a page without its own shows (legacy's `default-og-image-new.jpg`, vendored). */
export const DEFAULT_OG_IMAGE = "/assets/legacy/Content/Images/Gov/default-og-image-new.jpg";

/**
 * Every page's Open Graph and Twitter card meta (gap audit M5): og:site_name, url (the canonical),
 * type, title, description (trimmed; left out when empty), image and image:alt (a page's own image
 * only), then twitter:card summary_large_image and the twitter: title, description, image and
 * image:alt with the same values. A crawler fetches the image
 * on its own, so it must be absolute: anything but an absolute http(s) URL gets the default. No
 * twitter:site — the handle is tenant identity, which plan 5 T10 owns.
 */
function socialMeta(title: string, site: SiteInfo, canonical: string, opts: PageOptions): string {
  const s = opts.social ?? {};
  const ogTitle = s.title ?? title;
  const description = (s.description ?? opts.description)?.trim() || null;
  const ownImage = s.image && isSafeUrl(s.image, { relative: false, schemes: ["https:", "http:"] }) ? s.image : null;
  const image = ownImage ?? new URL(site.baseUrl).origin + basePath(site) + DEFAULT_OG_IMAGE;
  // Alt text describes the page's own image; the default card image carries none.
  const imageAlt = ownImage ? s.imageAlt?.trim() || null : null;
  const og = (k: string, v: string) => `\n<meta property="og:${k}" content="${e(v)}">`;
  const tw = (k: string, v: string) => `\n<meta name="twitter:${k}" content="${e(v)}">`;
  return (
    og("site_name", site.name) +
    og("url", canonical) +
    og("type", s.type ?? "website") +
    og("title", ogTitle) +
    (description ? og("description", description) : "") +
    og("image", image) +
    (imageAlt ? og("image:alt", imageAlt) : "") +
    tw("card", "summary_large_image") +
    tw("title", ogTitle) +
    (description ? tw("description", description) : "") +
    tw("image", image) +
    (imageAlt ? tw("image:alt", imageAlt) : "")
  );
}

/** The head's inline script: marks `<html>` as `.js` before any CSS applies, so stylesheets can
 * keep no-JS fallbacks under `html:not(.js)` without a flash. A constant: nothing is interpolated. */
export const HTML_JS_MARKER = 'document.documentElement.classList.add("js")';

/** site.js's `onerror`: if the script can't load, the page drops the html.js marker so the
 * `html:not(.js)` fallbacks in overrides.css apply (the phone nav and search drawer show, News
 * stays a link). A constant: nothing is interpolated. */
export const SITE_SCRIPT_ONERROR = 'document.documentElement.classList.remove("js")';

/** Elements browsers draw in italics by default, and the classes our CSS sets `font-style: italic`
 * on (bootstrap's `.fst-italic`, legacy site.css's `.quotes .quote p`). */
const ITALIC_TAG = /<(?:em|i|cite|address|var|dfn)[\s>/]/i;
const ITALIC_CLASS = /\sclass="(?:[^"]*\s)?(?:fst-italic|quote)(?:\s[^"]*)?"/;

/**
 * Whether a rendered page shows italic text, so its head preloads BC Sans Italic (P4-R6): without
 * the preload the italic face is found only at layout, late enough that Lighthouse's mobile run
 * reports first paint after it (FCP 1.2 s -> 2.3 s on /privacy/). Pages with no italics don't pay
 * for the extra font. Bold italic (BoldItalic) is not preloaded.
 */
export function usesItalic(html: string): boolean {
  return ITALIC_TAG.test(html) || ITALIC_CLASS.test(html);
}

/** Every page's chrome (spec §6.3): skip link, header with brand and nav, main, footer. */
export function renderPage(title: string, site: SiteInfo, canonicalPath: string, body: string, opts: PageOptions = {}, bodyAttr = ""): string {
  const base = basePath(site);
  const theme = site.theme ?? DEFAULT_THEME;
  const robots = opts.test ? `\n<meta name="robots" content="noindex, nofollow">` : "";
  const description = opts.description ? `\n<meta name="description" content="${e(opts.description)}">` : "";
  const canonical = new URL(site.baseUrl).origin + canonicalPath;
  // Defence in depth: the tenant config schema (`@gcpe/config`'s siteThemeSchema) already
  // restricts stylesheetUrl to https:/relative, but render time doesn't re-trust config-time
  // validation for anything else that reaches an href/src — this shouldn't either.
  const fontHref = theme.font.stylesheetUrl && isSafeUrl(theme.font.stylesheetUrl, { schemes: ["https:"] }) ? theme.font.stylesheetUrl : null;
  const font = fontHref ? `\n<link rel="stylesheet" href="${e(fontHref)}">` : "";
  const feed = opts.feed ? `\n<link rel="alternate" type="application/rss+xml" title="${e(opts.feed.title)}" href="${e(opts.feed.href)}">` : "";
  // Legacy loads the Granville Bridge theme only while Project Blue Bridge is on.
  const bridgeCss = opts.banner ? `\n<link rel="stylesheet" href="${e(base)}/assets/legacy/Content/granville-bridge-theme.css">` : "";
  const settings = opts.settings ?? themeDefaults(theme);
  const page = `<body${bodyAttr}>
<a class="skip-link" href="#main">Skip to main content</a>
${renderBanner(base, opts.banner)}
${renderHeader(site, opts)}
${opts.lead ? `${opts.lead}\n` : ""}<div id="main-content" class="template container-xl"><main id="main" tabindex="-1">
${body}
</main></div>
${opts.trail ? `${opts.trail}\n` : ""}${renderFooter(settings, site, opts)}
<script src="${e(base)}/assets/site/site.js" defer onerror="${e(SITE_SCRIPT_ONERROR)}"></script>
</body>`;
  const italicPreload = usesItalic(page) ? `\n<link rel="preload" href="${e(base)}/assets/legacy/fonts/BCSans-Italic.woff2" as="font" type="font/woff2" crossorigin>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} | ${e(site.name)}</title>
<link rel="canonical" href="${e(canonical)}">${robots}${description}${socialMeta(title, site, canonical, opts)}
<link rel="icon" href="${e(base)}/favicon.ico">
<script>${HTML_JS_MARKER}</script>
<link rel="preload" href="${e(base)}/assets/legacy/fonts/BCSans-Regular.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${e(base)}/assets/legacy/fonts/BCSans-Bold.woff2" as="font" type="font/woff2" crossorigin>${italicPreload}
<link rel="stylesheet" href="${e(base)}/assets/${LEGACY_BUNDLE}">
<link rel="stylesheet" href="${e(base)}/assets/legacy/Content/print.css" media="print">${bridgeCss}
<link rel="stylesheet" href="${e(base)}/assets/site/overrides.css">
<link rel="stylesheet" href="${e(base)}/assets/theme.css">${font}${feed}
</head>
${page}
</html>
`;
}

/**
 * `section#banner` (look-and-feel §1.3–1.4): the Project Blue Bridge banner when it is on, in legacy
 * `_BlueBridgeBanner.cshtml`'s skeleton with a real close button and `role="alert"`; then the site
 * banner's placeholder and its inline script (banner-script.ts), which stands down while Blue Bridge
 * shows. With no Blue Bridge banner the section starts hidden, so no empty "Site notices" region is
 * announced; the script un-hides it when it shows the site banner.
 */
function renderBanner(base: string, blueBridge: string | null | undefined): string {
  const bridge = blueBridge
    ? `<div id="bridge-banner" class="info-black-banner container-fluid sm-g-0" role="alert"><div class="content container-xl sm-g-0"><div>${icon("circle-info", e(base))}</div><div>${e(blueBridge)}</div><div><button type="button" id="btnCloseBannerBridge" aria-label="Close banner">${icon("xmark", e(base))}</button></div></div></div>
`
    : "";
  return `<section id="banner" aria-label="Site notices"${bridge ? "" : " hidden"}>
${bridge}<div id="site-banner" hidden data-base="${e(base)}" data-icons="${e(base)}/assets/site/icons.svg"></div>
<script>${SITE_BANNER_SCRIPT}</script>
</section>`;
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

/**
 * Every page's land acknowledgement band and footer, from the site settings (spec "Delivery": a
 * change rebuilds every page): legacy `_Layout`'s skeleton (look-and-feel §1) with the §5
 * deviations — the band is an `aside` landmark with no inline style, the footer is `footer#footer`
 * (no `role=navigation`), its headings are `h2` (overrides.css restates legacy's `#footer h4`),
 * the link columns sit in one labelled `nav` (a flex box of its own that reproduces legacy's flat
 * `.top` row; overrides.css) and
 * the lists carry no `role=menu`. One logo, the bridge file while Blue Bridge is on, instead of
 * legacy's two toggled by class. An empty or whitespace-only acknowledgement shows no band.
 */
function renderFooter(settings: SiteSettings, site: SiteInfo, opts: PageOptions): string {
  const f = settings.footer;
  const ack = f.landAcknowledgement?.trim() ? `<aside id="landAcknowledgement" class="container-fluid" aria-label="Land acknowledgement"><div class="container-xl"><p>${e(f.landAcknowledgement)}</p></div></aside>\n` : "";
  const help = [f.helpText ? e(f.helpText) : "", helpSentence(f.helpLinks, site)].filter(Boolean).join(" ");
  const column = (cls: string, heading: string, links: LinkSetting[], ulClass = "") =>
    links.length ? `<div class="${cls}">\n<h2>${heading}</h2>\n<ul${ulClass ? ` class="${ulClass}"` : ""}>\n${linkList(links, site)}\n</ul>\n</div>` : "";
  const columns = [column("footer-connect", "Connect with Us", f.connectLinks), column("footer-more-info", "More Info", f.moreInfoLinks, "pull-left")].filter(Boolean).join("\n");
  const logo = `${e(basePath(site))}/assets/legacy/Content/Images/Gov/BCID_H_rgb_pos_LH_crop${opts.banner ? "_bridge" : ""}.svg`;
  const year = yearIn(site.timeZone ?? DEFAULT_TIME_ZONE, new Date());
  return `${ack}<footer id="footer" class="container-fluid">
<div class="top container-xl">
<div class="footer-bc">
<img id="BCGov-logo-footer" src="${logo}" alt="Government of B.C.">
${help ? `<p>${help}</p>\n` : ""}</div>
${columns ? `<nav aria-label="Footer">\n${columns}\n</nav>\n` : ""}<hr>
</div>
<div class="container-xl bottom">
<div class="copyright">© ${e(year)} ${e(f.copyrightHolder)}</div>
</div>
</footer>`;
}
