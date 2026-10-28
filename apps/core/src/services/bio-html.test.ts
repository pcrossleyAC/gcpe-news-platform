import { describe, expect, it } from "vitest";
import { BIO_TAGS, BODY_TAGS } from "@gcpe/nrms-contract";
import { sanitizeBioHtml } from "./bio-html";
import { sanitizeBodyHtml } from "../../../public-site/src/sanitize-body";

describe("sanitizeBioHtml", () => {
  it("BIO_TAGS is BODY_TAGS without asset", () => {
    expect([...BIO_TAGS]).toEqual(BODY_TAGS.filter((t) => t !== "asset"));
  });

  it("keeps <em> and turns <i> into <em>; still drops <u>", () => {
    expect(sanitizeBioHtml("<p>Under the <em>Act</em> and <i>Code</i> <u>x</u></p>")).toBe("<p>Under the <em>Act</em> and <em>Code</em> x</p>");
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
    expect(out).toBe("<p>Hello</p>Big title" + "https://www.youtube.com/watch?v=abc" + "<p>bad proto slash</p>");
    for (const gone of ["script", "alert(1)", "iframe", "frame text", "obj text", "onclick", "style", "class", "<img", "<h1", "<asset", "javascript:", "//evil"]) {
      expect(out).not.toContain(gone);
    }
  });

  it("removes empty paragraphs and trims", () => {
    expect(sanitizeBioHtml("  <p></p><p>Text</p><p> </p><p>&nbsp;</p><p><strong></strong></p>\n ")).toBe("<p>Text</p>");
    expect(sanitizeBioHtml("<p></p>")).toBe("");
    expect(sanitizeBioHtml("   ")).toBe("");
  });

  it("unwraps an <a> left without an href to its text (no hrefless link survives), like the public sanitiser", () => {
    const html = '<p><a name="top">anchor</a> <a href="">empty</a> <a href="#frag">frag</a> <a href="javascript:x()"><strong>bold</strong></a> <a href="/ok">ok</a></p>';
    expect(sanitizeBioHtml(html)).toBe('<p>anchor empty frag <strong>bold</strong> <a href="/ok">ok</a></p>');
    expect(sanitizeBodyHtml(html)).toBe(sanitizeBioHtml(html));
  });
});
