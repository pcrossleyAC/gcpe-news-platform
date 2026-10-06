import { describe, expect, it } from "vitest";
import { renderHomePage, renderPostPage, type PostDto } from "./render";

const post: PostDto = {
  key: "2026HLTH0001-000001", kind: "releases", publishDate: "2026-10-03T10:00:00-07:00", summary: "Summary <b>", location: "VICTORIA",
  ministryKeys: ["health"],
  documents: [
    { languageId: 3084, headline: "Titre", subheadline: null, detailsHtml: "<p>fr</p>", contacts: [] },
    { languageId: 4105, headline: "Clinics <script>alert(1)</script>", subheadline: null, detailsHtml: "<p>Clinics will open.</p>", contacts: [{ title: "Media", details: "Alex Example\n250-555-0100" }] },
  ],
};
const site = { name: "BC Gov News", baseUrl: "https://news.example" };

describe("render", () => {
  it("renders the English document, escaped headline, trusted body, contacts", () => {
    const html = renderPostPage(post, site);
    expect(html).toContain("<title>Clinics &lt;script&gt;alert(1)&lt;/script&gt; | BC Gov News</title>");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("<p>Clinics will open.</p>");
    expect(html).toContain("Alex Example<br>250-555-0100");
    expect(html).toContain('<link rel="canonical" href="https://news.example/releases/2026HLTH0001-000001">');
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });
  it("percent-encodes the key in the canonical link, like the home links (fix round 1, item 5)", () => {
    const spaced: PostDto = { ...post, key: "2026HLTH0001-00000 1" };
    const html = renderPostPage(spaced, site);
    expect(html).toContain('<link rel="canonical" href="https://news.example/releases/2026HLTH0001-00000%201">');
  });
  it("home lists posts linking to their pages", () => {
    const html = renderHomePage([post], site);
    expect(html).toContain('href="/releases/2026HLTH0001-000001"');
    expect(html).toContain("Clinics &lt;script&gt;");
  });
});
