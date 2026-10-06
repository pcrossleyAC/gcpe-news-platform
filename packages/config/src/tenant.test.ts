import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertTimeZoneRules, loadTenantConfig } from "./tenant";
import { fileURLToPath } from "node:url";

function writeTemp(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "tenant-"));
  const file = join(dir, "t.json");
  writeFileSync(file, JSON.stringify(content));
  return file;
}

const valid = {
  tenantId: "bc",
  siteName: "BC Gov News",
  timeZone: "America/Vancouver",
  defaultLanguageId: 4105,
  organizationLabel: { singular: "Ministry", plural: "Ministries" },
  publicSiteBaseUrl: "https://news.gov.bc.ca",
  branding: { primaryColor: "#003366", logoUrl: null },
};

describe("loadTenantConfig", () => {
  it("loads the committed BC tenant file", () => {
    const cfg = loadTenantConfig(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url)));
    expect(cfg.tenantId).toBe("bc");
    expect(cfg.timeZone).toBe("America/Vancouver");
  });

  it("rejects an unknown IANA time zone", () => {
    expect(() => loadTenantConfig(writeTemp({ ...valid, timeZone: "Mars/Olympus" }))).toThrow(/timeZone/);
  });

  it("rejects a malformed brand colour", () => {
    expect(() =>
      loadTenantConfig(writeTemp({ ...valid, branding: { primaryColor: "blue", logoUrl: null } })),
    ).toThrow(/primaryColor/);
  });

  it("rejects a malformed timeZoneCheck.expectedOffset", () => {
    expect(() =>
      loadTenantConfig(writeTemp({ ...valid, timeZoneCheck: { at: "2027-01-15T19:00:00Z", expectedOffset: "nope" } })),
    ).toThrow(/expectedOffset/);
  });

  // I3/P2-R17: this is the real, committed BC config exercising the real runtime's Intl —
  // deliberately not a synthetic fixture. CI runs under Node 24 (new enough tzdata to know BC
  // stays UTC-7 permanently from 2026-11-01); the project's local default Node 22 has stale
  // tzdata and is *expected* to fail this one, per the brief — proof the check actually
  // catches staleness rather than rubber-stamping everything.
  it("assertTimeZoneRules passes for the committed BC tenant config under current tzdata (requires Node 24+)", () => {
    const cfg = loadTenantConfig(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url)));
    expect(() => assertTimeZoneRules(cfg)).not.toThrow();
  });
});

describe("assertTimeZoneRules", () => {
  // UTC's offset is always +00:00, on every runtime's tzdata, at every instant — this is a
  // pure unit test of the checker itself, not of any particular tenant's time-zone rules.
  it("passes when the runtime's Intl matches the pinned offset", () => {
    const tenant = { tenantId: "test", timeZone: "UTC", timeZoneCheck: { at: "2024-06-01T12:00:00Z", expectedOffset: "+00:00" } };
    expect(() => assertTimeZoneRules(tenant)).not.toThrow();
  });

  it("is a no-op when timeZoneCheck is absent", () => {
    const tenant = { tenantId: "test", timeZone: "UTC", timeZoneCheck: undefined };
    expect(() => assertTimeZoneRules(tenant)).not.toThrow();
  });

  it("throws a clear message naming the tenant, time zone, expected/actual offset, and process.versions.tz when the expected offset is wrong", () => {
    const tenant = { tenantId: "bc", timeZone: "UTC", timeZoneCheck: { at: "2024-06-01T12:00:00Z", expectedOffset: "-07:00" } };
    expect(() => assertTimeZoneRules(tenant)).toThrow(
      new RegExp(`"bc".*UTC.*\\+00:00.*-07:00.*process\\.versions\\.tz=${process.versions.tz ?? "unknown"}`, "s"),
    );
  });
});
