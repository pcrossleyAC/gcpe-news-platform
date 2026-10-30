import { randomUUID } from "node:crypto";
import type { MinistryPageLabels, PageTextSettings } from "@gcpe/site-settings";
import type { AssetDto, MinistryDto, PostDocument, PostDto, RelatedPost } from "../dto";
import { icon } from "../icons";
import { headlineOf } from "../post-index";
import { basePath, e, renderPage, safeHref, type PageOptions, type SiteInfo } from "../render";
import { sanitizeBodyHtml } from "../sanitize-body";
import { releaseInstagram, settingsHref, themeDefaults } from "../settings";
import { categoryPageId, pageUrl, parsePageId } from "../site-paths";
import { bytesReadable, displayDate, displayDateTime, displayDateTimeNoWeekday } from "./format";
import { translationLanguage } from "./languages";
import { leadMedia, renderBodyAssets, renderMedia, type LeadMedia } from "./media";
import { ministryLinkGroups, resourceLinks } from "./side-links";

const ENGLISH = 4105;
const FRENCH = 3084;

export interface ReleaseContext {
  related: RelatedPost[];
  /** The lead ministry (`leadMinistryKey ?? ministryKeys[0]`, matched case-insensitively), or null. */
  leadMinistry: MinistryDto | null;
  /** For an inactive lead ministry: the active ministry its URLs now 301 to (apps/stack's
   * ministry-successors), or null/absent when none resolves (abolished, or the table unavailable). */
  leadMinistrySuccessor?: string | null;
  /** The lead ministry's latest posts: the related band's fallback when `related` is empty (the
   * builder fetches them only then). This page's post may be among them; it is left out. */
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

/** A document's contacts, [] when absent: one malformed stored document omits its contacts
 * rather than failing the page's render. */
const contactsOf = (d: PostDocument | null | undefined): PostDocument["contacts"] => d?.contacts ?? [];

/** Legacy's rule: a backgrounder shows its contacts only when they differ from the main document's. */
function contactsDiffer(item: PostDocument["contacts"], main: PostDocument["contacts"]): boolean {
  return item.length > 0 && (item.length !== main.length || item.some((c) => !main.some((m) => m.details === c.details && m.title === c.title)));
}

/**
 * A document's body: `<asset>` embeds first (a Flickr photo link named after `headline`), then the
 * sanitiser. Only the embeds keep their classes (a per-body random mark), and in-page `#name`
 * links into the same body survive under the per-document `prefix`.
 */
const bodyOf = (d: PostDocument | null, base: string, headline: string, prefix: string) => {
  const embedMark = randomUUID();
  return sanitizeBodyHtml(renderBodyAssets(d?.detailsHtml ?? "", base, `Photo: ${headline}`, embedMark), { embedMark, fragmentPrefix: prefix });
};

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

/** How many articles the related band lists (legacy's RelatedArticles). */
const RELATED_COUNT = 3;

/**
 * Legacy `ShareSocialMedia` as plain links (plan 2 ledger P2-R1): legacy built the share URLs in
 * page script and opened pop-ups; these are the same URLs as hrefs, with no script and no
 * third-party load until a reader follows one. Instagram has no share intent, so, as legacy did,
 * its link is a profile (`instagram.url`, already gated; named by the account's text), left out
 * when there is none. `canonical`
 * and `title` are percent-encoded, then escaped.
 */
export function shareLinks(canonical: string, title: string, instagram: { url: string; text: string } | null, base: string): string {
  const enc = encodeURIComponent(canonical);
  const b = e(base);
  const item = (cls: string, href: string, label: string, iconId: Parameters<typeof icon>[0]) =>
    `<li><a${cls ? ` class="${cls}"` : ""} href="${e(href)}" aria-label="${e(label)}">${icon(iconId, b)}</a></li>`;
  const items = [
    item("share-facebook", `https://www.facebook.com/sharer/sharer.php?u=${enc}`, "Share on Facebook", "facebook"),
    item("share-twitter", `https://twitter.com/intent/tweet?url=${enc}`, "Share on X", "square-x-twitter"),
    instagram ? item("share-instagram", instagram.url, `${instagram.text.trim() || "BC Government"} on Instagram`, "instagram") : "",
    item("share-threads", `https://threads.net/intent/post?text=${enc}`, "Share on Threads", "threads"),
    item("share-bluesky", `https://bsky.app/intent/compose?text=${enc}`, "Share on Bluesky", "bluesky"),
    item("", `mailto:?subject=${encodeURIComponent(title)}&body=${enc}`, "Share by email", "envelope"),
  ].filter(Boolean);
  return `<div class="resource-links connect share">\n<h2>Share</h2>\n<ul>\n${items.join("\n")}\n</ul>\n</div>`;
}

/** The card image crawlers fetch for a lead: a Flickr photo itself, a YouTube video's own
 * thumbnail (only crawlers load it, never a reader's browser: the page shows our placeholder),
 * else none (renderPage's default). */
function socialImage(m: LeadMedia | null): string | null {
  if (m?.kind === "image") return m.src;
  if (m?.kind === "youtube") return `https://img.youtube.com/vi/${m.id}/hqdefault.jpg`;
  return null;
}

/**
 * The band below the release (legacy PostView's AssortedMedia section), a labelled landmark with
 * the headings one level up: Related Articles (up to three of the News API's related posts; when
 * it has none, the lead ministry's latest other posts — a fallback that is only as fresh as this
 * page's last render, since a ministry's new post doesn't rebuild its older releases), the
 * default image, and Connect with the Ministry when the ministry has a safe Flickr or YouTube
 * link. Nothing when there are neither articles nor that block.
 */
function relatedBand(site: SiteInfo, post: PostDto, ctx: ReleaseContext): string {
  const base = e(basePath(site));
  const self = post.key.toLowerCase();
  const items = ctx.related.length
    ? ctx.related.slice(0, RELATED_COUNT).map((r) => ({ key: r.key, headline: r.headline, publishDate: r.publishDate }))
    : ctx.ministryLatest
        .filter((p) => p.key.toLowerCase() !== self)
        .slice(0, RELATED_COUNT)
        .map((p) => ({ key: p.key, headline: headlineOf(p), publishDate: p.publishDate }));
  const articles = items.length
    ? `<div class="related-articles">\n<h2>Related Articles</h2>\n${items
        .map((r) => `<div class="related-article">\n<h3><a href="${e(pageUrl(site, { type: "post", key: r.key }))}">${e(r.headline)}</a></h3>\n<div class="item-date">${e(displayDateTimeNoWeekday(r.publishDate))}</div>\n</div>`)
        .join("\n")}\n</div>`
    : "";
  const photos = safeHref(ctx.leadMinistry?.flickrUri);
  const videos = safeHref(ctx.leadMinistry?.youtubeUri);
  const connect =
    photos || videos
      ? `<div class="connect-with-bc">\n<h2>Connect with the Ministry</h2>\n${[
          photos ? `<h3><a href="${e(photos)}">Photos</a></h3>\n<p>View the Ministry's latest photos on Flickr.</p>` : "",
          videos ? `<h3><a href="${e(videos)}">Videos</a></h3>\n<p>Watch the Ministry's latest videos on YouTube.</p>` : "",
        ]
          .filter(Boolean)
          .join("\n")}\n</div>`
      : "";
  if (!articles && !connect) return "";
  const image = `<div class="related-image"><img src="${base}/assets/legacy/Content/Images/Gov/default-og-meta-image-1.jpg" alt=""></div>`;
  return `<section class="media-container" aria-label="Related">\n<div class="story-parts">\n${[articles, image, connect].filter(Boolean).join("\n")}\n</div>\n</section>`;
}

/** The lead ministry's name above the headline, linked to its page while it is active, or while a
 * successor resolves (the stack 301s the old page to it). An abolished ministry is named, unlinked. */
function storyMinistry(site: SiteInfo, m: MinistryDto | null, successor: string | null | undefined): string {
  if (!m) return "";
  const pageId = m.isActive || successor ? categoryPageId("ministries", m.key) : null;
  const parsed = pageId ? parsePageId(pageId) : null;
  const name = parsed ? `<a href="${e(pageUrl(site, parsed))}">${e(m.name)}</a>` : e(m.name);
  return `<p class="story-ministry">${name}</p>`;
}

function sideColumn(site: SiteInfo, post: PostDto, main: PostDocument | null, labels: MinistryPageLabels, ctx: ReleaseContext, parts: { translations: string[]; date: string; assetsShown: boolean; share: string }): string {
  const base = e(basePath(site));
  const translations = parts.translations.length ? `<div class="resource-links translate" id="translationList">\n<h2>Translations</h2>\n<ul>\n${parts.translations.join("\n")}\n</ul>\n</div>` : "";
  const assetsLink = parts.assetsShown ? `\n<div class="media-assets"><a class="assets-link" href="#assets">${icon("download", base)} Media Assets</a></div>` : "";
  const locationAndDate = `<div class="resource-links location-and-date">
${present(main?.pageTitle) ? `<h2>${e(main.pageTitle)}</h2>\n` : ""}${present(post.location) ? `<p class="location">${e(post.location)}</p>\n` : ""}<div>${e(parts.date)}</div>${assetsLink}
</div>`;
  const contacts = contactsOf(main).length ? `<div class="resource-links comm-contacts">\n${contactsBlock(contactsOf(main), labels.mediaContacts, 2)}\n</div>` : "";
  const ministry = ctx.leadMinistry ? ministryLinkGroups(site, ctx.leadMinistry, labels).map((g) => resourceLinks(site, g.heading, g.links)) : [];
  const blocks = [translations, parts.share, locationAndDate, contacts, ...ministry].filter(Boolean).join("\n");
  return `<section class="story-features" id="sidebar" aria-label="About this release">\n${blocks}\n</section>`;
}

/** The licence sentence after the Media Assets list (L3), from pageText.assetLicence: plain text,
 * escaped; the link only for a safe URL (else its text alone) and only when it has text. */
function licenceLine(l: PageTextSettings["assetLicence"], site: SiteInfo): string {
  if (l.text.trim() === "") return "";
  const href = l.linkText.trim() !== "" ? settingsHref(l.url.trim(), site) : null;
  const link = l.linkText.trim() === "" ? "" : href ? ` <a href="${e(href)}">${e(l.linkText)}</a>` : ` ${e(l.linkText)}`;
  return `\n<p class="assets-licence">${e(l.text)}${link}.</p>`;
}

/**
 * The release page, in legacy PostView's skeleton (look-and-feel §2.2) with the plan's
 * accessibility deviations: one h1 (the headline; legacy's lead-ministry h3 becomes
 * `p.story-ministry`), legacy's h3–h6 one level up, a labelled `<section>` side column instead of
 * a floating div, and buttons for Print and the language toggle. French renders with the English
 * (`.story-lang.secondary`, `lang="fr"`): site.js toggles `body.lang-secondary`; without script
 * both languages show (overrides.css).
 */
/** NRMS references are `NEWS-<n>`; `/<n>` is news.gov's short link to the post (the stack's
 * reference rule, C272, accepts 1-9 digits and reads "007" as 7, so a leading zero gets none). */
const REFERENCE = /^NEWS-([1-9]\d{0,8})$/;

/** The post's short link, `https://<site>/<n>` (keeping a prefixed site's base path), or null. */
export function shortLinkOf(post: Pick<PostDto, "reference">, site: SiteInfo): string | null {
  const n = REFERENCE.exec(post.reference ?? "")?.[1];
  return n ? `${new URL(site.baseUrl).origin}${basePath(site)}/${n}` : null;
}

export function renderReleasePage(post: PostDto, site: SiteInfo, opts: PageOptions, ctx: ReleaseContext): string {
  const base = basePath(site);
  const { main, backgrounders, french, frenchBackgrounders } = documentsByLanguage(post.documents);
  const headline = present(main?.headline) ? main.headline : post.key;
  const mainLang = main?.languageId === FRENCH ? ` lang="fr"` : "";
  const settings = opts.settings ?? themeDefaults(site.theme);
  const labels = settings.ministryPages;
  const path = pageUrl(site, { type: "post", key: post.key });
  const canonical = new URL(site.baseUrl).origin + path;
  const shortLink = shortLinkOf(post, site);
  const date = displayDateTime(post.publishDate);
  // A change to it re-renders every release (settings.ts releaseShareHash).
  const instagram = releaseInstagram(settings);
  const instagramHref = instagram ? settingsHref(instagram.url, site) : null;
  const share = shareLinks(canonical, headline, instagram && instagramHref ? { url: instagramHref, text: instagram.text } : null, base);
  const lead = leadMedia(post.assetUrl);

  const sideTranslations = translationItems(post.azureTranslations ?? [], icon("language", e(base)));
  const assetItems = post.hasMediaAssets === true ? mediaAssetItems(post.azureAssets ?? []) : [];

  // The headline French mode shows in place of the (then hidden) h1: the French one, or the
  // English one when the French document has none (F4). A plain paragraph here; site.js makes it
  // the level-1 heading only while French shows, so every mode exposes exactly one (F3).
  const frHeadline = french
    ? present(french.headline)
      ? `\n<p class="story-lang secondary story-headline" lang="fr">${e(french.headline)}</p>`
      : `\n<p class="story-lang secondary story-headline">${e(headline)}</p>`
    : "";
  const subheadlines = [
    present(main?.subheadline) ? `<p class="story-lang primary subheadline"${mainLang}>${e(main.subheadline)}</p>` : "",
    french && present(french.subheadline) ? `<p class="story-lang secondary subheadline" lang="fr">${e(french.subheadline)}</p>` : "",
  ].filter(Boolean);

  const phonePageTitle = present(main?.pageTitle) ? `<h2 class="story-lang primary">${e(main.pageTitle)}</h2>\n` : "";
  const storyInfo = `<div class="story-info">
${sideTranslations.length ? `<div class="resource-links translate">\n<h2>Translations</h2>\n<ul>\n${sideTranslations.join("\n")}\n</ul>\n</div>\n` : ""}<div class="mobile-toolbar">
${share}
<div class="resource-links">
${phonePageTitle}${present(post.location) ? `<p>${e(post.location)}</p>\n` : ""}<div>${e(date)}</div>
</div>
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
    `<div class="story-copy story-lang primary"${mainLang}>\n<article>\n${bodyOf(main, base, headline, "body-")}\n</article>\n</div>`,
    french ? `<div class="story-copy story-lang secondary" lang="fr">\n<article>\n${bodyOf(french, base, present(french.headline) ? french.headline : headline, "body-fr-")}\n</article>\n</div>` : "",
  ].filter(Boolean);
  const bodyContacts = contactsOf(main).length ? `<div class="comm-contacts-body-section">\n<div class="comm-contacts-body comm-contacts">\n${contactsBlock(contactsOf(main), labels.mediaContacts, 2)}\n</div>\n</div>` : "";

  const backgrounder = (d: PostDocument, cls: string, lang: string, n: number) => {
    const title = present(d.headline) ? d.headline : "Backgrounder";
    const contacts = contactsDiffer(contactsOf(d), contactsOf(main)) ? `\n<div class="comm-contacts">\n${contactsBlock(contactsOf(d), labels.mediaContacts, 4)}\n</div>` : "";
    return `<div class="${cls}"${lang}>
<div class="backgrounder-header"><h3>${e(title)}</h3></div>
<div class="backgrounder-content">
${present(d.subheadline) ? `<p class="subheadline">${e(d.subheadline)}</p>\n` : ""}${present(d.byline) ? `<p><b>${withBreaks(d.byline.trim())}</b></p>\n` : ""}${bodyOf(d, base, title, `bg${n}-`)}${contacts}
</div>
</div>`;
  };
  const allBackgrounders = [
    ...backgrounders.map((d, i) => backgrounder(d, "backgrounder", d.languageId === FRENCH ? ` lang="fr"` : "", i + 1)),
    // With a French main document there is no toggle, so the other French documents are ordinary backgrounders.
    ...frenchBackgrounders.map((d, i) => backgrounder(d, french ? "backgrounder story-lang secondary" : "backgrounder", ` lang="fr"`, backgrounders.length + i + 1)),
  ];
  const backgroundersHeading = allBackgrounders.length
    ? french
      ? `<h2><span class="story-lang primary">Backgrounders</span><span class="story-lang secondary" lang="fr">Détails supplémentaires</span></h2>`
      : `<h2>Backgrounders</h2>`
    : "";

  const assets = assetItems.length ? `<div id="assets" class="assets expanded">\n<h2>Media Assets</h2>\n<div class="media-assets-container">\n<ul>\n${assetItems.join("\n")}\n</ul>\n</div>${licenceLine(settings.pageText.assetLicence, site)}\n</div>` : "";
  const bodyTranslations = translationItems(post.azureTranslations ?? [], "");
  const translations = bodyTranslations.length ? `<div${assetItems.length ? "" : ' id="assets"'} class="assets expanded">\n<h2 id="translations">Translations</h2>\n<div class="media-assets-container">\n<ul>\n${bodyTranslations.join("\n")}\n</ul>\n</div>\n</div>` : "";

  const primaryAsset = lead ? `<div class="story-copy primary-asset">${renderMedia(lead, base, headline)}</div>` : "";
  // news.gov's short link at the end of the story (legacy .share-options; print.css hides it).
  const permalink = shortLink ? `<div class="share-options">\n<div class="share-permalink">${e(shortLink)}</div>\n<div class="clear"></div>\n</div>` : "";
  const storyBody = [primaryAsset, ...bylines, ...selectors, ...copies, bodyContacts, backgroundersHeading, ...allBackgrounders, assets, translations, permalink].filter(Boolean).join("\n");

  const header = [
    `<button type="button" class="print-document">${icon("print", e(base))} Print</button>`,
    storyMinistry(site, ctx.leadMinistry, ctx.leadMinistrySuccessor),
    `<div class="print-title">${e(site.name)}</div>`,
    `<h1 class="story-lang primary"${mainLang}>${e(headline)}</h1>${frHeadline}`,
    `<div class="print-url">${e(shortLink ?? canonical)}</div>`,
    `<div class="print-date">${e(date)}</div>`,
    ...subheadlines,
  ].filter(Boolean);

  const body = `<div class="story-page pt-4">
${header.join("\n")}
${storyInfo}
${sideColumn(site, post, main, labels, ctx, { translations: sideTranslations, date, assetsShown: assetItems.length > 0, share })}
<div class="story-body" id="main-content-release">
${storyBody}
</div>
</div>`;

  const trail = relatedBand(site, post, ctx);
  return renderPage(headline, site, path, body, {
    ...opts,
    description: post.summary,
    social: { title: headline, description: post.summary, image: socialImage(lead), imageAlt: headline, type: "article" },
    ...(trail ? { trail } : {}),
  });
}
