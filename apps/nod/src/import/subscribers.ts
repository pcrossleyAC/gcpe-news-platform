import { and, eq, sql } from "drizzle-orm";
import { wallClockToInstant } from "@gcpe/config";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import type { LegacySource } from "@gcpe/legacy-import";
import { legacySubscriberImports, subscribers, subscriptions, type SubscriberSource, type SubscriberStatus } from "../db/schema";
import { lockAddress, withLockedSubscriber } from "../locks";
import { ALL_MEDIA_LISTS, keepOptOutHashes, optedOutKeys } from "../opt-outs";
import { writeHistory } from "../subscribe/history";
import { endLockedSubscriber } from "../subscribe/journeys";
import { normaliseEmail } from "../subscribe/info";
import {
  fingerprintOf,
  guidKey,
  MEDIA_CATEGORY_KEY,
  mapSubscriber,
  pickWinners,
  type LegacySubscriberRow,
  type ListMapping,
  type MappedList,
  type MappedSubscriber,
  type SubscriberState,
} from "./map";
import { Q_ENDED, Q_MEDIA_LIST_LEAVES, Q_SUBSCRIBERS, Q_SUBSCRIBER_LISTS, Q_UNSUBSCRIBED } from "./queries";
import type { NodImportReport } from "./report";

export const IMPORT_ACTOR = "Legacy import";
const BATCH = 500;
const OPTED_OUT = "opted out of this media list in NoD (staff must confirm a re-add)";
const ENDED = "unsubscribed in legacy since the last import (NoD's record ended)";
const HOLDER_ENDED = "unsubscribed in legacy: NoD's record of the address ended";
const NEWER_IN_NOD = "unsubscribed in legacy before a newer subscribe in NoD (not applied)";

export interface ImportedSubscriber {
  asItHappens: boolean;
  digest: boolean;
  /** NoD media list keys the legacy record was on (articles use them to spot a media send). */
  mediaKeys: Set<string>;
}

export interface SubscriberStageContext {
  report: NodImportReport;
  timeZone: string;
  lists: ListMapping;
  /** The database clock when the run began. */
  runAt: Date;
}

/** What became of an unsubscribe from a duplicate legacy record of the address (see
 * {@link duplicateUnsubscribe}), when there was one to weigh. */
type DuplicateUnsubscribe = "ended" | "newer-in-nod";
type Written = { kind: "imported" | "updated" | "unchanged"; optedOut: string[]; duplicate?: DuplicateUnsubscribe };
type Outcome = Written | { kind: "skipped"; reason: string };
const skipped = (reason: string): Outcome => ({ kind: "skipped", reason });

interface Leave {
  listKey: string;
  at: Date;
}

/** A legacy record to write, with the consent legacy holds for its address. */
interface Candidate {
  m: MappedSubscriber;
  /** Its address's latest legacy leave from each media list legacy doesn't have it on now
   * (one it is on now came after: legacy re-added it). */
  leaves: Leave[];
  /** Its address's latest legacy unsubscribe (SysLog 104) on any legacy record, as an instant. */
  unsubscribedAt: Date | null;
  /** That unsubscribe was made on another (duplicate) legacy record of the address. */
  fromDuplicate: boolean;
}

type CurrentRow = {
  id: string;
  email: string;
  status: SubscriberStatus;
  as_it_happens: boolean;
  digest: boolean;
  source: SubscriberSource;
  list_keys: string[] | null;
  fingerprint: string | null;
  imported_at: string | Date | null;
  created_at: string | Date;
};

/** NoD's rows for these ids or addresses, with what the importer last wrote for each. */
async function currentRows(db: DbOrTx, ids: string[], emails: string[]): Promise<CurrentRow[]> {
  const { rows } = await db.execute<CurrentRow>(sql`
    SELECT s.id, s.email, s.status, s.as_it_happens, s.digest, s.source, s.created_at,
           (SELECT array_agg(x.list_key ORDER BY x.list_key) FROM subscriptions x WHERE x.subscriber_id = s.id) AS list_keys,
           li.fingerprint, li.imported_at
      FROM subscribers s LEFT JOIN legacy_subscriber_imports li ON li.subscriber_id = s.id
     WHERE s.id = ANY(${sql.param(ids)}::uuid[]) OR lower(s.email) = ANY(${sql.param(emails)}::text[])`);
  return rows.map((r) => ({ ...r, email: normaliseEmail(r.email) }));
}

/** Row-locks these ids' or addresses' rows, but only those whose address is in `locked` (the
 * address locks the transaction holds): a row that moved elsewhere is someone else's to lock. */
async function lockRows(tx: Tx, ids: string[], emails: string[], locked: string[]): Promise<void> {
  await tx.execute(sql`
    SELECT s.id FROM subscribers s
     WHERE (s.id = ANY(${sql.param(ids)}::uuid[]) OR lower(s.email) = ANY(${sql.param(emails)}::text[]))
       AND lower(s.email) = ANY(${sql.param(locked)}::text[])
       FOR UPDATE`);
}

const stateOf = (r: CurrentRow): SubscriberState => ({ email: r.email, status: r.status, asItHappens: r.as_it_happens, digest: r.digest, source: r.source, listKeys: r.list_keys ?? [] });

/**
 * Drops from `m` every media list this address may not be put on without staff confirming: an
 * opt-out on NoD's own record or one kept from a purged record of the address, '*' included
 * (opt-outs.ts `optedOutKeys`, the rule every other way onto a media list follows). Lists the
 * record is on already are left alone, as nothing would be added -- unless legacy moves it to a
 * new address, when every list it would carry there is checked against that address. The
 * fingerprint is of what is actually written, so an unchanged re-run still reads as unchanged.
 */
async function withoutOptedOut(tx: Tx, m: MappedSubscriber, existing: CurrentRow | null): Promise<{ m: MappedSubscriber; optedOut: string[] }> {
  const moving = existing !== null && existing.email !== m.state.email;
  const on = new Set(moving ? [] : (existing?.list_keys ?? []));
  const optedOut = (await optedOutKeys(tx, m.state.email, m.state.listKeys.filter((k) => !on.has(k)), existing)).map((o) => o.listKey);
  if (optedOut.length === 0) return { m, optedOut };
  const state = { ...m.state, listKeys: m.state.listKeys.filter((k) => !optedOut.includes(k)) };
  return { m: { ...m, state, fingerprint: fingerprintOf(state) }, optedOut };
}

async function insertSubscriber(tx: Tx, m: MappedSubscriber): Promise<void> {
  await tx.insert(subscribers).values({
    id: m.id,
    email: m.state.email,
    status: m.state.status,
    asItHappens: m.state.asItHappens,
    digest: m.state.digest,
    source: m.state.source,
    createdAt: m.createdAt,
    verifiedAt: m.createdAt,
    endedAt: m.endedAt,
  });
  if (m.state.listKeys.length > 0) await tx.insert(subscriptions).values(m.state.listKeys.map((listKey) => ({ subscriberId: m.id, listKey })));
  await writeHistory(tx, m.id, IMPORT_ACTOR, "legacy-imported", `status ${m.state.status}`);
  await tx.insert(legacySubscriberImports).values({ subscriberId: m.id, fingerprint: m.fingerprint });
}

async function updateSubscriber(tx: Tx, m: MappedSubscriber, currentEmail: string): Promise<void> {
  await tx
    .update(subscribers)
    .set({
      email: m.state.email,
      status: m.state.status,
      asItHappens: m.state.asItHappens,
      digest: m.state.digest,
      source: m.state.source,
      endedAt: m.endedAt,
      // A new address must not keep the old one's unsubscribe links working.
      ...(currentEmail !== m.state.email ? { unsubscribeVersion: sql`${subscribers.unsubscribeVersion} + 1` } : {}),
    })
    .where(eq(subscribers.id, m.id));
  await tx.delete(subscriptions).where(eq(subscriptions.subscriberId, m.id));
  if (m.state.listKeys.length > 0) await tx.insert(subscriptions).values(m.state.listKeys.map((listKey) => ({ subscriberId: m.id, listKey })));
  await writeHistory(tx, m.id, IMPORT_ACTOR, "legacy-imported", `updated from legacy: status ${m.state.status}`);
  // Marks the move for the opt-out check: adds made at the old address don't count at the new one.
  if (currentEmail !== m.state.email) await writeHistory(tx, m.id, IMPORT_ACTOR, "legacy-email-changed");
  await tx.update(legacySubscriberImports).set({ fingerprint: m.fingerprint, importedAt: sql`now()` }).where(eq(legacySubscriberImports.subscriberId, m.id));
}

/**
 * Applies legacy media-list leaves to a NoD record, by the rule opt-outs.ts `optedOutOfKey`
 * enforces: a leave newer than (or as new as) the record's latest `media-list-added` for that list
 * takes them off it and is kept as `media-list-opted-out` history (inserted if absent), so staff
 * are asked before re-adding them; a staff add made since the leave stands. Legacy can't tell an
 * opt-out from a staff removal; asking is the safe side. Takes no lock: the caller holds the
 * record's address lock and row.
 */
async function applyLegacyLeaves(tx: Tx, subscriberId: string, leaves: Leave[]): Promise<void> {
  for (const l of leaves) {
    const at = l.at.toISOString();
    const { rows } = await tx.execute<{ added: string | Date | null }>(sql`
      SELECT max(at) AS added FROM subscriber_history
       WHERE subscriber_id = ${subscriberId}::uuid AND action = 'media-list-added' AND detail = ${l.listKey}`);
    const added = rows[0]?.added;
    if (added && new Date(added) > l.at) continue;
    await tx.delete(subscriptions).where(and(eq(subscriptions.subscriberId, subscriberId), eq(subscriptions.listKey, l.listKey)));
    await tx.execute(sql`
      INSERT INTO subscriber_history (subscriber_id, at, actor, action, detail)
      SELECT ${subscriberId}::uuid, ${at}::timestamptz, ${IMPORT_ACTOR}, 'media-list-opted-out', ${l.listKey}
       WHERE NOT EXISTS (SELECT 1 FROM subscriber_history
                          WHERE subscriber_id = ${subscriberId}::uuid AND action = 'media-list-opted-out' AND detail = ${l.listKey} AND at = ${at}::timestamptz)`);
  }
}

/** A legacy unsubscribe (104) as `unsubscribed` history at its own date (inserted if absent), so
 * NoD's opt-out checks and the purge's kept opt-outs treat it as the subscriber's own. */
async function keepLegacyUnsubscribe(tx: Tx, subscriberId: string, unsubscribedAt: Date | null): Promise<void> {
  if (!unsubscribedAt) return;
  const at = unsubscribedAt.toISOString();
  await tx.execute(sql`
    INSERT INTO subscriber_history (subscriber_id, at, actor, action, detail)
    SELECT ${subscriberId}::uuid, ${at}::timestamptz, ${IMPORT_ACTOR}, 'unsubscribed', ''
     WHERE NOT EXISTS (SELECT 1 FROM subscriber_history
                        WHERE subscriber_id = ${subscriberId}::uuid AND action = 'unsubscribed' AND at = ${at}::timestamptz)`);
}

/**
 * Whether NoD holds consent for this record newer than a legacy unsubscribe at `at`: the record
 * was created in NoD after it, or its own `subscribed`, `resubscribed` or `staff-activated` came
 * after it. The newer consent wins; a tie goes to the unsubscribe.
 */
async function consentedSince(tx: Tx, s: { id: string; createdAt: string | Date }, at: Date): Promise<boolean> {
  if (new Date(s.createdAt) > at) return true;
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM subscriber_history
     WHERE subscriber_id = ${s.id}::uuid AND action IN ('subscribed', 'resubscribed', 'staff-activated') AND at > ${at.toISOString()}::timestamptz`);
  return (rows[0]?.n ?? 0) > 0;
}

/**
 * Legacy leaves and unsubscribe for an address NoD keeps its own record of (or, with none, as
 * kept opt-out hashes: an unsubscribe is out of every media list). On a record, the unsubscribe
 * ends it as a NoD unsubscribe would -- history alone would read as an opt-out from lists it is
 * still on -- unless NoD holds newer consent for it, when it isn't applied at all. Returns what
 * was done with the unsubscribe. The caller holds the address lock.
 */
async function applyToAddress(tx: Tx, email: string, leaves: Leave[], unsubscribedAt: Date | null): Promise<"ended" | "newer-in-nod" | null> {
  const [holder] = await tx
    .select({ id: subscribers.id, status: subscribers.status, createdAt: subscribers.createdAt })
    .from(subscribers)
    .where(sql`lower(${subscribers.email}) = ${email}`)
    .for("update");
  if (!holder) {
    await keepOptOutHashes(tx, email, [...leaves, ...(unsubscribedAt ? [{ listKey: ALL_MEDIA_LISTS, at: unsubscribedAt }] : [])]);
    return null;
  }
  await applyLegacyLeaves(tx, holder.id, leaves);
  if (!unsubscribedAt) return null;
  if (await consentedSince(tx, holder, unsubscribedAt)) return "newer-in-nod";
  if (holder.status === "deleted") {
    await keepLegacyUnsubscribe(tx, holder.id, unsubscribedAt);
    return null;
  }
  await endForLegacyUnsubscribe(tx, holder, unsubscribedAt);
  return "ended";
}

/** The candidate's legacy unsubscribe if NoD hasn't had it yet: made at or after the last import of
 * this id (an earlier one was imported then, as history). */
function unsubscribedSince(c: Candidate, importedAt: string | Date | null): Date | null {
  return c.unsubscribedAt && importedAt && c.unsubscribedAt >= new Date(importedAt) ? c.unsubscribedAt : null;
}

/**
 * Ends a record for a legacy unsubscribe NoD hasn't had yet, as NoD's own unsubscribe does
 * (journeys.ts `endLockedSubscriber`: media lists opted out of, `deleted`, `ended_at`), with its
 * public lists cleared too, as legacy's are, and the unsubscribe as history at its own date. The
 * import time moves past it, so the next run doesn't end the record again after NoD brings it
 * back (a confirmed staff re-add, the person subscribing again). The caller holds the locks.
 */
async function endForLegacyUnsubscribe(tx: Tx, mine: Pick<CurrentRow, "id" | "status">, at: Date): Promise<void> {
  await endLockedSubscriber(tx, mine, IMPORT_ACTOR, at);
  await tx.delete(subscriptions).where(eq(subscriptions.subscriberId, mine.id));
  await keepLegacyUnsubscribe(tx, mine.id, at);
  await tx
    .update(legacySubscriberImports)
    .set({ importedAt: sql`GREATEST(now(), ${at.toISOString()}::timestamptz + interval '1 millisecond')` })
    .where(eq(legacySubscriberImports.subscriberId, mine.id));
}

/**
 * The legacy unsubscribe a record written from legacy carries. Its own, or one on a record already
 * ended, is kept as history. One made on a duplicate legacy record of the address, on a record
 * that hasn't ended, follows the newer-consent rule ({@link consentedSince}): newer than the
 * record's registration and its own subscribes, it ends the record as a NoD unsubscribe would
 * (history alone would read as an opt-out from lists it is still on); otherwise it isn't applied.
 * `decide` only says which, so a caller without the record's lock can defer first.
 */
async function duplicateUnsubscribe(
  tx: Tx,
  c: Candidate,
  rec: { id: string; createdAt: string | Date; status: SubscriberStatus },
  decide = false,
): Promise<DuplicateUnsubscribe | null> {
  const at = c.unsubscribedAt;
  if (!at) return null;
  if (!c.fromDuplicate || rec.status === "deleted") {
    if (!decide) await keepLegacyUnsubscribe(tx, rec.id, at);
    return null;
  }
  if (await consentedSince(tx, rec, at)) return "newer-in-nod";
  if (!decide) await endForLegacyUnsubscribe(tx, rec, at);
  return "ended";
}

/**
 * Media lists NoD's record is on that legacy no longer has, which staff added in NoD after
 * legacy's latest leave from that list -- or, with no leave, since the last import. Dates, not
 * the fingerprint: a remove and re-add in NoD leaves the record looking untouched, and legacy's
 * older leave must not undo the re-add.
 */
async function nodReAdds(tx: Tx, mine: CurrentRow, m: MappedSubscriber, leaves: Leave[]): Promise<string[]> {
  const kept: string[] = [];
  for (const key of mine.list_keys ?? []) {
    if (!key.startsWith(`${MEDIA_CATEGORY_KEY}:`) || m.state.listKeys.includes(key)) continue;
    const { rows } = await tx.execute<{ added: string | Date | null }>(sql`
      SELECT max(at) AS added FROM subscriber_history
       WHERE subscriber_id = ${mine.id}::uuid AND action = 'media-list-added' AND detail = ${key}`);
    const added = rows[0]?.added ? new Date(rows[0].added) : null;
    const since = leaves.find((l) => l.listKey === key)?.at ?? (mine.imported_at ? new Date(mine.imported_at) : null);
    if (added && since && added > since) kept.push(key);
  }
  return kept;
}

/**
 * A legacy record whose id NoD already has. Untouched since the last import (its fingerprint
 * still matches) means legacy's data wins, but for media lists staff have re-added in NoD since;
 * otherwise NoD's does, though legacy's leaves still apply. Either way a legacy unsubscribe NoD
 * hasn't had yet ends the record. Returns "defer" instead of changing the record when `locked`
 * is false, so the caller can redo this under withLockedSubscriber. Must run holding the address
 * locks of `mine` and `m`.
 */
async function settleExisting(tx: Tx, c: Candidate, mine: CurrentRow, addressHeldElsewhere: boolean, locked: boolean): Promise<Outcome | "defer"> {
  const { m } = c;
  if (mine.fingerprint === null) return skipped("a NoD record already has this id");
  const since = unsubscribedSince(c, mine.imported_at);
  const newerInNod = since !== null && (await consentedSince(tx, { id: mine.id, createdAt: mine.created_at }, since));
  const ending = newerInNod ? null : since;
  // With the unsubscribe not applied, a leave legacy had already overtaken at the last import
  // (the record was still on that list then) only resurfaces because legacy's unsubscribe
  // dropped every list: it doesn't apply either.
  const leaves = newerInNod ? c.leaves.filter((l) => mine.imported_at && l.at >= new Date(mine.imported_at)) : c.leaves;
  if (fingerprintOf(stateOf(mine)) !== mine.fingerprint) {
    if ((leaves.length > 0 || ending) && !locked) return "defer";
    await applyLegacyLeaves(tx, m.id, leaves);
    if (newerInNod) return skipped(NEWER_IN_NOD);
    if (!ending) return skipped("changed in NoD since the last import (NoD's record kept)");
    await endForLegacyUnsubscribe(tx, mine, ending);
    return skipped(ENDED);
  }
  const reAdded = await nodReAdds(tx, mine, m, c.leaves);
  const legacy = reAdded.length === 0 ? m : { ...m, state: { ...m.state, listKeys: [...m.state.listKeys, ...reAdded].sort() } };
  const { m: allowed, optedOut } = await withoutOptedOut(tx, { ...legacy, fingerprint: fingerprintOf(legacy.state) }, mine);
  if (allowed.fingerprint === mine.fingerprint) {
    // NoD holds exactly what legacy does, so no leave can remove anything: history only.
    const rec = { id: m.id, createdAt: mine.created_at, status: mine.status };
    if (!locked && (await duplicateUnsubscribe(tx, c, rec, true)) === "ended") return "defer";
    await applyLegacyLeaves(tx, m.id, c.leaves);
    const duplicate = (await duplicateUnsubscribe(tx, c, rec)) ?? undefined;
    return { kind: "unchanged", optedOut, duplicate };
  }
  if (addressHeldElsewhere) {
    if (newerInNod) return skipped(NEWER_IN_NOD);
    if (!ending) return skipped("address already in NoD (NoD's record kept)");
    if (!locked) return "defer";
    await endForLegacyUnsubscribe(tx, mine, ending);
    return skipped(ENDED);
  }
  if (!locked) return "defer";
  await updateSubscriber(tx, allowed, mine.email);
  await applyLegacyLeaves(tx, m.id, c.leaves);
  const duplicate = (await duplicateUnsubscribe(tx, c, { id: m.id, createdAt: mine.created_at, status: allowed.state.status })) ?? undefined;
  return { kind: "updated", optedOut, duplicate };
}

/**
 * One batch, one transaction, holding the address lock (the same keyspace as the live journeys)
 * for every address involved, taken in sorted order before any row is locked. The addresses
 * come from an unlocked read first. An id whose NoD address changed between that read and the
 * locks is skipped and picked up by the next run, never written under the wrong lock.
 * New records are inserted here, and records that need only history are settled here. Anything
 * that changes an existing record (a legacy update, a leave that takes them off a list) is done
 * afterwards, one record at a time, through withLockedSubscriber like any other writer.
 */
async function writeBatch(db: Db, batch: Candidate[]): Promise<Map<string, Outcome>> {
  const ids = batch.map((c) => c.m.id);
  const emails = batch.map((c) => c.m.state.email);
  const toLock = [...new Set([...emails, ...(await currentRows(db, ids, emails)).map((r) => r.email)])].sort();
  const out = new Map<string, Outcome>();
  const deferred: Candidate[] = [];
  const forHolder: { c: Candidate; unsubscribedAt: Date | null }[] = [];
  await db.transaction(async (tx) => {
    for (const a of toLock) await lockAddress(tx, a);
    await lockRows(tx, ids, emails, toLock);
    const rows = await currentRows(tx, ids, emails);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const byEmail = new Map(rows.map((r) => [r.email, r]));
    const { rows: importedBefore } = await tx.execute<{ subscriber_id: string; imported_at: string | Date }>(
      sql`SELECT subscriber_id, imported_at FROM legacy_subscriber_imports WHERE subscriber_id = ANY(${sql.param(ids)}::uuid[])`,
    );
    const seen = new Map(importedBefore.map((r) => [r.subscriber_id, r.imported_at]));
    for (const c of batch) {
      const { m } = c;
      const mine = byId.get(m.id);
      const holder = byEmail.get(m.state.email);
      let outcome: Outcome | "defer";
      if (mine && !toLock.includes(mine.email)) outcome = skipped("changed while importing: run the import again");
      else if (!mine && (seen.has(m.id) || holder)) {
        // NoD's record of the address is kept (or it has none), but legacy's opt-outs for the
        // address still count: on NoD's record, else as kept hashes, as the purge would. An
        // unsubscribe already imported for a purged record was kept by the purge itself.
        const unsubscribedAt = seen.has(m.id) ? unsubscribedSince(c, seen.get(m.id)!) : c.unsubscribedAt;
        if (holder && (c.leaves.length > 0 || unsubscribedAt)) forHolder.push({ c, unsubscribedAt });
        else if (!holder) await applyToAddress(tx, m.state.email, c.leaves, unsubscribedAt);
        outcome = skipped(seen.has(m.id) ? "removed in NoD since the last import" : "address already in NoD (NoD's record kept)");
      } else if (!mine) {
        const { m: allowed, optedOut } = await withoutOptedOut(tx, m, null);
        await insertSubscriber(tx, allowed);
        await applyLegacyLeaves(tx, m.id, c.leaves);
        const duplicate = (await duplicateUnsubscribe(tx, c, { id: m.id, createdAt: allowed.createdAt, status: allowed.state.status })) ?? undefined;
        outcome = { kind: "imported", optedOut, duplicate };
      } else outcome = await settleExisting(tx, c, mine, holder !== undefined && holder.id !== m.id, false);
      if (outcome === "defer") deferred.push(c);
      else out.set(m.id, outcome);
    }
  });
  for (const c of deferred) {
    const { m } = c;
    const outcome = await withLockedSubscriber(db, m.id, m.state.email, async (tx, s): Promise<Outcome> => {
      if (!s) return skipped("removed in NoD since the last import");
      const rows = await currentRows(tx, [m.id], [m.state.email]);
      const mine = rows.find((r) => r.id === m.id)!;
      const elsewhere = rows.some((r) => r.id !== m.id && r.email === m.state.email);
      const settled = await settleExisting(tx, c, mine, elsewhere, true);
      return settled === "defer" ? skipped("changed while importing: run the import again") : settled;
    });
    out.set(m.id, outcome);
  }
  for (const { c, unsubscribedAt } of forHolder) {
    const email = c.m.state.email;
    const holderId = (await db.select({ id: subscribers.id }).from(subscribers).where(sql`lower(${subscribers.email}) = ${email}`))[0]?.id;
    // Locks the holder's row and address, plus the legacy address in case it has moved on since.
    const applied = holderId
      ? await withLockedSubscriber(db, holderId, email, (tx) => applyToAddress(tx, email, c.leaves, unsubscribedAt))
      : await db.transaction(async (tx) => {
          await lockAddress(tx, email);
          return applyToAddress(tx, email, c.leaves, unsubscribedAt);
        });
    if (applied === "ended") out.set(c.m.id, skipped(HOLDER_ENDED));
    else if (applied === "newer-in-nod") out.set(c.m.id, skipped(NEWER_IN_NOD));
  }
  return out;
}

/** Legacy Subscriber + SubscriberList → NoD subscribers, subscriptions and history, in batches of 500. */
export async function importSubscribers(db: Db, source: LegacySource, ctx: SubscriberStageContext): Promise<Map<string, ImportedSubscriber>> {
  const { report, lists } = ctx;
  const legacy = await source.query<LegacySubscriberRow & Record<string, unknown>>(Q_SUBSCRIBERS);
  const memberships = await source.query<{ SubscriberGuid: string; ListGuid: string }>(Q_SUBSCRIBER_LISTS);
  const ended = await source.query<{ SubscriberGuid: string; EndedAt: Date }>(Q_ENDED);
  const unsubscribed = await source.query<{ SubscriberGuid: string; UnsubscribedAt: Date }>(Q_UNSUBSCRIBED);
  const leaves = await source.query<{ SubscriberGuid: string; ListGuid: string; LeftAt: Date }>(Q_MEDIA_LIST_LEAVES);
  report.count("Subscriber", "legacy", legacy.length);
  report.count("SubscriberList", "legacy", memberships.length);

  const listGuidsOf = new Map<string, string[]>();
  for (const m of memberships) {
    const s = guidKey(m.SubscriberGuid);
    listGuidsOf.set(s, [...(listGuidsOf.get(s) ?? []), guidKey(m.ListGuid)]);
  }
  const unsubscribedAt = new Map(unsubscribed.map((u) => [guidKey(u.SubscriberGuid), wallClockToInstant(u.UnsubscribedAt, ctx.timeZone)]));
  // A record ends at its latest staff delete or own unsubscribe.
  const endedAt = new Map(unsubscribedAt);
  for (const e of ended) {
    const guid = guidKey(e.SubscriberGuid);
    const at = wallClockToInstant(e.EndedAt, ctx.timeZone);
    const prev = endedAt.get(guid);
    if (!prev || at > prev) endedAt.set(guid, at);
  }

  // Leaves are an address's consent, so they're kept by address: a duplicate legacy record's
  // leave counts against the record imported for that address, or NoD's own record of it.
  const emailOf = new Map(legacy.map((s) => [guidKey(s.SubscriberGuid), normaliseEmail(s.EmailAddress ?? "")]));
  const latestLeave = new Map<string, Map<string, Date>>();
  for (const l of leaves) {
    const mapped = lists.byGuid.get(guidKey(l.ListGuid));
    const email = emailOf.get(guidKey(l.SubscriberGuid));
    if (!mapped?.media || !email) continue;
    const at = wallClockToInstant(l.LeftAt, ctx.timeZone);
    const byList = latestLeave.get(email) ?? new Map<string, Date>();
    const prev = byList.get(mapped.listKey);
    if (!prev || at > prev) byList.set(mapped.listKey, at);
    latestLeave.set(email, byList);
  }
  const leavesOf = (email: string): Leave[] => [...(latestLeave.get(email) ?? new Map<string, Date>())].map(([listKey, at]) => ({ listKey, at }));
  // An unsubscribe likewise: the newest one on any legacy record of the address.
  const latestUnsubscribe = new Map<string, { at: Date; guid: string }>();
  for (const [guid, at] of unsubscribedAt) {
    const email = emailOf.get(guid);
    if (!email) continue;
    const prev = latestUnsubscribe.get(email);
    if (!prev || at > prev.at) latestUnsubscribe.set(email, { at, guid });
  }

  const skipWithLists = (guid: string, reason: string) => {
    report.skip("Subscriber", reason, guid);
    for (const lg of listGuidsOf.get(guid) ?? []) report.skip("SubscriberList", "subscriber not imported", `${guid}/${lg}`);
  };
  const { winners, duplicates, invalid } = pickWinners(legacy);
  for (const g of duplicates) skipWithLists(g, "duplicate address: another legacy record with it was imported");
  for (const g of invalid) skipWithLists(g, "invalid email address");

  const candidates: Candidate[] = winners.map((s) => {
    const guid = guidKey(s.SubscriberGuid);
    const own = (listGuidsOf.get(guid) ?? []).map((lg) => lists.byGuid.get(lg)).filter((x): x is MappedList => x !== undefined);
    const m = mapSubscriber(s, own, endedAt.get(guid) ?? null, ctx);
    const unsubscribe = latestUnsubscribe.get(m.state.email);
    return {
      m,
      leaves: leavesOf(m.state.email).filter((l) => !m.state.listKeys.includes(l.listKey)),
      unsubscribedAt: unsubscribe?.at ?? null,
      fromDuplicate: unsubscribe !== undefined && unsubscribe.guid !== guid,
    };
  });

  const result = new Map<string, ImportedSubscriber>();
  const duplicateUnsubscribes: Record<DuplicateUnsubscribe, string[]> = { ended: [], "newer-in-nod": [] };
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const outcomes = await writeBatch(db, batch);
    for (const { m } of batch) {
      const o = outcomes.get(m.id)!;
      if (o.kind === "skipped") {
        skipWithLists(m.id, o.reason);
        continue;
      }
      report.count("Subscriber", "imported");
      if (o.duplicate) duplicateUnsubscribes[o.duplicate].push(m.id);
      const own = listGuidsOf.get(m.id) ?? [];
      for (const lg of own) {
        const list = lists.byGuid.get(lg);
        if (m.state.status === "deleted") report.skip("SubscriberList", "subscriber deleted in legacy: memberships not kept", `${m.id}/${lg}`);
        else if (!list) report.skip("SubscriberList", lists.skipped.get(lg) ?? "list not in legacy's List table", `${m.id}/${lg}`);
        else if (o.optedOut.includes(list.listKey)) report.skip("SubscriberList", OPTED_OUT, `${m.id}/${lg}`);
        else report.count("SubscriberList", "imported");
      }
      const mediaKeys = new Set(own.map((lg) => lists.byGuid.get(lg)).filter((x): x is MappedList => x?.media === true).map((x) => x.listKey));
      result.set(m.id, { asItHappens: m.state.asItHappens, digest: m.state.digest, mediaKeys });
    }
  }
  // Ids only, a sample of them, like the skip groups.
  const sample = (ids: string[]) => ids.slice(0, 10).join(", ");
  const { ended: endedByDuplicate, "newer-in-nod": notApplied } = duplicateUnsubscribes;
  if (endedByDuplicate.length > 0) {
    const n = endedByDuplicate.length;
    report.note(`${n} record${n === 1 ? "" : "s"} ended by a newer unsubscribe on a duplicate legacy record of its address: ${sample(endedByDuplicate)}`);
  }
  if (notApplied.length > 0) {
    const n = notApplied.length;
    report.note(`${n} unsubscribe${n === 1 ? "" : "s"} on a duplicate legacy record not applied (its address's record subscribed since): ${sample(notApplied)}`);
  }
  return result;
}
