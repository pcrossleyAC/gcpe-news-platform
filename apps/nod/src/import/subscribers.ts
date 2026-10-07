import { and, eq, sql } from "drizzle-orm";
import { wallClockToInstant } from "@gcpe/config";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import type { LegacySource } from "@gcpe/legacy-import";
import { legacySubscriberImports, subscribers, subscriptions, type SubscriberSource, type SubscriberStatus } from "../db/schema";
import { lockAddress, withLockedSubscriber } from "../locks";
import { keepOptOutHashes, mediaOptOutAt } from "../opt-outs";
import { writeHistory } from "../subscribe/history";
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

type Written = { kind: "imported" | "updated" | "unchanged"; optedOut: string[] };
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
  /** Its own latest legacy unsubscribe (SysLog 104), as an instant. */
  unsubscribedAt: Date | null;
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
};

/** NoD's rows for these ids or addresses, with what the importer last wrote for each. */
async function currentRows(db: DbOrTx, ids: string[], emails: string[]): Promise<CurrentRow[]> {
  const { rows } = await db.execute<CurrentRow>(sql`
    SELECT s.id, s.email, s.status, s.as_it_happens, s.digest, s.source,
           (SELECT array_agg(x.list_key ORDER BY x.list_key) FROM subscriptions x WHERE x.subscriber_id = s.id) AS list_keys,
           li.fingerprint
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
 * (opt-outs.ts `mediaOptOutAt`, the check every other way onto a media list makes). Lists the
 * record is on already are left alone: nothing would be added. The fingerprint is of what is
 * actually written, so an unchanged re-run still reads as unchanged.
 */
async function withoutOptedOut(tx: Tx, m: MappedSubscriber, existing: CurrentRow | null): Promise<{ m: MappedSubscriber; optedOut: string[] }> {
  const on = new Set(existing?.list_keys ?? []);
  const optedOut: string[] = [];
  for (const key of m.state.listKeys) {
    if (!key.startsWith(`${MEDIA_CATEGORY_KEY}:`) || on.has(key)) continue;
    if (await mediaOptOutAt(tx, m.state.email, key, existing)) optedOut.push(key);
  }
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

/** Legacy leaves for an address NoD keeps its own record of (or, with none, as kept opt-out
 * hashes). The caller holds the address lock. */
async function applyLeavesToAddress(tx: Tx, email: string, leaves: Leave[]): Promise<void> {
  const [holder] = await tx.select({ id: subscribers.id }).from(subscribers).where(sql`lower(${subscribers.email}) = ${email}`).for("update");
  if (holder) await applyLegacyLeaves(tx, holder.id, leaves);
  else await keepOptOutHashes(tx, email, leaves);
}

/**
 * A legacy record whose id NoD already has. Untouched since the last import (its fingerprint
 * still matches) means legacy's data wins; otherwise NoD's does, though legacy's leaves still
 * apply. Returns "defer" instead of changing the record when `locked` is false, so the caller
 * can redo this under withLockedSubscriber. Must run holding the address locks of `mine` and `m`.
 */
async function settleExisting(tx: Tx, c: Candidate, mine: CurrentRow, addressHeldElsewhere: boolean, locked: boolean): Promise<Outcome | "defer"> {
  const { m } = c;
  if (mine.fingerprint === null) return skipped("a NoD record already has this id");
  if (fingerprintOf(stateOf(mine)) !== mine.fingerprint) {
    if (c.leaves.length > 0 && !locked) return "defer";
    await applyLegacyLeaves(tx, m.id, c.leaves);
    return skipped("changed in NoD since the last import (NoD's record kept)");
  }
  const { m: allowed, optedOut } = await withoutOptedOut(tx, m, mine);
  if (allowed.fingerprint === mine.fingerprint) {
    // NoD holds exactly what legacy does, so no leave can remove anything: history only.
    await applyLegacyLeaves(tx, m.id, c.leaves);
    await keepLegacyUnsubscribe(tx, m.id, c.unsubscribedAt);
    return { kind: "unchanged", optedOut };
  }
  if (addressHeldElsewhere) return skipped("address already in NoD (NoD's record kept)");
  if (!locked) return "defer";
  await updateSubscriber(tx, allowed, mine.email);
  await applyLegacyLeaves(tx, m.id, c.leaves);
  await keepLegacyUnsubscribe(tx, m.id, c.unsubscribedAt);
  return { kind: "updated", optedOut };
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
  const leavesForAddress: Candidate[] = [];
  await db.transaction(async (tx) => {
    for (const a of toLock) await lockAddress(tx, a);
    await lockRows(tx, ids, emails, toLock);
    const rows = await currentRows(tx, ids, emails);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const byEmail = new Map(rows.map((r) => [r.email, r]));
    const { rows: importedBefore } = await tx.execute<{ subscriber_id: string }>(
      sql`SELECT subscriber_id FROM legacy_subscriber_imports WHERE subscriber_id = ANY(${sql.param(ids)}::uuid[])`,
    );
    const seen = new Set(importedBefore.map((r) => r.subscriber_id));
    for (const c of batch) {
      const { m } = c;
      const mine = byId.get(m.id);
      const holder = byEmail.get(m.state.email);
      let outcome: Outcome | "defer";
      if (mine && !toLock.includes(mine.email)) outcome = skipped("changed while importing: run the import again");
      else if (!mine && (seen.has(m.id) || holder)) {
        // NoD's record of the address is kept (or it has none), but legacy's opt-outs for the
        // address still count: on NoD's record, else as kept hashes, as the purge would.
        if (holder && c.leaves.length > 0) leavesForAddress.push(c);
        else if (!holder) await keepOptOutHashes(tx, m.state.email, c.leaves);
        outcome = skipped(seen.has(m.id) ? "removed in NoD since the last import" : "address already in NoD (NoD's record kept)");
      } else if (!mine) {
        const { m: allowed, optedOut } = await withoutOptedOut(tx, m, null);
        await insertSubscriber(tx, allowed);
        await applyLegacyLeaves(tx, m.id, c.leaves);
        await keepLegacyUnsubscribe(tx, m.id, c.unsubscribedAt);
        outcome = { kind: "imported", optedOut };
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
  for (const c of leavesForAddress) {
    const holderId = (await db.select({ id: subscribers.id }).from(subscribers).where(sql`lower(${subscribers.email}) = ${c.m.state.email}`))[0]?.id;
    // Locks the holder's row and address, plus the legacy address in case it has moved on since.
    if (holderId) await withLockedSubscriber(db, holderId, c.m.state.email, (tx) => applyLeavesToAddress(tx, c.m.state.email, c.leaves));
    else await db.transaction(async (tx) => {
      await lockAddress(tx, c.m.state.email);
      await applyLeavesToAddress(tx, c.m.state.email, c.leaves);
    });
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
    return { m, leaves: leavesOf(m.state.email).filter((l) => !m.state.listKeys.includes(l.listKey)), unsubscribedAt: unsubscribedAt.get(guid) ?? null };
  });

  const result = new Map<string, ImportedSubscriber>();
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
  return result;
}
