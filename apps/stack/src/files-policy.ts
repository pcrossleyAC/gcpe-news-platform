import type { Response } from "express";

/**
 * What `/files` may serve inline, by extension (security review 2026-10-29). Imported legacy
 * files (legacy-files/) can be any type, and anything a browser would run — HTML, SVG, XML,
 * JavaScript, an unknown type it might sniff — must never render on news.gov.bc.ca's origin.
 * These types are inert: images (not SVG), PDF, office documents, archives, audio/video, and
 * text served as text/plain. Everything else is `application/octet-stream` with
 * `Content-Disposition: attachment` and a sandbox CSP (no script, no origin, no subresources even
 * if a browser did render it). Inline types get no CSP: a sandboxed top-level document can break
 * Firefox's and Safari's PDF viewers (re-review 2026-10-29). Every answer carries nosniff.
 */
const INLINE: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  zip: "application/zip",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mov: "video/quicktime",
  csv: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

export const FILES_CSP = "sandbox; default-src 'none'";
export const DOWNLOAD_TYPE = "application/octet-stream";

function extension(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot <= 0 || dot === name.length - 1 ? null : name.slice(dot + 1).toLowerCase();
}

/** The type `/files` serves `name` as, and whether inline. */
export function filesContentPolicy(name: string): { contentType: string; inline: boolean } {
  const ext = extension(name);
  const inline = ext !== null && Object.hasOwn(INLINE, ext) ? INLINE[ext]! : null;
  return inline ? { contentType: inline, inline: true } : { contentType: DOWNLOAD_TYPE, inline: false };
}

/** RFC 6266 attachment header with an ASCII fallback and the UTF-8 name. */
function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Sets the policy's headers on `res` before `send` writes the body (its own type() then leaves Content-Type alone). */
export function applyFilesHeaders(res: Response, name: string): void {
  const p = filesContentPolicy(name);
  res.setHeader("Content-Type", p.contentType);
  if (!p.inline) {
    res.setHeader("Content-Disposition", attachment(name));
    res.setHeader("Content-Security-Policy", FILES_CSP);
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
}
