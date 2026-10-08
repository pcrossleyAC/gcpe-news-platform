import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";

const SIZES = { letter: [612, 792], legal: [1008, 612] };
const failures = [];
const pass = [];
const expect = (ok, what) => (ok ? pass : failures).push(what);

async function checkPdf(file, size) {
  const bytes = readFileSync(file);
  const pdf = await PDFDocument.load(bytes);
  const n = pdf.getPageCount();
  const { width, height } = pdf.getPage(0).getSize();
  expect(Math.round(width) === SIZES[size][0] && Math.round(height) === SIZES[size][1], `${file}: page size ${Math.round(width)}×${Math.round(height)}`);
  const text = (p) => execFileSync("pdftotext", ["-f", String(p), "-l", String(p), "-layout", file, "-"], { encoding: "utf8" });
  for (let p = 1; p <= n; p++) expect(text(p).includes(`Page ${p} of ${n}`), `${file}: "Page ${p} of ${n}" on page ${p}`);
  if (n > 1) {
    expect(text(1).includes("DRAFT ONLY - NOT FOR CIRCULATION"), `${file}: page-1 header`);
    expect(!text(2).includes("DRAFT ONLY - NOT FOR CIRCULATION") && text(2).includes("DRAFT AND CONFIDENTIAL"), `${file}: later-page header differs`);
  }
  if (file.includes("look-ahead-60")) {
    // Forced page breaks: every one of the 60 day headings is the first line under its page's
    // running header. A day too long for one page continues on the next under its repeated
    // table header, so "every page starts with a day" would be the wrong test.
    const at = [];
    for (let p = 1; p <= n; p++) {
      const lines = text(p).split("\n").map((l) => l.trim()).filter(Boolean).slice(1);
      lines.forEach((l, i) => /^[A-Z][a-z]+day, [A-Z][a-z]+ \d+, 2026$/.test(l) && at.push(i));
    }
    const top = at.filter((i) => i === 0).length;
    expect(at.length === 60 && top === 60, `${file}: a forced break before each day (${top} of ${at.length} day headings start a page)`);
  }
}

async function checkDocx(file, size) {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const doc = await zip.file("word/document.xml").async("string");
  // A part that isn't well-formed XML makes Word refuse or "repair" the file, whatever the
  // regexes below find in it.
  const parts = Object.keys(zip.files).filter((n) => /\.(xml|rels)$/.test(n));
  const malformed = [];
  for (const n of parts) {
    try {
      new JSDOM(await zip.file(n).async("string"), { contentType: "application/xml" });
    } catch {
      malformed.push(n);
    }
  }
  expect(malformed.length === 0, `${file}: every XML part is well-formed${malformed.length ? ` (not: ${malformed.join(", ")})` : ""}`);
  const [w, h] = size === "letter" ? [12240, 15840] : [20160, 12240];
  expect(new RegExp(`<w:pgSz[^>]*w:w="${w}"[^>]*w:h="${h}"`).test(doc), `${file}: page size ${w}×${h} twips`);
  if (size === "legal") expect(/w:orient="landscape"/.test(doc), `${file}: landscape`);
  const footers = await Promise.all(Object.keys(zip.files).filter((n) => /^word\/footer\d*\.xml$/.test(n)).map((n) => zip.file(n).async("string")));
  expect(footers.some((f) => /<w:fldSimple [^>]*w:instr=" PAGE "/.test(f) && /<w:fldSimple [^>]*w:instr=" NUMPAGES "/.test(f)), `${file}: "Page X of Y" fields in the footer`);
  expect(/<w:titlePg\/>/.test(doc) && /w:type="first"/.test(doc), `${file}: a different first-page header`);
  expect(/w:fill="558ABD"|w:fill="558abd"|w:fill="384C70"|w:fill="384c70"/.test(doc), `${file}: coloured header cells`);
  expect(/w:fill="F2F2F2"|w:fill="f2f2f2"/.test(doc), `${file}: alternating row shading`);
  if (file.includes("look-ahead-60")) expect(/<w:br w:type="page"\/>|<w:pageBreakBefore/.test(doc), `${file}: forced page breaks`);
}

const dir = process.argv[2];
for (const f of readdirSync(dir)) {
  const m = /^(.+)\.(letter|legal)\.(.+)\.(pdf|docx)$/.exec(f);
  if (!m) continue;
  if (m[4] === "pdf") await checkPdf(join(dir, f), m[2]);
  else await checkDocx(join(dir, f), m[2]);
}
console.log(JSON.stringify({ pass, failures }, null, 2));
process.exit(failures.length ? 1 : 0);
