import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import {
  assetUrlProblem, LANG_EN, LANG_FR, TYPE_LABEL, typeRules,
  type AddDocumentInput, type AddTranslationInput, type AssetInput, type CategoriesInput, type CreateReleaseInput, type DocumentLanguageInput,
  type LanguageId, type Layout, type MetaInput, type ReleaseType, type ReleaseView, type ReorderDocumentsInput, type SettingsInput,
} from "@gcpe/nrms-contract";
import {
  categoryTerms, documentContacts, flickrJobs, documentLanguages, mediaLists, newsReleases, organizations, releaseCategories, releaseDocuments, releaseFiles, releaseLanguages, releaseMediaLists,
  type NewsReleaseRow,
} from "../db/schema";
import type { ObjectStore } from "@gcpe/storage";
import { flickrAssetProblem } from "../media/asset-status";
import { normalizeEmbeds, type EmbedDeps } from "../media/embeds";
import { deleteStoredFiles } from "../media/files";
import { sanitizeBodyHtml } from "../text/sanitize";
import { generateSlug } from "../text/slug";
import { summaryFromBody } from "../text/plain";
import { ReleaseNotFoundError, ReleaseRuleError, ReleaseStateError } from "./errors";
import { uniqueKey } from "./keys";
import { loadView, mutateRelease, writeLog, type Actor } from "./store";

const EDITABLE_KEY_STATUSES = new Set(["draft", "approved"]);
const PLANNING_STATUSES = new Set(["draft", "approved", "failed"]);
const DELETABLE_STATUSES = new Set(["draft", "approved", "failed"]);
const SINGULAR = { ministries: "ministry", sectors: "sector", themes: "theme", tags: "tag" } as const;

/** Unknown keys (not in the local cache at all) → ReleaseRuleError. Inactive keys are allowed. */
async function assertKnownCategories(tx: DbOrTx, c: { ministries: string[]; sectors: string[]; themes: string[]; tags: string[] }): Promise<void> {
  const problems: string[] = [];
  if (c.ministries.length) {
    const found = new Set((await tx.select({ k: organizations.key }).from(organizations).where(inArray(organizations.key, c.ministries))).map((r) => r.k));
    for (const k of c.ministries) if (!found.has(k)) problems.push(`Unknown ministry: ${k}`);
  }
  for (const kind of ["sectors", "themes", "tags"] as const) {
    if (!c[kind].length) continue;
    const found = new Set((await tx.select({ k: categoryTerms.key }).from(categoryTerms).where(and(eq(categoryTerms.kind, kind), inArray(categoryTerms.key, c[kind])))).map((r) => r.k));
    for (const k of c[kind]) if (!found.has(k)) problems.push(`Unknown ${SINGULAR[kind]}: ${k}`);
  }
  if (problems.length) throw new ReleaseRuleError(problems);
}

async function mediaListIds(tx: DbOrTx, keys: string[]): Promise<string[]> {
  if (!keys.length) return [];
  const rows = await tx.select({ id: mediaLists.id, key: mediaLists.key }).from(mediaLists).where(inArray(mediaLists.key, keys));
  const missing = keys.filter((k) => !rows.some((r) => r.key === k));
  if (missing.length) throw new ReleaseRuleError(missing.map((k) => `Unknown media distribution list: ${k}`));
  return rows.map((r) => r.id);
}

async function replaceCategories(tx: Tx, releaseId: string, c: { ministries: string[]; sectors: string[]; themes: string[]; tags: string[] }): Promise<void> {
  await tx.delete(releaseCategories).where(eq(releaseCategories.releaseId, releaseId));
  const rows = (["ministries", "sectors", "themes", "tags"] as const).flatMap((kind) => c[kind].map((key) => ({ releaseId, kind, key })));
  if (rows.length) await tx.insert(releaseCategories).values(rows);
}

async function replaceMediaLists(tx: Tx, releaseId: string, ids: string[]): Promise<void> {
  await tx.delete(releaseMediaLists).where(eq(releaseMediaLists.releaseId, releaseId));
  if (ids.length) await tx.insert(releaseMediaLists).values(ids.map((mediaListId) => ({ releaseId, mediaListId })));
}

async function replaceContacts(tx: Tx, documentId: string, languageId: number, contacts: string[]): Promise<void> {
  await tx.delete(documentContacts).where(and(eq(documentContacts.documentId, documentId), eq(documentContacts.languageId, languageId)));
  const rows = contacts.map((information, sortIndex) => ({ documentId, languageId, sortIndex, information })).filter((r) => r.information.trim() !== "");
  if (rows.length) await tx.insert(documentContacts).values(rows.map((r, i) => ({ ...r, sortIndex: i })));
}

function leadOf(lead: string | null, ministries: string[]): string | null {
  if (lead && !ministries.includes(lead)) throw new ReleaseRuleError(["The lead ministry must be one of the selected ministries."]);
  return lead ?? (ministries.length === 1 ? ministries[0]! : null);
}

function assertTypeAllows(type: ReleaseType, x: { sectors?: string[]; themes?: string[]; tags?: string[]; mediaListKeys?: string[]; pageImageId?: string | null }): void {
  const r = typeRules(type);
  const p: string[] = [];
  if (!r.categoriesBeyondMinistries && ((x.sectors?.length ?? 0) || (x.themes?.length ?? 0) || (x.tags?.length ?? 0))) p.push(`A ${TYPE_LABEL[type]} has no sectors, themes or tags.`);
  if (!r.mediaListsAllowed && (x.mediaListKeys?.length ?? 0)) p.push(`A ${TYPE_LABEL[type]} has no media distribution lists.`);
  if (!r.pageImageAllowed && x.pageImageId) p.push(`A ${TYPE_LABEL[type]} has no page image.`);
  if (p.length) throw new ReleaseRuleError(p);
}

/** Two editors racing for the same slug: the unique index catches the loser. */
async function keyRace<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
    if (code === "23505") throw new ReleaseStateError("That URL key is already in use — try again.");
    throw e;
  }
}

const languageName = (lang: number) => (lang === LANG_EN ? "English" : "French");

async function documentOf(tx: DbOrTx, releaseId: string, documentId: string) {
  const [doc] = await tx
    .select()
    .from(releaseDocuments)
    .where(and(eq(releaseDocuments.releaseId, releaseId), eq(releaseDocuments.id, documentId)));
  if (!doc) throw new ReleaseNotFoundError(`document ${documentId}`);
  return doc;
}

async function documentLanguageIds(tx: DbOrTx, documentId: string): Promise<number[]> {
  return (await tx.select({ l: documentLanguages.languageId }).from(documentLanguages).where(eq(documentLanguages.documentId, documentId))).map((r) => r.l);
}

/** Keep sort indexes contiguous (0..n-1) after a removal, preserving order. */
async function renumberDocuments(tx: Tx, releaseId: string): Promise<void> {
  const docs = await tx.select({ id: releaseDocuments.id }).from(releaseDocuments).where(eq(releaseDocuments.releaseId, releaseId)).orderBy(asc(releaseDocuments.sortIndex));
  for (const [i, d] of docs.entries()) await tx.update(releaseDocuments).set({ sortIndex: i }).where(eq(releaseDocuments.id, d.id));
}

/** Drop release-level language rows that no document uses any more (never English). */
async function pruneReleaseLanguages(tx: Tx, releaseId: string): Promise<void> {
  const used = await tx
    .selectDistinct({ l: documentLanguages.languageId })
    .from(documentLanguages)
    .innerJoin(releaseDocuments, eq(releaseDocuments.id, documentLanguages.documentId))
    .where(eq(releaseDocuments.releaseId, releaseId));
  const keep = new Set([LANG_EN, ...used.map((r) => r.l)]);
  const langs = await tx.select({ l: releaseLanguages.languageId }).from(releaseLanguages).where(eq(releaseLanguages.releaseId, releaseId));
  for (const { l } of langs) {
    if (!keep.has(l)) await tx.delete(releaseLanguages).where(and(eq(releaseLanguages.releaseId, releaseId), eq(releaseLanguages.languageId, l)));
  }
}

async function removeDocumentRows(tx: Tx, releaseId: string, documentId: string): Promise<void> {
  const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(releaseDocuments).where(eq(releaseDocuments.releaseId, releaseId));
  if (n <= 1) throw new ReleaseStateError("A release needs at least one document.");
  await tx.delete(releaseDocuments).where(eq(releaseDocuments.id, documentId));
  await renumberDocuments(tx, releaseId);
  await pruneReleaseLanguages(tx, releaseId);
}

const isFirstEnglish = (sortIndex: number, languageId: number) => sortIndex === 0 && languageId === LANG_EN;

/**
 * Sanitises a body and, when `deps` is supplied and the body contains an `<asset>` embed,
 * normalises it (Task 7) — a network-calling step that must run before `mutateRelease` opens
 * its transaction (no network while holding the release row lock). Without `deps` (e.g. a test
 * that doesn't care about embeds), the body is sanitised only, unchanged from before this task.
 */
async function normalizedBody(bodyHtml: string, deps: EmbedDeps | undefined): Promise<string> {
  const sanitized = sanitizeBodyHtml(bodyHtml);
  return deps && sanitized.includes("<asset") ? normalizeEmbeds(sanitized, deps) : sanitized;
}

export async function createRelease(db: Db, input: CreateReleaseInput, actor: Actor, deps?: EmbedDeps): Promise<ReleaseView> {
  const type = input.type;
  const rules = typeRules(type);
  if (!rules.creatable) throw new ReleaseRuleError([`A new ${TYPE_LABEL[type]} can't be created.`]);
  assertTypeAllows(type, input);
  const body = await normalizedBody(input.bodyHtml, deps);
  return keyRace(
    db.transaction(async (tx) => {
      await assertKnownCategories(tx, input);
      const lead = leadOf(input.leadMinistryKey, input.ministries);
      const listIds = await mediaListIds(tx, input.mediaListKeys);
      const key = rules.keyEditable ? await uniqueKey(tx, generateSlug(input.headline), null) : null;
      const options = rules.defaultPublishOptions(input.mediaListKeys.length > 0);
      const [row] = await tx
        .insert(newsReleases)
        .values({
          type, key, leadMinistryKey: lead, activityId: input.activityId,
          publishAt: input.publishAt ? new Date(input.publishAt) : null,
          toWeb: options.toWeb, toSubscribers: options.toSubscribers, toMediaLists: options.toMediaLists,
        })
        .returning({ id: newsReleases.id });
      const id = row!.id;
      await tx.insert(releaseLanguages).values({
        releaseId: id, languageId: LANG_EN, location: input.location,
        // Advisories carry no summary (spec §4).
        summary: rules.categoriesBeyondMinistries ? summaryFromBody(body) : "",
        summaryEdited: false,
      });
      const [doc] = await tx.insert(releaseDocuments).values({ releaseId: id, sortIndex: 0, layout: input.layout }).returning({ id: releaseDocuments.id });
      await tx.insert(documentLanguages).values({
        documentId: doc!.id, languageId: LANG_EN, pageTitle: input.pageTitle, headline: input.headline, subheadline: input.subheadline,
        organizations: input.layout === "formal" ? input.organizations : null,
        byline: input.layout === "informal" ? input.byline : null,
        bodyHtml: body, pageImageId: input.pageImageId,
      });
      await replaceContacts(tx, doc!.id, LANG_EN, input.contacts);
      await replaceCategories(tx, id, input);
      await replaceMediaLists(tx, id, listIds);
      await writeLog(tx, id, actor, `Created ${TYPE_LABEL[type]}`);
      return (await loadView(tx, id))!;
    }),
  );
}

export function saveSettings(db: Db, id: string, input: SettingsInput, actor: Actor): Promise<ReleaseView> {
  return mutateRelease(db, id, input.version, actor, async (tx, row) => {
    const rules = typeRules(row.type);
    assertTypeAllows(row.type, { mediaListKeys: input.mediaListKeys });
    const listIds = await mediaListIds(tx, input.mediaListKeys);
    const current = await tx
      .select({ key: mediaLists.key })
      .from(releaseMediaLists)
      .innerJoin(mediaLists, eq(mediaLists.id, releaseMediaLists.mediaListId))
      .where(eq(releaseMediaLists.releaseId, row.id));
    const listsChanged = current.length !== input.mediaListKeys.length || current.some((c) => !input.mediaListKeys.includes(c.key));
    if (listsChanged && rules.mediaListsLockAfterRelease && row.releasedAt) {
      throw new ReleaseStateError(`The media distribution lists of a ${TYPE_LABEL[row.type]} can't change once it has been released.`);
    }

    let toSubscribers: boolean;
    if (rules.nodAllowed) toSubscribers = input.toSubscribers;
    else if (row.type === "update") toSubscribers = row.toSubscribers; // imported Updates keep what they had
    else if (input.toSubscribers) throw new ReleaseRuleError([`A ${TYPE_LABEL[row.type]} can't be sent to News On Demand subscribers.`]);
    else toSubscribers = false;

    const planned = input.plannedPublishAt ? new Date(input.plannedPublishAt) : null;
    let publishAt = row.publishAt;
    // A live release (e.g. a failed correction) keeps its time; schedule/cancel change committed times.
    if (PLANNING_STATUSES.has(row.status) && !row.live) publishAt = planned;
    else if (planned && planned.getTime() !== row.publishAt?.getTime()) {
      throw new ReleaseStateError("The publish time can only be planned while the release is a draft, approved or failed (and not live).");
    }

    await tx
      .update(newsReleases)
      .set({ activityId: input.activityId, publishAt, toSubscribers, toMediaLists: input.mediaListKeys.length > 0 })
      .where(eq(newsReleases.id, row.id));
    if (listsChanged) await replaceMediaLists(tx, row.id, listIds);
    return "Updated publish settings";
  });
}

export function saveCategories(db: Db, id: string, input: CategoriesInput, actor: Actor): Promise<ReleaseView> {
  return mutateRelease(db, id, input.version, actor, async (tx, row) => {
    assertTypeAllows(row.type, input);
    await assertKnownCategories(tx, input);
    const lead = leadOf(input.leadMinistryKey, input.ministries);
    await tx.update(newsReleases).set({ leadMinistryKey: lead }).where(eq(newsReleases.id, row.id));
    await replaceCategories(tx, row.id, input);
    return "Updated categories";
  });
}

export function saveAsset(db: Db, id: string, input: AssetInput, actor: Actor): Promise<ReleaseView> {
  return mutateRelease(db, id, input.version, actor, async (tx, row) => {
    if (!typeRules(row.type).assetsAllowed && (input.assetUrl || input.assetAltText || input.hasMediaAssets)) {
      throw new ReleaseRuleError([`A ${TYPE_LABEL[row.type]} has no media asset.`]);
    }
    const problem = input.assetUrl ? (assetUrlProblem(input.assetUrl) ?? flickrAssetProblem(input.assetUrl)) : null;
    if (problem) throw new ReleaseRuleError([problem]);
    await tx
      .update(newsReleases)
      .set({ assetUrl: input.assetUrl, assetAltText: input.assetAltText, hasMediaAssets: input.hasMediaAssets })
      .where(eq(newsReleases.id, row.id));
    // Re-adding a photo NRMS gave up on (see media/flickr-jobs.ts) starts over with a fresh job.
    await tx.delete(flickrJobs).where(and(eq(flickrJobs.releaseId, row.id), eq(flickrJobs.status, "gave_up")));
    return "Updated media asset";
  });
}

export function saveMeta(db: Db, id: string, input: MetaInput, actor: Actor): Promise<ReleaseView> {
  return keyRace(
    mutateRelease(db, id, input.version, actor, async (tx, row) => {
      const rules = typeRules(row.type);
      if (!rules.categoriesBeyondMinistries && (input.summary.trim() || input.keywords?.trim() || input.socialMediaSummary?.trim())) {
        throw new ReleaseRuleError([`A ${TYPE_LABEL[row.type]} has no summary, keywords or social media summary.`]);
      }
      let key = row.key;
      if (input.key !== null && input.key !== row.key) {
        if (!rules.keyEditable || !EDITABLE_KEY_STATUSES.has(row.status)) {
          throw new ReleaseStateError(`The URL key of this ${TYPE_LABEL[row.type]} can't be changed now.`);
        }
        key = await uniqueKey(tx, generateSlug(input.key), row.id);
      }
      const [en] = await tx
        .select()
        .from(releaseLanguages)
        .where(and(eq(releaseLanguages.releaseId, row.id), eq(releaseLanguages.languageId, LANG_EN)));
      const summaryEdited = (en?.summaryEdited ?? false) || input.summary !== (en?.summary ?? "");
      await tx
        .update(newsReleases)
        .set({ key, redirectUrl: input.redirectUrl, keywords: input.keywords })
        .where(eq(newsReleases.id, row.id));
      await tx
        .insert(releaseLanguages)
        .values({ releaseId: row.id, languageId: LANG_EN, location: input.location, summary: input.summary, summaryEdited, socialMediaSummary: input.socialMediaSummary })
        .onConflictDoUpdate({
          target: [releaseLanguages.releaseId, releaseLanguages.languageId],
          set: { location: input.location, summary: input.summary, summaryEdited, socialMediaSummary: input.socialMediaSummary },
        });
      return "Updated page details";
    }),
  );
}

export async function saveDocumentLanguage(
  db: Db,
  id: string,
  documentId: string,
  languageId: LanguageId,
  input: DocumentLanguageInput,
  actor: Actor,
  deps?: EmbedDeps,
): Promise<ReleaseView> {
  const body = await normalizedBody(input.bodyHtml, deps);
  return keyRace(
    mutateRelease(db, id, input.version, actor, async (tx, row) => {
      const rules = typeRules(row.type);
      assertTypeAllows(row.type, { pageImageId: input.pageImageId });
      const doc = await documentOf(tx, row.id, documentId);
      const [existing] = await tx
        .select()
        .from(documentLanguages)
        .where(and(eq(documentLanguages.documentId, doc.id), eq(documentLanguages.languageId, languageId)));
      if (!existing) throw new ReleaseNotFoundError(`document ${documentId} language ${languageId}`);
      if (input.layout !== doc.layout) {
        if ((await documentLanguageIds(tx, doc.id)).length > 1) {
          throw new ReleaseStateError("The layout can't change on a document that has a translation.");
        }
        await tx.update(releaseDocuments).set({ layout: input.layout }).where(eq(releaseDocuments.id, doc.id));
      }
      const layout: Layout = input.layout;
      await tx
        .update(documentLanguages)
        .set({
          pageTitle: input.pageTitle, headline: input.headline, subheadline: input.subheadline,
          organizations: layout === "formal" ? input.organizations : null,
          byline: layout === "informal" ? input.byline : null,
          bodyHtml: body, pageImageId: input.pageImageId,
        })
        .where(and(eq(documentLanguages.documentId, doc.id), eq(documentLanguages.languageId, languageId)));
      await replaceContacts(tx, doc.id, languageId, input.contacts);

      if (isFirstEnglish(doc.sortIndex, languageId)) {
        const [en] = await tx
          .select()
          .from(releaseLanguages)
          .where(and(eq(releaseLanguages.releaseId, row.id), eq(releaseLanguages.languageId, LANG_EN)));
        if (en && !en.summaryEdited && rules.categoriesBeyondMinistries) {
          await tx
            .update(releaseLanguages)
            .set({ summary: summaryFromBody(body) })
            .where(and(eq(releaseLanguages.releaseId, row.id), eq(releaseLanguages.languageId, LANG_EN)));
        }
        if (rules.keyEditable && EDITABLE_KEY_STATUSES.has(row.status) && input.headline !== existing.headline) {
          const key = await uniqueKey(tx, generateSlug(input.headline), row.id);
          await tx.update(newsReleases).set({ key }).where(eq(newsReleases.id, row.id));
        }
      }
      return `Edited document ${doc.sortIndex + 1} (${languageName(languageId)})`;
    }),
  );
}

export function addDocument(db: Db, id: string, input: AddDocumentInput, actor: Actor): Promise<ReleaseView> {
  return mutateRelease(db, id, input.version, actor, async (tx, row) => {
    const [{ top } = { top: null }] = await tx.select({ top: max(releaseDocuments.sortIndex) }).from(releaseDocuments).where(eq(releaseDocuments.releaseId, row.id));
    const [doc] = await tx
      .insert(releaseDocuments)
      .values({ releaseId: row.id, sortIndex: top === null ? 0 : top + 1, layout: input.layout })
      .returning({ id: releaseDocuments.id });
    await tx.insert(documentLanguages).values({ documentId: doc!.id, languageId: LANG_EN, pageTitle: input.pageTitle });
    return "Added a document";
  });
}

export function addTranslation(db: Db, id: string, documentId: string, input: AddTranslationInput, actor: Actor): Promise<ReleaseView> {
  return mutateRelease(db, id, input.version, actor, async (tx, row) => {
    if (input.languageId !== LANG_FR) throw new ReleaseRuleError(["Only a French translation can be added."]);
    const doc = await documentOf(tx, row.id, documentId);
    const langs = await tx.select().from(documentLanguages).where(eq(documentLanguages.documentId, doc.id));
    if (langs.some((l) => l.languageId === LANG_FR)) throw new ReleaseStateError("This document already has a French translation.");
    const en = langs.find((l) => l.languageId === LANG_EN);
    await tx.insert(documentLanguages).values({
      documentId: doc.id, languageId: LANG_FR, pageTitle: en?.pageTitle ?? "", pageImageId: en?.pageImageId ?? null,
    });
    const [enRelease] = await tx
      .select({ location: releaseLanguages.location })
      .from(releaseLanguages)
      .where(and(eq(releaseLanguages.releaseId, row.id), eq(releaseLanguages.languageId, LANG_EN)));
    await tx
      .insert(releaseLanguages)
      .values({ releaseId: row.id, languageId: LANG_FR, location: enRelease?.location ?? "" })
      .onConflictDoNothing();
    return "Added a French translation";
  });
}

export function removeDocument(db: Db, id: string, documentId: string, version: number, actor: Actor): Promise<ReleaseView> {
  return mutateRelease(db, id, version, actor, async (tx, row) => {
    await documentOf(tx, row.id, documentId);
    await removeDocumentRows(tx, row.id, documentId);
    return "Removed a document";
  });
}

export function removeTranslation(db: Db, id: string, documentId: string, languageId: LanguageId, version: number, actor: Actor): Promise<ReleaseView> {
  return mutateRelease(db, id, version, actor, async (tx, row) => {
    const doc = await documentOf(tx, row.id, documentId);
    if (languageId === LANG_EN) {
      // The English language is the document.
      await removeDocumentRows(tx, row.id, doc.id);
      return "Removed a document";
    }
    if (!(await documentLanguageIds(tx, doc.id)).includes(languageId)) throw new ReleaseNotFoundError(`document ${documentId} language ${languageId}`);
    await tx.delete(documentContacts).where(and(eq(documentContacts.documentId, doc.id), eq(documentContacts.languageId, languageId)));
    await tx.delete(documentLanguages).where(and(eq(documentLanguages.documentId, doc.id), eq(documentLanguages.languageId, languageId)));
    await pruneReleaseLanguages(tx, row.id);
    return "Removed a translation";
  });
}

export function reorderDocuments(db: Db, id: string, input: ReorderDocumentsInput, actor: Actor): Promise<ReleaseView> {
  return mutateRelease(db, id, input.version, actor, async (tx, row) => {
    const docs = await tx.select({ id: releaseDocuments.id }).from(releaseDocuments).where(eq(releaseDocuments.releaseId, row.id));
    const wanted = new Set(input.documentIds);
    if (wanted.size !== input.documentIds.length || wanted.size !== docs.length || docs.some((d) => !wanted.has(d.id))) {
      throw new ReleaseRuleError(["The document order doesn't match this release's documents — reload and try again."]);
    }
    for (const [i, docId] of input.documentIds.entries()) await tx.update(releaseDocuments).set({ sortIndex: i }).where(eq(releaseDocuments.id, docId));
    return "Reordered documents";
  });
}

/** Without a reference the release is deleted for good; with one it's hidden (status `deleted`). */
/**
 * Deletes a draft/approved/failed release: hard-deletes one that never got a reference, hides one
 * that did. A hard delete also removes its uploaded files from `store` afterwards (best effort —
 * failures are logged, the delete itself already committed). A hidden release keeps its files.
 */
export async function deleteRelease(db: Db, id: string, version: number, actor: Actor, store?: ObjectStore): Promise<"deleted" | "hidden"> {
  let outcome: "deleted" | "hidden" = "hidden";
  let storedKeys: string[] = [];
  await mutateRelease(
    db,
    id,
    version,
    actor,
    async (tx, row: NewsReleaseRow) => {
      if (!DELETABLE_STATUSES.has(row.status)) throw new ReleaseStateError("Only a draft, approved or failed release can be deleted.");
      // A live release (e.g. a failed correction) has to be unpublished, not hidden.
      if (row.live) throw new ReleaseStateError("This release has been published — unpublish it first.");
      if (!row.reference) {
        storedKeys = (await tx.select({ key: releaseFiles.storageKey }).from(releaseFiles).where(eq(releaseFiles.releaseId, row.id))).map((f) => f.key);
        await tx.delete(newsReleases).where(eq(newsReleases.id, row.id));
        outcome = "deleted";
        return null; // the row (and its log) is gone
      }
      await tx.update(newsReleases).set({ status: "deleted" }).where(eq(newsReleases.id, row.id));
      outcome = "hidden";
      return "Deleted Release";
    },
    { correction: false },
  );
  if (store && storedKeys.length) await deleteStoredFiles(store, storedKeys); // only set on a hard delete
  return outcome;
}
