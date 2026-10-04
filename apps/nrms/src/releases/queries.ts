import { and, asc, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { ReleaseRecord } from "@gcpe/events";
import {
  LANG_EN, POST_KIND, statusText, type ListQuery, type ReleaseListItem, type ReleasePage, type ReleaseStatus, type ReleaseType, type SearchQuery,
} from "@gcpe/nrms-contract";
import {
  documentLanguages, mediaLists, newsReleases, organizations, pageImageLanguages, pageImages, pageTypes, releaseCategories, releaseDocuments,
  releaseLanguages, releaseLog as releaseLogTable, releasePublications, type NewsReleaseRow,
} from "../db/schema";

export interface QueryOptions {
  timeZone: string;
  nowMs: number;
}

export const SEARCH_PAGE_SIZE = 20;

const FOLDER_STATUSES: Record<ListQuery["folder"], ReleaseStatus[]> = {
  drafts: ["draft", "approved", "failed"],
  scheduled: ["scheduled"],
  published: ["published", "publishing", "unpublishing"],
};

/** The instant local midnight starts on the day after `nowMs`'s local date in `timeZone`. */
export function startOfTomorrow(nowMs: number, timeZone: string): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const parts = (ms: number) => {
    const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, x.value]));
    return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
  };
  /** Local wall-clock minus UTC at `ms`. */
  const offset = (ms: number) => {
    const p = parts(ms);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
  };
  const today = parts(nowMs);
  const wall = Date.UTC(today.y, today.m - 1, today.d + 1);
  // Two passes settle the offset when a DST change falls between now and tomorrow's midnight.
  const guess = wall - offset(wall);
  return new Date(wall - offset(guess));
}

/** The first document's English headline (the list/search display headline). */
const firstHeadline = sql<string>`(SELECT dl.headline FROM ${releaseDocuments} d JOIN ${documentLanguages} dl ON dl.document_id = d.id AND dl.language_id = ${LANG_EN}
  WHERE d.release_id = ${newsReleases.id} ORDER BY d.sort_index LIMIT 1)`;

async function pageOf(db: DbOrTx, where: SQL | undefined, order: SQL[], page: number, pageSize: number, opts: QueryOptions): Promise<ReleasePage<ReleaseListItem>> {
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(newsReleases).where(where);
  const rows = n === 0 ? [] : await db.select().from(newsReleases).where(where).orderBy(...order, asc(newsReleases.id)).limit(pageSize).offset((page - 1) * pageSize);
  return { items: await listItems(db, rows, opts.nowMs), total: n, page, pageSize };
}

export function listFolder(db: DbOrTx, q: ListQuery, opts: QueryOptions): Promise<ReleasePage<ReleaseListItem>> {
  const where = and(inArray(newsReleases.status, FOLDER_STATUSES[q.folder]), q.type === "all" ? undefined : eq(newsReleases.type, q.type));
  let order: SQL[];
  if (q.folder === "drafts") {
    const tomorrow = startOfTomorrow(opts.nowMs, opts.timeZone).toISOString();
    order = [
      sql`CASE WHEN ${newsReleases.publishAt} IS NULL THEN 1 WHEN ${newsReleases.publishAt} < ${tomorrow}::timestamptz THEN 0 ELSE 2 END`,
      asc(newsReleases.publishAt),
      desc(newsReleases.updatedAt),
    ];
  } else if (q.folder === "scheduled") {
    order = [asc(newsReleases.publishAt)];
  } else {
    order = [sql`${newsReleases.releasedAt} DESC NULLS LAST`];
  }
  return pageOf(db, where, order, q.page, q.pageSize, opts);
}

const ACTIVITY_QUERY = /^[A-Za-z]+-(\d+)$/;
const MAX_INT = 2_147_483_647;
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function searchReleases(db: DbOrTx, q: SearchQuery, opts: QueryOptions): Promise<ReleasePage<ReleaseListItem>> {
  const filters: (SQL | undefined)[] = [ne(newsReleases.status, "deleted")];
  const activity = ACTIVITY_QUERY.exec(q.q);
  if (activity && !/^NEWS-/i.test(q.q)) {
    const n = Number(activity[1]);
    filters.push(n <= MAX_INT ? eq(newsReleases.activityId, n) : sql`false`);
  } else if (q.q) {
    filters.push(sql`EXISTS (SELECT 1 FROM ${releaseDocuments} d JOIN ${documentLanguages} dl ON dl.document_id = d.id
      WHERE d.release_id = ${newsReleases.id} AND dl.headline ILIKE ${`%${likeEscape(q.q)}%`})`);
  }
  const inCategory = (kind: "ministries" | "sectors", key: string) =>
    sql`EXISTS (SELECT 1 FROM ${releaseCategories} c WHERE c.release_id = ${newsReleases.id} AND c.kind = ${kind} AND c.key = ${key})`;
  if (q.ministry) filters.push(inCategory("ministries", q.ministry));
  if (q.sector) filters.push(inCategory("sectors", q.sector));
  const order = [sql`coalesce(${newsReleases.releasedAt}, ${newsReleases.publishAt}) DESC NULLS LAST`, sql`${firstHeadline} ASC`];
  return pageOf(db, and(...filters), order, q.page, SEARCH_PAGE_SIZE, opts);
}

/** Legacy GetFirstOrganization. */
function leadOrganization(r: NewsReleaseRow, ministries: string[], names: Map<string, string>, doc: { organizations: string | null; byline: string | null } | undefined): string {
  const lead = r.leadMinistryKey ? names.get(r.leadMinistryKey) : undefined;
  if (lead) return lead;
  const firstOrg = (doc?.organizations ?? "").split(/\r?\n/)[0]!.trim();
  if (firstOrg) return firstOrg.startsWith("Ministry of ") ? firstOrg.slice("Ministry of ".length) : firstOrg;
  const minister = (doc?.byline ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("Minister of "));
  if (minister) return minister.slice("Minister of ".length);
  if (ministries.length === 1) return names.get(ministries[0]!) ?? "";
  return "";
}

/** Batched: one query each for release languages, first documents, ministries and organization names. */
export async function listItems(db: DbOrTx, rows: NewsReleaseRow[], nowMs: number): Promise<ReleaseListItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const langs = await db
    .select({ releaseId: releaseLanguages.releaseId, location: releaseLanguages.location, summary: releaseLanguages.summary })
    .from(releaseLanguages)
    .where(and(inArray(releaseLanguages.releaseId, ids), eq(releaseLanguages.languageId, LANG_EN)));
  const docs = await db
    .selectDistinctOn([releaseDocuments.releaseId], {
      releaseId: releaseDocuments.releaseId, pageTitle: documentLanguages.pageTitle, headline: documentLanguages.headline,
      organizations: documentLanguages.organizations, byline: documentLanguages.byline,
    })
    .from(releaseDocuments)
    .innerJoin(documentLanguages, and(eq(documentLanguages.documentId, releaseDocuments.id), eq(documentLanguages.languageId, LANG_EN)))
    .where(inArray(releaseDocuments.releaseId, ids))
    .orderBy(releaseDocuments.releaseId, asc(releaseDocuments.sortIndex));
  const cats = await db
    .select({ releaseId: releaseCategories.releaseId, key: releaseCategories.key })
    .from(releaseCategories)
    .where(and(inArray(releaseCategories.releaseId, ids), eq(releaseCategories.kind, "ministries")))
    .orderBy(asc(releaseCategories.key));
  const orgKeys = [...new Set([...rows.flatMap((r) => (r.leadMinistryKey ? [r.leadMinistryKey] : [])), ...cats.map((c) => c.key)])];
  const names = new Map(
    orgKeys.length
      ? (await db.select({ key: organizations.key, name: organizations.displayName }).from(organizations).where(inArray(organizations.key, orgKeys))).map((o) => [o.key, o.name])
      : [],
  );
  const langOf = new Map(langs.map((l) => [l.releaseId, l]));
  const docOf = new Map(docs.map((d) => [d.releaseId, d]));
  return rows.map((r) => {
    const lang = langOf.get(r.id);
    const doc = docOf.get(r.id);
    const ministries = cats.filter((c) => c.releaseId === r.id).map((c) => c.key);
    const publishAt = r.publishAt?.toISOString() ?? null;
    return {
      id: r.id, type: r.type, key: r.key, reference: r.reference, status: r.status,
      statusText: statusText({ status: r.status, type: r.type, reference: r.reference, publishAt }, nowMs),
      leadOrganization: leadOrganization(r, ministries, names, doc),
      pageTitle: doc?.pageTitle ?? "", headline: doc?.headline ?? "", location: (lang?.location ?? "").toUpperCase(), summary: lang?.summary ?? "",
      publishAt, releasedAt: r.releasedAt?.toISOString() ?? null, activityId: r.activityId, approved: r.reference !== null,
      flickrAlert: r.flickrAlert,
    };
  });
}

const TYPE_BY_KIND = new Map<string, ReleaseType>(Object.entries(POST_KIND).map(([type, kind]) => [kind, type as ReleaseType]));
const PATH_KEY = /(?:^|\/)(releases|stories|factsheets|updates|advisories)\/([^/?#]+)\/?$/i;

/** Legacy GetSearchUrl: a public URL/path, a 5-digit number, a NEWS- reference, or an exact key. Returns the release id. */
export async function goTo(db: DbOrTx, q: string): Promise<string | null> {
  const s = q.trim();
  if (!s) return null;
  let path = s;
  if (/^https?:\/\//i.test(s)) {
    try {
      path = new URL(s).pathname;
    } catch {
      return null;
    }
  }
  const visible = ne(newsReleases.status, "deleted");
  const first = async (where: SQL | undefined) =>
    (await db.select({ id: newsReleases.id }).from(newsReleases).where(and(visible, where)).orderBy(desc(newsReleases.createdAt)).limit(1))[0]?.id ?? null;

  const m = PATH_KEY.exec(path);
  if (m) {
    let key: string;
    try {
      key = decodeURIComponent(m[2]!);
    } catch {
      return null;
    }
    return first(and(eq(newsReleases.type, TYPE_BY_KIND.get(m[1]!.toLowerCase())!), sql`lower(${newsReleases.key}) = lower(${key})`));
  }
  if (/^\d{5}$/.test(s)) return first(eq(newsReleases.reference, `NEWS-${s}`));
  if (/^NEWS-\d{5}$/i.test(s)) return first(eq(newsReleases.reference, s.toUpperCase()));
  return (
    (await first(sql`lower(${newsReleases.key}) = lower(${s})`)) ?? (await first(eq(newsReleases.reference, s)))
  );
}

/** True when the id names a release that isn't deleted (history routes 404 otherwise). */
export async function releaseVisible(db: DbOrTx, id: string): Promise<boolean> {
  const [row] = await db.select({ status: newsReleases.status }).from(newsReleases).where(eq(newsReleases.id, id));
  return !!row && row.status !== "deleted";
}

/** Newest first; without `all`, the "Edited …"/"Updated …" lines are hidden (legacy "show all" toggle). */
export async function releaseLog(db: DbOrTx, id: string, all: boolean): Promise<{ at: string; actorName: string; text: string }[]> {
  const t = releaseLogTable;
  const rows = await db
    .select({ at: t.at, actorName: t.actorName, text: t.text })
    .from(t)
    .where(and(eq(t.releaseId, id), all ? undefined : sql`NOT (${t.text} LIKE 'Edited %' OR ${t.text} LIKE 'Updated %')`))
    .orderBy(desc(t.at), desc(t.id));
  return rows.map((r) => ({ at: r.at.toISOString(), actorName: r.actorName, text: r.text }));
}

/** Frozen publications, newest first. */
export async function publications(db: DbOrTx, id: string): Promise<{ id: number; publishedAt: string; actorName: string }[]> {
  const p = releasePublications;
  const rows = await db
    .select({ id: p.id, publishedAt: p.publishedAt, actorName: p.actorName })
    .from(p)
    .where(eq(p.releaseId, id))
    .orderBy(desc(p.publishedAt), desc(p.id));
  return rows.map((r) => ({ id: r.id, publishedAt: r.publishedAt.toISOString(), actorName: r.actorName }));
}

export async function publication(db: DbOrTx, id: string, pubId: number): Promise<ReleaseRecord | null> {
  const [row] = await db
    .select({ record: releasePublications.record })
    .from(releasePublications)
    .where(and(eq(releasePublications.releaseId, id), eq(releasePublications.id, pubId)));
  return row?.record ?? null;
}

export async function listMediaLists(db: DbOrTx): Promise<{ id: string; key: string; name: string }[]> {
  return db
    .select({ id: mediaLists.id, key: mediaLists.key, name: mediaLists.displayName })
    .from(mediaLists)
    .where(eq(mediaLists.isActive, true))
    .orderBy(asc(mediaLists.sortOrder), asc(mediaLists.displayName));
}

export async function listPageTypes(db: DbOrTx) {
  return db
    .select({
      pageTitle: pageTypes.pageTitle, languageId: pageTypes.languageId, releaseType: pageTypes.releaseType, sortOrder: pageTypes.sortOrder,
      layout: pageTypes.layout, pageImageId: pageTypes.pageImageId,
    })
    .from(pageTypes)
    .orderBy(asc(pageTypes.releaseType), asc(pageTypes.languageId), asc(pageTypes.sortOrder), asc(pageTypes.pageTitle));
}

/** Active page images without their bytes; `altTexts` keyed by language id. */
export async function listPageImages(db: DbOrTx): Promise<{ id: string; name: string; sortOrder: number; mimeType: string; altTexts: Record<string, string> }[]> {
  const images = await db
    .select({ id: pageImages.id, name: pageImages.name, sortOrder: pageImages.sortOrder, mimeType: pageImages.mimeType })
    .from(pageImages)
    .where(eq(pageImages.isActive, true))
    .orderBy(asc(pageImages.sortOrder), asc(pageImages.name));
  const ids = images.map((i) => i.id);
  const alts = ids.length ? await db.select().from(pageImageLanguages).where(inArray(pageImageLanguages.imageId, ids)) : [];
  return images.map((i) => ({
    ...i,
    altTexts: Object.fromEntries(alts.filter((a) => a.imageId === i.id).map((a) => [String(a.languageId), a.altText])),
  }));
}
