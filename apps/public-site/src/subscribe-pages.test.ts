import { describe, expect, it } from "vitest";
import { SUBSCRIBE_PAGES, writeSubscribePages } from "./subscribe-pages";

const site = { name: "BC Gov News", baseUrl: "https://boxs.ca/site" };

describe("subscribe test pages", () => {
  it("writes the three pages with site chrome, noindex on a test site, and no innerHTML", async () => {
    const files = new Map<string, string>();
    await writeSubscribePages({ write: async (p: string, c: string) => void files.set(p, c) } as never, site, { test: true });
    expect([...files.keys()].sort()).toEqual(["subscribe/index.html", "subscribe/manage/index.html", "subscribe/unsubscribe/index.html"]);
    for (const html of files.values()) {
      expect(html).toContain('<header><a href="/site/">');
      expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
      expect(html).toContain("/api/Subscribe/");
      expect(html).toContain("api-version=1.0");
      expect(html).not.toContain("innerHTML");
    }
  });
  it("the unsubscribe page only acts on a button press", () => {
    const html = SUBSCRIBE_PAGES.find((p) => p.path === "subscribe/unsubscribe/index.html")!.render(site, {});
    expect(html).toMatch(/<button[^>]*>Unsubscribe<\/button>/);
  });
  it("offers the emergency category alongside ministries, sectors, themes and tags", () => {
    for (const path of ["subscribe/index.html", "subscribe/manage/index.html"]) {
      const html = SUBSCRIBE_PAGES.find((p) => p.path === path)!.render(site, {});
      expect(html).toContain('<fieldset data-category="emergency">');
    }
  });
  it("has two fixed live regions instead of switching one element's role", () => {
    for (const page of SUBSCRIBE_PAGES) {
      const html = page.render(site, {});
      expect(html).toContain('<p id="message" role="status"></p>');
      expect(html).toContain('<p id="message-alert" role="alert"></p>');
      expect(html).not.toContain("setAttribute(\"role\"");
    }
  });
  it("the manage page shows the request box immediately and never queries Confirm when there is no token", () => {
    const html = SUBSCRIBE_PAGES.find((p) => p.path === "subscribe/manage/index.html")!.render(site, {});
    expect(html).toMatch(/if\s*\(!token\)\s*\{\s*requestForm\.hidden = false;\s*\}\s*else\s*\{/);
  });
  it("pins the expired-link wording", () => {
    const html = SUBSCRIBE_PAGES.find((p) => p.path === "subscribe/manage/index.html")!.render(site, {});
    expect(html).toContain("This link has expired. Request a new one below.");
  });
});
