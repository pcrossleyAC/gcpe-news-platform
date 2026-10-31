/**
 * Corrected copies (owner decision 2026-10-31): when a release that already went out is
 * republished and the editor ticks "Also email it again?", the people who already got it are
 * emailed the corrected release again, with "Corrected: " before the subject. Per tick:
 * subscribers (who got it As it happens or in a daily digest) and media lists (who got its media
 * email). Nobody new, nobody since unsubscribed or made inactive, one copy per person per
 * correction (the media copy wins, as the first send's "one copy per person per release").
 *
 * Each correction is its own deliberate send: its jobs are keyed by the release's correction
 * number (`correction:<n>:<kind>:<key>`), separate from the first send's `as_it_happens:<key>` and
 * `media:<key>`, so a normal republish still never re-emails anyone. Its deliveries are mode
 * `correction` with that number. The jobs are ordinary send jobs: a pause holds them, they show
 * as held on Operations and can be cancelled there, and the sender cancels them if the release is
 * taken off the site first.
 */
import { eq, sql, type SQL } from "drizzle-orm";
import type { DbOrTx, Tx } from "@gcpe/db-kit";
import { items, sendJobs } from "./db/schema";
import { correctionMediaRecipient, correctionSubscriberRecipient } from "./recipients";
import { correctedSubject, itemCategories, renderAsItHappens, renderMedia, type Rendered, type RenderOptions } from "./render";
import { writeOpsLog } from "./settings";

/** What NRMS sends with the republish (the event's `emailAgain`). */
export interface CorrectionRequest {
  /** The release's correction number: 1 for its first corrected copy, then 2, ... */
  seq: number;
  subscribers: boolean;
  mediaLists: boolean;
  /** Who asked for it, by name, and when (ISO), for the NoD log. */
  requestedBy: string;
  requestedAt: string;
}

export interface CorrectionAudienceInput {
  itemKey: string;
  /** The release's list keys as its republish will carry them. */
  listKeys: string[];
  /** Its NoD media list keys as its republish will carry them; empty when no media copy can go. */
  mediaListKeys: string[];
}

/**
 * How many people each tick reaches, by the very rules {@link createCorrectionSends} uses:
 * `subscribers` with only Subscribers ticked, `mediaContacts` with only Media lists ticked, and
 * `both` how many are in both (with both ticked they get one copy, the media one). Read-only.
 */
export async function correctionAudience(db: DbOrTx, input: CorrectionAudienceInput): Promise<{ subscribers: number; mediaContacts: number; both: number }> {
  const keys = sql`${sql.param(input.listKeys.map((k) => k.toLowerCase()))}::text[]`;
  const media = sql`${sql.param(input.mediaListKeys.map((k) => k.toLowerCase()))}::text[]`;
  const sub = correctionSubscriberRecipient(input.itemKey, keys);
  const med = correctionMediaRecipient(input.itemKey, media);
  const { rows } = await db.execute<{ subscribers: number; media: number; both: number }>(sql`
    SELECT count(*) FILTER (WHERE ${sub})::int AS subscribers,
           count(*) FILTER (WHERE ${med})::int AS media,
           count(*) FILTER (WHERE ${sub} AND ${med})::int AS both
      FROM subscribers s`);
  const r = rows[0]!;
  return { subscribers: r.subscribers, mediaContacts: r.media, both: r.both };
}

/** Creates one corrected-copy job and its deliveries/recipients; the number of people it reaches
 * (0 when the job already existed or nobody qualifies, and then no job is left behind). */
async function createJob(tx: Tx, itemKey: string, seq: number, kind: "correction" | "correction_media", rendered: Rendered, recipient: SQL): Promise<number> {
  const jobKey = `correction:${seq}:${kind === "correction_media" ? "media" : "as_it_happens"}:${itemKey}`;
  const created = await tx
    .insert(sendJobs)
    .values({ jobKey, itemKey, kind, priority: kind === "correction_media" ? "media" : "immediate", subject: correctedSubject(rendered.subject), html: rendered.html, text: rendered.text })
    .onConflictDoNothing({ target: sendJobs.jobKey })
    .returning({ id: sendJobs.id });
  if (created.length === 0) return 0;
  const jobId = created[0]!.id;
  // ON CONFLICT DO NOTHING on (item, subscriber, 'correction', seq): someone already given this
  // correction's media copy gets no subscriber copy as well.
  const inserted = await tx.execute(sql`
    INSERT INTO deliveries (item_key, subscriber_id, mode, correction, job_id)
    SELECT ${itemKey}, s.id, 'correction', ${seq}::int, ${jobId}::uuid
      FROM subscribers s
     WHERE ${recipient}
    ON CONFLICT DO NOTHING
    RETURNING 1`);
  if (inserted.rows.length === 0) {
    await tx.delete(sendJobs).where(eq(sendJobs.id, jobId));
    return 0;
  }
  await tx.execute(sql`
    INSERT INTO job_recipients (job_id, subscriber_id)
    SELECT job_id, subscriber_id FROM deliveries WHERE job_id = ${jobId}::uuid
    ON CONFLICT DO NOTHING`);
  return inserted.rows.length;
}

const plural = (n: number, one: string) => `${n.toLocaleString("en-CA")} ${one}${n === 1 ? "" : "s"}`;

/**
 * Makes the corrected copies for `itemKey` from the item as it is now (the republish refreshed
 * it first, in the same transaction): the media copy (the media template) first, then the
 * subscriber copy (the As-It-Happens template) to everyone left. Nothing for a release that's off
 * the site or that NoD never had. Writes one NoD log row naming who asked and when.
 */
export async function createCorrectionSends(tx: Tx, itemKey: string, req: CorrectionRequest, render: RenderOptions): Promise<{ subscribers: number; mediaContacts: number }> {
  const [item] = await tx.select().from(items).where(eq(items.key, itemKey));
  if (!item || item.withdrawnAt !== null || item.kind !== "release") return { subscribers: 0, mediaContacts: 0 };
  const categories = await itemCategories(tx, item.listKeys);
  const base = { key: item.key, title: item.title, summary: item.summary, url: item.url, publishedAt: item.publishedAt, categories };

  let mediaContacts = 0;
  if (req.mediaLists && item.mediaText !== null && item.mediaListKeys.length > 0) {
    const rendered = renderMedia({ ...base, mediaText: item.mediaText, postKind: item.postKind }, render);
    mediaContacts = await createJob(tx, itemKey, req.seq, "correction_media", rendered, correctionMediaRecipient(itemKey, sql`${sql.param(item.mediaListKeys)}::text[]`));
  }
  let subscribers = 0;
  if (req.subscribers) {
    subscribers = await createJob(tx, itemKey, req.seq, "correction", renderAsItHappens(base, render), correctionSubscriberRecipient(itemKey, sql`${sql.param(item.listKeys)}::text[]`));
  }

  const asked = [req.subscribers && plural(subscribers, "subscriber"), req.mediaLists && plural(mediaContacts, "media contact")].filter(Boolean).join(", ");
  await writeOpsLog(tx, req.requestedBy, "correction-emailed", `${itemKey} "${item.title}", correction ${req.seq}, asked for at ${req.requestedAt}: ${asked}`);
  return { subscribers, mediaContacts };
}
