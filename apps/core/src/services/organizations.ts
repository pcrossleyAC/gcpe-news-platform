import { and, asc, eq, max, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "@gcpe/db-kit";
import { enqueueEvent, orgKeyFromName, orgRecordSchema, type OrgRecord, type SubscriberConfig } from "@gcpe/events";
import { isSafeUrl } from "@gcpe/site-settings";
import { organizations } from "../db/schema";
import { CORE_SOURCE, lockAggregate, orgAggregateId } from "./aggregate";
import { MAX_BIO_CHARS, isBlankHtml, sanitizeBioHtml } from "./bio-html";

export { MAX_BIO_CHARS };

/**
 * isHq and isPublic are both optional on input: omitted keeps the stored flag (false for isHq,
 * true for isPublic, on a new organization). The BC seed and the legacy importer send either
 * flag only when they create the organization, so a re-seed or re-import never changes a flag
 * Core.Admin has set, in either direction (C124).
 */
export const orgInputSchema = orgRecordSchema
  .omit({ updatedAt: true, isHq: true, isPublic: true })
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
    teamLinks: row.teamLinks,
    sectorKeys: row.sectorKeys,
    isHq: row.isHq,
    isPublic: row.isPublic,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** teamLinks is optional on input and the column defaults to [], so an absent list and [] are the same content. */
function sameContent(a: OrgInput, b: OrgInput): boolean {
  const normal = (o: OrgInput) => JSON.stringify(orgInputSchema.parse({ ...o, teamLinks: o.teamLinks ?? [] }));
  return normal(a) === normal(b);
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
    if (existing) {
      const { updatedAt: _u, ...current } = toOrgRecord(existing);
      if (sameContent(current, data)) {
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
    const values = { ...data, legacyId: opts.legacyId ?? existing?.legacyId ?? null, updatedAt: new Date(), ...(opts.staffEdit ? { staffEditedAt: new Date() } : {}) };
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

const PHONE_MESSAGE = "Keep phone numbers to 50 characters or fewer.";
const phoneOrNull = trimmedOrNull.pipe(z.string().max(50, PHONE_MESSAGE).nullable());

/**
 * A ministry media contact as free text (plan 2, T2; P8): the stored contactSchema shape, all four
 * fields required, each trimmed with blank meaning null. Four blanks is no contact at all (null).
 */
const mediaContactSchema = z
  .object({
    fullName: trimmedOrNull,
    phoneNumber: phoneOrNull,
    mobileNumber: phoneOrNull,
    emailAddress: trimmedOrNull.pipe(z.string().email("Enter an email address like name@gov.bc.ca.").nullable()),
  })
  .strict()
  .transform((c) => (Object.values(c).every((v) => v === null) ? null : c));

/**
 * The minister biography (T1): sanitised to the bio allow-list (bio-html.ts); HTML with no text
 * left (the Hub's emptied editor sends `<p></p>`) clears it to null. The raw input is capped before
 * sanitising, the sanitised result at MAX_BIO_CHARS.
 */
const bioHtmlSchema = z
  .string()
  .max(100_000, "Keep the biography to 20,000 characters or fewer.")
  .nullable()
  .transform((html, ctx) => {
    if (html === null) return null;
    const clean = sanitizeBioHtml(html);
    if (isBlankHtml(clean)) return null;
    if (clean.length > MAX_BIO_CHARS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Keep the biography to 20,000 characters or fewer." });
      return z.NEVER;
    }
    return clean;
  });

/** The NRMS release-number prefix (e.g. 2026HLTH0001): trimmed, upper-cased, 2 to 10 capital letters or digits. */
export const abbreviationSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,10}$/, "Use 2 to 10 capital letters or digits, e.g. HLTH.");

/** Another organization already uses this abbreviation (compared case-insensitively). The route answers 409. */
export class AbbreviationTakenError extends Error {
  constructor(readonly takenBy: string) {
    super("abbreviation taken");
    this.name = "AbbreviationTakenError";
  }
}

/**
 * Refuses an abbreviation another organization holds. There is no unique index: the legacy importer
 * and seed write abbreviations as news.gov has them, so existing data may already repeat one. Instead,
 * every Hub write of an abbreviation takes one shared lock first, so two concurrent claims serialise
 * and the second sees the first. Callers hold their own org lock already (always taken before this one).
 */
async function assertAbbreviationFree(tx: Tx, abbreviation: string, key: string): Promise<void> {
  await lockAggregate(tx, "org-abbreviations");
  const [other] = await tx
    .select({ displayName: organizations.displayName })
    .from(organizations)
    .where(and(sql`upper(trim(${organizations.abbreviation})) = ${abbreviation}`, ne(organizations.key, key)))
    .orderBy(asc(organizations.sortOrder), asc(organizations.key))
    .limit(1);
  if (other) throw new AbbreviationTakenError(other.displayName);
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
        detailsHtml: bioHtmlSchema,
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
    /** The Premier's "Meet the Team" links (T1): the side-column link rules. */
    teamLinks: sideLinksSchema,
    /** The ministry page's media contacts (T2), each replaced whole, and the after-hours number. */
    contact: mediaContactSchema.nullable(),
    secondContact: mediaContactSchema.nullable(),
    weekendContactNumber: phoneOrNull,
  })
  .partial()
  .strict();
export type OrgProfilePatch = z.infer<typeof orgProfilePatchSchema>;

/** Profile fields only Core.Admin may change. isHq and isPublic are not in the schema at all; the route rejects them first. */
export const ADMIN_ONLY_PROFILE_FIELDS = ["parentKey", "isActive", "abbreviation"] as const;

/**
 * Staff edit of the form fields. Merges `minister` and `social` field by field onto the stored ones
 * (lists and the two media contacts are replaced whole), refuses an abbreviation another organization holds, reuses the
 * upsert path (so org.upserted fires only on a real change) and stamps staffEditedAt when it writes.
 * Returns null when the key does not exist; throws AbbreviationTakenError.
 */
export async function patchOrganizationProfile(
  db: Db,
  key: string,
  patch: OrgProfilePatch,
  subscribers: SubscriberConfig[],
): Promise<OrgRecord | null> {
  const parsed = orgProfilePatchSchema.parse(patch);
  return db.transaction(async (tx) => {
    await lockAggregate(tx, orgAggregateId(key));
    const [existing] = await tx.select().from(organizations).where(eq(organizations.key, key)).for("update");
    if (!existing) return null;
    const { updatedAt: _u, isHq: _h, isPublic: _p, ...current } = toOrgRecord(existing);
    const { minister, social, ...rest } = parsed;
    if (rest.abbreviation !== undefined && rest.abbreviation !== current.abbreviation?.trim().toUpperCase()) {
      await assertAbbreviationFree(tx, rest.abbreviation, key);
    }
    const merged: OrgInput = { ...current, ...rest, minister: { ...current.minister, ...minister }, social: { ...current.social, ...social } };
    // tx is a Db-compatible handle; upsertOrganization opens a nested transaction (savepoint) on it and re-takes the same lock.
    return (await upsertOrganization(tx as unknown as Db, merged, subscribers, { staffEdit: true })).record;
  });
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
 * when another organization holds the abbreviation.
 */
export async function createOrganization(
  db: Db,
  input: { displayName: string; sortOrder?: number; parentKey?: string | null; minister?: Partial<OrgRecord["minister"]>; abbreviation?: string },
  subscribers: SubscriberConfig[],
): Promise<{ record: OrgRecord } | { conflict: string }> {
  const displayName = input.displayName.trim();
  const key = orgKeyFromName(displayName);
  if (!key) throw new Error("displayName must contain a letter or digit");
  const abbreviation = input.abbreviation === undefined ? null : abbreviationSchema.parse(input.abbreviation);
  return db.transaction(async (tx) => {
    await lockAggregate(tx, orgAggregateId(key));
    if (abbreviation !== null) await assertAbbreviationFree(tx, abbreviation, key);
    const sortOrder = input.sortOrder ?? ((await tx.select({ m: max(organizations.sortOrder) }).from(organizations))[0]?.m ?? 0) + 10;
    const now = new Date();
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
  });
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

export async function deactivateOrganization(db: Db, key: string, subscribers: SubscriberConfig[]): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockAggregate(tx, orgAggregateId(key));
    const [existing] = await tx.select().from(organizations).where(eq(organizations.key, key)).for("update");
    if (!existing) return false;
    if (!existing.isActive) return true;
    await tx.update(organizations).set({ isActive: false, updatedAt: new Date(), staffEditedAt: new Date() }).where(eq(organizations.key, key));
    await enqueueEvent(tx, { type: "org.deactivated", source: CORE_SOURCE, aggregateId: orgAggregateId(key), data: { key } }, subscribers);
    return true;
  });
}

export async function listOrganizations(db: Db): Promise<OrgRecord[]> {
  const rows = await db.select().from(organizations).orderBy(asc(organizations.sortOrder), asc(organizations.key));
  return rows.map(toOrgRecord);
}

export async function getOrganization(db: Db, key: string): Promise<OrgRecord | null> {
  const [row] = await db.select().from(organizations).where(eq(organizations.key, key));
  return row ? toOrgRecord(row) : null;
}
