/**
 * Builds the generated legacy-URL snapshot from live news.gov.bc.ca: at most 4 GETs (here 3),
 * spaced 1 s apart by throttledFetch. HTML is only scanned with a regex for href="..."; it is never
 * executed. Usage:
 *   npm run parity:urls:list -- --posts 150 > tools/parity/legacy-urls.generated.txt
 */
import { pathToFileURL } from "node:url";
import { throttledFetch } from "./url-check";

const ORIGIN = "https://news.gov.bc.ca";
const HOST = "news.gov.bc.ca";
const ASSET = /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot)(?:\?|$)/i;

/** Path (+ query) of every same-host href in `html`, in document order; other hosts and non-http schemes are dropped. */
export function extractPaths(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href\s*=\s*"([^"]*)"/gi)) {
    const raw = m[1]!.replace(/&amp;/g, "&").trim();
    if (raw === "" || raw.startsWith("#")) continue;
    let url: URL;
    try {
      url = new URL(raw, ORIGIN);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    if (url.host !== HOST) continue;
    out.push(url.pathname + url.search);
  }
  return out;
}

export async function buildLegacyUrlList(
  fetchText: (path: string) => Promise<string>,
  opts: { posts: number },
): Promise<string[]> {
  const seen = new Set<string>();
  const section = (name: string, paths: string[]): string[] => {
    const fresh: string[] = [];
    for (const p of paths) {
      if (seen.has(p)) continue;
      seen.add(p);
      fresh.push(p);
    }
    return [`# section: ${name}`, ...fresh];
  };

  const home = extractPaths(await fetchText("/"));
  const nav = home.filter((p) => p !== "/" && !ASSET.test(p));
  const feeds = extractPaths(await fetchText("/connect")).filter((p) => /\/feed(?:\/|\?|$)/.test(p));
  const sitemap = extractPaths(await fetchText(`/sitemap/html?count=${opts.posts}`));
  const posts = sitemap.filter((p) => /^\/releases\/[^/?]+$/.test(p));
  const variants = [...new Set(posts)].slice(0, 10).flatMap((p) => {
    const key = p.slice("/releases/".length);
    return [`/stories/${key}`, `/releases/${key.toLowerCase()}`];
  });

  return [
    ...section("nav", ["/", ...nav]),
    ...section("feeds", feeds),
    ...section("posts", posts),
    ...section("post-variants", variants),
  ];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf("--posts");
  const posts = i >= 0 ? Number(args[i + 1]) : 150;
  if (!Number.isInteger(posts) || posts < 1) throw new Error("--posts must be a positive integer");
  const f = throttledFetch();
  const fetchText = async (path: string) => {
    const res = await f(`${ORIGIN}${path}`);
    if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
    return res.text();
  };
  const lines = await buildLegacyUrlList(fetchText, { posts });
  const date = new Date().toISOString().slice(0, 10);
  console.log(`# Generated ${date} from live news.gov.bc.ca by tools/parity/legacy-url-list.ts (do not edit by hand).`);
  console.log(`# Sources: GET / (nav, ministries, sectors, tags), GET /connect (feeds), GET /sitemap/html?count=${posts} (latest posts).`);
  console.log(lines.join("\n"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e: unknown) => {
    console.error("legacy-url-list: failed to run", e);
    process.exitCode = 1;
  });
}
