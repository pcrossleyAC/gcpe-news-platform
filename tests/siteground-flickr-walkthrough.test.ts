import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("scripts/siteground-flickr-walkthrough.sh", () => {
  it("is valid bash", () => {
    execFileSync("bash", ["-n", "scripts/siteground-flickr-walkthrough.sh"]);
  });

  it("sends the CSRF header, keeps the cookie jar private, and never echoes the password", () => {
    const s = readFileSync("scripts/siteground-flickr-walkthrough.sh", "utf8");
    expect(s).toContain("x-gcpe-request: 1");
    expect(s).toMatch(/umask 077/);
    expect(s).toMatch(/trap .*rm -f/);
    expect(s).not.toMatch(/echo .*PASS/);
  });

  it("never passes the password to another process as a command-line argument, and sets the cleanup trap before mktemp creates the file", () => {
    const s = readFileSync("scripts/siteground-flickr-walkthrough.sh", "utf8");
    const lines = s.split("\n");
    for (const line of lines) {
      expect(line).not.toMatch(/python3[^|]*"\$(ADMIN_PASS|pass)"/);
      expect(line).not.toMatch(/\bjson\b[^|]*"\$(ADMIN_PASS|pass)"/);
    }
    const trapLine = lines.findIndex((l) => /trap .*rm -f/.test(l));
    const mktempLine = lines.findIndex((l) => /JAR="\$\(mktemp\)"/.test(l));
    expect(trapLine).toBeGreaterThanOrEqual(0);
    expect(mktempLine).toBeGreaterThanOrEqual(0);
    expect(trapLine).toBeLessThan(mktempLine);
  });

  it("unsets the password variable right after it's used, and the outage switch and asset use the fake's real photo id shape", () => {
    const s = readFileSync("scripts/siteground-flickr-walkthrough.sh", "utf8");
    expect(s).toMatch(/unset ADMIN_PASS/);
    expect(s).toContain("__fake/state");
    expect(s).toContain("refuseAuth");
    expect(s).toContain("53000000001");
  });

  it("exits non-zero when the expected end state is never reached", () => {
    const s = readFileSync("scripts/siteground-flickr-walkthrough.sh", "utf8");
    expect(s).toMatch(/set -euo pipefail/);
    const waitForCalls = s.match(/wait_for\s+"[^"]+"\s+\w+\s*\|\|\s*\{[^}]*exit 1/g) ?? [];
    expect(waitForCalls.length).toBeGreaterThanOrEqual(2);
  });
});
