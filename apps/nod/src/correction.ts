/**
 * Corrected copies (owner decision 2026-10-31): when a release that already went out is
 * republished and the editor ticks "Also email it again?", the people who already got it are
 * emailed the corrected release again, with "Corrected: " before the subject. Per tick:
 * subscribers (who got it As it happens or in a daily digest) and media lists (who got its media
 * email). Nobody new, nobody since unsubscribed or made inactive, one copy per person per
 * correction (the media copy wins, as the first send's "one copy per person per release").
 *
 * N2 (owner 2026-10-31): a subscriber's copy comes the way they got the release. Someone who got
 * it As it happens gets the As-It-Happens template; someone who got it only in a daily digest gets
 * a one-item daily digest ("Corrected: " before the digest's subject), sent straight away. Someone
 * who got it both ways gets one copy, the As-It-Happens one.
 *
 * Each correction is its own deliberate send: its jobs are keyed by the release's correction
 * number (`correction:<n>:<kind>:<key>`), separate from the first send's `as_it_happens:<key>` and
 * `media:<key>`, so a normal republish still never re-emails anyone. Its deliveries are mode
 * `correction:<n>`, so the deliveries key (item, subscriber, mode) gives one copy per person per
 * correction. NRMS repeats its latest request on every later republish of the release (an event
 * can be overtaken or given up on); `items.corrections_sent` makes each number act once. The jobs are ordinary send jobs: a pause holds them, they show
 * as held on Operations and can be cancelled there, and the sender cancels them if the release is
 * taken off the site first.
 */
import { and, eq, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx, Tx } from "@gcpe/db-kit";
import { renderDigestItems } from "./digest";
import { correctionMode, items, sendJobs, type ItemRow } from "./db/schema";
import { correctionMediaRecipient, correctionSubscriberRecipient } from "./recipients";
import { correctedSubject, itemCategories, renderAsItHappens, renderDigest, renderMedia, type Rendered, type RenderOptions } from "./render";
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

type CorrectionKind = "correction" | "correction_digest" | "correction_media";
/** Each corrected-copy kind's job-key part and Distribution priority, as its first send's. */
const KIND_SHAPE: Record<CorrectionKind, { part: string; priority: "immediate" | "digest" | "media" }> = {
  correction: { part: "as_it_happens", priority: "immediate" },
  correction_digest: { part: "digest", priority: "digest" },
  correction_media: { part: "media", priority: "media" },
};

/** Creates one corrected-copy job and its deliveries/recipients; the number of people it reaches
 * (0 when the job already existed or nobody qualifies, and then no job is left behind). */
async function createJob(tx: Tx, itemKey: string, seq: number, kind: CorrectionKind, rendered: Rendered, recipient: SQL): Promise<number> {
  const { part, priority } = KIND_SHAPE[kind];
  const jobKey = `correction:${seq}:${part}:${itemKey}`;
  const created = await tx
    .insert(sendJobs)
    .values({ jobKey, itemKey, kind, priority, subject: correctedSubject(rendered.subject), html: rendered.html, text: rendered.text })
    .onConflictDoNothing({ target: sendJobs.jobKey })
    .returning({ id: sendJobs.id });
  if (created.length === 0) return 0;
  const jobId = created[0]!.id;
  // ON CONFLICT DO NOTHING on (item, subscriber, 'correction:<n>'): someone already given this
  // correction's media copy gets no subscriber copy as well, and someone given its As-It-Happens
  // copy no digest copy.
  const inserted = await tx.execute(sql`
    INSERT INTO deliveries (item_key, subscriber_id, mode, job_id)
    SELECT ${itemKey}, s.id, ${correctionMode(seq)}, ${jobId}::uuid
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
 * subscriber copies to everyone left: the As-It-Happens template to those who got it As it
 * happens, then a one-item daily digest to those who got it only in a digest. Nothing for a release that's off
 * the site or that NoD never had. Writes one NoD log row naming who asked and when.
 */
export async function createCorrectionSends(tx: Tx, itemKey: string, req: CorrectionRequest, render: RenderOptions): Promise<{ subscribers: number; mediaContacts: number }> {
  // Locked, so two deliveries of the same number can't both act on it.
  const [item] = await tx.select().from(items).where(eq(items.key, itemKey)).for("update");
  if (!item || item.withdrawnAt !== null || item.kind !== "release") return { subscribers: 0, mediaContacts: 0 };
  // Already acted on (a repeat of the latest request, or an older one arriving late).
  if (req.seq <= item.correctionsSent) return { subscribers: 0, mediaContacts: 0 };
  await tx.update(items).set({ correctionsSent: req.seq }).where(eq(items.key, itemKey));
  const base = await renderBase(tx, item);

  let mediaContacts = 0;
  if (req.mediaLists && item.mediaText !== null && item.mediaListKeys.length > 0) {
    const rendered = renderMedia({ ...base, mediaText: item.mediaText, postKind: item.postKind }, render);
    mediaContacts = await createJob(tx, itemKey, req.seq, "correction_media", rendered, correctionMediaRecipient(itemKey, sql`${sql.param(item.mediaListKeys)}::text[]`));
  }
  let subscribers = 0;
  // An advisory never goes to subscribers (its normal send is media lists only), whatever NRMS asked.
  if (req.subscribers && item.postKind !== "advisories") {
    const listKeys = sql`${sql.param(item.listKeys)}::text[]`;
    subscribers = await createJob(tx, itemKey, req.seq, "correction", renderAsItHappens(base, render), correctionSubscriberRecipient(itemKey, listKeys, ["as_it_happens"]));
    subscribers += await createJob(tx, itemKey, req.seq, "correction_digest", renderDigest([base], render), correctionSubscriberRecipient(itemKey, listKeys, ["digest"]));
  }

  const asked = [req.subscribers && plural(subscribers, "subscriber"), req.mediaLists && plural(mediaContacts, "media contact")].filter(Boolean).join(", ");
  await writeOpsLog(tx, req.requestedBy, "correction-emailed", `${itemKey} "${item.title}", correction ${req.seq}, asked for at ${req.requestedAt}: ${asked}`);
  return { subscribers, mediaContacts };
}

async function renderBase(tx: DbOrTx, item: ItemRow) {
  const categories = await itemCategories(tx, item.listKeys);
  return { key: item.key, title: item.title, summary: item.summary, url: item.url, publishedAt: item.publishedAt, categories };
}

/**
 * Review I4: after a release is corrected (its item refreshed, same transaction), every email of it
 * still waiting is rebuilt from the corrected release, so someone whose first email a pause is
 * holding gets the right content: its As-It-Happens and media jobs, its corrected copies (still
 * "Corrected: ", a digest copy still a one-item digest), and each daily digest carrying it (rebuilt from its items, as the sender does when
 * one is withdrawn). Only a job nothing of which has gone yet: pending, not claimed by the sender
 * (the same test as an unpublish), no part handed to Distribution, no delivery attempted -- a part
 * already handed off is never re-sent with different content under the same key. Returns how many
 * jobs were rebuilt.
 */
export async function rerenderWaitingEmail(tx: Tx, itemKey: string, render: RenderOptions): Promise<number> {
  const [item] = await tx.select().from(items).where(eq(items.key, itemKey));
  if (!item || item.kind !== "release" || item.withdrawnAt !== null) return 0;
  const { rows } = await tx.execute<{ id: string; kind: string }>(sql`
    SELECT j.id, j.kind FROM send_jobs j
     WHERE j.status = 'pending'
       AND (j.locked_until IS NULL OR j.locked_until <= now())
       AND j.batch_ids = '{}'::jsonb
       AND NOT EXISTS (SELECT 1 FROM deliveries a WHERE a.job_id = j.id AND a.attempted_at IS NOT NULL)
       AND (j.item_key = ${itemKey}
            OR (j.kind = 'digest' AND j.id IN (SELECT d.job_id FROM deliveries d WHERE d.item_key = ${itemKey} AND d.mode = 'digest' AND d.attempted_at IS NULL)))
     FOR UPDATE OF j`);
  if (rows.length === 0) return 0;
  const base = await renderBase(tx, item);
  const media = item.mediaText !== null ? renderMedia({ ...base, mediaText: item.mediaText, postKind: item.postKind }, render) : null;
  const single = renderAsItHappens(base, render);
  let count = 0;
  for (const job of rows) {
    let rendered: Rendered | null = null;
    if (job.kind === "as_it_happens") rendered = single;
    else if (job.kind === "media") rendered = media;
    else if (job.kind === "correction") rendered = { ...single, subject: correctedSubject(single.subject) };
    else if (job.kind === "correction_digest") {
      const digest = renderDigest([base], render);
      rendered = { ...digest, subject: correctedSubject(digest.subject) };
    } else if (job.kind === "correction_media") rendered = media && { ...media, subject: correctedSubject(media.subject) };
    else if (job.kind === "digest") {
      const { rows: keys } = await tx.execute<{ item_key: string }>(sql`SELECT DISTINCT item_key FROM deliveries WHERE job_id = ${job.id}::uuid`);
      rendered = await renderDigestItems(tx, keys.map((k) => k.item_key), render);
    }
    if (!rendered) continue;
    const res = await tx
      .update(sendJobs)
      .set({ subject: rendered.subject, html: rendered.html, text: rendered.text })
      .where(and(eq(sendJobs.id, job.id), eq(sendJobs.status, "pending"), or(isNull(sendJobs.lockedUntil), lte(sendJobs.lockedUntil, sql`now()`))));
    count += res.rowCount ?? 0;
  }
  return count;
}
