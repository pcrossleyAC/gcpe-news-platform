import { z } from "zod";
import { CREATABLE_TYPES, LAYOUTS, RELEASE_TYPES } from "./types";

const key = z.string().trim().toLowerCase().min(1).max(100);
const keys = z.array(key).max(200).transform((a) => [...new Set(a)]);
const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((s) => /^https?:\/\/\S+$/i.test(s), "must be an absolute http:// or https:// URL");
const languageId = z.union([z.literal(4105), z.literal(3084)]);
const version = z.number().int().positive();
const contact = z.string().max(250);
const activityId = z
  .union([
    z.number().int().positive(),
    z
      .string()
      .regex(/^\d+$/, "Activity ID must be numeric")
      .transform(Number)
      .pipe(z.number().int().positive()),
    z.null(),
  ])
  .default(null);
const LOCAL_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * Fix round 2, bug 1: the digit-grouping regex alone accepted non-existent calendar values
 * (e.g. "2026-13-40T25:99") — `Date.UTC` silently *normalises* out-of-range components (month
 * 13 rolls into next January, hour 25 rolls into the next day, etc.) rather than rejecting
 * them, so a naive `new Date(...)` round trip through that regex alone would have quietly
 * shifted a mistyped date by days or months instead of refusing it. This round-trips the parsed
 * parts through `Date.UTC` and rejects unless every part comes back unchanged — which, as a
 * side effect, also correctly handles leap years (Feb 29 round-trips only in a leap year)
 * without any separate leap-year table.
 */
function isRealLocalDateTime(s: string): boolean {
  const m = LOCAL_DATE_TIME_RE.exec(s);
  if (!m) return false;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const d = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month! - 1 && d.getUTCDate() === day && d.getUTCHours() === hour && d.getUTCMinutes() === minute;
}

/** BC wall-clock local time, no offset — "YYYY-MM-DDTHH:mm" (fix round 1, finding 3; reused by
 * settingsSchema's plannedPublishAtLocal, fix round 1 follow-up; and by the Website section's
 * carousel goLiveAtLocal, 3f task 5 fix round 1 — exported so apps/nrms/src/http/site-routes.ts
 * can reuse this exact schema instead of a second copy), with real calendar values (fix round
 * 2, bug 1). */
export const localDateTime = z
  .string()
  .regex(LOCAL_DATE_TIME_RE, "must be a local date/time, YYYY-MM-DDTHH:mm")
  .refine(isRealLocalDateTime, "Enter a real date and time.");

export const versionOnlySchema = z.object({ version });

export const createReleaseSchema = z.object({
  type: z.enum(CREATABLE_TYPES),
  pageTitle: z.string().trim().min(1).max(50),
  layout: z.enum(LAYOUTS),
  pageImageId: z.string().uuid().nullable().default(null),
  headline: z.string().trim().min(1).max(255),
  subheadline: z.string().max(100).nullable().default(null),
  organizations: z.string().max(500).nullable().default(null),
  byline: z.string().max(250).nullable().default(null),
  bodyHtml: z.string().max(500_000).default(""),
  location: z.string().max(50).default(""),
  contacts: z.array(contact).max(20).default([]),
  ministries: keys.default([]),
  leadMinistryKey: key.nullable().default(null),
  sectors: keys.default([]),
  themes: keys.default([]),
  tags: keys.default([]),
  mediaListKeys: keys.default([]),
  activityId,
  publishAt: z.string().datetime({ offset: true }).nullable().default(null),
});
export type CreateReleaseInput = z.infer<typeof createReleaseSchema>;

/**
 * Planned publish time (drafts); committing a time is POST /schedule. At most one of
 * `plannedPublishAt` (a real instant, as before) or `plannedPublishAtLocal` (fix round 1
 * follow-up: BC wall-clock, no offset — the server converts it with its own tzdata, the same
 * treatment `scheduleSchema`'s `publishAtLocal` got) may be given; both is a 400. Omitting
 * both clears the planned time (`plannedPublishAt` then defaults to `null`).
 */
export const settingsSchema = z
  .object({
    version,
    activityId,
    plannedPublishAt: z.string().datetime({ offset: true }).nullable().optional(),
    plannedPublishAtLocal: localDateTime.optional(),
    toSubscribers: z.boolean(),
    toMediaLists: z.boolean(),
    mediaListKeys: keys,
  })
  .refine((v) => !(v.plannedPublishAt !== undefined && v.plannedPublishAtLocal !== undefined), {
    message: "Provide at most one of plannedPublishAt or plannedPublishAtLocal.",
  })
  .transform((v) => ({ ...v, plannedPublishAt: v.plannedPublishAt ?? null }));
export type SettingsInput = z.infer<typeof settingsSchema>;

export const categoriesSchema = z.object({ version, leadMinistryKey: key.nullable(), ministries: keys, sectors: keys, themes: keys, tags: keys });
export type CategoriesInput = z.infer<typeof categoriesSchema>;

export const assetSchema = z.object({
  version,
  assetUrl: httpUrl.nullable(),
  assetAltText: z.string().max(149, "Alt text must be under 150 characters").nullable(),
  hasMediaAssets: z.boolean(),
});
export type AssetInput = z.infer<typeof assetSchema>;

export const metaSchema = z.object({
  version,
  key: z.string().trim().max(100).nullable(),
  redirectUrl: httpUrl.nullable(),
  location: z.string().max(50),
  summary: z.string().max(5000),
  socialMediaSummary: z.string().max(5000).nullable(),
  keywords: z.string().max(2000).nullable(),
});
export type MetaInput = z.infer<typeof metaSchema>;

export const documentLanguageSchema = z.object({
  version,
  pageTitle: z.string().trim().min(1).max(50),
  layout: z.enum(LAYOUTS),
  headline: z.string().trim().max(255),
  subheadline: z.string().max(100).nullable(),
  organizations: z.string().max(500).nullable(),
  byline: z.string().max(250).nullable(),
  bodyHtml: z.string().max(500_000),
  pageImageId: z.string().uuid().nullable(),
  contacts: z.array(contact).max(20),
});
export type DocumentLanguageInput = z.infer<typeof documentLanguageSchema>;

export const addDocumentSchema = z.object({ version, pageTitle: z.string().trim().min(1).max(50), layout: z.enum(LAYOUTS) });
export const addTranslationSchema = z.object({ version, languageId });
export const reorderDocumentsSchema = z.object({ version, documentIds: z.array(z.string().uuid()).min(1).max(50) });

/**
 * Exactly one of `publishAt` ("now", or an already-resolved instant with an explicit offset —
 * today's form, still used e.g. by anything that already has a real instant) or
 * `publishAtLocal` (fix round 1, finding 3: a BC wall-clock time with no offset at all — the
 * server, whose tzdata is the one that actually matters for the tenant, resolves it via
 * `wallClockToInstant`, rather than trusting a browser that may have stale tzdata). Neither or
 * both is a 400, not a silently-ambiguous choice between them.
 */
export const scheduleSchema = z
  .object({
    version,
    publishAt: z.union([z.literal("now"), z.string().datetime({ offset: true })]).optional(),
    publishAtLocal: localDateTime.optional(),
  })
  .refine((v) => (v.publishAt !== undefined) !== (v.publishAtLocal !== undefined), {
    message: "Provide exactly one of publishAt or publishAtLocal.",
  });
export type ScheduleInput = z.infer<typeof scheduleSchema>;

export const listQuerySchema = z.object({
  folder: z.enum(["drafts", "scheduled", "published"]),
  type: z.enum(["all", ...RELEASE_TYPES]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListQuery = z.infer<typeof listQuerySchema>;
export const searchQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  ministry: z.string().trim().toLowerCase().max(100).optional(),
  sector: z.string().trim().toLowerCase().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type AddDocumentInput = z.infer<typeof addDocumentSchema>;
export type AddTranslationInput = z.infer<typeof addTranslationSchema>;
export type ReorderDocumentsInput = z.infer<typeof reorderDocumentsSchema>;
