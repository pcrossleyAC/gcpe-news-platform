import { describe, expect, it } from "vitest";
import { bcSettings } from "./fixtures";
import { SECTION_LABEL, connectDisplayOrder, differingSections, withSection } from "./index";

describe("sections", () => {
  it("labels", () => {
    expect(SECTION_LABEL).toEqual({ banner: "Banner", theme: "Theme", footer: "Footer", connect: "Social links", ministryPages: "Ministry pages" });
  });
  it("differingSections reports exactly the changed sections", () => {
    const a = bcSettings();
    expect(differingSections(a, structuredClone(a))).toEqual([]);
    const b = structuredClone(a);
    b.banner.message = "x";
    b.ministryPages.mediaContacts = "Contacts";
    expect(differingSections(a, b)).toEqual(["banner", "ministryPages"]);
  });
  it("differingSections ignores key order", () => {
    const a = bcSettings();
    const b = { ...a, theme: { colors: Object.fromEntries(Object.entries(a.theme.colors).reverse()) as typeof a.theme.colors } };
    expect(differingSections(a, b)).toEqual([]);
  });
  it("withSection returns a new document and leaves the input alone", () => {
    const a = bcSettings();
    const before = JSON.stringify(a);
    const banner = { ...a.banner, message: "hello" };
    const b = withSection(a, "banner", banner);
    expect(b).not.toBe(a);
    expect(b.banner.message).toBe("hello");
    expect(b.footer).toBe(a.footer);
    expect(JSON.stringify(a)).toBe(before);
  });
  it("connectDisplayOrder puts featured first, then accounts case-insensitively", () => {
    const l = (text: string) => ({ text, url: "https://x.ca" });
    expect(connectDisplayOrder({ featured: [l("Zed")], accounts: [l("b"), l("A"), l("c")] }).map((x) => x.text)).toEqual(["Zed", "A", "b", "c"]);
  });
});
