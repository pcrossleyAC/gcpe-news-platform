import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const APPS = ["core", "nrms", "news-api", "nod", "distribution", "calendar", "public-site"];

describe("every mounted app honours TRUST_PROXY_HOPS", () => {
  it.each(APPS)("%s: createApp takes trustProxyHops and start passes it from env, no hardcoded hop count", (app) => {
    const appSrc = read(`../../${app}/src/app.ts`);
    expect(appSrc.match(/trust[ -]proxy/gi)).toHaveLength(1);
    expect(appSrc).toMatch(/set\(\s*["'`]trust proxy["'`]\s*,\s*deps\.trustProxyHops \?\? 1\s*\)/);
    expect(read(`../../${app}/src/start.ts`)).toMatch(/trustProxyHops:\s*trustProxyHopsFrom\(env\)/);
  });
  it("the stack's own app uses the parsed setting", () => {
    const src = read("./stack.ts");
    expect(src.match(/trust[ -]proxy/gi)).toHaveLength(1);
    expect(src).toMatch(/set\(\s*["'`]trust proxy["'`]\s*,\s*stackEnv\.TRUST_PROXY_HOPS\s*\)/);
  });
});
