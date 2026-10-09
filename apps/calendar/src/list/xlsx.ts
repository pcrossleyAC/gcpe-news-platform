import { crc32, deflateRawSync } from "node:zlib";

export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** ARGB, such as FF8B0000. */
  color?: string;
}
export type CellStyle = "cell" | "boldCell" | "header" | "banner" | "heading" | "notice";
export interface SheetCell {
  runs: Run[];
  style: CellStyle;
  /** Columns this cell covers, merged; 1 when absent. */
  span?: number;
}
export interface SheetRow {
  cells: SheetCell[];
  /** Points; Excel doesn't grow a merged cell's row to fit. */
  height?: number;
}
export interface Sheet {
  name: string;
  widths: number[];
  rows: SheetRow[];
}

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const STYLE_INDEX: Record<CellStyle, number> = { cell: 1, boldCell: 2, header: 3, banner: 4, heading: 5, notice: 6 };

/** What Excel, or a CSV re-save, would read as a formula (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;
/** A cell that starts like a formula gets a leading apostrophe, so it stays text wherever it goes. */
export const inert = (text: string) => (FORMULA_START.test(text) ? `'${text}` : text);
/** XML 1.0 can't carry most control characters, U+FFFE, U+FFFF or a lone surrogate. */
const xmlSafe = (s: string) =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
/** Excel reads "_xHHHH_" in a string as an escaped character; a literal one keeps its underscore as "_x005F_". */
const cellText = (s: string) => escape(s.replace(/_(?=x[0-9A-Fa-f]{4}_)/g, "_x005F_"));
/** The most characters an Excel cell holds; a longer one makes Excel repair the file. */
const CELL_MAX_CHARS = 32_767;
const colName = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** The runs cut to Excel's cell limit, never between the halves of a surrogate pair. */
function clamp(runs: Run[]): Run[] {
  let room = CELL_MAX_CHARS;
  return runs.map((r) => {
    let text = r.text.slice(0, room);
    if (text.length < r.text.length && /[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    room -= text.length;
    return { ...r, text };
  });
}

function runsXml(runs: Run[]): string {
  // Clean first, then make inert: a control character can't hide a leading "=".
  const clean = runs.map((r) => ({ ...r, text: xmlSafe(r.text) }));
  const first = clean.findIndex((r) => r.text.length > 0);
  if (first >= 0) clean[first] = { ...clean[first]!, text: inert(clean[first]!.text) };
  const cut = clamp(clean);
  if (cut.every((r) => !r.bold && !r.italic && !r.color)) return `<is><t xml:space="preserve">${cellText(cut.map((r) => r.text).join(""))}</t></is>`;
  const rPr = (r: Run) => `<rPr>${r.bold ? "<b/>" : ""}${r.italic ? "<i/>" : ""}${r.color ? `<color rgb="${escape(r.color)}"/>` : ""}<sz val="10"/><rFont val="Calibri"/></rPr>`;
  return `<is>${cut.map((r) => `<r>${rPr(r)}<t xml:space="preserve">${cellText(r.text)}</t></r>`).join("")}</is>`;
}

function sheetXml(sheet: Sheet): string {
  const merges: string[] = [];
  const rows = sheet.rows
    .map((row, r) => {
      let col = 0;
      const cells = row.cells
        .map((c) => {
          const ref = `${colName(col)}${r + 1}`;
          const span = c.span ?? 1;
          if (span > 1) merges.push(`${ref}:${colName(col + span - 1)}${r + 1}`);
          col += span;
          return `<c r="${ref}" s="${STYLE_INDEX[c.style]}" t="inlineStr">${runsXml(c.runs)}</c>`;
        })
        .join("");
      const height = row.height ? ` ht="${row.height}" customHeight="1"` : "";
      return `<row r="${r + 1}"${height}>${cells}</row>`;
    })
    .join("");
  const cols = sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const mergeXml = merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
  return `${HEAD}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><cols>${cols}</cols><sheetData>${rows}</sheetData>${mergeXml}</worksheet>`;
}

const align = '<alignment vertical="top" wrapText="1"/>';
const STYLES = `${HEAD}<styleSheet xmlns="${MAIN_NS}">
<fonts count="4"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FFFF0000"/><name val="Calibri"/></font><font><b/><sz val="10"/><color rgb="FFFF0000"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">${align}</xf><xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">${align}</xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${align}</xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">${align}</xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** A zip with deflated entries, a fixed 1980-01-01 timestamp and UTF-8 names. */
function zip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const body = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/** One sheet as an .xlsx package: inline strings only, so no cell can be a formula. */
export function xlsxOf(sheet: Sheet): Buffer {
  const text = (name: string, xml: string) => ({ name, data: Buffer.from(xml, "utf8") });
  return zip([
    text("[Content_Types].xml", `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    text("_rels/.rels", `${HEAD}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    text("xl/workbook.xml", `${HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="${escape(sheet.name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    text("xl/_rels/workbook.xml.rels", `${HEAD}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`),
    text("xl/styles.xml", STYLES),
    text("xl/worksheets/sheet1.xml", sheetXml(sheet)),
  ]);
}
