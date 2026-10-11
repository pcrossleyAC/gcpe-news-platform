import { describe, expect, it } from "vitest";
import { collapseWhitespace, htmlToPlainText, normaliseForEmbedding } from "./text";

describe("htmlToPlainText", () => {
  it("decodes entities, keeps inline words joined and separates blocks", () => {
    expect(htmlToPlainText("<p>Crews&nbsp;are <b>on</b>-site.</p><p>Call&#160;250&amp;more</p>end<br>line &lt;tag&gt;")).toBe(
      "Crews are on-site. Call 250&more end line <tag>",
    );
  });

  it("drops script and style content", () => {
    expect(htmlToPlainText("<p>Shown</p><script>alert(1)</script><style>p{color:red}</style>")).toBe("Shown");
  });

  it("copes with unclosed tags, plain text, null and empty", () => {
    expect(htmlToPlainText("<p>unclosed <b>bold")).toBe("unclosed bold");
    expect(htmlToPlainText("Drivers can expect…")).toBe("Drivers can expect…");
    expect(htmlToPlainText(null)).toBe("");
    expect(htmlToPlainText("")).toBe("");
  });

  it("puts table cells and list items apart", () => {
    expect(htmlToPlainText("<table><tr><td>Region</td><td>Count</td></tr></table><ul><li>One</li><li>Two</li></ul>")).toBe(
      "Region Count One Two",
    );
  });
});

describe("collapseWhitespace", () => {
  it("collapses runs of any whitespace (including no-break spaces) and trims", () => {
    expect(collapseWhitespace("  a \n\t b  c  ")).toBe("a b c");
  });
});

describe("normaliseForEmbedding", () => {
  it("lower-cases, folds compatibility forms and turns punctuation into single spaces", () => {
    expect(normaliseForEmbedding("WILDFIRE, Crews!  Ｆｉｒｅ")).toBe("wildfire crews fire");
  });
});
