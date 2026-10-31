import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import { LANG_EN, type CategoryKind, type LanguageId, type LastCorrectionView, type ReleaseFeatureView, type ReleaseView } from "@gcpe/nrms-contract";
import {
  categoryFeatures, documentContacts, documentLanguages, mediaLists, newsReleases, releaseCategories, releaseDocuments, releaseFiles, releaseLanguages, releaseLog, releaseMediaLists, releasePublications,
  type NewsReleaseRow, type SentEmailAgain,
} from "../db/schema";
import { ReleaseNotFoundError, VersionConflictError } from "./errors";

export interface Actor {
  id: string;
  name: string;
}
export const SYSTEM_ACTOR: Actor = { id: "system", name: "System" };

const isUuid = (id: string) => z.string().uuid().safeParse(id).success;
const iso = (d: Date | null) => (d ? d.toISOString() : null);
/** Where an uploaded file is publicly served (the stack's `/files` mount; see apps/stack/src/stack.ts). */
export const filePublicPath = (storageKey: string) => `/files/${storageKey.split("/").map(encodeURIComponent).join("/")}`;
const langOrder = (a: number, b: number) => (a === LANG_EN ? -1 : b === LANG_EN ? 1 : a - b);

/**
 * Ever public: releasedAt, or (a legacy import with no ReleaseDateTime) an atomId — stamped on
 * every publish and carried by imports — or a publication row. Its key is then a public URL, so
 * it never goes back to draft (returnToDraft) and its key never changes (suite review R2). The
 * view's `everPublished` is this same test.
 */
export async function hasBeenPublic(tx: DbOrTx, row: { id: string; releasedAt: Date | null; atomId: string | null }): Promise<boolean> {
  if (row.releasedAt !== null || row.atomId !== null) return true;
  return (await tx.select({ id: releasePublications.id }).from(releasePublications).where(eq(releasePublications.releaseId, row.id)).limit(1)).length > 0;
}

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
  const files = await db
    .select()
    .from(releaseFiles)
    .where(eq(releaseFiles.releaseId, id))
    .orderBy(asc(releaseFiles.createdAt), asc(releaseFiles.id));
  const cat = (kind: CategoryKind) => cats.filter((c) => c.kind === kind).map((c) => c.key);
  const featureRows = await db.select().from(categoryFeatures).where(or(eq(categoryFeatures.topReleaseId, id), eq(categoryFeatures.featureReleaseId, id)));
  const features: ReleaseFeatureView[] = featureRows.flatMap((f) => {
    const out: ReleaseFeatureView[] = [];
    if (f.topReleaseId === id) out.push({ kind: f.kind, key: f.key, slot: "top" });
    if (f.featureReleaseId === id) out.push({ kind: f.kind, key: f.key, slot: "feature" });
    return out;
  });
  return {
    id: r.id, type: r.type, key: r.key, reference: r.reference, status: r.status, live: r.live, onHold: r.onHold, version: r.version,
    leadMinistryKey: r.leadMinistryKey, activityId: r.activityId, publishAt: iso(r.publishAt), releasedAt: iso(r.releasedAt),
    everPublished: await hasBeenPublic(db, r),
    publishOptions: { toWeb: r.toWeb, toSubscribers: r.toSubscribers, toMediaLists: r.toMediaLists },
    assetUrl: r.assetUrl, assetAltText: r.assetAltText, hasMediaAssets: r.hasMediaAssets, hasTranslations: r.hasTranslations,
    redirectUrl: r.redirectUrl, keywords: r.keywords, atomId: r.atomId, nodSubscribers: r.nodSubscribers, mediaSubscribers: r.mediaSubscribers, lastError: r.lastError,
    flickrAlert: r.flickrAlert,
    emailAgainPending: r.emailAgain ? { subscribers: r.emailAgain.subscribers, mediaLists: r.emailAgain.mediaLists, requestedBy: r.emailAgain.actorName, requestedAt: r.emailAgain.at } : null,
    lastCorrection: r.lastEmailAgain ? await lastCorrection(db, r.lastEmailAgain) : null,
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
    files: files.map((f) => ({ id: f.id, kind: f.kind, label: f.label, url: filePublicPath(f.storageKey), contentType: f.contentType, size: f.size })),
    features,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

/** The NoD event subscriber's name (apps/stack env.ts): whose outbox deliveries say whether NoD got a request. */
export const NOD_SUBSCRIBER = "nod";

/**
 * Review I2: the latest corrected email passed to NoD, and whether NoD received it, from the
 * outbox deliveries of the events that carried it (by id, so no scan): any delivered means NoD has
 * it (NoD acts on each number once); any still pending, on its way; all given up on, not sent;
 * none to NoD, unknown.
 */
async function lastCorrection(db: DbOrTx, sent: SentEmailAgain): Promise<LastCorrectionView> {
  const ids = sent.eventIds ?? [];
  const { rows } = ids.length
    ? await db.execute<{ status: string }>(sql`SELECT status FROM outbox_deliveries WHERE subscriber = ${NOD_SUBSCRIBER} AND event_id = ANY(${sql.param(ids)}::uuid[])`)
    : { rows: [] as { status: string }[] };
  const has = (s: string) => rows.some((r) => r.status === s);
  const state = has("delivered") ? "delivered" : has("pending") ? "waiting" : has("dead") ? "not-delivered" : "unknown";
  return { seq: sent.seq, subscribers: sent.subscribers, mediaLists: sent.mediaLists, requestedBy: sent.requestedBy, requestedAt: sent.requestedAt, state };
}

export async function writeLog(tx: DbOrTx, releaseId: string, actor: Actor, text: string): Promise<void> {
  await tx.insert(releaseLog).values({ releaseId, actorId: actor.id, actorName: actor.name, text: text.slice(0, 500) });
}

/**
 * Every edit goes through here: row lock, version check, the change, version bump, its log
 * line(s), and — when the release is live — the correction transition (published → publishing).
 */
export async function mutateRelease(
  db: Db,
  id: string,
  expectedVersion: number,
  actor: Actor,
  change: (tx: Tx, row: NewsReleaseRow) => Promise<string | string[] | null>,
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
    for (const line of Array.isArray(text) ? text : text ? [text] : []) await writeLog(tx, id, actor, line);
    if (correction) await writeLog(tx, id, actor, "Edited after publishing — will republish");
    return (await loadView(tx, id))!;
  });
}
