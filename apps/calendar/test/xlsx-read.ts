import { inflateRawSync } from "node:zlib";

/** Every entry of a zip, by name, as text. Reads the central directory, as Excel does. */
export function unzip(buf: Buffer): Map<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("not a zip: no end of central directory");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out.set(name, (method === 8 ? inflateRawSync(data) : data).toString("utf8"));
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

/** Each cell's text by reference ("A1"), runs joined, XML entities and Excel's "_xHHHH_" escapes undone. */
export function cellsOf(sheetXml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of sheetXml.matchAll(/<c r="([A-Z]+\d+)"[^>]*>(.*?)<\/c>/gs)) {
    const text = [...m[2]!.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((t) => t[1]!).join("");
    out.set(m[1]!, text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
  }
  return out;
}

const ENTITY_FREE = (s: string) => !s.replace(/&(?:lt|gt|amp|quot|apos);/g, "").includes("&");

/**
 * Throws unless the part is well-formed XML 1.0 as a strict parser reads it: an optional declaration,
 * one root element, tags balanced, attributes double-quoted, only the five predefined entities, and no
 * character XML forbids.
 */
export function checkWellFormed(name: string, xml: string): void {
  const fail = (why: string) => {
    throw new Error(`${name}: ${why}`);
  };
  const body = xml.replace(/^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>\n?/, "");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/.test(body)) fail("a character XML 1.0 forbids");
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body)) fail("a lone surrogate");
  const token = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*="[^"<]*")*)\s*(\/?)>|([^<]+)/y;
  const stack: string[] = [];
  let roots = 0;
  for (let i = 0; i < body.length; i = token.lastIndex) {
    token.lastIndex = i;
    const m = token.exec(body);
    if (!m) fail(`malformed markup at offset ${i}`);
    const [, close, tag, attrs, selfClose, text] = m!;
    if (text !== undefined) {
      if (stack.length === 0 && text.trim()) fail("text outside the root element");
      if (!ENTITY_FREE(text)) fail("an unknown entity or a bare &");
      continue;
    }
    if (!ENTITY_FREE(attrs!)) fail("an unknown entity or a bare & in an attribute");
    if (close) {
      if (attrs || selfClose) fail(`a closing tag with attributes: ${tag}`);
      if (stack.pop() !== tag) fail(`unbalanced </${tag}>`);
    } else {
      if (stack.length === 0) roots++;
      if (!selfClose) stack.push(tag!);
    }
  }
  if (stack.length) fail(`unclosed <${stack.at(-1)}>`);
  if (roots !== 1) fail(`${roots} root elements`);
}

/** The package's parts, each checked well-formed, and the sheet's cells. */
export function readXlsx(buf: Buffer): { files: Map<string, string>; cells: Map<string, string> } {
  const files = unzip(buf);
  for (const [name, xml] of files) checkWellFormed(name, xml);
  return { files, cells: cellsOf(files.get("xl/worksheets/sheet1.xml") ?? "") };
}
