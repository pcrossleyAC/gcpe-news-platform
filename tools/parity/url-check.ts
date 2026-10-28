/**
 * Legacy-URL rehearsal runner: checks that each path answers 2xx, or redirects once to a 2xx page
 * (or to another host). Local/on-demand only. Usage:
 *   npm run parity:urls -- [--base https://news.gov.bc.ca] [--list tools/parity/legacy-urls.txt]
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export interface UrlEntry {
  path: string;
  section: string;
}

export interface UrlResult {
  path: string;
  section: string;
  status: number;
  location: string | null;
  ok: boolean;
  reason?: string;
}

const isRedirect = (s: number) => s >= 300 && s < 400;
const is2xx = (s: number) => s >= 200 && s < 300;

/**
 * Checks each path in turn. A network error or a request slower than `timeoutMs` is recorded on
 * that path (status 0) and the rest of the list still runs.
 */
export async function checkUrls(
  base: string,
  entries: (UrlEntry | string)[],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<UrlResult[]> {
  const baseUrl = new URL(base);
  const get = (url: string) => fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  const results: UrlResult[] = [];
  for (const entry of entries) {
    const { path, section } = typeof entry === "string" ? { path: entry, section: "default" } : entry;
    const result: UrlResult = { path, section, status: 0, location: null, ok: false };
    try {
      await checkOne(path, result);
    } catch (e) {
      result.ok = false;
      result.reason = `fetch failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    results.push(result);
  }
  return results;

  async function checkOne(path: string, result: UrlResult): Promise<void> {
    const first = await get(new URL(path, baseUrl).href);
    const location = first.headers.get("location");
    result.status = first.status;
    result.location = location;
    if (is2xx(first.status)) {
      result.ok = true;
    } else if (isRedirect(first.status)) {
      if (!location) {
        result.reason = "redirect without Location";
      } else {
        // `new URL` percent-encodes spaces etc. and keeps the query string.
        const target = new URL(location, new URL(path, baseUrl));
        if (target.host !== baseUrl.host) {
          result.ok = true;
        } else {
          const hop = await get(target.href);
          if (is2xx(hop.status)) result.ok = true;
          else if (isRedirect(hop.status)) result.reason = "redirect chain";
          else result.reason = `redirect target answered ${hop.status}`;
        }
      }
    } else {
      result.reason = `status ${first.status}`;
    }
  }
}

/**
 * fetch wrapper that spaces requests to news.gov.bc.ca at least `minGapMs` apart, and requests to any
 * other host at least `otherHostGapMs` apart.
 */
export function throttledFetch(minGapMs = 1000, otherHostGapMs = 200): typeof fetch {
  let lastLegacy = 0;
  let lastOther = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    const legacy = host === "news.gov.bc.ca";
    const gap = legacy ? minGapMs : otherHostGapMs;
    const wait = (legacy ? lastLegacy : lastOther) + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (legacy) lastLegacy = Date.now();
    else lastOther = Date.now();
    return fetch(input, { ...init, headers: { "user-agent": "curl/8.7.1", ...(init?.headers ?? {}) } });
  }) as typeof fetch;
}

/** `# section: <name>` lines set the section of the paths after them; the default is "default". */
export function parseList(text: string): UrlEntry[] {
  const entries: UrlEntry[] = [];
  let section = "default";
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (l === "") continue;
    if (l.startsWith("#")) {
      const m = /^#\s*section:\s*(.+)$/.exec(l);
      if (m) section = m[1]!.trim();
      continue;
    }
    entries.push({ path: l, section });
  }
  return entries;
}

/** Per-section pass counts (in first-seen order), then the overall count. */
export function formatSummary(results: UrlResult[]): string[] {
  const bySection = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    const c = bySection.get(r.section) ?? { pass: 0, total: 0 };
    c.total++;
    if (r.ok) c.pass++;
    bySection.set(r.section, c);
  }
  const lines = [...bySection].map(([name, c]) => `${name}: ${c.pass}/${c.total} passed`);
  const pass = results.filter((r) => r.ok).length;
  return [...lines, `${pass}/${results.length} passed`];
}

export interface MainDeps {
  readList: (path: string) => Promise<string>;
  fetchImpl: typeof fetch;
  log: (line: string) => void;
}

/** Runs the check and returns the process exit code (1 when any URL fails). */
export async function main(
  args: string[],
  deps: MainDeps = { readList: (p) => readFile(p, "utf8"), fetchImpl: throttledFetch(), log: console.log },
): Promise<number> {
  const opt = (name: string, dflt: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
  };
  const base = opt("base", "https://news.gov.bc.ca");
  const list = opt("list", "tools/parity/legacy-urls.txt");
  const entries = parseList(await deps.readList(list));
  const results = await checkUrls(base, entries, deps.fetchImpl);
  for (const r of results) {
    deps.log(`${r.ok ? "ok  " : "FAIL"} ${r.status} ${r.path}${r.location ? ` -> ${r.location}` : ""}${r.reason ? ` (${r.reason})` : ""}`);
  }
  for (const line of formatSummary(results)) deps.log(line);
  return results.some((r) => !r.ok) ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      console.error("url-check: failed to run", e);
      process.exitCode = 1;
    });
}
