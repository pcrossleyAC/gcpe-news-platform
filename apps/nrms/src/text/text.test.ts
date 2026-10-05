import { describe, expect, it } from "vitest";
import { BODY_TAGS as CONTRACT_BODY_TAGS } from "@gcpe/nrms-contract";
import { htmlToText } from "./html-to-text";
import { asciiPunctuation, collapseBlankLines, ledeFromBody, summaryFromBody, trimSummary } from "./plain";
import { BODY_TAGS, sanitizeBodyHtml } from "./sanitize";
import { generateSlug } from "./slug";

describe("generateSlug — legacy SlugUnitTests cases, verbatim", () => {
  it.each([
    ["Province celebrates First Nation, Métis, Inuit employees", "province-celebrates-first-nation-metis-inuit-employees"],
    ["B.C.'s Skills for Jobs Blueprint eNewsletter", "bcs-skills-for-jobs-blueprint-enewsletter"],
    ["OPINION-EDITORIAL: As K'ómoks signs AIP, treaty process is going strong", "opinion-editorial-as-komoks-signs-aip-treaty-process-is-going-strong"],
    ["BC Liquor Stores collect over $208,000 for Nepal Relief", "bc-liquor-stores-collect-over-208000-for-nepal-relief"],
    ["Canada and British Columbia sign Agreement-in-Principle", "canada-and-british-columbia-sign-agreement-in-principle"],
    ["FACTSHEET: BC Stats Report - Profile of the British Columbia High Tech Sector 2014 Edition", "factsheet-bc-stats-report-profile-of-the-british-columbia-high-tech-sector-2014-edition"],
    ["Tsilhqot’in title land access", "tsilhqotin-title-land-access"],
    ["Et si l’absentéisme révélait un mal être au travail ?", "et-si-labsenteisme-revelait-un-mal-etre-au-travail"],
  ])("%s", (phrase, slug) => expect(generateSlug(phrase)).toBe(slug));

  it("cuts at 100 characters without a trailing hyphen, and can come out empty", () => {
    const s = generateSlug(`${"word ".repeat(30)}end`);
    expect(s.length).toBeLessThanOrEqual(100);
    expect(s.endsWith("-")).toBe(false);
    expect(generateSlug("中文 !!!")).toBe("");
  });
});

describe("sanitizeBodyHtml", () => {
  it("drives its allow-list from the shared @gcpe/nrms-contract list (Task 1, staff-web)", () => {
    // Reference equality: sanitize.ts must re-export the contract's own tuple, not a second
    // array that merely happens to contain the same strings today.
    expect(BODY_TAGS).toBe(CONTRACT_BODY_TAGS);
  });

  it("keeps the allow-list, normalises b, strips attributes except a[href]", () => {
    expect(sanitizeBodyHtml('<p class="x" style="color:red">Hi <b>there</b></p>')).toBe("<p>Hi <strong>there</strong></p>");
    expect(sanitizeBodyHtml('<a href="https://gov.bc.ca" target="_blank" onclick="x()">link</a>')).toBe('<a href="https://gov.bc.ca">link</a>');
    expect(sanitizeBodyHtml("<ul><li>one</li></ul><ol><li>two</li></ol><div>d<br>e</div>")).toBe("<ul><li>one</li></ul><ol><li>two</li></ol><div>d<br />e</div>");
    expect(sanitizeBodyHtml("<asset>https://youtu.be/abc</asset>")).toBe("<asset>https://youtu.be/abc</asset>");
  });
  it("drops disallowed tags but keeps their text; drops script/style content", () => {
    expect(sanitizeBodyHtml("<h1>Title</h1><p><span>keep</span></p>")).toBe("Title<p>keep</p>");
    expect(sanitizeBodyHtml("<p>a</p><script>alert(1)</script><style>p{}</style>")).toBe("<p>a</p>");
    expect(sanitizeBodyHtml('<p><img src="x" onerror="alert(1)">b</p>')).toBe("<p>b</p>");
  });
  it("removes dangerous link schemes and empty paragraphs", () => {
    expect(sanitizeBodyHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeBodyHtml("<p>&nbsp;</p><p> <strong>&nbsp;</strong> </p><p></p><p>real</p>")).toBe("<p>real</p>");
  });
});

describe("htmlToText — legacy Convert.HtmlToText", () => {
  it("paragraphs, lists, breaks, links", () => {
    expect(htmlToText("<p>One</p><p>Two<br>three</p>")).toBe("One\r\n\r\nTwo\r\nthree\r\n\r\n");
    expect(htmlToText("<ul><li>a</li><li>b</li></ul>")).toBe("* a\r\n* b\r\n\r\n");
    expect(htmlToText("<ol><li>a</li><li>b</li></ol>")).toBe("1. a\r\n2. b\r\n\r\n");
    expect(htmlToText('<p><a href="https://gov.bc.ca">BC</a> and <a href="http://x.ca/">x.ca</a> and <a href="#top">top</a></p>')).toBe("BC (https://gov.bc.ca) and x.ca and top\r\n\r\n");
    expect(htmlToText("<p>Fish &amp; chips<asset>https://youtu.be/x</asset></p><p>&nbsp;</p>")).toBe("Fish & chips\r\n\r\n");
    expect(htmlToText("")).toBe("");
  });
});

describe("plain-text helpers", () => {
  it("asciiPunctuation follows the legacy replacement table", () => {
    expect(asciiPunctuation("‘a’ “b” c… d–e—f ‹g› h i ˆ")).toBe("'a' \"b\" c... d-e-f <g> h i ^");
  });
  it("collapseBlankLines collapses runs of blank lines", () => {
    expect(collapseBlankLines("a\r\n\r\n\r\n\r\nb\r\n  \r\nc")).toBe("a\r\n\r\nb\r\n\r\nc");
  });
  it("trimSummary matches legacy Utils.TrimSummary", () => {
    expect(trimSummary("Short.", 500)).toBe("Short.");
    expect(trimSummary("one two three four", 12)).toBe("one two...");
    expect(trimSummary("Hello world. More words here", 16)).toBe("Hello world.");
  });
  it("lede is the first line of the body text; summary trims it to 500", () => {
    expect(ledeFromBody("<p>First para.</p><p>Second.</p>")).toBe("First para.");
    expect(summaryFromBody(`<p>${"word ".repeat(200)}</p>`).length).toBeLessThanOrEqual(500);
  });
});
