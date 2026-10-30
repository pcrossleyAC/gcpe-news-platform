import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { MANUAL_IDS, compile } from "./manuals-lib.mjs";
import { LOGO_PATH, buildManualDocx, writeAllDocx } from "./manuals-docx.mjs";

const page = (id: string, manual: string, title: string, order: number, topics: string[], body: string) =>
  ({ path: `docs/manuals/x/${id}.md`, text: `---\nid: ${id}\ntitle: ${title}\nmanual: ${manual}\norder: ${order}\nroutes: []\nscreens: []\ntopics: [${topics.join(", ")}]\n---\n${body}` });

const BODY_ONE = [
  "Intro with **bold** and a [Fund site](https://example.org/fund?a=1&b=2) link.",
  "",
  "## Steps",
  "",
  "1. First step",
  "2. Second step",
  "   - nested bullet",
  "",
  "- Plain bullet",
  "",
  "| Name | Role |",
  "| --- | --- |",
  "| Ada | Editor |",
  "",
  "See [the glossary](topic:glossary) and [page two](manual:two), [bad](javascript:alert(1)), [mail](mailto:a@b.ca).",
  "",
].join("\n");

const data = compile(
  [
    page("one", "core-admin", "First page", 1, ["glossary"], BODY_ONE),
    page("two", "core-admin", "Second page", 2, ["glossary"], "Second body. See [glossary](topic:glossary).\n"),
    page("glossary", "topic", "Glossary topic", 1, [], "A term means a thing.\n"),
    page("other", "nrms-editor", "Other manual page", 1, [], "Not in the core manual.\n"),
  ],
  null,
  "2026-10-30",
);
// Give the pages known dates so "newest changed" is observable.
data.pages.find((p) => p.id === "one")!.changed = "2026-03-02";
data.pages.find((p) => p.id === "two")!.changed = "2026-05-09";
data.pages.find((p) => p.id === "glossary")!.changed = "2026-07-21";
data.pages.find((p) => p.id === "other")!.changed = "2026-12-31";

const opts = { logoPath: LOGO_PATH, versionDate: "2026-10-30" };
const xmlOf = async (id: string) => {
  const files = unzipSync(new Uint8Array(await buildManualDocx(data, id, opts)));
  return { files, xml: strFromU8(files["word/document.xml"]!) };
};
const textOf = (xml: string) => xml.replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
const count = (s: string, sub: string) => s.split(sub).length - 1;

describe("buildManualDocx", () => {
  it("holds the title, the For line, the version date, every page title, and each topic title once", async () => {
    const { xml } = await xmlOf("core-admin");
    expect(xml).toContain("Core administrator manual");
    expect(xml).toContain("For: Core administrators");
    expect(xml).toContain("Software version of July 21, 2026");
    expect(xml).toContain("First page");
    expect(xml).toContain("Second page");
    expect(count(xml, "Glossary topic")).toBe(1);
    expect(xml).toContain(">Topics<");
    expect(xml).not.toContain("Other manual page");
    expect(xml.indexOf("First page")).toBeLessThan(xml.indexOf("Second page"));
    expect(xml.indexOf("Second page")).toBeLessThan(xml.indexOf("Glossary topic"));
  });

  it("keeps headings, lists, tables and links as Word structures and plain-text URLs", async () => {
    const { xml, files } = await xmlOf("core-admin");
    expect(xml).toMatch(/w:pStyle w:val="Heading1"/);
    expect(xml).toMatch(/w:pStyle w:val="Heading2"/);
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("Ada");
    expect(xml).toContain("<w:numPr>");
    expect(xml).toContain("First step");
    expect(xml).toContain("nested bullet");
    // External link: the visible text is followed by the plain URL, not a clickable-only target.
    const text = textOf(xml);
    expect(text).toContain("Fund site (https://example.org/fund?a=1&b=2)");
    expect(text).toContain("mail (a@b.ca)");
    // An unsafe link shows only its text, and no Hub URL appears anywhere.
    expect(xml).toContain("bad");
    expect(xml).not.toContain("javascript:");
    expect(xml).not.toContain("/hub/");
    expect(xml).not.toContain("topic:");
    // The logo is in the package.
    expect(Object.keys(files).some((f) => f.startsWith("word/media/"))).toBe(true);
  });

  it("turns manual: and topic: links into cross-references to the inlined sections", async () => {
    const { xml } = await xmlOf("core-admin");
    expect(xml).toMatch(/<w:hyperlink [^>]*w:anchor="section_\d+"/);
    expect(xml).toContain("<w:bookmarkStart");
  });

  it("builds an empty manual with a cover and a note", async () => {
    const { xml } = await xmlOf("calendar-readonly");
    expect(xml).toContain("Calendar read-only manual");
    expect(xml).toContain("This manual has no pages yet.");
    expect(xml).toContain("Software version of October 30, 2026");
  });

  it("is the same bytes every time for the same input", async () => {
    const a = await buildManualDocx(data, "core-admin", opts);
    const b = await buildManualDocx(data, "core-admin", opts);
    expect(a.equals(b)).toBe(true);
  });

  it("rejects an unknown manual", async () => {
    await expect(buildManualDocx(data, "nope", opts)).rejects.toThrow(/unknown manual/);
  });
});

describe("writeAllDocx", () => {
  let dir = "";
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it("writes one file per manual", async () => {
    dir = await mkdtemp(join(tmpdir(), "gcpe-docx-"));
    await writeAllDocx(dir, data);
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(MANUAL_IDS.map((id) => `${id}.docx`).sort());
    expect(names).toHaveLength(11);
  });
});
