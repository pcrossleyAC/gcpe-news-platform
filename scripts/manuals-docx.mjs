// "Download as Word": one .docx per staff manual, built at build time from the same compiled pages
// Hub Help shows (apps/staff-web/src/manuals/manuals.generated.json). Nothing here ships at runtime.
// The Markdown of each page is read with marked's lexer and written out as Word headings, lists,
// tables and text. Links to other pages (manual:/topic:) become cross-references to the section
// inlined in the same file; web links are written out as plain-text URLs, since a Hub address or a
// clickable-only link is no use on paper.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  AlignmentType, BorderStyle, Bookmark, Document, Footer, HeadingLevel, ImageRun, InternalHyperlink, LevelFormat, Packer,
  PageNumber, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from "docx";
import { Lexer } from "marked";
import { MANUAL_IDS, safeTarget } from "./manuals-lib.mjs";

const root = join(import.meta.dirname, "..");
export const LOGO_PATH = join(root, "apps/public-site/assets/legacy/Content/Images/SocialMedia/32x32-bc-logo.png");
const DATA_PATH = join(root, "apps/staff-web/src/manuals/manuals.generated.json");
const CATALOG_PATH = join(root, "apps/staff-web/src/manuals/catalog.ts");

const FONT = "BC Sans";
const MONO = "Consolas";
const BC_BLUE = "013366";
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-07-21" -> "July 21, 2026" (the same form as the Hub's formatLongDate). */
const longDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : iso;
};

/** The catalog is TypeScript that the Hub also uses; bundle it here so titles and role lines have one source. */
async function loadCatalog() {
  const out = await build({ entryPoints: [CATALOG_PATH], bundle: true, write: false, format: "esm", platform: "node", logLevel: "error" });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
  return mod.MANUALS;
}

const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const INTERNAL = /^(manual|topic):([a-z0-9]+(?:-[a-z0-9]+)*)$/i;

/** Writes one manual's pages; `anchors` maps a page/topic id to its bookmark name (only sections that are in this file). */
class Writer {
  constructor(anchors) {
    this.anchors = anchors;
    this.lists = 0;
  }

  inline(tokens, style = {}) {
    const runs = [];
    const run = (text, extra = {}) => runs.push(new TextRun({ text, ...style, ...extra }));
    for (const t of tokens ?? []) {
      switch (t.type) {
        case "text":
        case "escape":
          if (t.tokens?.length) runs.push(...this.inline(t.tokens, style));
          else run(decode(t.text));
          break;
        case "strong":
          runs.push(...this.inline(t.tokens, { ...style, bold: true }));
          break;
        case "em":
          runs.push(...this.inline(t.tokens, { ...style, italics: true }));
          break;
        case "del":
          runs.push(...this.inline(t.tokens, { ...style, strike: true }));
          break;
        case "codespan":
          run(decode(t.text), { font: MONO });
          break;
        case "br":
          run("", { break: 1 });
          break;
        case "image":
          // A picture cannot be placed from a link; keep what it says.
          if (t.text) run(decode(t.text), { italics: true });
          break;
        case "html":
          run(t.text); // raw HTML in a page is shown as text, as in Help
          break;
        case "link":
          runs.push(...this.link(t, style));
          break;
        default:
          if (t.tokens) runs.push(...this.inline(t.tokens, style));
          else if (t.text) run(decode(t.text));
      }
    }
    return runs;
  }

  link(t, style) {
    const label = this.inline(t.tokens, style);
    const href = decode(t.href).trim();
    const internal = INTERNAL.exec(href);
    if (internal) {
      const anchor = this.anchors.get(internal[2]);
      // A page or topic in this file: a cross-reference. Anything else (another manual, or a manual's list) stays plain text.
      return anchor && !(internal[1].toLowerCase() === "manual" && MANUAL_IDS.includes(internal[2]) && !this.anchors.has(internal[2]))
        ? [new InternalHyperlink({ anchor, children: label.map((r) => r) })]
        : label;
    }
    if (!safeTarget(t.href) || !/^(https?|mailto):/i.test(href)) return label; // relative or unsafe: text only
    const shown = href.replace(/^mailto:/i, "");
    const plain = t.tokens.map((x) => x.text ?? "").join("");
    if (decode(plain).trim() === href || decode(plain).trim() === shown) return label;
    return [...label, new TextRun({ text: ` (${shown})`, ...style })];
  }

  /** A whole page body: its shallowest heading sits one level under the page title, whatever depth the author used. */
  page(tokens, shift) {
    this.top = Math.min(...tokens.filter((t) => t.type === "heading").map((t) => t.depth), 7);
    return this.blocks(tokens, shift);
  }

  /** Markdown block tokens -> docx paragraphs and tables. `shift` pushes page headings down under the page title. */
  blocks(tokens, shift, listLevel = -1, listRef = null) {
    const out = [];
    for (const t of tokens) {
      switch (t.type) {
        case "heading":
          out.push(new Paragraph({ heading: HEADINGS[Math.min(t.depth - this.top + shift, 5)], children: this.inline(t.tokens) }));
          break;
        case "paragraph":
          out.push(new Paragraph({ children: this.inline(t.tokens), spacing: { after: 120 } }));
          break;
        case "text": // a list item's own text
          out.push(this.listParagraph(this.inline(t.tokens ?? [{ type: "text", text: t.text }]), listLevel, listRef));
          break;
        case "list": {
          const ref = t.ordered ? "ordered" : "bullet";
          const instance = t.ordered ? ++this.lists : 0;
          const level = Math.min(listLevel + 1, 3);
          for (const item of t.items) {
            let first = true;
            for (const child of item.tokens) {
              if (child.type === "text" && first) {
                out.push(this.listParagraph(this.inline(child.tokens ?? [child]), level, { ref, instance }));
                first = false;
              } else if (child.type === "list") {
                out.push(...this.blocks([child], shift, level, { ref, instance }));
              } else if (child.type === "space") {
                continue;
              } else {
                const made = this.blocks([child], shift, level, { ref, instance });
                if (first && made[0] instanceof Paragraph) first = false;
                out.push(...made);
              }
            }
          }
          break;
        }
        case "table":
          out.push(this.table(t));
          out.push(new Paragraph({ children: [] }));
          break;
        case "code":
          for (const line of t.text.split("\n"))
            out.push(new Paragraph({ children: [new TextRun({ text: line, font: MONO, size: 20 })], shading: { fill: "F2F2F2" }, indent: { left: 240 } }));
          out.push(new Paragraph({ children: [] }));
          break;
        case "blockquote":
          for (const p of this.blocks(t.tokens, shift)) out.push(p);
          break;
        case "hr":
          out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } }, children: [] }));
          break;
        case "html":
          out.push(new Paragraph({ children: [new TextRun({ text: t.text.trim() })] }));
          break;
        default:
          break; // space, def
      }
    }
    return out;
  }

  listParagraph(children, level, list) {
    const base = list ?? { ref: "bullet", instance: 0 };
    return new Paragraph({
      children,
      ...(base.ref === "bullet" ? { bullet: { level: Math.max(level, 0) } } : { numbering: { reference: "ordered", level: Math.max(level, 0), instance: base.instance } }),
    });
  }

  table(t) {
    const cell = (c, header) =>
      new TableCell({ children: [new Paragraph({ children: this.inline(c.tokens, header ? { bold: true } : {}) })], shading: header ? { fill: "E8EEF5" } : undefined });
    const rows = [new TableRow({ tableHeader: true, children: t.header.map((c) => cell(c, true)) }), ...t.rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false)) }))];
    return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
  }
}

const bookmarked = (name, heading, text) => new Paragraph({ heading, children: [new Bookmark({ id: name, children: [new TextRun({ text })] })] });

/**
 * One manual as a Word file: a cover (logo, title, "For:" line, software version), then the manual's
 * pages in order, then "Topics" with each topic page they link or list, inlined once.
 * data: ManualsData; opts.versionDate is used only when the manual has no pages to take a date from.
 */
export async function buildManualDocx(data, manualId, opts) {
  const manual = (await loadCatalog()).find((m) => m.id === manualId);
  if (!manual) throw new Error(`unknown manual "${manualId}"`);
  const pages = data.pages.filter((p) => p.manual === manualId);
  const topicById = new Map(data.pages.filter((p) => p.manual === "topic").map((p) => [p.id, p]));

  // Topics this manual uses: those a page lists in its header, then any it links to, each once.
  const topicIds = [];
  const addTopic = (id) => topicById.has(id) && !topicIds.includes(id) && topicIds.push(id);
  for (const p of pages) {
    p.topics.forEach(addTopic);
    for (const m of p.markdown.matchAll(/\]\(\s*topic:([a-z0-9]+(?:-[a-z0-9]+)*)\s*\)/gi)) addTopic(m[1]);
  }
  const topics = topicIds.map((id) => topicById.get(id)).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  const anchors = new Map();
  [...pages, ...topics].forEach((p, i) => anchors.set(p.id, `section_${i + 1}`));
  const writer = new Writer(anchors);

  const newest = [...pages, ...topics].map((p) => p.changed).sort().pop() ?? opts.versionDate;
  const logo = readFileSync(opts.logoPath);

  const cover = [
    new Paragraph({ children: [new ImageRun({ type: "png", data: logo, transformation: { width: 48, height: 48 }, altText: { name: "BC logo", title: "BC logo", description: "Government of British Columbia logo" } })], spacing: { after: 240 } }),
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: manual.title })] }),
    new Paragraph({ children: [new TextRun({ text: `For: ${manual.forRoles}`, size: 28 })], spacing: { after: 120 } }),
    new Paragraph({ children: [new TextRun({ text: `Software version of ${longDate(newest)}`, size: 24 })], spacing: { after: 480 } }),
  ];

  const body = [];
  const section = (p, shift, first) => {
    body.push(new Paragraph({ pageBreakBefore: first, heading: HEADINGS[Math.min(shift, 5)], children: [new Bookmark({ id: anchors.get(p.id), children: [new TextRun({ text: p.title })] })] }));
    body.push(...writer.page(new Lexer().lex(p.markdown), shift + 1));
  };
  if (pages.length === 0) body.push(new Paragraph({ children: [new TextRun({ text: "This manual has no pages yet." })] }));
  pages.forEach((p, i) => section(p, 0, i === 0));
  if (topics.length > 0) {
    body.push(new Paragraph({ pageBreakBefore: true, heading: HEADINGS[0], children: [new TextRun({ text: "Topics" })] }));
    topics.forEach((p) => section(p, 1, false));
  }

  const doc = new Document({
    creator: "GCPE News",
    title: manual.title,
    description: `Software version of ${longDate(newest)}`,
    styles: {
      default: {
        document: { run: { font: FONT, size: 22 }, paragraph: { spacing: { line: 300 } } },
        title: { run: { font: FONT, size: 56, bold: true, color: BC_BLUE }, paragraph: { spacing: { after: 200 } } },
        heading1: { run: { font: FONT, size: 36, bold: true, color: BC_BLUE }, paragraph: { spacing: { before: 240, after: 160 } } },
        heading2: { run: { font: FONT, size: 30, bold: true, color: BC_BLUE }, paragraph: { spacing: { before: 200, after: 120 } } },
        heading3: { run: { font: FONT, size: 26, bold: true, color: BC_BLUE }, paragraph: { spacing: { before: 160, after: 100 } } },
        heading4: { run: { font: FONT, size: 24, bold: true }, paragraph: { spacing: { before: 120, after: 80 } } },
        heading5: { run: { font: FONT, size: 22, bold: true } },
        heading6: { run: { font: FONT, size: 22, bold: true, italics: true } },
      },
    },
    numbering: {
      config: [
        {
          reference: "bullet",
          levels: [0, 1, 2, 3].map((level) => ({ level, format: LevelFormat.BULLET, text: level % 2 ? "–" : "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540 + level * 360, hanging: 270 } } } })),
        },
        {
          reference: "ordered",
          levels: [0, 1, 2, 3].map((level) => ({ level, format: level % 2 ? LevelFormat.LOWER_LETTER : LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540 + level * 360, hanging: 360 } } } })),
        },
      ],
    },
    sections: [
      {
        footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ["Page ", PageNumber.CURRENT] })] })] }) },
        children: [...cover, ...body],
      },
    ],
  });
  return stabilise(Buffer.from(await Packer.toBuffer(doc)), newest);
}

/** Same input, same bytes: the package carries the build time, and the docx library's running counters (picture and bookmark ids) span builds. Pin the dates and renumber the ids from 1. */
function stabilise(buffer, isoDate) {
  const stamp = `${isoDate}T00:00:00Z`;
  const files = unzipSync(new Uint8Array(buffer));
  const out = {};
  for (const name of Object.keys(files).sort()) {
    let bytes = files[name];
    if (name === "docProps/core.xml") {
      bytes = strToU8(strFromU8(bytes).replace(/(<dcterms:(?:created|modified)[^>]*>)[^<]*/g, `$1${stamp}`));
    }
    if (name === "word/document.xml") {
      const ids = new Map();
      const next = (old) => ids.get(old) ?? (ids.set(old, ids.size + 1), ids.size);
      let pics = 0;
      bytes = strToU8(
        strFromU8(bytes)
          .replace(/<wp:docPr id="\d+"/g, () => `<wp:docPr id="${++pics}"`)
          .replace(/(<w:bookmarkStart [^>]*w:id=")(\d+)"/g, (_, a, id) => `${a}${next(id)}"`)
          .replace(/(<w:bookmarkEnd w:id=")(\d+)"/g, (_, a, id) => `${a}${next(id)}"`),
      );
    }
    out[name] = [bytes, { mtime: new Date(`${isoDate}T00:00:00Z`), level: 6 }];
  }
  return Buffer.from(zipSync(out));
}

/** Writes <outDir>/<manualId>.docx for all 11 manuals, from the compiled pages (or `data`). Returns the file names written. */
export async function writeAllDocx(outDir, data = JSON.parse(readFileSync(DATA_PATH, "utf8"))) {
  mkdirSync(outDir, { recursive: true });
  const versionDate = data.pages.map((p) => p.changed).sort().pop() ?? "1970-01-01";
  const written = [];
  for (const id of MANUAL_IDS) {
    const file = `${id}.docx`;
    writeFileSync(join(outDir, file), await buildManualDocx(data, id, { logoPath: LOGO_PATH, versionDate }));
    written.push(file);
  }
  return written;
}
