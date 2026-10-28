import { describe, expect, it } from "vitest";
import { sanitizeBodyHtml } from "./sanitize-body";

describe("sanitizeBodyHtml", () => {
  it("strips a <script> tag and its contents", () => {
    expect(sanitizeBodyHtml("<p>Hi</p><script>alert(1)</script>")).toBe("<p>Hi</p>");
  });

  it("strips an onerror handler from an image, keeping the tag", () => {
    const out = sanitizeBodyHtml('<img src="https://files.example/a.png" onerror="alert(1)">');
    expect(out).not.toContain("onerror");
    expect(out).toContain('src="https://files.example/a.png"');
  });

  it("strips a javascript: href, keeping the link text but not the attribute", () => {
    const out = sanitizeBodyHtml('<a href="javascript:alert(1)">Click</a>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain("Click");
  });

  it("strips an iframe entirely", () => {
    expect(sanitizeBodyHtml('<p>Before</p><iframe src="https://evil.example"></iframe><p>After</p>')).toBe("<p>Before</p><p>After</p>");
  });

  it("strips a <style> tag and a style attribute", () => {
    expect(sanitizeBodyHtml("<style>body{display:none}</style><p>Hi</p>")).toBe("<p>Hi</p>");
    const out = sanitizeBodyHtml('<p style="display:none">Hi</p>');
    expect(out).not.toContain("style");
    expect(out).toContain("<p>Hi</p>");
  });

  it("strips object, embed and form", () => {
    expect(sanitizeBodyHtml('<object data="x"></object><embed src="x"><form action="x"><input></form><p>Hi</p>')).toBe("<p>Hi</p>");
  });

  it("refuses a backslash-bypassed href/src, like isSafeUrl", () => {
    const href = sanitizeBodyHtml('<a href="/\\evil.example/phish">Click</a>');
    expect(href).not.toContain("evil.example");
    expect(href).toContain("Click");
    const src = sanitizeBodyHtml('<img src="/\\evil.example/a.png">');
    expect(src).not.toContain("evil.example");
  });

  it("refuses a protocol-relative //host href", () => {
    expect(sanitizeBodyHtml('<a href="//evil.example">Click</a>')).not.toContain("evil.example");
  });

  it("keeps ordinary formatting: paragraphs, lists, tables, links, images, figures (headings demoted one level, as every page already does)", () => {
    const input = [
      "<p>A paragraph with <strong>bold</strong>, <em>italic</em> and <u>underline</u>.</p>",
      "<h2>A heading</h2>",
      "<ul><li>One</li><li>Two</li></ul>",
      '<table><thead><tr><th colspan="2">Head</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr></tbody></table>',
      '<a href="https://gov.example/page">A link</a>',
      '<figure><img src="https://files.example/a.png" alt="An image" width="100" height="80"><figcaption>Caption</figcaption></figure>',
      "<blockquote>Quoted</blockquote>",
      "<hr>",
    ].join("");
    const expected = input
      .replace("<h2>A heading</h2>", "<h3>A heading</h3>")
      .replace('width="100" height="80">', 'width="100" height="80" />') // sanitize-html's own self-closing style
      .replace("<hr>", "<hr />");
    expect(sanitizeBodyHtml(input)).toBe(expected);
  });

  it("demotes a heading that survives sanitising, so a body <h1> renders as <h2> and the page keeps one h1", () => {
    expect(sanitizeBodyHtml("<h1>Inner</h1>")).toBe("<h2>Inner</h2>");
  });

  it("strips an attribute not in the allow-list, such as class or id, from an otherwise-allowed tag", () => {
    expect(sanitizeBodyHtml('<p class="x" id="y">Hi</p>')).toBe("<p>Hi</p>");
  });

  it("sanitizeBodyHtml keeps div.asset/flickr/youtube and span.visually-hidden classes, drops any other class", () => {
    expect(sanitizeBodyHtml('<div class="asset flickr"><a href="https://x.example/">x</a></div>')).toBe('<div class="asset flickr"><a href="https://x.example/">x</a></div>');
    expect(sanitizeBodyHtml('<div class="asset youtube"><span class="visually-hidden">: t</span></div>')).toBe('<div class="asset youtube"><span class="visually-hidden">: t</span></div>');
    expect(sanitizeBodyHtml('<div class="asset evil row">x</div>')).toBe('<div class="asset">x</div>');
    expect(sanitizeBodyHtml('<div class="d-none">x</div>')).toBe("<div>x</div>");
    expect(sanitizeBodyHtml('<span class="asset">x</span>')).toBe("<span>x</span>");
    expect(sanitizeBodyHtml('<p class="visually-hidden">x</p>')).toBe("<p>x</p>");
    expect(sanitizeBodyHtml('<span class="visually-hidden-focusable">x</span>')).toBe("<span>x</span>");
  });
});
