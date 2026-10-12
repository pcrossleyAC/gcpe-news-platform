import type { PostDto, ResourceLinkDto, SlideDto } from "../dto";
import { basePath, e, renderPage, safeHref, type PageOptions, type SiteInfo } from "../render";
import { feedUrl, pageUrl } from "../site-paths";
import { displayDate, postListItem } from "./format";

export interface HomeView {
  top: PostDto | null;
  feature: PostDto | null;
  latest: PostDto[];
  slides: SlideDto[];
  links: ResourceLinkDto[];
}

const ENGLISH = 4105;
const english = (p: PostDto) => p.documents.find((d) => d.languageId === ENGLISH) ?? p.documents[0];

function postCard(site: Pick<SiteInfo, "baseUrl">, p: PostDto): string {
  const headline = english(p)?.headline ?? p.key;
  const summary = p.summary ? `<p>${e(p.summary)}</p>` : "";
  return `<div class="card"><a href="${e(pageUrl(site, { type: "post", key: p.key }))}">${e(headline)}</a> <time datetime="${e(p.publishDate)}">${e(displayDate(p.publishDate))}</time>${summary}</div>`;
}

/** A non-rotating slide: headline, summary and (when given) one action link — no auto-advancing
 * carousel and no JavaScript needed (WCAG 2.2.2, C205). */
function slideCard(s: SlideDto): string {
  const summary = s.summary ? `<p>${e(s.summary)}</p>` : "";
  const actionHref = safeHref(s.actionUri);
  const action = actionHref ? `<p><a href="${e(actionHref)}">${e(s.actionLabel ?? "Learn more")}</a></p>` : "";
  return `<article class="card"><h3>${e(s.headline)}</h3>${summary}${action}</article>`;
}

export function renderHomePage(view: HomeView, site: SiteInfo, opts: PageOptions = {}): string {
  const top = view.top ? `<section>\n<h2>Top story</h2>\n${postCard(site, view.top)}\n</section>` : "";
  const feature = view.feature ? `<section>\n<h2>Featured</h2>\n${postCard(site, view.feature)}\n</section>` : "";
  const highlights = view.slides.length
    ? `<section aria-labelledby="highlights-heading">\n<h2 id="highlights-heading">Highlights</h2>\n${view.slides.map(slideCard).join("\n")}\n</section>`
    : "";
  const more = view.latest.length
    ? `<section>\n<h2>More news</h2>\n<ul class="post-list">\n${view.latest.map((p) => postListItem(site, { key: p.key, headline: english(p)?.headline ?? p.key, publishDate: p.publishDate, summary: p.summary })).join("\n")}\n</ul>\n</section>`
    : "";
  const resourceItem = (l: ResourceLinkDto) => {
    const href = safeHref(l.uri);
    return href ? `<li><a href="${e(href)}">${e(l.key)}</a></li>` : `<li>${e(l.key)}</li>`;
  };
  const resources = view.links.length ? `<section>\n<h2>Resources</h2>\n<ul>\n${view.links.map(resourceItem).join("\n")}\n</ul>\n</section>` : "";

  const body = `<h1>Latest news</h1>\n${top}\n${feature}\n${highlights}\n${more}\n${resources}`;
  return renderPage("Home", site, `${basePath(site)}/`, body, {
    ...opts,
    feed: { href: feedUrl(site, { type: "home" }), title: `${site.name}: latest news` },
  });
}
