import { readFileSync } from "node:fs";
import { z } from "zod";
import { formatIssues } from "./issues";

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const tenantConfigSchema = z.object({
  tenantId: z.string().min(1),
  siteName: z.string().min(1),
  timeZone: z.string().refine(isValidTimeZone, { message: "timeZone must be a valid IANA time zone" }),
  defaultLanguageId: z.number().int(),
  organizationLabel: z.object({ singular: z.string().min(1), plural: z.string().min(1) }),
  publicSiteBaseUrl: z.string().url(),
  branding: z.object({
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "primaryColor must be #RRGGBB"),
    logoUrl: z.string().url().nullable(),
  }),
});

export type TenantConfig = z.infer<typeof tenantConfigSchema>;

export function loadTenantConfig(path: string): TenantConfig {
  const result = tenantConfigSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!result.success) {
    throw new Error(`Invalid tenant config ${path}: ${formatIssues(result.error)}`);
  }
  return result.data;
}
