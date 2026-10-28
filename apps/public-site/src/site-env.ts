/**
 * Project Blue Bridge's public banner text. Whether this deployment is a test site (the TEST
 * banner prefix and noindex) is @gcpe/config's isTestSite.
 */

import { BLUE_BRIDGE_AGE_TOKEN } from "@gcpe/site-settings";

const BC_TIME_ZONE = "America/Vancouver";
let warnedBadBirthDate = false;

/** `YYYY-MM-DD` as a real calendar date, or null. */
function parseBirthDate(birthDate: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? { year, month, day } : null;
}

/**
 * Whole years since `birthDate` (`YYYY-MM-DD`) on `now`, by the BC calendar date. A 29 February
 * birthday counts from 1 March in a non-leap year. NaN when the date is unparseable.
 */
export function ageInBcYears(now: Date, birthDate: string): number {
  const born = parseBirthDate(birthDate);
  if (!born) return Number.NaN;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: BC_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  let age = year - born.year;
  if (month < born.month || (month === born.month && day < born.day)) age--;
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
 * {@link isGranvilleOn}). `text.message` with every {@link BLUE_BRIDGE_AGE_TOKEN} replaced by the
 * age at `text.birthDate`; a message without the token is used as written. An unparseable birth
 * date (validation stops it; this is the backstop) leaves the token out and logs once per
 * process. On a test site the text is prefixed `TEST — ` so staff previewing a non-production
 * site never mistake it for the real thing.
 */
export function blueBridgeBanner(granville: string | null, now: Date, test: boolean, text: { message: string; birthDate: string }): string | null {
  if (!isGranvilleOn(granville)) return null;
  let age = "";
  if (text.message.includes(BLUE_BRIDGE_AGE_TOKEN)) {
    const years = ageInBcYears(now, text.birthDate);
    if (Number.isNaN(years)) {
      if (!warnedBadBirthDate) {
        warnedBadBirthDate = true;
        console.warn("Blue Bridge birth date is not a YYYY-MM-DD date; the age is left out of the banner.");
      }
    } else age = String(years);
  }
  const message = text.message.split(BLUE_BRIDGE_AGE_TOKEN).join(age);
  return test ? `TEST — ${message}` : message;
}
