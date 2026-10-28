import sanitizeHtml from "sanitize-html";
import { isSafeUrl } from "@gcpe/http-kit";
import { BIO_TAGS, BODY_SCHEMES } from "@gcpe/nrms-contract";

/** The longest biography Core stores, measured after sanitising. */
export const MAX_BIO_CHARS = 20_000;

/** Same pattern as apps/nrms/src/text/sanitize.ts: `<p></p>`, `<p> </p>`, `<p>&nbsp;</p>`, `<p><strong></strong></p>`. */
const EMPTY_PARAGRAPH = /<p>\s*(?:<strong>)?\s*(?:&nbsp;| )?\s*(?:<\/strong>)?\s*<\/p>/g;

/**
 * The minister biography (plan 2, T1) as Core stores it: the release body's allow-list without
 * `<asset>`. Every tag kept here is also kept by the public site's sanitizeBodyHtml
 * (apps/public-site/src/sanitize-body.ts), and hrefs pass the same isSafeUrl check it applies, so
 * what staff save is what the public sees. Text inside a dropped tag (h1, span…) is kept; the
 * content of script/style/iframe/object… is removed with the tag.
 */
export function sanitizeBioHtml(html: string): string {
  const cleaned = sanitizeHtml(html, {
    allowedTags: [...BIO_TAGS],
    allowedAttributes: { a: ["href"] },
    allowedSchemes: [...BODY_SCHEMES],
    allowedSchemesAppliedToAttributes: ["href"],
    allowProtocolRelative: false,
    transformTags: {
      b: "strong",
      a: (tagName, attribs) => {
        const next = { ...attribs };
        if (next.href !== undefined && !isSafeUrl(next.href, { mailto: true })) delete next.href;
        return { tagName, attribs: next };
      },
    },
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "iframe", "object", "embed"],
    selfClosing: ["br"],
  });
  return cleaned.replace(EMPTY_PARAGRAPH, "").trim();
}

/** True when the HTML carries no text once its tags are stripped. */
export function isBlankHtml(html: string): boolean {
  return /^\s*$/.test(html.replace(/<[^>]*>/g, ""));
}
