import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTenantConfig } from "./tenant";
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
});
