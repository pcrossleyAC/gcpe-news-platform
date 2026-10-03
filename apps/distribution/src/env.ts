import { fileURLToPath } from "node:url";
import { z } from "zod";

// z.coerce.boolean() treats the string "false" as truthy (any non-empty string coerces to
// true), so booleans are parsed from an explicit enum instead.
const boolEnv = (def: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(def)
    .transform((v) => v === "true");

const commaList = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));

export const distributionEnvSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().default(3005),
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().default(587),
    SMTP_SECURE: boolEnv("false"),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_TLS_REJECT_UNAUTHORIZED: boolEnv("true"),
    MAIL_FROM: z.string().min(1),
    MAIL_REDIRECT_TO: commaList,
    MAIL_ALLOW_REAL_RECIPIENTS: boolEnv("false"),
    INTERNAL_DOMAINS: commaList,
    SEND_INTERVAL_MS: z.coerce.number().int().default(2000),
    MIGRATIONS_FOLDER: z.string().default(fileURLToPath(new URL("../migrations", import.meta.url))),
  })
  .superRefine((e, ctx) => {
    // Non-prod mail redirect safety rule: refuse to boot unless either a redirect list is
    // configured or someone has explicitly opted in to delivering to real recipients. When
    // both are set, the redirect wins at send time (sender.ts only consults MAIL_REDIRECT_TO).
    if (e.MAIL_REDIRECT_TO.length === 0 && !e.MAIL_ALLOW_REAL_RECIPIENTS) {
      ctx.addIssue({ code: "custom", message: "set MAIL_REDIRECT_TO or MAIL_ALLOW_REAL_RECIPIENTS=true" });
    }
  });

export type DistributionEnv = z.infer<typeof distributionEnvSchema>;
