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

// P2-R17: a tenant's time zone is only as correct as the runtime's bundled IANA tzdata — a
// jurisdiction can change its own offset rules (e.g. BC's permanent-DST legislation) on a
// known future date, and a Node whose ICU/tzdata predates that change will silently compute
// the *old* rule forever. `timeZoneCheck` pins one known-good (instant, expected UTC offset)
// pair so that drift is caught at startup instead of discovered in production as a mis-timed
// email or scheduled publish.
const timeZoneCheckSchema = z.object({
  at: z.string().datetime({ message: "timeZoneCheck.at must be an ISO 8601 UTC datetime" }),
  expectedOffset: z.string().regex(/^[+-]\d{2}:\d{2}$/, "timeZoneCheck.expectedOffset must be ±HH:MM"),
});

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
  /** Optional: when present, {@link assertTimeZoneRules} must be called at startup (see
   * apps/news-api and apps/public-site's main.ts) to fail fast if the runtime's tzdata
   * disagrees with the pinned (at, expectedOffset) pair. */
  timeZoneCheck: timeZoneCheckSchema.optional(),
});

export type TenantConfig = z.infer<typeof tenantConfigSchema>;

export function loadTenantConfig(path: string): TenantConfig {
  const result = tenantConfigSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!result.success) {
    throw new Error(`Invalid tenant config ${path}: ${formatIssues(result.error)}`);
  }
  return result.data;
}

/**
 * Resolves `timeZone`'s actual UTC offset, at the instant `timeZoneCheck.at`, using the
 * *runtime's own* `Intl` — deliberately not any hand-rolled offset table, since it's exactly
 * the runtime's bundled ICU/tzdata that can be stale. `timeZoneName: "longOffset"` renders as
 * e.g. "GMT-07:00" (or bare "GMT" for a zero offset); the "GMT" prefix is stripped before
 * comparing against `expectedOffset`.
 *
 * A mismatch throws, naming the runtime's own tzdata version (`process.versions.tz`) in the
 * message so a stale-ICU failure is immediately actionable — "upgrade Node", not "guess why
 * the clock is wrong" — rather than requiring whoever reads the error to already know that
 * `process.versions.tz` is the thing to check.
 *
 * A no-op when `timeZoneCheck` wasn't set at all (most tenants won't need it).
 */
export function assertTimeZoneRules(tenant: Pick<TenantConfig, "tenantId" | "timeZone" | "timeZoneCheck">): void {
  if (!tenant.timeZoneCheck) return;
  const { at, expectedOffset } = tenant.timeZoneCheck;

  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tenant.timeZone, timeZoneName: "longOffset" }).formatToParts(new Date(at));
  const rawOffset = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const actualOffset = rawOffset === "GMT" ? "+00:00" : rawOffset.replace(/^GMT/, "");

  if (actualOffset !== expectedOffset) {
    throw new Error(
      `Tenant "${tenant.tenantId}" time-zone self-check failed: ${tenant.timeZone} at ${at} resolved to UTC offset ` +
        `${actualOffset || "(unknown)"}, expected ${expectedOffset}. This runtime's tzdata (process.versions.tz=` +
        `${process.versions.tz ?? "unknown"}) is likely stale for this time zone's rules — upgrade Node (and its ` +
        `bundled ICU/tzdata) to a version that knows about them.`,
    );
  }
}
