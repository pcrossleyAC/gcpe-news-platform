import { stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Whether a decoded URL path names something the static mount would serve as a page, and its
 * canonical URL path if so (parity plan 3: "one hop" and "a page on disk wins over a fallback
 * rule"):
 * - a file → `urlPath` itself (null when it ends in "/": static would not serve that);
 * - a directory holding `index.html` → the path with exactly one trailing slash;
 * - anything else → null.
 *
 * Never stats anything outside `outputDir` or under a dot-segment: a segment that starts with
 * "." (".", "..", ".site-state.json" — express.static denies dotfiles anyway), or contains "\",
 * ":" (a Windows drive or stream name) or NUL, makes the answer null before any filesystem call.
 * Any stat error (missing, ENOTDIR, a file Windows has locked mid-replace) is also null: the
 * caller then falls through or picks the next candidate.
 */
export async function pagePath(outputDir: string, urlPath: string): Promise<string | null> {
  if (!urlPath.startsWith("/")) return null;
  const trailing = urlPath.endsWith("/");
  const segments = urlPath.split("/").filter((s) => s !== "");
  if (segments.some((s) => s.startsWith(".") || s.includes("\\") || s.includes(":") || s.includes("\0"))) return null;
  const fsPath = join(outputDir, ...segments);
  try {
    const s = await stat(fsPath);
    if (s.isFile()) return trailing ? null : urlPath;
    if (!s.isDirectory()) return null;
    if (!(await stat(join(fsPath, "index.html"))).isFile()) return null;
    return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
  } catch {
    return null;
  }
}
