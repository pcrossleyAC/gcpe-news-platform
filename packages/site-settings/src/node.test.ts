import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSiteSettings } from "./defaults";
import { bcSettings } from "./fixtures";
import { loadSiteSettingsDefaults } from "./node";

const theme = {
  colors: { primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D", mutedText: "#474543", surface: "#F2F2F2", background: "#FFFFFF", border: "#D8D8D8" },
  footerLinks: [{ label: "Privacy", url: "https://example.gov/privacy" }],
};

describe("loadSiteSettingsDefaults", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "site-settings-node-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("derives defaults from the theme when there is no <tenantId>.site-settings.json beside the config", () => {
    writeFileSync(join(dir, "acme.json"), JSON.stringify({ tenantId: "acme" }));
    expect(loadSiteSettingsDefaults(join(dir, "acme.json"), theme)).toEqual(defaultSiteSettings(theme));
  });

  it("reads <tenantId>.site-settings.json when present (tenantId from the config's own field)", () => {
    const doc = bcSettings();
    doc.footer.copyrightHolder = "Acme Corp";
    writeFileSync(join(dir, "renamed.json"), JSON.stringify({ tenantId: "acme" }));
    writeFileSync(join(dir, "acme.site-settings.json"), JSON.stringify(doc));
    expect(loadSiteSettingsDefaults(join(dir, "renamed.json"), theme).footer.copyrightHolder).toBe("Acme Corp");
  });

  it("falls back to the config file name when the config has no tenantId", () => {
    const doc = bcSettings();
    doc.footer.copyrightHolder = "Beta";
    writeFileSync(join(dir, "beta.json"), "{}");
    writeFileSync(join(dir, "beta.site-settings.json"), JSON.stringify(doc));
    expect(loadSiteSettingsDefaults(join(dir, "beta.json"), theme).footer.copyrightHolder).toBe("Beta");
  });

  it("throws when the settings file is not a valid document", () => {
    writeFileSync(join(dir, "acme.json"), JSON.stringify({ tenantId: "acme" }));
    writeFileSync(join(dir, "acme.site-settings.json"), "{}");
    expect(() => loadSiteSettingsDefaults(join(dir, "acme.json"), theme)).toThrow();
  });

  it("loads the real bc tenant file", () => {
    const bc = fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url));
    expect(loadSiteSettingsDefaults(bc, theme)).toEqual(bcSettings());
  });
});
