import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Owner decision 2026-10-31: every BC date or time the Hub shows goes through one path,
 * apps/staff-web/src/format/bcTime.ts, which corrects a browser whose tzdata predates BC's
 * permanent UTC-7 (2026-11-01). Anything else that hands a time zone to the browser's own
 * `Intl` would show such a browser's times an hour off again.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "apps/staff-web/src");
const SHARED = "apps/staff-web/src/format/bcTime.ts";
/** The calendar-contract formatters read the wall clock themselves; the Hub passes them bcTime's. */
const CALENDAR_WRAPPER = "apps/staff-web/src/format/calendarDates.ts";

const RULES: { name: string; re: RegExp; allowedIn: string }[] = [
  { name: "Intl.DateTimeFormat", re: /\bDateTimeFormat\b/, allowedIn: SHARED },
  { name: "toLocaleDateString/toLocaleTimeString", re: /\btoLocale(Date|Time)String\b/, allowedIn: SHARED },
  { name: "toLocaleString with a time zone", re: /toLocaleString\([^)]*timeZone/, allowedIn: SHARED },
  { name: "a date library's time-zone helpers", re: /from\s+["'](date-fns-tz|date-fns|dayjs|moment|luxon)/, allowedIn: SHARED },
  { name: "getTimezoneOffset (the device's zone, not BC's)", re: /\bgetTimezoneOffset\b/, allowedIn: SHARED },
  { name: "calendar-contract's friendly date formatters", re: /\b(friendlyDateRange|friendlyDateParts|friendlySpan)\b[^\n]*from\s+["']@gcpe\/calendar-contract["']|import\s*\{[^}]*\b(friendlyDateRange|friendlyDateParts|friendlySpan)\b[^}]*\}\s*from\s+["']@gcpe\/calendar-contract["']/, allowedIn: CALENDAR_WRAPPER },
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(p) && !/\.(test|testkit)\.tsx?$/.test(p) && !/fixtures\.tsx?$/.test(p) ? [p] : [];
  });
}

export function offendersIn(file: string, source: string): string[] {
  const lines = source.split("\n");
  return RULES.flatMap((rule) => {
    if (file === rule.allowedIn) return [];
    if (rule.re.source.includes("import")) return rule.re.test(source) ? [`${file}: ${rule.name}`] : [];
    return lines.flatMap((l, i) => (rule.re.test(l) ? [`${file}:${i + 1}: ${rule.name}`] : []));
  });
}

describe("staff-web formats BC times only through format/bcTime.ts", () => {
  it("the scanner flags each way round it, and not the shared module", () => {
    expect(offendersIn("a.ts", 'new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric" })')).toHaveLength(1);
    expect(offendersIn("a.ts", "d.toLocaleTimeString()")).toHaveLength(1);
    expect(offendersIn("a.ts", 'd.toLocaleString("en-CA", { timeZone: "America/Vancouver" })')).toHaveLength(1);
    expect(offendersIn("a.ts", 'import { formatInTimeZone } from "date-fns-tz";')).toHaveLength(1);
    expect(offendersIn("a.ts", 'import { friendlySpan, LIST_COLUMNS } from "@gcpe/calendar-contract";')).toHaveLength(1);
    expect(offendersIn("a.ts", 'import {\n  friendlyDateRange,\n  LIST_COLUMNS,\n} from "@gcpe/calendar-contract";')).toHaveLength(1);
    expect(offendersIn("a.ts", "n.toLocaleString(\"en-CA\")")).toEqual([]);
    expect(offendersIn("a.ts", 'import { LIST_COLUMNS } from "@gcpe/calendar-contract";')).toEqual([]);
    expect(offendersIn(SHARED, 'new Intl.DateTimeFormat("en-US", { timeZone })')).toEqual([]);
  });

  it("no other staff-web file does", () => {
    const offenders = sources(SRC).flatMap((f) => offendersIn(relative(ROOT, f), readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
