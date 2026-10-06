import { z } from "zod";

/**
 * The Media Hub contacts contract (Global Constraints, "Media Hub contract", spec §5.3 amended
 * so each email carries a stable `ref`). Validated at the client boundary (client.ts) --
 * anything the client hands back to the rest of NoD has already passed these schemas.
 */

export const mediaHubEmailSchema = z.object({
  /** "personal" or "workplace:<workplaceId>". */
  ref: z.string().min(1),
  // Deliberately not `.email()` -- Media Hub's own contract just says "address", and an
  // unusual-but-valid address (an IDN domain, an uncommon local part, ...) that zod's email
  // regex happens to reject must not make every search/sync throw MediaHubError("contract")
  // and 502 wholesale over one contact. Whether the chosen address is usable as an email is
  // validated where it matters -- the add-from-hub route, right before handing it to
  // addMediaMember (routes.ts).
  address: z.string().min(1),
  kind: z.enum(["personal", "workplace"]),
  organization: z.string().nullable(),
  preferred: z.boolean(),
});
export type MediaHubEmail = z.infer<typeof mediaHubEmailSchema>;

export const contactSchema = z.object({
  id: z.number().int(),
  firstName: z.string(),
  lastName: z.string(),
  outlet: z.string().nullable(),
  emails: z.array(mediaHubEmailSchema),
  deletedAt: z.string().nullable(),
});
export type MediaHubContact = z.infer<typeof contactSchema>;

export const contactPageSchema = z.object({
  contacts: z.array(contactSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type MediaHubContactPage = z.infer<typeof contactPageSchema>;

export const changesPageSchema = z.object({
  contacts: z.array(contactSchema),
  nextCursor: z.string().nullable(),
});
export type MediaHubChangesPage = z.infer<typeof changesPageSchema>;
