import { describe, expect, it } from "vitest";
import { siteThemeSchema } from "@gcpe/config";
import { DEFAULT_THEME, themeCss } from "./theme-css";

describe("themeCss", () => {
  it("emits every colour as a CSS variable and the font stack", () => {
    const css = themeCss(DEFAULT_THEME);
    for (const [name, value] of Object.entries(DEFAULT_THEME.colors)) {
      const kebab = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      expect(css).toContain(`--color-${kebab}: ${value};`);
    }
    expect(css).toContain(`--font-family: "${DEFAULT_THEME.font.family}", ${DEFAULT_THEME.font.fallback};`);
  });
  it("uses only variables for colours outside :root", () => {
    const body = themeCss(DEFAULT_THEME).split("}").slice(1).join("}");
    expect(body).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
  it("has a visible focus style and a skip link that appears on focus", () => {
    const css = themeCss(DEFAULT_THEME);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--color-accent\)/);
    expect(css).toMatch(/\.skip-link:focus\s*\{/);
  });
  it("refuses to quote a font family that could break out of the declaration", () => {
    const evil = { ...DEFAULT_THEME, font: { family: 'X"; } body { color: red', fallback: "serif" } };
    expect(themeCss(evil)).not.toContain("color: red");
  });
  it("refuses a hostile font fallback that could open an unterminated string", () => {
    const evil = { ...DEFAULT_THEME, font: { family: "Noto Sans", fallback: 'serif", color: red; } body { color: blue' } };
    const css = themeCss(evil);
    expect(css).not.toContain("color: red");
    expect(css).not.toContain("color: blue");
    // Exactly the one quoted pair around the family name survives — no stray quote from the
    // hostile fallback is left in to open an unterminated string.
    expect(css.match(/"/g)).toHaveLength(2);
  });
  it("site settings colours replace the tenant's, and add the banner variables", () => {
    const colors = { ...DEFAULT_THEME.colors, primary: "#013366", bannerInfo: "#123456", bannerEmergency: "#A12B2B" };
    const css = themeCss(DEFAULT_THEME, colors);
    expect(css).toContain("--color-primary: #013366;");
    expect(css).not.toContain(`--color-primary: ${DEFAULT_THEME.colors.primary};`);
    expect(css).toContain("--color-banner-info: #123456;");
    expect(css).toContain("--color-banner-emergency: #A12B2B;");
    expect(css).toMatch(/\.site-banner\s*\{[^}]*background: var\(--color-banner-info\)/);
    expect(css).toMatch(/\.site-banner-emergency\s*\{[^}]*background: var\(--color-banner-emergency\)/);
  });
  it("without settings colours, the banner variables use the default banner colours", () => {
    const css = themeCss(DEFAULT_THEME);
    expect(css).toContain("--color-banner-info: #013366;");
    expect(css).toContain("--color-banner-emergency: #D8292F;");
  });
  it("a colour that isn't #RRGGBB never reaches the stylesheet (an unvalidated document)", () => {
    const css = themeCss(DEFAULT_THEME, { ...DEFAULT_THEME.colors, bannerInfo: "red; } body { display: none", bannerEmergency: "#D8292F" });
    expect(css).not.toContain("display: none");
    expect(css).toContain("--color-banner-info: #013366;");
  });
  it("the default theme passes the tenant schema's contrast check", () => {
    expect(siteThemeSchema.safeParse(DEFAULT_THEME).success).toBe(true);
  });
});
