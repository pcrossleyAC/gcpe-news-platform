import type { PageTextSettings } from "@gcpe/site-settings";
import { e, renderPage, type PageOptions, type SiteInfo } from "../render";
import { sanitizeBodyHtml } from "../sanitize-body";
import { pageUrl } from "../site-paths";

/**
 * `/privacy/` (L1): legacy Default/Privacy.cshtml from the Page text settings. The legacy label
 * h3 is a paragraph here (the title is the page's one h1; overrides.css gives it the legacy look)
 * and the legacy "Reset Preferences" block is left out (spec conflict 9). The body is staff HTML
 * with no server-side sanitiser behind it, so it goes through sanitizeBodyHtml (images off, headings
 * demoted so no second h1); label and title are plain text, escaped.
 */
export function renderPrivacyPage(p: PageTextSettings["privacy"], site: SiteInfo, opts: PageOptions = {}): string {
  const label = p.label.trim() !== "" ? `<p class="page-label">${e(p.label)}</p>\n` : "";
  const body = `<div class="connect">
<div class="home-body" id="main-content-release">
${label}<h1>${e(p.title)}</h1>
<div id="body">
${sanitizeBodyHtml(p.bodyHtml, { images: false })}
</div>
</div>
</div>`;
  return renderPage(p.title, site, pageUrl(site, { type: "privacy" }), body, opts);
}
