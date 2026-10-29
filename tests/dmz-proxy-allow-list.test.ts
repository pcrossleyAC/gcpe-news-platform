import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SUBSCRIBE_PAGES } from "../apps/public-site/src/subscribe-pages";
import { STACK_OWNED_PREFIXES } from "../apps/stack/src/stack";

// The DMZ proxy (deploy/windows/Install-GcpeProxy.ps1) forwards GET/HEAD of everything outside the
// stack's own prefixes to the public site, so every prefix the stack answers itself must be
// classified there: blocked (404 at the proxy), the public API, or public GET/HEAD. A new mount
// (tests/stack-owned-prefixes.test.ts keeps STACK_OWNED_PREFIXES complete) fails here until it is.

async function psList(name: string): Promise<string[]> {
  const src = await readFile(join(__dirname, "../deploy/windows/Install-GcpeProxy.ps1"), "utf8");
  const m = new RegExp(`^\\$${name} = @\\(([^)]*)\\)`, "m").exec(src);
  if (!m) throw new Error(`$${name} not found in Install-GcpeProxy.ps1`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

const top = (p: string) => p.replace(/^\/+/, "").split("/")[0]!.toLowerCase();

describe("Install-GcpeProxy.ps1 allow-list", () => {
  it("classifies every stack-owned prefix exactly once", async () => {
    const blocked = (await psList("BlockedPaths")).filter((p) => !p.includes("/"));
    const api = await psList("ApiPaths");
    const getOnly = await psList("GetOnlyOwnedPaths");
    const classified = [...blocked, ...api, ...getOnly];
    expect(new Set(classified).size, "a prefix in two lists").toBe(classified.length);
    const owned = STACK_OWNED_PREFIXES.map(top);
    expect(owned.filter((p) => !classified.includes(p)), "stack-owned but not classified for the DMZ").toEqual([]);
    expect(classified.filter((p) => !owned.includes(p)), "classified but not stack-owned (stale)").toEqual([]);
  });

  it("keeps the staff mounts, the stack's own routes and the internal API routes blocked", async () => {
    const blocked = await psList("BlockedPaths");
    for (const p of ["hub", "core", "nrms", "nod", "calendar", "distribution", "site-builder", "stack", "events", "health", "api/v2/changes", "api/v2/internal"]) {
      expect(blocked).toContain(p);
    }
    expect(await psList("ApiPaths")).toEqual(["api"]);
    expect(await psList("GetOnlyOwnedPaths")).toEqual(["files", "updates"]);
  });

  it("never caches the subscribe pages", async () => {
    const never = await psList("NeverCachedPaths");
    for (const page of SUBSCRIBE_PAGES) expect(never).toContain(top(page.path));
  });
});
