/**
 * Coverage check before cutover (new-government spec §1): reads the release keys from the legacy
 * archive's index_<collection>.htm files and reports any key the News API lacks. Evidence that
 * "the platform's archive is the archive" is true.
 *
 *   npx tsx scripts/archive-coverage-check.ts --news-api <url> <index.htm path or URL>...
 *
 * Prints `checked N, missing M`, lists the missing keys, and exits 1 if M > 0 (2 on a fetch
 * failure, a timeout of 30 seconds, or an index that lists no keys: a page that could not be read is never counted as "nothing missing"). Every fetch
 * runs at most once a second.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const KEY_HREF = /href\s*=\s*["'][^"']*\/releases\/news_releases_[^/"']+\/([^/"']+)\.htm["']/gi;

/** Release keys linked from a legacy index page, de-duplicated, in order of first appearance. */
export function extractKeys(html: string): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const m of html.matchAll(KEY_HREF)) {
    const key = decodeURIComponent(m[1]!);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/** Keys the News API does not return. `fetchPosts` returns the posts it has for a batch; the match ignores case. */
export async function missingKeys(keys: string[], fetchPosts: (keys: string[]) => Promise<{ key: string }[]>, batch = 100): Promise<string[]> {
  const missing: string[] = [];
  for (let i = 0; i < keys.length; i += batch) {
    const chunk = keys.slice(i, i + batch);
    const found = new Set((await fetchPosts(chunk)).map((p) => p.key.toLowerCase()));
    for (const k of chunk) if (!found.has(k.toLowerCase())) missing.push(k);
  }
  return missing;
}

function throttled(minGapMs: number): () => Promise<void> {
  let last = 0;
  return async () => {
    const wait = last + minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  };
}

const FETCH_TIMEOUT_MS = 30_000;
const UA = "gcpe-archive-coverage-check/1.0";

export async function runCli(argv: string[], log: (line: string) => void = console.log): Promise<number> {
  const args = argv.slice();
  let newsApi: string | undefined;
  const sources: string[] = [];
  while (args.length) {
    const a = args.shift()!;
    if (a === "--news-api") newsApi = args.shift();
    else sources.push(a);
  }
  if (!newsApi || sources.length === 0) {
    log("usage: archive-coverage-check.ts --news-api <url> <index.htm path or URL>...");
    return 2;
  }
  const base = newsApi.replace(/\/+$/, "");
  const wait = throttled(1000);
  const get = async (url: string): Promise<Response> => {
    await wait();
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res;
  };
  try {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const src of sources) {
      const html = /^https?:\/\//i.test(src) ? await (await get(src)).text() : await readFile(src, "utf8");
      const found = extractKeys(html);
      if (found.length === 0) throw new Error(`${src} lists no release keys (wrong file, an error page, or a changed link format?)`);
      for (const k of found) if (!seen.has(k.toLowerCase())) (seen.add(k.toLowerCase()), keys.push(k));
    }
    if (keys.length === 0) throw new Error("no release keys found in any source");
    const missing = await missingKeys(keys, async (batch) => {
      const url = `${base}/api/Posts?api-version=1.0&postKeys=${batch.map(encodeURIComponent).join(",")}`;
      return (await (await get(url)).json()) as { key: string }[];
    });
    log(`checked ${keys.length}, missing ${missing.length}`);
    for (const k of missing) log(k);
    return missing.length > 0 ? 1 : 0;
  } catch (e) {
    log(`could not finish: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
