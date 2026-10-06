import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("scripts/siteground-seed-users.sh", () => {
  it("is valid bash", () => {
    execFileSync("bash", ["-n", "scripts/siteground-seed-users.sh"]);
  });
  it("sends the CSRF header, keeps the cookie jar private, and never echoes passwords", () => {
    const s = readFileSync("scripts/siteground-seed-users.sh", "utf8");
    expect(s).toContain("x-gcpe-request: 1");
    expect(s).toMatch(/umask 077/);
    expect(s).toMatch(/trap .*rm -f/);
    expect(s).not.toMatch(/echo .*PASS/);
  });
  it("never passes a password to another process as a command-line argument, and sets the cleanup trap before mktemp creates the file", () => {
    const s = readFileSync("scripts/siteground-seed-users.sh", "utf8");
    const lines = s.split("\n");
    for (const line of lines) {
      expect(line).not.toMatch(/python3[^|]*"\$(ADMIN_PASS|pass)"/);
      expect(line).not.toMatch(/\bjson\b[^|]*"\$pass"/);
    }
    const trapLine = lines.findIndex((l) => /trap .*rm -f/.test(l));
    const mktempLine = lines.findIndex((l) => /JAR="\$\(mktemp\)"/.test(l));
    expect(trapLine).toBeGreaterThanOrEqual(0);
    expect(mktempLine).toBeGreaterThanOrEqual(0);
    expect(trapLine).toBeLessThan(mktempLine);
  });
  it("captures the HTTP status of every curl_api call on the update (409) path, so a failed roles/password/reactivate step is never silently reported as updated", () => {
    const s = readFileSync("scripts/siteground-seed-users.sh", "utf8");
    const elifIdx = s.indexOf('elif [ "$status" = "409" ]');
    const fiIdx = s.indexOf("\n  else", elifIdx);
    expect(elifIdx).toBeGreaterThanOrEqual(0);
    expect(fiIdx).toBeGreaterThan(elifIdx);
    const updatePath = s.slice(elifIdx, fiIdx);
    const curlCalls = updatePath.split("curl_api").length - 1;
    // The user lookup (GET) plus the three write steps (roles, password, reactivate).
    expect(curlCalls).toBe(4);
    const writeCalls = updatePath.match(/curl_api[^\n]*-X (PUT|POST|PATCH)[^\n]*/g) ?? [];
    expect(writeCalls).toHaveLength(3);
    for (const call of writeCalls) expect(call).toMatch(/-w '%\{http_code\}'/);
    expect(updatePath).toMatch(/\[ "\$all_ok" = "1" \] && echo "updated {2}\$email"/);
  });
});
