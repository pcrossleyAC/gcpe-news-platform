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
 * The Project Blue Bridge banner text, or `null` when `granville` is null/empty (the switch is
 * off). On a test site the text is prefixed `TEST — ` (constraints.md) so staff previewing a
 * non-production site never mistake it for the real thing.
 */
export function blueBridgeBanner(granville: string | null, now: Date, test: boolean): string | null {
  if (!granville) return null;
  const text = `ALERT: His Majesty King Charles III, King of Canada, has passed away at the age of ${ageInBcYears(now)}`;
  return test ? `TEST — ${text}` : text;
}
