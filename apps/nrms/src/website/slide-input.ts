import { z } from "zod";

/**
 * The Hub's rules for a carousel slide's fields, shared by its save route (http/site-routes.ts)
 * and `import:public-slides` (import/public-slides.ts), so an imported slide passes exactly what
 * an editor's save would. The action label's 40-character, plain-text rule stays in the store
 * (website/carousel.ts's `checkActionLabel`), as it always has.
 */
export const httpOrEmpty = z
  .string()
  .trim()
  .max(255)
  .refine((s) => s === "" || /^https?:\/\/\S+$/i.test(s), "must be an absolute http:// or https:// URL, or empty");
/** Optional: a writer that omits it (a Hub tab opened before this field shipped) keeps the stored label.
 * Trimmed here; the 40-character and plain-text rules stay in the store, so a too-long label gets its
 * plain 422 message rather than a schema 400. */
export const actionLabelField = z.string().trim().optional();
export const justifySchema = z.enum(["left", "right"]);

export const slideInputSchema = z.object({
  id: z.string().uuid().optional(),
  headline: z.string().max(255),
  summary: z.string().max(255),
  actionUrl: httpOrEmpty,
  actionLabel: actionLabelField,
  facebookPostUrl: httpOrEmpty,
  justify: justifySchema,
});
