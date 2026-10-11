import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { hasCategoryStartingWith, visible, type Viewer, type VisibilityFacts } from "@gcpe/calendar-contract";
import type { ActivityLookup, ReleasePrefill } from "@gcpe/nrms-contract";
import { calendarActivities, categoryTerms, organizations, type CalendarActivityRow } from "../db/schema";
import { ReleaseRuleError } from "../releases/errors";

export interface LookupOptions {
  /** The tenant's `calendar.forecastCategoryPrefix`; null when the tenant has no Calendar settings. */
  prefix: string | null;
  timeZone: string;
  nowMs: number;
}

/** "YYYY-MM-DD" in `timeZone`: the calendar day an instant falls on there. */
export function bcDateOf(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/** Legacy's location: the city without ", BC" (News/Services.asmx.cs:118-128), within the release's 50 characters. */
export const locationOf = (cityName: string | null): string => (cityName ?? "").replaceAll(", BC", "").trim().slice(0, 50);

export const factsOf = (a: CalendarActivityRow): VisibilityFacts => ({
  contactMinistryKey: a.contactMinistryKey, sharedMinistryKeys: a.sharedMinistryKeys, isConfidential: a.isConfidential, isDeleted: a.isDeleted,
});

/** Whether a live, visible activity can be planned against (News/Services.asmx.cs:87); null when it can. */
function whyNotEligible(a: CalendarActivityRow, o: LookupOptions): string | null {
  if (o.prefix === null) return "Nothing is filled in: this site has no Calendar settings.";
  if (!hasCategoryStartingWith(a.categoryNames, o.prefix)) return `Nothing is filled in: its category doesn't start with “${o.prefix}”.`;
  if (a.endAt === null || bcDateOf(a.endAt.getTime(), o.timeZone) < bcDateOf(o.nowMs, o.timeZone)) return "Nothing is filled in: it has ended.";
  return null;
}

/** Keys NRMS offers (active), in the order given, lowercased as NRMS keeps them. */
async function activeKeys(db: DbOrTx, kind: "ministries" | "sectors" | "themes" | "tags", keys: readonly (string | null)[]): Promise<string[]> {
  const wanted = [...new Set(keys.flatMap((k) => (k ? [k.toLowerCase()] : [])))];
  if (wanted.length === 0) return [];
  const found =
    kind === "ministries"
      ? await db.select({ key: organizations.key }).from(organizations).where(and(inArray(organizations.key, wanted), eq(organizations.isActive, true)))
      : await db.select({ key: categoryTerms.key }).from(categoryTerms).where(and(eq(categoryTerms.kind, kind), inArray(categoryTerms.key, wanted), eq(categoryTerms.isActive, true)));
  const have = new Set(found.map((f) => f.key));
  return wanted.filter((k) => have.has(k));
}

/** Legacy's pre-fill (News/ReleaseManagement/New.aspx:625-700): publish time, location, ministries, sectors, themes and tags. */
async function prefillOf(db: DbOrTx, a: CalendarActivityRow): Promise<ReleasePrefill> {
  const ministries = await activeKeys(db, "ministries", [a.contactMinistryKey, ...a.sharedMinistryKeys]);
  const lead = a.contactMinistryKey?.toLowerCase() ?? null;
  return {
    publishAt: a.startAt?.toISOString() ?? null,
    location: locationOf(a.cityName),
    ministries,
    leadMinistryKey: lead !== null && ministries.includes(lead) ? lead : null,
    sectors: await activeKeys(db, "sectors", a.sectorKeys),
    themes: await activeKeys(db, "themes", a.themeKeys),
    tags: await activeKeys(db, "tags", a.tagKeys),
  };
}

/**
 * The release editor's lookup (spec addendum §11). It names an activity's state; detail leaves
 * only for an activity that isn't deleted or confidential and that `viewer` can see in the
 * Calendar (spec addendum §6).
 */
export async function lookupActivity(db: DbOrTx, viewer: Viewer | null, id: number, o: LookupOptions): Promise<ActivityLookup> {
  const [a] = await db.select().from(calendarActivities).where(eq(calendarActivities.id, id));
  if (!a) return { id, state: "unknown" };
  if (a.isDeleted) return { id, state: "deleted" };
  if (a.isConfidential || viewer === null || !visible(viewer, factsOf(a))) return { id, state: "hidden" };
  const [ministry] = a.contactMinistryKey
    ? await db.select({ name: organizations.displayName }).from(organizations).where(eq(organizations.key, a.contactMinistryKey.toLowerCase()))
    : [];
  const notEligible = whyNotEligible(a, o);
  return {
    id, state: "found", title: a.title ?? "", startAt: a.startAt?.toISOString() ?? null, endAt: a.endAt?.toISOString() ?? null,
    ministryName: ministry?.name ?? null, location: locationOf(a.cityName), translations: a.translations,
    prefill: notEligible === null ? await prefillOf(db, a) : null, notEligible,
  };
}

/**
 * Saving a release's activity id (C142): a new one must be an activity NRMS knows and that isn't
 * deleted. Confidential ids can be linked (NRMS holds them so typed ids resolve). An unchanged id
 * stands whatever it is: a release imported linked to an activity that wasn't migrated keeps it (C158).
 */
export async function assertActivityLinkable(db: DbOrTx, next: number | null, current: number | null): Promise<void> {
  if (next === null || next === current) return;
  const [a] = await db.select({ isDeleted: calendarActivities.isDeleted }).from(calendarActivities).where(eq(calendarActivities.id, next));
  if (!a) throw new ReleaseRuleError([`No Calendar activity has ID ${next}.`]);
  if (a.isDeleted) throw new ReleaseRuleError([`Calendar activity ${next} has been deleted.`]);
}
