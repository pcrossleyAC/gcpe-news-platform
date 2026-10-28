import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * CI builds the app images but never runs them, so an image missing the tenant file only fails on
 * a real deploy (Task 15 re-review N1: Core's start-up loads TENANT_CONFIG and its image had no
 * config/). A cheap text check instead: every app whose start-up reads TENANT_CONFIG ships config/
 * in its image and points TENANT_CONFIG at it.
 */
const appsDir = fileURLToPath(new URL("../../", import.meta.url));

const apps = readdirSync(appsDir).filter((app) => {
  const start = `${appsDir}${app}/src/start.ts`;
  return existsSync(`${appsDir}${app}/Dockerfile`) && existsSync(start) && readFileSync(start, "utf8").includes("TENANT_CONFIG");
});

describe("app images ship the tenant config", () => {
  it("covers Core", () => {
    expect(apps).toContain("core");
  });

  it.each(apps)("%s's Dockerfile copies config/ and sets TENANT_CONFIG", (app) => {
    const dockerfile = readFileSync(`${appsDir}${app}/Dockerfile`, "utf8");
    expect(dockerfile).toMatch(/^COPY config \.\/config$/m);
    expect(dockerfile).toMatch(/^COPY --from=build \/repo\/config \.\/config$/m);
    expect(dockerfile).toMatch(/TENANT_CONFIG=\/app\/config\/tenants\/bc\.json/);
  });
});
