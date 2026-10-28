import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "@gcpe/db-kit";
import { LANG_EN } from "@gcpe/nrms-contract";
import type { EventEnvelope, EventHandler, OrgSucceeded } from "@gcpe/events";
import { documentLanguages, newsReleases, releaseDocuments } from "./db/schema";

/**
 * Core hands ministry `e.key` to `successorKeys[0]` (new-government spec §4). Only drafts move:
 * an approved release already carries its number, key and lead, and rewriting those would change
 * published history. A redelivery is a no-op. There is no counter seed: release numbers are counted
 * per printed abbreviation (numbering.ts), so a successor that takes HLTH continues HLTH's count by
 * construction, in any event order.
 */
export async function applySuccession(tx: Tx, e: OrgSucceeded): Promise<{ drafts: number }> {
  const from = e.key.toLowerCase();
  const to = e.successorKeys[0]!.toLowerCase();
  let drafts = 0;

  if (e.moveDrafts && from !== to) {
    const draftIds = tx.select({ id: newsReleases.id }).from(newsReleases).where(eq(newsReleases.status, "draft"));
    // Lead first, then the category rows of every draft that lists the ministry (a draft can list it without leading).
    const leading = await tx
      .update(newsReleases)
      .set({ leadMinistryKey: to, version: sql`${newsReleases.version} + 1`, updatedAt: sql`now()` })
      .where(and(eq(newsReleases.status, "draft"), eq(newsReleases.leadMinistryKey, from)))
      .returning({ id: newsReleases.id });
    // Drop the old row where the draft already lists the successor (primary key would collide), re-point the rest.
    const listing = await tx.execute<{ release_id: string }>(sql`
      WITH gone AS (
        DELETE FROM release_categories rc
        WHERE rc.kind = 'ministries' AND rc.key = ${from} AND rc.release_id IN (${draftIds})
          AND EXISTS (SELECT 1 FROM release_categories o WHERE o.release_id = rc.release_id AND o.kind = 'ministries' AND o.key = ${to})
        RETURNING rc.release_id
      ), moved AS (
        UPDATE release_categories SET key = ${to}
        WHERE kind = 'ministries' AND key = ${from} AND release_id IN (${draftIds})
          AND NOT EXISTS (SELECT 1 FROM release_categories o WHERE o.release_id = release_categories.release_id AND o.kind = 'ministries' AND o.key = ${to})
        RETURNING release_id
      )
      SELECT release_id FROM gone UNION SELECT release_id FROM moved`);
    const touched = new Set([...leading.map((r) => r.id), ...listing.rows.map((r) => r.release_id)]);
    const listedOnly = [...touched].filter((id) => !leading.some((r) => r.id === id));
    if (listedOnly.length) {
      await tx.update(newsReleases).set({ version: sql`${newsReleases.version} + 1`, updatedAt: sql`now()` }).where(inArray(newsReleases.id, listedOnly));
    }
    drafts = touched.size;
  }

  return { drafts };
}

/** Core's org.succeeded → applySuccession. */
export function successionHandler(event: EventEnvelope): EventHandler | undefined {
  if (event.source !== "core" || event.type !== "org.succeeded") return undefined;
  return async (tx, e) => void (await applySuccession(tx, e.data as OrgSucceeded));
}

export interface OpenReleases {
  drafts: { id: string; headline: string }[];
  notMoved: { id: string; headline: string; status: string; key: string | null }[];
}

/** What a hand-over of `key` would and would not take: every draft that leads with or lists it moves; approved/scheduled/publishing releases it leads keep their lead. */
export async function openReleasesOf(db: DbOrTx, key: string): Promise<OpenReleases> {
  const k = key.toLowerCase();
  const headline = sql<string>`coalesce((SELECT dl.headline FROM ${releaseDocuments} d JOIN ${documentLanguages} dl ON dl.document_id = d.id AND dl.language_id = ${LANG_EN}
    WHERE d.release_id = news_releases.id ORDER BY d.sort_index LIMIT 1), '')`;
  const rows = await db
    .select({ id: newsReleases.id, headline, status: newsReleases.status, key: newsReleases.key })
    .from(newsReleases)
    .where(
      or(
        // Every draft applySuccession would move: led by the ministry, or merely listing it.
        and(
          eq(newsReleases.status, "draft"),
          or(
            eq(newsReleases.leadMinistryKey, k),
            sql`EXISTS (SELECT 1 FROM release_categories rc WHERE rc.release_id = news_releases.id AND rc.kind = 'ministries' AND rc.key = ${k})`,
          ),
        ),
        and(eq(newsReleases.leadMinistryKey, k), inArray(newsReleases.status, ["approved", "scheduled", "publishing"])),
      ),
    )
    .orderBy(newsReleases.createdAt, newsReleases.id);
  return {
    drafts: rows.filter((r) => r.status === "draft").map((r) => ({ id: r.id, headline: r.headline })),
    notMoved: rows.filter((r) => r.status !== "draft"),
  };
}
