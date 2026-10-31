import { describe, expect, it } from "vitest";
import { compile, parsePage, plainLanguageProblems } from "./manuals-lib.mjs";

const page = (over: Record<string, string> = {}, body = "Hello there.\n") => {
  const h = { id: "one", title: "One", manual: "core-admin", order: "1", routes: "[]", screens: "[]", topics: "[]", ...over };
  const head = Object.entries(h)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${head}\n---\n${body}`;
};
const src = (path: string, text: string) => ({ path, text });

describe("parsePage", () => {
  it("reads the header fields and the body", () => {
    const { header, body } = parsePage("a.md", page({ routes: "[/government-terms, /users]", screens: "[admin/government-terms]" }));
    expect(header).toEqual({
      id: "one",
      title: "One",
      manual: "core-admin",
      order: 1,
      routes: ["/government-terms", "/users"],
      screens: ["admin/government-terms"],
      topics: [],
    });
    expect(body).toBe("Hello there.\n");
  });
  it("throws naming the file for an unknown manual", () => {
    expect(() => parsePage("docs/manuals/x/bad.md", page({ manual: "nope" }))).toThrow(/docs\/manuals\/x\/bad\.md/);
  });
  it("throws naming the file for a missing field and an unknown field", () => {
    expect(() => parsePage("m.md", page({ title: "" }))).toThrow(/m\.md.*title/);
    expect(() => parsePage("u.md", page({ colour: "red" }))).toThrow(/u\.md.*colour/);
  });
  it("accepts topic as the manual", () => {
    expect(parsePage("t.md", page({ manual: "topic" })).header.manual).toBe("topic");
  });
});

describe("compile", () => {
  const a = src("a.md", page({ id: "a" }, "Alpha.\n"));
  it("throws on duplicate ids, naming both files", () => {
    expect(() => compile([a, src("b.md", page({ id: "a" }))], null, "2026-10-30")).toThrow(/b\.md.*a\.md/);
  });
  it("sets changed to today and no previous for a new page", () => {
    const [p] = compile([a], null, "2026-10-30").pages;
    expect(p).toMatchObject({ id: "a", changed: "2026-10-30", previous: null, markdown: "Alpha.\n" });
    expect(p!.html).toContain("<p>Alpha.</p>");
    expect(p!.hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("keeps changed and previous when the input is unchanged", () => {
    const first = compile([a], null, "2026-10-01");
    const again = compile([a], first, "2026-10-30");
    expect(again).toEqual(first);
  });
  it("sets changed to today and previous to the old html and date when edited", () => {
    const first = compile([a], null, "2026-10-01");
    const edited = compile([src("a.md", page({ id: "a" }, "Alpha two.\n"))], first, "2026-10-30");
    expect(edited.pages[0]).toMatchObject({ changed: "2026-10-30", previous: { html: first.pages[0]!.html, changed: "2026-10-01" } });
  });
  it("treats a header change as an edit", () => {
    const first = compile([a], null, "2026-10-01");
    const edited = compile([src("a.md", page({ id: "a", title: "Renamed" }, "Alpha.\n"))], first, "2026-10-30");
    expect(edited.pages[0]!.changed).toBe("2026-10-30");
  });
  it("gives a CRLF copy of a page the same hash and text", () => {
    const lf = compile([a], null, "2026-10-01").pages[0]!;
    const crlf = compile([src("a.md", page({ id: "a" }, "Alpha.\n").replace(/\n/g, "\r\n"))], null, "2026-10-01").pages[0]!;
    expect(crlf.hash).toBe(lf.hash);
    expect(crlf.markdown).toBe(lf.markdown);
  });
  it("drops a page missing from the input", () => {
    const first = compile([a, src("b.md", page({ id: "b" }))], null, "2026-10-01");
    expect(compile([a], first, "2026-10-30").pages.map((p) => p.id)).toEqual(["a"]);
  });
  it("escapes raw HTML in Markdown", () => {
    const [p] = compile([src("x.md", page({ id: "x" }, "Hi <script>alert(1)</script>\n\n<div>block</div>\n"))], null, "2026-10-30").pages;
    expect(p!.html).toContain("&lt;script&gt;");
    expect(p!.html).not.toContain("<script>");
    expect(p!.html).not.toContain("<div>");
  });
});

describe("links and images", () => {
  const html = (body: string) => compile([src("l.md", page({ id: "l" }, body))], null, "2026-10-30").pages[0]!.html;
  it("turns an unsafe link into plain text", () => {
    const h = html("[x](javascript:alert(1)) and [y](JaVaScRiPt:alert(1)) and [z](data:text/html,hi) and [w](//evil.example)\n");
    expect(h).not.toMatch(/<a /i);
    expect(h).not.toContain("href");
    expect(h).toContain("x and y and z and w");
  });
  it.each([
    "javascript&#58;alert(1)",
    "&#106;avascript:alert(1)",
    "&#x6a;avascript:alert(1)",
    "java&#x09;script:alert(1)",
    "java&Tab;script:alert(1)",
    "java&NewLine;script:alert(1)",
    "javascript&colon;alert(1)",
    "javascript&#0000058alert(1)",
    "\\\\evil.example",
    "/\\evil.example",
    "&#47;/evil.example",
    "&bogus;x",
    ":nothing",
  ])("turns the encoded or odd target %s into plain text", (target) => {
    const h = html(`[x](<${target}>)\n![y](<${target}>)\n`);
    expect(h).not.toMatch(/<a |<img|href|src=/i);
    expect(h).toContain("x");
  });
  it("turns an unsafe image into plain text", () => {
    const h = html("![alt text](javascript:alert(1))\n");
    expect(h).not.toContain("<img");
    expect(h).toContain("alt text");
  });
  it("turns an image aimed at a manual: or topic: target into plain alt text", () => {
    const h = html("![x](manual:foo) ![y](topic:bar)\n");
    expect(h).not.toMatch(/<img|src=|<a /i);
    expect(h).toContain("x y");
  });
  it("wraps a table and a code block in a labelled, focusable scroll box, keeping the table", () => {
    const h = html("| A | B |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```\n");
    expect(h).toContain('<div class="gcpe-table-scroll" role="region" aria-label="Table 1 — scrollable" tabindex="0"><table>');
    expect(h).toContain('aria-label="Code 1 — scrollable" tabindex="0"><pre>');
  });
  it("keeps http, https, mailto and relative links", () => {
    for (const t of ["http://a.example/", "https://a.example/", "mailto:a@b.example", "/government-terms", "#top", "other-page"]) {
      expect(html(`[go](${t})\n`)).toContain(`<a href="${t}">go</a>`);
    }
  });
});

describe("manual: and topic: links", () => {
  const pages = (body: string) => [
    src("docs/manuals/core-admin/terms.md", page({ id: "terms", manual: "core-admin" }, body)),
    src("docs/manuals/nrms-editor/release.md", page({ id: "release", manual: "nrms-editor" })),
    src("docs/manuals/topic/signing-in.md", page({ id: "signing-in", manual: "topic" })),
  ];
  const html = (body: string) => compile(pages(body), null, "2026-10-30").pages.find((p) => p.id === "terms")!.html;
  it("turns manual:<page id> into that page's Hub route, under /hub/", () => {
    expect(html("[go](manual:release)\n")).toContain('<a href="/hub/help/manuals/nrms-editor/release">go</a>');
  });
  it("turns manual:<manual id> into the manual's contents route", () => {
    expect(html("[go](manual:nrms-editor)\n")).toContain('<a href="/hub/help/manuals/nrms-editor">go</a>');
  });
  it("turns topic:<id> into the topic route", () => {
    expect(html("[go](topic:signing-in)\n")).toContain('<a href="/hub/help/manuals/topic/signing-in">go</a>');
  });
  it("fails, naming the file, for a target that does not exist or is the wrong kind", () => {
    expect(() => html("[go](manual:nope)\n")).toThrow(/terms\.md.*manual:nope/);
    expect(() => html("[go](topic:nope)\n")).toThrow(/terms\.md.*topic:nope/);
    expect(() => html("[go](topic:release)\n")).toThrow(/terms\.md.*topic:release/);
    expect(() => html("[go](manual:signing-in)\n")).toThrow(/terms\.md.*manual:signing-in/);
  });
  it("fails for a malformed target", () => {
    expect(() => html("[go](manual:Bad_Id)\n")).toThrow(/terms\.md/);
  });
});

describe("plainLanguageProblems", () => {
  it("accepts plain text and a role id on the Who line", () => {
    expect(plainLanguageProblems("**Who this is for:** Core administrators (Core.Admin).\n\nOpen the Calendar.\n")).toEqual([]);
  });
  it.each([
    ["/api/users", "an API path"],
    ["Ask for NRMS.Editor access.", "a role id"],
    ["The database is full.", "database"],
    ["It returns JSON.", "JSON"],
    ["Run the SQL.", "SQL"],
    ["Value is null.", "null"],
    ["An endpoint, a payload, a boolean.", "endpoint"],
  ])("flags %s", (body) => {
    expect(plainLanguageProblems(body).length).toBeGreaterThan(0);
  });
  it("flags a heading repeated as the first sentence, case-insensitively", () => {
    expect(plainLanguageProblems("## Government terms\n\nGovernment terms are the names of governments.\n").length).toBe(1);
    expect(plainLanguageProblems("## Government terms\n\nPick the term you need.\n")).toEqual([]);
  });
});

describe("the retired running notes", () => {
  it("stay retired", async () => {
    const { existsSync } = await import("node:fs");
    const notes = new URL("../docs/manuals/running-notes.md", import.meta.url);
    expect(
      existsSync(notes),
      "docs/manuals/running-notes.md was retired: staff notes go in a manual page, operations notes in docs/deploy/ and developer notes in docs/developer-notes.md. See docs/manuals/README.md.",
    ).toBe(false);
  });
});
