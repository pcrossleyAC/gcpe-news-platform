import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { subscriptions } from "./db/schema";
import { addSubscriber, SubscriberExistsError } from "./subscribers";
import { addSubscriberSchema } from "./http/routes";

describe("subscribers", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("adds a subscriber with lists 'all' as a single '*' subscription", async () => {
    const { id } = await addSubscriber(tdb.db, { email: "alex.all@example.com", lists: "all" });
    const rows = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, id));
    expect(rows).toEqual([expect.objectContaining({ subscriberId: id, listKey: "*" })]);
  });

  it("stores list keys lowercased", async () => {
    const { id } = await addSubscriber(tdb.db, { email: "sam.health@example.com", lists: ["ministries:Health"] });
    const rows = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, id));
    expect(rows).toEqual([expect.objectContaining({ subscriberId: id, listKey: "ministries:health" })]);
  });

  it("rejects the same email in other casing with SubscriberExistsError", async () => {
    await addSubscriber(tdb.db, { email: "casing@example.com", lists: "all" });
    await expect(addSubscriber(tdb.db, { email: "Casing@Example.com", lists: "all" })).rejects.toThrow(SubscriberExistsError);
  });

  it("rejects an invalid list key (not '<kind>:<key>' with a known kind) via the routes' schema", () => {
    expect(() => addSubscriberSchema.parse({ email: "bad-list@example.com", lists: ["bogus"] })).toThrow();
    expect(addSubscriberSchema.safeParse({ email: "bad-list@example.com", lists: ["bogus"] }).success).toBe(false);
    expect(addSubscriberSchema.safeParse({ email: "ok-list@example.com", lists: ["ministries:Health"] }).success).toBe(true);
  });
});
