import sanitizeHtml from "sanitize-html";

/** Spec addendum §4 body allow-list (legacy HtmlTagCleaner + the <asset> embed tag). */
export const BODY_TAGS = ["a", "p", "ul", "ol", "li", "strong", "br", "div", "asset"];

const EMPTY_PARAGRAPH = /<p>\s*(?:<strong>)?\s*(?:&nbsp;| )?\s*(?:<\/strong>)?\s*<\/p>/g;

export function sanitizeBodyHtml(html: string): string {
  const cleaned = sanitizeHtml(html, {
    allowedTags: BODY_TAGS,
    allowedAttributes: { a: ["href"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href"],
    allowProtocolRelative: false,
    transformTags: { b: "strong" },
    nonTextTags: ["script", "style", "textarea", "option", "noscript"],
    selfClosing: ["br"],
  });
  return cleaned.replace(EMPTY_PARAGRAPH, "");
}
