import { describe, expect, it } from "vitest";
import { bcSettings } from "./fixtures";
import { NETWORKS, SECTION_KEYS, SECTION_LABEL, connectDisplayOrder, differingSections, withSection } from "./index";

describe("sections", () => {
  it("labels", () => {
    expect(SECTION_LABEL).toEqual({
      banner: "Banner", theme: "Theme", footer: "Footer", connect: "Social links", ministryPages: "Ministry pages",
      contactsPage: "Media contacts page", pageText: "Page text", navigation: "Navigation and labels", siteIdentity: "Site identity",
    });
    expect(SECTION_KEYS.slice(-4)).toEqual(["contactsPage", "pageText", "navigation", "siteIdentity"]);
  });
  it("NETWORKS puts linkedin after bluesky; policyLink and intro are not networks", () => {
    expect(NETWORKS.map((n) => n.key)).toEqual(["facebook", "x", "instagram", "threads", "bluesky", "linkedin", "flickr", "youtube", "blogs"]);
    expect(NETWORKS.find((n) => n.key === "linkedin")?.name).toBe("LinkedIn");
    expect(NETWORKS.map((n) => n.key as string)).not.toContain("policyLink");
    expect(NETWORKS.map((n) => n.key as string)).not.toContain("intro");
  });
  it("differingSections reports contactsPage/pageText/navigation edits", () => {
    const a = bcSettings();
    const b = structuredClone(a);
    b.contactsPage.contacts[0]!.phone = "250-000-0000";
    b.pageText.notFound.text = "Gone.";
    b.navigation.labels.resources = "More resources";
    expect(differingSections(a, b)).toEqual(["contactsPage", "pageText", "navigation"]);
    const c = structuredClone(a);
    c.connect.intro = "Hi.";
    expect(differingSections(a, c)).toEqual(["connect"]);
  });
  it("differingSections reports a siteIdentity edit", () => {
    const a = bcSettings();
    const b = structuredClone(a);
    b.siteIdentity.blueBridge.message = "Another message.";
    expect(differingSections(a, b)).toEqual(["siteIdentity"]);
    const c = structuredClone(a);
    c.siteIdentity.twitterSite = "";
    expect(differingSections(a, c)).toEqual(["siteIdentity"]);
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
