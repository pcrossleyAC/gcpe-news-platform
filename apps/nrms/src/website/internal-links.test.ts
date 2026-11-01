import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { SiteSettings } from "@gcpe/site-settings";
import { bcSettings } from "../../../../packages/site-settings/src/fixtures";
import { createNrmsTestDb } from "../../test/helpers";
import { findInternalLinks } from "./internal-links";

/** Suite fix W2 (M4 report): every stored Website address on one of the Hub's internal hosts. */

const HUB = "https://gcpe-app01.internal.example";
const ALIAS = "https://hub.example";
const HOSTS = ["gcpe-app01.internal.example", "hub.example"];

describe("website/internal-links", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE carousels, slides, resource_links, site_settings_revisions, site_settings_drafts CASCADE");
    await tdb.pool.query("UPDATE emergency_pins SET action_url = '', facebook_post_url = '', summary = '', headline = ''");
    await tdb.pool.query("UPDATE site_settings SET live_manifest_url = '', live_m3u_url = '' WHERE id = 1");
  });

  const carousel = async (state: "live" | "next" | "past") =>
    (
      await tdb.pool.query("INSERT INTO carousels (state, go_live_at) VALUES ($1, CASE WHEN $1 = 'next' THEN now() + interval '1 day' END) RETURNING id", [state])
    ).rows[0].id as string;
  const slide = (carouselId: string, sortIndex: number, over: { action_url?: string; facebook_post_url?: string; summary?: string } = {}) =>
    tdb.pool.query("INSERT INTO slides (carousel_id, sort_index, headline, summary, action_url, facebook_post_url) VALUES ($1, $2, 'Headline', $3, $4, $5)", [
      carouselId,
      sortIndex,
      over.summary ?? "",
      over.action_url ?? "",
      over.facebook_post_url ?? "",
    ]);

  it("finds nothing when nothing points at the Hub, or when no internal host is known", async () => {
    const live = await carousel("live");
    await slide(live, 0, { action_url: `${HUB}/files/a.pdf` });
    expect(await findInternalLinks(tdb.db, [])).toEqual([]);
    await tdb.pool.query("TRUNCATE carousels CASCADE");
    await slide(await carousel("live"), 0, { action_url: "https://news.example/files/a.pdf" });
    expect(await findInternalLinks(tdb.db, HOSTS)).toEqual([]);
  });

  it("lists the live and next carousels' slides, the pins, the Live Feed and the resource links, in screen order", async () => {
    const live = await carousel("live");
    await slide(live, 0, { action_url: "https://news.example/ok" });
    await slide(live, 1, { action_url: `${HUB}/files/minister.jpg`, summary: `Read ${ALIAS}/hub/x.` });
    const next = await carousel("next");
    await slide(next, 0, { facebook_post_url: `${ALIAS}/fb` });
    // A past carousel isn't on the site and can't be edited: not listed.
    await slide(await carousel("past"), 0, { action_url: `${HUB}/old` });
    await tdb.pool.query("UPDATE emergency_pins SET action_url = $1 WHERE slot = 'secondary'", [`${HUB}/files/pin.pdf`]);
    await tdb.pool.query("UPDATE site_settings SET live_m3u_url = $1 WHERE id = 1", [`${HUB}/live.m3u`]);
    await tdb.pool.query("INSERT INTO resource_links (sort_index, text, url) VALUES (0, 'Fine', 'https://gov.bc.ca'), (1, 'Report', $1)", [`${HUB.toUpperCase()}/files/r.pdf`]);

    expect(await findInternalLinks(tdb.db, HOSTS)).toEqual([
      { screen: "carousel", where: "Live carousel, slide 2: summary", address: `${ALIAS}/hub/x` },
      { screen: "carousel", where: "Live carousel, slide 2: action URL", address: `${HUB}/files/minister.jpg` },
      { screen: "carousel", where: "Next carousel, slide 1: Facebook post URL", address: `${ALIAS}/fb` },
      { screen: "pins", where: "Secondary emergency pin: action URL", address: `${HUB}/files/pin.pdf` },
      { screen: "live-feed", where: "M3U URL", address: `${HUB}/live.m3u` },
      { screen: "links", where: "Link 2 URL", address: `${HUB.toUpperCase()}/files/r.pdf` },
    ]);
  });

  it("lists the published site settings by screen, with the field's place in its section (fix round 1, M2), including rich text", async () => {
    const doc: SiteSettings = structuredClone(bcSettings());
    doc.footer.helpLinks = [{ text: "Contact us", url: `${HUB}/contact` }, ...doc.footer.helpLinks];
    doc.connect.policyLink = { text: "Policy", url: `${ALIAS}/files/policy.pdf` };
    doc.pageText.subscribeHelpHtml = `<p>See <a href="${HUB}/files/help.pdf">help</a>.</p>`;
    await tdb.pool.query("INSERT INTO site_settings_revisions (revision, document, published_by_id, published_by_name) VALUES (1, $1, 'u', 'Jane')", [
      JSON.stringify({ ...structuredClone(bcSettings()), footer: { ...doc.footer, helpLinks: [{ text: "Old", url: `${HUB}/old` }] } }),
    ]);
    await tdb.pool.query("INSERT INTO site_settings_revisions (revision, document, published_by_id, published_by_name) VALUES (2, $1, 'u', 'Jane')", [JSON.stringify(doc)]);
    // A draft isn't on the site: not listed.
    await tdb.pool.query("INSERT INTO site_settings_drafts (editor_id, document, base_revision) VALUES ('x', $1, 2)", [
      JSON.stringify({ ...doc, banner: { ...doc.banner, message: `${HUB}/draft` } }),
    ]);

    expect(await findInternalLinks(tdb.db, HOSTS)).toEqual([
      { screen: "settings", section: "footer", where: "", path: ["helpLinks", 0, "url"], address: `${HUB}/contact` },
      { screen: "settings", section: "connect", where: "", path: ["policyLink", "url"], address: `${ALIAS}/files/policy.pdf` },
      { screen: "settings", section: "pageText", where: "", path: ["subscribeHelpHtml"], address: `${HUB}/files/help.pdf` },
    ]);
  });
});
