import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { siteThemeSchema } from "@gcpe/config";
import { BC_SANS_FILES } from "./site-assets";
import { DEFAULT_THEME, themeCss } from "./theme-css";

const overrides = readFileSync(new URL("../assets/site/overrides.css", import.meta.url), "utf8");

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
    expect(overrides).toMatch(/\.skip-link:focus\s*\{/);
  });
  it("aliases the five legacy variables to our tokens", () => {
    expect(themeCss(DEFAULT_THEME)).toContain(
      ":root{--primary-blue:var(--color-primary);--info-blue:var(--color-primary);--theme-text:var(--color-text);--theme-link:var(--color-primary);--theme-footer-background:var(--color-background)}",
    );
  });
  it(":focus-visible is the last rule", () => {
    expect(themeCss(DEFAULT_THEME).trimEnd().endsWith(":focus-visible { outline: 3px solid var(--color-accent); outline-offset: 2px; }")).toBe(true);
  });
  it("keeps only the token blocks and the focus rule; every other rule lives in overrides.css", () => {
    const css = themeCss(DEFAULT_THEME);
    for (const sel of [".site-footer", ".card", ".post-list", ".ministry-layout", ".connect-list", ".site-banner", ".skip-link"]) {
      expect(css).not.toContain(sel);
      expect(overrides).toContain(sel);
    }
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
    expect(overrides).toMatch(/\.site-banner\s*\{[^}]*background: var\(--color-banner-info\)/);
    expect(overrides).toMatch(/\.site-banner-emergency\s*\{[^}]*background: var\(--color-banner-emergency\)/);
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

describe("overrides.css", () => {
  it("uses token colours only: no hex, rgb() or named colours", () => {
    expect(overrides).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(overrides).not.toMatch(/\brgba?\(/);
    expect(overrides).not.toMatch(/:\s*(white|black|red|gray|grey)\b/);
  });
  it("folds in components.css's nav-link hover, the icon sprite sizing and long-link wrapping", () => {
    expect(overrides).toMatch(/\.nav-link:hover,\s*\.nav-link:focus\s*\{[^}]*background-color:\s*var\(--color-/);
    expect(overrides).toContain(".icon{width:1em;height:1em;fill:currentColor;vertical-align:-0.125em}");
    expect(overrides).toContain(".story-copy a, main a{overflow-wrap:anywhere}");
  });
  it("underlines links inside running text (legacy CSS removes it; axe link-in-text-block, WCAG 1.4.1)", () => {
    expect(overrides).toMatch(/main p a, main li a\s*\{[^}]*text-decoration:\s*underline/);
  });
  it("re-declares the six BC Sans faces legacy declares, woff2 only, with font-display: swap", () => {
    const faces = [...overrides.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]!);
    const desc = faces.map((f) => ({
      style: /font-style:\s*(\w+)/.exec(f)?.[1],
      weight: /font-weight:\s*(\w+)/.exec(f)?.[1],
      file: /url\("\.\.\/legacy\/fonts\/([^"]+)"\)/.exec(f)?.[1],
      swap: /font-display:\s*swap/.test(f) && /font-family:\s*"BCSans"/.test(f),
    }));
    expect(desc).toEqual([
      { style: "normal", weight: "normal", file: "BCSans-Regular.woff2", swap: true },
      { style: "italic", weight: "normal", file: "BCSans-Italic.woff2", swap: true },
      { style: "normal", weight: "700", file: "BCSans-Bold.woff2", swap: true },
      { style: "italic", weight: "700", file: "BCSans-BoldItalic.woff2", swap: true },
      { style: "normal", weight: "300", file: "BCSans-Light.woff2", swap: true },
      { style: "italic", weight: "300", file: "BCSans-LightItalic.woff2", swap: true },
    ]);
    for (const d of desc) expect(BC_SANS_FILES).toContain(d.file);
  });
  it("has no :focus-visible outline rule of its own (theme.css's loads last)", () => {
    expect(overrides).not.toMatch(/(^|[,}])\s*:focus-visible\s*\{/m);
  });
});
