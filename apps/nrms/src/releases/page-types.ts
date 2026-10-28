import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@gcpe/db-kit";
import { CREATABLE_TYPES, LANG_EN, LANG_FR, LAYOUTS, RELEASE_TYPES, TYPE_LABEL, type ReleaseType } from "@gcpe/nrms-contract";
import { pageImages, pageTypes } from "../db/schema";

/** The release editor's Page title limit (addDocumentSchema). */
export const PAGE_TITLE_MAX = 50;

export const pageTypeInputSchema = z.object({
  pageTitle: z.string().trim().min(1).max(PAGE_TITLE_MAX).refine((s) => !/[<>]/.test(s), "Page titles are plain text."),
  languageId: z.union([z.literal(LANG_EN), z.literal(LANG_FR)]),
  releaseType: z.enum(RELEASE_TYPES),
  sortOrder: z.number().int().min(0).max(9999),
  layout: z.enum(LAYOUTS),
  pageImageId: z.string().uuid().nullable(),
});
export type PageTypeInput = z.infer<typeof pageTypeInputSchema>;
export type PageTypeKey = { pageTitle: string; languageId: number };
export type PageTypeRow = PageTypeInput;
const asRow = (r: { languageId: number } & Omit<PageTypeInput, "languageId">): PageTypeRow => r as PageTypeRow;

/** 409 */
export class PageTypeConflictError extends Error {}
/** 400 (unknown page image) */
export class PageTypeRuleError extends Error {}
/** 404 */
export class PageTypeNotFoundError extends Error {}

const COLUMNS = {
  pageTitle: pageTypes.pageTitle, languageId: pageTypes.languageId, releaseType: pageTypes.releaseType,
  sortOrder: pageTypes.sortOrder, layout: pageTypes.layout, pageImageId: pageTypes.pageImageId,
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Serialises writers: the table is a few dozen rows, and the checks below read before they write. */
const lock = (tx: Tx) => tx.execute(sql`LOCK TABLE page_types IN SHARE ROW EXCLUSIVE MODE`);

async function find(tx: Tx, key: PageTypeKey) {
  const [row] = await tx.select(COLUMNS).from(pageTypes).where(and(eq(pageTypes.pageTitle, key.pageTitle), eq(pageTypes.languageId, key.languageId)));
  return row;
}

async function checkTitleFree(tx: Tx, input: PageTypeInput, except?: PageTypeKey) {
  const rows = await tx.select({ t: pageTypes.pageTitle }).from(pageTypes)
    .where(and(eq(pageTypes.languageId, input.languageId), sql`lower(${pageTypes.pageTitle}) = lower(${input.pageTitle})`));
  if (rows.some((r) => !(except && except.languageId === input.languageId && r.t === except.pageTitle))) {
    throw new PageTypeConflictError("A page title with that name already exists in that language.");
  }
}

async function checkImage(tx: Tx, id: string | null) {
  if (id === null) return;
  const [img] = await tx.select({ id: pageImages.id }).from(pageImages).where(eq(pageImages.id, id));
  if (!img) throw new PageTypeRuleError("That page image does not exist.");
}

/** A creatable type must keep an English title, or the New release screen has nothing to offer. */
async function checkNotStranded(tx: Tx, old: { releaseType: ReleaseType; languageId: number }) {
  if (old.languageId !== LANG_EN || !(CREATABLE_TYPES as readonly string[]).includes(old.releaseType)) return;
  const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(pageTypes)
    .where(and(eq(pageTypes.releaseType, old.releaseType), eq(pageTypes.languageId, LANG_EN)));
  if (n === 0) throw new PageTypeConflictError(`This is the only English page title for ${TYPE_LABEL[old.releaseType]}. Add another first.`);
}

export async function createPageType(db: Db, input: PageTypeInput): Promise<PageTypeRow> {
  return db.transaction(async (tx) => {
    await lock(tx);
    await checkTitleFree(tx, input);
    await checkImage(tx, input.pageImageId);
    const [row] = await tx.insert(pageTypes).values(input).returning(COLUMNS);
    return asRow(row!);
  });
}

/** May change the title (the key). Existing releases hold their own copy of the title text and are untouched. */
export async function updatePageType(db: Db, key: PageTypeKey, input: PageTypeInput): Promise<PageTypeRow> {
  return db.transaction(async (tx) => {
    await lock(tx);
    const old = await find(tx, key);
    if (!old) throw new PageTypeNotFoundError("not found");
    await checkTitleFree(tx, input, key);
    await checkImage(tx, input.pageImageId);
    const [row] = await tx.update(pageTypes).set(input)
      .where(and(eq(pageTypes.pageTitle, key.pageTitle), eq(pageTypes.languageId, key.languageId))).returning(COLUMNS);
    await checkNotStranded(tx, old);
    return asRow(row!);
  });
}

export async function deletePageType(db: Db, key: PageTypeKey): Promise<void> {
  await db.transaction(async (tx) => {
    await lock(tx);
    const old = await find(tx, key);
    if (!old) throw new PageTypeNotFoundError("not found");
    await tx.delete(pageTypes).where(and(eq(pageTypes.pageTitle, key.pageTitle), eq(pageTypes.languageId, key.languageId)));
    await checkNotStranded(tx, old);
  });
}
