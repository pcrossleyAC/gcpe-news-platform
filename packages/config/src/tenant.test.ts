import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertTimeZoneRules, loadTenantConfig } from "./tenant";
import { fileURLToPath } from "node:url";
import { contrastRatio, WCAG_AA_TEXT_CONTRAST } from "./theme";

function writeTemp(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "tenant-"));
  const file = join(dir, "t.json");
  writeFileSync(file, JSON.stringify(content));
  return file;
}

const theme = {
  colors: {
    primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D",
    mutedText: "#474543", surface: "#F2F2F2", background: "#FFFFFF", border: "#D8D8D8",
  },
  font: { family: "Example Sans", fallback: "Verdana, Arial, sans-serif" },
  logo: { path: "assets/logo.svg", alt: "Example Government" },
  footerLinks: [],
};

const valid = {
  tenantId: "bc",
  siteName: "BC Gov News",
  timeZone: "America/Vancouver",
  defaultLanguageId: 4105,
  organizationLabel: { singular: "Ministry", plural: "Ministries" },
  publicSiteBaseUrl: "https://news.gov.bc.ca",
  site: { theme },
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

  it("rejects a malformed theme colour", () => {
    expect(() =>
      loadTenantConfig(writeTemp({ ...valid, site: { theme: { ...theme, colors: { ...theme.colors, primary: "blue" } } } })),
    ).toThrow(/site\.theme\.colors\.primary/);
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

  it("defaults features off and the search language to english when absent", () => {
    const cfg = loadTenantConfig(writeTemp(valid));
    expect(cfg.features).toEqual({ semanticSearch: false, staffAi: false });
    expect(cfg.search).toEqual({ language: "english" });
  });

  it("rejects a search language Postgres configuration outside english, french and simple", () => {
    expect(() => loadTenantConfig(writeTemp({ ...valid, search: { language: "german" } }))).toThrow(/search\.language/);
  });

  it("refuses a theme below WCAG AA and names the failing pair", () => {
    const failing = { ...theme, colors: { ...theme.colors, text: "#777777" } };
    expect(() => loadTenantConfig(writeTemp({ ...valid, site: { theme: failing } }))).toThrow(
      /site\.theme\.colors\.text: text #777777 on background #FFFFFF has contrast 4\.4\d:1, below WCAG AA 4\.5:1/,
    );
  });

  it("requires a site theme", () => {
    const { site: _site, ...noSite } = valid;
    expect(() => loadTenantConfig(writeTemp(noSite))).toThrow(/site/);
  });

  it.each(["bc", "nb"])("loads the committed %s config with flags off, english search and a theme that passes", (id) => {
    const cfg = loadTenantConfig(fileURLToPath(new URL(`../../../config/tenants/${id}.json`, import.meta.url)));
    expect(cfg.features).toEqual({ semanticSearch: false, staffAi: false });
    expect(cfg.search.language).toBe("english");
    const c = cfg.site.theme.colors;
    // The spec checks three pairs. The committed themes also keep muted text readable.
    for (const [fg, bg] of [[c.mutedText, c.background], [c.mutedText, c.surface]] as const) {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(WCAG_AA_TEXT_CONTRAST);
    }
  });

  it("gives BC BC Sans, BC blue, BC gold and BC's logo", () => {
    const cfg = loadTenantConfig(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url)));
    expect(cfg.site.theme.font.family).toBe("BC Sans");
    expect(cfg.site.theme.colors.primary).toBe("#013366");
    expect(cfg.site.theme.colors.accent).toBe("#FCBA19");
    expect(cfg.site.theme.logo.path).toBe("assets/bc-logo.svg");
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
