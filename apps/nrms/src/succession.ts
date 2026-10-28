import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "@gcpe/db-kit";
import { LANG_EN } from "@gcpe/nrms-contract";
import type { EventEnvelope, EventHandler, OrgSucceeded } from "@gcpe/events";
import { documentLanguages, newsReleases, releaseDocuments } from "./db/schema";
import { bcYear } from "./releases/numbering";

/**
 * Core hands ministry `e.key` to `successorKeys[0]` (new-government spec §4). Only drafts move:
 * an approved release already carries its number, key and lead, and rewriting those would change
 * published history. Every step is a no-op the second time, so a redelivery is harmless.
 */
export async function applySuccession(tx: Tx, e: OrgSucceeded, timeZone: string): Promise<{ drafts: number }> {
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

  if (e.takeAbbreviation && from !== to) {
    // The successor now signs releases with the predecessor's abbreviation, so its counter must start
    // where the predecessor's stopped (never lower: GREATEST also keeps a redelivery from rewinding it).
    const year = bcYear(new Date(e.at), timeZone);
    await tx.execute(sql`
      INSERT INTO number_counters (scope, year, ministry, last_value)
      SELECT 'ministry', year, ${to}, last_value FROM number_counters WHERE scope = 'ministry' AND year = ${year} AND ministry = ${from}
      ON CONFLICT (scope, year, ministry) DO UPDATE SET last_value = GREATEST(number_counters.last_value, EXCLUDED.last_value)`);
  }
  return { drafts };
}

/** Core's org.succeeded → applySuccession. `timeZone` is the tenant's (WorkflowDeps.timeZone) for the counter's year. */
export function successionHandler(event: EventEnvelope, timeZone = "America/Vancouver"): EventHandler | undefined {
  if (event.source !== "core" || event.type !== "org.succeeded") return undefined;
  return async (tx, e) => void (await applySuccession(tx, e.data as OrgSucceeded, timeZone));
}

export interface OpenReleases {
  drafts: { id: string; headline: string }[];
  notMoved: { id: string; headline: string; status: string; key: string | null }[];
}

/** What a hand-over of `key` would and would not take: drafts move, approved/scheduled/publishing releases keep their lead. */
export async function openReleasesOf(db: DbOrTx, key: string): Promise<OpenReleases> {
  const headline = sql<string>`coalesce((SELECT dl.headline FROM ${releaseDocuments} d JOIN ${documentLanguages} dl ON dl.document_id = d.id AND dl.language_id = ${LANG_EN}
    WHERE d.release_id = news_releases.id ORDER BY d.sort_index LIMIT 1), '')`;
  const rows = await db
    .select({ id: newsReleases.id, headline, status: newsReleases.status, key: newsReleases.key })
    .from(newsReleases)
    .where(and(eq(newsReleases.leadMinistryKey, key.toLowerCase()), inArray(newsReleases.status, ["draft", "approved", "scheduled", "publishing"])))
    .orderBy(newsReleases.createdAt, newsReleases.id);
  return {
    drafts: rows.filter((r) => r.status === "draft").map((r) => ({ id: r.id, headline: r.headline })),
    notMoved: rows.filter((r) => r.status !== "draft"),
  };
}
