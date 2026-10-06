import { z } from "zod";
import { fileURLToPath } from "node:url";
import { eventSecretsSchema } from "@gcpe/config";

export const newsApiEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(3002),
  TENANT_CONFIG: z.string().default(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url))),
  EVENT_SECRETS: eventSecretsSchema,
  EVENT_SUBSCRIBERS: z.string().optional(),
  NOD_BASE_URL: z.string().url().optional(),
  NOD_TOKEN_URL: z.string().url().optional(),
  NOD_CLIENT_ID: z.string().optional(),
  NOD_CLIENT_SECRET: z.string().optional(),
  NOD_SCOPE: z.string().optional(),
  SUBSCRIBE_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(300),
  SUBSCRIBE_CLIENT_IP_HEADER: z.string().min(1).optional(),
  UPDATES_NEGOTIATE_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),
  UPDATES_MAX_CONNECTIONS: z.coerce.number().int().positive().default(5000),
  UPDATES_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().positive().default(50),
  MIGRATIONS_FOLDER: z.string().default(fileURLToPath(new URL("../migrations", import.meta.url))),
});

export type NewsApiEnv = z.infer<typeof newsApiEnvSchema>;
