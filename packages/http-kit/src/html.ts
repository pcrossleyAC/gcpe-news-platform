/**
 * Escapes text for safe inclusion in HTML element content and quoted attribute values:
 * `&`, `<`, `>`, `"` and `'`. The one implementation shared by every app that writes HTML
 * (public-site pages, NoD's As-It-Happens email, Distribution's html-mode substitutions).
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
