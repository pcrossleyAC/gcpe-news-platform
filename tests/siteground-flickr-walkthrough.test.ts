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

  it("gives recovery a budget of at least RETRY_MS (300s) plus two 60s ticks, and raises the phase-1 default", () => {
    const s = readFileSync("scripts/siteground-flickr-walkthrough.sh", "utf8");
    const pollInterval = Number(/POLL_INTERVAL="\$\{POLL_INTERVAL:-(\d+)\}"/.exec(s)?.[1]);
    const maxPolls = Number(/MAX_POLLS="\$\{MAX_POLLS:-(\d+)\}"/.exec(s)?.[1]);
    const recoveryMaxPolls = Number(/RECOVERY_MAX_POLLS="\$\{RECOVERY_MAX_POLLS:-(\d+)\}"/.exec(s)?.[1]);
    expect(pollInterval).toBe(60);
    expect(maxPolls).toBeGreaterThanOrEqual(8);
    expect(recoveryMaxPolls).toBeGreaterThanOrEqual(10);
    const RETRY_MS = 300_000;
    const PUBLISHER_TICK_MS = 60_000;
    expect(recoveryMaxPolls * pollInterval * 1000).toBeGreaterThanOrEqual(RETRY_MS + 2 * PUBLISHER_TICK_MS);
  });

  it("checks fake mode before doing anything, and fails every control curl on an HTTP error", () => {
    const s = readFileSync("scripts/siteground-flickr-walkthrough.sh", "utf8");
    expect(s).toMatch(/fake-Flickr mode/);
    const loginLine = s.split("\n").findIndex((l) => l.includes('"$BASE/core/auth/login"'));
    const fakeCheckLine = s.split("\n").findIndex((l) => l.includes("FAKE_STATUS="));
    const createLine = s.split("\n").findIndex((l) => l.includes('"$BASE/nrms/api/releases"'));
    expect(loginLine).toBeGreaterThanOrEqual(0);
    expect(fakeCheckLine).toBeGreaterThan(loginLine);
    expect(fakeCheckLine).toBeLessThan(createLine);
    const controlCalls = s.match(/curl_api -f -o \/dev\/null -X POST "\$BASE\/(fake-flickr\/__fake\/state|nrms\/api\/releases\/\$ID\/schedule)"/g) ?? [];
    expect(controlCalls.length).toBe(3);
  });

  it("exits non-zero when the expected end state is never reached", () => {
    const s = readFileSync("scripts/siteground-flickr-walkthrough.sh", "utf8");
    expect(s).toMatch(/set -euo pipefail/);
    const waitForCalls = s.match(/wait_for\s+"[^"]+"\s+\w+\s+"\$\w+"\s*\|\|\s*\{[^}]*exit 1/g) ?? [];
    expect(waitForCalls.length).toBeGreaterThanOrEqual(2);
  });
});
