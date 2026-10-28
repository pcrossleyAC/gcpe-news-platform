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

/** How many entries a list shows before its Expand button when its network sets no `collapseAfter` (legacy's 100px `.collapsed` body). */
const DEFAULT_KEEP = 2;

/**
 * One section: a heading bar (the icon is decorative, inline after the text) and its list. Every entry
 * is rendered. A list longer than `keep` (the network's `collapseAfter`, 2 when absent; 0 never
 * collapses) starts `collapsed` with `data-collapsible`, its entry `keep` marked `collapse-last` (faded)
 * and the rest `collapse-extra`, and an "Expand {name} list" button after it. overrides.css applies
 * all of that only under `html.js` (set in the head, before the first paint), so the page paints
 * collapsed with no layout shift; site.js wires the button. With script off every entry shows and the
 * button is hidden.
 */
function section(key: string, heading: string, items: string[], base: string, keep = DEFAULT_KEEP): string {
  const img = ` ${icon(HEADING_ICON[key]!, base, "icon connect-icon")}`;
  const collapsible = keep > 0 && items.length > keep;
  const attrs = collapsible ? ` data-collapsible="${keep}" data-list-name="${LIST_NAME[key]}"` : "";
  const listId = collapsible ? ` id="${key}-list"` : "";
  const mark = (i: number) => (!collapsible ? "" : i === keep - 1 ? ` class="collapse-last"` : i >= keep ? ` class="collapse-extra"` : "");
  const lis = items.map((inner, i) => `<li${mark(i)}>${inner}</li>`).join("\n");
  const button = collapsible ? `<button type="button" class="link-button expand-toggle" aria-controls="${key}-list" aria-expanded="false">Expand ${LIST_NAME[key]} list</button>` : "";
  return `<div class="expandable-section ${sectionClass(key)} ${collapsible ? "collapsed" : "expanded"}" id="${key}"${attrs}><h2>${e(heading)}${img}</h2><div class="expandable-section-content"><div class="expander-body"><ul class="external-links"${listId}>\n${lis}\n</ul></div></div>${button}</div>`;
}

/**
 * `/connect/` (page id `connect`), news.gov's Connect page: the h1, the policy link and intro (both
 * from the connect settings), one section per network (long lists collapse, per the network's `collapseAfter`) in `NETWORKS` order (each section's id is the
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
      const network = settings.connect[key] ?? { featured: [], accounts: [] };
      const items = connectDisplayOrder(network);
      if (items.length === 0) return "";
      // The summary span only when there is one: overrides.css underlines a link with text beside it.
      const lis = items.map((l) => `${settingsLink(l, site)}${l.summary?.trim() ? ` <span>${e(l.summary)}</span>` : ""}`);
      return section(key, NETWORK_HEADING[key], lis, base, network.collapseAfter ?? DEFAULT_KEEP);
    })
    .filter(Boolean);
  const rss = section("rss", "RSS Feeds", feeds.map((f) => `<a href="${e(f.href)}">${e(f.title)}</a>`), base);
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
