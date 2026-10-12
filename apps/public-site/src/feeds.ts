import type { PostDto } from "./dto";
import { headlineOf } from "./post-index";
import { ex, type SiteInfo } from "./render";
import { absoluteUrl, pageUrl } from "./site-paths";
import { LATEST_COUNT } from "./pages/format";

/** The latest `LATEST_COUNT` posts as an RSS 2.0 feed (spec §6.1). Every piece of text and every
 * URL is gated through `ex()`, which escapes `&`/`<`/`>`/quotes and strips XML-illegal control
 * characters, so a hostile headline or summary can never produce ill-formed XML. */
export function renderRssFeed(channel: { title: string; pagePath: string; feedPath: string; description: string }, posts: PostDto[], site: SiteInfo): string {
  const items = posts.slice(0, LATEST_COUNT).map((p) => {
    const link = absoluteUrl(site, pageUrl(site, { type: "post", key: p.key }));
    const date = new Date(p.publishDate);
    const pubDate = Number.isNaN(date.getTime()) ? "" : `\n<pubDate>${date.toUTCString()}</pubDate>`;
    const description = p.summary ? `\n<description>${ex(p.summary)}</description>` : "";
    return `<item>\n<title>${ex(headlineOf(p))}</title>\n<link>${ex(link)}</link>\n<guid isPermaLink="true">${ex(link)}</guid>${pubDate}${description}\n</item>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${ex(channel.title)}</title>
<link>${ex(absoluteUrl(site, channel.pagePath))}</link>
<description>${ex(channel.description)}</description>
<language>en-ca</language>
<atom:link href="${ex(absoluteUrl(site, channel.feedPath))}" rel="self" type="application/rss+xml"/>
${items.join("\n")}
</channel>
</rss>
`;
}
