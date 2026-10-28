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
  { name: "contacts", path: "/contacts" },
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
    out[name] = path;
  }
  return out;
}
