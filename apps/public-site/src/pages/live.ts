import type { PageTextSettings } from "@gcpe/site-settings";
import { basePath, e, renderPage, type PageOptions, type SiteInfo } from "../render";
import { sanitizeBodyHtml } from "../sanitize-body";
import { liveStreamUrl } from "../settings";
import { pageUrl } from "../site-paths";

/** The stream's host as the visitor should see it before pressing Play ("" for anything unparsable). */
function hostOf(stream: string): string {
  try {
    return new URL(stream).host;
  } catch {
    return "";
  }
}

/** Staff HTML from the settings: sanitised (no images, headings demoted), never raw. */
const rich = (html: string): string => sanitizeBodyHtml(html, { images: false });

/**
 * `/live/` (H4): legacy Live view + the web-cast component. `stream` is the home settings' https
 * playlist URL (settings.ts liveStreamUrl) or null for off air; anything that is not https is off air
 * here too (the one check lives in liveStreamUrl), and the URL only ever goes in `data-stream` and the stream link.
 *
 * Consent first: nothing here references the stream host except the plain link (not fetched) and
 * `data-stream`, which site.js reads on Play. The play button is a real button named by visually
 * hidden text and described by the consent paragraph (`aria-describedby`); the consent text
 * (settings HTML, sanitised, then `{host}` replaced by the escaped host) is visible before Play.
 * The placeholder image is decorative (alt=""): the button names the action.
 */
export function renderLivePage(streamUrl: string | null, t: PageTextSettings["live"], site: SiteInfo, opts: PageOptions = {}): string {
  // The builder passes liveStreamUrl's answer; asking it again keeps a caller's unchecked URL off the page.
  const stream = liveStreamUrl({ liveWebcastM3uPlaylist: streamUrl });
  const base = basePath(site);
  const image = `<img src="${e(base)}/assets/legacy/Content/Images/Gov/Live_Webcast.png" alt="" width="768" height="432">`;
  let player: string;
  if (stream === null) {
    player = `<div class="wowza-wrapper asset video off-air">
<div class="placeholder-container">
${image}
</div>
<div class="off-air-text">${rich(t.offAirHtml)}</div>
</div>`;
  } else {
    const consent = rich(t.consentHtml).split("{host}").join(e(hostOf(stream)));
    player = `<div class="wowza-wrapper asset wowza video" data-stream="${e(stream)}">
<div class="placeholder-container">
${image}
<div class="overlay-container"><div class="outer"><div class="inner">
<button type="button" class="play-button" aria-describedby="live-consent"><span class="visually-hidden">Play the live webcast</span></button>
<div id="live-consent" class="play-instructions preface">${consent}</div>
</div></div></div>
</div>
<video controls preload="none" playsinline tabindex="-1" hidden></video>
<p id="live-status" role="status"></p>
<p class="live-stream-link"><a href="${e(stream)}">Open the stream in your media player</a></p>
</div>`;
  }
  const body = `<div class="connect">
<div class="home-body" id="main-content-release">
<h1 class="page-label">${e(t.heading)}</h1>
<div id="body" class="container live-body">
${player}
</div>
</div>
</div>`;
  return renderPage(t.heading, site, pageUrl(site, { type: "live" }), body, opts);
}
