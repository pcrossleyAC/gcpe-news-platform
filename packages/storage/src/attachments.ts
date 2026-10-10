type Family = "pdf" | "png" | "jpeg" | "gif" | "ooxml" | "ole" | "rtf" | "text";

/**
 * Every extension a Calendar attachment may have, the one type it is served as, and the content
 * family its first bytes must belong to (spec addendum §8.4). The served type never comes from
 * the uploader.
 */
export const ATTACHMENT_TYPES = {
  pdf: { contentType: "application/pdf", family: "pdf" },
  png: { contentType: "image/png", family: "png" },
  jpg: { contentType: "image/jpeg", family: "jpeg" },
  jpeg: { contentType: "image/jpeg", family: "jpeg" },
  gif: { contentType: "image/gif", family: "gif" },
  doc: { contentType: "application/msword", family: "ole" },
  docx: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", family: "ooxml" },
  xls: { contentType: "application/vnd.ms-excel", family: "ole" },
  xlsx: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", family: "ooxml" },
  ppt: { contentType: "application/vnd.ms-powerpoint", family: "ole" },
  pptx: { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", family: "ooxml" },
  msg: { contentType: "application/vnd.ms-outlook", family: "ole" },
  rtf: { contentType: "application/rtf", family: "rtf" },
  txt: { contentType: "text/plain", family: "text" },
  csv: { contentType: "text/csv", family: "text" },
} as const satisfies Record<string, { contentType: string; family: Family }>;
export type AttachmentExtension = keyof typeof ATTACHMENT_TYPES;

/** Legacy's blocklist (Activity.aspx.cs:1274-1391), without its duplicates. Checked first, so its refusal keeps legacy's meaning. */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  "ashx", "asmx", "json", "soap", "svc", "xamlx", "ade", "adp", "asa", "asp", "bas", "bat", "cdx", "cer", "chm", "class", "cmd", "com",
  "config", "cnt", "cpl", "crt", "csh", "der", "dll", "exe", "fxp", "gadget", "grp", "hlp", "hpj", "hta", "htr", "htw", "ida", "idc",
  "idq", "ins", "isp", "its", "jse", "ksh", "lnk", "mad", "maf", "mag", "mam", "maq", "mar", "mas", "mat", "mau", "mav", "maw", "mcf",
  "mda", "mdb", "mde", "mdt", "mdw", "mdz", "ms-one-stub", "msc", "msh", "msh1", "msh1xml", "msh2", "msh2xml", "mshxml", "msi", "msp",
  "mst", "ops", "pcd", "pif", "pl", "prf", "prg", "printer", "ps1", "ps1xml", "ps2", "ps2xml", "psc1", "psc2", "pst", "reg", "rem",
  "scf", "scr", "sct", "shb", "shs", "shtm", "shtml", "stm", "url", "vb", "vbe", "vbs", "vsix", "ws", "wsc", "wsf", "wsh",
]);

export type AttachmentProblem = "empty" | "blocked" | "unsupported" | "mismatch";
export type AttachmentCheck = { ok: true; extension: AttachmentExtension; contentType: string } | { ok: false; problem: AttachmentProblem };

/** The text after the last dot, lower-cased; null when there is none. */
export function extensionOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 || dot === fileName.length - 1 ? null : fileName.slice(dot + 1).toLowerCase();
}

const startsWith = (b: Buffer, sig: string | readonly number[]) => {
  const s = typeof sig === "string" ? Buffer.from(sig, "latin1") : Buffer.from(sig);
  return b.length >= s.length && b.subarray(0, s.length).equals(s);
};
const MATCHES: Record<Family, (b: Buffer) => boolean> = {
  pdf: (b) => startsWith(b, "%PDF-"),
  png: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  gif: (b) => startsWith(b, "GIF87a") || startsWith(b, "GIF89a"),
  // Word, Excel and PowerPoint since 2007: a ZIP package with a [Content_Types].xml part.
  ooxml: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) && b.includes("[Content_Types].xml"),
  // Word, Excel and PowerPoint before 2007, and Outlook messages: an OLE compound file.
  ole: (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  rtf: (b) => startsWith(b, "{\\rtf"),
  text: (b) => !b.includes(0),
};

/** Refuses an empty file, legacy's blocked extensions, any type outside the list, and bytes that aren't what the name says. */
export function checkAttachment(fileName: string, bytes: Buffer): AttachmentCheck {
  if (bytes.length === 0) return { ok: false, problem: "empty" };
  const ext = extensionOf(fileName);
  if (ext !== null && BLOCKED_EXTENSIONS.has(ext)) return { ok: false, problem: "blocked" };
  if (ext === null || !Object.hasOwn(ATTACHMENT_TYPES, ext)) return { ok: false, problem: "unsupported" };
  const type = ATTACHMENT_TYPES[ext as AttachmentExtension];
  if (!MATCHES[type.family](bytes)) return { ok: false, problem: "mismatch" };
  return { ok: true, extension: ext as AttachmentExtension, contentType: type.contentType };
}

const SERVED: ReadonlySet<string> = new Set(Object.values(ATTACHMENT_TYPES).map((t) => t.contentType));
/** The type a stored file is served as: one of the list's, or a plain download for an imported file of any other type. */
export function downloadContentType(stored: string): string {
  return SERVED.has(stored) ? stored : "application/octet-stream";
}
