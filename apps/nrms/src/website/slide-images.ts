import { createHash } from "node:crypto";
import { isNotNull } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { ObjectStore } from "@gcpe/storage";
import { emergencyPins, websiteSlides } from "../db/schema";

/**
 * Carousel and emergency pin images, served from NRMS's existing public file store under
 * content-addressed keys (spec addendum §6.4): `slides/<sha256>.<png|jpg>`. Unlike
 * general site files (website/files.ts), the key is derived from the bytes themselves, so the
 * same image uploaded twice (e.g. copied onto a new next carousel) shares one file, and a
 * not-yet-live image can only be found by whoever already has its hash.
 */
export interface SlideImageFiles {
  store: ObjectStore;
  /** NRMS's PUBLIC_FILES_BASE (no trailing slash; "" for same-origin paths), as release files use. */
  filesBase: string;
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg" };

/** The content-addressed key, public URL and hash for `bytes`/`mimeType` — doesn't touch storage. */
export function slideImageRef(files: SlideImageFiles, bytes: Buffer, mimeType: string): { imageKey: string; imageUrl: string; imageSha256: string } {
  const ext = EXT[mimeType];
  if (!ext) throw new Error(`unsupported slide image type ${mimeType}`);
  const imageSha256 = createHash("sha256").update(bytes).digest("hex");
  const imageKey = `slides/${imageSha256}.${ext}`;
  return { imageKey, imageUrl: `${files.filesBase}${files.store.publicPath(imageKey)}`, imageSha256 };
}

/** Writes `bytes` to the file store under its content-addressed key. Idempotent: the same bytes
 * always land at the same key, so writing them again just overwrites identical content. */
export async function publishSlideImage(files: SlideImageFiles, bytes: Buffer, mimeType: string): Promise<void> {
  const { imageKey } = slideImageRef(files, bytes, mimeType);
  await files.store.put(imageKey, bytes, mimeType);
}

/**
 * Writes the file for every stored slide and pin image that has none yet (the startup backfill
 * for images stored before this change, and recovery after a lost file). Returns how many files
 * were written.
 */
export async function ensureSlideImageFiles(db: DbOrTx, files: SlideImageFiles): Promise<number> {
  const have = new Set((await files.store.list("slides/")).map((o) => o.key));
  const rows = [
    ...(await db.select({ image: websiteSlides.image, imageType: websiteSlides.imageType }).from(websiteSlides).where(isNotNull(websiteSlides.image))),
    ...(await db.select({ image: emergencyPins.image, imageType: emergencyPins.imageType }).from(emergencyPins).where(isNotNull(emergencyPins.image))),
  ];
  let written = 0;
  for (const r of rows) {
    if (!r.image || !r.imageType || !EXT[r.imageType]) continue;
    const { imageKey } = slideImageRef(files, r.image, r.imageType);
    if (have.has(imageKey)) continue;
    await files.store.put(imageKey, r.image, r.imageType);
    have.add(imageKey);
    written++;
  }
  return written;
}
