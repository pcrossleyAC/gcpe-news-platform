import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { cabinetChanges, organizations, userOrganizations, users } from "../db/schema";
import {
  cabinetOperationSchema,
  cancelCabinetChange,
  getOpenCabinetChange,
  previewCabinetChange,
  publishCabinetChange,
  publishDueCabinetChanges,
  saveCabinetChangeDraft,
  scheduleCabinetChange,
  type CabinetOperation,
} from "./cabinet-changes";
import { deactivateOrganization, getOrganization, patchOrganizationProfile, upsertOrganization, type SuccessionInput } from "./organizations";

const subs: SubscriberConfig[] = [{ name: "news-api", url: "http://x/events", secret: "s", types: ["*"] }];
const moves: Omit<SuccessionInput, "successorKeys"> = { moveSubscribers: true, moveStaff: true, moveCalendar: true, moveDrafts: true, takeAbbreviation: true };

describe("cabinet changes (new-government spec §5)", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE organizations, users, cabinet_changes, outbox_events, aggregate_sequences CASCADE");
  });

  const org = (key: string, displayName: string, abbreviation: string | null, sortOrder = 10) =>
    upsertOrganization(tdb.db, { ...healthOrg, key, displayName, abbreviation, sortOrder }, subs);
  const stamp = async (key: string) => (await getOrganization(tdb.db, key))!.updatedAt;
  const clearOutbox = () => tdb.pool.query("TRUNCATE outbox_events, aggregate_sequences CASCADE");
  async function outbox(): Promise<{ type: string; aggregateId: string; data: Record<string, unknown> }[]> {
    const { rows } = await tdb.pool.query<{ type: string; aggregate_id: string; envelope: { data: Record<string, unknown> } }>(
      "SELECT type, aggregate_id, envelope FROM outbox_events ORDER BY ctid",
    );
    return rows.map((r) => ({ type: r.type, aggregateId: r.aggregate_id, data: r.envelope.data }));
  }
  const draft = (operations: CabinetOperation[]) => saveCabinetChangeDraft(tdb.db, operations, "admin@example.test");
  const orgKeys = async () => (await tdb.db.select({ key: organizations.key }).from(organizations)).map((r) => r.key).sort();

  async function mergeOps(): Promise<CabinetOperation[]> {
    return [
      { op: "create", ref: "new-c", displayName: "C" },
      { op: "succeed", key: "a", expectedUpdatedAt: await stamp("a"), successors: [{ ref: "new-c" }], moves },
      { op: "succeed", key: "b", expectedUpdatedAt: await stamp("b"), successors: [{ ref: "new-c" }], moves: { ...moves, takeAbbreviation: false } },
    ];
  }

  it("merge A+B→C publishes atomically", async () => {
    await org("a", "Alpha", "ALPH");
    await org("b", "Beta", "BETA");
    const [u] = await tdb.db.insert(users).values({ email: "u@example.test", displayName: "U" }).returning({ id: users.id });
    const [aRow] = await tdb.db.select().from(organizations).where(eq(organizations.key, "a"));
    await tdb.db.insert(userOrganizations).values({ userId: u!.id, organizationId: aRow!.id });
    const change = await draft(await mergeOps());
    await clearOutbox();

    expect(await publishCabinetChange(tdb.db, change.id, subs)).toEqual({ result: "published" });

    expect(await getOrganization(tdb.db, "c")).toMatchObject({ displayName: "C", isActive: true, abbreviation: "ALPH", successorKeys: [] });
    expect(await getOrganization(tdb.db, "a")).toMatchObject({ isActive: false, successorKeys: ["c"] });
    expect(await getOrganization(tdb.db, "b")).toMatchObject({ isActive: false, successorKeys: ["c"], abbreviation: "BETA" });
    // The same events, in the same order, as the three operations done one at a time.
    const events = await outbox();
    expect(events.map((e) => `${e.type} ${e.aggregateId}`)).toEqual([
      "org.upserted org:c",
      "org.upserted org:a",
      "org.deactivated org:a",
      "org.upserted org:c",
      "org.succeeded org:a",
      `user.upserted user:${u!.id}`,
      "org.upserted org:b",
      "org.deactivated org:b",
      "org.succeeded org:b",
    ]);
    expect(events.filter((e) => e.type === "org.succeeded").map((e) => e.data)).toEqual([
      { key: "a", successorKeys: ["c"], moveSubscribers: true, moveCalendar: true, moveDrafts: true, takeAbbreviation: true, at: expect.any(String) },
      { key: "b", successorKeys: ["c"], moveSubscribers: true, moveCalendar: true, moveDrafts: true, takeAbbreviation: false, at: expect.any(String) },
    ]);
    const [row] = await tdb.db.select().from(cabinetChanges).where(eq(cabinetChanges.id, change.id));
    expect(row).toMatchObject({ status: "published", error: null });
    expect(row!.publishedAt).toBeInstanceOf(Date);
    expect(await getOpenCabinetChange(tdb.db)).toBeNull();
    // A published change can't be published again.
    expect(await publishCabinetChange(tdb.db, change.id, subs)).toEqual({ result: "not-open" });
  });

  it("one invalid op writes nothing", async () => {
    await org("a", "Alpha", "ALPH");
    await org("b", "Beta", "BETA");
    const change = await draft([
      { op: "update", key: "a", expectedUpdatedAt: await stamp("a"), patch: { displayName: "Alpha Renamed" } },
      { op: "create", ref: "x", displayName: "Xray", abbreviation: "beta" },
    ]);
    await clearOutbox();

    const result = await publishCabinetChange(tdb.db, change.id, subs);
    expect(result).toEqual({ result: "invalid", problems: [{ op: 1, message: "The abbreviation BETA is already used by Beta." }] });
    expect((await getOrganization(tdb.db, "a"))!.displayName).toBe("Alpha");
    expect(await orgKeys()).toEqual(["a", "b"]);
    expect(await outbox()).toEqual([]);
    expect((await getOpenCabinetChange(tdb.db))!.status).toBe("draft");
  });

  it("an abbreviation a hand-over in the same change frees can be reused", async () => {
    await org("a", "Alpha", "ALPH");
    await org("b", "Beta", "BETA");
    const change = await draft([
      { op: "update", key: "b", expectedUpdatedAt: await stamp("b"), patch: { abbreviation: "ALPH", displayName: "Beta and Alpha" } },
      { op: "succeed", key: "a", expectedUpdatedAt: await stamp("a"), successors: [{ key: "b" }], moves: { ...moves, takeAbbreviation: false } },
    ]);
    expect(await publishCabinetChange(tdb.db, change.id, subs)).toEqual({ result: "published" });
    expect(await getOrganization(tdb.db, "b")).toMatchObject({ abbreviation: "ALPH", displayName: "Beta and Alpha", isActive: true });
  });

  it("stale expectedUpdatedAt refuses the whole change and names the ministry", async () => {
    await org("a", "Alpha", "ALPH");
    await org("b", "Beta", "BETA");
    const change = await draft([
      { op: "create", ref: "x", displayName: "Xray" },
      { op: "update", key: "b", expectedUpdatedAt: await stamp("b"), patch: { displayName: "Beta Two" } },
      { op: "succeed", key: "a", expectedUpdatedAt: await stamp("a"), successors: [{ ref: "x" }], moves },
    ]);
    await new Promise((r) => setTimeout(r, 5));
    await patchOrganizationProfile(tdb.db, "a", { displayName: "Alpha (edited elsewhere)" }, subs);
    await clearOutbox();

    expect(await publishCabinetChange(tdb.db, change.id, subs)).toEqual({ result: "stale", key: "a" });
    expect(await orgKeys()).toEqual(["a", "b"]);
    expect((await getOrganization(tdb.db, "b"))!.displayName).toBe("Beta");
    expect(await getOrganization(tdb.db, "a")).toMatchObject({ isActive: true, successorKeys: [] });
    expect(await outbox()).toEqual([]);
    const preview = await previewCabinetChange(tdb.db, change.id);
    expect(preview.problems).toEqual([{ op: 2, message: "Alpha (edited elsewhere) was changed by someone else since this draft was started." }]);
  });

  it('abolish without "No successor" ticked is a problem', async () => {
    await org("a", "Alpha", "ALPH");
    const op: CabinetOperation = { op: "succeed", key: "a", expectedUpdatedAt: await stamp("a"), successors: [], moves };
    const change = await draft([op]);
    const problem = { op: 0, message: "Choose a successor for Alpha, or tick “No successor” to abolish it." };
    expect((await previewCabinetChange(tdb.db, change.id)).problems).toEqual([problem]);
    expect(await publishCabinetChange(tdb.db, change.id, subs)).toEqual({ result: "invalid", problems: [problem] });
    expect((await getOrganization(tdb.db, "a"))!.isActive).toBe(true);

    // Ticked, it is a plain deactivate: the same single org.deactivated as the Deactivate button.
    await draft([{ ...op, noSuccessor: true }]);
    await clearOutbox();
    expect(await publishCabinetChange(tdb.db, change.id, subs)).toEqual({ result: "published" });
    expect(await getOrganization(tdb.db, "a")).toMatchObject({ isActive: false, successorKeys: [] });
    expect((await outbox()).map((e) => `${e.type} ${e.aggregateId}`)).toEqual(["org.deactivated org:a"]);
  });

  it("a successor and “No successor” together, an unknown ref, an unknown ministry and a double hand-over are problems", async () => {
    await org("a", "Alpha", "ALPH");
    await org("b", "Beta", "BETA");
    const a = await stamp("a");
    const change = await draft([
      { op: "succeed", key: "a", expectedUpdatedAt: a, successors: [{ key: "b" }], moves, noSuccessor: true },
      { op: "succeed", key: "a", expectedUpdatedAt: a, successors: [{ ref: "nope" }], moves },
      { op: "update", key: "zzz", expectedUpdatedAt: a, patch: { displayName: "Z" } },
    ]);
    expect((await previewCabinetChange(tdb.db, change.id)).problems).toEqual([
      { op: 0, message: "Choose a successor for Alpha or tick “No successor”, not both." },
      { op: 1, message: "Alpha is handed over more than once in this change." },
      { op: 1, message: "No new ministry in this change is called “nope”." },
      { op: 2, message: "The ministry “zzz” doesn't exist." },
    ]);
  });

  it("preview shows the diff, the resulting list in sort order and the service's own problems, and writes nothing", async () => {
    await org("a", "Alpha", "ALPH", 10);
    await org("b", "Beta", "BETA", 20);
    const change = await draft(await mergeOps());
    await clearOutbox();

    const preview = await previewCabinetChange(tdb.db, change.id);
    expect(preview.problems).toEqual([]);
    expect(preview.resulting.map((o) => `${o.key}:${o.isActive ? "active" : "inactive"}:${o.abbreviation}`)).toEqual([
      "a:inactive:ALPH",
      "b:inactive:BETA",
      "c:active:ALPH",
    ]);
    expect(preview.diff).toEqual(
      expect.arrayContaining([
        { key: "a", displayName: "Alpha", kind: "changed", field: "isActive", from: true, to: false },
        { key: "a", displayName: "Alpha", kind: "changed", field: "successorKeys", from: [], to: ["c"] },
        { key: "c", displayName: "C", kind: "created", field: "displayName", from: null, to: "C" },
        { key: "c", displayName: "C", kind: "created", field: "abbreviation", from: null, to: "ALPH" },
      ]),
    );
    expect(preview.diff.some((d) => d.field === "updatedAt")).toBe(false);
    expect(await orgKeys()).toEqual(["a", "b"]);
    expect(await outbox()).toEqual([]);

    // A loop is refused by the hand-over itself.
    const loop = await draft([
      { op: "succeed", key: "a", expectedUpdatedAt: await stamp("a"), successors: [{ key: "b" }], moves },
      { op: "succeed", key: "b", expectedUpdatedAt: await stamp("b"), successors: [{ key: "a" }], moves },
    ]);
    expect((await previewCabinetChange(tdb.db, loop.id)).problems).toEqual([{ op: 1, message: "Choose an active ministry as successor." }]);
  });

  it("only one open draft", async () => {
    const first = await draft([]);
    const second = await draft([{ op: "create", ref: "x", displayName: "Xray" }]);
    expect(second.id).toBe(first.id);
    expect(second.operations).toHaveLength(1);
    expect(second.createdBy).toBe("admin@example.test");
    await expect(tdb.db.insert(cabinetChanges).values({ status: "scheduled", operations: [] })).rejects.toThrow();
    await expect(tdb.db.insert(cabinetChanges).values({ status: "draft", operations: [] })).rejects.toThrow();
    // Closed changes don't count.
    expect(await cancelCabinetChange(tdb.db, first.id)).toBe(true);
    expect(await getOpenCabinetChange(tdb.db)).toBeNull();
    const third = await draft([]);
    expect(third.id).not.toBe(first.id);
    await expect(tdb.db.insert(cabinetChanges).values({ status: "cancelled", operations: [] })).resolves.toBeDefined();
  });

  it("scheduled change publishes when due, and not before", async () => {
    await org("a", "Alpha", "ALPH");
    const at = new Date("2028-11-20T08:00:00Z");
    const before = () => new Date(at.getTime() - 60_000);
    const change = await draft([{ op: "update", key: "a", expectedUpdatedAt: await stamp("a"), patch: { displayName: "Alpha Renamed" } }]);
    expect(await scheduleCabinetChange(tdb.db, change.id, at, before)).toMatchObject({ result: "scheduled", change: { status: "scheduled", scheduledFor: at.toISOString() } });

    expect(await publishDueCabinetChanges(tdb.db, subs, before)).toEqual({ published: 0, failed: 0 });
    expect((await getOrganization(tdb.db, "a"))!.displayName).toBe("Alpha");
    expect((await getOpenCabinetChange(tdb.db))!.status).toBe("scheduled");

    const after = () => new Date(at.getTime() + 1_000);
    expect(await publishDueCabinetChanges(tdb.db, subs, after)).toEqual({ published: 1, failed: 0 });
    expect((await getOrganization(tdb.db, "a"))!.displayName).toBe("Alpha Renamed");
    const [row] = await tdb.db.select().from(cabinetChanges).where(eq(cabinetChanges.id, change.id));
    expect(row).toMatchObject({ status: "published", publishedAt: after() });
    expect(await publishDueCabinetChanges(tdb.db, subs, after)).toEqual({ published: 0, failed: 0 });
  });

  it("a scheduled change that has become stale goes back to draft with the reason, and is not retried", async () => {
    await org("a", "Alpha", "ALPH");
    const at = new Date("2028-11-20T08:00:00Z");
    const change = await draft([{ op: "update", key: "a", expectedUpdatedAt: await stamp("a"), patch: { displayName: "Alpha Renamed" } }]);
    await scheduleCabinetChange(tdb.db, change.id, at, () => new Date(at.getTime() - 60_000));
    await new Promise((r) => setTimeout(r, 5));
    await patchOrganizationProfile(tdb.db, "a", { sortOrder: 99 }, subs);

    const after = () => new Date(at.getTime() + 1_000);
    expect(await publishDueCabinetChanges(tdb.db, subs, after)).toEqual({ published: 0, failed: 1 });
    expect(await getOpenCabinetChange(tdb.db)).toMatchObject({
      status: "draft",
      scheduledFor: null,
      error: "Not published at the scheduled time: Alpha was changed by someone else since this draft was started.",
    });
    expect(await publishDueCabinetChanges(tdb.db, subs, after)).toEqual({ published: 0, failed: 0 });
  });

  it("refuses to schedule in the past or with problems; saving a scheduled change returns it to draft", async () => {
    await org("a", "Alpha", "ALPH");
    const now = () => new Date("2028-11-01T00:00:00Z");
    const change = await draft([{ op: "succeed", key: "a", expectedUpdatedAt: await stamp("a"), successors: [], moves }]);
    expect(await scheduleCabinetChange(tdb.db, change.id, new Date("2028-12-01T00:00:00Z"), now)).toMatchObject({ result: "invalid" });
    await draft([{ op: "update", key: "a", expectedUpdatedAt: await stamp("a"), patch: { displayName: "A2" } }]);
    expect(await scheduleCabinetChange(tdb.db, change.id, new Date("2028-10-01T00:00:00Z"), now)).toEqual({ result: "past" });
    expect((await scheduleCabinetChange(tdb.db, change.id, new Date("2028-12-01T00:00:00Z"), now)).result).toBe("scheduled");
    expect(await draft([])).toMatchObject({ id: change.id, status: "draft", scheduledFor: null });
  });

  it("the operation schema", () => {
    const at = "2026-10-28T10:00:00.000Z";
    expect(cabinetOperationSchema.parse({ op: "update", key: "a", expectedUpdatedAt: at, patch: { abbreviation: " hlth " } })).toMatchObject({ patch: { abbreviation: "HLTH" } });
    // Deactivating is a hand-over or an abolish, never a patch.
    expect(cabinetOperationSchema.safeParse({ op: "update", key: "a", expectedUpdatedAt: at, patch: { isActive: false } }).success).toBe(false);
    expect(cabinetOperationSchema.safeParse({ op: "update", key: "a", expectedUpdatedAt: at, patch: { isActive: true } }).success).toBe(true);
    expect(cabinetOperationSchema.safeParse({ op: "succeed", key: "a", expectedUpdatedAt: at, successors: [{ key: "b", ref: "c" }], moves }).success).toBe(false);
    expect(cabinetOperationSchema.safeParse({ op: "succeed", key: "a", expectedUpdatedAt: at, successors: [{}], moves }).success).toBe(false);
    expect(cabinetOperationSchema.safeParse({ op: "create", ref: "x", displayName: "X", parentKey: "p" }).success).toBe(false);
    expect(cabinetOperationSchema.safeParse({ op: "delete", key: "a" }).success).toBe(false);
  });

  it("deactivateOrganization takes the caller's transaction", async () => {
    await org("a", "Alpha", "ALPH");
    await expect(
      tdb.db.transaction(async (tx) => {
        await deactivateOrganization(tdb.db, "a", subs, tx);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await getOrganization(tdb.db, "a"))!.isActive).toBe(true);
  });
});
