/**
 * One-off live check of the ministry rename table (parity plan 3, Task 5, P16): sends
 * HEAD https://news.gov.bc.ca/ministries/<key> for every one-segment key at 1 request per
 * second and prints `key  status  location`, next to the closed value the table gives. Run once:
 *   npx tsx tools/parity/ministry-renames-live.ts
 * Where live redirects somewhere the table does not, live wins.
 */
import { pathToFileURL } from "node:url";
import renames from "../../apps/stack/src/legacy/ministry-renames.json";
import { loadRenames } from "../../apps/stack/src/legacy/ministry-renames";
import { throttledFetch } from "./url-check";

async function main(): Promise<void> {
  const closed = loadRenames(renames).ministries;
  const keys = Object.keys(renames.ministries).filter((k) => !k.includes("/"));
  const get = throttledFetch();
  console.log(`key  status  location  (table: closed value)`);
  for (const key of keys) {
    try {
      const res = await get(`https://news.gov.bc.ca/ministries/${key}`, { method: "HEAD", redirect: "manual" });
      console.log(`${key}  ${res.status}  ${res.headers.get("location") ?? "-"}  (table: ${closed.get(key)})`);
    } catch (e) {
      console.log(`${key}  error  ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e: unknown) => {
    console.error("ministry-renames-live: failed", e);
    process.exitCode = 1;
  });
}
