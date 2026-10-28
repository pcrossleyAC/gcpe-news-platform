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

  it("keeps div.asset/flickr/youtube and span.visually-hidden classes only on an element carrying the body's embed mark; drops any other class", () => {
    const opts = { embedMark: "m-1" };
    expect(sanitizeBodyHtml('<div data-embed="m-1" class="asset flickr"><a href="https://x.example/">x</a></div>', opts)).toBe('<div class="asset flickr"><a href="https://x.example/">x</a></div>');
    expect(sanitizeBodyHtml('<div data-embed="m-1" class="asset youtube"><span data-embed="m-1" class="visually-hidden">: t</span></div>', opts)).toBe('<div class="asset youtube"><span class="visually-hidden">: t</span></div>');
    expect(sanitizeBodyHtml('<div data-embed="m-1" class="asset evil row">x</div>', opts)).toBe('<div class="asset">x</div>');
    expect(sanitizeBodyHtml('<div data-embed="m-1" class="d-none">x</div>', opts)).toBe("<div>x</div>");
    expect(sanitizeBodyHtml('<span data-embed="m-1" class="asset">x</span>', opts)).toBe("<span>x</span>");
    expect(sanitizeBodyHtml('<p data-embed="m-1" class="visually-hidden">x</p>', opts)).toBe("<p>x</p>");
    expect(sanitizeBodyHtml('<span data-embed="m-1" class="visually-hidden-focusable">x</span>', opts)).toBe("<span>x</span>");
  });

  it("staff HTML can't hide text with span.visually-hidden (or borrow any embed class): without the mark every class goes", () => {
    expect(sanitizeBodyHtml('<p>Shown <span class="visually-hidden">hidden</span></p>', { embedMark: "m-1" })).toBe("<p>Shown <span>hidden</span></p>");
    expect(sanitizeBodyHtml('<span data-embed="guess" class="visually-hidden">hidden</span>', { embedMark: "m-1" })).toBe("<span>hidden</span>");
    expect(sanitizeBodyHtml('<div class="asset flickr">x</div>')).toBe("<div>x</div>");
    expect(sanitizeBodyHtml('<span data-embed="" class="visually-hidden">x</span>')).toBe("<span>x</span>");
  });

  it("keeps an in-page #name link whose target is in the same body, both under the body's prefix; a link to a missing target, or no prefix, is unwrapped", () => {
    const opts = { fragmentPrefix: "body-" };
    // Legacy NRMS: a list of anchors down to named sections (an id, or an old <a name>).
    expect(sanitizeBodyHtml('<p><a href="#cassidy">Cassidy</a> <a href="#island">Island</a></p><h2 id="cassidy">Cassidy</h2><p><a name="island">Island</a> text</p>', opts)).toBe(
      '<p><a href="#body-cassidy">Cassidy</a> <a href="#body-island">Island</a></p><h3 id="body-cassidy">Cassidy</h3><p><span id="body-island">Island</span> text</p>',
    );
    // No target in this body, an empty fragment, or an unlinked id: the link unwraps, the id goes.
    expect(sanitizeBodyHtml('<p><a href="#nowhere">x</a> <a href="#">top</a></p><p id="lonely">y</p>', opts)).toBe("<p>x top</p><p>y</p>");
    // Without a prefix (a bio), fragments are not kept.
    expect(sanitizeBodyHtml('<a href="#a">a</a><p id="a">t</p>')).toBe("a<p>t</p>");
    // A fragment name that would need escaping is never kept.
    expect(sanitizeBodyHtml('<a href="#a&quot;b">a</a><p id="a&quot;b">t</p>', opts)).toBe("a<p>t</p>");
  });

  it("unwraps an <a> left without an href (none, empty, unsafe, fragment without a target) to its text, keeping inline markup", () => {
    expect(sanitizeBodyHtml('<p><a name="x">anchor</a> <a href="javascript:alert(1)"><em>Click</em></a> <a href="https://gov.example/">kept</a></p>')).toBe(
      '<p>anchor <em>Click</em> <a href="https://gov.example/">kept</a></p>',
    );
    expect(sanitizeBodyHtml("<a>bare</a>")).toBe("bare");
  });
});

