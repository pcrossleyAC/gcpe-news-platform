import { connectDisplayOrder, NETWORKS } from "@gcpe/site-settings";
import { e, renderPage, settingsLink, type PageOptions, type SiteInfo } from "../render";
import { themeDefaults } from "../settings";
import { pageUrl } from "../site-paths";

/**
 * `/connect/` (page id `connect`): the site settings' social accounts, one section per network in
 * `NETWORKS` order (each heading's id is the network key, so `/connect#x` lands on it), featured
 * accounts first as stored, then the rest sorted by name; a network with no links is left out.
 * Only a `connect` settings change rebuilds it.
 */
export function renderConnectPage(site: SiteInfo, opts: PageOptions): string {
  const settings = opts.settings ?? themeDefaults(site.theme);
  const sections = NETWORKS.map(({ key, name }) => {
    const links = connectDisplayOrder(settings.connect[key]);
    if (links.length === 0) return "";
    const items = links.map((l) => `<li>${settingsLink(l, site)}${l.summary ? `<p>${e(l.summary)}</p>` : ""}</li>`).join("\n");
    return `<section aria-labelledby="${key}">
<h2 id="${key}">${e(name)}</h2>
<ul class="connect-list">
${items}
</ul>
</section>`;
  }).filter(Boolean);
  return renderPage("Connect with Us", site, pageUrl(site, { type: "connect" }), `<h1>Connect with Us</h1>\n${sections.join("\n")}`, opts);
}
