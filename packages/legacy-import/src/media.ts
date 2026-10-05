/** Legacy: Gcpe.Hub.Data_Legacy/Entity/Justify.cs — 0 = Left, 1 = Right. */
export function justifyFromLegacy(value: number | null): "left" | "right" | null {
  if (value === 0) return "left";
  if (value === 1) return "right";
  return null;
}

/** Sniffs the image type from its bytes (legacy stores no MIME type for slide images). */
export function imageTypeFromBytes(buf: Buffer | null): string | null {
  if (!buf || buf.length < 4) return null;
  if (buf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  return null;
}
