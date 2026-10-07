import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Db, TestDatabase, Tx } from "@gcpe/db-kit";
import { countBouncedEmails } from "../bounces";
import { deliveries, subscriberHistory, subscribers, subscriptions } from "../db/schema";
import { createNodTestDb, waitForLockWaiter } from "../../test/helpers";
import { lockAddress } from "../locks";
import { changeEmail, setStatus, updatePreferences } from "../staff-subscribers/actions";
import { addMediaMember, listMediaMembers, OptedOutError } from "../media-members";
import { infoFor, subscriberInfoSchema, PreferencesError } from "./info";
import { checkToken, confirm, requestManageLink, subscribe, unsubscribe, update, type JourneyDeps } from "./journeys";
import * as linksModule from "./links";
import { unsubscribeToken } from "./tokens";

const SECRET = "k".repeat(32);

/** Opens a transaction that runs `first`, then holds everything it took until `release()`,
 * then runs `then` and commits — so a test can queue a call behind its locks and change the
 * row underneath it. */
function heldTransaction(db: Db, first: (tx: Tx) => Promise<void>, then: (tx: Tx) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held!: () => void;
  const ready = new Promise<void>((r) => (held = r));
  const done = db.transaction(async (tx) => {
    await first(tx);
    held();
    await gate;
    await then(tx);
  });
  return { ready, release, done };
}

describe("subscriber journeys", () => {
  let tdb: TestDatabase;
  let deps: JourneyDeps;
  const sent: { to: string; subject: string; text: string }[] = [];
  const tokenFrom = (i = sent.length - 1) => new URL(sent[i]!.text.match(/https:\S+/)![0]).searchParams.get("token")!;
  const info = (over: Record<string, unknown> = {}) =>
    subscriberInfoSchema.parse({ emailAddress: "pat@example.test", subscribedCategories: { ministries: ["health"] }, isAsItHappens: true, ...over });

  beforeAll(async () => {
    tdb = await createNodTestDb();
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name) VALUES
      ('ministries:health','ministries','health','Health'),
      ('ministries:agri','ministries','agri','Agriculture'),
      ('media-distribution-lists:budget','media-distribution-lists','budget','Budget')`);
    deps = {
      db: tdb.db,
      pageUrl: "https://boxs.ca/site/subscribe/manage/",
      linkSecret: SECRET,
      render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null },
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

  // I4: pinned per the brief -- change-email (4a) moves media memberships with the subscriber
  // row as today; it's one row, so there's nothing media-specific to change, but it's untested.
  it("change-email moves media memberships with the subscriber row (4a carry-forward pin)", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    await addMediaMember(tdb.db, "budget", { email: "pat@example.test", source: "manual-media" }, "staff:jamie");

    await requestManageLink(deps, "pat@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    await update(deps, tokenFrom(), info({ emailAddress: "new@example.test" }));
    await confirm(deps, tokenFrom());

    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, s!.id));
    expect(after).toMatchObject({ email: "new@example.test" });
    const subs = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, s!.id));
    expect(subs.map((r) => r.listKey)).toContain("media-distribution-lists:budget");
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
    await tdb.db.execute(sql`INSERT INTO subscribers (email, status, source) VALUES ('b@example.test', 'disabled', 'admin')`);
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

  it("unsubscribe by link or stable token is idempotent; a token for a version never issued does nothing", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    expect(await unsubscribe(deps, unsubscribeToken(SECRET, s!.id, 0))).toBe(true);
    expect(await unsubscribe(deps, unsubscribeToken(SECRET, s!.id, 2))).toBe(true);
    expect((await tdb.db.select().from(subscribers))[0]!.status).toBe("active");
    expect(await unsubscribe(deps, unsubscribeToken(SECRET, s!.id, 1))).toBe(true);
    expect(await unsubscribe(deps, unsubscribeToken(SECRET, s!.id, 1))).toBe(true);
    const [after] = await tdb.db.select().from(subscribers);
    expect(after).toMatchObject({ status: "deleted" });
    expect(after!.endedAt).not.toBeNull();
  });

  // "disabled" defined: a bounce- or staff-disabled subscriber reactivates themselves through
  // public subscribe -> confirm, same as a deleted or pending one -- the verification email
  // reaching them proves the mailbox works again (see journeys.ts's applyEmailChange comment).
  it("a disabled subscriber subscribes again: verify then confirm reactivates them", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    await tdb.db.update(subscribers).set({ status: "disabled" }).where(eq(subscribers.id, s!.id));

    await subscribe(deps, info()); // disabled, not active -- gets a fresh verify link, not a manage one
    expect(sent.at(-1)!.subject).toBe("BC Gov News On Demand Email Verification");
    expect((await tdb.db.select().from(subscribers).where(eq(subscribers.id, s!.id)))[0]!.status).toBe("disabled"); // not yet

    const result = await confirm(deps, tokenFrom());
    expect(result).toMatchObject({ emailAddress: "pat@example.test", isAsItHappens: true });
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, s!.id));
    expect(after).toMatchObject({ status: "active" });
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
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.action, "subscribed"));
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
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.action, "subscribed"));
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
    await tdb.db.execute(sql`INSERT INTO subscribers (email, status, source) VALUES ('legacy@example.test', 'disabled', 'admin')`);
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

  it("unsubscribe is an opt-out from media lists too (global constraints)", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    await addMediaMember(tdb.db, "budget", { email: "pat@example.test", source: "manual-media" }, "staff:jamie");

    await unsubscribe(deps, unsubscribeToken(SECRET, s!.id, 1));

    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, s!.id));
    expect(after).toMatchObject({ status: "deleted" });
    const subs = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, s!.id));
    expect(subs.map((r) => r.listKey)).toEqual(["ministries:health"]); // only the media subscription is removed
    const optedOut = await tdb.db
      .select()
      .from(subscriberHistory)
      .where(and(eq(subscriberHistory.subscriberId, s!.id), eq(subscriberHistory.action, "media-list-opted-out")));
    expect(optedOut).toMatchObject([{ detail: "media-distribution-lists:budget" }]);
    expect(await listMediaMembers(tdb.db, "budget")).toEqual([]);

    const err = await addMediaMember(tdb.db, "budget", { email: "pat@example.test", source: "manual-media" }, "staff:jamie").catch((e) => e);
    expect(err).toBeInstanceOf(OptedOutError);
    const reinstated = await addMediaMember(tdb.db, "budget", { email: "pat@example.test", source: "manual-media", confirmOptOut: true }, "staff:jamie");
    expect(reinstated.subscriberId).toBe(s!.id);
    expect(await listMediaMembers(tdb.db, "budget")).toMatchObject([{ subscriberId: s!.id }]);
  });

  it("update() with new public prefs keeps the media subscription", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    await addMediaMember(tdb.db, "budget", { email: "pat@example.test", source: "manual-media" }, "staff:jamie");

    await requestManageLink(deps, "pat@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(await update(deps, tokenFrom(), info({ subscribedCategories: { ministries: ["agri"] } }))).toBe("ok");

    const subs = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, s!.id));
    expect(subs.map((r) => r.listKey).sort()).toEqual(["media-distribution-lists:budget", "ministries:agri"]);
  });

  it("infoFor omits the media key", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    await addMediaMember(tdb.db, "budget", { email: "pat@example.test", source: "manual-media" }, "staff:jamie");

    const view = await infoFor(tdb.db, s!.id);
    expect(view.subscribedCategories).not.toHaveProperty("media-distribution-lists");
    expect(view.subscribedCategories).toEqual({ ministries: ["health"] });
  });

  it("a first confirmation writes 'subscribed'; confirming again from disabled or deleted writes 'resubscribed'", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    await tdb.db.update(subscribers).set({ status: "disabled" }).where(eq(subscribers.id, s!.id));
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const actions = (await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, s!.id))).map((h) => h.action).sort();
    expect(actions).toEqual(["resubscribed", "subscribed"]);
  });

  it("re-confirming from disabled zeroes a previously tripped bounce count; the first confirm leaves the window null", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [s0] = await tdb.db.select().from(subscribers);
    expect(s0!.bounceWindowFrom).toBeNull();
    for (let i = 0; i < 10; i++) {
      await tdb.db.insert(deliveries).values({
        subscriberId: s0!.id,
        itemKey: `disabled-window-${i}`,
        mode: "as_it_happens",
        attemptedAt: sql`now() - interval '1 hour'`,
        distributionBatchId: randomUUID(),
        hardBouncedAt: sql`now() - interval '1 hour'`,
      });
    }
    expect(await countBouncedEmails(tdb.db, s0!.id)).toBe(10);
    await tdb.db.update(subscribers).set({ status: "disabled" }).where(eq(subscribers.id, s0!.id));
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, s0!.id));
    expect(after!.status).toBe("active");
    expect(await countBouncedEmails(tdb.db, s0!.id)).toBe(0);
  });

  it("unsubscribing then resubscribing at the same address writes 'resubscribed' and restarts the bounce count", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    for (let i = 0; i < 10; i++) {
      await tdb.db.insert(deliveries).values({
        subscriberId: s!.id,
        itemKey: `deleted-window-${i}`,
        mode: "as_it_happens",
        attemptedAt: sql`now() - interval '1 hour'`,
        distributionBatchId: randomUUID(),
        hardBouncedAt: sql`now() - interval '1 hour'`,
      });
    }
    expect(await countBouncedEmails(tdb.db, s!.id)).toBe(10);
    await unsubscribe(deps, unsubscribeToken(SECRET, s!.id, 1));
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, s!.id));
    expect(after!.status).toBe("active");
    expect(await countBouncedEmails(tdb.db, s!.id)).toBe(0);
    const actions = (await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, s!.id))).map((h) => h.action);
    expect(actions).toContain("resubscribed");
  });

  it("a verify link confirmed while the address is already active writes 'subscribed', not 'resubscribed'", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    const { token } = await linksModule.createLink(tdb.db, {
      purpose: "verify",
      email: "pat@example.test",
      subscriberId: s!.id,
      pending: { allNews: false, listKeys: ["ministries:health"], asItHappens: true, digest: false },
    });
    await confirm(deps, token);
    const actions = (await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, s!.id))).map((h) => h.action);
    expect(actions).toEqual(["subscribed", "subscribed"]);
  });

  it("a move over a dead row keeps that row's history on the mover, with a record-merged line", async () => {
    for (const email of ["a@example.test", "b@example.test"]) { await subscribe(deps, info({ emailAddress: email })); await confirm(deps, tokenFrom()); }
    const [bRow] = await tdb.db.select().from(subscribers).where(eq(subscribers.email, "b@example.test"));
    await unsubscribe(deps, unsubscribeToken(SECRET, bRow!.id, 1));
    await requestManageLink(deps, "a@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    await update(deps, tokenFrom(), info({ emailAddress: "b@example.test" }));
    await confirm(deps, tokenFrom());
    const [mover] = await tdb.db.select().from(subscribers);
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, mover!.id));
    expect(history.map((h) => h.action)).toEqual(expect.arrayContaining(["unsubscribed", "record-merged", "email-changed"]));
    expect(history.find((h) => h.action === "record-merged")!.detail).toBe("deleted");
  });

  it("a concurrent disable during a move over a dead row leaves the dead row and its history in place", async () => {
    for (const email of ["a@example.test", "b@example.test"]) { await subscribe(deps, info({ emailAddress: email })); await confirm(deps, tokenFrom()); }
    const [bRow] = await tdb.db.select().from(subscribers).where(eq(subscribers.email, "b@example.test"));
    const [aRow] = await tdb.db.select().from(subscribers).where(eq(subscribers.email, "a@example.test"));
    await unsubscribe(deps, unsubscribeToken(SECRET, bRow!.id, 1));
    await requestManageLink(deps, "a@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    await update(deps, tokenFrom(), info({ emailAddress: "b@example.test" }));
    const changeToken = tokenFrom();

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const disableTx = tdb.db.transaction(async (tx) => {
      await lockAddress(tx, "a@example.test");
      await tx.update(subscribers).set({ status: "disabled" }).where(eq(subscribers.id, aRow!.id));
      locked();
      await gate;
    });
    await lockedP;
    const confirmed = confirm(deps, changeToken);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await disableTx;
    expect(await confirmed).toBeNull();

    const [mover] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, aRow!.id));
    expect(mover).toMatchObject({ status: "disabled", email: "a@example.test" });
    const deadRows = await tdb.db.select().from(subscribers).where(eq(subscribers.email, "b@example.test"));
    expect(deadRows).toHaveLength(1);
    expect(deadRows[0]).toMatchObject({ status: "deleted" });
    const history = (await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, aRow!.id))).map((h) => h.action);
    expect(history).not.toContain("record-merged");
    expect(history).not.toContain("email-changed");
  });

  it("after a completed move, the subscriber's other links stop working; the change-email link stays a session", async () => {
    await subscribe(deps, info({ emailAddress: "old@example.test" }));
    const verifyToken = tokenFrom();
    await confirm(deps, verifyToken);
    await requestManageLink(deps, "old@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const manageToken = tokenFrom();
    await update(deps, manageToken, info({ emailAddress: "new@example.test" }));
    const changeToken = tokenFrom();
    await confirm(deps, changeToken);
    expect(await checkToken(deps, manageToken)).toBe(false);
    expect(await checkToken(deps, verifyToken)).toBe(false);
    expect(await update(deps, manageToken, info({ emailAddress: "new@example.test" }))).toBe("invalid");
    expect(await checkToken(deps, changeToken)).toBe(true);
  });

  it("a superseded verify link is dead everywhere: confirm null, checkToken false", async () => {
    await subscribe(deps, info());
    const first = tokenFrom();
    await subscribe(deps, info());
    const second = tokenFrom();
    await confirm(deps, first);
    expect(await confirm(deps, second)).toBeNull();
    expect(await checkToken(deps, second)).toBe(false);
    expect(await checkToken(deps, first)).toBe(true);
  });
  it("an unsubscribe link from an email sent before a staff change of address still unsubscribes", async () => {
    await subscribe(deps, info({ emailAddress: "old@example.test" }));
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    const earlier = unsubscribeToken(SECRET, s!.id, s!.unsubscribeVersion);
    await changeEmail(tdb.db, s!.id, "moved@example.test", "Jamie");
    expect(await unsubscribe(deps, earlier)).toBe(true);
    const [after] = await tdb.db.select().from(subscribers);
    expect(after).toMatchObject({ email: "moved@example.test", status: "deleted", unsubscribeVersion: 2 });
  });

  it("an unsubscribe link from before a public change of address still unsubscribes", async () => {
    await subscribe(deps, info({ emailAddress: "old@example.test" }));
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    const earlier = unsubscribeToken(SECRET, s!.id, s!.unsubscribeVersion);
    await requestManageLink(deps, "old@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    await update(deps, tokenFrom(), info({ emailAddress: "moved@example.test" }));
    await confirm(deps, tokenFrom());
    expect(await unsubscribe(deps, earlier)).toBe(true);
    expect((await tdb.db.select().from(subscribers))[0]).toMatchObject({ email: "moved@example.test", status: "deleted" });
  });

  it("an earlier-version unsubscribe token authorises nothing except unsubscribe", async () => {
    await subscribe(deps, info({ emailAddress: "old@example.test" }));
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    const earlier = unsubscribeToken(SECRET, s!.id, s!.unsubscribeVersion);
    await changeEmail(tdb.db, s!.id, "moved@example.test", "Jamie");
    expect(await update(deps, earlier, info({ emailAddress: "moved@example.test", isDailyDigest: true }))).toBe("invalid");
    expect(await checkToken(deps, earlier)).toBe(false);
    expect(await confirm(deps, earlier)).toBeNull();
    expect((await tdb.db.select().from(subscribers))[0]).toMatchObject({ status: "active", digest: false });
  });

  it("an unsubscribe still ends the subscriber when their address moves while it waits for the lock", async () => {
    await subscribe(deps, info({ emailAddress: "old@example.test" }));
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    const move = heldTransaction(
      tdb.db,
      (tx) => lockAddress(tx, "old@example.test"),
      async (tx) => {
        await tx.update(subscribers).set({ email: "new@example.test", unsubscribeVersion: sql`${subscribers.unsubscribeVersion} + 1` }).where(eq(subscribers.id, s!.id));
      },
    );
    await move.ready;
    const unsubscribed = unsubscribe(deps, unsubscribeToken(SECRET, s!.id, 1));
    await waitForLockWaiter(tdb.db);
    move.release();
    await move.done;
    expect(await unsubscribed).toBe(true);
    const [after] = await tdb.db.select().from(subscribers);
    expect(after).toMatchObject({ email: "new@example.test", status: "deleted" });
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, s!.id));
    expect(history.filter((h) => h.action === "unsubscribed")).toHaveLength(1);
  });

  it("a change-email link refused while the subscriber is disabled still works once they're active again", async () => {
    await subscribe(deps, info({ emailAddress: "old@example.test" }));
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    await requestManageLink(deps, "old@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    await update(deps, tokenFrom(), info({ emailAddress: "new@example.test" }));
    const changeToken = tokenFrom();
    await setStatus(tdb.db, s!.id, "disabled", "Jamie");
    expect(await confirm(deps, changeToken)).toBeNull();
    await setStatus(tdb.db, s!.id, "active", "Jamie");
    expect(await confirm(deps, changeToken)).toMatchObject({ emailAddress: "new@example.test" });
    expect((await tdb.db.select().from(subscribers))[0]).toMatchObject({ email: "new@example.test", status: "active" });
  });

  it("a public preferences update and a staff one at the same time both apply, one after the other", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    await requestManageLink(deps, "pat@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const manage = tokenFrom();
    for (let i = 0; i < 10; i++) {
      const results = await Promise.allSettled([
        update(deps, manage, info({ subscribedCategories: { ministries: ["health", "agri"] } })),
        updatePreferences(tdb.db, s!.id, { asItHappens: true, digest: false, allNews: false, listKeys: ["ministries:agri", "ministries:health"] }, "Jamie"),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    }
    const subs = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, s!.id));
    expect(subs.map((r) => r.listKey).sort()).toEqual(["ministries:agri", "ministries:health"]);
  });

  it("a public preferences update queued behind a staff delete answers invalid and changes nothing", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    await requestManageLink(deps, "pat@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const manage = tokenFrom();
    const staffDelete = heldTransaction(
      tdb.db,
      async (tx) => {
        await lockAddress(tx, "pat@example.test");
        await tx.select().from(subscribers).where(eq(subscribers.id, s!.id)).for("update");
      },
      async (tx) => {
        await tx.update(subscribers).set({ status: "deleted", endedAt: sql`now()` }).where(eq(subscribers.id, s!.id));
      },
    );
    await staffDelete.ready;
    const updated = update(deps, manage, info({ subscribedCategories: { ministries: ["agri"] }, isDailyDigest: true }));
    await waitForLockWaiter(tdb.db);
    staffDelete.release();
    await staffDelete.done;
    expect(await updated).toBe("invalid");
    const [after] = await tdb.db.select().from(subscribers);
    expect(after).toMatchObject({ status: "deleted", digest: false });
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, s!.id));
    expect(history.map((h) => h.action)).not.toContain("preferences-updated");
  });
});
