import type { PostDto, RelatedPost } from "../dto";
import { e, renderPage, safeHref, safeSrc, type PageOptions, type SiteInfo } from "../render";
import { categoryPageId, pageUrl, parsePageId } from "../site-paths";
import { demoteHeadings, displayDate, postListItem } from "./format";

const ENGLISH = 4105;
const english = (p: PostDto) => p.documents.find((d) => d.languageId === ENGLISH) ?? p.documents[0];

const IMAGE_EXT = /\.(png|jpe?g)$/i;

/** "1.2 KB" from a byte length. */
function formatSize(length: number): string {
  return `${(length / 1024).toFixed(1)} KB`;
}

/** The file extension, upper-cased, for an asset with no declared content type (e.g. "PDF"). */
function extensionLabel(key: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(key);
  return m ? m[1]!.toUpperCase() : "FILE";
}

function mediaAssetsSection(assets: { key: string | null; label: string | null; length: number | null }[]): string {
  const items = assets
    .filter((a): a is { key: string; label: string | null; length: number | null } => typeof a.key === "string")
    .map((a) => {
      if (IMAGE_EXT.test(a.key)) {
        const src = safeSrc(a.key);
        return src ? `<figure><img src="${e(src)}" alt=""><figcaption>${e(a.label)}</figcaption></figure>` : "";
      }
      const href = safeHref(a.key);
      if (!href) return "";
      const size = a.length != null ? `, ${formatSize(a.length)}` : "";
      return `<p><a href="${e(href)}">${e(a.label)} (${extensionLabel(a.key)}${size})</a></p>`;
    })
    .filter(Boolean);
  return items.length ? `<section>\n<h2>Media assets</h2>\n${items.join("\n")}\n</section>` : "";
}

function translationsSection(translations: { key: string | null; label: string | null }[]): string {
  const items = translations
    .filter((t): t is { key: string; label: string | null } => typeof t.key === "string")
    .map((t) => {
      const href = safeHref(t.key);
      return href ? `<li><a href="${e(href)}">${e(t.label)}</a></li>` : "";
    })
    .filter(Boolean);
  if (!items.length) return "";
  return `<section>\n<h2>Translations</h2>\n<ul>\n${items.join("\n")}\n</ul>\n</section>`;
}

function contactsSection(contacts: { title: string | null; details: string | null }[]): string {
  if (!contacts.length) return "";
  const items = contacts.map((c) => `<li><strong>${e(c.title)}</strong><br>${e(c.details).replace(/\n/g, "<br>")}</li>`).join("\n");
  return `<section>\n<h2>Contacts</h2>\n<ul>\n${items}\n</ul>\n</section>`;
}

function relatedSection(site: Pick<SiteInfo, "baseUrl">, related: RelatedPost[]): string {
  if (!related.length) return "";
  const items = related.map((r) => postListItem(site, r)).join("\n");
  return `<section>\n<h2>Related news</h2>\n<ul class="post-list">\n${items}\n</ul>\n</section>`;
}

/** The lead ministry's name, linked to its page, when `ministryNames` knows it (matched
 * case-insensitively — the News API's casing and NRMS's category-key casing can differ). */
function ministryLink(site: SiteInfo, leadKey: string | null, ministryNames: Map<string, string>): string {
  if (!leadKey) return "";
  const lower = leadKey.toLowerCase();
  const name = [...ministryNames].find(([k]) => k.toLowerCase() === lower)?.[1];
  if (!name) return "";
  const pageId = categoryPageId("ministries", leadKey);
  if (!pageId) return "";
  const parsed = parsePageId(pageId);
  if (!parsed) return "";
  return ` · <a href="${e(pageUrl(site, parsed))}">${e(name)}</a>`;
}

export function renderReleasePage(post: PostDto, site: SiteInfo, opts: PageOptions, ctx: { ministryNames: Map<string, string>; related: RelatedPost[] }): string {
  const d = english(post);
  const headline = d?.headline ?? post.key;
  const subheadline = d?.subheadline ? `<p class="subheadline">${e(d.subheadline)}</p>` : "";
  const leadKey = post.leadMinistryKey ?? post.ministryKeys[0] ?? null;
  const meta = `<p class="meta"><time datetime="${e(post.publishDate)}">${e(displayDate(post.publishDate))}</time>${post.location ? ` · ${e(post.location)}` : ""}${ministryLink(site, leadKey, ctx.ministryNames)}</p>`;
  const body = demoteHeadings(d?.detailsHtml ?? "");

  const sections = [contactsSection(d?.contacts ?? []), mediaAssetsSection(post.azureAssets ?? []), translationsSection(post.azureTranslations ?? []), relatedSection(site, ctx.related)]
    .filter(Boolean)
    .join("\n");

  const article = `<article>
<h1>${e(headline)}</h1>
${subheadline}
${meta}
${body}
${sections}
</article>`;

  return renderPage(headline, site, pageUrl(site, { type: "post", key: post.key }), article, { ...opts, description: post.summary });
}
