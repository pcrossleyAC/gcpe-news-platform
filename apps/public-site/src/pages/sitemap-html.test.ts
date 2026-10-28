import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { site } from "../../test/fixtures";
import { renderHtmlSitemap } from "./sitemap-html";

describe("renderHtmlSitemap", () => {
  const out = renderHtmlSitemap([
    { heading: "Pages", entries: [{ name: "A <b> & \"c\"", path: "/x/?a=1&b=2" }] },
    { heading: "Empty", entries: [] },
  ], site);
  const doc = new JSDOM(out).window.document;

  it("one h1, an h2 and list per non-empty group, names and hrefs escaped", () => {
    expect(doc.querySelectorAll("h1").length).toBe(1);
    expect([...doc.querySelectorAll("#main-content-release > h2")].map((h) => h.textContent)).toEqual(["Pages"]);
    const a = doc.querySelector("#main-content-release ul > li > a")!;
    expect(a.textContent).toBe('A <b> & "c"');
    expect(a.getAttribute("href")).toBe("/x/?a=1&b=2");
    expect(doc.querySelector("b")).toBeNull();
  });

  it("is canonical to /sitemap/", () => {
    expect(doc.querySelector("link[rel=canonical]")!.getAttribute("href")).toBe("https://news.example/sitemap/");
    expect(doc.title).toContain("Site map");
  });
});
