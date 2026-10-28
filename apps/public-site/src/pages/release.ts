import type { MinistryPageLabels } from "@gcpe/site-settings";
import type { AssetDto, MinistryDto, PostDocument, PostDto, RelatedPost } from "../dto";
import { icon } from "../icons";
import { basePath, e, renderPage, safeHref, type PageOptions, type SiteInfo } from "../render";
import { sanitizeBodyHtml } from "../sanitize-body";
import { themeDefaults } from "../settings";
import { categoryPageId, pageUrl, parsePageId } from "../site-paths";
import { bytesReadable, displayDateTime } from "./format";
import { translationLanguage } from "./languages";
import { renderBodyAssets } from "./media";
import { ministryLinkGroups, resourceLinks } from "./side-links";

const ENGLISH = 4105;
const FRENCH = 3084;

export interface ReleaseContext {
  ministryNames: Map<string, string>;
  related: RelatedPost[];
  /** The lead ministry (`leadMinistryKey ?? ministryKeys[0]`, matched case-insensitively), or null. */
  leadMinistry: MinistryDto | null;
  /** The lead ministry's latest posts (Task 8's related band); [] until then. */
  ministryLatest: PostDto[];
}

/**
 * A post's documents by language (legacy PostView reads the first document, an optional French
 * second one and the rest as backgrounders; this reads languages, so the order NRMS stores them
 * in doesn't matter):
 * - English is 4105, or — when no document is 4105 — any document that isn't French (3084);
 * - `main` is the first English document, else the first French one, and then `french` is null;
 * - `backgrounders` are the other English documents and `frenchBackgrounders` the other French
 *   ones, each in order.
 */
export function documentsByLanguage(docs: PostDocument[]): { main: PostDocument | null; backgrounders: PostDocument[]; french: PostDocument | null; frenchBackgrounders: PostDocument[] } {
  const hasEnglish = docs.some((d) => d.languageId === ENGLISH);
  const english = docs.filter((d) => (hasEnglish ? d.languageId === ENGLISH : d.languageId !== FRENCH));
  const frenchDocs = docs.filter((d) => d.languageId === FRENCH);
  if (english.length > 0) {
    return { main: english[0]!, backgrounders: english.slice(1), french: frenchDocs[0] ?? null, frenchBackgrounders: frenchDocs.slice(1) };
  }
  return { main: frenchDocs[0] ?? null, backgrounders: [], french: null, frenchBackgrounders: frenchDocs.slice(1) };
}

/** Escaped text with its line breaks as `<br>` (legacy `WithHtmlBreaks`). */
const withBreaks = (s: string) => e(s).replace(/\r?\n/g, "<br>");

const present = (s: string | null | undefined): s is string => typeof s === "string" && s.trim() !== "";

/** Legacy `ContactsDetails`: a heading, then each contact's title and its details with line
 * breaks. `level` is the heading level (the contact titles sit one below). */
function contactsBlock(contacts: PostDocument["contacts"], heading: string, level: 2 | 4): string {
  const items = contacts.map((c) => `<div class="comm-contact"><h${level + 1}>${e(c.title)}</h${level + 1}>${withBreaks(c.details ?? "")}</div>`);
  return `<h${level}>${e(heading)}</h${level}>\n${items.join("\n")}`;
}

/** Legacy's rule: a backgrounder shows its contacts only when they differ from the main document's. */
function contactsDiffer(item: PostDocument["contacts"], main: PostDocument["contacts"]): boolean {
  return item.length > 0 && (item.length !== main.length || item.some((c) => !main.some((m) => m.details === c.details && m.title === c.title)));
}

/** A document's body: `<asset>` embeds first (a Flickr photo link named after `headline`), then the sanitiser. */
const bodyOf = (d: PostDocument | null, base: string, headline: string) => sanitizeBodyHtml(renderBodyAssets(d?.detailsHtml ?? "", base, `Photo: ${headline}`));

/** The translation links, with each language's own name and tag (legacy `ToDefaultTranslationLanguage`). */
function translationItems(translations: AssetDto[], withIcon: string): string[] {
  return translations.flatMap((t) => {
    const href = safeHref(t.key);
    if (!href) return [];
    const { name, lang } = translationLanguage(t.label);
    const tag = lang ? ` hreflang="${e(lang)}" lang="${e(lang)}"` : "";
    return [`<li><a href="${e(href)}"${tag}>${withIcon}${e(name)}</a></li>`];
  });
}

function mediaAssetItems(assets: AssetDto[]): string[] {
  return assets.flatMap((a) => {
    const href = safeHref(a.key);
    if (!href) return [];
    const size = typeof a.length === "number" ? ` (${bytesReadable(a.length)})` : "";
    return [`<li><div><b>${e(a.label)}</b></div><div><a href="${e(href)}" download>Download${size}</a></div></li>`];
  });
}

/** The lead ministry's name above the headline, linked to its page while it is active. */
function storyMinistry(site: SiteInfo, m: MinistryDto | null): string {
  if (!m) return "";
  const pageId = m.isActive ? categoryPageId("ministries", m.key) : null;
  const parsed = pageId ? parsePageId(pageId) : null;
  const name = parsed ? `<a href="${e(pageUrl(site, parsed))}">${e(m.name)}</a>` : e(m.name);
  return `<p class="story-ministry">${name}</p>`;
}

function sideColumn(site: SiteInfo, post: PostDto, main: PostDocument | null, labels: MinistryPageLabels, ctx: ReleaseContext, parts: { translations: string[]; date: string; assetsShown: boolean }): string {
  const base = e(basePath(site));
  const translations = parts.translations.length ? `<div class="resource-links translate" id="translationList">\n<h2>Translations</h2>\n<ul>\n${parts.translations.join("\n")}\n</ul>\n</div>` : "";
  const assetsLink = parts.assetsShown ? `\n<div class="media-assets"><a class="assets-link" href="#assets">${icon("download", base)} Media Assets</a></div>` : "";
  const locationAndDate = `<div class="resource-links location-and-date">
${present(main?.pageTitle) ? `<h2>${e(main.pageTitle)}</h2>\n` : ""}${present(post.location) ? `<p class="location">${e(post.location)}</p>\n` : ""}<div>${e(parts.date)}</div>${assetsLink}
</div>`;
  const contacts = main?.contacts.length ? `<div class="resource-links comm-contacts">\n${contactsBlock(main.contacts, labels.mediaContacts, 2)}\n</div>` : "";
  const ministry = ctx.leadMinistry ? ministryLinkGroups(ctx.leadMinistry, labels).map((g) => resourceLinks(site, g.heading, g.links)) : [];
  const blocks = [translations, locationAndDate, contacts, ...ministry].filter(Boolean).join("\n");
  return `<section class="story-features" id="sidebar" aria-label="About this release">\n${blocks}\n</section>`;
}

/**
 * The release page, in legacy PostView's skeleton (look-and-feel §2.2) with the plan's
 * accessibility deviations: one h1 (the headline; legacy's lead-ministry h3 becomes
 * `p.story-ministry`), legacy's h3–h6 one level up, a labelled `<section>` side column instead of
 * a floating div, and buttons for Print and the language toggle. French renders with the English
 * (`.story-lang.secondary`, `lang="fr"`): site.js toggles `body.lang-secondary`; without script
 * both languages show (overrides.css).
 */
export function renderReleasePage(post: PostDto, site: SiteInfo, opts: PageOptions, ctx: ReleaseContext): string {
  const base = basePath(site);
  const { main, backgrounders, french, frenchBackgrounders } = documentsByLanguage(post.documents);
  const headline = present(main?.headline) ? main.headline : post.key;
  const mainLang = main?.languageId === FRENCH ? ` lang="fr"` : "";
  const labels = (opts.settings ?? themeDefaults(site.theme)).ministryPages;
  const path = pageUrl(site, { type: "post", key: post.key });
  const date = displayDateTime(post.publishDate);

  const sideTranslations = translationItems(post.azureTranslations ?? [], icon("language", e(base)));
  const assetItems = post.hasMediaAssets === true ? mediaAssetItems(post.azureAssets ?? []) : [];

  // While French shows (body.lang-secondary) the h1 is hidden, so the French headline stands in as
  // the page's level-1 heading (axe page-has-heading-one); in English it is hidden and not counted.
  const frHeadline = french && present(french.headline) ? `\n<p class="story-lang secondary story-headline" lang="fr" role="heading" aria-level="1">${e(french.headline)}</p>` : "";
  const subheadlines = [
    present(main?.subheadline) ? `<p class="story-lang primary subheadline"${mainLang}>${e(main.subheadline)}</p>` : "",
    french && present(french.subheadline) ? `<p class="story-lang secondary subheadline" lang="fr">${e(french.subheadline)}</p>` : "",
  ].filter(Boolean);

  const phonePageTitle = present(main?.pageTitle) ? `<h2 class="story-lang primary">${e(main.pageTitle)}</h2>\n` : "";
  const storyInfo = `<div class="story-info">
${sideTranslations.length ? `<div class="resource-links translate">\n<h2>Translations</h2>\n<ul>\n${sideTranslations.join("\n")}\n</ul>\n</div>\n` : ""}<div class="resource-links">
${phonePageTitle}${present(post.location) ? `<p>${e(post.location)}</p>\n` : ""}<div>${e(date)}</div>
</div>
</div>`;

  const bylines = [
    present(main?.byline) ? `<p class="story-lang primary byline"${mainLang}><b>${withBreaks(main.byline.trim())}</b></p>` : "",
    french && present(french.byline) ? `<p class="story-lang secondary byline" lang="fr"><b>${withBreaks(french.byline.trim())}</b></p>` : "",
  ].filter(Boolean);
  const selectors = french
    ? [
        `<div class="language-selector story-lang primary" lang="fr">Cet article est aussi disponible en <button type="button" data-story-lang="secondary" lang="fr">français</button></div>`,
        `<div class="language-selector story-lang secondary" lang="en">This article also available in <button type="button" data-story-lang="primary">English</button></div>`,
      ]
    : [];
  const copies = [
    `<div class="story-copy story-lang primary"${mainLang}>\n<article>\n${bodyOf(main, base, headline)}\n</article>\n</div>`,
    french ? `<div class="story-copy story-lang secondary" lang="fr">\n<article>\n${bodyOf(french, base, present(french.headline) ? french.headline : headline)}\n</article>\n</div>` : "",
  ].filter(Boolean);
  const bodyContacts = main?.contacts.length ? `<div class="comm-contacts-body-section">\n<div class="comm-contacts-body comm-contacts">\n${contactsBlock(main.contacts, labels.mediaContacts, 2)}\n</div>\n</div>` : "";

  const backgrounder = (d: PostDocument, cls: string, lang: string) => {
    const title = present(d.headline) ? d.headline : "Backgrounder";
    const contacts = contactsDiffer(d.contacts, main?.contacts ?? []) ? `\n<div class="comm-contacts">\n${contactsBlock(d.contacts, labels.mediaContacts, 4)}\n</div>` : "";
    return `<div class="${cls}"${lang}>
<div class="backgrounder-header"><h3>${e(title)}</h3></div>
<div class="backgrounder-content">
${present(d.subheadline) ? `<p class="subheadline">${e(d.subheadline)}</p>\n` : ""}${present(d.byline) ? `<p><b>${withBreaks(d.byline.trim())}</b></p>\n` : ""}${bodyOf(d, base, title)}${contacts}
</div>
</div>`;
  };
  const allBackgrounders = [
    ...backgrounders.map((d) => backgrounder(d, "backgrounder", d.languageId === FRENCH ? ` lang="fr"` : "")),
    // With a French main document there is no toggle, so the other French documents are ordinary backgrounders.
    ...frenchBackgrounders.map((d) => backgrounder(d, french ? "backgrounder story-lang secondary" : "backgrounder", ` lang="fr"`)),
  ];
  const backgroundersHeading = allBackgrounders.length
    ? french
      ? `<h2><span class="story-lang primary">Backgrounders</span><span class="story-lang secondary" lang="fr">Détails supplémentaires</span></h2>`
      : `<h2>Backgrounders</h2>`
    : "";

  const assets = assetItems.length ? `<div id="assets" class="assets expanded">\n<h2>Media Assets</h2>\n<div class="media-assets-container">\n<ul>\n${assetItems.join("\n")}\n</ul>\n</div>\n</div>` : "";
  const bodyTranslations = translationItems(post.azureTranslations ?? [], "");
  const translations = bodyTranslations.length ? `<div id="translations" class="assets expanded">\n<h2>Translations</h2>\n<ul>\n${bodyTranslations.join("\n")}\n</ul>\n</div>` : "";

  const storyBody = [...bylines, ...selectors, ...copies, bodyContacts, backgroundersHeading, ...allBackgrounders, assets, translations].filter(Boolean).join("\n");

  const header = [
    `<button type="button" class="print-document">${icon("print", e(base))} Print</button>`,
    storyMinistry(site, ctx.leadMinistry),
    `<div class="print-title">${e(site.name)}</div>`,
    `<h1 class="story-lang primary"${mainLang}>${e(headline)}</h1>${frHeadline}`,
    `<div class="print-url">${e(new URL(site.baseUrl).origin + path)}</div>`,
    `<div class="print-date">${e(date)}</div>`,
    ...subheadlines,
  ].filter(Boolean);

  const body = `<div class="story-page pt-4">
${header.join("\n")}
${storyInfo}
${sideColumn(site, post, main, labels, ctx, { translations: sideTranslations, date, assetsShown: assetItems.length > 0 })}
<div class="story-body" id="main-content-release">
${storyBody}
</div>
</div>`;

  return renderPage(headline, site, path, body, { ...opts, description: post.summary });
}
