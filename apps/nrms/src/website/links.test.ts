import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { createNrmsTestDb, editor } from "../../test/helpers";
import { SiteConflictError, SiteRuleError } from "./errors";
import { getLinks, saveLinks } from "./links";

const subs: SubscriberConfig[] = [];

describe("website/links — resource links", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE resource_links, site_log, outbox_events, outbox_deliveries, aggregate_sequences CASCADE");
    await tdb.pool.query("UPDATE site_settings SET links_version = 1, version = 1, updated_at = now() WHERE id = 1");
  });

  const linksEventCount = async () => {
    const r = await tdb.pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE type = 'site.content.changed'");
    return r.rows[0].n as number;
  };
  const lastLinksEvent = async () => {
    const r = await tdb.pool.query(
      "SELECT envelope FROM outbox_events WHERE type = 'site.content.changed' ORDER BY created_at DESC, sequence DESC LIMIT 1",
    );
    return r.rows[0]?.envelope as { data: { entity: string; links?: { text: string; uri: string }[] } } | undefined;
  };
  const lastLog = async () => {
    const r = await tdb.pool.query("SELECT actor_name, area, text FROM site_log ORDER BY id DESC LIMIT 1");
    return r.rows[0] as { actor_name: string; area: string; text: string } | undefined;
  };

  it("an empty database has no links and links_version 1", async () => {
    expect(await getLinks(tdb.db)).toEqual({ version: 1, links: [] });
  });

  it("saves three links, then reorders and saves again: ids are kept, sort_index is 0..2, one event per save", async () => {
    const first = await saveLinks(
      tdb.db,
      {
        version: 1,
        links: [
          { text: "A", url: "https://a.invalid" },
          { text: "B", url: "https://b.invalid" },
          { text: "C", url: "/local/c" },
        ],
      },
      editor,
      subs,
    );
    expect(first.version).toBe(2);
    expect(first.links.map((l) => l.text)).toEqual(["A", "B", "C"]);
    expect(await linksEventCount()).toBe(1);
    expect((await lastLinksEvent())!.data.entity).toBe("resourceLinks");
    expect(await lastLog()).toMatchObject({ area: "links", text: "Saved 3 resource links" });

    const [a, b, c] = first.links;
    const reordered = await saveLinks(
      tdb.db,
      { version: first.version, links: [{ id: c!.id, text: "C", url: "/local/c" }, { id: a!.id, text: "A", url: "https://a.invalid" }, { id: b!.id, text: "B", url: "https://b.invalid" }] },
      editor,
      subs,
    );
    expect(reordered.version).toBe(3);
    expect(reordered.links.map((l) => l.id)).toEqual([c!.id, a!.id, b!.id]);
    expect(await linksEventCount()).toBe(2);

    const rows = await tdb.pool.query("SELECT id, sort_index FROM resource_links ORDER BY sort_index");
    expect(rows.rows.map((r: { sort_index: number }) => r.sort_index)).toEqual([0, 1, 2]);
  });

  it("a javascript: URL is refused with a SiteRuleError; nothing changes", async () => {
    await expect(
      saveLinks(tdb.db, { version: 1, links: [{ text: "Evil", url: "javascript:alert(1)" }] }, editor, subs),
    ).rejects.toThrow(SiteRuleError);
    expect(await getLinks(tdb.db)).toEqual({ version: 1, links: [] });
    expect(await linksEventCount()).toBe(0);
  });

  it("a stale links_version is refused with SiteConflictError; nothing changes", async () => {
    await saveLinks(tdb.db, { version: 1, links: [{ text: "A", url: "https://a.invalid" }] }, editor, subs);
    await expect(
      saveLinks(tdb.db, { version: 1, links: [{ text: "B", url: "https://b.invalid" }] }, editor, subs),
    ).rejects.toThrow(SiteConflictError);
    const after = await getLinks(tdb.db);
    expect(after.links.map((l) => l.text)).toEqual(["A"]);
  });

  it("an unknown link id is refused with a SiteRuleError", async () => {
    await expect(
      saveLinks(tdb.db, { version: 1, links: [{ id: "00000000-0000-4000-8000-000000000999", text: "A", url: "https://a.invalid" }] }, editor, subs),
    ).rejects.toThrow(SiteRuleError);
  });
});
