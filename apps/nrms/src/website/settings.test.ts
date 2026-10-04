import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { createNrmsTestDb, editor } from "../../test/helpers";
import { SiteConflictError, SiteRuleError } from "./errors";
import { getLiveFeed, saveLiveFeed } from "./settings";

const subs: SubscriberConfig[] = [];
const defaults = { manifestUrl: "https://default.invalid/manifest.f4m", m3uUrl: "https://default.invalid/playlist.m3u8" };

describe("website/settings — Live Feed", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE site_log, outbox_events, outbox_deliveries, aggregate_sequences CASCADE");
    await tdb.pool.query(
      "UPDATE site_settings SET live_feed_enabled = false, live_manifest_url = '', live_m3u_url = '', granville = NULL, links_version = 1, version = 1 WHERE id = 1",
    );
  });

  const lastLog = async () => {
    const r = await tdb.pool.query("SELECT actor_name, area, text FROM site_log ORDER BY id DESC LIMIT 1");
    return r.rows[0] as { actor_name: string; area: string; text: string } | undefined;
  };
  const homeEventCount = async () => {
    const r = await tdb.pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE type = 'site.content.changed'");
    return r.rows[0].n as number;
  };

  it("a stored empty URL shows the environment default", async () => {
    const view = await getLiveFeed(tdb.db, defaults);
    expect(view).toEqual({ enabled: false, manifestUrl: defaults.manifestUrl, m3uUrl: defaults.m3uUrl, version: 1 });
  });

  it("a stored URL overrides the default", async () => {
    await tdb.pool.query("UPDATE site_settings SET live_manifest_url = 'https://stored.invalid/m.f4m' WHERE id = 1");
    const view = await getLiveFeed(tdb.db, defaults);
    expect(view.manifestUrl).toBe("https://stored.invalid/m.f4m");
    expect(view.m3uUrl).toBe(defaults.m3uUrl);
  });

  it("enabling with an empty M3U URL is refused with a SiteRuleError; nothing changes", async () => {
    await expect(
      saveLiveFeed(tdb.db, { version: 1, enabled: true, manifestUrl: "", m3uUrl: "" }, editor, subs),
    ).rejects.toThrow(SiteRuleError);
    const view = await getLiveFeed(tdb.db, defaults);
    expect(view.enabled).toBe(false);
    expect(view.version).toBe(1);
    expect(await homeEventCount()).toBe(0);
  });

  it("turning the Live Feed on with URLs set emits home with the URLs, and logs 'Turned the Live Feed on'", async () => {
    const saved = await saveLiveFeed(
      tdb.db,
      { version: 1, enabled: true, manifestUrl: "https://live.invalid/m.f4m", m3uUrl: "https://live.invalid/p.m3u8" },
      editor,
      subs,
    );
    expect(saved).toMatchObject({ enabled: true, manifestUrl: "https://live.invalid/m.f4m", m3uUrl: "https://live.invalid/p.m3u8", version: 2 });
    expect(await homeEventCount()).toBe(1);
    expect(await lastLog()).toMatchObject({ area: "live-feed", text: "Turned the Live Feed on" });

    const off = await saveLiveFeed(
      tdb.db,
      { version: 2, enabled: false, manifestUrl: "https://live.invalid/m.f4m", m3uUrl: "https://live.invalid/p.m3u8" },
      editor,
      subs,
    );
    expect(off.enabled).toBe(false);
    expect(await lastLog()).toMatchObject({ area: "live-feed", text: "Turned the Live Feed off" });

    const changedUrls = await saveLiveFeed(
      tdb.db,
      { version: off.version, enabled: false, manifestUrl: "https://live.invalid/new.f4m", m3uUrl: "https://live.invalid/p.m3u8" },
      editor,
      subs,
    );
    expect(changedUrls.manifestUrl).toBe("https://live.invalid/new.f4m");
    expect(await lastLog()).toMatchObject({ area: "live-feed", text: "Changed the Live Feed URLs" });
  });

  it("a stale version is refused with SiteConflictError", async () => {
    await saveLiveFeed(tdb.db, { version: 1, enabled: false, manifestUrl: "", m3uUrl: "" }, editor, subs);
    await expect(
      saveLiveFeed(tdb.db, { version: 1, enabled: false, manifestUrl: "https://x.invalid/a", m3uUrl: "" }, editor, subs),
    ).rejects.toThrow(SiteConflictError);
  });

  it("a non-https URL is refused with a SiteRuleError", async () => {
    await expect(
      saveLiveFeed(tdb.db, { version: 1, enabled: false, manifestUrl: "http://insecure.invalid/m.f4m", m3uUrl: "" }, editor, subs),
    ).rejects.toThrow(SiteRuleError);
  });
});
