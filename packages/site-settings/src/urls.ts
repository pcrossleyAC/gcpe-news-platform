/** An absolute https URL with a host, or a path on this site. Rejects http:, javascript:, data:,
 * `//host`, `/\host`, surrounding whitespace and empty strings. */
export function isSafeUrl(url: string): boolean {
  if (url === "" || url !== url.trim()) return false;
  if (url.startsWith("/")) return !url.startsWith("//") && !url.startsWith("/\\");
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.length > 0;
  } catch {
    return false;
  }
}
