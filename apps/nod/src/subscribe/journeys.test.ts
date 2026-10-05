import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { subscribers, subscriptions } from "../db/schema";
import { subscriberInfoSchema, PreferencesError } from "./info";
import { checkToken, confirm, requestManageLink, subscribe, unsubscribe, update, type JourneyDeps } from "./journeys";
import { unsubscribeToken } from "./tokens";

const SECRET = "k".repeat(32);

describe("subscriber journeys", () => {
  let tdb: TestDatabase;
  let deps: JourneyDeps;
  const sent: { to: string; subject: string; text: string }[] = [];
  const tokenFrom = (i = sent.length - 1) => new URL(sent[i]!.text.match(/https:\S+/)![0]).searchParams.get("token")!;
  const info = (over: Record<string, unknown> = {}) =>
    subscriberInfoSchema.parse({ emailAddress: "pat@example.test", subscribedCategories: { ministries: ["health"] }, isAsItHappens: true, ...over });

  beforeAll(async () => {
    tdb = await createNodTestDb();
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name) VALUES ('ministries:health','ministries','health','Health'), ('ministries:agri','ministries','agri','Agriculture')`);
    deps = {
      db: tdb.db,
      pageUrl: "https://boxs.ca/site/subscribe/manage/",
      linkSecret: SECRET,
      distribution: { send: vi.fn(async (m) => { sent.push({ to: m.recipients[0].email, subject: m.subject, text: m.text }); return { batchId: "b" }; }) },
    };
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    sent.length = 0;
    await tdb.db.execute(sql`DELETE FROM subscriber_links; DELETE FROM subscribers;`);
  });

  it("subscribe → verify email → confirm activates with the chosen lists and timing", async () => {
    await subscribe(deps, info({ isDailyDigest: true }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("BC Gov News On Demand Email Verification");
    expect(await tdb.db.select().from(subscribers)).toHaveLength(0); // nothing until confirmed
    const result = await confirm(deps, tokenFrom());
    expect(result).toMatchObject({ emailAddress: "pat@example.test", subscribedCategories: { ministries: ["health"] }, isAsItHappens: true, isDailyDigest: true });
    const [s] = await tdb.db.select().from(subscribers);
    expect(s).toMatchObject({ status: "active", source: "self", asItHappens: true, digest: true });
  });

  it("normalises case and spaces", async () => {
    await subscribe(deps, info({ emailAddress: "  Pat@Example.TEST " }));
    await confirm(deps, tokenFrom());
    await subscribe(deps, info({ emailAddress: "PAT@example.test" }));
    expect(await tdb.db.select().from(subscribers)).toHaveLength(1);
    expect(sent[1]!.subject).toBe("BC Gov News On Demand Subscription Management");
  });

  it("an existing subscriber gets a manage email, not a second verification (anti-enumeration)", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    await subscribe(deps, info({ subscribedCategories: { ministries: ["agri"] } }));
    expect(sent.map((m) => m.subject)).toEqual(["BC Gov News On Demand Email Verification", "BC Gov News On Demand Subscription Management"]);
    const subs = await tdb.db.select().from(subscriptions);
    expect(subs.map((r) => r.listKey)).toEqual(["ministries:health"]); // unchanged until they act on the manage link
  });

  it("confirm twice: the second click is a manage view and re-applies nothing", async () => {
    await subscribe(deps, info());
    const token = tokenFrom();
    await confirm(deps, token);
    await tdb.db.update(subscribers).set({ digest: true, asItHappens: false });
    expect(await confirm(deps, token)).toMatchObject({ isAsItHappens: false, isDailyDigest: true });
  });

  it("expired link: confirm flags it, update refuses, check says false", async () => {
    await subscribe(deps, info());
    const token = tokenFrom();
    await tdb.db.execute(sql`UPDATE subscriber_links SET expires_at = now() - interval '1 minute'`);
    expect(await confirm(deps, token)).toMatchObject({ emailAddress: "pat@example.test", expiredLinkOrUnverifiedEmail: true });
    expect(await tdb.db.select().from(subscribers)).toHaveLength(0);
    expect(await checkToken(deps, token)).toBe(false);
    expect(await update(deps, token, info())).toBe("invalid");
  });

  it("unknown or email-shaped tokens are invalid everywhere (C60)", async () => {
    expect(await confirm(deps, "pat@example.test")).toBeNull();
    expect(await update(deps, "pat@example.test", info())).toBe("invalid");
    expect(await checkToken(deps, "nope")).toBe(false);
    expect(await unsubscribe(deps, "pat@example.test")).toBe(true);
  });

  it("update changes timing and lists through a manage link", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    await requestManageLink(deps, "pat@example.test");
    expect(await update(deps, tokenFrom(), info({ subscribedCategories: { ministries: ["agri"] }, isAsItHappens: false, isDailyDigest: true }))).toBe("ok");
    const [s] = await tdb.db.select().from(subscribers);
    expect(s).toMatchObject({ asItHappens: false, digest: true });
    expect((await tdb.db.select().from(subscriptions)).map((r) => r.listKey)).toEqual(["ministries:agri"]);
  });

  it("changing email verifies the new address before switching (C49)", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    await requestManageLink(deps, "pat@example.test");
    await update(deps, tokenFrom(), info({ emailAddress: "new@example.test" }));
    expect(sent.at(-1)!.to).toBe("new@example.test");
    expect((await tdb.db.select().from(subscribers))[0]!.email).toBe("pat@example.test"); // not yet
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    expect(s).toMatchObject({ email: "new@example.test", unsubscribeVersion: 2 });
  });

  it("moving to an address that's already subscribed unsubscribes the old record silently", async () => {
    for (const email of ["a@example.test", "b@example.test"]) { await subscribe(deps, info({ emailAddress: email })); await confirm(deps, tokenFrom()); }
    await requestManageLink(deps, "a@example.test");
    await update(deps, tokenFrom(), info({ emailAddress: "b@example.test" }));
    expect(await confirm(deps, tokenFrom())).toBeNull();
    const [a] = await tdb.db.select().from(subscribers).where(eq(subscribers.email, "a@example.test"));
    expect(a!.status).toBe("deleted");
  });

  it("unsubscribe by link or stable token is idempotent; an old-version token does nothing", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    expect(await unsubscribe(deps, unsubscribeToken(SECRET, s!.id, 0))).toBe(true);
    expect((await tdb.db.select().from(subscribers))[0]!.status).toBe("active");
    expect(await unsubscribe(deps, unsubscribeToken(SECRET, s!.id, 1))).toBe(true);
    expect(await unsubscribe(deps, unsubscribeToken(SECRET, s!.id, 1))).toBe(true);
    const [after] = await tdb.db.select().from(subscribers);
    expect(after).toMatchObject({ status: "deleted" });
    expect(after!.endedAt).not.toBeNull();
  });

  it("caps verification/manage emails at 3 per address per hour without changing the response", async () => {
    for (let i = 0; i < 5; i++) await subscribe(deps, info({ emailAddress: "flood@example.test" }));
    expect(sent.filter((m) => m.to === "flood@example.test")).toHaveLength(3);
  });

  it("refuses a subscription that can receive nothing", async () => {
    await expect(subscribe(deps, info({ subscribedCategories: { ministries: ["nope"] } }))).rejects.toBeInstanceOf(PreferencesError);
  });
});
