import { describe, expect, it } from "vitest";
import { checkWellFormed, readXlsx } from "../../test/xlsx-read";
import { inert, xlsxOf, type SheetCell } from "./xlsx";

const cell = (text: string): SheetCell => ({ runs: [{ text }], style: "cell" });

describe("the .xlsx writer", () => {
  it("writes a package Excel can open: content types, workbook, styles and one sheet", () => {
    const { files, cells } = readXlsx(xlsxOf({ name: "Activities", widths: [10, 20], rows: [{ cells: [cell("Sample"), cell("Two")] }] }));
    expect([...files.keys()].sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
    expect(cells.get("A1")).toBe("Sample");
    expect(cells.get("B1")).toBe("Two");
    expect(files.get("xl/worksheets/sheet1.xml")).toContain('t="inlineStr"');
  });

  it("cells that start like a formula are inert, even behind a control character", () => {
    for (const t of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1"]) expect(inert(t)).toBe(`'${t}`);
    for (const t of ["Sample", " =1", "", "a=b"]) expect(inert(t)).toBe(t);
    const { cells } = readXlsx(xlsxOf({ name: "S", widths: [10], rows: [
      { cells: [cell("=HYPERLINK(\"http://example.test\")")] },
      { cells: [cell("\u0001=1+1")] },
      { cells: [{ runs: [{ text: "" }, { text: "@cmd", bold: true }], style: "cell" }] },
    ] }));
    expect(cells.get("A1")).toBe("'=HYPERLINK(\"http://example.test\")");
    expect(cells.get("A2")).toBe("'=1+1");
    expect(cells.get("A3")).toBe("'@cmd");
  });

  it("escapes XML, drops characters XML can't carry, keeps line breaks, and merges spans", () => {
    const { files, cells } = readXlsx(xlsxOf({ name: "S", widths: [10, 10, 10], rows: [
      { cells: [{ runs: [{ text: "a <b> & \"c\"\u0007\nd\uD800" }], style: "cell", span: 2 }, cell("e")] },
    ] }));
    expect(cells.get("A1")).toBe("a <b> & \"c\"\nd");
    expect(cells.get("C1")).toBe("e");
    expect(files.get("xl/worksheets/sheet1.xml")).toContain('<mergeCell ref="A1:B1"/>');
  });

  it("writes a carriage return as &#13;, so an XML reader doesn't turn it into a line feed", () => {
    const { files, cells } = readXlsx(xlsxOf({ name: "S", widths: [10], rows: [{ cells: [cell("a\r\nb\rc")] }] }));
    const sheet = files.get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain(">a&#13;\nb&#13;c<");
    expect(sheet).not.toContain("\r");
    expect(cells.get("A1")).toBe("a\r\nb\rc");
  });

  it("writes a number cell as a plain value: no type to override, no formula, and it reads back", () => {
    const { files, cells } = readXlsx(xlsxOf({ name: "S", widths: [10, 10], rows: [{ cells: [{ number: 12345, style: "cell" }, cell("=1")] }] }));
    const sheet = files.get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain('<c r="A1" s="1"><v>12345</v></c>');
    expect(sheet).not.toContain("<f>");
    expect(cells.get("A1")).toBe("12345");
    expect(cells.get("B1")).toBe("'=1");
    const odd = readXlsx(xlsxOf({ name: "S", widths: [10], rows: [{ cells: [{ number: Number.NaN, style: "cell" }] }] }));
    expect(odd.cells.get("A1")).toBe("NaN");
    expect(odd.files.get("xl/worksheets/sheet1.xml")).toContain('<c r="A1" s="1" t="inlineStr">');
  });

  it("escapes all five XML specials, in cell text and in the sheet's name", () => {
    const { files, cells } = readXlsx(xlsxOf({ name: "O'Brien <&>", widths: [10], rows: [{ cells: [cell("it's <x> & \"y\"")] }] }));
    expect(cells.get("A1")).toBe("it's <x> & \"y\"");
    expect(files.get("xl/worksheets/sheet1.xml")).toContain("it&apos;s &lt;x&gt; &amp; &quot;y&quot;");
    expect(files.get("xl/workbook.xml")).toContain('name="O&apos;Brien &lt;&amp;&gt;"');
  });

  it("keeps a literal \"_xHHHH_\" literal, so Excel can't decode it into a leading \"=\"", () => {
    const { files, cells } = readXlsx(xlsxOf({ name: "S", widths: [10], rows: [{ cells: [cell("_x003D_1+1")] }] }));
    expect(files.get("xl/worksheets/sheet1.xml")).toContain(">_x005F_x003D_1+1<");
    expect(cells.get("A1")).toBe("_x003D_1+1");
  });

  it("cuts a cell to Excel's 32,767 characters without splitting a character", () => {
    const long = "a".repeat(32_766) + "\u{1F600}" + "b".repeat(10);
    const { cells } = readXlsx(xlsxOf({ name: "S", widths: [10], rows: [{ cells: [cell(long)] }, { cells: [{ runs: [{ text: "=" + "c".repeat(40_000) }, { text: "d", bold: true }], style: "cell" }] }] }));
    expect(cells.get("A1")).toBe("a".repeat(32_766));
    expect(cells.get("A2")!.length).toBe(32_767);
    expect(cells.get("A2")!.startsWith("'=c")).toBe(true);
  });
});

describe("the well-formedness check the tests read every part through", () => {
  it("refuses what a strict XML parser refuses", () => {
    const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    expect(() => checkWellFormed("ok", `${head}<a x="1"><b/>t &amp; u</a>`)).not.toThrow();
    expect(() => checkWellFormed("ok", `${head}<a>t&#13;u&#x0D;</a>`)).not.toThrow();
    for (const bad of ["<a><b></a></b>", "<a>&nbsp;</a>", "<a>&#;</a>", "<a>&#x;</a>", "<a>x & y</a>", "<a>\u0001</a>", "<a/><b/>", "<a x=1/>", "<a>", "text<a/>", "<a>\uD800</a>"]) {
      expect(() => checkWellFormed("bad", head + bad), bad).toThrow();
    }
  });
});
