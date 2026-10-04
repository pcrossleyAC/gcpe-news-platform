import { and, eq } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { LANG_EN, LANG_FR } from "@gcpe/nrms-contract";
import { sniff } from "@gcpe/storage";
import { pageImageLanguages, pageImages } from "../db/schema";
import { ReleaseNotFoundError, ReleaseRuleError, ReleaseStateError } from "../releases/errors";

/** Page images (the letterhead banner at the top of a release) — 2 MiB per upload (constraints.md). */
export const MAX_PAGE_IMAGE_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AddPageImageInput {
  name: string;
  bytes: Buffer;
  altEn: string;
  altFr: string;
  sortOrder: number;
}

export interface PageImageUpdate {
  altEn?: string;
  altFr?: string;
  sortOrder?: number;
  isActive?: boolean;
}

export interface PageImageView {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  mimeType: string;
  altEn: string;
  altFr: string;
}

const isUniqueViolation = (e: unknown): boolean => {
  for (let c: unknown = e; c && typeof c === "object"; c = (c as { cause?: unknown }).cause) {
    if ((c as { code?: unknown }).code === "23505") return true;
  }
  return false;
};

async function viewOf(db: DbOrTx, id: string): Promise<PageImageView | null> {
  const [img] = await db
    .select({ id: pageImages.id, name: pageImages.name, sortOrder: pageImages.sortOrder, isActive: pageImages.isActive, mimeType: pageImages.mimeType })
    .from(pageImages)
    .where(eq(pageImages.id, id));
  if (!img) return null;
  const alts = await db.select().from(pageImageLanguages).where(eq(pageImageLanguages.imageId, id));
  const alt = (lang: number) => alts.find((a) => a.languageId === lang)?.altText ?? "";
  return { ...img, altEn: alt(LANG_EN), altFr: alt(LANG_FR) };
}

export async function addPageImage(db: Db, input: AddPageImageInput): Promise<{ id: string; name: string }> {
  if (input.bytes.length === 0) throw new ReleaseRuleError(["The file is empty."]);
  if (input.bytes.length > MAX_PAGE_IMAGE_BYTES) throw new ReleaseRuleError(["A page image can be at most 2 MB."]);
  const mimeType = sniff(input.bytes);
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") throw new ReleaseRuleError(["Upload a PNG or JPEG image."]);
  const name = input.name.trim();
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(pageImages)
        .values({ name, mimeType, bytes: input.bytes, sortOrder: input.sortOrder })
        .returning({ id: pageImages.id, name: pageImages.name });
      await tx.insert(pageImageLanguages).values([
        { imageId: row!.id, languageId: LANG_EN, altText: input.altEn },
        { imageId: row!.id, languageId: LANG_FR, altText: input.altFr },
      ]);
      return row!;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ReleaseStateError("A page image with that name already exists.");
    throw e;
  }
}

export async function updatePageImage(db: Db, id: string, input: PageImageUpdate): Promise<PageImageView> {
  if (!UUID.test(id)) throw new ReleaseNotFoundError(id);
  return db.transaction(async (tx) => {
    const set = {
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    };
    const [found] = Object.keys(set).length
      ? await tx.update(pageImages).set(set).where(eq(pageImages.id, id)).returning({ id: pageImages.id })
      : await tx.select({ id: pageImages.id }).from(pageImages).where(eq(pageImages.id, id)).for("update");
    if (!found) throw new ReleaseNotFoundError(id);
    for (const [languageId, altText] of [[LANG_EN, input.altEn], [LANG_FR, input.altFr]] as const) {
      if (altText === undefined) continue;
      await tx
        .insert(pageImageLanguages)
        .values({ imageId: id, languageId, altText })
        .onConflictDoUpdate({ target: [pageImageLanguages.imageId, pageImageLanguages.languageId], set: { altText } });
    }
    return (await viewOf(tx, id))!;
  });
}

export async function pageImageBytes(db: DbOrTx, id: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
  if (!UUID.test(id)) return null;
  const [row] = await db.select({ bytes: pageImages.bytes, mimeType: pageImages.mimeType }).from(pageImages).where(and(eq(pageImages.id, id)));
  return row ?? null;
}
