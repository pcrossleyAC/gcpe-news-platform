import { and, asc, count, eq, inArray, max, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx, TestClock, Tx } from "@gcpe/db-kit";
import { enqueueEvent, orgKeyFromName, orgRecordSchema, type OrgRecord, type OrgSucceeded, type SubscriberConfig } from "@gcpe/events";
import { isSafeUrl } from "@gcpe/site-settings";
import { organizations, userOrganizations } from "../db/schema";
import { CORE_SOURCE, lockAggregate, orgAggregateId, userAggregateId } from "./aggregate";
import { emitUserUpserted } from "./users";

/**
 * isHq and isPublic are both optional on input: omitted keeps the stored flag (false for isHq,
 * true for isPublic, on a new organization). The BC seed and the legacy importer send either
 * flag only when they create the organization, so a re-seed or re-import never changes a flag
 * Core.Admin has set, in either direction (C124).
 *
 * successorKeys is not input at all: only a hand-over (succeedOrganization) sets it and only
 * reactivation clears it, so a re-seed, re-import or PUT can neither set nor wipe it.
 */
export const orgInputSchema = orgRecordSchema
  .omit({ updatedAt: true, isHq: true, isPublic: true, successorKeys: true })
  .extend({ isHq: z.boolean().optional(), isPublic: z.boolean().optional() });
export type OrgInput = z.infer<typeof orgInputSchema>;

/** Legacy abbreviations of the HQ organizations (Q49): GCPE Headquarters, GCPE Media Relations and the Office of the Premier. Legacy matched HQ by Ministry.Abbreviation. */
export const HQ_ABBREVIATIONS = ["GCPEHQ", "GCPEMEDIA", "PREM"] as const;

export function isHqAbbreviation(abbreviation: string | null | undefined): boolean {
  return abbreviation != null && (HQ_ABBREVIATIONS as readonly string[]).includes(abbreviation.trim().toUpperCase());
}

/** Legacy abbreviations of the organizations hidden from public lists (Q54). The Office of the
 * Premier is HQ but public, so this is not HQ_ABBREVIATIONS. */
export const NON_PUBLIC_ABBREVIATIONS = ["GCPEHQ", "GCPEMEDIA"] as const;

export function isNonPublicAbbreviation(abbreviation: string | null | undefined): boolean {
  return abbreviation != null && (NON_PUBLIC_ABBREVIATIONS as readonly string[]).includes(abbreviation.trim().toUpperCase());
}

type Row = typeof organizations.$inferSelect;

export function toOrgRecord(row: Row): OrgRecord {
  return {
    key: row.key,
    displayName: row.displayName,
    abbreviation: row.abbreviation,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    parentKey: row.parentKey,
    url: row.url,
    displayAdditionalName: row.displayAdditionalName,
    minister: row.minister,
    contact: row.contact ?? null,
    secondContact: row.secondContact ?? null,
    weekendContactNumber: row.weekendContactNumber,
    social: row.social,
    topicLinks: row.topicLinks,
    serviceLinks: row.serviceLinks,
    sectorKeys: row.sectorKeys,
    isHq: row.isHq,
    isPublic: row.isPublic,
    successorKeys: row.successorKeys,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sameContent(a: OrgInput, b: OrgInput): boolean {
  return JSON.stringify(orgInputSchema.parse(a)) === JSON.stringify(orgInputSchema.parse(b));
}

export async function upsertOrganization(
  db: Db,
  input: OrgInput,
  subscribers: SubscriberConfig[],
  opts: {
    legacyId?: string;
    /** The HQ flag to give the organization if this upsert creates it. Ignored when it already exists, whatever the stored flag. */
    isHqOnCreate?: boolean;
    /** The public flag to give the organization if this upsert creates it. Ignored when it already exists. */
    isPublicOnCreate?: boolean;
    /** Stamp staffEditedAt: the write comes from a staff edit in the Hub, not the seed or importer. */
    staffEdit?: boolean;
    /** The clock for updatedAt and staffEditedAt (a cabinet change stamps one instant on everything it publishes). */
    now?: TestClock;
    /** Leave a staff-edited organization untouched (no write at all, legacyId backfill included) and report skippedStaffEdit. For the seed and importer; staff edits never pass it. */
    respectStaffEdits?: boolean;
  } = {},
): Promise<{ record: OrgRecord; changed: boolean; skippedStaffEdit?: true }> {
  const parsed = orgInputSchema.parse(input);
  return db.transaction(async (tx) => {
    await lockAggregate(tx, orgAggregateId(parsed.key));
    const [existing] = await tx.select().from(organizations).where(eq(organizations.key, parsed.key)).for("update");
    if (opts.respectStaffEdits && existing?.staffEditedAt) {
      return { record: toOrgRecord(existing), changed: false, skippedStaffEdit: true };
    }
    const data = {
      ...parsed,
      isHq: parsed.isHq ?? (existing ? existing.isHq : (opts.isHqOnCreate ?? false)),
      isPublic: parsed.isPublic ?? (existing ? existing.isPublic : (opts.isPublicOnCreate ?? true)),
    };
    // An active ministry has no successors: reactivating one, by any path, stops its redirect (N12).
    const clearSuccessors = data.isActive && (existing?.successorKeys.length ?? 0) > 0;
    if (existing) {
      const { updatedAt: _u, ...current } = toOrgRecord(existing);
      if (!clearSuccessors && sameContent(current, data)) {
        if (opts.legacyId !== undefined && opts.legacyId !== existing.legacyId) {
          const [row] = await tx
            .update(organizations)
            .set({ legacyId: opts.legacyId })
            .where(eq(organizations.key, data.key))
            .returning();
          return { record: toOrgRecord(row!), changed: false };
        }
        return { record: toOrgRecord(existing), changed: false };
      }
    }
    const values = {
      ...data,
      legacyId: opts.legacyId ?? existing?.legacyId ?? null,
      updatedAt: opts.now ? opts.now() : new Date(),
      ...(opts.staffEdit ? { staffEditedAt: opts.now ? opts.now() : new Date() } : {}),
      ...(clearSuccessors ? { successorKeys: [] } : {}),
    };
    const [row] = await tx
      .insert(organizations)
      .values(values)
      .onConflictDoUpdate({ target: organizations.key, set: values })
      .returning();
    const record = toOrgRecord(row!);
    await enqueueEvent(tx, { type: "org.upserted", source: CORE_SOURCE, aggregateId: orgAggregateId(record.key), data: record }, subscribers);
    return { record, changed: true };
  });
}

const trimmedOrNull = z
  .string()
  .nullable()
  .transform((v) => (v === null ? null : v.trim() || null));

/** An absolute https address with a host (the ministry website, Flickr and YouTube addresses); blank clears it. */
const httpsUrlOrNull = trimmedOrNull.pipe(
  z
    .string()
    .refine((u) => isSafeUrl(u) && !u.startsWith("/"), "Must start with https://.")
    .nullable(),
);

/** A side-column link (Featured Topics / Featured Services): the site-settings safe-URL rule and messages. */
const sideLinkSchema = z
  .object({
    text: z.string().trim().min(1, "Enter the link text."),
    url: z.string().trim().refine(isSafeUrl, "Must start with https:// or / (a page on this site)."),
  })
  .strict();

export const MAX_SIDE_LINKS = 20;
const sideLinksSchema = z.array(sideLinkSchema).max(MAX_SIDE_LINKS, `Use ${MAX_SIDE_LINKS} links or fewer.`);

/** The NRMS release-number prefix (e.g. 2026HLTH0001): trimmed, upper-cased, 2 to 10 capital letters or digits. */
export const abbreviationSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,10}$/, "Use 2 to 10 capital letters or digits, e.g. HLTH.");

/** The advisory lock every Hub write of an abbreviation takes, after the organizations' own locks (and any user locks). */
export const ABBREVIATIONS_LOCK = "org-abbreviations";

/** Another organization already uses this abbreviation (compared case-insensitively). The route answers 409. */
export class AbbreviationTakenError extends Error {
  constructor(readonly takenBy: string) {
    super("abbreviation taken");
    this.name = "AbbreviationTakenError";
  }
}

/**
 * Refuses an abbreviation another active organization holds (N11: an inactive ministry's abbreviation
 * is free, so a successor can take it). There is no unique index: the legacy importer
 * and seed write abbreviations as news.gov has them, so existing data may already repeat one. Instead,
 * every Hub write of an abbreviation takes one shared lock first, so two concurrent claims serialise
 * and the second sees the first. Callers hold their own org lock already (always taken before this one).
 */
async function assertAbbreviationFree(tx: Tx, abbreviation: string, key: string): Promise<void> {
  await lockAggregate(tx, ABBREVIATIONS_LOCK);
  if (await abbreviationCheckDeferred(tx)) return;
  const [other] = await tx
    .select({ displayName: organizations.displayName })
    .from(organizations)
    .where(and(sql`upper(trim(${organizations.abbreviation})) = ${abbreviation}`, ne(organizations.key, key), eq(organizations.isActive, true)))
    .orderBy(asc(organizations.sortOrder), asc(organizations.key))
    .limit(1);
  if (other) throw new AbbreviationTakenError(other.displayName);
}

const DEFER_ABBREVIATION_CHECK = "gcpe.defer_abbreviation_check";

/**
 * Defers the abbreviation check for the rest of `tx` (savepoints included), like a deferred
 * constraint: a cabinet change validates abbreviations against the resulting active set once,
 * before commit (spec §5, NG-R13), so a swap or a merge may clash for a moment in between. The
 * caller must hold ABBREVIATIONS_LOCK until commit and run that end-state check itself.
 */
export async function deferAbbreviationCheck(tx: Tx): Promise<void> {
  await lockAggregate(tx, ABBREVIATIONS_LOCK);
  await tx.execute(sql`select set_config(${DEFER_ABBREVIATION_CHECK}, 'on', true)`);
}

async function abbreviationCheckDeferred(tx: Tx): Promise<boolean> {
  const { rows } = await tx.execute<{ v: string | null }>(sql`select current_setting(${DEFER_ABBREVIATION_CHECK}, true) as v`);
  return rows[0]?.v === "on";
}

/** What the Hub's organization form may change. Everything else on the record survives a save untouched. */
export const orgProfilePatchSchema = z
  .object({
    displayName: z.string().trim().min(1),
    sortOrder: z.number().int(),
    minister: z
      .object({
        name: trimmedOrNull,
        summary: trimmedOrNull,
        email: trimmedOrNull.pipe(z.string().email().nullable()),
        photoUrl: trimmedOrNull.pipe(
          z
            .string()
            .url()
            .refine((u) => new URL(u).protocol === "https:", "photoUrl must be https")
            .nullable(),
        ),
        /** Only null is accepted: the form can remove the biography but never write one (v1 has no biography editor). */
        detailsHtml: z.null(),
      })
      .partial()
      .strict(),
    parentKey: trimmedOrNull,
    isActive: z.boolean(),
    abbreviation: abbreviationSchema,
    /** The ministry page's side column (More from this Ministry, Featured Topics, Featured Services). */
    url: httpsUrlOrNull,
    topicLinks: sideLinksSchema,
    serviceLinks: sideLinksSchema,
    social: z.object({ flickrUrl: httpsUrlOrNull, youtubeUrl: httpsUrlOrNull }).partial().strict(),
  })
  .partial()
  .strict();
export type OrgProfilePatch = z.infer<typeof orgProfilePatchSchema>;

/** Profile fields only Core.Admin may change. isHq and isPublic are not in the schema at all; the route rejects them first. */
export const ADMIN_ONLY_PROFILE_FIELDS = ["parentKey", "isActive", "abbreviation"] as const;

/**
 * Staff edit of the form fields. Merges `minister` and `social` field by field onto the stored ones
 * (lists are replaced whole), refuses an abbreviation another organization holds, reuses the
 * upsert path (so org.upserted fires only on a real change) and stamps staffEditedAt when it writes.
 * Returns null when the key does not exist; throws AbbreviationTakenError. Uses the caller's
 * transaction when `tx` is given (a cabinet change).
 */
export async function patchOrganizationProfile(
  db: Db,
  key: string,
  patch: OrgProfilePatch,
  subscribers: SubscriberConfig[],
  tx?: Tx,
  now?: TestClock,
): Promise<OrgRecord | null> {
  const parsed = orgProfilePatchSchema.parse(patch);
  const run = async (tx: Tx): Promise<OrgRecord | null> => {
    await lockAggregate(tx, orgAggregateId(key));
    const [existing] = await tx.select().from(organizations).where(eq(organizations.key, key)).for("update");
    if (!existing) return null;
    const { updatedAt: _u, isHq: _h, isPublic: _p, ...current } = toOrgRecord(existing);
    const { minister, social, ...rest } = parsed;
    if (rest.abbreviation !== undefined && rest.abbreviation !== current.abbreviation?.trim().toUpperCase()) {
      await assertAbbreviationFree(tx, rest.abbreviation, key);
    } else if (rest.isActive === true && !existing.isActive && current.abbreviation?.trim()) {
      // Reactivating: a successor may have taken this abbreviation meanwhile (N11), and two active
      // holders would issue the same release numbers.
      await assertAbbreviationFree(tx, current.abbreviation.trim().toUpperCase(), key);
    }
    const merged: OrgInput = { ...current, ...rest, minister: { ...current.minister, ...minister }, social: { ...current.social, ...social } };
    // tx is a Db-compatible handle; upsertOrganization opens a nested transaction (savepoint) on it and re-takes the same lock.
    return (await upsertOrganization(tx as unknown as Db, merged, subscribers, { staffEdit: true, now })).record;
  };
  return tx ? run(tx) : db.transaction(run);
}

export const orgCreateSchema = z
  .object({
    displayName: z.string().trim().min(1),
    sortOrder: z.number().int().optional(),
    parentKey: trimmedOrNull.optional(),
    minister: orgProfilePatchSchema.shape.minister.optional(),
    abbreviation: abbreviationSchema.optional(),
  })
  .strict();
export type OrgCreate = z.infer<typeof orgCreateSchema>;

/**
 * Creates an organization whose key is derived from its name. New ministries are public, active, not HQ,
 * and staff-edited (so the seed and importer leave them alone). Returns `{ conflict: key }` when the key
 * already exists (active or not), throws when the name yields no key, and throws AbbreviationTakenError
 * when another organization holds the abbreviation. Uses the caller's transaction when `tx` is given (a cabinet change).
 */
export async function createOrganization(
  db: Db,
  input: { displayName: string; sortOrder?: number; parentKey?: string | null; minister?: Partial<OrgRecord["minister"]>; abbreviation?: string },
  subscribers: SubscriberConfig[],
  tx?: Tx,
  clock?: TestClock,
): Promise<{ record: OrgRecord } | { conflict: string }> {
  const displayName = input.displayName.trim();
  const key = orgKeyFromName(displayName);
  if (!key) throw new Error("displayName must contain a letter or digit");
  const abbreviation = input.abbreviation === undefined ? null : abbreviationSchema.parse(input.abbreviation);
  const run = async (tx: Tx): Promise<{ record: OrgRecord } | { conflict: string }> => {
    await lockAggregate(tx, orgAggregateId(key));
    if (abbreviation !== null) await assertAbbreviationFree(tx, abbreviation, key);
    const sortOrder = input.sortOrder ?? ((await tx.select({ m: max(organizations.sortOrder) }).from(organizations))[0]?.m ?? 0) + 10;
    const now = clock ? clock() : new Date();
    const [row] = await tx
      .insert(organizations)
      .values({
        key,
        displayName,
        abbreviation,
        sortOrder,
        isActive: true,
        parentKey: input.parentKey ?? null,
        url: null,
        displayAdditionalName: null,
        minister: { name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null, ...input.minister },
        contact: null,
        secondContact: null,
        weekendContactNumber: null,
        social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
        topicLinks: [],
        serviceLinks: [],
        sectorKeys: [],
        isHq: false,
        isPublic: true,
        updatedAt: now,
        staffEditedAt: now,
      })
      .onConflictDoNothing({ target: organizations.key })
      .returning();
    if (!row) return { conflict: key };
    const record = toOrgRecord(row);
    await enqueueEvent(tx, { type: "org.upserted", source: CORE_SOURCE, aggregateId: orgAggregateId(key), data: record }, subscribers);
    return { record };
  };
  return tx ? run(tx) : db.transaction(run);
}

/** Core.Admin's HQ switch. Emits org.upserted only when the flag changes. */
export async function setOrganizationHq(db: Db, key: string, isHq: boolean, subscribers: SubscriberConfig[]): Promise<OrgRecord | null> {
  return db.transaction(async (tx) => {
    await lockAggregate(tx, orgAggregateId(key));
    const [existing] = await tx.select().from(organizations).where(eq(organizations.key, key)).for("update");
    if (!existing) return null;
    if (existing.isHq === isHq) return toOrgRecord(existing);
    const [row] = await tx.update(organizations).set({ isHq, updatedAt: new Date() }).where(eq(organizations.key, key)).returning();
    const record = toOrgRecord(row!);
    await enqueueEvent(tx, { type: "org.upserted", source: CORE_SOURCE, aggregateId: orgAggregateId(key), data: record }, subscribers);
    return record;
  });
}

/** Core.Admin's public switch (Q54). Emits org.upserted only when the flag changes. */
export async function setOrganizationPublic(db: Db, key: string, isPublic: boolean, subscribers: SubscriberConfig[]): Promise<OrgRecord | null> {
  return db.transaction(async (tx) => {
    await lockAggregate(tx, orgAggregateId(key));
    const [existing] = await tx.select().from(organizations).where(eq(organizations.key, key)).for("update");
    if (!existing) return null;
    if (existing.isPublic === isPublic) return toOrgRecord(existing);
    const [row] = await tx.update(organizations).set({ isPublic, updatedAt: new Date() }).where(eq(organizations.key, key)).returning();
    const record = toOrgRecord(row!);
    await enqueueEvent(tx, { type: "org.upserted", source: CORE_SOURCE, aggregateId: orgAggregateId(key), data: record }, subscribers);
    return record;
  });
}

/** Plain deactivation (no successor). Uses the caller's transaction when `tx` is given (a cabinet change's abolish). */
export async function deactivateOrganization(db: Db, key: string, subscribers: SubscriberConfig[], tx?: Tx, clock?: TestClock): Promise<boolean> {
  const run = async (tx: Tx): Promise<boolean> => {
    await lockAggregate(tx, orgAggregateId(key));
    const [existing] = await tx.select().from(organizations).where(eq(organizations.key, key)).for("update");
    if (!existing) return false;
    if (!existing.isActive) return true;
    const now = clock ? clock() : new Date();
    await tx.update(organizations).set({ isActive: false, updatedAt: now, staffEditedAt: now }).where(eq(organizations.key, key));
    await enqueueEvent(tx, { type: "org.deactivated", source: CORE_SOURCE, aggregateId: orgAggregateId(key), data: { key } }, subscribers);
    return true;
  };
  return tx ? run(tx) : db.transaction(run);
}

export async function listOrganizations(db: Db): Promise<OrgRecord[]> {
  const rows = await db.select().from(organizations).orderBy(asc(organizations.sortOrder), asc(organizations.key));
  return rows.map(toOrgRecord);
}

export async function getOrganization(db: Db, key: string): Promise<OrgRecord | null> {
  const [row] = await db.select().from(organizations).where(eq(organizations.key, key));
  return row ? toOrgRecord(row) : null;
}

/** What a hand-over moves (new-government spec §4). Each flag is a checkbox in the Hub, on by default (N8). */
export const successionInputSchema = z
  .object({
    successorKeys: z.array(z.string().trim().min(1)).min(1),
    moveSubscribers: z.boolean(),
    moveStaff: z.boolean(),
    moveCalendar: z.boolean(),
    moveDrafts: z.boolean(),
    takeAbbreviation: z.boolean(),
  })
  .strict();
export type SuccessionInput = z.infer<typeof successionInputSchema>;

/** A hand-over Core refuses. The route answers 422 with the message, which is Hub copy. */
export class SuccessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuccessionError";
  }
}

/**
 * Hands ministry `key` (A) over to `input.successorKeys` in one transaction (the caller's, when `tx`
 * is given): A becomes inactive with those successors (in order, duplicates dropped); with moveStaff,
 * A's user_organizations rows move to the first successor (B), skipping users already on B; with
 * takeAbbreviation, B gets A's abbreviation (free once A is inactive, N11). Emits org.upserted for A
 * (when it changed), org.deactivated (when A was active), org.upserted for B (when it changed),
 * org.succeeded, then user.upserted per moved user. NoD, the Calendar and NRMS do their own moves
 * from org.succeeded, so it is emitted even when nothing changed in Core (a re-sent hand-over).
 *
 * Returns null when A does not exist. Throws SuccessionError (a missing or inactive successor, A
 * itself, or a successor whose chain leads back to A) and AbbreviationTakenError (another active
 * ministry holds A's abbreviation), in both cases before anything is written. `now` (a test clock,
 * or a scheduled cabinet change's publish time) stamps the rows and the event's `at`.
 */
export async function succeedOrganization(
  db: Db,
  key: string,
  input: SuccessionInput,
  subscribers: SubscriberConfig[],
  tx?: Tx,
  now?: TestClock,
): Promise<OrgRecord | null> {
  const run = async (tx: Tx): Promise<OrgRecord | null> => {
    const successorKeys = [...new Set(input.successorKeys)];
    // Every organization lock in key order, so two hand-overs touching the same ministries can't
    // deadlock (A→B against B→A). Every Core write of an organization takes its lock, so the rows
    // are read without FOR UPDATE (see the user locks below). The abbreviation lock comes last.
    for (const k of [...new Set([key, ...successorKeys])].sort()) await lockAggregate(tx, orgAggregateId(k));
    const [a] = await tx.select().from(organizations).where(eq(organizations.key, key));
    if (!a) return null;
    if (successorKeys.includes(key)) throw new SuccessionError("A ministry can't succeed itself.");
    const found = successorKeys.length
      ? await tx.select().from(organizations).where(inArray(organizations.key, successorKeys))
      : [];
    const byKey = new Map(found.map((o) => [o.key, o]));
    if (!successorKeys.length || successorKeys.some((k) => !byKey.get(k)?.isActive)) throw new SuccessionError("Choose an active ministry as successor.");
    await assertNoLoop(tx, a, successorKeys.map((k) => byKey.get(k)!));

    // The users' locks before any organization row is locked or written: setCalendarAccess takes a
    // user's lock and then shares the rows of that user's ministries, so the other order could deadlock.
    const b = byKey.get(successorKeys[0]!)!;
    const movers = input.moveStaff ? await staffOf(tx, a.id) : [];
    for (const id of movers) await lockAggregate(tx, userAggregateId(id));

    const stampedAt = now ? now() : new Date();
    const changedA = a.isActive || JSON.stringify(a.successorKeys) !== JSON.stringify(successorKeys);
    let recordA = toOrgRecord(a);
    if (changedA) {
      const [row] = await tx
        .update(organizations)
        .set({ isActive: false, successorKeys, updatedAt: stampedAt, staffEditedAt: stampedAt })
        .where(eq(organizations.id, a.id))
        .returning();
      recordA = toOrgRecord(row!);
    }

    // A is inactive now, so its own abbreviation no longer counts against B.
    const abbreviation = a.abbreviation?.trim().toUpperCase() || null;
    const takeAbbreviation = input.takeAbbreviation && abbreviation !== null;
    let recordB: OrgRecord | null = null;
    if (takeAbbreviation && b.abbreviation?.trim().toUpperCase() !== abbreviation) {
      await assertAbbreviationFree(tx, abbreviation, b.key);
      const [row] = await tx
        .update(organizations)
        .set({ abbreviation, updatedAt: stampedAt, staffEditedAt: stampedAt })
        .where(eq(organizations.id, b.id))
        .returning();
      recordB = toOrgRecord(row!);
    }

    if (movers.length) {
      await tx.insert(userOrganizations).values(movers.map((userId) => ({ userId, organizationId: b.id }))).onConflictDoNothing();
      await tx.delete(userOrganizations).where(and(eq(userOrganizations.organizationId, a.id), inArray(userOrganizations.userId, movers)));
    }

    const event = (type: string, aggregateKey: string, data: unknown) =>
      enqueueEvent(tx, { type, source: CORE_SOURCE, aggregateId: orgAggregateId(aggregateKey), data }, subscribers);
    if (changedA) await event("org.upserted", key, recordA);
    if (a.isActive) await event("org.deactivated", key, { key });
    if (recordB) await event("org.upserted", b.key, recordB);
    const succeeded: OrgSucceeded = {
      key,
      successorKeys,
      moveSubscribers: input.moveSubscribers,
      moveCalendar: input.moveCalendar,
      moveDrafts: input.moveDrafts,
      takeAbbreviation,
      at: stampedAt.toISOString(),
    };
    await event("org.succeeded", key, succeeded);
    for (const id of movers) await emitUserUpserted(tx, id, subscribers);
    return recordA;
  };
  return tx ? run(tx) : db.transaction(run);
}

/** The ids of the users who belong to an organization, sorted (the order their locks are taken and their events emitted). */
async function staffOf(tx: Tx, organizationId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: userOrganizations.userId })
    .from(userOrganizations)
    .where(eq(userOrganizations.organizationId, organizationId))
    .orderBy(asc(userOrganizations.userId));
  return rows.map((r) => r.userId);
}

/**
 * Refuses a successor whose own chain of successors (every branch, through inactive ministries)
 * already reaches A: the redirects would loop.
 */
async function assertNoLoop(tx: Tx, a: Row, successors: Row[]): Promise<void> {
  const rows = await tx.select({ key: organizations.key, successorKeys: organizations.successorKeys }).from(organizations);
  const next = new Map(rows.map((r) => [r.key, r.successorKeys]));
  for (const s of successors) {
    const seen = new Set<string>();
    const queue = [s.key];
    while (queue.length) {
      const k = queue.shift()!;
      if (k === a.key) throw new SuccessionError(`${s.displayName} already leads back to ${a.displayName}; that would loop.`);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push(...(next.get(k) ?? []));
    }
  }
}

/** What a hand-over of `key` would move in Core: its staff count and the abbreviation a successor may take. Zero and null for an unknown key. */
export async function successionPreview(db: DbOrTx, key: string): Promise<{ staff: number; abbreviation: string | null }> {
  const [org] = await db.select({ id: organizations.id, abbreviation: organizations.abbreviation }).from(organizations).where(eq(organizations.key, key));
  if (!org) return { staff: 0, abbreviation: null };
  const [row] = await db.select({ n: count() }).from(userOrganizations).where(eq(userOrganizations.organizationId, org.id));
  return { staff: row?.n ?? 0, abbreviation: org.abbreviation?.trim().toUpperCase() || null };
}
