import { describe, expect, it } from "vitest";
import { bcSettings } from "./fixtures";
import { bannerVisibleAt, contrastRatio, isSafeUrl, validateSiteSettings } from "./index";
import type { SiteSettings } from "./index";

const base = (): SiteSettings => structuredClone(bcSettings());
const errorsFor = (mutate: (d: SiteSettings) => void) => {
  const d = base();
  mutate(d);
  return validateSiteSettings(d);
};

describe("contrastRatio", () => {
  it("matches WCAG reference values", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21.0, 1);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBe(1);
    expect(contrastRatio("#013366", "#FFFFFF")).toBeCloseTo(12.6, 1);
    expect(contrastRatio("#CE3E39", "#FFFFFF")).toBeCloseTo(4.8, 1);
  });
});

describe("isSafeUrl", () => {
  it.each(["https://gov.bc.ca", "/contact"])("accepts %s", (u) => expect(isSafeUrl(u)).toBe(true));
  it.each(["http://x.ca", "javascript:alert(1)", "data:text/html,x", "//evil.example", "/\\evil.example", " https://gov.bc.ca", "gov.bc.ca", ""])(
    "rejects %j",
    (u) => expect(isSafeUrl(u)).toBe(false),
  );
});

describe("validateSiteSettings", () => {
  it("accepts the bc defaults", () => expect(validateSiteSettings(base())).toEqual([]));

  it("rejects an http more-info link", () => {
    expect(errorsFor((d) => { d.footer.moreInfoLinks[2]!.url = "http://www2.gov.bc.ca/privacy"; })).toEqual([
      { field: "footer.moreInfoLinks[2].url", message: "Must start with https:// or / (a page on this site)." },
    ]);
  });

  it("checks the banner", () => {
    expect(errorsFor((d) => { d.banner.message = "<b>hi</b>"; })).toEqual([
      { field: "banner.message", message: "Use plain text. Add links below instead of HTML." },
    ]);
    expect(errorsFor((d) => { d.banner.enabled = true; d.banner.message = "   "; })).toEqual([
      { field: "banner.message", message: "Enter a message, or turn the banner off." },
    ]);
    expect(errorsFor((d) => { d.banner.message = "a".repeat(301); })).toEqual([
      { field: "banner.message", message: "Keep the message to 300 characters or fewer." },
    ]);
    expect(errorsFor((d) => { d.banner.message = "a".repeat(300); })).toEqual([]);
    const ends = { startsAt: "2026-11-01T10:00:00-07:00", endsAt: "2026-11-01T10:00:00-07:00" };
    expect(errorsFor((d) => { Object.assign(d.banner, ends); })).toEqual([
      { field: "banner.endsAt", message: "The end time must be after the start time." },
    ]);
    expect(errorsFor((d) => { d.banner.style = "loud" as never; })).toEqual([
      { field: "banner.style", message: "Choose Information or Emergency." },
    ]);
  });

  it("flags low contrast with the ratio", () => {
    const errors = errorsFor((d) => { d.theme.colors.bannerEmergency = "#F08080"; });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe("theme.colors.bannerEmergency");
    expect(errors[0]!.message).toContain("(2.6:1, needs 4.5:1)");
    expect(errors[0]!.message).toBe("Too faint to read behind white text (2.6:1, needs 4.5:1). Pick a darker shade.");
  });

  it("uses the where-wording for each contrast pair", () => {
    expect(errorsFor((d) => { d.theme.colors.text = "#999999"; }).map((e) => e.message.split(" (")[0])).toEqual([
      "Too faint to read on the page background",
      "Too faint to read on panels",
    ]);
    expect(errorsFor((d) => { d.theme.colors.primaryText = "#555555"; })).toEqual([
      { field: "theme.colors.primaryText", message: expect.stringContaining("on the header") },
    ]);
  });

  it.each(["013366", "#013", "#01336G", "red"])("rejects the malformed colour %j and skips contrast", (c) => {
    expect(errorsFor((d) => { d.theme.colors.text = c; })).toEqual([{ field: "theme.colors.text", message: "Use a colour like #013366." }]);
  });

  it("checks link summaries and ids", () => {
    expect(errorsFor((d) => { d.connect.x.accounts[0]!.summary = "<script>x</script>"; })).toEqual([
      { field: "connect.x.accounts[0].summary", message: "Use plain text, 200 characters or fewer." },
    ]);
    expect(errorsFor((d) => { d.connect.x.featured[0]!.id = 'x" onclick="alert(1)'; })).toEqual([
      { field: "connect.x.featured[0].id", message: "Link id must start with a letter and use only letters, digits, - or _." },
    ]);
  });

  it("checks footer text and link text", () => {
    expect(errorsFor((d) => { d.footer.copyrightHolder = " "; })).toEqual([{ field: "footer.copyrightHolder", message: "Enter who holds the copyright." }]);
    expect(errorsFor((d) => { d.footer.helpText = "a".repeat(201); })).toEqual([
      { field: "footer.helpText", message: "Keep the help text to 200 characters or fewer." },
    ]);
    expect(errorsFor((d) => { d.footer.helpText = "<i>"; })).toEqual([{ field: "footer.helpText", message: "Use plain text." }]);
    expect(errorsFor((d) => { d.footer.helpLinks[0]!.text = ""; })).toEqual([{ field: "footer.helpLinks[0].text", message: "Enter the link text." }]);
  });

  it("checks ministry page headings", () => {
    expect(errorsFor((d) => { d.ministryPages.ministryPhotos = "  "; })).toEqual([{ field: "ministryPages.ministryPhotos", message: "Enter a heading." }]);
    const plain = { field: "ministryPages.mediaContacts", message: "Use plain text, 60 characters or fewer." };
    expect(errorsFor((d) => { d.ministryPages.mediaContacts = "a".repeat(61); })).toEqual([plain]);
    expect(errorsFor((d) => { d.ministryPages.mediaContacts = "<b>"; })).toEqual([plain]);
    expect(errorsFor((d) => { d.ministryPages.mediaContacts = "a".repeat(60); })).toEqual([]);
  });
});

describe("bannerVisibleAt", () => {
  const banner = (over: Partial<SiteSettings["banner"]>) => ({ ...base().banner, enabled: true, message: "m", ...over });
  const start = "2026-11-01T10:00:00.000Z";
  const end = "2026-11-02T10:00:00.000Z";
  it("follows the schedule", () => {
    const b = banner({ startsAt: start, endsAt: end });
    expect(bannerVisibleAt(b, new Date(Date.parse(start) - 1000))).toBe(false);
    expect(bannerVisibleAt(b, new Date(start))).toBe(true);
    expect(bannerVisibleAt(b, new Date(end))).toBe(false);
  });
  it("is open-ended without times and hidden when disabled", () => {
    expect(bannerVisibleAt(banner({}), new Date())).toBe(true);
    expect(bannerVisibleAt(banner({ enabled: false }), new Date())).toBe(false);
  });
});
