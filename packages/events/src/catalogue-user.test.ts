import { describe, expect, it } from "vitest";
// Relative import: @gcpe/events doesn't depend on @gcpe/auth; this keeps the two role lists equal.
import { CALENDAR_ROLES } from "../../auth/src/roles";
import { calendarRoleSchema, parseEvent, type UserRecord } from "./index";

const user: UserRecord = {
  id: "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a6b",
  email: "robin.staff@example.test",
  displayName: "Robin Staff",
  isActive: true,
  calendarRole: "Calendar.Editor",
  organizationKeys: ["health"],
};

const envelope = (data: unknown) => ({
  id: "6f0d7f4e-8a51-4d39-9f42-2a4f4c1c0b11",
  type: "user.upserted",
  version: 1,
  source: "core",
  aggregateId: `user:${user.id}`,
  sequence: 1,
  occurredAt: "2026-10-07T17:00:00Z",
  correlationId: "0b8f3f86-2d1e-4b59-9e0c-5d6f1b1c2a33",
  data,
});

describe("user.upserted", () => {
  it("accepts a user with a Calendar role and ministries", () => {
    expect(parseEvent(envelope(user)).data).toEqual(user);
  });

  it("accepts an inactive user with no email and no Calendar access", () => {
    const imported = { ...user, email: null, isActive: false, calendarRole: null, organizationKeys: [] };
    expect(parseEvent(envelope(imported)).data).toEqual(imported);
  });

  it("rejects an unknown Calendar role, a missing ministry list, and a non-uuid id", () => {
    expect(() => parseEvent(envelope({ ...user, calendarRole: "Calendar.Owner" }))).toThrow();
    const { organizationKeys: _k, ...noKeys } = user;
    expect(() => parseEvent(envelope(noKeys))).toThrow();
    expect(() => parseEvent(envelope({ ...user, id: "local:admin" }))).toThrow();
  });

  it("names exactly packages/auth's Calendar roles, in order", () => {
    expect(calendarRoleSchema.options).toEqual([...CALENDAR_ROLES]);
  });
});
