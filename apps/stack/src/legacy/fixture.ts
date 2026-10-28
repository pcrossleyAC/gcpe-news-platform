import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The pages (directories holding index.html) every legacy-URL test can rely on. */
export const LEGACY_FIXTURE_PAGES = [
  "releases/2026TT0105-001130/",
  "archive/",
  "archive/2026/10/",
  "search/",
  "subscribe/",
  "subscribe/manage/",
  "connect/",
  "ministries/health/",
  "sectors/services/",
  "tags/speeches/",
] as const;

/**
 * Test helper: a throwaway OUTPUT_DIR shaped like the public site's (parity plan 3). The caller
 * removes it. Later tasks add to it.
 */
export async function createLegacySiteFixture(): Promise<string> {
  const outputDir = await mkdtemp(join(tmpdir(), "gcpe-legacy-urls-"));
  const put = async (rel: string, body: string) => {
    const file = join(outputDir, ...rel.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  };
  await put("index.html", "<h1>home</h1>");
  await put("404.html", "<h1>site 404</h1>");
  await put("feed.xml", '<?xml version="1.0"?><rss version="2.0"><channel/></rss>');
  for (const page of LEGACY_FIXTURE_PAGES) await put(`${page}index.html`, `<h1>${page}</h1>`);
  await put("assets/legacy/Content/Images/Gov/default-og-image-new.jpg", "JPEGDATA");
  // Our own mixed-case asset names (Review Focus 2): served as they are, never lowercased.
  await put("assets/legacy/Content/Images/Gov/BC_Mark.svg", "<svg/>");
  await put(".site-state.json", '{"granvilleOn":true}');
  return outputDir;
}
