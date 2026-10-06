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
});
