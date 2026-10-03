import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface LiveFixture {
  name: string;
  path: string;
  status: number;
  contentType: string | null;
  body: unknown;
}

export const DEFAULT_FIXTURE_DIR = new URL("../../test/fixtures/live/", import.meta.url).pathname;

export function loadLiveFixtures(dir: string = DEFAULT_FIXTURE_DIR): Record<string, LiveFixture> {
  const out: Record<string, LiveFixture> = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const fx = JSON.parse(readFileSync(join(dir, file), "utf8")) as LiveFixture;
    out[fx.name] = fx;
  }
  return out;
}
