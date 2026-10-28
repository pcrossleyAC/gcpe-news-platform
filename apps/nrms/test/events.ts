import { randomUUID } from "node:crypto";
import type express from "express";
import request from "supertest";
import { signPayload, type ActivityRecord, type OrgRecord, type UserRecord } from "@gcpe/events";

/** The receiver's secrets in NRMS tests: Core's reference data and users, the Calendar's activities. */
export const NRMS_EVENT_SECRETS = { core: "core-secret-for-nrms-tests", calendar: "calendar-secret-for-nrms-tests" } as const;

let seq = 0;
/** A signed-ready envelope; `sequence` defaults to the next number, so later calls are newer. */
export function envelope(source: string, type: string, data: unknown, aggregateId: string, sequence = ++seq) {
  return { id: randomUUID(), type, version: 1, source, aggregateId, sequence, occurredAt: new Date().toISOString(), correlationId: randomUUID(), data };
}
export const nextSequence = () => ++seq;

/** POSTs a signed event to the app's receiver, as a subscriber's dispatcher would. */
export function sendEvent(app: express.Express, event: ReturnType<typeof envelope>): Promise<request.Response> {
  const body = JSON.stringify(event);
  const ts = new Date().toISOString();
  const secret = NRMS_EVENT_SECRETS[event.source as keyof typeof NRMS_EVENT_SECRETS];
  return request(app)
    .post("/events")
    .set("content-type", "application/json")
    .set("x-event-source", event.source)
    .set("x-event-timestamp", ts)
    .set("x-signature", secret ? signPayload(secret, ts, body) : "bad-signature")
    .send(body);
}

/** A non-confidential activity as the Calendar sends it (spec addendum §5.4). Fictional values. */
export function activityRecord(id: number, over: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    id, isConfidential: false, isDeleted: false, title: `Sample activity ${id}`, details: "Sample details.",
    startAt: "2031-06-11T17:00:00.000Z", endAt: "2031-06-11T18:00:00.000Z", nrAt: null, isAllDay: false, isConfirmed: true,
    contactMinistryKey: "health", sharedMinistryKeys: [], categoryNames: ["Approved Event"], cityName: "Victoria, BC",
    themeKeys: [], tagKeys: [], sectorKeys: ["health"], translations: [],
    ...over,
  };
}

export function userRecord(id: string, over: Partial<UserRecord> = {}): UserRecord {
  return { id, email: "planner@example.test", displayName: "Sample Planner", isActive: true, calendarRole: "Calendar.ReadOnly", organizationKeys: ["health"], ...over };
}

export function orgRecord(key: string, over: Partial<OrgRecord> = {}): OrgRecord {
  return {
    key, displayName: key, abbreviation: key.toUpperCase().slice(0, 6), sortOrder: 0, isActive: true, parentKey: null, url: null, displayAdditionalName: null,
    minister: { name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null },
    contact: null, secondContact: null, weekendContactNumber: null, social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
    topicLinks: [], serviceLinks: [], sectorKeys: [], isHq: false, isPublic: true, successorKeys: [], updatedAt: "2026-10-08T17:00:00Z",
    ...over,
  };
}
