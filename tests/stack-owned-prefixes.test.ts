import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SUBSCRIBE_PAGES } from "../apps/public-site/src/subscribe-pages";
import * as env from "../apps/stack/src/env";
import { SITE_PASS_THROUGH, STACK_OWNED_PREFIXES } from "../apps/stack/src/stack";
import { buildFixtureSite } from "../scripts/fixture-site";

// News API is mounted at the stack root (app.use(newsApi.app)), so its own top-level routes are
// owned prefixes too: healthRoutes (/health/live, /health/ready), the event receiver (POST /events),
// the updates hub (/updates), /api/v2 and /api. Its routers are nested, so they're listed by hand.
const NEWS_API_ROOTS = ["/api", "/health", "/events", "/updates"];

const top = (path: string) => `/${path.replace(/^\/+/, "").split("/")[0]}`.toLowerCase();

/** The first segment of every path-mounted `app.use(...)` in stack.ts (root middleware has none). */
async function stackMountPrefixes(): Promise<Set<string>> {
  const src = await readFile(join(__dirname, "../apps/stack/src/stack.ts"), "utf8");
  const consts = env as unknown as Record<string, unknown>;
  const found = new Set<string>();
  for (const m of src.matchAll(/app\.use\(\s*(\[[^\]]*\]|"[^"]*"|`[^`]*`|[A-Za-z_$][\w$]*)/g)) {
    const arg = m[1]!;
    const paths: string[] = [];
    if (arg.startsWith("[")) paths.push(...[...arg.matchAll(/"([^"]+)"/g)].map((x) => x[1]!));
    else if (arg.startsWith('"')) paths.push(arg.slice(1, -1));
    else if (arg.startsWith("`")) {
      const name = /^`\$\{(\w+)\}/.exec(arg)?.[1];
      paths.push(name && typeof consts[name] === "string" ? (consts[name] as string) : arg.slice(1, -1));
    } else if (/^FAKE_\w+_PATH$/.test(arg)) {
      paths.push(consts[arg] as string);
    } else continue; // app.use(noStoreByDefault), app.use(root), app.use(newsApi.app), …
    for (const p of paths) found.add(top(p));
  }
  return found;
}

describe("STACK_OWNED_PREFIXES", () => {
  it("is exactly the stack's own path mounts plus News API's root routes", async () => {
    const mounts = await stackMountPrefixes();
    expect(mounts.size).toBeGreaterThan(5); // the scan found the mounts at all
    const owned = new Set(STACK_OWNED_PREFIXES.map(top));
    // A new top-level mount left off the list would answer its unknown GETs with the site's 404.html.
    expect([...mounts].filter((p) => !owned.has(p)), "mounted in stack.ts but not owned").toEqual([]);
    // A stale entry would hide a site page of that name behind an app's 404.
    const expected = new Set([...mounts, ...NEWS_API_ROOTS]);
    expect([...owned].filter((p) => !expected.has(p)), "owned but mounted nowhere").toEqual([]);
  });

  it("never collides with a top-level name in the public site's output (served at the root ahead of every app)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owned-prefixes-"));
    try {
      await buildFixtureSite(dir, { baseUrl: "http://127.0.0.1:1", test: false });
      const names = new Set((await readdir(dir)).filter((n) => !n.startsWith(".")).map((n) => `/${n.toLowerCase()}`));
      for (const p of SUBSCRIBE_PAGES) names.add(top(p.path));
      expect(names).toContain("/releases"); // sanity: the build wrote pages
      expect(names).toContain("/subscribe");
      // "/updates" is owned by News API's hub (POST /updates/negotiate) yet is also the site's Updates
      // listing (H5, ruling P3-R4): SITE_PASS_THROUGH leaves it out, so a GET/HEAD there is the site's page
      // (apps/stack's legacy-urls.test.ts pins that the POST still reaches News API).
      expect(names).toContain("/updates");
      const owned = SITE_PASS_THROUGH.map(top);
      expect([...names].filter((n) => owned.includes(n))).toEqual([]);
      expect(STACK_OWNED_PREFIXES.map(top).filter((n) => names.has(n))).toEqual(["/updates"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
