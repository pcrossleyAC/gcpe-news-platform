import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tsxBin = fileURLToPath(new URL("../../../../node_modules/.bin/tsx", import.meta.url));
const cliFile = fileURLToPath(new URL("./rebuild-all.ts", import.meta.url));

describe("site:rebuild-all CLI", () => {
  it("logs a safe label and exits 1 on a bad environment, instead of an uncaught stack trace", () => {
    // DATABASE_URL (and friends) stripped so parseEnv fails before anything else runs — this is
    // the part that used to run outside the try block.
    const { DATABASE_URL: _db, NEWS_API_URL: _api, OUTPUT_DIR: _out, PUBLIC_SITE_URL: _site, ...envWithoutRequired } = process.env;
    const result = spawnSync(tsxBin, [cliFile], { encoding: "utf8", env: envWithoutRequired });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[public-site] site:rebuild-all failed");
    // Never the raw parseEnv message (which would name every missing var) or a stack trace.
    expect(result.stderr).not.toContain("Invalid environment");
    expect(result.stderr).not.toContain(" at ");
  });
});
