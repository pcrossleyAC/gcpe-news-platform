import type { PostDto } from "../dto";
import { icon } from "../icons";
import { basePath, e, type SiteInfo } from "../render";
import { pageUrl } from "../site-paths";
import { displayDateTime } from "./format";
import { leadMedia } from "./media";

const ENGLISH = 4105;

/**
 * A card thumbnail sized to its slot: legacy's 222px column (desktop), the full column width
 * under 1120px. Flickr serves every size up to 1024px under the photo's one secret, by suffix
 * (`_n` 320w, `_z` 640w, `_b` 1024w), so the browser picks instead of always fetching the 1024px
 * `_b` the assetUrl usually names. width/height reserve a 3:2 box (CSS keeps height:auto). Lazy
 * unless the card is the top story, whose thumbnail may be the page's largest paint.
 */
export function flickrThumb(src: string, lazy = true): string {
  const stem = src.replace(/(_[a-z])?\.jpg$/, "");
  const at = (suffix: string) => e(`${stem}_${suffix}.jpg`);
  return `<img src="${at("n")}" srcset="${at("n")} 320w, ${at("z")} 640w, ${at("b")} 1024w" sizes="(max-width: 1120px) 100vw, 222px" width="320" height="213" alt=""${lazy ? ' loading="lazy"' : ""}>`;
}

/**
 * One post as legacy `Views/Shared/PostCard.cshtml` renders it (home, ministry and category
 * lists), less its inline `<style>` and with the icons from our sprite. The Media Assets and
 * Translations links show only when the News API says so (absent flags show neither). Only a
 * Flickr lead gets a thumbnail: a YouTube one would be a third-party load (C209). The thumbnail
 * link repeats the headline link, so it is kept out of the tab order and the accessibility tree
 * rather than being a link with no name. "Read More" carries the headline, visually hidden.
 */
export function postCard(site: Pick<SiteInfo, "baseUrl">, p: PostDto, o: { hidden?: boolean; eager?: boolean } = {}): string {
  const base = e(basePath(site));
  const href = e(pageUrl(site, { type: "post", key: p.key }));
  const english = p.documents.find((d) => d.languageId === ENGLISH) ?? p.documents[0];
  const headline = e(english?.headline || p.key);
  const links = [
    p.hasMediaAssets === true ? `<div class="item-medialink media-assets"><a href="${href}#assets">${icon("download", base)} Media Assets</a></div>` : "",
    p.hasTranslations === true ? `<div class="item-medialink translations"><a href="${href}#translationList">${icon("language", base)} Translations</a></div>` : "",
  ].join("");
  const lead = leadMedia(p.assetUrl);
  const thumb = lead?.kind === "image" ? `<div class="item-asset asset flickr"><a href="${href}" aria-hidden="true" tabindex="-1">${flickrThumb(lead.src, !o.eager)}</a></div>` : "";
  // Legacy AsHtmlParagraphs: one paragraph per line.
  const summary = p.summary?.trim()
    ? p.summary
        .split(/\r?\n/)
        .map((line) => `<p>${e(line)}</p>`)
        .join("")
    : "";
  return `<div class="article${o.hidden ? " hidden-article" : ""}">
<h2><a href="${href}">${headline}</a></h2>
<div class="list-container ps-0 pb-0">
<div class="item-date">${e(displayDateTime(p.publishDate))}</div>${links}
</div>
<div class="item-content">${thumb}
<div class="item-text${thumb ? " with-image" : ""}">${summary}
<a href="${href}" class="read-more">${icon("caret-right", base)} Read More<span class="visually-hidden">: ${headline}</span></a>
</div>
</div>
<div class="clear"></div>
</div>`;
}

/** Legacy shows the first three latest posts (home and ministry pages); the rest wait behind
 * "Load More News", which site.js wires to reveal them (without script, CSS shows them all). */
export const VISIBLE_LATEST = 3;

/** The latest posts as PostCards, those past {@link VISIBLE_LATEST} hidden, and the Load More
 * button (empty when nothing is hidden) that reveals `#regular-articles`' hidden cards. */
export function latestCards(site: Pick<SiteInfo, "baseUrl">, latest: PostDto[]): { cards: string; loadMore: string } {
  return {
    cards: latest.map((p, i) => postCard(site, p, { hidden: i >= VISIBLE_LATEST })).join("\n"),
    loadMore: latest.length > VISIBLE_LATEST ? `<button type="button" class="load-more link-button" aria-controls="regular-articles">Load More News</button>\n` : "",
  };
}
