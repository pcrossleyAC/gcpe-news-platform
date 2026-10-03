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
