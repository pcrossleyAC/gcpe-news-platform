/**
 * Legacy-URL rehearsal runner: checks that each path answers 2xx, or redirects once to a 2xx page
 * (or to another host). Local/on-demand only. Usage:
 *   npm run parity:urls -- [--base https://news.gov.bc.ca] [--list tools/parity/legacy-urls.txt]
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export interface UrlResult {
  path: string;
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
  paths: string[],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<UrlResult[]> {
  const baseUrl = new URL(base);
  const get = (url: string) => fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  const results: UrlResult[] = [];
  for (const path of paths) {
    const result: UrlResult = { path, status: 0, location: null, ok: false };
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

/** fetch wrapper that spaces requests to news.gov.bc.ca at least 1 s apart. */
export function throttledFetch(minGapMs = 1000): typeof fetch {
  let last = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    if (host === "news.gov.bc.ca") {
      const wait = last + minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
    }
    return fetch(input, { ...init, headers: { "user-agent": "curl/8.7.1", ...(init?.headers ?? {}) } });
  }) as typeof fetch;
}

export function parseList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string, dflt: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
  };
  const base = opt("base", "https://news.gov.bc.ca");
  const list = opt("list", "tools/parity/legacy-urls.txt");
  const paths = parseList(await readFile(list, "utf8"));
  const results = await checkUrls(base, paths, throttledFetch());
  for (const r of results) {
    console.log(`${r.ok ? "ok  " : "FAIL"} ${r.status} ${r.path}${r.location ? ` -> ${r.location}` : ""}${r.reason ? ` (${r.reason})` : ""}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  if (failed > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e: unknown) => {
    console.error("url-check: failed to run", e);
    process.exitCode = 1;
  });
}
