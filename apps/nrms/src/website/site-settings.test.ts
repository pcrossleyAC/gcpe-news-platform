import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { TestDatabase } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import type { SiteSettings } from "@gcpe/site-settings";
import { bcSettings, prePlan4Settings, prePlan5Settings } from "../../../../packages/site-settings/src/fixtures";
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

  it("getSettingsState fills a live document's missing land acknowledgement from the tenant defaults", async () => {
    const legacy = structuredClone(defaults);
    delete legacy.footer.landAcknowledgement;
    await tdb.pool.query(
      "INSERT INTO site_settings_revisions (revision, document, published_by_id, published_by_name) VALUES (1, $1, 'u', 'Jane')",
      [JSON.stringify(legacy)],
    );
    const state = await getSettingsState(tdb.db, jane, defaults);
    expect(state.live?.revision).toBe(1);
    expect(state.document.footer.landAcknowledgement).toBe(defaults.footer.landAcknowledgement);
    expect(state.document.footer.landAcknowledgement).not.toBe("");
    expect(state.errors).toEqual([]);
  });

  it("a non-footer publish, conflict and rebase on a pre-field live document never report the footer", async () => {
    const legacy = structuredClone(defaults);
    delete legacy.footer.landAcknowledgement;
    await tdb.pool.query(
      "INSERT INTO site_settings_revisions (revision, document, published_by_id, published_by_name) VALUES (1, $1, 'u', 'Jane')",
      [JSON.stringify(legacy)],
    );
    // Sam starts a banner draft from the pre-field revision; Jane publishes a banner first.
    await saveDraft(tdb.db, sam, defaults, { baseRevision: 1, section: "banner", value: banner("Sam's banner") });
    expect(await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 1, section: "banner", value: banner("Jane's banner") })).toEqual({
      result: "published",
      revision: 2,
    });
    // As the history route asks (with the tenant defaults): the pre-field revision's footer is the
    // default text, the same as live's, so only the banner differs.
    expect((await getRevision(tdb.db, 1, defaults))!.differing).toEqual(["banner"]);
    const stale = await publishSettings(tdb.db, sam, defaults, subs, { baseRevision: 1, section: "banner", value: banner("Sam's banner") });
    expect(stale).toMatchObject({ result: "conflict", differing: ["banner"] });
    const rebased = await rebaseDraft(tdb.db, sam, defaults, { section: "banner", value: banner("Sam's banner") });
    expect(rebased.alsoChangedByThem).toEqual([]);
    expect(rebased.document.footer.landAcknowledgement).toBe(defaults.footer.landAcknowledgement);
    expect(await publishSettings(tdb.db, sam, defaults, subs, { baseRevision: 2, section: "banner", value: banner("Sam's banner") })).toEqual({
      result: "published",
      revision: 3,
    });
    // A real footer change still shows: a custom acknowledgement isn't the pre-field default.
    const footer = { ...defaults.footer, landAcknowledgement: "Ours." };
    expect(await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 3, section: "footer", value: footer })).toMatchObject({ revision: 4 });
    expect((await getRevision(tdb.db, 1, defaults))!.differing).toEqual(["banner", "footer"]);
  });

  /** Stores a revision as published before plan 4 (no contactsPage/pageText/navigation, no connect.linkedin/policyLink/intro). */
  const storePrePlan4 = async (revision: number) =>
    tdb.pool.query("INSERT INTO site_settings_revisions (revision, document, published_by_id, published_by_name) VALUES ($1, $2, 'u', 'Jane')", [
      revision,
      JSON.stringify(prePlan4Settings()),
    ]);

  it("PUT section 'pageText' saves a draft; a stored revision without pageText reads back filled", async () => {
    await storePrePlan4(1);
    const before = await getSettingsState(tdb.db, jane, defaults);
    expect(before.document).toEqual(defaults);
    expect(before.errors).toEqual([]);

    const pageText = { ...defaults.pageText, notFound: { heading: "Not here.", text: "Try search." } };
    const state = await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "pageText", value: pageText });
    expect(state.draft).toMatchObject({ baseRevision: 1 });
    expect(state.document.pageText.notFound).toEqual({ heading: "Not here.", text: "Try search." });
    // The parts the editor didn't touch read back filled from the tenant defaults.
    expect(state.document.navigation).toEqual(defaults.navigation);
    expect(state.document.connect.linkedin).toEqual(defaults.connect.linkedin);
    expect(state.errors).toEqual([]);

    // A section edit must be a complete section (siteSettingsSchema.shape[section]).
    await expect(saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "navigation", value: { newsLabel: "News" } })).rejects.toBeInstanceOf(ZodError);

    expect(await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 1, section: "pageText", value: pageText })).toEqual({ result: "published", revision: 2 });
    const [event] = await publishedEvents();
    // What goes out is complete: the plan-4 parts are in the event.
    expect(event!.data.document.pageText.notFound.heading).toBe("Not here.");
    expect(event!.data.document.navigation).toEqual(defaults.navigation);
    expect(event!.data.document.connect.policyLink).toEqual(defaults.connect.policyLink);
  });

  it("PUT section 'siteIdentity' saves a draft; a stored revision without siteIdentity reads back filled", async () => {
    await tdb.pool.query("INSERT INTO site_settings_revisions (revision, document, published_by_id, published_by_name) VALUES (1, $1, 'u', 'Jane')", [
      JSON.stringify(prePlan5Settings()),
    ]);
    const before = await getSettingsState(tdb.db, jane, defaults);
    expect(before.document).toEqual(defaults);
    expect(before.errors).toEqual([]);

    const siteIdentity = { ...defaults.siteIdentity, description: "Updated description" };
    const state = await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "siteIdentity", value: siteIdentity });
    expect(state.draft).toMatchObject({ baseRevision: 1 });
    expect(state.document.siteIdentity).toEqual(siteIdentity);
    expect(state.errors).toEqual([]);

    await expect(saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "siteIdentity", value: { description: "x" } })).rejects.toBeInstanceOf(ZodError);

    expect(await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 1, section: "siteIdentity", value: siteIdentity })).toEqual({ result: "published", revision: 2 });
    const [event] = await publishedEvents();
    expect(event!.data.document.siteIdentity).toEqual(siteIdentity);
  });

  it("conflict, rebase and history on a pre-plan-4 live document report only the sections really edited", async () => {
    await storePrePlan4(1);
    await saveDraft(tdb.db, sam, defaults, { baseRevision: 1, section: "banner", value: banner("Sam's banner") });
    expect(await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 1, section: "banner", value: banner("Jane's banner") })).toEqual({
      result: "published",
      revision: 2,
    });
    // Revision 2 carries the filled parts; revision 1 lacks them: filled, they are the same.
    expect((await getRevision(tdb.db, 1, defaults))!.differing).toEqual(["banner"]);
    expect((await getRevision(tdb.db, 1, defaults))!.document).toEqual(defaults);
    const stale = await publishSettings(tdb.db, sam, defaults, subs, { baseRevision: 1, section: "banner", value: banner("Sam's banner") });
    expect(stale).toMatchObject({ result: "conflict", differing: ["banner"] });
    const rebased = await rebaseDraft(tdb.db, sam, defaults, { section: "banner", value: banner("Sam's banner") });
    expect(rebased.alsoChangedByThem).toEqual([]);
    expect(rebased.document.navigation).toEqual(defaults.navigation);
  });

  it("restoring a pre-plan-4 revision publishes it filled from the tenant defaults", async () => {
    await storePrePlan4(1);
    await publishBanner(sam, "Later");
    expect(await restoreRevision(tdb.db, jane, defaults, subs, { revision: 1, baseRevision: 2 })).toEqual({ result: "published", revision: 3 });
    const events = await publishedEvents();
    expect(events.at(-1)!.data.document).toEqual(defaults);
  });

  it("with nothing stored, the state is the defaults with no live revision, draft or errors", async () => {
    const state = await getSettingsState(tdb.db, jane, defaults);
    expect(state).toEqual({ live: null, document: defaults, draft: null, baseRevision: null, errors: [], draftSections: [] });
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

  it("audit #12: draftSections names the sections where my draft differs from what is live, and is empty with no draft", async () => {
    expect((await getSettingsState(tdb.db, jane, defaults)).draftSections).toEqual([]);
    await publishBanner(editor, "Live");
    await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "banner", value: banner("Work in progress") });
    await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "footer", value: { ...defaults.footer, copyrightHolder: "Province of B.C." } });
    // Saving a section unchanged doesn't count it.
    const state = await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "theme", value: defaults.theme });
    expect(state.draftSections).toEqual(["banner", "footer"]);
    // Drafts are per editor: Sam has none.
    expect((await getSettingsState(tdb.db, sam, defaults)).draftSections).toEqual([]);
    await discardDraft(tdb.db, jane);
    expect((await getSettingsState(tdb.db, jane, defaults)).draftSections).toEqual([]);
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

  it("rebase puts my section on top of live, with base = live, and keeps my changes on other screens (fix round 1)", async () => {
    await publishBanner(editor, "Live");
    await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "banner", value: banner("Jane's banner") });
    await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "footer", value: { ...defaults.footer, copyrightHolder: "Jane's holder" } });
    await publishBanner(sam, "Sam's banner");

    const rebased = await rebaseDraft(tdb.db, jane, defaults, { section: "banner", value: banner("Jane's banner") });

    expect(rebased.alsoChangedByThem).toEqual([]);
    expect(rebased.baseRevision).toBe(2);
    expect(rebased.draft).toMatchObject({ baseRevision: 2 });
    expect(rebased.document.banner.message).toBe("Jane's banner");
    expect(rebased.document.footer.copyrightHolder).toBe("Jane's holder");
    expect(rebased.draftSections).toEqual(["banner", "footer"]);

    expect(await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 2, section: "banner", value: banner("Jane's banner") })).toEqual({
      result: "published",
      revision: 3,
    });
  });

  it("rebase keeps my change on a screen the other editor also changed, and names it so I check it", async () => {
    await publishBanner(editor, "Live");
    await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "banner", value: banner("Jane's banner") });
    await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "footer", value: { ...defaults.footer, copyrightHolder: "Jane's holder" } });
    expect(await publishSettings(tdb.db, sam, defaults, subs, { baseRevision: 1, section: "footer", value: { ...defaults.footer, copyrightHolder: "Sam's holder" } })).toMatchObject({ revision: 2 });

    const rebased = await rebaseDraft(tdb.db, jane, defaults, { section: "banner", value: banner("Jane's banner") });
    expect(rebased.alsoChangedByThem).toEqual(["footer"]);
    expect(rebased.document.footer.copyrightHolder).toBe("Jane's holder");
    expect(rebased.baseRevision).toBe(2);
  });

  it("rebase does not report sections only the other editor changed", async () => {
    await publishBanner(editor, "Live");
    await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "banner", value: banner("Jane's banner") });
    const samFooter = { ...defaults.footer, copyrightHolder: "Sam's holder" };
    expect(await publishSettings(tdb.db, sam, defaults, subs, { baseRevision: 1, section: "footer", value: samFooter })).toEqual({ result: "published", revision: 2 });

    const rebased = await rebaseDraft(tdb.db, jane, defaults, { section: "banner", value: banner("Jane's banner") });

    expect(rebased.alsoChangedByThem).toEqual([]);
    expect(rebased.baseRevision).toBe(2);
    expect(rebased.document.footer.copyrightHolder).toBe("Sam's holder");
    expect(rebased.document.banner.message).toBe("Jane's banner");
  });

  describe("W4: Publish only this screen (owner decision 2026-10-31)", () => {
    const badFooter = () => ({ ...defaults.footer, moreInfoLinks: defaults.footer.moreInfoLinks.map((l, i) => (i === 0 ? { ...l, url: "javascript:alert(1)" } : l)) });

    it("publishes live plus this section, an invalid section elsewhere in the draft doesn't block it, and the rest of the draft stays", async () => {
      await publishBanner(editor, "Live");
      await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "footer", value: badFooter() });
      // A plain Publish is refused by the footer.
      expect((await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 1, section: "banner", value: banner("Urgent") })).result).toBe("invalid");

      const result = await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 1, section: "banner", value: banner("Urgent"), onlySection: true, note: "Fire" });
      expect(result).toEqual({ result: "published", revision: 2 });

      const published = await getRevision(tdb.db, 2, defaults);
      expect(published!.document.banner.message).toBe("Urgent");
      expect(published!.document.footer).toEqual(defaults.footer);
      const events = await publishedEvents();
      expect(events.at(-1)!.data.document.footer).toEqual(defaults.footer);

      const state = await getSettingsState(tdb.db, jane, defaults);
      expect(state.live?.revision).toBe(2);
      expect(state.draft).toMatchObject({ baseRevision: 2 });
      expect(state.baseRevision).toBe(2);
      expect(state.draftSections).toEqual(["footer"]);
      expect(state.document.banner.message).toBe("Urgent");
      expect(state.document.footer.moreInfoLinks[0]!.url).toBe("javascript:alert(1)");

      const log = await tdb.pool.query("SELECT text FROM site_log ORDER BY id DESC LIMIT 1");
      expect(log.rows).toEqual([{ text: "Published revision 2: Banner only: Fire" }]);
    });

    it("with nothing else in the draft it removes the draft, as Publish does", async () => {
      await publishBanner(editor, "Live");
      await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "banner", value: banner("Draft wording") });
      expect(await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 1, section: "banner", value: banner("Final"), onlySection: true })).toEqual({ result: "published", revision: 2 });
      const state = await getSettingsState(tdb.db, jane, defaults);
      expect(state.draft).toBeNull();
      expect(state.document.banner.message).toBe("Final");
    });

    it("refuses this section's own problems, publishes nothing and keeps the draft", async () => {
      await publishBanner(editor, "Live");
      const result = await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 1, section: "footer", value: badFooter(), onlySection: true });
      expect(result.result).toBe("invalid");
      expect(await revisionCount()).toBe(1);
      expect((await getSettingsState(tdb.db, jane, defaults)).document.footer.moreInfoLinks[0]!.url).toBe("javascript:alert(1)");
    });

    it("from a stale draft, publishes this screen when nobody else changed it: live keeps their changes, my draft keeps mine (fix round 1)", async () => {
      await publishBanner(editor, "Live");
      await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "footer", value: { ...defaults.footer, copyrightHolder: "Jane's holder" } });
      const samFooter = { ...defaults.footer, moreInfoLinks: defaults.footer.moreInfoLinks.slice(1) };
      expect(await publishSettings(tdb.db, sam, defaults, subs, { baseRevision: 1, section: "footer", value: samFooter })).toMatchObject({ revision: 2 });

      const result = await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 1, section: "banner", value: banner("Urgent"), onlySection: true });
      expect(result).toEqual({ result: "published", revision: 3 });
      const published = (await getRevision(tdb.db, 3, defaults))!.document;
      expect(published.banner.message).toBe("Urgent");
      expect(published.footer).toEqual(samFooter);
      // My draft is left as it was (still based on revision 1), so a later full Publish still asks.
      const state = await getSettingsState(tdb.db, jane, defaults);
      expect(state.draft).toMatchObject({ baseRevision: 1 });
      expect(state.document.footer.copyrightHolder).toBe("Jane's holder");
      expect((await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 1, section: "footer", value: state.document.footer })).result).toBe("conflict");
    });

    it("from a stale draft, is a conflict when someone else changed this same screen, and writes nothing", async () => {
      await publishBanner(editor, "Live");
      await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "footer", value: { ...defaults.footer, copyrightHolder: "Jane's holder" } });
      await publishBanner(sam, "Sam's banner");
      const result = await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 1, section: "banner", value: banner("Jane's banner"), onlySection: true });
      expect(result).toMatchObject({ result: "conflict", live: { revision: 2 }, differing: ["banner"] });
      expect(await revisionCount()).toBe(2);
      const state = await getSettingsState(tdb.db, jane, defaults);
      expect(state.draft).toMatchObject({ baseRevision: 1 });
      expect(state.document.footer.copyrightHolder).toBe("Jane's holder");
    });

    it("N1: publishing the same screen twice from a stale draft isn't a conflict with my own publish; someone else then changing it is", async () => {
      await publishBanner(editor, "Live");
      await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "footer", value: { ...defaults.footer, copyrightHolder: "Jane's holder" } });
      expect(await publishSettings(tdb.db, sam, defaults, subs, { baseRevision: 1, section: "footer", value: { ...defaults.footer, copyrightHolder: "Sam's holder" } })).toMatchObject({ revision: 2 });
      expect(await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 1, section: "banner", value: banner("Urgent"), onlySection: true })).toEqual({ result: "published", revision: 3 });
      // Both changed the footer, so the draft stays on its old base…
      const base = (await getSettingsState(tdb.db, jane, defaults)).baseRevision;
      expect(base).toBe(1);
      // …and a typo fix on the banner still publishes.
      expect(await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: base, section: "banner", value: banner("Urgent, fixed"), onlySection: true })).toEqual({ result: "published", revision: 4 });
      // Sam then changes the banner: now it is a conflict, and nothing is written.
      await publishBanner(sam, "Sam's banner");
      const result = await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: base, section: "banner", value: banner("Jane again"), onlySection: true });
      expect(result).toMatchObject({ result: "conflict", live: { revision: 5, publishedBy: "Sam Editor" }, differing: ["banner"] });
      expect(await revisionCount()).toBe(5);
    });

    it("N1: from a stale draft whose other changes don't overlap theirs, the draft is re-based on the new revision and keeps my changes", async () => {
      await publishBanner(editor, "Live");
      await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "footer", value: { ...defaults.footer, copyrightHolder: "Jane's holder" } });
      const samTheme = { ...defaults.theme, colors: { ...defaults.theme.colors, accent: "#AA5500" } };
      expect(await publishSettings(tdb.db, sam, defaults, subs, { baseRevision: 1, section: "theme", value: samTheme })).toMatchObject({ revision: 2 });
      expect(await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 1, section: "banner", value: banner("Urgent"), onlySection: true })).toMatchObject({ revision: 3 });
      const state = await getSettingsState(tdb.db, jane, defaults);
      expect(state.baseRevision).toBe(3);
      expect(state.draftSections).toEqual(["footer"]);
      expect(state.document.footer.copyrightHolder).toBe("Jane's holder");
      expect(state.document.theme).toEqual(samTheme);
    });

    it("N4: Keep mine doesn't name my own Publish only as changed by them", async () => {
      await publishBanner(editor, "Live");
      await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "footer", value: { ...defaults.footer, copyrightHolder: "Jane's holder" } });
      await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "theme", value: { ...defaults.theme, colors: { ...defaults.theme.colors, accent: "#112233" } } });
      expect(await publishSettings(tdb.db, sam, defaults, subs, { baseRevision: 1, section: "footer", value: { ...defaults.footer, copyrightHolder: "Sam's holder" } })).toMatchObject({ revision: 2 });
      expect(await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 1, section: "banner", value: banner("Urgent"), onlySection: true })).toMatchObject({ revision: 3 });
      const rebased = await rebaseDraft(tdb.db, jane, defaults, { section: "theme", value: { ...defaults.theme, colors: { ...defaults.theme.colors, accent: "#112233" } } });
      expect(rebased.alsoChangedByThem).toEqual(["footer"]);
      expect(rebased.document.banner.message).toBe("Urgent");
    });

    it("N2: a save from another tab that lands while the publish waits is published, not overwritten", async () => {
      await publishBanner(editor, "Live");
      await saveDraft(tdb.db, jane, defaults, { baseRevision: 1, section: "banner", value: banner("Jane") });
      const other = await tdb.pool.connect();
      try {
        await other.query("BEGIN");
        await other.query("SELECT 1 FROM site_settings_drafts WHERE editor_id = $1 FOR UPDATE", [jane.id]);
        await other.query("UPDATE site_settings_drafts SET document = jsonb_set(document, '{footer,copyrightHolder}', '\"Other tab\"') WHERE editor_id = $1", [jane.id]);
        const publishing = publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 1, section: "banner", value: banner("Jane") });
        await new Promise((r) => setTimeout(r, 300));
        await other.query("COMMIT");
        expect(await publishing).toMatchObject({ result: "published", revision: 2 });
      } finally {
        other.release();
      }
      expect((await getRevision(tdb.db, 2, defaults))!.document.footer.copyrightHolder).toBe("Other tab");
    });

    it("records the partial publish in the history note, as Restore does (fix round 1)", async () => {
      await publishBanner(editor, "Live");
      await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 1, section: "banner", value: banner("A"), onlySection: true });
      await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: 2, section: "banner", value: banner("B"), onlySection: true, note: "Fire" });
      expect((await listHistory(tdb.db)).slice(0, 2).map((h) => h.note)).toEqual(["Banner only: Fire", "Banner only"]);
    });
  });

  it("discard removes only my draft", async () => {
    await saveDraft(tdb.db, jane, defaults, { baseRevision: null, section: "banner", value: banner("Jane") });
    await saveDraft(tdb.db, sam, defaults, { baseRevision: null, section: "banner", value: banner("Sam") });
    await discardDraft(tdb.db, jane);
    expect((await getSettingsState(tdb.db, jane, defaults)).draft).toBeNull();
    expect((await getSettingsState(tdb.db, sam, defaults)).document.banner.message).toBe("Sam");
  });

  describe("rich HTML fields are cleaned on save (P4-R4)", () => {
    const NASTY = '<p>Hi<script>alert(1)</script></p><img src="https://x.example/a.png" onerror="alert(2)"><p><a href="javascript:alert(3)">Click</a></p>';
    const CLEAN = "<p>Hi</p><p>Click</p>";
    const storedDraft = async (actor: Actor) =>
      (await tdb.pool.query("SELECT document FROM site_settings_drafts WHERE editor_id = $1", [actor.id])).rows[0].document as SiteSettings;
    const storedRevision = async (n: number) =>
      (await tdb.pool.query("SELECT document FROM site_settings_revisions WHERE revision = $1", [n])).rows[0].document as SiteSettings;

    it("a saved draft and a published revision store inert HTML for every rich pageText field", async () => {
      const pageText = {
        ...defaults.pageText,
        privacy: { ...defaults.pageText.privacy, bodyHtml: NASTY },
        live: { ...defaults.pageText.live, consentHtml: NASTY, offAirHtml: NASTY },
        collectionNotice: { ...defaults.pageText.collectionNotice, bodyHtml: NASTY },
        subscribeHelpHtml: NASTY,
      };
      const state = await saveDraft(tdb.db, jane, defaults, { baseRevision: null, section: "pageText", value: pageText });
      expect(state.document.pageText.privacy.bodyHtml).toBe(CLEAN);
      const draft = await storedDraft(jane);
      for (const html of [draft.pageText.privacy.bodyHtml, draft.pageText.live.consentHtml, draft.pageText.live.offAirHtml, draft.pageText.collectionNotice.bodyHtml, draft.pageText.subscribeHelpHtml]) {
        expect(html).toBe(CLEAN);
      }
      expect(await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: null, section: "pageText", value: pageText })).toEqual({ result: "published", revision: 1 });
      expect((await storedRevision(1)).pageText.privacy.bodyHtml).toBe(CLEAN);
      expect((await publishedEvents())[0]!.data.document.pageText.subscribeHelpHtml).toBe(CLEAN);
    });

    it("the Media contacts introduction is cleaned on save and on rebase", async () => {
      const contactsPage = { ...defaults.contactsPage, introHtml: NASTY };
      await saveDraft(tdb.db, jane, defaults, { baseRevision: null, section: "contactsPage", value: contactsPage });
      expect((await storedDraft(jane)).contactsPage.introHtml).toBe(CLEAN);
      await rebaseDraft(tdb.db, sam, defaults, { section: "contactsPage", value: contactsPage });
      expect((await storedDraft(sam)).contactsPage.introHtml).toBe(CLEAN);
    });

    it("restoring a revision stored before cleaning existed publishes it cleaned", async () => {
      const dirty = structuredClone(defaults);
      dirty.pageText.privacy.bodyHtml = NASTY;
      await tdb.pool.query("INSERT INTO site_settings_revisions (revision, document, published_by_id, published_by_name) VALUES (1, $1, 'u', 'Jane')", [
        JSON.stringify(dirty),
      ]);
      expect(await restoreRevision(tdb.db, jane, defaults, subs, { revision: 1, baseRevision: 1 })).toEqual({ result: "published", revision: 2 });
      expect((await storedRevision(2)).pageText.privacy.bodyHtml).toBe(CLEAN);
    });

    it("a clean document round-trips byte-identical (re-saving published text changes nothing)", async () => {
      // jsonb reorders object keys, so "byte-identical" is checked per stored HTML string.
      const richStrings = (d: SiteSettings) => [
        d.contactsPage.introHtml,
        d.pageText.privacy.bodyHtml,
        d.pageText.live.consentHtml,
        d.pageText.live.offAirHtml,
        d.pageText.collectionNotice.bodyHtml,
        d.pageText.subscribeHelpHtml,
      ];
      await saveDraft(tdb.db, jane, defaults, { baseRevision: null, section: "pageText", value: defaults.pageText });
      await saveDraft(tdb.db, jane, defaults, { baseRevision: null, section: "contactsPage", value: defaults.contactsPage });
      const draft = await storedDraft(jane);
      expect(draft).toEqual(defaults);
      richStrings(draft).forEach((html, i) => expect(html).toBe(richStrings(defaults)[i]));
      expect(await publishSettings(tdb.db, jane, defaults, subs, { baseRevision: null, section: "pageText", value: defaults.pageText })).toEqual({ result: "published", revision: 1 });
      const live = await storedRevision(1);
      expect(live).toEqual(defaults);
      richStrings(live).forEach((html, i) => expect(html).toBe(richStrings(defaults)[i]));
    });
  });

  it("accented names and notes survive history", async () => {
    await publishBanner(andre, "x", "Feux de forêt — mise à jour");
    const history = await listHistory(tdb.db);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ publishedBy: "André Tremblay", note: "Feux de forêt — mise à jour" });
  });
});
