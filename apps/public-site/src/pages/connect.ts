import { connectDisplayOrder, type NetworkKey } from "@gcpe/site-settings";
import type { ResourceLinkDto } from "../dto";
import { basePath, e, renderPage, settingsLink, type PageOptions, type SiteInfo } from "../render";
import { settingsHref, themeDefaults } from "../settings";
import { pageUrl } from "../site-paths";
import { NETWORK_LOGO } from "./connect-strip";
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

/** One expandable section as a native `details` (open, so it needs no script). The heading's icon
 * is decorative; `body` is the list inside. */
function section(key: string, heading: string, body: string, base: string): string {
  const logo = NETWORK_LOGO[key];
  const img = logo ? ` <img class="connect-icon" src="${e(base)}/assets/legacy/Content/Images/SocialMedia/${logo}" alt="" width="24" height="24">` : "";
  return `<details class="expandable-section ${sectionClass(key)} expanded" id="${key}" open><summary><h2>${e(heading)}${img}</h2></summary><div class="expandable-section-content"><div class="expander-body">${body}</div></div></details>`;
}

/**
 * `/connect/` (page id `connect`), news.gov's Connect page: the h1, the policy link and intro (both
 * from the connect settings), one section per network in `NETWORKS` order (each section's id is the
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
      const lis = items.map((l) => `<li>${settingsLink(l, site)} <span>${e(l.summary ?? "")}</span></li>`).join("\n");
      return section(key, NETWORK_HEADING[key], `<ul class="external-links">\n${lis}\n</ul>`, base);
    })
    .filter(Boolean);
  const feedItems = feeds.map((f) => `<li><a href="${e(f.href)}">${e(f.title)}</a></li>`).join("\n");
  const rss = section("rss", "RSS Feeds", `<ul class="external-links">\n${feedItems}\n</ul>`, base);
  const body = `<div class="connect" id="connect-content">
<div class="home-layout">
<div class="home-body" id="main-content-release">
<h1>Connect</h1>
${policy}${introHtml}${[...networks, rss].join("\n")}
</div>
<section class="home-features" aria-label="Resources">
${resourcesBox(site, settings.navigation.labels.resources, links)}
</section>
</div>
</div>`;
  return renderPage("Connect", site, pageUrl(site, { type: "connect" }), body, opts);
}
