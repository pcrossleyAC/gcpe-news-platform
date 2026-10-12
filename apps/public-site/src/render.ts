import type { SiteTheme } from "@gcpe/config";
import { escapeHtml } from "@gcpe/http-kit";
import { DEFAULT_THEME } from "./theme-css";
import type { PostDto } from "./dto";

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

const ENGLISH = 4105;

export const e = (s: string | null | undefined): string => escapeHtml(s ?? "");
const english = (p: PostDto) => p.documents.find((d) => d.languageId === ENGLISH) ?? p.documents[0];

/** The base URL's path with no trailing slash: "" at a root base, "/site" on boxs.ca. */
export function basePath(site: Pick<SiteInfo, "baseUrl">): string {
  return new URL(site.baseUrl).pathname.replace(/\/+$/, "");
}

const releasePath = (site: SiteInfo, key: string) => `${basePath(site)}/releases/${encodeURIComponent(key)}`;

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
  const footerLinks = theme.footerLinks.map((l) => `<li><a href="${e(l.url)}">${e(l.label)}</a></li>`).join("\n");
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

export function renderPostPage(p: PostDto, site: SiteInfo, opts: PageOptions = {}): string {
  const d = english(p);
  const headline = d?.headline ?? p.key;
  const contacts = (d?.contacts ?? [])
    .map((c) => `<li><strong>${e(c.title)}</strong><br>${e(c.details).replace(/\n/g, "<br>")}</li>`)
    .join("\n");
  const body = `<article>
<h1>${e(headline)}</h1>
${d?.subheadline ? `<h2>${e(d.subheadline)}</h2>` : ""}
<p><time datetime="${e(p.publishDate)}">${e(p.publishDate)}</time>${p.location ? ` · ${e(p.location)}` : ""}</p>
${d?.detailsHtml ?? ""}
${contacts ? `<section><h2>Contacts</h2><ul>\n${contacts}\n</ul></section>` : ""}
</article>`;
  return renderPage(headline, site, releasePath(site, p.key), body, opts);
}

export function renderHomePage(posts: PostDto[], site: SiteInfo, opts: PageOptions = {}): string {
  const items = posts
    .map((p) => `<li><a href="${e(releasePath(site, p.key))}">${e(english(p)?.headline ?? p.key)}</a> <time datetime="${e(p.publishDate)}">${e(p.publishDate)}</time></li>`)
    .join("\n");
  return renderPage("Home", site, `${basePath(site)}/`, `<h1>Latest news</h1>\n<ul>\n${items}\n</ul>`, opts);
}
