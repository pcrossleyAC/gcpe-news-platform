import { z } from "zod";
import { eventEnvelopeSchema, type EventEnvelope } from "./envelope";

export const socialSchema = z.object({
  twitterUsername: z.string().nullable(),
  flickrUrl: z.string().nullable(),
  youtubeUrl: z.string().nullable(),
  audioUrl: z.string().nullable(),
});

export const linkSchema = z.object({ text: z.string(), url: z.string() });

export const contactSchema = z.object({
  fullName: z.string().nullable(),
  phoneNumber: z.string().nullable(),
  mobileNumber: z.string().nullable(),
  emailAddress: z.string().nullable(),
});

export const orgRecordSchema = z.object({
  key: z.string().min(1),
  displayName: z.string().min(1),
  abbreviation: z.string().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  parentKey: z.string().nullable(),
  url: z.string().nullable(),
  displayAdditionalName: z.string().nullable(),
  minister: z.object({
    name: z.string().nullable(),
    summary: z.string().nullable(),
    detailsHtml: z.string().nullable(),
    email: z.string().nullable(),
    photoUrl: z.string().nullable(),
    address: z.string().nullable(),
  }),
  contact: contactSchema.nullable(),
  secondContact: contactSchema.nullable(),
  weekendContactNumber: z.string().nullable(),
  social: socialSchema,
  topicLinks: z.array(linkSchema),
  serviceLinks: z.array(linkSchema),
  sectorKeys: z.array(z.string()),
  updatedAt: z.string().datetime({ offset: true }),
});
export type OrgRecord = z.infer<typeof orgRecordSchema>;

export const termKindSchema = z.enum(["sector", "theme", "tag", "service"]);
export type TermKind = z.infer<typeof termKindSchema>;

export const termRecordSchema = z.object({
  kind: termKindSchema,
  key: z.string().min(1),
  displayName: z.string().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  social: socialSchema,
  updatedAt: z.string().datetime({ offset: true }),
});
export type TermRecord = z.infer<typeof termRecordSchema>;

const termDeactivated = z.object({ kind: termKindSchema, key: z.string().min(1) });

export const postKindSchema = z.enum(["releases", "stories", "factsheets", "updates", "advisories"]);
export type PostKind = z.infer<typeof postKindSchema>;

export const documentContactSchema = z.object({ title: z.string().nullable(), details: z.string().nullable() });

export const releaseDocumentSchema = z.object({
  pageTitle: z.string().nullable(),
  languageId: z.number().int(),
  headline: z.string().nullable(),
  subheadline: z.string().nullable(),
  detailsHtml: z.string().nullable(),
  byline: z.string().nullable(),
  contacts: z.array(documentContactSchema),
});

export const assetSchema = z.object({ key: z.string().nullable(), label: z.string().nullable(), length: z.number().int().nullable() });

const offsetDateTime = z.string().datetime({ offset: true });

export const releaseRecordSchema = z.object({
  key: z.string().min(1),
  kind: postKindSchema,
  reference: z.string().nullable(),
  atomId: z.string().nullable(),
  publishDate: offsetDateTime,
  leadMinistryKey: z.string().nullable(),
  summary: z.string().nullable(),
  socialMediaSummary: z.string().nullable(),
  socialMediaHeadline: z.string().nullable(),
  keywords: z.string().nullable(),
  location: z.string().nullable(),
  hasMediaAssets: z.boolean(),
  hasTranslations: z.boolean(),
  isNewsOnDemand: z.boolean(),
  assetUrl: z.string().nullable(),
  redirectUri: z.string().nullable(),
  documents: z.array(releaseDocumentSchema),
  ministryKeys: z.array(z.string()),
  sectorKeys: z.array(z.string()),
  tagKeys: z.array(z.string()),
  themeKeys: z.array(z.string()),
  assets: z.array(assetSchema).nullable(),
  translations: z.array(assetSchema).nullable(),
  publishFlags: z.object({ toWeb: z.boolean(), toSubscribers: z.boolean(), toMediaLists: z.boolean() }),
  mediaListKeys: z.array(z.string()),
  renditions: z.object({ htmlUrl: z.string().nullable(), textUrl: z.string().nullable(), pdfUrl: z.string().nullable() }).nullable(),
  timestamp: offsetDateTime,
});
export type ReleaseRecord = z.infer<typeof releaseRecordSchema>;

export const categoryKindSchema = z.enum(["ministries", "sectors", "themes", "tags"]);
export type CategoryKind = z.infer<typeof categoryKindSchema>;

export const slideRecordSchema = z.object({
  id: z.string().uuid(),
  sortIndex: z.number().int(),
  headline: z.string().nullable(),
  summary: z.string().nullable(),
  actionLabel: z.string().nullable(),
  actionUri: z.string().nullable(),
  imageBase64: z.string().nullable(),
  imageType: z.string().nullable(),
  facebookPostUri: z.string().nullable(),
  justify: z.string().nullable(),
  timestamp: offsetDateTime,
});
export type SlideRecord = z.infer<typeof slideRecordSchema>;

export const siteContentChangedSchema = z.discriminatedUnion("entity", [
  z.object({
    entity: z.literal("home"),
    topPostKey: z.string().nullable(),
    featurePostKey: z.string().nullable(),
    liveWebcastFlashMediaManifestUrl: z.string().nullable(),
    liveWebcastM3uPlaylist: z.string().nullable(),
    granville: z.string().nullable(),
    timestamp: offsetDateTime,
  }),
  z.object({ entity: z.literal("slides"), slides: z.array(slideRecordSchema) }),
  z.object({
    entity: z.literal("resourceLinks"),
    links: z.array(z.object({ sortIndex: z.number().int(), text: z.string(), uri: z.string() })),
    timestamp: offsetDateTime,
  }),
  z.object({
    entity: z.literal("categoryFeatures"),
    kind: categoryKindSchema,
    key: z.string().min(1),
    topPostKey: z.string().nullable(),
    featurePostKey: z.string().nullable(),
  }),
]);
export type SiteContentChanged = z.infer<typeof siteContentChangedSchema>;

/** Page identifiers the public site builder understands: "home" and `post:<key>`. Unknown ids are skipped by the builder. */
export const siteRebuildRequestedSchema = z.object({ pages: z.array(z.string().min(1)).min(1) });
export type SiteRebuildRequested = z.infer<typeof siteRebuildRequestedSchema>;

/** Index keys a release is listed under (`ministries:health`, …), lowercased. Shared by the News API and NoD. */
export function indexKeysFor(r: Pick<ReleaseRecord, "ministryKeys" | "sectorKeys" | "tagKeys" | "themeKeys">): string[] {
  return [
    ...r.ministryKeys.map((k) => `ministries:${k}`),
    ...r.sectorKeys.map((k) => `sectors:${k}`),
    ...r.tagKeys.map((k) => `tags:${k}`),
    ...r.themeKeys.map((k) => `themes:${k}`),
  ].map((s) => s.toLowerCase());
}

export const eventDataSchemas = {
  "org.upserted": orgRecordSchema,
  "org.deactivated": z.object({ key: z.string().min(1) }),
  "sector.upserted": termRecordSchema,
  "sector.deactivated": termDeactivated,
  "theme.upserted": termRecordSchema,
  "theme.deactivated": termDeactivated,
  "tag.upserted": termRecordSchema,
  "tag.deactivated": termDeactivated,
  "service.upserted": termRecordSchema,
  "service.deactivated": termDeactivated,
  "release.published": releaseRecordSchema,
  "release.updated": releaseRecordSchema.extend({ notify: z.boolean() }),
  "release.unpublished": z.object({ key: z.string().min(1) }),
  "site.content.changed": siteContentChangedSchema,
  "site.rebuild_requested": siteRebuildRequestedSchema,
} as const;

export type EventType = keyof typeof eventDataSchemas;
export type EventData<T extends EventType> = z.infer<(typeof eventDataSchemas)[T]>;

export function termEventType(kind: TermKind, action: "upserted" | "deactivated"): EventType {
  return `${kind}.${action}` as EventType;
}

export function parseEvent(raw: unknown): EventEnvelope {
  const envelope = eventEnvelopeSchema.parse(raw);
  const schema = (eventDataSchemas as Record<string, z.ZodTypeAny>)[envelope.type];
  if (!schema) return envelope as EventEnvelope;
  return { ...envelope, data: schema.parse(envelope.data) };
}
