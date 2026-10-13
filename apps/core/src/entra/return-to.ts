const FALLBACK = "/hub/";
const MAX_LENGTH = 512;
const PROBE_ORIGIN = "https://return-to.invalid";

/**
 * Where to send the browser after Entra sign-in: a same-origin path under /hub/, by the same
 * rules as staff-web's safeReturnTo (a leading single slash, no backslash), and also no control
 * characters, at most 512 characters, and still under /hub/ once dot segments are resolved.
 * Anything else is /hub/.
 */
export function safeHubReturnTo(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) return FALLBACK;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return FALLBACK;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return FALLBACK;
  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return FALLBACK;
  }
  if (url.origin !== PROBE_ORIGIN) return FALLBACK;
  if (url.pathname !== "/hub" && !url.pathname.startsWith("/hub/")) return FALLBACK;
  return `${url.pathname === "/hub" ? FALLBACK : url.pathname}${url.search}${url.hash}`;
}
