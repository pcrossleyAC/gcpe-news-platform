import type { PostDto } from "../dto";
import { icon } from "../icons";
import { basePath, e, type SiteInfo } from "../render";
import { pageUrl } from "../site-paths";
import { displayDateTime } from "./format";
import { leadMedia } from "./media";

const ENGLISH = 4105;

/**
 * One post as legacy `Views/Shared/PostCard.cshtml` renders it (home, ministry and category
 * lists), less its inline `<style>` and with the icons from our sprite. The Media Assets and
 * Translations links show only when the News API says so (absent flags show neither). Only a
 * Flickr lead gets a thumbnail: a YouTube one would be a third-party load (C209). The thumbnail
 * link repeats the headline link, so it is kept out of the tab order and the accessibility tree
 * rather than being a link with no name. "Read More" carries the headline, visually hidden.
 */
export function postCard(site: Pick<SiteInfo, "baseUrl">, p: PostDto, o: { hidden?: boolean } = {}): string {
  const base = e(basePath(site));
  const href = e(pageUrl(site, { type: "post", key: p.key }));
  const english = p.documents.find((d) => d.languageId === ENGLISH) ?? p.documents[0];
  const headline = e(english?.headline || p.key);
  const links = [
    p.hasMediaAssets === true ? `<div class="item-medialink media-assets"><a href="${href}#assets">${icon("download", base)} Media Assets</a></div>` : "",
    p.hasTranslations === true ? `<div class="item-medialink translations"><a href="${href}#translationList">${icon("language", base)} Translations</a></div>` : "",
  ].join("");
  const lead = leadMedia(p.assetUrl);
  const thumb = lead?.kind === "image" ? `<div class="item-asset asset flickr"><a href="${href}" aria-hidden="true" tabindex="-1"><img src="${e(lead.src)}" alt=""></a></div>` : "";
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
