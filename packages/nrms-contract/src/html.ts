/**
 * The release body's shared HTML allow-list (spec addendum §4: legacy HtmlTagCleaner plus the
 * `<asset>` embed tag). Zod-only package (browser-safe): both the server's sanitizer
 * (apps/nrms/src/text/sanitize.ts, Node-only via sanitize-html) and the staff web app's
 * client-side paste handling (Task 4) build their allow-lists from these same three constants,
 * so pasted-then-saved HTML can never diverge from what the server actually keeps.
 */
export const BODY_TAGS = ["a", "p", "ul", "ol", "li", "strong", "br", "div", "asset"] as const;
export const BODY_ATTRIBUTES = { a: ["href"] } as const;
export const BODY_SCHEMES = ["http", "https", "mailto"] as const;
