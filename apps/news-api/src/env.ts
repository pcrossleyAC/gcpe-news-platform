import { z } from "zod";

// Parses and validates EVENT_SECRETS inside the schema itself (rather than leaving it as a
// raw string for main.ts to JSON.parse later) so a malformed value — invalid JSON, or valid
// JSON that isn't an object of strings — surfaces as parseEnv's own
// "Invalid environment: EVENT_SECRETS: …" message instead of an uncaught SyntaxError/ZodError
// thrown straight out of main.ts.
const eventSecrets = z
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

export const newsApiEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(3002),
  TENANT_CONFIG: z.string().default(new URL("../../../config/tenants/bc.json", import.meta.url).pathname),
  EVENT_SECRETS: eventSecrets,
  NOD_BASE_URL: z.string().url().optional(),
  NOD_TOKEN_URL: z.string().url().optional(),
  NOD_CLIENT_ID: z.string().optional(),
  NOD_CLIENT_SECRET: z.string().optional(),
  NOD_SCOPE: z.string().optional(),
  SUBSCRIBE_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(300),
  SUBSCRIBE_CLIENT_IP_HEADER: z.string().min(1).optional(),
  UPDATES_NEGOTIATE_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),
  UPDATES_MAX_CONNECTIONS: z.coerce.number().int().positive().default(5000),
  MIGRATIONS_FOLDER: z.string().default(new URL("../migrations", import.meta.url).pathname),
});

export type NewsApiEnv = z.infer<typeof newsApiEnvSchema>;
