import { describe, expect, it } from "vitest";
// Relative import: @gcpe/events doesn't depend on @gcpe/nrms-contract; this keeps the lists equal.
import { RELEASE_STATUSES, RELEASE_TYPES } from "../../nrms-contract/src/types";
import { parseEvent, releaseStatusSchema, releaseTypeSchema, type ActivityRecord, type ReleaseStatusChanged } from "./index";

const envelope = (type: string, data: unknown, aggregateId = "activity:4101") => ({
  id: "6f0d7f4e-8a51-4d39-9f42-2a4f4c1c0b11",
  type,
  version: 1,
  source: type.startsWith("release.") ? "nrms" : "calendar",
  aggregateId,
  sequence: 1,
  occurredAt: "2026-10-08T17:00:00Z",
  correlationId: "0b8f3f86-2d1e-4b59-9e0c-5d6f1b1c2a33",
  data,
});

const activity: ActivityRecord = {
  id: 4101,
  isConfidential: false,
  isDeleted: false,
  title: "Sample community announcement",
  details: "Fictional details for a contract test.",
  startAt: "2026-11-02T17:00:00Z",
  endAt: "2026-11-02T18:00:00Z",
  nrAt: null,
  isAllDay: false,
  isConfirmed: true,
  contactMinistryKey: "health",
  sharedMinistryKeys: ["finance"],
  categoryNames: ["Approved Release"],
  cityName: "Victoria",
  themeKeys: [],
  tagKeys: ["sample-tag"],
  sectorKeys: ["health"],
  translations: ["French"],
};

describe("activity.created / activity.updated", () => {
  it("accepts a non-confidential activity with every §5.4 field", () => {
    for (const type of ["activity.created", "activity.updated"]) expect(parseEvent(envelope(type, activity)).data).toEqual(activity);
  });

  it("accepts a confidential activity as id, flag and deletion only", () => {
    const confidential = { id: 4102, isConfidential: true, isDeleted: false };
    expect(parseEvent(envelope("activity.updated", confidential)).data).toEqual(confidential);
  });

  it("refuses a confidential activity that carries any text (spec addendum §5.4: no confidential text leaves the Calendar)", () => {
    expect(() => parseEvent(envelope("activity.updated", { id: 4102, isConfidential: true, isDeleted: false, title: "leak" }))).toThrow();
    expect(() => parseEvent(envelope("activity.updated", { ...activity, isConfidential: true }))).toThrow();
  });

  it("accepts legacy's missing dates and missing contact ministry, and refuses a non-integer id", () => {
    const undated = { ...activity, startAt: null, endAt: null, contactMinistryKey: null };
    expect(parseEvent(envelope("activity.created", undated)).data).toEqual(undated);
    expect(() => parseEvent(envelope("activity.created", { ...activity, id: "4101" }))).toThrow();
    expect(() => parseEvent(envelope("activity.created", { ...activity, id: 0 }))).toThrow();
  });

  it("activity.deleted carries only the id", () => {
    expect(parseEvent(envelope("activity.deleted", { id: 4101 })).data).toEqual({ id: 4101 });
    expect(() => parseEvent(envelope("activity.deleted", { id: 4101, title: "x" }))).toThrow();
  });
});

describe("release.status_changed", () => {
  const change: ReleaseStatusChanged = {
    releaseId: "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a6b",
    key: "2026HLTH0001-000001",
    reference: "NEWS-00001",
    type: "release",
    activityId: 4101,
    previousActivityId: null,
    status: "scheduled",
    publishAt: "2026-11-02T17:00:00Z",
    releasedAt: null,
    headline: "Sample headline",
  };

  it("accepts a status change linked to an activity", () => {
    expect(parseEvent(envelope("release.status_changed", change, `release:${change.releaseId}`)).data).toEqual(change);
  });

  it("accepts a draft with no key and a link moved away (previousActivityId set, activityId null)", () => {
    const moved = { ...change, key: null, reference: null, status: "draft", activityId: null, previousActivityId: 4101, publishAt: null };
    expect(parseEvent(envelope("release.status_changed", moved, `release:${change.releaseId}`)).data).toEqual(moved);
  });

  it("refuses an unknown status or type", () => {
    expect(() => parseEvent(envelope("release.status_changed", { ...change, status: "archived" }))).toThrow();
    expect(() => parseEvent(envelope("release.status_changed", { ...change, type: "newsletter" }))).toThrow();
  });

  it("names exactly packages/nrms-contract's release types and statuses", () => {
    expect(releaseTypeSchema.options).toEqual([...RELEASE_TYPES]);
    expect(releaseStatusSchema.options).toEqual([...RELEASE_STATUSES]);
  });
});
