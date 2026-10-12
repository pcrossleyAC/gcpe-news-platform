import type { SiteTheme } from "@gcpe/config";
import { escapeHtml } from "@gcpe/http-kit";
import { DEFAULT_THEME } from "./theme-css";

export type { PostDocument, PostDto } from "./dto";

export interface SiteInfo {
  name: string;
  baseUrl: string;
  /** Tenant `site.theme`; DEFAULT_THEME when absent. */
  theme?: SiteTheme;
  /** Set by start.ts only when the logo file exists under SITE_ASSETS_DIR (static-pages.ts's logoFor). */
  logo?: { src: string; alt: string } | null;
}

export interface PageOptions {
  /** A test site gets `<meta name="robots" content="noindex, nofollow">` (site-env.ts's isTestSite). */
  test?: boolean;
  /** Project Blue Bridge's banner text (site-env.ts's blueBridgeBanner), or null/absent for none. */
  banner?: string | null;
  description?: string | null;
  /** The page's RSS feed, linked as an alternate. */
  feed?: { href: string; title: string } | null;
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

/**
 * Shared by `safeHref` and `safeSrc` below. Escaping (`e()`) only neutralises HTML
 * metacharacters — it does nothing to stop a `javascript:`/`vbscript:`/`data:` URL from running
 * as a link or image load, which would be stored XSS. Only an absolute `http:`/`https:` URL (and,
 * for a link, `mailto:`), or a single-slash site-relative path (`/files/...`, `/releases/...`),
 * is accepted; everything else, including a protocol-relative `//host` URL, is rejected (`null`)
 * and the caller must not render the attribute at all.
 *
 * Checked after stripping ASCII tabs/newlines/carriage-returns and trimming surrounding
 * whitespace — browsers do the same before reading a URL's scheme, so a hostile value can hide
 * `javascript:` as `"java\tscript:"` or `" JaVaScRiPt:"` and still run when a naive check (a
 * plain `startsWith("javascript:")`) would miss it.
 */
function safeUrl(u: string | null | undefined, allowedSchemes: readonly string[]): string | null {
  if (!u) return null;
  const stripped = u.replace(/[\t\n\r]/g, "").trim();
  if (!stripped) return null;
  if (stripped.startsWith("/") && !stripped.startsWith("//")) return u;
  let parsed: URL;
  try {
    parsed = new URL(stripped);
  } catch {
    return null;
  }
  return allowedSchemes.includes(parsed.protocol.toLowerCase()) ? u : null;
}

/** Gates every `href` built from News API data (a ministry URL, a resource link, an asset or
 * translation file, a slide's action link) before it's escaped with `e()`. See {@link safeUrl}. */
export const safeHref = (u: string | null | undefined): string | null => safeUrl(u, ["https:", "http:", "mailto:"]);

/** Gates every `src` built from News API data (an asset image, the minister's photo) before it's
 * escaped with `e()` — same as {@link safeHref} but never `mailto:`, which cannot load as an
 * image. See {@link safeUrl}. */
export const safeSrc = (u: string | null | undefined): string | null => safeUrl(u, ["https:", "http:"]);

/** The base URL's path with no trailing slash: "" at a root base, "/site" on boxs.ca. */
export function basePath(site: Pick<SiteInfo, "baseUrl">): string {
  return new URL(site.baseUrl).pathname.replace(/\/+$/, "");
}

/** Every page's chrome (spec §6.3): skip link, header with brand and nav, main, footer. */
export function renderPage(title: string, site: SiteInfo, canonicalPath: string, body: string, opts: PageOptions = {}, bodyAttr = ""): string {
  const base = basePath(site);
  const theme = site.theme ?? DEFAULT_THEME;
  const robots = opts.test ? `\n<meta name="robots" content="noindex, nofollow">` : "";
  const description = opts.description ? `\n<meta name="description" content="${e(opts.description)}">` : "";
  const font = theme.font.stylesheetUrl ? `\n<link rel="stylesheet" href="${e(theme.font.stylesheetUrl)}">` : "";
  const feed = opts.feed ? `\n<link rel="alternate" type="application/rss+xml" title="${e(opts.feed.title)}" href="${e(opts.feed.href)}">` : "";
  const banner = opts.banner ? `\n<div class="blue-bridge-banner" role="alert">${e(opts.banner)}</div>` : "";
  const brand = site.logo
    ? `<img class="logo" src="${e(site.logo.src)}" alt="${e(site.logo.alt)}"><span class="wordmark">${e(site.name)}</span>`
    : `<span class="wordmark">${e(site.name)}</span>`;
  const footerLinks = theme.footerLinks
    .map((l) => {
      const href = safeHref(l.url);
      return href ? `<li><a href="${e(href)}">${e(l.label)}</a></li>` : `<li>${e(l.label)}</li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} | ${e(site.name)}</title>
<link rel="canonical" href="${e(new URL(site.baseUrl).origin + canonicalPath)}">${robots}${description}
<link rel="stylesheet" href="${e(base)}/assets/theme.css">${font}${feed}
</head>
<body${bodyAttr}>
<a class="skip-link" href="#main">Skip to main content</a>${banner}
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
<footer class="site-footer">
<ul>
${footerLinks}
</ul>
<p class="muted">${e(site.name)}</p>
</footer>
</body>
</html>
`;
}
