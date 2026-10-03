export interface PostDocument {
  languageId: number;
  headline: string | null;
  subheadline: string | null;
  detailsHtml: string | null;
  contacts: { title: string | null; details: string | null }[];
}
export interface PostDto {
  key: string;
  kind: string;
  publishDate: string;
  summary: string | null;
  location: string | null;
  ministryKeys: string[];
  documents: PostDocument[];
}
export interface SiteInfo {
  name: string;
  baseUrl: string;
}

const ENGLISH = 4105;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const e = (s: string | null | undefined) => escapeHtml(s ?? "");
const english = (p: PostDto) => p.documents.find((d) => d.languageId === ENGLISH) ?? p.documents[0];

function page(title: string, site: SiteInfo, canonicalPath: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} | ${e(site.name)}</title>
<link rel="canonical" href="${e(site.baseUrl + canonicalPath)}">
</head>
<body>
<header><a href="/">${e(site.name)}</a></header>
<main>
${body}
</main>
</body>
</html>
`;
}

export function renderPostPage(p: PostDto, site: SiteInfo): string {
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
  return page(headline, site, `/releases/${p.key}`, body);
}

export function renderHomePage(posts: PostDto[], site: SiteInfo): string {
  const items = posts
    .map((p) => `<li><a href="/releases/${encodeURIComponent(p.key)}">${e(english(p)?.headline ?? p.key)}</a> <time datetime="${e(p.publishDate)}">${e(p.publishDate)}</time></li>`)
    .join("\n");
  return page("Home", site, "/", `<h1>Latest news</h1>\n<ul>\n${items}\n</ul>`);
}
