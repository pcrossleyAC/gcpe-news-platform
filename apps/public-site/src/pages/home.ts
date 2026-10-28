import { DEFAULT_NAVIGATION, type NavigationSettings } from "@gcpe/site-settings";
import type { PostDto, ResourceLinkDto, SlideDto } from "../dto";
import { icon } from "../icons";
import { basePath, e, renderPage, safeHref, safeSrc, type PageOptions, type SiteInfo } from "../render";
import { themeDefaults } from "../settings";
import { feedUrl, pageUrl } from "../site-paths";
import { connectStrip } from "./connect-strip";
import { latestCards, postCard } from "./post-card";
import { resourceHref, resourcesBox } from "./resources";

export { resourceHref };

export interface HomeView {
  top: PostDto | null;
  feature: PostDto | null;
  latest: PostDto[];
  slides: SlideDto[];
  links: ResourceLinkDto[];
  /** The active sectors, by name, each with its newest post (null: none, and it is left out). */
  sectors: { key: string; name: string; latest: PostDto | null }[];
}


const ENGLISH = 4105;
const headlineOf = (p: PostDto) => (p.documents.find((d) => d.languageId === ENGLISH) ?? p.documents[0])?.headline || p.key;

/** An action link's purpose, visually hidden (as PostCard's "Read More" carries its headline):
 * "Learn more" alone doesn't say where it goes (WCAG 2.4.4; Lighthouse link-text). With no
 * headline, the item's position names it instead (`fallback`), so the link is never bare. */
const purpose = (s: SlideDto, fallback: string) => `<span class="visually-hidden">: ${e(s.headline || fallback)}</span>`;

/**
 * Legacy HomeCarousel.cshtml as a static band (the page's `lead`): the non-emergency slides in
 * sort order, the first one `.current`, each a `group` named "Slide n of N" (the APG carousel
 * pattern). There is no auto-advance (C205). With two or more slides, one Previous/Next pair
 * follows the slides — outside `.carousel-slides`, which site.js makes the polite live region on
 * the first click, so only the slide content is announced. The pair sits in its own
 * `.home-banner-content > .stories` so legacy's arrow placement applies unchanged. Without
 * JavaScript every slide shows, stacked, and the buttons are hidden (overrides.css). The image is
 * decorative (alt=""): the headline says the same thing.
 */
export function renderCarousel(slides: SlideDto[], base: string, labels: Pick<NavigationSettings["labels"], "highlights" | "slideActionLabel"> = DEFAULT_NAVIGATION.labels): string {
  const shown = slides.filter((s) => !s.emergency).sort((a, b) => a.sortIndex - b.sortIndex);
  if (shown.length === 0) return "";
  const n = shown.length;
  const banners = shown.map((s, i) => {
    const src = safeSrc(s.imageUrl);
    // The first slide's image is the page's largest paint: fetch it first; the hidden ones lazily.
    const img = src ? `\n<img class="home-banner-image" src="${e(src)}" alt=""${i === 0 ? ` fetchpriority="high"` : ` loading="lazy"`}>` : "";
    const href = safeHref(s.actionUri);
    const headline = s.headline ? `<h2>${href ? `<a href="${e(href)}">${e(s.headline)}</a>` : e(s.headline)}</h2>` : "";
    const summary = s.summary ? `<p class="summary">${e(s.summary)}</p>` : "";
    const action = href ? `<div><a href="${e(href)}" class="read-more">${icon("caret-right", e(base))} ${e(s.actionLabel || labels.slideActionLabel)}${purpose(s, `slide ${i + 1} of ${n}`)}</a></div>` : "";
    return `<div class="home-banner${i === 0 ? " current" : ""}" role="group" aria-roledescription="slide" aria-label="Slide ${i + 1} of ${n}">${img}
<div class="home-banner-content"><div class="stories">
<div class="story ${s.justify === "right" ? "right" : "left"}">${headline}${summary}${action}</div>
</div></div>
<div class="bottom-fade"></div>
</div>`;
  });
  const nav =
    n > 1
      ? `\n<div class="home-banner carousel-controls"><div class="home-banner-content"><div class="stories">
<button type="button" class="story-nav story-previous" aria-label="Previous highlight"></button>
<button type="button" class="story-nav story-next" aria-label="Next highlight"></button>
</div></div></div>`
      : "";
  return `<section id="carousel-holder" aria-label="${e(labels.highlights)}" aria-roledescription="carousel">\n<div class="carousel-slides">\n${banners.join("\n")}\n</div>${nav}\n</section>`;
}

/** C208: a pinned emergency slide, as a home-body article card (under its region's h2). */
function emergencyCard(s: SlideDto, base: string, i: number, n: number, fallbackLabel: string): string {
  const href = safeHref(s.actionUri);
  const headline = s.headline ? `<h3>${e(s.headline)}</h3>` : "";
  const summary = s.summary ? `<p>${e(s.summary)}</p>` : "";
  const action = href ? `\n<a href="${e(href)}" class="read-more">${icon("caret-right", e(base))} ${e(s.actionLabel || fallbackLabel)}${purpose(s, `emergency notice ${i + 1} of ${n}`)}</a>` : "";
  return `<div class="article">${headline}
<div class="item-content"><div class="item-text">${summary}${action}
</div></div>
<div class="clear"></div>
</div>`;
}

function resourceBoxes(view: HomeView, site: SiteInfo, labels: NavigationSettings["labels"]): string {
  const resources = resourcesBox(site, labels.resources, view.links);
  const sectors = view.sectors.filter((s): s is typeof s & { latest: PostDto } => !!s.latest);
  const bySector = sectors.length
    ? `<div class="resource-links">\n<h2>${e(labels.newsBySector)}</h2>\n<div>\n${sectors
        .map((s) => `<h3>${e(s.name)}</h3>\n<p><a href="${e(pageUrl(site, { type: "post", key: s.latest.key }))}">${e(headlineOf(s.latest))}</a></p>`)
        .join("\n")}\n</div>\n</div>`
    : "";
  // Nothing to show: no empty container.
  return resources || bySector ? `<div class="collapsible-regions">${resources ? `\n${resources}` : ""}${bySector ? `\n${bySector}` : ""}\n</div>` : "";
}

/**
 * Legacy HomeView.cshtml with the plan-1 accessibility deviations: one visually hidden h1, the
 * side column a labelled section (not an <aside> inside <main>), its headings one level up, and
 * Resources/News by Sector rendered once inside it (in place of legacy's JS clone). The column
 * follows the news in the DOM, so on a phone it stacks below the news in reading order; CSS order
 * puts it on the left on a desktop. "Load More News" is a button revealing the cards
 * already on the page (site.js); without JavaScript they all show and the button is hidden.
 */
export function renderHomePage(view: HomeView, site: SiteInfo, opts: PageOptions = {}): string {
  const base = basePath(site);
  const settings = opts.settings ?? themeDefaults(site.theme);
  const labels = settings.navigation.labels;
  const emergencySlides = view.slides.filter((s) => s.emergency).sort((a, b) => a.sortIndex - b.sortIndex);
  const emergency = emergencySlides.length
    ? `<section aria-labelledby="emergency-heading">\n<h2 id="emergency-heading">${e(labels.emergencyInformation)}</h2>\n${emergencySlides.map((s, i) => emergencyCard(s, base, i, emergencySlides.length, labels.slideActionLabel)).join("\n")}\n</section>\n`
    : "";
  const top = view.top ? `<div class="top-article">\n${postCard(site, view.top, { eager: true })}\n</div>\n` : "";
  const feature = view.feature ? `<div class="feature-article">\n${postCard(site, view.feature)}\n</div>\n` : "";
  const { cards, loadMore } = latestCards(site, view.latest, { loadMoreLabel: labels.loadMoreNews });
  const body = `<h1 class="visually-hidden">${e(labels.latestNews)}</h1>
<div class="home-layout">
<div class="home-body" id="main-content-release">
${emergency}${top}<div class="other-articles">
${feature}<div id="regular-articles" class="regular-articles">
${cards}
</div>
<div class="news-control">
${loadMore}<a href="${e(base)}/search/" class="read-more">${e(labels.searchNews)}</a>
<div class="clear"></div>
</div>
</div>
</div>
<section class="home-features" aria-label="Connect and resources">
${connectStrip(settings, base)}
${resourceBoxes(view, site, labels)}
</section>
</div>`;
  return renderPage("Home", site, `${base}/`, body, {
    ...opts,
    googleVerificationMeta: site.verification?.googleMeta ?? null,
    lead: renderCarousel(view.slides, base, labels) || undefined,
    feed: { href: feedUrl(site, { type: "home" }), title: `${site.name}: latest news` },
  });
}
