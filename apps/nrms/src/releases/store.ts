import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import { LANG_EN, type CategoryKind, type LanguageId, type ReleaseView } from "@gcpe/nrms-contract";
import {
  documentContacts, documentLanguages, mediaLists, newsReleases, releaseCategories, releaseDocuments, releaseLanguages, releaseLog, releaseMediaLists,
  type NewsReleaseRow,
} from "../db/schema";
import { ReleaseNotFoundError, VersionConflictError } from "./errors";

export interface Actor {
  id: string;
  name: string;
}
export const SYSTEM_ACTOR: Actor = { id: "system", name: "System" };

const isUuid = (id: string) => z.string().uuid().safeParse(id).success;
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const langOrder = (a: number, b: number) => (a === LANG_EN ? -1 : b === LANG_EN ? 1 : a - b);

/** The whole release as the API and renditions see it. Deleted releases still load (callers decide). */
export async function loadView(db: DbOrTx, id: string): Promise<ReleaseView | null> {
  if (!isUuid(id)) return null;
  const [r] = await db.select().from(newsReleases).where(eq(newsReleases.id, id));
  if (!r) return null;
  const langs = await db.select().from(releaseLanguages).where(eq(releaseLanguages.releaseId, id));
  const docs = await db.select().from(releaseDocuments).where(eq(releaseDocuments.releaseId, id)).orderBy(asc(releaseDocuments.sortIndex));
  const docIds = docs.map((d) => d.id);
  const dls = docIds.length ? await db.select().from(documentLanguages).where(inArray(documentLanguages.documentId, docIds)) : [];
  const contacts = docIds.length
    ? await db.select().from(documentContacts).where(inArray(documentContacts.documentId, docIds)).orderBy(asc(documentContacts.sortIndex))
    : [];
  const cats = await db.select().from(releaseCategories).where(eq(releaseCategories.releaseId, id)).orderBy(asc(releaseCategories.key));
  const lists = await db
    .select({ key: mediaLists.key })
    .from(releaseMediaLists)
    .innerJoin(mediaLists, eq(mediaLists.id, releaseMediaLists.mediaListId))
    .where(eq(releaseMediaLists.releaseId, id))
    .orderBy(asc(mediaLists.sortOrder), asc(mediaLists.key));
  const cat = (kind: CategoryKind) => cats.filter((c) => c.kind === kind).map((c) => c.key);
  return {
    id: r.id, type: r.type, key: r.key, reference: r.reference, status: r.status, onHold: r.onHold, version: r.version,
    leadMinistryKey: r.leadMinistryKey, activityId: r.activityId, publishAt: iso(r.publishAt), releasedAt: iso(r.releasedAt),
    publishOptions: { toWeb: r.toWeb, toSubscribers: r.toSubscribers, toMediaLists: r.toMediaLists },
    assetUrl: r.assetUrl, assetAltText: r.assetAltText, hasMediaAssets: r.hasMediaAssets, hasTranslations: r.hasTranslations,
    redirectUrl: r.redirectUrl, keywords: r.keywords, atomId: r.atomId, nodSubscribers: r.nodSubscribers, mediaSubscribers: r.mediaSubscribers, lastError: r.lastError,
    languages: langs
      .sort((a, b) => langOrder(a.languageId, b.languageId))
      .map((l) => ({ languageId: l.languageId as LanguageId, location: l.location, summary: l.summary, summaryEdited: l.summaryEdited, socialMediaSummary: l.socialMediaSummary })),
    documents: docs.map((d) => ({
      id: d.id,
      sortIndex: d.sortIndex,
      layout: d.layout,
      languages: dls
        .filter((l) => l.documentId === d.id)
        .sort((a, b) => langOrder(a.languageId, b.languageId))
        .map((l) => ({
          languageId: l.languageId as LanguageId, pageTitle: l.pageTitle, headline: l.headline, subheadline: l.subheadline,
          organizations: l.organizations, byline: l.byline, bodyHtml: l.bodyHtml, pageImageId: l.pageImageId,
          contacts: contacts.filter((c) => c.documentId === d.id && c.languageId === l.languageId).map((c) => c.information),
        })),
    })),
    ministries: cat("ministries"), sectors: cat("sectors"), themes: cat("themes"), tags: cat("tags"), mediaListKeys: lists.map((l) => l.key),
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

export async function writeLog(tx: DbOrTx, releaseId: string, actor: Actor, text: string): Promise<void> {
  await tx.insert(releaseLog).values({ releaseId, actorId: actor.id, actorName: actor.name, text: text.slice(0, 500) });
}

/**
 * Every edit goes through here: row lock, version check, the change, version bump, one log
 * line, and — when the release is live — the correction transition (published → publishing).
 */
export async function mutateRelease(
  db: Db,
  id: string,
  expectedVersion: number,
  actor: Actor,
  change: (tx: Tx, row: NewsReleaseRow) => Promise<string | null>,
  opts: { correction?: boolean } = {},
): Promise<ReleaseView> {
  if (!isUuid(id)) throw new ReleaseNotFoundError(id);
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(newsReleases).where(eq(newsReleases.id, id)).for("update");
    if (!row || row.status === "deleted") throw new ReleaseNotFoundError(id);
    if (row.version !== expectedVersion) throw new VersionConflictError();
    const text = await change(tx, row);
    const correction = (opts.correction ?? true) && row.status === "published";
    await tx
      .update(newsReleases)
      .set({ version: row.version + 1, updatedAt: sql`now()`, ...(correction ? { status: "publishing" as const } : {}) })
      .where(and(eq(newsReleases.id, id)));
    if (text) await writeLog(tx, id, actor, text);
    if (correction) await writeLog(tx, id, actor, "Edited after publishing — will republish");
    return (await loadView(tx, id))!;
  });
}
