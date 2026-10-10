import type express from "express";
import request from "supertest";
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { CalendarRole } from "@gcpe/auth";
import type { ActivityFields } from "@gcpe/calendar-contract";
import { outboxEvents } from "@gcpe/events";
import {
  activities, activityChangeFields, activityChanges, categories, cities, commContacts, commMaterials, eventPlanners, governmentRepresentatives, initiatives, keywords,
  nrDistributions, nrOrigins, premierRequested, videographers,
} from "../src/db/schema";
import { envelope, projectOrg, projectUser, sendEvent, sessionCookie } from "./helpers";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export type Who = "readOnly" | "editor" | "financeEditor" | "advanced" | "admin" | "hqReadOnly" | "hqEditor" | "hqAdvanced" | "hqAdmin";
const PEOPLE: Record<Who, { n: number; role: CalendarRole; org: string; name: string }> = {
  readOnly: { n: 401, role: "Calendar.ReadOnly", org: "health", name: "Sample Reader" },
  editor: { n: 402, role: "Calendar.Editor", org: "health", name: "Robin Staff" },
  financeEditor: { n: 403, role: "Calendar.Editor", org: "finance", name: "Kim Finance" },
  advanced: { n: 404, role: "Calendar.Advanced", org: "health", name: "Sample Advanced" },
  admin: { n: 405, role: "Calendar.Administrator", org: "health", name: "Sample Admin" },
  hqReadOnly: { n: 406, role: "Calendar.ReadOnly", org: "gcpe-hq", name: "Sample HQ Reader" },
  hqEditor: { n: 407, role: "Calendar.Editor", org: "gcpe-hq", name: "Sample HQ Editor" },
  hqAdvanced: { n: 408, role: "Calendar.Advanced", org: "gcpe-hq", name: "Sample HQ Advanced" },
  hqAdmin: { n: 409, role: "Calendar.Administrator", org: "gcpe-hq", name: "Sample HQ Admin" },
};

export interface World {
  as: Record<Who, { id: string; cookie: string; name: string }>;
  cat: { proposedRelease: 12; approvedRelease: 58; awareness: 2; event: 30; speech: 31; plain: 32; hqPlaceholder: 33; retired: 34; hqPlaceholderSpaced: 35 };
  city: { sample: 1; other: 311; retired: 2 };
  commMaterial: { newsRelease: 1; unconfirmedMarker: 61; retired: 3 };
  ids: { origin: 1; distribution: 1; premierYes: 1; premierMaybe: 2; planner: 1; planner2: 2; videographer: 1; videographer2: 2; representative: 1; representative2: 2; initiative: 1; keptKeyword: 1; sampleTag: 2 };
  contact: { editorHealth: number; adminHealth: number; financeEditor: number; retiredHealth: number };
}

export function projectTerm(app: express.Express, kind: "sector" | "theme" | "tag", key: string, over: { isActive?: boolean } = {}) {
  const record = { kind, key, displayName: `Sample ${kind} ${key}`, sortOrder: 0, isActive: over.isActive ?? true, social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null }, updatedAt: "2026-10-08T17:00:00Z" };
  return sendEvent(app, envelope("core", `${kind}.upserted`, record, `${kind}:${key}`));
}

/** Organizations, terms, people at every level, every lookup and four comm contacts. Fictional values only. */
export async function seedWorld(app: express.Express, db: Db): Promise<World> {
  await projectOrg(app, "health", { abbreviation: "HLTH", displayName: "Sample Health" });
  await projectOrg(app, "finance", { abbreviation: "FIN", displayName: "Sample Finance" });
  await projectOrg(app, "gcpe-hq", { abbreviation: "HQ", displayName: "Sample HQ", isHq: true });
  await projectOrg(app, "consult", { abbreviation: "CONSULT", displayName: "Sample Consultations" });
  await projectOrg(app, "excluded", { abbreviation: "EXCL", displayName: "Sample Excluded" });
  await projectOrg(app, "retired", { abbreviation: "RET", displayName: "Sample Retired", isActive: false });
  await projectTerm(app, "sector", "sample-sector");
  await projectTerm(app, "theme", "sample-theme");
  await projectTerm(app, "tag", "sample-tag");
  await projectTerm(app, "tag", "retired-tag", { isActive: false });

  const as = {} as World["as"];
  for (const [who, p] of Object.entries(PEOPLE) as [Who, (typeof PEOPLE)[Who]][]) {
    await projectUser(app, { id: uid(p.n), email: `${who}@example.test`, displayName: p.name, isActive: true, calendarRole: p.role, organizationKeys: [p.org] });
    as[who] = { id: uid(p.n), cookie: await sessionCookie(uid(p.n)), name: p.name };
  }

  await db.insert(categories).values([
    { id: 12, name: "Sample proposed release" }, { id: 58, name: "Sample approved release" }, { id: 2, name: "Sample awareness day" },
    { id: 30, name: "Sample approved event" }, { id: 31, name: "Sample speech" }, { id: 32, name: "Sample plain category" },
    { id: 33, name: "Sample HQ placeholder", isActive: false }, { id: 34, name: "Sample retired category", isActive: false },
    // Legacy-style stray whitespace (legacy category 16: "Speech /  Remarks"): the tenant's hqPlaceholderCategoryName is "Sample HQ placeholder".
    { id: 35, name: " Sample  HQ placeholder ", isActive: false },
  ]);
  await db.insert(cities).values([{ id: 1, name: "Sample City" }, { id: 311, name: "Other..." }, { id: 2, name: "Sample Retired City", isActive: false }]);
  await db.insert(commMaterials).values([{ id: 1, name: "Sample news release" }, { id: 61, name: "Sample unconfirmed marker" }, { id: 3, name: "Sample retired material", isActive: false }]);
  await db.insert(nrOrigins).values([{ id: 1, name: "Sample origin" }, { id: 2, name: "Sample joint origin" }]);
  await db.insert(nrDistributions).values([{ id: 1, name: "Sample distribution" }, { id: 2, name: "Sample wide distribution" }]);
  await db.insert(premierRequested).values([{ id: 1, name: "Sample yes" }, { id: 2, name: "Sample maybe" }]);
  await db.insert(eventPlanners).values([{ id: 1, name: "Sample Planner" }, { id: 2, name: "Sample Planner Two" }]);
  await db.insert(videographers).values([{ id: 1, name: "Sample Videographer" }, { id: 2, name: "Sample Videographer Two" }]);
  await db.insert(governmentRepresentatives).values([{ id: 1, name: "Sample Representative" }, { id: 2, name: "Sample Representative Two" }]);
  await db.insert(initiatives).values([{ id: 1, name: "Sample initiative", shortName: "SI" }]);
  await db.insert(keywords).values([{ id: 1, name: "Sample kept keyword" }, { id: 2, name: "sample tag" }]);
  // Explicit ids above leave the identities behind them, as the importer's will; re-base them.
  for (const t of ["categories", "cities", "comm_materials", "nr_origins", "nr_distributions", "premier_requested", "event_planners", "videographers", "government_representatives", "initiatives", "keywords"]) {
    await db.execute(sql`SELECT setval(pg_get_serial_sequence(${t}, 'id'), (SELECT max(id) FROM ${sql.identifier(t)}))`);
  }

  const contact = async (who: Who, ministryKey: string, isActive = true) =>
    (await db.insert(commContacts).values({ userId: as[who].id, ministryKey, rank: 4, isActive }).returning({ id: commContacts.id }))[0]!.id;
  return {
    as,
    cat: { proposedRelease: 12, approvedRelease: 58, awareness: 2, event: 30, speech: 31, plain: 32, hqPlaceholder: 33, retired: 34, hqPlaceholderSpaced: 35 },
    city: { sample: 1, other: 311, retired: 2 },
    commMaterial: { newsRelease: 1, unconfirmedMarker: 61, retired: 3 },
    ids: { origin: 1, distribution: 1, premierYes: 1, premierMaybe: 2, planner: 1, planner2: 2, videographer: 1, videographer2: 2, representative: 1, representative2: 2, initiative: 1, keptKeyword: 1, sampleTag: 2 },
    contact: { editorHealth: await contact("editor", "health"), adminHealth: await contact("admin", "health"), financeEditor: await contact("financeEditor", "finance"), retiredHealth: await contact("advanced", "health", false) },
  };
}

export function validInput(w: World, over: Partial<ActivityFields> = {}): ActivityFields {
  return {
    categoryId: w.cat.plain, title: "Sample activity", details: "Sample summary", significance: "Sample significance", strategy: "",
    schedule: "Sample scheduling", comments: "", leadOrganization: "", venue: "", otherCity: "", potentialDates: "",
    isIssue: false, isConfidential: false, isMilestone: false, isCrossGovernment: false, isAtLegislature: false, isAllDay: false, isConfirmed: true,
    startDate: "2026-11-10", startTime: "09:00", endDate: "2026-11-10", endTime: "10:00", nrDate: null, nrTime: null,
    contactMinistryKey: "health", commContactId: w.contact.editorHealth, governmentRepresentativeId: null, cityId: w.city.sample,
    premierRequestedId: null, nrDistributionId: null, eventPlannerId: null, videographerId: null, nrOriginId: null,
    commMaterialIds: [], initiativeIds: [], keywordNames: [], sectorKeys: [], themeKeys: [], tagKeys: [], sharedWithKeys: [], translations: [],
    ...over,
  };
}

export function call(app: express.Express, method: "get" | "post" | "put" | "delete", path: string, cookie: string, body?: object) {
  const r = request(app)[method](path).set("cookie", cookie);
  if (method !== "get") r.set("x-gcpe-request", "1");
  return body === undefined ? r : r.send(body);
}

/** The envelopes the Calendar queued for one activity, oldest first. */
export async function outboxOf(db: Db, activityId: number) {
  const rows = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, `activity:${activityId}`)).orderBy(asc(outboxEvents.sequence));
  return rows.map((r) => r.envelope as { type: string; data: Record<string, unknown> });
}

/** An activity as the importer will write it: whatever legacy held, rules or not. */
export async function insertRaw(db: Db, over: Partial<typeof activities.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(activities)
    .values({
      title: "Sample imported", details: "Sample details", significance: "Sample significance", schedule: "Sample schedule",
      contactMinistryKey: "health", startAt: new Date("2026-11-10T17:00:00Z"), endAt: new Date("2026-11-10T18:00:00Z"),
      isConfirmed: true, status: "reviewed", hqSection: "in_the_news", ...over,
    })
    .returning({ id: activities.id });
  return row!.id;
}

/** One activity's history entries, oldest first, each with its field rows as `{ key: [old, new] }`. */
export async function historyOf(db: Db, id: number) {
  const changes = await db.select().from(activityChanges).where(eq(activityChanges.activityId, id)).orderBy(asc(activityChanges.id));
  const fields = await db.select().from(activityChangeFields);
  return changes.map((c) => ({ action: c.action, actorName: c.actorName, fields: Object.fromEntries(fields.filter((f) => f.changeId === c.id).map((f) => [f.fieldKey, [f.oldValue, f.newValue]])) }));
}
