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
