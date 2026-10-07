import { eq, sql } from "drizzle-orm";
import { wallClockToInstant } from "@gcpe/config";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import type { LegacySource } from "@gcpe/legacy-import";
import { legacySubscriberImports, subscribers, subscriptions, type SubscriberSource, type SubscriberStatus } from "../db/schema";
import { lockAddress, withLockedSubscriber } from "../locks";
import { mediaOptOutAt } from "../opt-outs";
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
import { Q_ENDED, Q_MEDIA_LIST_LEAVES, Q_SUBSCRIBERS, Q_SUBSCRIBER_LISTS } from "./queries";
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

/** NoD's rows for these ids or addresses, with what the importer last wrote for each. Inside a
 * transaction that holds their address locks, `forUpdate` also locks the rows. */
async function currentRows(db: DbOrTx, ids: string[], emails: string[], forUpdate: boolean): Promise<CurrentRow[]> {
  const { rows } = await db.execute<CurrentRow>(sql`
    SELECT s.id, s.email, s.status, s.as_it_happens, s.digest, s.source,
           (SELECT array_agg(x.list_key ORDER BY x.list_key) FROM subscriptions x WHERE x.subscriber_id = s.id) AS list_keys,
           li.fingerprint
      FROM subscribers s LEFT JOIN legacy_subscriber_imports li ON li.subscriber_id = s.id
     WHERE s.id = ANY(${sql.param(ids)}::uuid[]) OR lower(s.email) = ANY(${sql.param(emails)}::text[])
     ${forUpdate ? sql`FOR UPDATE OF s` : sql``}`);
  return rows.map((r) => ({ ...r, email: normaliseEmail(r.email) }));
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

/** Legacy media-list leaves for lists the subscriber isn't on now: written as opt-outs (insert
 * if absent), so staff are asked before re-adding them. Legacy can't tell an opt-out from a
 * staff removal; asking is the safe side. */
async function keepLegacyOptOuts(tx: Tx, subscriberId: string, onLists: string[], leaves: Leave[]): Promise<void> {
  for (const l of leaves) {
    if (onLists.includes(l.listKey)) continue;
    const at = l.at.toISOString();
    await tx.execute(sql`
      INSERT INTO subscriber_history (subscriber_id, at, actor, action, detail)
      SELECT ${subscriberId}::uuid, ${at}::timestamptz, ${IMPORT_ACTOR}, 'media-list-opted-out', ${l.listKey}
       WHERE NOT EXISTS (SELECT 1 FROM subscriber_history
                          WHERE subscriber_id = ${subscriberId}::uuid AND action = 'media-list-opted-out' AND detail = ${l.listKey} AND at = ${at}::timestamptz)`);
  }
}

/**
 * A legacy record whose id NoD already has. Untouched since the last import (its fingerprint
 * still matches) means legacy's data wins; otherwise NoD's does. Returns "update" instead of
 * writing when `mayUpdate` is false, so the caller can redo this under withLockedSubscriber.
 * Must run holding the address locks of `mine` and of `m`.
 */
async function settleExisting(tx: Tx, m: MappedSubscriber, mine: CurrentRow, addressHeldElsewhere: boolean, leaves: Leave[], mayUpdate: boolean): Promise<Outcome | "update"> {
  if (mine.fingerprint === null) return skipped("a NoD record already has this id");
  if (fingerprintOf(stateOf(mine)) !== mine.fingerprint) return skipped("changed in NoD since the last import (NoD's record kept)");
  const { m: allowed, optedOut } = await withoutOptedOut(tx, m, mine);
  if (allowed.fingerprint === mine.fingerprint) {
    await keepLegacyOptOuts(tx, m.id, allowed.state.listKeys, leaves);
    return { kind: "unchanged", optedOut };
  }
  if (addressHeldElsewhere) return skipped("address already in NoD (NoD's record kept)");
  if (!mayUpdate) return "update";
  await updateSubscriber(tx, allowed, mine.email);
  await keepLegacyOptOuts(tx, m.id, allowed.state.listKeys, leaves);
  return { kind: "updated", optedOut };
}

/**
 * One batch, one transaction, holding the address lock (the same keyspace as the live journeys)
 * for every address involved, taken in sorted order before the rows are read FOR UPDATE. The
 * addresses come from an unlocked read first. An id whose NoD address changed between that read
 * and the locks is skipped and picked up by the next run, never written under the wrong lock.
 * New records are inserted here; records that only need opt-out history are settled here, under
 * the same locks. An existing record legacy has changed is rewritten afterwards, one at a time,
 * through withLockedSubscriber like any other writer of an existing subscriber.
 */
async function writeBatch(db: Db, batch: MappedSubscriber[], leavesOf: (email: string) => Leave[]): Promise<Map<string, Outcome>> {
  const ids = batch.map((m) => m.id);
  const emails = batch.map((m) => m.state.email);
  const toLock = [...new Set([...emails, ...(await currentRows(db, ids, emails, false)).map((r) => r.email)])].sort();
  const out = new Map<string, Outcome>();
  const toUpdate: MappedSubscriber[] = [];
  await db.transaction(async (tx) => {
    for (const a of toLock) await lockAddress(tx, a);
    const rows = await currentRows(tx, ids, emails, true);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const byEmail = new Map(rows.map((r) => [r.email, r]));
    const { rows: importedBefore } = await tx.execute<{ subscriber_id: string }>(
      sql`SELECT subscriber_id FROM legacy_subscriber_imports WHERE subscriber_id = ANY(${sql.param(ids)}::uuid[])`,
    );
    const seen = new Set(importedBefore.map((r) => r.subscriber_id));
    for (const m of batch) {
      const mine = byId.get(m.id);
      const holder = byEmail.get(m.state.email);
      const leaves = leavesOf(m.state.email);
      let outcome: Outcome | "update";
      if (mine && !toLock.includes(mine.email)) outcome = skipped("changed while importing: run the import again");
      else if (!mine && seen.has(m.id)) outcome = skipped("removed in NoD since the last import");
      else if (!mine && holder) {
        // NoD's record is kept, but legacy's opt-outs for this address still count against it.
        await keepLegacyOptOuts(tx, holder.id, holder.list_keys ?? [], leaves);
        outcome = skipped("address already in NoD (NoD's record kept)");
      } else if (!mine) {
        const { m: allowed, optedOut } = await withoutOptedOut(tx, m, null);
        await insertSubscriber(tx, allowed);
        await keepLegacyOptOuts(tx, m.id, allowed.state.listKeys, leaves);
        outcome = { kind: "imported", optedOut };
      } else outcome = await settleExisting(tx, m, mine, holder !== undefined && holder.id !== m.id, leaves, false);
      if (outcome === "update") toUpdate.push(m);
      else out.set(m.id, outcome);
    }
  });
  for (const m of toUpdate) {
    const outcome = await withLockedSubscriber(db, m.id, m.state.email, async (tx, s) => {
      if (!s) return skipped("removed in NoD since the last import");
      const rows = await currentRows(tx, [m.id], [m.state.email], true);
      const mine = rows.find((r) => r.id === m.id)!;
      const elsewhere = rows.some((r) => r.id !== m.id && r.email === m.state.email);
      const settled = await settleExisting(tx, m, mine, elsewhere, leavesOf(m.state.email), true);
      return settled === "update" ? skipped("changed while importing: run the import again") : settled;
    });
    out.set(m.id, outcome);
  }
  return out;
}

/** Legacy Subscriber + SubscriberList → NoD subscribers, subscriptions and history, in batches of 500. */
export async function importSubscribers(db: Db, source: LegacySource, ctx: SubscriberStageContext): Promise<Map<string, ImportedSubscriber>> {
  const { report, lists } = ctx;
  const legacy = await source.query<LegacySubscriberRow & Record<string, unknown>>(Q_SUBSCRIBERS);
  const memberships = await source.query<{ SubscriberGuid: string; ListGuid: string }>(Q_SUBSCRIBER_LISTS);
  const ended = await source.query<{ SubscriberGuid: string; EndedAt: Date }>(Q_ENDED);
  const leaves = await source.query<{ SubscriberGuid: string; ListGuid: string; LeftAt: Date }>(Q_MEDIA_LIST_LEAVES);
  report.count("Subscriber", "legacy", legacy.length);
  report.count("SubscriberList", "legacy", memberships.length);

  const listGuidsOf = new Map<string, string[]>();
  for (const m of memberships) {
    const s = guidKey(m.SubscriberGuid);
    listGuidsOf.set(s, [...(listGuidsOf.get(s) ?? []), guidKey(m.ListGuid)]);
  }
  const endedAt = new Map(ended.map((e) => [guidKey(e.SubscriberGuid), wallClockToInstant(e.EndedAt, ctx.timeZone)]));

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

  const mapped = winners.map((s) => {
    const guid = guidKey(s.SubscriberGuid);
    const own = (listGuidsOf.get(guid) ?? []).map((lg) => lists.byGuid.get(lg)).filter((x): x is MappedList => x !== undefined);
    return mapSubscriber(s, own, endedAt.get(guid) ?? null, ctx);
  });

  const result = new Map<string, ImportedSubscriber>();
  for (let i = 0; i < mapped.length; i += BATCH) {
    const batch = mapped.slice(i, i + BATCH);
    const outcomes = await writeBatch(db, batch, leavesOf);
    for (const m of batch) {
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
