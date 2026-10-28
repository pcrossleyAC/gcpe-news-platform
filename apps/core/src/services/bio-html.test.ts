import { describe, expect, it } from "vitest";
import { BIO_TAGS, BODY_TAGS } from "@gcpe/nrms-contract";
import { sanitizeBioHtml } from "./bio-html";

describe("sanitizeBioHtml", () => {
  it("BIO_TAGS is BODY_TAGS without asset", () => {
    expect([...BIO_TAGS]).toEqual(BODY_TAGS.filter((t) => t !== "asset"));
  });

  it("keeps p, strong, ul/ol/li, a[href], br, div; b becomes strong", () => {
    const html =
      '<div><p>Minister <b>Pat</b> <strong>Doe</strong><br>was elected.</p><ul><li>One</li></ul><ol><li>Two</li></ol><p><a href="https://gov.bc.ca/x">site</a> <a href="mailto:pat@gov.bc.ca">mail</a> <a href="/about">about</a></p></div>';
    expect(sanitizeBioHtml(html)).toBe(
      '<div><p>Minister <strong>Pat</strong> <strong>Doe</strong><br />was elected.</p><ul><li>One</li></ul><ol><li>Two</li></ol><p><a href="https://gov.bc.ca/x">site</a> <a href="mailto:pat@gov.bc.ca">mail</a> <a href="/about">about</a></p></div>',
    );
  });

  it("drops script/iframe/object content, on* attributes, img, h1 (text kept), <asset> and javascript: hrefs", () => {
    const html = [
      "<script>alert(1)</script>",
      '<iframe src="https://evil.example">frame text</iframe>',
      "<object>obj text</object>",
      "<style>p{}</style>",
      '<p onclick="steal()" class="x" style="color:red">Hello</p>',
      '<img src="https://x/y.jpg" alt="pic">',
      "<h1>Big title</h1>",
      '<asset>https://www.youtube.com/watch?v=abc</asset>',
      '<p><a href="javascript:alert(1)">bad</a> <a href="//evil.example/x">proto</a> <a href="/\\evil.example">slash</a></p>',
    ].join("");
    const out = sanitizeBioHtml(html);
    expect(out).toBe("<p>Hello</p>Big title" + "https://www.youtube.com/watch?v=abc" + "<p><a>bad</a> <a>proto</a> <a>slash</a></p>");
    for (const gone of ["script", "alert(1)", "iframe", "frame text", "obj text", "onclick", "style", "class", "<img", "<h1", "<asset", "javascript:", "//evil"]) {
      expect(out).not.toContain(gone);
    }
  });

  it("removes empty paragraphs and trims", () => {
    expect(sanitizeBioHtml("  <p></p><p>Text</p><p> </p><p>&nbsp;</p><p><strong></strong></p>\n ")).toBe("<p>Text</p>");
    expect(sanitizeBioHtml("<p></p>")).toBe("");
    expect(sanitizeBioHtml("   ")).toBe("");
  });
});
