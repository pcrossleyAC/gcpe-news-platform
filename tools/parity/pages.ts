export interface ParityPage {
  name: string;
  path: string;
  /** Path on our site when it differs from the legacy path. */
  oursPath?: string;
}

export const PARITY_PAGES: ParityPage[] = [
  { name: "home", path: "/" },
  { name: "ministry", path: "/ministries/health" },
  { name: "biography", path: "/ministries/citizens-services/biography", oursPath: "/ministries/citizens-services/biography/" },
  { name: "premier", path: "/office-of-the-premier", oursPath: "/ministries/office-of-the-premier/" },
  { name: "sector", path: "/sectors/economy" },
  { name: "release", path: "/releases/2026HLTH0085-001117" },
  { name: "search", path: "/search?q=housing" },
  { name: "subscribe", path: "/subscribe" },
  { name: "connect", path: "/connect" },
  { name: "contacts", path: "/contacts", oursPath: "/contacts/" },
  { name: "live", path: "/live", oursPath: "/live/" },
  { name: "privacy", path: "/privacy", oursPath: "/privacy/" },
  { name: "factsheets", path: "/factsheets", oursPath: "/factsheets/" },
  { name: "stories", path: "/stories", oursPath: "/stories/" },
  { name: "ministry-factsheets", path: "/ministries/health/factsheets", oursPath: "/ministries/health/factsheets/" },
  { name: "ministries", path: "/ministries", oursPath: "/ministries/" },
  { name: "sectors", path: "/sectors", oursPath: "/sectors/" },
  { name: "themes", path: "/themes", oursPath: "/themes/" },
  { name: "topics", path: "/news-subscribe", oursPath: "/tags/" },
  // Legacy has no archive page; paired with /stories for chrome and listing look (spec conflict 1).
  { name: "archive", path: "/stories", oursPath: "/archive/2026/10/" },
];

/** Page names added by plan 4; their ours paths are directory-style (trailing slash). */
export const PLAN4_PAGE_NAMES = [
  "contacts", "live", "privacy", "factsheets", "stories", "ministry-factsheets",
  "ministries", "sectors", "themes", "topics", "archive",
];

export const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
];

/** Parses `--ours name=path[,name=path]`; throws on a malformed entry or an unknown page name. */
export function parseOursOverrides(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of spec.split(",").map((e) => e.trim()).filter(Boolean)) {
    const i = entry.indexOf("=");
    const name = i > 0 ? entry.slice(0, i) : "";
    const path = i > 0 ? entry.slice(i + 1) : "";
    if (!name || !path) throw new Error(`--ours: expected name=path, got "${entry}"`);
    if (!PARITY_PAGES.some((p) => p.name === name)) throw new Error(`--ours: unknown page "${name}"`);
    if (!/^\/(?!\/)/.test(path) || /\.\.|[@\\:]|[\u0000-\u001f\u007f\s]/.test(path)) {
      throw new Error(`--ours: invalid path "${path}" for ${name} (must start with a single "/", no "..", "@", "\\", ":" or whitespace)`);
    }
    out[name] = path;
  }
  return out;
}

/**
 * Joins a site path onto the target keeping the target's own path prefix (e.g. https://boxs.ca/site),
 * and asserts the result stays on the target's origin and under that prefix.
 */
export function buildOursUrl(target: string, path: string): string {
  const base = new URL(target.replace(/\/+$/, "") + "/");
  const url = new URL(path.replace(/^\/+/, ""), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    throw new Error(`ours URL ${url.href} escapes target ${base.href}`);
  }
  return url.href;
}
