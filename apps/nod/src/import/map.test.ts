import { describe, expect, it } from "vitest";
import { deliveryModes, fingerprintOf, legacyStatus, mapLists, mapSubscriber, pickWinners, type LegacySubscriberRow } from "./map";

const TZ = "America/Vancouver";
const RUN_AT = new Date("2026-11-20T18:00:00Z");
const row = (over: Partial<LegacySubscriberRow>): LegacySubscriberRow => ({
  SubscriberGuid: "B0000000-0000-4000-8000-000000000001",
  RegisteredDateTime: new Date("2017-03-01T09:00:00Z"),
  EmailAddress: "pat@example.test",
  IsSelfSubscription: true,
  IsEnabled: true,
  IsDeleted: false,
  ImmediateDelivery: true,
  DigestDelivery: false,
  ...over,
});

describe("mapLists", () => {
  const nod = [
    { listKey: "ministries:health", category: "ministries", name: "Health" },
    { listKey: "media-distribution-lists:000-0-victoria", category: "media-distribution-lists", name: "000.0 - Victoria" },
    { listKey: "media-distribution-lists:sample-town", category: "media-distribution-lists", name: "001.0 - Sample Town" },
  ];
  const legacy = (guid: string, CategoryKey: string, ListKey: string, over: Partial<{ ListName: string; ListDeleted: boolean; CategoryDeleted: boolean }> = {}) => ({
    ListGuid: guid, CategoryKey, ListKey, ListName: over.ListName ?? ListKey, ListDeleted: over.ListDeleted ?? false, CategoryDeleted: over.CategoryDeleted ?? false,
  });

  it("maps by key case-insensitively, All news to '*', a media list by name when its key differs; skips with reasons", () => {
    const m = mapLists(
      [
        legacy("A1", "all-news", "all-news"),
        legacy("A2", "Ministries", "HEALTH"),
        legacy("A3", "media-distribution-lists", "000-0-victoria"),
        legacy("A4", "media-distribution-lists", "old-key", { ListName: "001.0 - Sample Town" }),
        legacy("A5", "ministries", "finance", { ListDeleted: true }),
        legacy("A6", "services", "bc-jobs"),
        legacy("A7", "emergency", "alerts", { CategoryDeleted: true }),
        legacy("A8", "ministries", "nowhere"),
      ],
      nod,
    );
    expect(Object.fromEntries(m.byGuid)).toEqual({
      a1: { listKey: "*", media: false },
      a2: { listKey: "ministries:health", media: false },
      a3: { listKey: "media-distribution-lists:000-0-victoria", media: true },
      a4: { listKey: "media-distribution-lists:sample-town", media: true },
    });
    expect(Object.fromEntries(m.skipped)).toEqual({
      a5: "list or its category is deleted in legacy",
      a6: 'category "services" is not carried over',
      a7: "list or its category is deleted in legacy",
      a8: "no matching NoD list",
    });
    expect(m.categoryOf.get("a7")).toBe("emergency");
  });
});

describe("subscribers", () => {
  it("status: deleted wins, then enabled; legacy has no pending", () => {
    expect(legacyStatus(row({ IsEnabled: true, IsDeleted: true }))).toBe("deleted");
    expect(legacyStatus(row({ IsEnabled: true }))).toBe("active");
    expect(legacyStatus(row({ IsEnabled: false }))).toBe("disabled");
  });

  it("one record per address: active over disabled over deleted, then the newest; invalid addresses out", () => {
    const { winners, duplicates, invalid } = pickWinners([
      row({ SubscriberGuid: "B1", EmailAddress: " Pat@Example.TEST ", IsDeleted: true, RegisteredDateTime: new Date("2025-01-01T00:00:00Z") }),
      row({ SubscriberGuid: "B2", EmailAddress: "pat@example.test", IsEnabled: false }),
      row({ SubscriberGuid: "B3", EmailAddress: "pat@example.test", RegisteredDateTime: new Date("2015-01-01T00:00:00Z") }),
      row({ SubscriberGuid: "B4", EmailAddress: "pat@example.test", RegisteredDateTime: new Date("2016-01-01T00:00:00Z") }),
      row({ SubscriberGuid: "B5", EmailAddress: "not-an-address" }),
    ]);
    expect(winners.map((w) => w.SubscriberGuid)).toEqual(["B4"]);
    expect(duplicates.sort()).toEqual(["b1", "b2", "b3"]);
    expect(invalid).toEqual(["b5"]);
  });

  it("maps a self subscriber: lowercased address, BC wall clock to an instant, timing as is", () => {
    const m = mapSubscriber(row({ EmailAddress: " Pat@Example.TEST " }), [{ listKey: "ministries:health", media: false }, { listKey: "*", media: false }], null, { timeZone: TZ, runAt: RUN_AT });
    expect(m).toMatchObject({
      id: "b0000000-0000-4000-8000-000000000001",
      state: { email: "pat@example.test", status: "active", asItHappens: true, digest: false, source: "self", listKeys: ["*", "ministries:health"] },
      createdAt: new Date("2017-03-01T17:00:00Z"),
      endedAt: null,
    });
  });

  it("a non-self subscriber on a media list is manual-media; otherwise admin", () => {
    const media = [{ listKey: "media-distribution-lists:000-0-victoria", media: true }];
    expect(mapSubscriber(row({ IsSelfSubscription: false }), media, null, { timeZone: TZ, runAt: RUN_AT }).state.source).toBe("manual-media");
    expect(mapSubscriber(row({ IsSelfSubscription: false }), [], null, { timeZone: TZ, runAt: RUN_AT }).state.source).toBe("admin");
    expect(mapSubscriber(row({ IsSelfSubscription: true }), media, null, { timeZone: TZ, runAt: RUN_AT }).state.source).toBe("self");
  });

  it("a deleted subscriber keeps no lists; ended_at is legacy's date, else the import time", () => {
    const lists = [{ listKey: "ministries:health", media: false }];
    const ended = new Date("2026-05-01T17:00:00Z");
    expect(mapSubscriber(row({ IsDeleted: true }), lists, ended, { timeZone: TZ, runAt: RUN_AT })).toMatchObject({ state: { status: "deleted", listKeys: [] }, endedAt: ended });
    expect(mapSubscriber(row({ IsDeleted: true }), lists, null, { timeZone: TZ, runAt: RUN_AT }).endedAt).toEqual(RUN_AT);
  });

  it("an active subscriber with neither timing is imported as is", () => {
    expect(mapSubscriber(row({ ImmediateDelivery: false, DigestDelivery: false }), [], null, { timeZone: TZ, runAt: RUN_AT }).state).toMatchObject({ status: "active", asItHappens: false, digest: false });
  });

  it("the fingerprint ignores list order and duplicates, and changes with any field", () => {
    const base = { email: "pat@example.test", status: "active" as const, asItHappens: true, digest: false, source: "self" as const, listKeys: ["b", "a"] };
    expect(fingerprintOf(base)).toBe(fingerprintOf({ ...base, listKeys: ["a", "b", "a"] }));
    expect(fingerprintOf(base)).not.toBe(fingerprintOf({ ...base, digest: true }));
  });
});

describe("deliveryModes", () => {
  const sub = { asItHappens: true, digest: false, mediaKeys: new Set(["media-distribution-lists:000-0-victoria"]) };
  const release = { kind: "release" as const, mediaListKeys: [] as string[] };
  const flags = (i: boolean, d: boolean) => ({ ImmediateAttempted: i, DigestAttempted: d });

  it("a release: each attempted mode the subscriber actually takes", () => {
    expect(deliveryModes(flags(true, true), sub, release)).toEqual(["as_it_happens"]);
    expect(deliveryModes(flags(true, true), { ...sub, digest: true }, release)).toEqual(["as_it_happens", "digest"]);
    expect(deliveryModes(flags(true, true), { ...sub, asItHappens: false, digest: false }, release)).toEqual([]);
    expect(deliveryModes(flags(false, false), sub, release)).toEqual([]);
  });
  it("a release on a media list the subscriber is on is a media send", () => {
    expect(deliveryModes(flags(true, false), sub, { kind: "release", mediaListKeys: ["media-distribution-lists:000-0-victoria"] })).toEqual(["media"]);
  });
  it("a media-list member who doesn't take as-it-happens wasn't sent the release: legacy marks it attempted only to suppress it", () => {
    expect(deliveryModes(flags(true, false), { ...sub, asItHappens: false }, { kind: "release", mediaListKeys: ["media-distribution-lists:000-0-victoria"] })).toEqual([]);
  });
  it("an emergency alert went to everyone on the list, whatever their timing", () => {
    expect(deliveryModes(flags(false, true), { ...sub, asItHappens: false }, { kind: "emergency", mediaListKeys: [] })).toEqual(["as_it_happens"]);
  });
});
