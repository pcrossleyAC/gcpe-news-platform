import sanitizeHtml from "sanitize-html";
import { BODY_ATTRIBUTES, BODY_SCHEMES, BODY_TAGS } from "@gcpe/nrms-contract";

/** Spec addendum §4 body allow-list (legacy HtmlTagCleaner + the <asset> embed tag) — now the
 * shared, zod-only @gcpe/nrms-contract list (Task 1, staff-web), re-exported here so existing
 * importers of BODY_TAGS from this module keep working unchanged. */
export { BODY_TAGS };

const EMPTY_PARAGRAPH = /<p>\s*(?:<strong>)?\s*(?:&nbsp;| )?\s*(?:<\/strong>)?\s*<\/p>/g;

export function sanitizeBodyHtml(html: string): string {
  const cleaned = sanitizeHtml(html, {
    allowedTags: [...BODY_TAGS],
    allowedAttributes: { a: [...BODY_ATTRIBUTES.a] },
    allowedSchemes: [...BODY_SCHEMES],
    allowedSchemesAppliedToAttributes: ["href"],
    allowProtocolRelative: false,
    transformTags: { b: "strong" },
    nonTextTags: ["script", "style", "textarea", "option", "noscript"],
    selfClosing: ["br"],
  });
  return cleaned.replace(EMPTY_PARAGRAPH, "");
}
