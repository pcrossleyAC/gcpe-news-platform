import type { PostDto } from "./dto";
import { headlineOf } from "./post-index";
import { ex, type SiteInfo } from "./render";
import { LATEST_COUNT } from "./pages/format";
import { absoluteUrl, pageUrl } from "./site-paths";
import type { MenuMinistry } from "./ministry-menu";

/** Only a uuid URN (what NRMS stamps on publish, `uuid:<id>`) is used as an item id. */
const ATOM_ID = /^uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The item's legacy identity: news.gov's guid/id is the post's atomId, so feed readers that knew
 * news.gov's items see the same items after cutover. Null ⇒ the permalink stays the id. */
const legacyId = (p: PostDto): string | null => (p.atomId && ATOM_ID.test(p.atomId) ? p.atomId : null);

/** The lead ministry's name, as news.gov's item category; null when the ministry isn't known. */
function categoryName(p: PostDto, names: readonly MenuMinistry[] | null | undefined): string | null {
  const key = (p.leadMinistryKey ?? p.ministryKeys[0] ?? "").toLowerCase();
  return (key && names?.find((m) => m.key.toLowerCase() === key)?.name) || null;
}

export { FEED_POST_KINDS, kindFeedFile } from "./site-paths";

/** The latest `LATEST_COUNT` posts as an RSS 2.0 feed (spec §6.1). Every piece of text and every
 * URL is gated through `ex()`, which escapes `&`/`<`/`>`/quotes and strips XML-illegal control
 * characters, so a hostile headline or summary can never produce ill-formed XML. */
export function renderRssFeed(channel: { title: string; pagePath: string; feedPath: string; description: string }, posts: PostDto[], site: SiteInfo, names?: readonly MenuMinistry[] | null): string {
  const items = posts.slice(0, LATEST_COUNT).map((p) => {
    const link = absoluteUrl(site, pageUrl(site, { type: "post", key: p.key }));
    const date = new Date(p.publishDate);
    const pubDate = Number.isNaN(date.getTime()) ? "" : `\n<pubDate>${date.toUTCString()}</pubDate>`;
    const description = p.summary ? `\n<description>${ex(p.summary)}</description>` : "";
    const id = legacyId(p);
    const guid = id ? `<guid isPermaLink="false">${ex(id)}</guid>` : `<guid isPermaLink="true">${ex(link)}</guid>`;
    const name = categoryName(p, names);
    const category = name ? `\n<category>${ex(name)}</category>` : "";
    return `<item>\n<title>${ex(headlineOf(p))}</title>\n<link>${ex(link)}</link>\n${guid}${category}${pubDate}${description}\n</item>`;
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

const EPOCH = "1970-01-01T00:00:00Z";
/** An ISO-8601 UTC instant without milliseconds, or null for an unparseable date. */
const instant = (iso: string): string | null => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, "Z");
};

/** The latest `LATEST_COUNT` posts as an Atom 1.0 feed, beside the RSS one. Same `ex()` gate as
 * `renderRssFeed`. Feed `updated` is the newest item's publish instant (not the build time, so an
 * unchanged feed is byte-identical), or the epoch with no items. */
export function renderAtomFeed(channel: { title: string; pagePath: string; feedPath: string; description: string }, posts: PostDto[], site: SiteInfo, names?: readonly MenuMinistry[] | null): string {
  const items = posts.slice(0, LATEST_COUNT);
  const entries = items.map((p) => {
    const link = absoluteUrl(site, pageUrl(site, { type: "post", key: p.key }));
    const summary = p.summary ? `\n<summary>${ex(p.summary)}</summary>` : "";
    const at = instant(p.publishDate);
    const published = at ? `\n<published>${at}</published>` : "";
    const name = categoryName(p, names);
    const category = name ? `\n<category term="${ex(name)}"/>` : "";
    return `<entry>\n<title>${ex(headlineOf(p))}</title>\n<id>${ex(legacyId(p) ?? link)}</id>\n<link href="${ex(link)}"/>${published}\n<updated>${at ?? EPOCH}</updated>${summary}${category}\n</entry>`;
  });
  const newest = items.map((p) => instant(p.publishDate)).filter((x): x is string => x !== null).sort().at(-1) ?? EPOCH;
  const feedUrl = absoluteUrl(site, channel.feedPath);
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>${ex(channel.title)}</title>
<subtitle>${ex(channel.description)}</subtitle>
<id>${ex(feedUrl)}</id>
<updated>${newest}</updated>
<link rel="self" type="application/atom+xml" href="${ex(feedUrl)}"/>
<link rel="alternate" type="text/html" href="${ex(absoluteUrl(site, channel.pagePath))}"/>
<author><name>${ex(site.name)}</name></author>
${entries.join("\n")}
</feed>
`;
}
