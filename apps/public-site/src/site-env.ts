/**
 * Plan 3d task 4: whether this deployment is a test site (the TEST banner and noindex), and
 * Project Blue Bridge's public banner text. See constraints.md's "Test-site rule" and "Blue
 * Bridge banner text".
 */

const BC_TIME_ZONE = "America/Vancouver";
/** His Majesty King Charles III's birth date, for the banner's age-in-years (BC time). */
const CHARLES_BORN = { year: 1948, month: 11, day: 14 };

/**
 * A site is a test site unless it is the real production deployment (constraints.md, ruling
 * C39): `NODE_ENV` isn't "production", or it is but `LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true`
 * (a test deployment left in "production" for other reasons), or `SITE_ENVIRONMENT=test`
 * says so explicitly.
 */
export function isTestSite(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV !== "production" || env.LOCAL_ADMIN_ALLOW_IN_PRODUCTION === "true" || env.SITE_ENVIRONMENT === "test";
}

/** His Majesty's age in whole years on `now`, in BC time. */
function ageInBcYears(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: BC_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  let age = year - CHARLES_BORN.year;
  if (month < CHARLES_BORN.month || (month === CHARLES_BORN.month && day < CHARLES_BORN.day)) age--;
  return age;
}

/**
 * Fix round 1 (IMPORTANT 2): legacy stores `granville` as the literal strings "true"/"false"
 * (Hub.Legacy `ProjectBlueBridge.aspx.cs`: `SetAppSetting(appSetting, enabled ? "true" :
 * "false")`), and the News API legacy importer (apps/news-api/src/import/run.ts) copies it
 * through. NRMS's own `setBlueBridge` only ever writes "true" or `null`, but the public site
 * must still treat an imported "false" (or any value that isn't exactly "true") as OFF, not
 * "any non-empty string is ON". Same rule, same name, in apps/nrms/src/website/settings.ts's
 * `getBlueBridge` and the News API importer's `normalizeGranville`.
 */
export function isGranvilleOn(granville: string | null): boolean {
  return granville != null && granville.trim().toLowerCase() === "true";
}

/**
 * The Project Blue Bridge banner text, or `null` when `granville` isn't ON (per
 * {@link isGranvilleOn} — covers null/empty/"false"/anything but "true"). On a test site the
 * text is prefixed `TEST — ` (constraints.md) so staff previewing a non-production site never
 * mistake it for the real thing.
 */
export function blueBridgeBanner(granville: string | null, now: Date, test: boolean): string | null {
  if (!isGranvilleOn(granville)) return null;
  const text = `ALERT: His Majesty King Charles III, King of Canada, has passed away at the age of ${ageInBcYears(now)}`;
  return test ? `TEST — ${text}` : text;
}
