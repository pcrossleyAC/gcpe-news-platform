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
});
