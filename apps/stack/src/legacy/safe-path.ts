/**
 * The one place a legacy URL's request target is taken apart (parity plan 3, Task 1). Anything
 * that could make a Location leave the site or a file path leave OUTPUT_DIR is rejected here
 * (null), and the caller falls through to the static mount and the site 404.
 */

export interface RequestTarget {
  /** The path as sent, still percent-encoded. Always starts with "/". */
  rawPath: string;
  /** The path decoded segment by segment. Always starts with "/", never "//". */
  path: string;
  /** "" or "?…", byte for byte as sent: never decoded, re-encoded or lowercased. */
  query: string;
}

/** Scheme and authority of an absolute-form request line ("GET http://h/x HTTP/1.1"). */
const ABSOLUTE_FORM = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;
/** NUL, other C0 controls and DEL. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * `rawUrl` is `req.url` (or the remainder of it under a mount). Null when the path:
 * - has malformed percent-encoding;
 * - contains NUL, another control character or `\` (raw or encoded);
 * - has an encoded `/` inside a segment (it would move a segment boundary);
 * - has a `.` or `..` segment (raw or encoded);
 * - starts with `//` (raw or after decoding), or does not start with `/`.
 */
export function parseRequestTarget(rawUrl: string): RequestTarget | null {
  const target = rawUrl.replace(ABSOLUTE_FORM, "");
  const q = target.indexOf("?");
  let rawPath = q === -1 ? target : target.slice(0, q);
  const query = q === -1 ? "" : target.slice(q);
  if (rawPath === "" && target !== rawUrl) rawPath = "/"; // "http://h" and "http://h?x"
  if (!rawPath.startsWith("/") || rawPath.startsWith("//") || rawPath.includes("\\")) return null;
  const segments = rawPath.slice(1).split("/");
  const decoded: string[] = [];
  for (const raw of segments) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg === "." || seg === ".." || seg.includes("/") || seg.includes("\\") || CONTROL.test(seg)) return null;
    decoded.push(seg);
  }
  const path = `/${decoded.join("/")}`;
  if (path.startsWith("//")) return null;
  return { rawPath, path, query };
}
