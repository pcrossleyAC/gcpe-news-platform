import { describe, expect, it } from "vitest";
import { contrastRatio, siteThemeSchema, WCAG_AA_TEXT_CONTRAST } from "./theme";

const theme = {
  colors: {
    primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D",
    mutedText: "#474543", surface: "#F2F2F2", background: "#FFFFFF", border: "#D8D8D8",
  },
  font: { family: "Example Sans", fallback: "Verdana, Arial, sans-serif" },
  logo: { path: "assets/logo.svg", alt: "Example Government" },
  footerLinks: [{ label: "Privacy", url: "https://example.test/privacy" }],
};

describe("contrastRatio", () => {
  it("is 21:1 for black on white and 1:1 for a colour on itself, in either order", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#013366", "#013366")).toBeCloseTo(1, 10);
  });

  it("puts #767676 on white just above AA and #777777 just below", () => {
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(WCAG_AA_TEXT_CONTRAST);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(WCAG_AA_TEXT_CONTRAST);
  });
});

describe("siteThemeSchema", () => {
  it("accepts a theme whose three checked pairs pass AA", () => {
    expect(siteThemeSchema.safeParse(theme).success).toBe(true);
  });

  it.each([
    ["text", "background", { text: "#777777", background: "#FFFFFF" }],
    ["text", "surface", { text: "#767676", surface: "#767676" }],
    ["primaryText", "primary", { primaryText: "#FFFFFF", primary: "#FCBA19" }],
  ])("refuses %s on %s below 4.5:1, naming the pair", (fg, bg, colors) => {
    const result = siteThemeSchema.safeParse({ ...theme, colors: { ...theme.colors, ...colors } });
    expect(result.success).toBe(false);
    const issue = result.error!.issues[0]!;
    expect(issue.path).toEqual(["colors", fg]);
    expect(issue.message).toContain(`${fg} `);
    expect(issue.message).toContain(` on ${bg} `);
    expect(issue.message).toContain("4.5:1");
  });

  it("refuses a colour that isn't #RRGGBB", () => {
    const result = siteThemeSchema.safeParse({ ...theme, colors: { ...theme.colors, accent: "gold" } });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.path).toEqual(["colors", "accent"]);
  });

  it.each(["/etc/logo.svg", "../logo.svg", "assets/../../logo.svg", "https://example.test/logo.svg", ""])(
    "refuses logo path %j: it must be a relative path under the site's assets",
    (path) => {
      expect(siteThemeSchema.safeParse({ ...theme, logo: { path, alt: "x" } }).success).toBe(false);
    },
  );

  it("accepts an https or site-relative font stylesheet URL", () => {
    expect(siteThemeSchema.safeParse({ ...theme, font: { ...theme.font, stylesheetUrl: "https://example.test/font.css" } }).success).toBe(true);
    expect(siteThemeSchema.safeParse({ ...theme, font: { ...theme.font, stylesheetUrl: "/assets/font.css" } }).success).toBe(true);
  });

  it.each(["font.css", "http://example.test/font.css", "javascript:alert(1)", "//evil.example/font.css", "/\\evil.example/font.css"])(
    "refuses a font stylesheet URL of %j (not a non-http(s) scheme, not http:, and never the backslash bypass)",
    (stylesheetUrl) => {
      expect(siteThemeSchema.safeParse({ ...theme, font: { ...theme.font, stylesheetUrl } }).success).toBe(false);
    },
  );

  it.each(["https://example.test/privacy", "http://example.test/privacy", "mailto:info@example.test", "/privacy"])(
    "accepts a footer link url of %j",
    (url) => {
      expect(siteThemeSchema.safeParse({ ...theme, footerLinks: [{ label: "Privacy", url }] }).success).toBe(true);
    },
  );

  it.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "//evil.example/phish", "/\\evil.example/phish", "\\/evil.example", ""])(
    "refuses a footer link url of %j",
    (url) => {
      const result = siteThemeSchema.safeParse({ ...theme, footerLinks: [{ label: "Privacy", url }] });
      expect(result.success).toBe(false);
    },
  );
});
