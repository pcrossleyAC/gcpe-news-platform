import { connectDisplayOrder, type NetworkKey } from "@gcpe/site-settings";
import type { ResourceLinkDto } from "../dto";
import { basePath, e, renderPage, settingsLink, type PageOptions, type SiteInfo } from "../render";
import { settingsHref, themeDefaults } from "../settings";
import { pageUrl } from "../site-paths";
import { icon, type IconId } from "../icons";
import { resourcesBox } from "./resources";

/** Legacy ConnectView's section headings, in `NETWORKS` order. */
const NETWORK_HEADING: Record<NetworkKey, string> = {
  facebook: "Find us on Facebook",
  x: "Follow us on X",
  instagram: "Find us on Instagram",
  threads: "Find us on Threads",
  bluesky: "Find us on Bluesky",
  linkedin: "Find us on LinkedIn",
  flickr: "See Photos in Flickr",
  youtube: "Watch us on YouTube",
  blogs: "Blogs and Engagement Sites",
};

/** The class legacy's CSS knows each section by (X is still `twitter` there). */
const sectionClass = (key: string) => (key === "x" ? "twitter" : key);

/** Each heading's glyph from the Font Awesome sprite, as news.gov's own headings use (white, inline after the text). */
const HEADING_ICON: Record<string, IconId> = {
  facebook: "square-facebook", x: "square-x-twitter", instagram: "instagram", threads: "square-threads", bluesky: "square-bluesky",
  linkedin: "linkedin", flickr: "flickr", youtube: "youtube", blogs: "blog", rss: "rss",
};

/** The name in "Expand {name} list" (legacy's button text), where it isn't the heading's own network. */
const LIST_NAME: Record<string, string> = {
  facebook: "Facebook", x: "X", instagram: "Instagram", threads: "Threads", bluesky: "Bluesky", linkedin: "LinkedIn",
  flickr: "Flickr", youtube: "YouTube", blogs: "Blogs", rss: "RSS",
};

/** Lists longer than this collapse (site.js) to this many entries, as legacy's 100px `.collapsed` body did. */
const VISIBLE = 2;

/**
 * One section: a heading bar (the icon is decorative, inline after the text) and its list. Every entry
 * is rendered, so with script off the whole list shows. A list of more than two entries is marked
 * `data-collapsible` for site.js, which collapses it and adds the Expand button (legacy's rule is
 * editorial, not a count: its Blogs list of four is left open, so Blogs is never marked).
 */
function section(key: string, heading: string, items: string[], base: string): string {
  const img = ` ${icon(HEADING_ICON[key]!, base, "icon connect-icon")}`;
  const collapsible = items.length > VISIBLE && key !== "blogs";
  const attrs = collapsible ? ` data-collapsible="${VISIBLE}" data-list-name="${LIST_NAME[key]}"` : "";
  const listId = collapsible ? ` id="${key}-list"` : "";
  return `<div class="expandable-section ${sectionClass(key)} expanded" id="${key}"${attrs}><h2>${e(heading)}${img}</h2><div class="expandable-section-content"><div class="expander-body"><ul class="external-links"${listId}>\n${items.join("\n")}\n</ul></div></div></div>`;
}

/**
 * `/connect/` (page id `connect`), news.gov's Connect page: the h1, the policy link and intro (both
 * from the connect settings), one section per network (long lists collapse in site.js) in `NETWORKS` order (each section's id is the
 * network key, so `/connect/#x` lands on it; featured accounts first as stored, then the rest sorted
 * by name; a network with no links is left out), the RSS Feeds list, and the Resources box beside
 * them. Staff text is escaped; a staff URL that isn't safe is plain text. The intro is plain text
 * with its line breaks kept.
 */
export function renderConnectPage(site: SiteInfo, opts: PageOptions, feeds: { title: string; href: string }[], links: ResourceLinkDto[]): string {
  const settings = opts.settings ?? themeDefaults(site.theme);
  const base = basePath(site);
  const { policyLink, intro } = settings.connect;
  const policyHref = policyLink?.text ? settingsHref(policyLink.url, site) : null;
  const policy = policyLink?.text ? `<p>${policyHref ? `<a href="${e(policyHref)}">${e(policyLink.text)}</a>` : e(policyLink.text)}</p>\n` : "";
  const introHtml = intro?.trim() ? `<p class="connect-intro">${e(intro).replace(/\r?\n/g, "<br>")}</p>\n` : "";
  const networks = (Object.keys(NETWORK_HEADING) as NetworkKey[])
    .map((key) => {
      const items = connectDisplayOrder(settings.connect[key] ?? { featured: [], accounts: [] });
      if (items.length === 0) return "";
      const lis = items.map((l) => `<li>${settingsLink(l, site)} <span>${e(l.summary ?? "")}</span></li>`);
      return section(key, NETWORK_HEADING[key], lis, base);
    })
    .filter(Boolean);
  const rss = section("rss", "RSS Feeds", feeds.map((f) => `<li><a href="${e(f.href)}">${e(f.title)}</a></li>`), base);
  const body = `<div class="connect" id="connect-content">
<div class="home-layout">
<div class="home-body" id="main-content-release">
<h1 class="connect-title">Connect</h1>
${policy}${introHtml}${[...networks, rss].join("\n")}
</div>
<section class="home-features" aria-label="Resources">
${resourcesBox(site, settings.navigation.labels.resources, links)}
</section>
</div>
</div>`;
  return renderPage("Connect", site, pageUrl(site, { type: "connect" }), body, opts);
}
