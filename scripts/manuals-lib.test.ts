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
  it("turns an unsafe image into plain text", () => {
    const h = html("![alt text](javascript:alert(1))\n");
    expect(h).not.toContain("<img");
    expect(h).toContain("alt text");
  });
  it("keeps http, https, mailto, manual:, topic: and relative links", () => {
    for (const t of ["http://a.example/", "https://a.example/", "mailto:a@b.example", "manual:core-admin", "topic:signing-in", "/government-terms", "#top", "other-page"]) {
      expect(html(`[go](${t})\n`)).toContain(`<a href="${t}">go</a>`);
    }
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
