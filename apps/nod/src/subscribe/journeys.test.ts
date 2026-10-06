import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { subscriberHistory, subscribers, subscriptions } from "../db/schema";
import { subscriberInfoSchema, PreferencesError } from "./info";
import { checkToken, confirm, requestManageLink, subscribe, unsubscribe, update, type JourneyDeps } from "./journeys";
import * as linksModule from "./links";
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
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(await update(deps, tokenFrom(), info({ subscribedCategories: { ministries: ["agri"] }, isAsItHappens: false, isDailyDigest: true }))).toBe("ok");
    const [s] = await tdb.db.select().from(subscribers);
    expect(s).toMatchObject({ asItHappens: false, digest: true });
    expect((await tdb.db.select().from(subscriptions)).map((r) => r.listKey)).toEqual(["ministries:agri"]);
  });

  it("changing email verifies the new address before switching (C49)", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    await requestManageLink(deps, "pat@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
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
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    await update(deps, tokenFrom(), info({ emailAddress: "b@example.test" }));
    expect(await confirm(deps, tokenFrom())).toBeNull();
    const [a] = await tdb.db.select().from(subscribers).where(eq(subscribers.email, "a@example.test"));
    expect(a!.status).toBe("deleted");
  });

  it("moving to an address held by a disabled row unsubscribes the mover and leaves the disabled row untouched (R-I3)", async () => {
    await subscribe(deps, info({ emailAddress: "a@example.test" }));
    await confirm(deps, tokenFrom());
    await tdb.db.execute(sql`INSERT INTO subscribers (email, manage_token, status, source) VALUES ('b@example.test', ${"y".repeat(43)}, 'disabled', 'admin')`);
    await requestManageLink(deps, "a@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    await update(deps, tokenFrom(), info({ emailAddress: "b@example.test" }));
    expect(await confirm(deps, tokenFrom())).toBeNull();
    const [a] = await tdb.db.select().from(subscribers).where(eq(subscribers.email, "a@example.test"));
    expect(a!.status).toBe("deleted");
    const [b] = await tdb.db.select().from(subscribers).where(eq(subscribers.email, "b@example.test"));
    expect(b).toMatchObject({ status: "disabled" }); // untouched
  });

  it("moving to an address whose old row is inactive deletes the dead row and completes the move", async () => {
    for (const email of ["a@example.test", "b@example.test"]) { await subscribe(deps, info({ emailAddress: email })); await confirm(deps, tokenFrom()); }
    const [bRow] = await tdb.db.select().from(subscribers).where(eq(subscribers.email, "b@example.test"));
    await unsubscribe(deps, unsubscribeToken(SECRET, bRow!.id, 1));
    await requestManageLink(deps, "a@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    await update(deps, tokenFrom(), info({ emailAddress: "b@example.test" }));
    const result = await confirm(deps, tokenFrom());
    expect(result).toMatchObject({ emailAddress: "b@example.test" });
    const rows = await tdb.db.select().from(subscribers);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "b@example.test", status: "active" });
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

  it("caps at 3 per hour even under 20 concurrent subscribes for the same address (I2)", async () => {
    await Promise.all(Array.from({ length: 20 }, () => subscribe(deps, info({ emailAddress: "par@example.test" }))));
    await new Promise((r) => setTimeout(r, 50)); // flush any pending (unexpected) async work
    expect(sent.filter((m) => m.to === "par@example.test")).toHaveLength(3);
  });

  it("refuses a subscription that can receive nothing", async () => {
    await expect(subscribe(deps, info({ subscribedCategories: { ministries: ["nope"] } }))).rejects.toBeInstanceOf(PreferencesError);
  });

  it("concurrent double confirm of the same link resolves without throwing and writes one confirmed history row", async () => {
    await subscribe(deps, info());
    const token = tokenFrom();
    const [a, b] = await Promise.all([confirm(deps, token), confirm(deps, token)]);
    for (const r of [a, b]) expect(r).toMatchObject({ emailAddress: "pat@example.test", isAsItHappens: true });
    expect(await tdb.db.select().from(subscribers)).toHaveLength(1);
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.action, "confirmed"));
    expect(history).toHaveLength(1);
  });

  it("two different verify links for the same address confirmed concurrently resolve without throwing and leave one subscriber", async () => {
    await subscribe(deps, info({ subscribedCategories: { ministries: ["health"] } }));
    const tokenA = tokenFrom();
    await subscribe(deps, info({ subscribedCategories: { ministries: ["agri"] } }));
    const tokenB = tokenFrom();
    const [a, b] = await Promise.all([confirm(deps, tokenA), confirm(deps, tokenB)]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(await tdb.db.select().from(subscribers)).toHaveLength(1);
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.action, "confirmed"));
    expect(history).toHaveLength(1);
  });

  it("confirming a verify link invalidates other unused verify links for the same address", async () => {
    await subscribe(deps, info({ subscribedCategories: { ministries: ["health"] } }));
    const tokenA = tokenFrom();
    await subscribe(deps, info({ subscribedCategories: { ministries: ["agri"] } }));
    const tokenB = tokenFrom();
    await confirm(deps, tokenB);
    expect(await confirm(deps, tokenA)).toBeNull();
    const subs = await tdb.db.select().from(subscriptions);
    expect(subs.map((r) => r.listKey)).toEqual(["ministries:agri"]);
  });

  it("confirming a change-email link for a now-inactive subscriber returns null and writes no history", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    await requestManageLink(deps, "pat@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    await update(deps, tokenFrom(), info({ emailAddress: "new@example.test" }));
    const changeToken = tokenFrom();
    const [s] = await tdb.db.select().from(subscribers);
    await unsubscribe(deps, unsubscribeToken(SECRET, s!.id, 1));
    expect(await confirm(deps, changeToken)).toBeNull();
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.action, "email-changed"));
    expect(history).toHaveLength(0);
  });

  it("a change-email link does not authorise update, unsubscribe or checkToken before confirmation (C1)", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    await requestManageLink(deps, "pat@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    await update(deps, tokenFrom(), info({ emailAddress: "new@example.test" }));
    const changeToken = tokenFrom();
    expect(await checkToken(deps, changeToken)).toBe(false);
    expect(await update(deps, changeToken, info())).toBe("invalid");
    expect(await unsubscribe(deps, changeToken)).toBe(true); // C50: always true
    const [s] = await tdb.db.select().from(subscribers);
    expect(s).toMatchObject({ status: "active", email: "pat@example.test" }); // unaffected
  });

  it("a confirmed change-email link becomes a session: checkToken, update and unsubscribe act on it (C1)", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    await requestManageLink(deps, "pat@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    await update(deps, tokenFrom(), info({ emailAddress: "new@example.test" }));
    const changeToken = tokenFrom();
    expect(await checkToken(deps, changeToken)).toBe(false); // before confirmation
    expect(await confirm(deps, changeToken)).toMatchObject({ emailAddress: "new@example.test" });
    expect(await checkToken(deps, changeToken)).toBe(true); // after confirmation

    expect(await update(deps, changeToken, info({ emailAddress: "new@example.test", subscribedCategories: { ministries: ["agri"] } }))).toBe("ok");
    expect((await tdb.db.select().from(subscriptions)).map((r) => r.listKey)).toEqual(["ministries:agri"]);

    expect(await unsubscribe(deps, changeToken)).toBe(true);
    const [after] = await tdb.db.select().from(subscribers);
    expect(after).toMatchObject({ status: "deleted" });
  });

  it("writes email-change-requested only when the change-email link was actually issued (not rate-limited)", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    await requestManageLink(deps, "pat@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const manageToken = tokenFrom();
    for (let i = 0; i < 3; i++) await subscribe(deps, info({ emailAddress: "busy@example.test" }));
    expect(await update(deps, manageToken, info({ emailAddress: "busy@example.test" }))).toBe("ok");
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.action, "email-change-requested"));
    expect(history).toHaveLength(0);
  });

  it("reactivating an existing non-self row through subscribe/confirm resets source to self", async () => {
    await tdb.db.execute(sql`INSERT INTO subscribers (email, manage_token, status, source) VALUES ('legacy@example.test', ${"z".repeat(43)}, 'disabled', 'admin')`);
    await subscribe(deps, info({ emailAddress: "legacy@example.test" }));
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers).where(eq(subscribers.email, "legacy@example.test"));
    expect(s).toMatchObject({ status: "active", source: "self" });
  });

  it("requestManageLink for an unknown address resolves and sends nothing", async () => {
    await requestManageLink(deps, "nobody@example.test");
    await new Promise((r) => setTimeout(r, 50)); // flush any pending (unexpected) async work
    expect(sent).toHaveLength(0);
  });

  it("requestManageLink logs no address or query params when issuing the link fails", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const createLinkSpy = vi
      .spyOn(linksModule, "createLink")
      .mockRejectedValueOnce(new Error('Failed query: insert into "subscriber_links" (...) values (...)\nparams: pat@example.test,abcDEF123xyz'));
    try {
      await requestManageLink(deps, "pat@example.test");
      await vi.waitFor(() => expect(errSpy).toHaveBeenCalled());
      const logged = errSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).not.toContain("pat@example.test");
      expect(logged).not.toContain("params:");
    } finally {
      createLinkSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("unsubscribes via a legacy Phase 2 manage_token", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    const legacyToken = "a".repeat(43);
    await tdb.db.update(subscribers).set({ manageToken: legacyToken }).where(eq(subscribers.id, s!.id));
    expect(await unsubscribe(deps, legacyToken)).toBe(true);
    const [after] = await tdb.db.select().from(subscribers);
    expect(after).toMatchObject({ status: "deleted" });
  });

  it("confirm of a manage link for a deleted subscriber returns null", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    await requestManageLink(deps, "pat@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const manageToken = tokenFrom();
    const [s] = await tdb.db.select().from(subscribers);
    await unsubscribe(deps, unsubscribeToken(SECRET, s!.id, 1));
    expect(await confirm(deps, manageToken)).toBeNull();
  });

  it("writes 'unsubscribed' history exactly once across repeated unsubscribes", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    await unsubscribe(deps, unsubscribeToken(SECRET, s!.id, 1));
    await unsubscribe(deps, unsubscribeToken(SECRET, s!.id, 1));
    await unsubscribe(deps, unsubscribeToken(SECRET, s!.id, 1));
    const rows = await tdb.db.select().from(subscriberHistory).where(and(eq(subscriberHistory.subscriberId, s!.id), eq(subscriberHistory.action, "unsubscribed")));
    expect(rows).toHaveLength(1);
  });
});
