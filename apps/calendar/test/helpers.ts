import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type express from "express";
import request from "supertest";
import { mintSession } from "@gcpe/auth";
import type { CalendarRules } from "@gcpe/calendar-contract";
import { createTestDatabase, type Db, type TestDatabase } from "@gcpe/db-kit";
import { signPayload, type OrgRecord, type UserRecord } from "@gcpe/events";
import { createApp, type AppDeps } from "../src/app";

export const calendarMigrations = fileURLToPath(new URL("../migrations", import.meta.url));

export function createCalendarTestDb(): Promise<TestDatabase> {
  return createTestDatabase({ migrationsFolder: calendarMigrations });
}

export const EVENT_SECRETS = { core: "core-secret", nrms: "nrms-secret" } as const;
export const SESSION_SECRET = "calendar-session-secret-0123456789abcdef";

/** Fictional names only: never a legacy category name or value. */
export const TEST_RULES: CalendarRules = {
  timeZone: "America/Vancouver",
  freeze: { start: "16:00", end: "17:00" },
  releaseCategoryIds: [12, 58],
  awarenessCategoryIds: [2],
  otherCityId: 311,
  unconfirmedIssueCommMaterialId: 61,
  hqPlaceholderCategoryName: "Sample HQ placeholder",
  confidentialCategoryName: "Sample confidential category",
  issueExemptCategoryNames: ["Sample approved event", "Sample proposed release", "Sample approved release"],
  eventsCategoryNames: ["Sample approved event", "Sample proposed release", "Sample approved release", "Sample speech", "Sample HQ placeholder"],
  releaseHiddenCategoryNames: ["Sample awareness day"],
  consultationsMinistryAbbreviation: "CONSULT",
  contactMinistryExcludedAbbreviations: ["EXCL"],
  sharedWithExcludedAbbreviations: ["EXCL"],
  translationsDefault: ["Sample language A", "Sample language B"],
  required: { significance: true, scheduling: true, strategy: false },
  showHqCommentsField: false,
  showRecordsSection: false,
  cloneKeptKeywordNames: ["Sample kept keyword"],
  lookAheadCoverImage: null,
  reportBanner: { province: "Sample Province", confidentiality: "DRAFT AND CONFIDENTIAL" },
  reports: {
    cover: { organization: "Sample Communications Office", lines: ["SAMPLE PROVINCE", "CORPORATE LOOK AHEAD"] },
    planningTitle: "Sample Corporate Calendar: Schedule of Activities",
    leadAbbreviations: { FIN: "FN" },
    cityToBeDecidedName: "Sample undecided city",
    citySuffix: ", SP",
    tvRadioCategoryName: "Sample broadcast",
    issueCategoryText: "Sample issue",
    fyiOnlyCategoryText: "Sample FYI only",
    rlsMaterials: [
      { contains: ["Sample news release"], code: "NR" },
      { contains: ["Sample report"], code: "Report", notInEvents: true },
      { contains: ["Sample fact sheet", "Sample factsheet"], code: "Fact Sheet" },
      { contains: ["Sample newsletter"], code: "e-news", notInEvents: true, releaseTime: false },
    ],
    rlsOrigins: [
      { contains: ["Sample origin"], code: "Gov" },
      { contains: ["Sample joint origin"], code: "Joint" },
    ],
  },
};

/** 11:00 BC on 2026-11-03: outside the freeze, so a test run at 16:30 BC behaves like any other. */
export const FIXED_NOW = new Date("2026-11-03T18:00:00Z");

export function createTestApp(db: Db, over: Partial<AppDeps> = {}): express.Express {
  return createApp({ db, auth: { session: { secret: SESSION_SECRET } }, eventSecrets: EVENT_SECRETS, rules: TEST_RULES, subscribers: [], now: () => FIXED_NOW, ...over });
}

/** Resolves once at least `count` sessions are blocked on a lock. */
export async function waitForLockWaiters(tdb: TestDatabase, count: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await tdb.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r.rows[0]!.n >= count) return;
    if (Date.now() > deadline) throw new Error(`fewer than ${count} sessions started waiting for a lock`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Resolves once some session is blocked on a lock. */
export function waitForLockWaiter(tdb: TestDatabase, timeoutMs = 5000): Promise<void> {
  return waitForLockWaiters(tdb, 1, timeoutMs);
}

let seq = 0;
export function envelope(source: string, type: string, data: unknown, aggregateId: string) {
  return { id: randomUUID(), type, version: 1, source, aggregateId, sequence: ++seq, occurredAt: new Date().toISOString(), correlationId: randomUUID(), data };
}

export async function sendEvent(app: express.Express, event: ReturnType<typeof envelope>): Promise<request.Response> {
  const body = JSON.stringify(event);
  const ts = new Date().toISOString();
  const secret = EVENT_SECRETS[event.source as keyof typeof EVENT_SECRETS];
  return request(app)
    .post("/events")
    .set("content-type", "application/json")
    .set("x-event-source", event.source)
    .set("x-event-timestamp", ts)
    .set("x-signature", secret ? signPayload(secret, ts, body) : "bad-signature")
    .send(body);
}

/** A session cookie for `userId`. The roles in it are what sign-in minted; the Calendar ignores them. */
export async function sessionCookie(userId: string, roles: string[] = []): Promise<string> {
  const { token } = await mintSession(SESSION_SECRET, { id: userId, name: "Cookie Name", email: "cookie@example.test", roles });
  return `gcpe_session=${token}`;
}

export async function projectUser(app: express.Express, user: UserRecord): Promise<void> {
  const res = await sendEvent(app, envelope("core", "user.upserted", user, `user:${user.id}`));
  if (res.status !== 200) throw new Error(`user.upserted failed: ${res.status}`);
}

export function orgRecord(key: string, over: Partial<OrgRecord> = {}): OrgRecord {
  return {
    key,
    displayName: key,
    abbreviation: key.toUpperCase().slice(0, 6),
    sortOrder: 0,
    isActive: true,
    parentKey: null,
    url: null,
    displayAdditionalName: null,
    minister: { name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null },
    contact: null,
    secondContact: null,
    weekendContactNumber: null,
    social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
    topicLinks: [],
    serviceLinks: [],
    sectorKeys: [],
    isHq: false,
    isPublic: true,
    updatedAt: "2026-10-08T17:00:00Z",
    ...over,
  };
}

export async function projectOrg(app: express.Express, key: string, over: Partial<OrgRecord> = {}): Promise<void> {
  const res = await sendEvent(app, envelope("core", "org.upserted", orgRecord(key, over), `org:${key}`));
  if (res.status !== 200) throw new Error(`org.upserted failed: ${res.status}`);
}
