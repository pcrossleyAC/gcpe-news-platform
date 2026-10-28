import type { MinisterDto, MinistryDto, MinistryProfileDto } from "../dto";
import { e, renderPage, safeHref, safeSrc, type PageOptions, type SiteInfo } from "../render";
import { sanitizeBodyHtml } from "../sanitize-body";
import { themeDefaults } from "../settings";
import { biographyUrl, pageUrl } from "../site-paths";
import { ministryLinkGroups, resourceLinks } from "./side-links";

/** The Office of the Premier's ministry key: its bio page links to "All News From The Premier". */
export const PREMIER_KEY = "office-of-the-premier";

/** The plan's test is p/div/ul/ol (legacy wrapped every bio); headings, tables, quotes, figures and rules are added because none
 * of them may sit inside the `<p>` the plain-text branch would wrap them in. */
const BLOCK = /<(p|div|ul|ol|h[1-6]|table|blockquote|figure|hr)[\s>/]/i;

/**
 * The minister's biography as the public site shows it: always through the public sanitiser
 * (which demotes any `h1`). A bio with no paragraph-level block (plain text, as older NRMS bios
 * are) gets one `<p>` per non-empty line, as legacy's `AsHtmlParagraphs` did; the wrapped result
 * is sanitised again, so a tag spanning two lines is re-balanced rather than left open.
 */
export function bioHtml(details: string | null): string {
  const clean = sanitizeBodyHtml(details ?? "");
  if (BLOCK.test(clean)) return clean;
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? sanitizeBodyHtml(lines.map((l) => `<p>${l}</p>`).join("")) : "";
}

/** True when the minister's bio has any text once sanitised (an emptied editor's `<p></p>` has none). */
export function hasBiography(minister: MinisterDto | null): boolean {
  if (!minister) return false;
  const text = bioHtml(minister.details)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ");
  return text.trim() !== "";
}

const ministryHref = (site: Pick<SiteInfo, "baseUrl">, m: MinistryDto) => pageUrl(site, { type: "category", kind: "ministries", key: m.key.toLowerCase() });

/**
 * Legacy `Minister.cshtml` as `div.resource-links.minister`: photo, name, summary, "Read Bio" (only
 * when there is a bio) and the minister's Contact email (from `/api/v2/ministries`). Empty when the
 * minister has no name, as legacy's `Headline` check. Legacy's h3/h4 are emitted one level up;
 * with `ministryHeading` (a page listing several ministries) the ministry name is the h2 above the
 * minister's h3. Legacy's link from the photo to www2's large photo is not reproduced.
 */
export function ministerCard(site: Pick<SiteInfo, "baseUrl">, m: MinistryDto, minister: MinisterDto | null, profile: MinistryProfileDto | null, o: { ministryHeading?: boolean } = {}): string {
  const name = minister?.headline?.trim();
  if (!minister || !name) return "";
  const parts: string[] = [];
  if (o.ministryHeading) parts.push(`<h2><a href="${e(ministryHref(site, m))}">${e(m.name)}</a></h2>`);
  const photo = safeSrc(minister.photo);
  if (photo) parts.push(`<img src="${e(photo)}" alt="${e(name)}">`);
  const h = o.ministryHeading ? "h3" : "h2";
  parts.push(`<${h}>${e(name)}</${h}>`);
  for (const line of (minister.summary ?? "").split(/\r?\n/)) if (line.trim()) parts.push(`<p>${e(line.trim())}</p>`);
  if (hasBiography(minister)) parts.push(`<a href="${e(biographyUrl(site, m.key))}" class="read-more">Read Bio<span class="visually-hidden">: ${e(name)}</span></a>`);
  const email = profile?.ministerEmail?.trim();
  const mailto = email ? safeHref(`mailto:${email}`) : null;
  if (email && mailto) parts.push(`<h3>Contact</h3>\n<p class="minister-email">Email: <a href="${e(mailto)}">${e(email)}</a></p>`);
  return `<div class="resource-links minister">\n${parts.join("\n")}\n</div>`;
}

/** The ministry pages' side column (legacy `div.home-features`): the ministry name (legacy's h3,
 * here a presentational title, as the page's own heading already names it), the minister card,
 * then `extra` (trusted renderer HTML). */
export function ministrySidebar(site: Pick<SiteInfo, "baseUrl">, m: MinistryDto, minister: MinisterDto | null, profile: MinistryProfileDto | null, extra: string): string {
  return `<section class="home-features" aria-label="${e(`About ${m.name}`)}">
<p class="ministry-title" aria-hidden="true">${e(m.name)}</p>
${ministerCard(site, m, minister, profile)}${extra ? `\n${extra}` : ""}
</section>`;
}

/**
 * Legacy `Biography.cshtml` at `/ministries/<key>/biography/` (H2): the ministry column (minister
 * card, Featured Topics, Featured Services) beside the bio, whose h2 becomes the page's one h1.
 * Legacy's `<center>` is a div centred in overrides.css.
 */
export function renderBiographyPage(m: MinistryDto, minister: MinisterDto, profile: MinistryProfileDto | null, site: SiteInfo, opts: PageOptions = {}): string {
  const name = minister.headline?.trim() || m.ministerName?.trim() || m.name;
  const labels = (opts.settings ?? themeDefaults(site.theme)).ministryPages;
  const [, topics, services] = ministryLinkGroups(m, labels);
  const extra = [topics!, services!].map((g) => resourceLinks(site, g.heading, g.links)).filter(Boolean).join("\n");
  const photo = safeSrc(minister.photo);
  const picture = photo ? `\n<div class="minister-bio-picture">\n<img src="${e(photo)}" alt="${e(name)}">\n</div>` : "";
  const allNews = m.key.toLowerCase() === PREMIER_KEY ? "All News From The Premier" : "All News From This Ministry";
  const body = `<div class="ministry-listing">
<div class="home-layout">
${ministrySidebar(site, m, minister, profile, extra)}
<div class="home-body">
<div class="biography-details" id="main-content-release">
<h1>${e(name)}</h1>${picture}
${bioHtml(minister.details)}
</div>
<div class="news-control">
<a href="${e(ministryHref(site, m))}" class="read-more">${allNews}</a>
<div class="clear"></div>
</div>
</div>
</div>
</div>`;
  return renderPage(name, site, biographyUrl(site, m.key), body, {
    ...opts,
    description: minister.summary?.trim() ? minister.summary : null,
    social: { image: photo },
  });
}
