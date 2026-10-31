import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { createNrmsTestDb, createScheduledRelease, editor, sampleCreate } from "../../test/helpers";
import { publishDue } from "../publisher";
import { ReleaseRuleError, ReleaseStateError } from "./errors";
import { createRelease, saveCategories, saveSettings } from "./service";
import { loadView } from "./store";
import { approve, cancel, emailAgainAudience, requestEmailAgain, schedule, unpublish } from "./workflow";

const TZ = "America/Vancouver";
const deps = { timeZone: TZ };
const subs: SubscriberConfig[] = [{ name: "nod", url: "http://nod.invalid/events", secret: "s".repeat(40), types: ["*"] }];

/**
 * Owner decision 2026-10-31: republishing a release that already went out can also email it again
 * ("Corrected: " before the subject) to the people who already got it, per tick. Every republish
 * path: an edit to a live release (Email the correction, which republishes it), a failed correction
 * published again, and unpublish then Publish now or Schedule. Without a tick, nothing changes.
 */
describe("email it again", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE news_releases, outbox_events, outbox_deliveries, aggregate_sequences, release_log, release_publications CASCADE");
  });
  const db = () => tdb.db;
  const events = async () => (await tdb.pool.query("SELECT type, envelope FROM outbox_events ORDER BY created_at, sequence")).rows as { type: string; envelope: { data: Record<string, unknown> } }[];
  const logs = async (id: string) => (await tdb.pool.query("SELECT text, actor_name FROM release_log WHERE release_id = $1 ORDER BY id", [id])).rows as { text: string; actor_name: string }[];
  const row = async (id: string) =>
    (await tdb.pool.query("SELECT email_again, corrections_emailed FROM news_releases WHERE id = $1", [id])).rows[0] as { email_again: Record<string, unknown> | null; corrections_emailed: number };
  const version = async (id: string) => (await loadView(db(), id))!.version;
  /** A release with a media list, published (gone out). */
  const published = async (over = {}) => {
    const due = await createScheduledRelease(db(), { mediaListKeys: ["regional"], ...over });
    await publishDue({ db: db(), subscribers: subs });
    return due;
  };

  it("an edit to a live release: Email the correction republishes it with the request, then clears it; each is a new correction", async () => {
    const due = await published();
    const asked = await requestEmailAgain(db(), due.id, { version: await version(due.id), subscribers: true, mediaLists: false }, editor);
    expect(asked.status).toBe("publishing");
    expect((await row(due.id)).email_again).toMatchObject({ subscribers: true, mediaLists: false, actorId: editor.id, actorName: editor.name });
    expect((await logs(due.id)).at(-1)).toEqual({ text: "Asked to email it again to subscribers who got it", actor_name: editor.name });
    const pending = (await row(due.id)).email_again!;

    expect((await publishDue({ db: db(), subscribers: subs })).updated).toEqual([due.key]);
    const ev = (await events()).at(-1)!;
    expect(ev.type).toBe("release.updated");
    expect(ev.envelope.data.emailAgain).toEqual({ seq: 1, subscribers: true, mediaLists: false, requestedBy: editor.name, requestedAt: pending.at });
    expect(await row(due.id)).toEqual({ email_again: null, corrections_emailed: 1 });
    expect((await logs(due.id)).at(-1)).toEqual({ text: `Emailed it again with "Corrected:" to subscribers who got it, as ${editor.name} asked`, actor_name: "System" });

    await requestEmailAgain(db(), due.id, { version: await version(due.id), subscribers: true, mediaLists: true }, editor);
    await publishDue({ db: db(), subscribers: subs });
    expect((await events()).at(-1)!.envelope.data.emailAgain).toMatchObject({ seq: 2, subscribers: true, mediaLists: true });
    expect((await row(due.id)).corrections_emailed).toBe(2);
  });

  it("a plain correction, and unpublish then publish again, carry no request (nobody is emailed again)", async () => {
    const due = await published();
    await saveCategories(db(), due.id, { version: await version(due.id), leadMinistryKey: "health", ministries: ["health"], sectors: ["education"], themes: [], tags: [] }, editor);
    await publishDue({ db: db(), subscribers: subs });
    await unpublish(db(), due.id, await version(due.id), editor);
    await publishDue({ db: db(), subscribers: subs });
    await schedule(db(), due.id, { version: await version(due.id), publishAt: "now" }, editor, deps);
    await publishDue({ db: db(), subscribers: subs });
    const evs = await events();
    expect(evs.map((e) => e.type)).toEqual(["release.published", "release.updated", "release.unpublished", "release.published"]);
    for (const e of evs) expect(e.envelope.data).not.toHaveProperty("emailAgain");
    expect((await row(due.id)).corrections_emailed).toBe(0);
  });

  it("unpublish then Publish now or Schedule, ticked: release.published carries the request", async () => {
    const due = await published();
    await unpublish(db(), due.id, await version(due.id), editor);
    await publishDue({ db: db(), subscribers: subs });
    await schedule(db(), due.id, { version: await version(due.id), publishAt: "now", emailAgain: { subscribers: true, mediaLists: true } }, editor, deps);
    expect((await logs(due.id)).slice(-2).map((l) => l.text)).toEqual(["Scheduled for Immediate Release", "Asked to email it again to subscribers and media lists who got it"]);
    await publishDue({ db: db(), subscribers: subs });
    const ev = (await events()).at(-1)!;
    expect(ev.type).toBe("release.published");
    expect(ev.envelope.data.emailAgain).toMatchObject({ seq: 1, subscribers: true, mediaLists: true, requestedBy: editor.name });
  });

  it("a failed correction published again, ticked: release.updated carries it", async () => {
    const due = await published();
    await saveCategories(db(), due.id, { version: await version(due.id), leadMinistryKey: "health", ministries: ["health"], sectors: ["education"], themes: [], tags: [] }, editor);
    await tdb.db.execute(sql`UPDATE news_releases SET status = 'failed' WHERE id = ${due.id}`);
    await schedule(db(), due.id, { version: await version(due.id), publishAt: "now", emailAgain: { subscribers: false, mediaLists: true } }, editor, deps);
    await publishDue({ db: db(), subscribers: subs });
    expect((await events()).at(-1)!).toMatchObject({ type: "release.updated", envelope: { data: { emailAgain: { seq: 1, subscribers: false, mediaLists: true } } } });
  });

  it("a later choice replaces an earlier one; Cancel schedule and Unpublish drop it", async () => {
    const due = await published();
    await unpublish(db(), due.id, await version(due.id), editor);
    await publishDue({ db: db(), subscribers: subs });
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await schedule(db(), due.id, { version: await version(due.id), publishAt: later, emailAgain: { subscribers: true, mediaLists: false } }, editor, deps);
    expect((await row(due.id)).email_again).not.toBeNull();
    await cancel(db(), due.id, await version(due.id), editor);
    expect((await row(due.id)).email_again).toBeNull();
    await schedule(db(), due.id, { version: await version(due.id), publishAt: later, emailAgain: { subscribers: true, mediaLists: false } }, editor, deps);
    await schedule(db(), due.id, { version: (await cancel(db(), due.id, await version(due.id), editor)).version, publishAt: later }, editor, deps);
    expect((await row(due.id)).email_again).toBeNull();

    const live = await published();
    await requestEmailAgain(db(), live.id, { version: await version(live.id), subscribers: true, mediaLists: false }, editor);
    await unpublish(db(), live.id, await version(live.id), editor);
    expect((await row(live.id)).email_again).toBeNull();
  });

  it("only for a release that has gone out, only what it can be sent to, at least one tick, live for Email the correction", async () => {
    const fresh = await createRelease(db(), { ...sampleCreate, headline: "Never out" }, editor);
    const approved = await approve(db(), fresh.id, fresh.version, editor, deps);
    await expect(schedule(db(), fresh.id, { version: approved.version, publishAt: "now", emailAgain: { subscribers: true, mediaLists: false } }, editor, deps)).rejects.toEqual(
      new ReleaseRuleError(["Only a release that has gone out before can be emailed again."]),
    );
    // Unticked is the same as not asking.
    expect((await schedule(db(), fresh.id, { version: approved.version, publishAt: "now", emailAgain: { subscribers: false, mediaLists: false } }, editor, deps)).status).toBe("scheduled");

    const noMedia = await published({ mediaListKeys: [] });
    await expect(requestEmailAgain(db(), noMedia.id, { version: await version(noMedia.id), subscribers: false, mediaLists: true }, editor)).rejects.toEqual(
      new ReleaseRuleError(["This release doesn't go to any media distribution lists, so it can't be emailed to them again."]),
    );
    await expect(requestEmailAgain(db(), noMedia.id, { version: await version(noMedia.id), subscribers: false, mediaLists: false }, editor)).rejects.toEqual(
      new ReleaseRuleError(["Tick who to email it to again."]),
    );

    const adv = await published({ type: "advisory", ministries: [], leadMinistryKey: null, sectors: [] });
    await expect(requestEmailAgain(db(), adv.id, { version: await version(adv.id), subscribers: true, mediaLists: false }, editor)).rejects.toEqual(
      new ReleaseRuleError(["A media advisory is emailed again to media lists only."]),
    );
    expect((await requestEmailAgain(db(), adv.id, { version: await version(adv.id), subscribers: false, mediaLists: true }, editor)).status).toBe("publishing");

    const off = await published();
    await unpublish(db(), off.id, await version(off.id), editor);
    await publishDue({ db: db(), subscribers: subs });
    await expect(requestEmailAgain(db(), off.id, { version: await version(off.id), subscribers: true, mediaLists: false }, editor)).rejects.toEqual(
      new ReleaseStateError("Only a published release can be emailed again this way. Use Publish now or Schedule to publish it again."),
    );
  });

  it("a ticked audience it no longer goes to when it republishes: only what's still possible goes, and the history says so", async () => {
    const due = await published();
    await requestEmailAgain(db(), due.id, { version: await version(due.id), subscribers: false, mediaLists: true }, editor);
    // Settings refuses this once it's released; the publisher still never sends what it can't.
    await expect(
      saveSettings(db(), due.id, { version: await version(due.id), activityId: null, plannedPublishAt: null, toSubscribers: true, toMediaLists: false, mediaListKeys: [] }, editor, { timeZone: TZ, subscribers: [] }),
    ).rejects.toThrow();
    await tdb.db.execute(sql`UPDATE news_releases SET to_media_lists = false WHERE id = ${due.id}`);
    await publishDue({ db: db(), subscribers: subs });
    expect((await events()).at(-1)!.envelope.data).not.toHaveProperty("emailAgain");
    expect(await row(due.id)).toEqual({ email_again: null, corrections_emailed: 0 });
    expect((await logs(due.id)).at(-1)!.text).toBe("Not emailed again: it no longer goes to media lists");
  });

  it("emailAgainAudience: NoD's counts of who got it, per tick it can offer; unavailable kept apart; null for one never out", async () => {
    const due = await published();
    let asked: unknown = null;
    const counting = { timeZone: TZ, correctionAudience: async (q: unknown) => ((asked = q), { subscribers: 40, mediaContacts: 12, both: 3 }) };
    expect(await emailAgainAudience(db(), due.id, counting)).toEqual({ subscribers: { count: 40 }, mediaContacts: { count: 12 }, both: 3 });
    expect(asked).toEqual({ itemKey: due.key, listKeys: ["ministries:health", "sectors:health"], mediaListKeys: ["media-distribution-lists:regional"] });
    expect(await emailAgainAudience(db(), due.id, { timeZone: TZ, correctionAudience: async () => { throw new Error("down"); } })).toEqual({ subscribers: { count: null }, mediaContacts: { count: null }, both: null });
    expect(await emailAgainAudience(db(), due.id, deps)).toEqual({ subscribers: { count: null }, mediaContacts: { count: null }, both: null });

    const adv = await published({ type: "advisory", ministries: [], leadMinistryKey: null, sectors: [] });
    expect(await emailAgainAudience(db(), adv.id, counting)).toMatchObject({ subscribers: null, mediaContacts: { count: 12 } });
    const fresh = await createRelease(db(), { ...sampleCreate, headline: "Not out" }, editor);
    expect(await emailAgainAudience(db(), fresh.id, counting)).toBeNull();
  });
});
