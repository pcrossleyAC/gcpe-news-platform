import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { siteThemeSchema } from "@gcpe/config";
import { BC_SANS_FILES } from "./site-assets";
import { DEFAULT_THEME, fadeStrength, themeCss } from "./theme-css";

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
    for (const sel of ["#landAcknowledgement", "#footer h2", ".card", ".post-list", ".ministry-name-mobile", ".connect-list", ".site-banner-info", ".skip-link"]) {
      expect(css).not.toContain(sel);
      expect(overrides).toContain(sel);
    }
  });
  it("never puts display:contents on an element that carries a landmark (older Safari drops its role)", () => {
    expect(overrides).not.toMatch(/display\s*:\s*contents/);
    // The footer nav keeps a box and lays its two columns out as legacy's flat .top row did.
    expect(overrides).toMatch(/#footer \.top > nav\{display:flex;flex-wrap:wrap;gap:inherit;flex:2 1 50px\}/);
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
    const colors = { ...DEFAULT_THEME.colors, primary: "#013366", bannerInfo: "#123456", bannerEmergency: "#A12B2B", sectionBar: "#2B5580" };
    const css = themeCss(DEFAULT_THEME, colors);
    expect(css).toContain("--color-primary: #013366;");
    expect(css).not.toContain(`--color-primary: ${DEFAULT_THEME.colors.primary};`);
    expect(css).toContain("--color-banner-info: #123456;");
    expect(css).toContain("--color-banner-emergency: #A12B2B;");
    expect(overrides).toMatch(/\.site-banner-info\s*\{[^}]*background:\s*var\(--color-banner-info\)/);
    expect(overrides).toMatch(/\.site-banner-emergency\s*\{[^}]*background:\s*var\(--color-banner-emergency\)/);
    // The old placeholder-era rules are gone.
    expect(overrides).not.toMatch(/\.site-banner\s*[{ ]|\.blue-bridge-banner/);
  });
  it("sectionBar is the --color-section-bar variable, #2B5580 without settings", () => {
    expect(themeCss(DEFAULT_THEME)).toContain("--color-section-bar: #2B5580;");
    expect(themeCss(DEFAULT_THEME, { ...DEFAULT_THEME.colors, bannerInfo: "#013366", bannerEmergency: "#D8292F", sectionBar: "#112233" })).toContain("--color-section-bar: #112233;");
    expect(overrides).toMatch(/\.expandable-section>?[^{]*\{[^}]*var\(--color-section-bar\)/);
  });
  it("without settings colours, the banner variables use the default banner colours", () => {
    const css = themeCss(DEFAULT_THEME);
    expect(css).toContain("--color-banner-info: #013366;");
    expect(css).toContain("--color-banner-emergency: #D8292F;");
  });
  it("a colour that isn't #RRGGBB never reaches the stylesheet (an unvalidated document)", () => {
    const css = themeCss(DEFAULT_THEME, { ...DEFAULT_THEME.colors, bannerInfo: "red; } body { display: none", bannerEmergency: "#D8292F", sectionBar: "#2B5580" });
    expect(css).not.toContain("display: none");
    expect(css).toContain("--color-banner-info: #013366;");
  });
  it("--fade-strength: the strongest whole-percent background overlay that keeps primary links and body text at 4.6:1 or more (the Connect page's faded entry)", () => {
    const bc = { ...DEFAULT_THEME.colors, primary: "#013366", text: "#2D2D2D", background: "#FFFFFF", bannerInfo: "#013366", bannerEmergency: "#D8292F", sectionBar: "#2B5580" };
    // Computed for BC: 34% white over #013366 composites to #57789A (4.61:1); 35% gives #5A7A9C (4.47:1), so the link colour sets the limit.
    expect(fadeStrength(["#013366", "#2D2D2D"], "#FFFFFF")).toBe(34);
    expect(themeCss(DEFAULT_THEME, bc)).toContain("  --fade-strength: 34%;");
    // A primary that only just passes 4.5:1 leaves no room to fade.
    expect(fadeStrength(["#767676"], "#FFFFFF")).toBe(0);
    expect(themeCss(DEFAULT_THEME)).toMatch(/ {2}--fade-strength: \d+%;/);
    expect(overrides).toMatch(/li\.collapse-last::after\{[^}]*color-mix\(in srgb,var\(--color-background\) var\(--fade-strength\),transparent\)/);
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
  it("side-column link lists (More from this Ministry, Featured Topics/Services) drop the underline as legacy: each row is a link alone; hover and focus add it", () => {
    expect(overrides).toContain(".collapsible-regions .resource-links ul li>a:only-child{text-decoration:none}");
    expect(overrides).toMatch(/\.collapsible-regions \.resource-links ul li>a:only-child:hover,\.collapsible-regions \.resource-links ul li>a:only-child:focus-visible\{text-decoration:underline\}/);
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

/** Specificity (ids, classes/attributes/pseudo-classes, types) of the simple selectors overrides.css
 * uses: `:not(x)` counts as its argument; no pseudo-elements or attribute values with spaces. */
function specificity(selector: string): [number, number, number] {
  let rest = selector;
  const parts: [number, number, number] = [0, 0, 0];
  rest = rest.replace(/:not\(([^)]*)\)/g, (_m, inner: string) => {
    const [a, b, c] = specificity(inner);
    parts[0] += a;
    parts[1] += b;
    parts[2] += c;
    return " ";
  });
  parts[0] += (rest.match(/#[\w-]+/g) ?? []).length;
  parts[1] += (rest.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length;
  parts[2] += (rest.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:[\w-]+/g, " ").match(/[a-z][\w-]*/gi) ?? []).length;
  return parts;
}
const outranks = (a: [number, number, number], b: [number, number, number]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

describe("overrides.css no-JS language rules", () => {
  it("the rule hiding the language selector outranks the rule showing .story-lang.secondary, so source order can't regress it", () => {
    const rules = [...overrides.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ selectors: m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((s) => s.trim()), body: m[2]! }));
    const hide = rules.flatMap((r) => (/display:\s*none/.test(r.body) ? r.selectors : [])).find((s) => /^html:not\(\.js\) .*\.language-selector/.test(s));
    const show = rules.flatMap((r) => (/display:\s*block/.test(r.body) ? r.selectors : [])).find((s) => s === "html:not(.js) .story-lang.secondary");
    expect(hide).toBeDefined();
    expect(show).toBeDefined();
    expect(specificity("html:not(.js) .story-lang.secondary")).toEqual([0, 3, 1]);
    expect(outranks(specificity(hide!), specificity(show!))).toBeGreaterThan(0);
  });
});

describe("overrides.css home-layout order", () => {
  it("the column (after the news in the DOM) is moved left on a desktop with order:-1 and back to DOM order on a phone; no order:2", () => {
    expect(overrides).toMatch(/\.home-layout>\.home-features\{[^}]*order:-1[^}]*\}/);
    const phone = /@media \(max-width: 768px\) \{([\s\S]*?)\n\}/.exec(overrides.slice(overrides.indexOf(".home-layout{display:flex}")))![1]!;
    expect(phone).toMatch(/\.home-layout>\.home-features\{[^}]*order:0[^}]*\}/);
    expect(overrides).not.toMatch(/home-features\{[^}]*order:2/);
  });
});

