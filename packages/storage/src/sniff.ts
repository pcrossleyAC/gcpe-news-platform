const PDF_MAGIC = Buffer.from("%PDF-", "latin1");
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * Identifies content by magic bytes only (never by extension or declared
 * content type). Returns null for anything else, including empty buffers.
 */
export function sniff(bytes: Buffer): "application/pdf" | "image/png" | "image/jpeg" | null {
  if (bytes.length >= PDF_MAGIC.length && bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return "application/pdf";
  }
  if (bytes.length >= PNG_MAGIC.length && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return "image/png";
  }
  if (bytes.length >= JPEG_MAGIC.length && bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    return "image/jpeg";
  }
  return null;
}
