import { cleanRichHtml, type RichHtmlOptions } from "@gcpe/site-settings/rich-html";
import { demoteHeadings } from "./pages/format";

/**
 * The release body (`detailsHtml`) and the minister's `details` are staff-authored HTML from
 * NRMS, trusted and rendered raw everywhere else in this codebase (spec §6.3's one named
 * exception). NRMS's editor being staff-only is an organisational control, not a technical one —
 * a public government site shouldn't rest its XSS safety on a single staff account never being
 * compromised and never pasting raw HTML. This is the public site's render-time sanitiser,
 * defence in depth on top of (not instead of) NRMS's own write-time cleaning. It never touches
 * the News API: v1 responses are untouched, byte-identical.
 *
 * The allow-list itself is `cleanRichHtml` in @gcpe/site-settings/rich-html, shared with NRMS's
 * save-time cleaning of rich site-settings fields so the two cannot drift (plan 4 P4-R4).
 *
 * `h1` is allowed through sanitising only so `demoteHeadings` (below) has something to demote —
 * every `h1` that survives sanitising is converted to `h2` before this function returns, so no
 * caller of `sanitizeBodyHtml` ever sees one: the page's own `<h1>` stays unique (C209).
 */
export type BodyHtmlOptions = RichHtmlOptions;

export function sanitizeBodyHtml(html: string, opts: BodyHtmlOptions = {}): string {
  return demoteHeadings(cleanRichHtml(html, opts));
}
