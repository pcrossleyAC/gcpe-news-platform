/** An absolute https URL with a host, or a path on this site. Rejects http:, javascript:, data:,
 * `//host`, `/\host`, empty strings and any whitespace or control character anywhere in the
 * URL (browsers strip tab/newline, so "/\t/host" would resolve off-site). */
export function isSafeUrl(url: string): boolean {
  // Browsers strip tab/newline anywhere in a URL, so "/\t/host" would resolve off-site: refuse any
  // whitespace or control character, not just surrounding whitespace.
  if (url === "" || /[\s\u0000-\u001F\u007F]/.test(url)) return false;
  if (url.startsWith("/")) return !url.startsWith("//") && !url.startsWith("/\\");
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.length > 0;
  } catch {
    return false;
  }
}
