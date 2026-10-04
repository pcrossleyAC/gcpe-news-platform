import { randomBytes } from "node:crypto";

export class InvalidKeyError extends Error {
  constructor(key: string, reason?: string) {
    super(`Invalid key: ${key}${reason ? ` (${reason})` : ""}`);
    this.name = "InvalidKeyError";
  }
}

const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_SEGMENTS = 4;
const MAX_LENGTH = 300;

/**
 * Throws InvalidKeyError unless every `/`-separated segment matches
 * ^[a-z0-9][a-z0-9._-]{0,127}$ and no segment is "." or "..";
 * max 4 segments; total length <= 300 chars.
 */
export function assertSafeKey(key: string): void {
  if (key.length === 0 || key.length > MAX_LENGTH) {
    throw new InvalidKeyError(key, "invalid length");
  }
  const segments = key.split("/");
  if (segments.length > MAX_SEGMENTS) {
    throw new InvalidKeyError(key, "too many segments");
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new InvalidKeyError(key, "dot segment");
    }
    if (!SEGMENT_RE.test(segment)) {
      throw new InvalidKeyError(key, "unsafe segment");
    }
  }
}

/**
 * Sanitises an arbitrary original file name into a safe, flat name:
 * lowercase -> replace any char outside [a-z0-9._-] with "-" ->
 * collapse runs of "-" -> strip leading/trailing "."/"-" ->
 * truncate to 100 chars keeping the extension (last "." + up to 10 chars) ->
 * "file" if empty.
 */
export function safeFileName(original: string): string {
  let name = original.toLowerCase();
  name = name.replace(/[^a-z0-9._-]/g, "-");
  name = name.replace(/-+/g, "-");
  name = name.replace(/^[.-]+|[.-]+$/g, "");

  if (name.length > 100) {
    const dotIndex = name.lastIndexOf(".");
    const ext = dotIndex > -1 ? name.slice(dotIndex, dotIndex + 11) : "";
    const base = dotIndex > -1 ? name.slice(0, dotIndex) : name;
    name = base.slice(0, 100 - ext.length) + ext;
  }

  return name === "" ? "file" : name;
}

/**
 * Builds a random storage key: `${prefix}/${16 hex}-${safeFileName(original)}`.
 */
export function randomFileKey(prefix: string, original: string): string {
  const random = randomBytes(8).toString("hex");
  return `${prefix}/${random}-${safeFileName(original)}`;
}

export type SniffedType = "application/pdf" | "image/png" | "image/jpeg";

/** The file extensions each type sniff() can return is allowed to be served under. */
export const SNIFFED_EXTENSIONS: Record<SniffedType, string[]> = {
  "application/pdf": [".pdf"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
};

/** True if `fileName` already ends (case-insensitively) with one of `contentType`'s valid extensions. */
export function hasMatchingExtension(fileName: string, contentType: SniffedType): boolean {
  const lower = fileName.toLowerCase();
  return SNIFFED_EXTENSIONS[contentType].some((e) => lower.endsWith(e));
}

/**
 * Forces a file name's extension to agree with its sniffed content type by *appending* the
 * canonical extension when the name doesn't already end in one of that type's extensions —
 * the rest of the name is kept verbatim. Used for storage keys, where the original name is
 * kept only for readability (media/files.ts): "evil.html" + image/png becomes
 * "evil.html.png", never served as HTML.
 */
export function appendMatchingExtension(fileName: string, contentType: SniffedType): string {
  return hasMatchingExtension(fileName, contentType) ? fileName : `${fileName}${SNIFFED_EXTENSIONS[contentType][0]}`;
}

/**
 * Forces a file name's extension to agree with its sniffed content type by *replacing* any
 * other recognised (pdf/png/jpg/jpeg) extension, or appending one when there is none. Used for
 * names the public site serves as-is (website/files.ts), where the result should read as an
 * ordinary file name: "report.pdf" + image/png becomes "report.png", not "report.pdf.png".
 */
export function forceExtension(fileName: string, contentType: SniffedType): string {
  if (hasMatchingExtension(fileName, contentType)) return fileName;
  const lower = fileName.toLowerCase();
  const allExtensions = Object.values(SNIFFED_EXTENSIONS).flat();
  const existing = allExtensions.find((e) => lower.endsWith(e));
  const base = existing ? fileName.slice(0, fileName.length - existing.length) : fileName;
  return `${base}${SNIFFED_EXTENSIONS[contentType][0]}`;
}
