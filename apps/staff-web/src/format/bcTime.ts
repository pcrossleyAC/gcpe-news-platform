/**
 * The Hub's one way to turn an instant into BC wall-clock time, and back (owner decision
 * 2026-10-31). Every date or time staff-web shows, and every browser-side comparison that
 * depends on BC's wall clock (today's date, "is this in the past", unsaved-changes checks,
 * calendar days), goes through here. A guard test (`tests/staff-web-bc-time-guard.test.ts`) fails if any other
 * file passes a `timeZone` to `Intl` itself.
 *
 * Why: from 2026-11-01 America/Vancouver stays on UTC-7 all year. A browser whose time-zone
 * data predates that change still puts BC winters at UTC-8, so on its own it shows every time
 * from then on an hour early (a 09:00 go-live as 8:00 AM) and can put a late-evening item on
 * the wrong day. The server is the authority: `GET /core/api/time-zone-check` gives the
 * server's offset at a pinned instant and the instant since which the zone has kept that offset
 * (`fixedSince`, from packages/config's `offsetFixedSince`, i.e. the server's own tzdata). When
 * the browser disagrees, AppShell calls {@link setServerZoneRule}, and from then on an instant
 * at or after `fixedSince` *where the browser's own answer differs* is shown at the server's
 * offset instead. Every other instant (all of them on an up-to-date browser, and the past —
 * BC's old DST years, which an old browser knows correctly) still uses the browser's own `Intl`.
 *
 * The correction formats the instant shifted by the fixed offset with `timeZone: "UTC"`, which
 * gives the same fields `Intl` would for a zone at that offset. A time-zone *name* (`timeZoneName`)
 * would then read "UTC", so callers never ask for one; the Hub writes "BC time"/"Pacific" itself.
 */

/** What the server says about the tenant zone, when the browser's tzdata disagrees with it. */
export interface ServerZoneRule {
  timeZone: string;
  /** From this instant on (epoch ms) the zone is at {@link offsetMinutes} for good. */
  fixedSinceMs: number;
  /** Minutes east of UTC (-420 for UTC-7). */
  offsetMinutes: number;
}

let rule: ServerZoneRule | null = null;

/** Set (or clear, with `null`) the server's rule: only when the browser's tzdata disagrees. */
export function setServerZoneRule(next: ServerZoneRule | null): void {
  rule = next;
}

/** Whether times are currently being corrected. */
export function isCorrectingTimes(): boolean {
  return rule !== null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Tests stub `Intl.DateTimeFormat` to play an old browser; cached formatters would outlive the stub. */
export function clearBcTimeCachesForTests(): void {
  formatters.clear();
}

function formatterFor(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, f);
  }
  return f;
}

/**
 * The browser's own answer for `timeZone`'s UTC offset at `epochMs`, in minutes east of UTC —
 * asked for that zone specifically, never the device's own (`getTimezoneOffset`). `null` if the
 * browser's answer can't be read.
 */
export function browserOffsetMinutes(epochMs: number, timeZone: string): number | null {
  const parts = formatterFor("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date(epochMs));
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  if (raw === "GMT" || raw === "UTC") return 0;
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(raw);
  if (!m) return null;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** The server's offset for this instant, when the browser would get it wrong; else null. */
function correctionAt(epochMs: number, timeZone: string): number | null {
  if (!rule || rule.timeZone !== timeZone || epochMs < rule.fixedSinceMs) return null;
  return browserOffsetMinutes(epochMs, timeZone) === rule.offsetMinutes ? null : rule.offsetMinutes;
}

type When = Date | string | number;
type Options = Omit<Intl.DateTimeFormatOptions, "timeZone" | "timeZoneName">;

const msOf = (at: When): number => (at instanceof Date ? at.getTime() : typeof at === "number" ? at : new Date(at).getTime());

/** The (instant, zone) pair to hand `Intl` so the fields come out in correct BC time. */
function effective(at: When, timeZone: string): { date: Date; timeZone: string } {
  const ms = msOf(at);
  const offset = Number.isNaN(ms) ? null : correctionAt(ms, timeZone);
  return offset === null ? { date: new Date(ms), timeZone } : { date: new Date(ms + offset * 60_000), timeZone: "UTC" };
}

/** `Intl.DateTimeFormat(locale, { ...options, timeZone }).format(at)`, correct whatever the browser's tzdata. */
export function formatInZone(at: When, timeZone: string, options: Options, locale = "en-US"): string {
  const e = effective(at, timeZone);
  return formatterFor(locale, { ...options, timeZone: e.timeZone }).format(e.date);
}

/** {@link formatInZone}'s parts. */
export function formatToPartsInZone(at: When, timeZone: string, options: Options, locale = "en-US"): Intl.DateTimeFormatPart[] {
  const e = effective(at, timeZone);
  return formatterFor(locale, { ...options, timeZone: e.timeZone }).formatToParts(e.date);
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
  /** 0 is Sunday. */
  weekday: number;
}

const PARTS_OPTIONS: Options = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };

/** The wall-clock fields `timeZone` shows for the instant `at`. */
export function zonedParts(at: When, timeZone: string): ZonedParts {
  const p = Object.fromEntries(formatToPartsInZone(at, timeZone, PARTS_OPTIONS).map((x) => [x.type, x.value]));
  const [year, month, day] = [Number(p.year), Number(p.month), Number(p.day)];
  return { year, month, day, hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second), weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The BC calendar date (YYYY-MM-DD) of an instant. */
export function zonedDate(at: When, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The BC wall-clock `{ date: "YYYY-MM-DD", time: "HH:mm" }` of an instant, as date and time inputs hold it. */
export function zonedDateTime(at: When, timeZone: string): { date: string; time: string } {
  const p = zonedParts(at, timeZone);
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/** `at`'s wall-clock fields in `timeZone`, re-read as if they were UTC. */
function localAsUtcMs(epochMs: number, timeZone: string): number {
  const p = zonedParts(epochMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, new Date(epochMs).getUTCMilliseconds());
}

/** `timeZone`'s UTC offset at `epochMs`, in minutes east of UTC (-420 for UTC-7), corrected like every display. */
export function offsetMinutesAt(epochMs: number, timeZone: string): number {
  return (localAsUtcMs(epochMs, timeZone) - epochMs) / 60_000;
}

/**
 * `d`'s UTC fields hold a wall-clock time meant for `timeZone`. Returns the real instant that
 * wall-clock time represents there (the same rules as the server's packages/config
 * `wallClockToInstant`, using the corrected offsets above):
 *
 *  - an ordinary wall-clock time has exactly one matching instant — returned directly.
 *  - the repeated "fall back" hour has two — the earlier (daylight-time) one is picked.
 *  - the skipped "spring forward" hour has none — it is moved forward by the size of the gap.
 */
export function wallClockToInstant(d: Date, timeZone: string): Date {
  const wallMs = d.getTime();
  const offsetMs = (epochMs: number) => epochMs - localAsUtcMs(epochMs, timeZone);

  const offset1 = offsetMs(wallMs);
  const instant1 = wallMs + offset1;
  const offset2 = offsetMs(instant1);
  if (offset2 === offset1) return new Date(instant1);

  const instant2 = wallMs + offset2;
  const valid = [instant1, instant2].filter((instant) => localAsUtcMs(instant, timeZone) === wallMs);
  if (valid.length > 0) return new Date(Math.min(...valid));

  const gap = Math.abs(offset1 - offset2);
  return new Date(wallMs + gap + Math.min(offset1, offset2));
}
