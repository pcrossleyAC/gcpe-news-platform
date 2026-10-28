import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { sqlNow, type Db, type TestClock, type Tx } from "@gcpe/db-kit";
import { orgKeyFromName, type OrgRecord, type SubscriberConfig } from "@gcpe/events";
import { safeErrorLabel } from "@gcpe/http-kit";
import { wallClockToInstant } from "@gcpe/config";
import { cabinetChanges, organizations, userOrganizations } from "../db/schema";
import { lockAggregate, orgAggregateId, userAggregateId } from "./aggregate";
import {
  SuccessionError,
  createOrganization,
  deactivateOrganization,
  deferAbbreviationCheck,
  listOrganizations,
  orgCreateSchema,
  orgProfilePatchSchema,
  patchOrganizationProfile,
  succeedOrganization,
  successionInputSchema,
} from "./organizations";

/*
 * Staged cabinet change (new-government spec §5). A draft holds ministry operations; preview runs
 * them for real inside a transaction that is rolled back; publish runs the same code and commits.
 * Every operation goes through the same service function as the one-at-a-time Hub action
 * (patchOrganizationProfile, createOrganization, succeedOrganization, deactivateOrganization), so a
 * published change emits exactly the events those would, and NoD, the Calendar, NRMS and the News API
 * need nothing new.
 */

const expectedUpdatedAt = z.string().datetime({ offset: true });
const orgKey = z.string().trim().min(1);
/** A draft-local name for a ministry the change creates, so a hand-over in the same change can name it as successor. */
const ref = z.string().trim().min(1).max(60);

const updateOperationSchema = z
  .object({
    op: z.literal("update"),
    key: orgKey,
    expectedUpdatedAt,
    /** The Hub form's patch, abbreviation included. Deactivating is a hand-over or an abolish, never a patch; reactivating is allowed. */
    patch: orgProfilePatchSchema.extend({ isActive: z.literal(true).optional() }),
  })
  .strict();

const createOperationSchema = orgCreateSchema.omit({ parentKey: true }).extend({ op: z.literal("create"), ref }).strict();

const successorSchema = z
  .object({ key: orgKey.optional(), ref: ref.optional() })
  .strict()
  .refine((s) => (s.key === undefined) !== (s.ref === undefined), "Give an existing ministry's key or a new ministry's ref.");

const succeedOperationSchema = z
  .object({
    op: z.literal("succeed"),
    key: orgKey,
    expectedUpdatedAt,
    /** In order; the first gets the staff, the abbreviation and the redirect. Empty to abolish, which needs noSuccessor. */
    successors: z.array(successorSchema),
    moves: successionInputSchema.omit({ successorKeys: true }),
    /** The Hub's "No successor" tick: an abolish is a plain deactivate. */
    noSuccessor: z.boolean().optional(),
  })
  .strict();

export const cabinetOperationSchema = z.discriminatedUnion("op", [updateOperationSchema, createOperationSchema, succeedOperationSchema]);
export type CabinetOperation = z.infer<typeof cabinetOperationSchema>;
const cabinetOperationsSchema = z.array(cabinetOperationSchema).max(200);

export type CabinetChangeStatus = "draft" | "scheduled" | "published" | "cancelled";
export interface CabinetChangeRecord {
  id: string;
  status: CabinetChangeStatus;
  scheduledFor: string | null;
  operations: CabinetOperation[];
  createdBy: string | null;
  publishedAt: string | null;
  error: string | null;
  updatedAt: string;
}

/** A reason the change can't be published, against the index of the operation in the draft. */
export interface CabinetProblem {
  op: number;
  message: string;
}

/** One changed field of one ministry, old → new. A created ministry has `from: null` and only its set fields. */
export interface DiffRow {
  key: string;
  displayName: string;
  kind: "created" | "changed";
  field: string;
  from: unknown;
  to: unknown;
}

export type PublishResult = { result: "published" } | { result: "invalid"; problems: CabinetProblem[] } | { result: "stale"; key: string } | { result: "not-open" };

type Row = typeof cabinetChanges.$inferSelect;
const OPEN: CabinetChangeStatus[] = ["draft", "scheduled"];
/** Serialises every write of a cabinet change (save, schedule, cancel, publish). Taken before any organization lock. */
const CABINET_CHANGE_LOCK = "cabinet-change";

function toRecord(row: Row): CabinetChangeRecord {
  return {
    id: row.id,
    status: row.status,
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    operations: row.operations as CabinetOperation[],
    createdBy: row.createdBy,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    error: row.error,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function openRow(tx: Db | Tx): Promise<Row | undefined> {
  const [row] = await tx.select().from(cabinetChanges).where(inArray(cabinetChanges.status, OPEN)).limit(1);
  return row;
}

/** The open (draft or scheduled) change, if any. */
export async function getOpenCabinetChange(db: Db): Promise<CabinetChangeRecord | null> {
  const row = await openRow(db);
  return row ? toRecord(row) : null;
}

/**
 * Saves the operations as the open change, creating it when there is none (one open change at a
 * time). Saving a scheduled change returns it to draft: it must be previewed and scheduled again.
 * Throws ZodError for operations the schema refuses.
 */
export async function saveCabinetChangeDraft(db: Db, operations: unknown, createdBy: string | null): Promise<CabinetChangeRecord> {
  const parsed = cabinetOperationsSchema.parse(operations);
  return db.transaction(async (tx) => {
    await lockAggregate(tx, CABINET_CHANGE_LOCK);
    const open = await openRow(tx);
    if (open) {
      const [row] = await tx
        .update(cabinetChanges)
        .set({ operations: parsed, status: "draft", scheduledFor: null, error: null, transientFailures: 0, updatedAt: new Date() })
        .where(eq(cabinetChanges.id, open.id))
        .returning();
      return toRecord(row!);
    }
    const [row] = await tx.insert(cabinetChanges).values({ operations: parsed, status: "draft", createdBy }).returning();
    return toRecord(row!);
  });
}

/** Cancels the change if it is still open. */
export async function cancelCabinetChange(db: Db, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockAggregate(tx, CABINET_CHANGE_LOCK);
    const rows = await tx
      .update(cabinetChanges)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(cabinetChanges.id, id), inArray(cabinetChanges.status, OPEN)))
      .returning({ id: cabinetChanges.id });
    return rows.length > 0;
  });
}

/** Thrown to roll a transaction (or savepoint) back while handing a value out of it. */
class Rollback<T> {
  constructor(readonly value: T) {}
}

/** Runs `run`, answering a Rollback it throws with the value it carries. */
async function rolledBack<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof Rollback) return e.value as T;
    throw e;
  }
}

interface Applied {
  problems: CabinetProblem[];
  /** Operations whose expectedUpdatedAt no longer matches, in draft order. */
  stale: { op: number; key: string; displayName: string }[];
  before: OrgRecord[];
  after: OrgRecord[];
}

const staleMessage = (displayName: string) => `${displayName} was changed by someone else since this draft was started.`;

/** Each successor's key, with a created ministry's ref resolved. null when a ref names nothing created (yet). */
function successorKeys(op: Extract<CabinetOperation, { op: "succeed" }>, created: Map<string, string>): string[] | null {
  const keys = op.successors.map((s) => (s.key !== undefined ? s.key : created.get(s.ref!)));
  return keys.every((k): k is string => k !== undefined) ? keys : null;
}

/**
 * Runs the operations in `tx`. Locks first, all of them before any organization row is read or
 * written, in the order the one-at-a-time functions use, so this never deadlocks with them: every
 * organization this change names (sorted by key), then the users a hand-over may move (sorted by id),
 * then the abbreviation lock, held to the end. The service functions re-take these (advisory locks
 * are re-entrant).
 *
 * Abbreviations are checked against the resulting active set, like a deferred constraint (spec §5,
 * NG-R13): the per-write check is deferred for this transaction, so a swap or "create C with A's
 * abbreviation, then hand A over to C" may clash for a moment in between, and checkEndState runs
 * once on the final rows. Nothing is visible to anyone else until commit, and the abbreviation lock
 * keeps every other abbreviation write out until then.
 *
 * Then it checks each operation on its own (a missing ministry, a stale expectedUpdatedAt, a double
 * hand-over, a hand-over to a ministry the change also hands over, an abolish without "No successor", an unknown ref), and runs the rest, each in its own
 * savepoint, so a refused operation (a loop, an inactive successor, a name that already exists)
 * becomes a problem and the others still run and report. Run order: updates (renames and
 * reactivations, so a hand-over can name a ministry the change reactivates), then creates, then
 * hand-overs and abolishes; draft order within each. With `stopAtStale`, nothing runs once an
 * operation is stale.
 */
async function applyOperations(
  db: Db,
  tx: Tx,
  ops: CabinetOperation[],
  subscribers: SubscriberConfig[],
  opts: { now?: TestClock; stopAtStale: boolean },
): Promise<Applied> {
  const orgKeys = new Set<string>();
  for (const op of ops) {
    if (op.op === "create") {
      const key = orgKeyFromName(op.displayName);
      if (key) orgKeys.add(key);
    } else {
      orgKeys.add(op.key);
      if (op.op === "succeed") for (const s of op.successors) if (s.key !== undefined) orgKeys.add(s.key);
    }
  }
  for (const k of [...orgKeys].sort()) await lockAggregate(tx, orgAggregateId(k));
  // Anyone a hand-over in this change could move: the staff of every ministry handed over (a chain
  // A→B, B→C moves A's former staff on from B, and they are counted here under A).
  const sources = ops.filter((op) => op.op === "succeed" && op.moves.moveStaff && op.successors.length > 0).map((op) => (op as { key: string }).key);
  if (sources.length) {
    const staff = await tx
      .selectDistinct({ userId: userOrganizations.userId })
      .from(userOrganizations)
      .innerJoin(organizations, eq(organizations.id, userOrganizations.organizationId))
      .where(inArray(organizations.key, sources))
      .orderBy(asc(userOrganizations.userId));
    for (const { userId } of staff) await lockAggregate(tx, userAggregateId(userId));
  }
  await deferAbbreviationCheck(tx);

  const before = await listOrganizations(tx as unknown as Db);
  const byKey = new Map(before.map((o) => [o.key, o]));
  const problems: CabinetProblem[] = [];
  const stale: Applied["stale"] = [];
  const blocked = new Set<number>();
  const problem = (op: number, message: string) => {
    problems.push({ op, message });
    blocked.add(op);
  };
  const createdRefs = new Set(ops.flatMap((op) => (op.op === "create" ? [op.ref] : [])));
  const succeeded = new Set(ops.flatMap((op) => (op.op === "succeed" ? [op.key] : [])));
  const handedOver = new Set<string>();
  const refsSeen = new Set<string>();
  /** The first operation that gave each ministry its abbreviation or made it active, for the end-state check. */
  const claimedBy = new Map<string, number>();

  ops.forEach((op, i) => {
    if (op.op === "create") {
      if (!orgKeyFromName(op.displayName)) problem(i, `The name “${op.displayName}” needs a letter or digit.`);
      if (refsSeen.has(op.ref)) problem(i, `Two new ministries in this change are called “${op.ref}”.`);
      refsSeen.add(op.ref);
      return;
    }
    const org = byKey.get(op.key);
    if (!org) return problem(i, `The ministry “${op.key}” doesn't exist.`);
    if (new Date(op.expectedUpdatedAt).getTime() !== new Date(org.updatedAt).getTime()) {
      stale.push({ op: i, key: org.key, displayName: org.displayName });
      problem(i, staleMessage(org.displayName));
    }
    if (op.op === "update") {
      if (op.patch.isActive === true && succeeded.has(op.key)) problem(i, `${org.displayName} is handed over in this change, so it can't also be reactivated.`);
      return;
    }
    if (handedOver.has(op.key)) problem(i, `${org.displayName} is handed over more than once in this change.`);
    handedOver.add(op.key);
    if (op.noSuccessor && op.successors.length) problem(i, `Choose a successor for ${org.displayName} or choose “No successor (abolish it)”, not both.`);
    if (!op.noSuccessor && !op.successors.length) problem(i, `Choose a successor for ${org.displayName}, or choose “No successor (abolish it)”.`);
    for (const s of op.successors) if (s.ref !== undefined && !createdRefs.has(s.ref)) problem(i, `No new ministry in this change is called “${s.ref}”.`);
    // A chain (A→B, B→C or B abolished) in one change: consumers apply the two hand-overs in
    // whatever order they arrive, so A's subscribers, activities and drafts could land on B after
    // B's own moved on, and stay on an inactive ministry (final review I1). Hand A straight to C.
    for (const s of op.successors) {
      if (s.key === undefined || !succeeded.has(s.key) || s.key === op.key) continue;
      const successor = byKey.get(s.key)?.displayName ?? s.key;
      problem(i, `${successor} is handed over in this change, so it can't also take over ${org.displayName}'s work.`);
    }
  });

  if (!(opts.stopAtStale && stale.length)) {
    const phase = (op: CabinetOperation) => (op.op === "update" ? 0 : op.op === "create" ? 1 : 2);
    const order = ops
      .map((op, i) => ({ op, i }))
      .filter(({ i }) => !blocked.has(i))
      .sort((x, y) => phase(x.op) - phase(y.op) || x.i - y.i);
    const created = new Map<string, string>();
    for (const { op, i } of order) {
      try {
        await tx.transaction(async (sp) => {
          if (op.op === "update") {
            await patchOrganizationProfile(db, op.key, op.patch, subscribers, sp, opts.now);
            claimedBy.set(op.key, claimedBy.get(op.key) ?? i);
          } else if (op.op === "create") {
            const { ref: r, op: _op, ...input } = op;
            const result = await createOrganization(db, input, subscribers, sp, opts.now);
            if ("conflict" in result) return problem(i, `${op.displayName} already exists.`);
            created.set(r, result.record.key);
            claimedBy.set(result.record.key, claimedBy.get(result.record.key) ?? i);
          } else if (op.noSuccessor) {
            await deactivateOrganization(db, op.key, subscribers, sp, opts.now);
          } else {
            const keys = successorKeys(op, created);
            if (!keys) return problem(i, `A new ministry ${byKey.get(op.key)!.displayName} hands over to wasn't created.`);
            await succeedOrganization(db, op.key, { successorKeys: keys, ...op.moves }, subscribers, sp, opts.now);
            if (op.moves.takeAbbreviation) claimedBy.set(keys[0]!, claimedBy.get(keys[0]!) ?? i);
          }
        });
      } catch (e) {
        if (e instanceof SuccessionError) problem(i, e.message);
        else throw e;
      }
    }
  }

  const after = await listOrganizations(tx as unknown as Db);
  for (const p of endStateProblems(before, after, claimedBy)) problems.push(p);
  problems.sort((a, b) => a.op - b.op);
  return { problems, stale, before, after };
}

const abbreviationKey = (o: OrgRecord) => o.abbreviation?.trim().toUpperCase() || null;

function names(list: string[]): string {
  return list.length <= 2 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/**
 * The resulting-set rule (spec §5): no two active ministries may share an abbreviation. Only clashes
 * this change creates count: a ministry it creates, gives an abbreviation or reactivates. Clashes
 * already in the data (legacy imports repeat some) are left alone, as the one-at-a-time edits do.
 * Each problem goes on the first operation that made one of the ministries claim it.
 */
function endStateProblems(before: OrgRecord[], after: OrgRecord[], claimedBy: Map<string, number>): CabinetProblem[] {
  const old = new Map(before.map((o) => [o.key, o]));
  const holders = new Map<string, OrgRecord[]>();
  for (const o of after) {
    const abbreviation = abbreviationKey(o);
    if (!o.isActive || !abbreviation) continue;
    holders.set(abbreviation, [...(holders.get(abbreviation) ?? []), o]);
  }
  const problems: CabinetProblem[] = [];
  for (const [abbreviation, orgs] of holders) {
    if (orgs.length < 2) continue;
    const claimed = orgs.filter((o) => {
      const b = old.get(o.key);
      return !b || !b.isActive || abbreviationKey(b) !== abbreviation;
    });
    if (!claimed.length) continue;
    const op = Math.min(...claimed.map((o) => claimedBy.get(o.key) ?? 0));
    problems.push({ op, message: `${names(orgs.map((o) => o.displayName))} would ${orgs.length > 2 ? "all" : "both"} use the abbreviation ${abbreviation}.` });
  }
  return problems;
}

const CREATED_FIELDS = ["displayName", "abbreviation", "sortOrder", "isActive", "minister"] as const;

function diffOf(before: OrgRecord[], after: OrgRecord[]): DiffRow[] {
  const old = new Map(before.map((o) => [o.key, o]));
  const rows: DiffRow[] = [];
  for (const o of after) {
    const b = old.get(o.key);
    if (!b) {
      for (const field of CREATED_FIELDS) {
        const to = o[field];
        if (to === null || (field === "minister" && Object.values(o.minister).every((v) => v === null))) continue;
        rows.push({ key: o.key, displayName: o.displayName, kind: "created", field, from: null, to });
      }
      continue;
    }
    for (const field of Object.keys(o) as (keyof OrgRecord)[]) {
      if (field === "updatedAt" || field === "key") continue;
      if (JSON.stringify(b[field]) !== JSON.stringify(o[field])) rows.push({ key: o.key, displayName: o.displayName, kind: "changed", field, from: b[field], to: o[field] });
    }
  }
  return rows;
}

/** The stored operations, re-checked against today's schema. */
function operationsOf(row: Row): { ops: CabinetOperation[] } | { problems: CabinetProblem[] } {
  const parsed = cabinetOperationsSchema.safeParse(row.operations);
  if (parsed.success) return { ops: parsed.data };
  return { problems: parsed.error.issues.map((i) => ({ op: typeof i.path[0] === "number" ? i.path[0] : 0, message: "This change can't be read. Edit and save it again." })) };
}

/** Runs the operations in a savepoint of `tx` and rolls them back. */
function dryRun(db: Db, tx: Tx, ops: CabinetOperation[], now?: TestClock): Promise<Applied> {
  return rolledBack<Applied>(() =>
    tx.transaction(async (sp): Promise<never> => {
      throw new Rollback(await applyOperations(db, sp, ops, [], { now, stopAtStale: false }));
    }),
  );
}

/**
 * What publishing would do, without writing anything: each changed field (old → new), every
 * organization afterwards in sort order, and every problem (including stale ministries). Throws when
 * the change does not exist.
 */
export async function previewCabinetChange(
  db: Db,
  id: string,
): Promise<{ diff: DiffRow[]; resulting: OrgRecord[]; problems: CabinetProblem[] }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(cabinetChanges).where(eq(cabinetChanges.id, id));
    if (!row) throw new Error("cabinet change not found");
    const read = operationsOf(row);
    if ("problems" in read) {
      const orgs = await listOrganizations(tx as unknown as Db);
      return { diff: [], resulting: orgs, problems: read.problems };
    }
    const applied = await dryRun(db, tx, read.ops);
    return { diff: diffOf(applied.before, applied.after), resulting: applied.after, problems: applied.problems };
  });
}

type InternalPublish = Exclude<PublishResult, { result: "stale" }> | { result: "stale"; key: string; displayName: string } | { result: "not-due" };

async function publish(db: Db, id: string, subscribers: SubscriberConfig[], opts: { now?: TestClock; onlyIfDue?: boolean }): Promise<InternalPublish> {
  // Nothing is written before the last check, so the refusals simply return; a stale or invalid
  // change throws Rollback to undo the operations it ran.
  return rolledBack<InternalPublish>(() =>
    db.transaction(async (tx): Promise<InternalPublish> => {
      await lockAggregate(tx, CABINET_CHANGE_LOCK);
      const [row] = await tx.select().from(cabinetChanges).where(eq(cabinetChanges.id, id));
      if (!row || !OPEN.includes(row.status)) return { result: "not-open" };
      if (opts.onlyIfDue) {
        // Re-checked under the lock: an admin may have edited it (back to draft) or rescheduled it since the worker looked.
        const [due] = await tx
          .select({ id: cabinetChanges.id })
          .from(cabinetChanges)
          .where(and(eq(cabinetChanges.id, id), eq(cabinetChanges.status, "scheduled"), sql`${cabinetChanges.scheduledFor} <= ${sqlNow(opts.now)}`));
        if (!due) return { result: "not-due" };
      }
      const read = operationsOf(row);
      if ("problems" in read) return { result: "invalid", problems: read.problems };
      // One instant for every stamp this publish writes: each ministry's updatedAt and staffEditedAt,
      // org.succeeded's `at`, and publishedAt.
      const at = opts.now ? opts.now() : new Date();
      const applied = await applyOperations(db, tx, read.ops, subscribers, { now: () => at, stopAtStale: true });
      const first = applied.stale[0];
      if (first) throw new Rollback({ result: "stale", key: first.key, displayName: first.displayName });
      if (applied.problems.length) throw new Rollback({ result: "invalid", problems: applied.problems });
      await tx.update(cabinetChanges).set({ status: "published", publishedAt: at, error: null, updatedAt: at }).where(eq(cabinetChanges.id, id));
      return { result: "published" };
    }),
  );
}

/**
 * Publishes the change in one transaction: every operation through its one-at-a-time service
 * function, or nothing. A stale expectedUpdatedAt refuses the whole change, naming the first stale
 * ministry; any other problem refuses it with every problem found. `now` is a test clock.
 */
export async function publishCabinetChange(db: Db, id: string, subscribers: SubscriberConfig[], opts: { now?: TestClock } = {}): Promise<PublishResult> {
  const result = await publish(db, id, subscribers, { now: opts.now });
  if (result.result === "stale") return { result: "stale", key: result.key };
  if (result.result === "not-due") return { result: "not-open" };
  return result;
}

export type ScheduleResult =
  | { result: "scheduled"; change: CabinetChangeRecord }
  | { result: "invalid"; problems: CabinetProblem[] }
  | { result: "past" }
  | { result: "not-open" };

/**
 * Schedules the open change to publish at `at` (the swearing-in time). Refuses a time not in the
 * future, and a change whose preview has problems (stale ministries included).
 */
export async function scheduleCabinetChange(db: Db, id: string, at: Date, now?: TestClock): Promise<ScheduleResult> {
  if (at.getTime() <= (now ? now() : new Date()).getTime()) return { result: "past" };
  return db.transaction(async (tx): Promise<ScheduleResult> => {
    await lockAggregate(tx, CABINET_CHANGE_LOCK);
    const [row] = await tx.select().from(cabinetChanges).where(eq(cabinetChanges.id, id));
    if (!row || !OPEN.includes(row.status)) return { result: "not-open" };
    const read = operationsOf(row);
    if ("problems" in read) return { result: "invalid", problems: read.problems };
    const { problems } = await dryRun(db, tx, read.ops, now);
    if (problems.length) return { result: "invalid", problems };
    const [updated] = await tx
      .update(cabinetChanges)
      .set({ status: "scheduled", scheduledFor: at, error: null, transientFailures: 0, updatedAt: new Date() })
      .where(eq(cabinetChanges.id, id))
      .returning();
    return { result: "scheduled", change: toRecord(updated!) };
  });
}

/** The tenant zone when none is configured. */
export const DEFAULT_TIME_ZONE = "America/Vancouver";

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * A BC wall-clock "YYYY-MM-DDTHH:mm" (what the Hub's schedule picker holds) as the real instant in
 * `timeZone`, by this server's tzdata (NG-R15: the server converts, never the browser). Null for a
 * malformed or impossible date or time (e.g. 2026-02-30, 24:00).
 */
export function localToInstant(local: string, timeZone: string): Date | null {
  const m = LOCAL_DATE_TIME.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const wall = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (wall.getUTCFullYear() !== y || wall.getUTCMonth() !== mo - 1 || wall.getUTCDate() !== d || wall.getUTCHours() !== h || wall.getUTCMinutes() !== mi) return null;
  return wallClockToInstant(wall, timeZone);
}

/** The inverse of {@link localToInstant}: the "YYYY-MM-DDTHH:mm" `timeZone`'s clock shows at `iso`, by this server's tzdata. */
export function instantToLocal(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/**
 * Worth one more try: a deadlock or serialization failure (a clash with another writer), too many
 * clients (53300), an admin shutdown (57P01), or any connection exception (class 08), all of which
 * shared Postgres hosting (SiteGround) produces in passing.
 */
const TRANSIENT_SQLSTATES = new Set(["40P01", "40001", "53300", "57P01"]);
const isTransient = (state: string) => TRANSIENT_SQLSTATES.has(state) || state.startsWith("08");

function sqlStateOf(e: unknown): string | undefined {
  let c: unknown = e;
  for (let i = 0; i < 5 && c && typeof c === "object"; i++) {
    const code = (c as { code?: unknown }).code;
    if (typeof code === "string") return code;
    c = (c as { cause?: unknown }).cause;
  }
  return undefined;
}

const GENERIC_SCHEDULED_ERROR = "Not published at the scheduled time: something went wrong while publishing. Review the change and schedule it again.";

/**
 * The scheduler's step (Core's loop and the stack's core.cabinet-changes tick): publishes each
 * scheduled change whose time has come (by the database clock, or the test clock). One that can't be
 * published goes back to draft, unscheduled, with the reason in `error`, so it is not retried every
 * tick and the Hub shows why. That includes an unexpected error (logged, with a generic message in
 * `error`). The write-back matches the scheduled time the worker saw, so a reschedule made meanwhile
 * survives.
 */
export async function publishDueCabinetChanges(db: Db, subscribers: SubscriberConfig[], now?: TestClock): Promise<{ published: number; failed: number }> {
  const due = await db
    .select({ id: cabinetChanges.id, scheduledFor: cabinetChanges.scheduledFor, transientFailures: cabinetChanges.transientFailures })
    .from(cabinetChanges)
    .where(and(eq(cabinetChanges.status, "scheduled"), sql`${cabinetChanges.scheduledFor} <= ${sqlNow(now)}`))
    .orderBy(asc(cabinetChanges.scheduledFor));
  let published = 0;
  let failed = 0;
  for (const { id, scheduledFor, transientFailures } of due) {
    // This attempt is still for the time the worker saw: a save or reschedule meanwhile wins.
    const unchanged = and(eq(cabinetChanges.id, id), eq(cabinetChanges.status, "scheduled"), eq(cabinetChanges.scheduledFor, scheduledFor!));
    let error: string;
    let reason: string;
    try {
      const result = await publish(db, id, subscribers, { now, onlyIfDue: true });
      if (result.result === "published") published++;
      if (result.result !== "stale" && result.result !== "invalid") continue;
      reason = result.result;
      error = `Not published at the scheduled time: ${result.result === "stale" ? staleMessage(result.displayName) : result.problems.map((p) => p.message).join(" ")}`;
    } catch (e) {
      const state = sqlStateOf(e);
      if (state && isTransient(state) && transientFailures === 0) {
        // Nothing was written (one transaction): leave it scheduled, note the failure on the row,
        // and try once more next tick. The note is stored so the bound holds across processes.
        const noted = await db.transaction(async (tx) => {
          await lockAggregate(tx, CABINET_CHANGE_LOCK);
          return tx
            .update(cabinetChanges)
            .set({ transientFailures: 1 })
            .where(and(unchanged, eq(cabinetChanges.transientFailures, 0)))
            .returning({ id: cabinetChanges.id });
        });
        if (noted.length) {
          console.warn("[core] scheduled cabinet change hit a transient database error; retrying next tick", { id, sqlState: state });
          continue;
        }
      }
      console.error("[core] scheduled cabinet change failed", { id }, safeErrorLabel(e));
      reason = "error";
      error = GENERIC_SCHEDULED_ERROR;
    }
    const rows = await db.transaction(async (tx) => {
      await lockAggregate(tx, CABINET_CHANGE_LOCK);
      return tx
        .update(cabinetChanges)
        .set({ status: "draft", scheduledFor: null, error, transientFailures: 0, updatedAt: new Date() })
        .where(unchanged)
        .returning({ id: cabinetChanges.id });
    });
    if (rows.length) {
      failed++;
      console.warn("[core] scheduled cabinet change not published", { id, reason });
    }
  }
  return { published, failed };
}
