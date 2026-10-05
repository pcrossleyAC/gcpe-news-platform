import { describe, expect, it } from "vitest";
import { reduceToAllowedHtml } from "./pasteFilter";

describe("reduceToAllowedHtml (task-4-brief.md Step 1: paste is reduced to the allow-list)", () => {
  it("drops a heading but keeps its text", () => {
    expect(reduceToAllowedHtml("<h1>Title</h1><p>keep</p>")).toBe("Title<p>keep</p>");
  });

  it("drops disallowed tags but keeps their text", () => {
    expect(reduceToAllowedHtml("<h1>Title</h1><p><span style=\"color:red\">keep</span></p>")).toBe("Title<p>keep</p>");
  });

  it("drops script/style content entirely", () => {
    expect(reduceToAllowedHtml('<p>a</p><script>alert(1)</script><style>p{}</style>')).toBe("<p>a</p>");
  });

  it("drops an <img>, including its alt text", () => {
    expect(reduceToAllowedHtml('<p><img src="x" alt="y" onerror="alert(1)">b</p>')).toBe("<p>b</p>");
  });

  it("keeps a[href] only for allowed schemes; strips target/rel/class/style/onclick", () => {
    expect(reduceToAllowedHtml('<a href="https://gov.bc.ca" target="_blank" rel="x" onclick="y()">link</a>')).toBe('<a href="https://gov.bc.ca">link</a>');
    expect(reduceToAllowedHtml('<a href="mailto:a@b.ca">mail</a>')).toBe('<a href="mailto:a@b.ca">mail</a>');
  });

  it("removes a javascript: link's href but keeps its text", () => {
    expect(reduceToAllowedHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
  });

  it("normalises b to strong", () => {
    expect(reduceToAllowedHtml("<b>bold</b>")).toBe("<strong>bold</strong>");
  });

  it("keeps lists, hard breaks and a plain div exactly", () => {
    expect(reduceToAllowedHtml("<ul><li>one</li></ul><ol><li>two</li></ol><div>d<br>e</div>")).toBe("<ul><li>one</li></ul><ol><li>two</li></ol><div>d<br>e</div>");
  });

  it("keeps an <asset> embed's URL text content", () => {
    expect(reduceToAllowedHtml("<asset>https://youtu.be/abc</asset>")).toBe("<asset>https://youtu.be/abc</asset>");
  });
});
