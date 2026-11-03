import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import type { TestDatabase } from "@gcpe/db-kit";
import type { OrgRecord } from "@gcpe/events";
import { createPublicSiteTestDb } from "../test/helpers";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { bcSettings, post, site } from "../test/fixtures";
import { createSiteBuilder } from "./builder";
import { postIndex } from "./post-index";
import { ICON_SPRITE, previewMinistry } from "./preview";
import type { SyncDeps } from "./sync";

/** An organization record as Core sends it for the preview. */
const org = (o: Omit<Partial<OrgRecord>, "minister"> & { minister?: Partial<OrgRecord["minister"]> } = {}): OrgRecord => ({
  key: "Health",
  displayName: "Health and Wellness",
  abbreviation: "HLTH",
  sortOrder: 10,
  isActive: true,
  parentKey: null,
  url: null,
  displayAdditionalName: null,
  contact: { fullName: "Pat Contact", phoneNumber: "250-555-0100", mobileNumber: null, emailAddress: "pat@example.test" },
  secondContact: null,
  weekendContactNumber: null,
  social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
  topicLinks: [{ text: "Draft topic", url: "https://example.test/topic" }],
  serviceLinks: [],
  teamLinks: [],
  sectorKeys: [],
  isHq: false,
  isPublic: true,
  successorKeys: [],
  updatedAt: "2026-11-02T15:00:00-07:00",
  ...o,
  minister: { name: "Honourable Alex Draft", summary: "Minister of Health", detailsHtml: "<p>Alex grew up in Prince George.</p>", email: "alex@example.test", photoUrl: null, address: null, ...o.minister },
});

describe("ministry preview (C324)", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createPublicSiteTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE site_posts, site_state");
  });

  const setup = () => {
    const storage = memoryStorage();
    const newsApi = fakeNewsApi(new Map([["K1", post({ key: "K1", ministryKeys: ["Health"] })]]));
    newsApi.settings = { revision: 1, document: bcSettings() };
    const index = postIndex(tdb.db);
    const builder = createSiteBuilder({ newsApi, storage, index, site, assetsDir: null });
    const deps: SyncDeps = { db: tdb.db, builder, index, newsApi, storage, site, test: false, batch: 200 };
    return { storage, deps };
  };
  const doc = (html: string) => new JSDOM(html).window.document;

  it("renders the ministry page from the record, with the ministry's live posts, and writes nothing", async () => {
    const { storage, deps } = setup();

    const { ministryPage, biographyPage } = await previewMinistry(deps, org());

    const page = doc(ministryPage);
    expect(page.querySelector("h1")?.textContent).toBe("Health and Wellness");
    const card = page.querySelector(".resource-links.minister")!;
    expect(card.textContent).toContain("Honourable Alex Draft");
    expect(card.textContent).toContain("Minister of Health");
    expect(card.querySelector('a[href="mailto:alex@example.test"]')).not.toBeNull();
    expect(card.querySelector("a.read-more")?.getAttribute("href")).toBe("/ministries/health/biography/");
    expect(page.body.textContent).toContain("Pat Contact");
    expect(page.querySelector('a[href="https://example.test/topic"]')?.textContent).toBe("Draft topic");
    expect(page.querySelector('a[href="/releases/K1/"]')).not.toBeNull();
    // Never indexed; links leave the preview's frame for a new tab.
    expect(page.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex");
    expect(page.querySelector("base")?.getAttribute("target")).toBe("_blank");

    expect(biographyPage).not.toBeNull();
    const bio = doc(biographyPage!);
    expect(bio.querySelector("h1")?.textContent).toBe("Honourable Alex Draft");
    expect(bio.body.textContent).toContain("Alex grew up in Prince George.");

    expect([...storage.files.keys()]).toEqual([]);
  });

  it("carries the icon sprite inside the page and points the icons at it: the Hub's frame can't reach another file", async () => {
    const { storage, deps } = setup();
    await storage.write(ICON_SPRITE, '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><symbol id="i-search" viewBox="0 0 1 1"></symbol></svg>');

    const { ministryPage } = await previewMinistry(deps, org());

    const page = doc(ministryPage);
    expect(page.getElementById("i-search")?.tagName.toLowerCase()).toBe("symbol");
    expect(ministryPage).not.toContain("assets/site/icons.svg");
    const uses = [...page.querySelectorAll("svg.icon use")].map((u) => u.getAttribute("href"));
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((h) => h?.startsWith("#i-"))).toBe(true);
    expect(page.getElementById("site-banner")?.getAttribute("data-icons")).toBe("");
  });

  it("no biography: no biography page and no Read Bio", async () => {
    const { deps } = setup();
    const { ministryPage, biographyPage } = await previewMinistry(deps, org({ minister: { detailsHtml: null } }));
    expect(biographyPage).toBeNull();
    expect(doc(ministryPage).querySelector(".resource-links.minister a.read-more")).toBeNull();
  });

  it("a ministry the News API doesn't have yet renders from the record alone, with no posts", async () => {
    const { deps } = setup();
    const { ministryPage } = await previewMinistry(deps, org({ key: "new-ministry", displayName: "New Ministry" }));
    const page = doc(ministryPage);
    expect(page.querySelector("h1")?.textContent).toBe("New Ministry");
    expect(page.querySelector('a[href="/releases/K1/"]')).toBeNull();
  });
});
