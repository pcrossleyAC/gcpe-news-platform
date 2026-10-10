import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

/**
 * WOFF 1.0 → the TrueType font inside it, with Node's own zlib. pdfkit can read WOFF itself, but
 * inflates it in JavaScript for every document: about 400 ms locally and 3.4 s on boxs.ca for BC
 * Sans's four faces, against about 10 ms once here (measured 2026-10-10).
 */
export function woffToSfnt(woff: Buffer): Buffer {
  if (woff.length < 44 || woff.readUInt32BE(0) !== 0x774f4646) throw new Error("not a WOFF font");
  const flavor = woff.readUInt32BE(4);
  const numTables = woff.readUInt16BE(12);
  const tables: { tag: number; checksum: number; data: Buffer }[] = [];
  for (let i = 0; i < numTables; i++) {
    const e = 44 + i * 20;
    const offset = woff.readUInt32BE(e + 4);
    const compLength = woff.readUInt32BE(e + 8);
    const origLength = woff.readUInt32BE(e + 12);
    const raw = woff.subarray(offset, offset + compLength);
    const data = compLength < origLength ? inflateSync(raw) : Buffer.from(raw);
    if (data.length !== origLength) throw new Error("a WOFF table didn't inflate to its stated length");
    tables.push({ tag: woff.readUInt32BE(e), checksum: woff.readUInt32BE(e + 16), data });
  }
  let searchRange = 1;
  let entrySelector = 0;
  while (searchRange * 2 <= numTables) {
    searchRange *= 2;
    entrySelector++;
  }
  searchRange *= 16;
  const headerLength = 12 + numTables * 16;
  const out = Buffer.alloc(tables.reduce((n, t) => n + ((t.data.length + 3) & ~3), headerLength));
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(numTables, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(numTables * 16 - searchRange, 10);
  let offset = headerLength;
  tables.forEach((t, i) => {
    const d = 12 + i * 16;
    out.writeUInt32BE(t.tag, d);
    out.writeUInt32BE(t.checksum, d + 4);
    out.writeUInt32BE(offset, d + 8);
    out.writeUInt32BE(t.data.length, d + 12);
    t.data.copy(out, offset);
    offset += (t.data.length + 3) & ~3;
  });
  return out;
}

/** BC Sans's four faces (@bcgov/bc-sans), by pdfmake's style names. */
export const BC_SANS_FILES = { normal: "BCSans-Regular.woff", bold: "BCSans-Bold.woff", italics: "BCSans-Italic.woff", bolditalics: "BCSans-BoldItalic.woff" } as const;

/** Each face as TrueType bytes, read from `dir`. */
export function loadBcSans(dir: string): Record<keyof typeof BC_SANS_FILES, Buffer> {
  return Object.fromEntries(Object.entries(BC_SANS_FILES).map(([style, file]) => [style, woffToSfnt(readFileSync(join(dir, file)))])) as Record<keyof typeof BC_SANS_FILES, Buffer>;
}
