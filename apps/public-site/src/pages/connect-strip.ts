import type { NetworkKey, SiteSettings } from "@gcpe/site-settings";
import { e } from "../render";

/** Legacy ConnectSocialMedia.cshtml's networks: the anchor id (legacy spelling, `connectThread`
 * included), the display name and the logo file under assets/legacy/Content/Images/SocialMedia. */
const STRIP: { key: NetworkKey; id: string; name: string; file: string }[] = [
  { key: "facebook", id: "connectFacebook", name: "Facebook", file: "facebook-svg-logo.svg" },
  { key: "x", id: "connectTwitter", name: "X", file: "twitter-X-svg-logo.svg" },
  { key: "instagram", id: "connectInstagram", name: "Instagram", file: "Instagram_logo_2016.svg" },
  { key: "threads", id: "connectThread", name: "Threads", file: "threads_logo.svg" },
  { key: "bluesky", id: "connectBluesky", name: "Bluesky", file: "bluesky-logo.svg" },
  { key: "linkedin", id: "connectLinkedin", name: "LinkedIn", file: "linkedin-logo-blue.svg" },
  { key: "flickr", id: "connectFlickr", name: "Flickr", file: "flickr-svg-logo.svg" },
  { key: "youtube", id: "connectYoutube", name: "YouTube", file: "youtube.svg" },
];

/** A network's logo file (shared with the Connect page's headings). */
export const NETWORK_LOGO: Record<string, string> = { ...Object.fromEntries(STRIP.map((n) => [n.key, n.file])), rss: "rss-logo.svg" };

/**
 * Legacy `ConnectSocialMedia` ("Connect With Us"), shared by the home page and anywhere else the strip is wanted:
 * one wrapping list of the networks that have accounts, then RSS (always), each icon linking to
 * its section of /connect/, then the "view all" link. Legacy's two rows are one list here, as
 * news.gov now shows it. Labels come from the navigation settings.
 */
export function connectStrip(settings: SiteSettings, base: string): string {
  const b = e(base);
  const img = (file: string, alt: string) => `<img src="${b}/assets/legacy/Content/Images/SocialMedia/${file}" alt="${e(alt)}" width="22" height="22">`;
  const items = [
    ...STRIP.filter((n) => settings.connect[n.key].accounts.length > 0).map((n) => `<li><a id="${n.id}" href="${b}/connect/#${n.key}">${img(n.file, n.name)}</a></li>`),
    `<li><a id="connectRss" href="${b}/connect/#rss">${img("rss-logo.svg", "RSS")}</a></li>`,
  ];
  const labels = settings.navigation.labels;
  return `<div class="resource-links connect">
<h2>${e(labels.connectWithUs)}</h2>
<ul>
${items.join("\n")}
</ul>
<a id="connectAllSocialMedia" href="${b}/connect/" class="read-more">${e(labels.viewAllSocialMedia)}</a>
</div>`;
}
