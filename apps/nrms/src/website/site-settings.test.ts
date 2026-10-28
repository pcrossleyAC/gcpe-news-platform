import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { TestDatabase } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import type { SiteSettings } from "@gcpe/site-settings";
import { bcSettings } from "../../../../packages/site-settings/src/fixtures";
import type { Actor } from "../releases/store";
import { createNrmsTestDb, editor } from "../../test/helpers";
import {
  discardDraft,
  getRevision,
  getSettingsState,
  listHistory,
  publishSettings,
  rebaseDraft,
  restoreRevision,
  saveDraft,
} from "./site-settings";

/**
 * Ports Gov.News.Settings.Tests/BlobSiteSettingsStoreTests.cs (admin-screens branch) to NRMS's
 * revisions/drafts tables: the base revision replaces the blob ETag as the concurrency token.
 */

const subs: SubscriberConfig[] = [];
const defaults: SiteSettings = bcSettings();
const jane: Actor = { id: "00000000-0000-4000-8000-00000000a001", name: "Jane Editor" };
const sam: Actor = { id: "00000000-0000-4000-8000-00000000a002", name: "Sam Editor" };
const andre: Actor = { id: "00000000-0000-4000-8000-00000000a003", name: "André Tremblay" };

const banner = (message: string) => ({ ...defaults.banner, message });

describe("website/site-settings", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query(
      "TRUNCATE site_settings_revisions, site_settings_drafts, site_log, outbox_events, outbox_deliveries, aggregate_sequences CASCADE",
    );
  });

  const publishedEvents = async () => {
    const r = await tdb.pool.query("SELECT aggregate_id, envelope->'data' AS data FROM outbox_events WHERE type = 'site.settings.published' ORDER BY sequence");
    return r.rows as { aggregate_id: string; data: { revision: number; publishedAt: string; document: SiteSettings } }[];
  };
  const revisionCount = async () => (await tdb.pool.query("SELECT count(*)::int AS n FROM site_settings_revisions")).rows[0].n as number;

  /** Publishes `message` as the banner from whatever is live now. */
  const publishBanner = async (actor: Actor, message: string, note?: string) => {
    const live = (await getSettingsState(tdb.db, actor, defaults)).live;
    return publishSettings(tdb.db, actor, defaults, subs, { baseRevision: live?.revision ?? null, section: "banner", value: banner(message), note });
  };

  it("with nothing stored, the state is the defaults with no live revision, draft or errors", async () => {
    const state = await getSettingsState(tdb.db, jane, defaults);
    expect(state).toEqual({ live: null, document: defaults, draft: null, baseRevision: null, errors: [] });
  });

  it("first publish becomes revision 1, by the actor, clears the draft, writes history, the log and one event", async () => {
    await saveDraft(tdb.db, jane, defaults, { baseRevision: null, section: "banner", value: banner("First") });
    const drafted = await getSettingsState(tdb.db, jane, defaults);
    expect(drafted.draft).toMatchObject({ baseRevision: null });
    expect(drafted.document.banner.message).toBe("First");

    const result = await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: null, section: "banner", value: banner("First"), note: "  Launch  " });
    expect(result).toEqual({ result: "published", revision: 1 });

    const state = await getSettingsState(tdb.db, jane, defaults);
    expect(state.live).toMatchObject({ revision: 1, publishedBy: "Jane Editor", note: "Launch" });
    expect(state.draft).toBeNull();
    expect(state.baseRevision).toBe(1);
    expect(state.document.banner.message).toBe("First");

    const history = await listHistory(tdb.db);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ revision: 1, note: "Launch", publishedBy: "Jane Editor" });

    const events = await publishedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.aggregate_id).toBe("site:settings");
    expect(events[0]!.data.revision).toBe(1);
    expect(events[0]!.data.publishedAt).toBe(state.live!.publishedAt);
    expect(events[0]!.data.document).toEqual(state.document);

    const log = await tdb.pool.query("SELECT actor_name, area, text FROM site_log");
    expect(log.rows).toEqual([{ actor_name: "Jane Editor", area: "settings", text: "Published revision 1: Launch" }]);
  });

  it("a blank note is stored as null and the log line has no note", async () => {
    await publishBanner(jane, "First", "   ");
    expect((await listHistory(tdb.db))[0]!.note).toBeNull();
    const log = await tdb.pool.query("SELECT text FROM site_log");
    expect(log.rows).toEqual([{ text: "Published revision 1" }]);
  });

  it("an editor publishing from a stale base gets a conflict carrying the other editor's live info, and keeps their draft", async () => {
    await publishBanner(editor, "Original");
    const r2 = await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 1, section: "banner", value: banner("Jane's wording") });
    const bob = await publishSettings(tdb.db, sam, defaults, subs, { baseRevision: 1, section: "banner", value: banner("Sam's wording") });

    expect(r2).toEqual({ result: "published", revision: 2 });
    expect(bob).toMatchObject({ result: "conflict", live: { revision: 2, publishedBy: "Jane Editor" }, differing: ["banner"] });
    expect((await listHistory(tdb.db)).map((h) => h.revision)).toEqual([2, 1]);

    const samState = await getSettingsState(tdb.db, sam, defaults);
    expect(samState.draft).toMatchObject({ baseRevision: 1 });
    expect(samState.document.banner.message).toBe("Sam's wording");
    expect(samState.live?.revision).toBe(2);
    expect((await getSettingsState(tdb.db, jane, defaults)).document.banner.message).toBe("Jane's wording");
  });

  it("two first publishes cannot both succeed", async () => {
    const a = await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: null, section: "banner", value: banner("A") });
    const b = await publishSettings(tdb.db, sam, defaults, subs, { baseRevision: null, section: "banner", value: banner("B") });
    expect(a).toEqual({ result: "published", revision: 1 });
    expect(b).toMatchObject({ result: "conflict", live: { revision: 1 } });
  });

  it("8 simultaneous publishes from the same base let exactly one through", async () => {
    await publishBanner(editor, "Original");
    const editors: Actor[] = Array.from({ length: 8 }, (_, i) => ({ id: `00000000-0000-4000-8000-0000000000b${i}`, name: `Editor ${i}` }));

    const results = await Promise.all(
      editors.map((a, i) => publishSettings(tdb.db, a, defaults, subs, { baseRevision: 1, section: "banner", value: banner(`Editor ${i}`) })),
    );

    const winners = results.filter((r) => r.result === "published");
    expect(winners).toEqual([{ result: "published", revision: 2 }]);
    expect(results.filter((r) => r.result === "conflict")).toHaveLength(7);

    const history = await listHistory(tdb.db);
    expect(history.map((h) => h.revision)).toEqual([2, 1]);
    const live = await getSettingsState(tdb.db, editor, defaults);
    expect(live.document.banner.message).toBe(history[0]!.publishedBy);
    expect(await publishedEvents()).toHaveLength(2);
  });

  it("drafts are per editor; another editor's publish leaves mine alone", async () => {
    await publishBanner(editor, "Live");
    await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "banner", value: banner("Jane's draft") });
    await saveDraft(tdb.db, sam, defaults, { baseRevision: 1, section: "banner", value: banner("Sam's draft") });

    expect(await publishSettings(tdb.db, sam, defaults, subs, { baseRevision: 1, section: "banner", value: banner("Sam's draft") })).toEqual({
      result: "published",
      revision: 2,
    });

    expect((await getSettingsState(tdb.db, sam, defaults)).draft).toBeNull();
    const janeState = await getSettingsState(tdb.db, jane, defaults);
    expect(janeState.document.banner.message).toBe("Jane's draft");
    expect(janeState.draft).toMatchObject({ baseRevision: 1 });
    expect(janeState.baseRevision).toBe(1);
  });

  it("a draft overlays only its section on the editor's previous draft, and remembers its base", async () => {
    await publishBanner(editor, "Live");
    await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "banner", value: banner("Work in progress") });
    const footer = { ...defaults.footer, copyrightHolder: "Province of B.C." };
    const state = await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "footer", value: footer });

    expect(state.document.banner.message).toBe("Work in progress");
    expect(state.document.footer.copyrightHolder).toBe("Province of B.C.");
    expect(state.draft).toMatchObject({ baseRevision: 1 });
    expect(state.errors).toEqual([]);
  });

  it("a section value of the wrong shape is a ZodError and saves nothing", async () => {
    await expect(saveDraft(tdb.db, jane, defaults, { baseRevision: null, section: "banner", value: { message: 1 } })).rejects.toBeInstanceOf(ZodError);
    expect((await getSettingsState(tdb.db, jane, defaults)).draft).toBeNull();
  });

  it("saving an invalid draft saves it and reports the problems", async () => {
    const footer = { ...defaults.footer, moreInfoLinks: defaults.footer.moreInfoLinks.map((l, i) => (i === 0 ? { ...l, url: "javascript:alert(1)" } : l)) };
    const state = await saveDraft(tdb.db, jane, defaults, { baseRevision: null, section: "footer", value: footer });
    expect(state.draft).not.toBeNull();
    expect(state.errors.map((e) => e.field)).toContain("footer.moreInfoLinks[0].url");
  });

  it("invalid settings are not published anywhere, and the draft is kept", async () => {
    const footer = { ...defaults.footer, moreInfoLinks: defaults.footer.moreInfoLinks.map((l, i) => (i === 0 ? { ...l, url: "javascript:alert(1)" } : l)) };
    const result = await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: null, section: "footer", value: footer });

    expect(result.result).toBe("invalid");
    expect(result.result === "invalid" && result.errors.map((e) => e.field)).toContain("footer.moreInfoLinks[0].url");
    expect(await revisionCount()).toBe(0);
    expect(await publishedEvents()).toHaveLength(0);
    expect((await tdb.pool.query("SELECT count(*)::int AS n FROM site_log")).rows[0].n).toBe(0);
    const state = await getSettingsState(tdb.db, jane, defaults);
    expect(state.draft).not.toBeNull();
    expect(state.document.footer.moreInfoLinks[0]!.url).toBe("javascript:alert(1)");
  });

  it("restore republishes an old revision as a new one; an unknown revision is not-found", async () => {
    await publishBanner(sam, "Election period");
    await publishBanner(sam, "Wildfire emergency");
    await saveDraft(tdb.db, jane, defaults, { baseRevision: 2, section: "banner", value: banner("Jane's unsent draft") });

    const restored = await restoreRevision(tdb.db, jane, defaults, subs, { revision: 1, baseRevision: 2 });
    expect(restored).toEqual({ result: "published", revision: 3 });

    const state = await getSettingsState(tdb.db, jane, defaults);
    expect(state.document.banner.message).toBe("Election period");
    expect(state.draft).toBeNull();
    const history = await listHistory(tdb.db);
    expect(history[0]).toMatchObject({ revision: 3, note: "Restored revision 1", publishedBy: "Jane Editor" });
    const log = await tdb.pool.query("SELECT text FROM site_log ORDER BY id DESC LIMIT 1");
    expect(log.rows[0].text).toBe("Published revision 3: Restored revision 1");

    expect(await restoreRevision(tdb.db, jane, defaults, subs, { revision: 99, baseRevision: 3 })).toEqual({ result: "not-found" });
  });

  it("restore from a stale base is a conflict and writes nothing", async () => {
    await publishBanner(sam, "One");
    await publishBanner(sam, "Two");
    const result = await restoreRevision(tdb.db, jane, defaults, subs, { revision: 1, baseRevision: 1 });
    expect(result).toMatchObject({ result: "conflict", live: { revision: 2 }, differing: ["banner"] });
    expect(await revisionCount()).toBe(2);
  });

  it("getRevision returns a revision's document and the sections that differ from live", async () => {
    await publishBanner(sam, "One", "first");
    await publishBanner(sam, "Two");
    const r1 = await getRevision(tdb.db, 1);
    expect(r1).toMatchObject({ info: { revision: 1, note: "first", publishedBy: "Sam Editor" }, differing: ["banner"] });
    expect(r1!.document.banner.message).toBe("One");
    expect((await getRevision(tdb.db, 2))!.differing).toEqual([]);
    expect(await getRevision(tdb.db, 99)).toBeNull();
  });

  it("rebase puts my section on top of live, with base = live, and reports the other sections set aside", async () => {
    await publishBanner(editor, "Live");
    await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "banner", value: banner("Jane's banner") });
    await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "footer", value: { ...defaults.footer, copyrightHolder: "Jane's holder" } });
    await publishBanner(sam, "Sam's banner");

    const rebased = await rebaseDraft(tdb.db, jane, defaults, { section: "banner", value: banner("Jane's banner") });

    expect(rebased.setAside).toEqual(["footer"]);
    expect(rebased.baseRevision).toBe(2);
    expect(rebased.draft).toMatchObject({ baseRevision: 2 });
    expect(rebased.document.banner.message).toBe("Jane's banner");
    expect(rebased.document.footer).toEqual(defaults.footer);

    expect(await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 2, section: "banner", value: banner("Jane's banner") })).toEqual({
      result: "published",
      revision: 3,
    });
  });

  it("rebase does not report sections only the other editor changed as set aside", async () => {
    await publishBanner(editor, "Live");
    await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "banner", value: banner("Jane's banner") });
    const samFooter = { ...defaults.footer, copyrightHolder: "Sam's holder" };
    expect(await publishSettings(tdb.db, sam, defaults, subs, { baseRevision: 1, section: "footer", value: samFooter })).toEqual({ result: "published", revision: 2 });

    const rebased = await rebaseDraft(tdb.db, jane, defaults, { section: "banner", value: banner("Jane's banner") });

    expect(rebased.setAside).toEqual([]);
    expect(rebased.baseRevision).toBe(2);
    expect(rebased.document.footer.copyrightHolder).toBe("Sam's holder");
    expect(rebased.document.banner.message).toBe("Jane's banner");
  });

  it("discard removes only my draft", async () => {
    await saveDraft(tdb.db, jane, defaults, { baseRevision: null, section: "banner", value: banner("Jane") });
    await saveDraft(tdb.db, sam, defaults, { baseRevision: null, section: "banner", value: banner("Sam") });
    await discardDraft(tdb.db, jane);
    expect((await getSettingsState(tdb.db, jane, defaults)).draft).toBeNull();
    expect((await getSettingsState(tdb.db, sam, defaults)).document.banner.message).toBe("Sam");
  });

  it("accented names and notes survive history", async () => {
    await publishBanner(andre, "x", "Feux de forêt — mise à jour");
    const history = await listHistory(tdb.db);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ publishedBy: "André Tremblay", note: "Feux de forêt — mise à jour" });
  });
});
