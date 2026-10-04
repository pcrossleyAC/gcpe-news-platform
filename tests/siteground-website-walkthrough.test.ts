import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT = "scripts/siteground-website-walkthrough.sh";

describe("scripts/siteground-website-walkthrough.sh", () => {
  it("is valid bash", () => {
    execFileSync("bash", ["-n", SCRIPT]);
  });

  it("sends the CSRF header, keeps the cookie jar private, and sets the cleanup trap before mktemp creates it", () => {
    const s = readFileSync(SCRIPT, "utf8");
    expect(s).toContain("x-gcpe-request: 1");
    expect(s).toMatch(/umask 077/);
    const lines = s.split("\n");
    const trapLine = lines.findIndex((l) => /trap cleanup EXIT/.test(l));
    const mktempLine = lines.findIndex((l) => /JAR="\$\(mktemp\)"/.test(l));
    expect(trapLine).toBeGreaterThanOrEqual(0);
    expect(mktempLine).toBeGreaterThan(trapLine);
  });

  it("never passes the admin password to another process as a command-line argument, and unsets it right after use", () => {
    const s = readFileSync(SCRIPT, "utf8");
    const lines = s.split("\n");
    for (const line of lines) {
      expect(line).not.toMatch(/python3[^|]*"\$(ADMIN_PASS|pass)"/);
      expect(line).not.toMatch(/\bjson\b[^|]*"\$(ADMIN_PASS|pass)"/);
    }
    expect(s).toMatch(/unset ADMIN_PASS/);
  });

  it("refuses to run against anything but a test site, before signing in or touching anything else", () => {
    const s = readFileSync(SCRIPT, "utf8");
    const lines = s.split("\n");
    const noindexCheckLine = lines.findIndex((l) => l.includes("has no noindex meta"));
    const jarLine = lines.findIndex((l) => /JAR="\$\(mktemp\)"/.test(l));
    const loginLine = lines.findIndex((l) => l.includes('"$BASE/core/auth/login"'));
    expect(noindexCheckLine).toBeGreaterThanOrEqual(0);
    expect(noindexCheckLine).toBeLessThan(jarLine);
    expect(noindexCheckLine).toBeLessThan(loginLine);
  });

  it("turns Project Blue Bridge off and unpins the primary slide in the cleanup trap, re-reading each one's current version", () => {
    const s = readFileSync(SCRIPT, "utf8");
    const cleanupFn = s.slice(s.indexOf("cleanup() {"), s.indexOf("trap cleanup EXIT"));
    expect(cleanupFn.length).toBeGreaterThan(0);
    expect(cleanupFn).toMatch(/"on":False/);
    expect(cleanupFn).toMatch(/"pinned":False/);
    expect(cleanupFn).toContain("/nrms/api/site/blue-bridge");
    expect(cleanupFn).toContain("/nrms/api/site/pins/primary/pinned");
    // Re-reads the version rather than reusing a variable set earlier in the run.
    expect(cleanupFn).toMatch(/CUR_V=/);
    expect(cleanupFn).toMatch(/PV=/);
  });

  it("generates the test PDF in-script with a minimal valid %PDF- header, never fetching one from the network", () => {
    const s = readFileSync(SCRIPT, "utf8");
    expect(s).toMatch(/%PDF-1\.4/);
    expect(s).toMatch(/PDF_FILE="\$\(mktemp\)"/);
  });

  it("every mutating control call (POST/PUT) uses curl -f or explicitly checks its result", () => {
    const s = readFileSync(SCRIPT, "utf8");
    const lines = s.split("\n");
    const mutating = lines.filter((l) => /curl_(api|bin)\b.*-X (POST|PUT)/.test(l));
    expect(mutating.length).toBeGreaterThanOrEqual(10);
    for (const l of mutating) {
      const hasDashF = /(^|\s)-f(\s|$)/.test(l);
      const checksStatus = l.includes("-w '%{http_code}'") || l.includes("||");
      expect(hasDashF || checksStatus).toBe(true);
    }
  });

  it("exits non-zero when the expected end state is never reached, and polls once a minute up to 6 times", () => {
    const s = readFileSync(SCRIPT, "utf8");
    expect(s).toMatch(/set -euo pipefail/);
    expect(s).toMatch(/FAILED: never reached the expected state/);
    expect(s).toMatch(/POLL_INTERVAL="\$\{POLL_INTERVAL:-60\}"/);
    expect(s).toMatch(/MAX_POLLS="\$\{MAX_POLLS:-6\}"/);
  });

  it("checks the public site for the TEST banner and noindex after turning Project Blue Bridge on", () => {
    const s = readFileSync(SCRIPT, "utf8");
    expect(s).toContain("TEST — ALERT:");
    const lines = s.split("\n");
    const bbOnLine = lines.findIndex((l) => l.includes('"on":True,"confirmation"'));
    const bannerCheckLine = lines.findIndex((l) => l.includes("TEST — ALERT:"));
    expect(bbOnLine).toBeGreaterThanOrEqual(0);
    expect(bannerCheckLine).toBeGreaterThan(bbOnLine);
  });
});
