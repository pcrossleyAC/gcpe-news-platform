import { z } from "zod";

/**
 * Parses and validates EVENT_SECRETS inside the schema itself (rather than leaving it as a
 * raw string for main.ts to JSON.parse later) so a malformed value — invalid JSON, or valid
 * JSON that isn't an object of strings — surfaces as parseEnv's own
 * "Invalid environment: EVENT_SECRETS: …" message instead of an uncaught SyntaxError/ZodError
 * thrown straight out of main.ts. Shared by every app that receives signed events, so there's
 * exactly one copy of this transform instead of one per app.
 */
export const eventSecretsSchema = z
  .string()
  .default("{}")
  .transform((value, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be valid JSON" });
      return z.NEVER;
    }
    const result = z.record(z.string()).safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a JSON object of string values" });
      return z.NEVER;
    }
    return result.data;
  });
