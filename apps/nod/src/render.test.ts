import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { itemCategories, neutralizeHtml, neutralizeText, renderAsItHappens, renderDigest, renderEmergency, renderSystemShell, type RenderItem, type RenderOptions } from "./render";

const RENDER: RenderOptions = { siteUrl: "https://news.gov.bc.ca", bannerUrl: null };
const RENDER_WITH_BANNER: RenderOptions = { siteUrl: "https://news.gov.bc.ca", bannerUrl: "https://news.gov.bc.ca/assets/banner.png" };

function item(over: Partial<RenderItem> = {}): RenderItem {
  return {
    key: "K-1",
    title: "A test release",
    summary: "A test summary.",
    url: "https://news.gov.bc.ca/releases/K-1",
    publishedAt: new Date("2026-09-22T17:00:00Z"),
    categories: [],
    ...over,
  };
}

describe("subjects", () => {
  it("As-It-Happens: 'BC Gov News - <title>'", () => {
    expect(renderAsItHappens(item({ title: "Highway 11 closure" }), RENDER).subject).toBe("BC Gov News - Highway 11 closure");
  });

  it("Emergency: 'Emergency Info BC - <title>'", () => {
    expect(renderEmergency(item({ title: "Evacuation order" }), RENDER).subject).toBe("Emergency Info BC - Evacuation order");
  });

  it("Digest: fixed 'BCNews - Daily Digest', regardless of items", () => {
    expect(renderDigest([item(), item({ key: "K-2" })], RENDER).subject).toBe("BCNews - Daily Digest");
    expect(renderDigest([], RENDER).subject).toBe("BCNews - Daily Digest");
  });

  it("falls back to the item key (no prefix) for an empty or whitespace-only title", () => {
    expect(renderAsItHappens(item({ key: "K-EMPTY", title: "" }), RENDER).subject).toBe("K-EMPTY");
    expect(renderEmergency(item({ key: "K-WS", title: "   \t\n  " }), RENDER).subject).toBe("K-WS");
  });

  it("truncates a subject over 998 UTF-16 units, ending in '…'", () => {
    const subject = renderAsItHappens(item({ title: "x".repeat(1200) }), RENDER).subject;
    expect(subject.length).toBe(998);
    expect(subject.endsWith("…")).toBe(true);
  });

  it("no '{{' survives in the subject from title content", () => {
    const subject = renderAsItHappens(item({ title: "Update {{manageUrl}} now" }), RENDER).subject;
    expect(subject).not.toContain("{{");
  });
});

describe("content", () => {
  it("footers contain '{{manageUrl}}' and '{{unsubscribeUrl}}' exactly once each (As-It-Happens/emergency/digest)", () => {
    for (const rendered of [
      renderAsItHappens(item(), RENDER),
      renderEmergency(item(), RENDER),
      renderDigest([item(), item({ key: "K-2" })], RENDER),
    ]) {
      expect(rendered.html.match(/\{\{manageUrl\}\}/g)).toHaveLength(1);
      expect(rendered.html.match(/\{\{unsubscribeUrl\}\}/g)).toHaveLength(1);
      expect(rendered.text.match(/\{\{manageUrl\}\}/g)).toHaveLength(1);
      expect(rendered.text.match(/\{\{unsubscribeUrl\}\}/g)).toHaveLength(1);
    }
  });

  it("the digest lists every item's title and url in the given (published) order, each with '▶ READ MORE' and its category line", () => {
    const items = [
      item({ key: "K-1", title: "First release", url: "https://news.gov.bc.ca/releases/K-1", categories: [{ name: "Health", url: "https://news.gov.bc.ca/topics/health" }] }),
      item({ key: "K-2", title: "Second release", url: "https://news.gov.bc.ca/releases/K-2", categories: [{ name: "Economy", url: null }] }),
    ];
    const { html, text } = renderDigest(items, RENDER);
    const firstIdx = html.indexOf("First release");
    const secondIdx = html.indexOf("Second release");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(html).toContain("https://news.gov.bc.ca/releases/K-1");
    expect(html).toContain("https://news.gov.bc.ca/releases/K-2");
    expect(html.match(/READ MORE/g)).toHaveLength(2);
    expect(html).toContain("Health");
    expect(html).toContain("Economy");
    expect(text.indexOf("First release")).toBeLessThan(text.indexOf("Second release"));
    expect(text.match(/Read more:/g)).toHaveLength(2);
  });

  it("the banner is an <img> when bannerUrl is set, else the plain heading", () => {
    const withBanner = renderAsItHappens(item(), RENDER_WITH_BANNER).html;
    expect(withBanner).toContain(`<img src="${RENDER_WITH_BANNER.bannerUrl}"`);
    expect(withBanner).not.toContain("Government of B.C. — News on Demand</td>");

    const withoutBanner = renderAsItHappens(item(), RENDER).html;
    expect(withoutBanner).not.toContain("<img");
    expect(withoutBanner).toContain("Government of B.C.");
  });

  it("'See more from BC Gov News' links to siteUrl, and 'Please do not respond to this message' is present", () => {
    const { html, text } = renderAsItHappens(item(), RENDER);
    expect(html).toContain(`href="${RENDER.siteUrl}"`);
    expect(html).toContain("See more from BC Gov News");
    expect(html).toContain("Please do not respond to this message");
    expect(text).toContain(`See more from BC Gov News: ${RENDER.siteUrl}`);
    expect(text).toContain("Please do not respond to this message.");
  });

  it("the HTML escapes titles and category names", () => {
    const { html } = renderAsItHappens(item({ title: "<b>Bold</b> & co", categories: [{ name: "<i>Health</i> & Safety", url: null }] }), RENDER);
    expect(html).not.toContain("<b>Bold</b>");
    expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt; &amp; co");
    expect(html).not.toContain("<i>Health</i>");
    expect(html).toContain("&lt;i&gt;Health&lt;/i&gt; &amp; Safety");
  });

  it("renderSystemShell carries the banner, the 'See more' link, and the do-not-respond line, with no manage or unsubscribe link", () => {
    const { html, text } = renderSystemShell(RENDER, "<h1>Manage your subscription</h1>", "Manage your subscription");
    expect(html).toContain("Government of B.C.");
    expect(html).toContain(`href="${RENDER.siteUrl}"`);
    expect(html).toContain("See more from BC Gov News");
    expect(html).toContain("Please do not respond to this message");
    expect(html).not.toContain("{{manageUrl}}");
    expect(html).not.toContain("{{unsubscribeUrl}}");
    expect(html).not.toContain("Manage your subscription</a>");
    expect(text).toContain("See more from BC Gov News");
    expect(text).not.toContain("{{manageUrl}}");
  });
});

describe("neutralizeHtml / neutralizeText", () => {
  it("escapes HTML and breaks up every adjacent brace pair, idempotently", () => {
    expect(neutralizeHtml("<script>")).toContain("&lt;script&gt;");
    for (const raw of ["{{x}}", "{{{x}}", "a {{b}} c"]) {
      expect(neutralizeText(raw)).not.toContain("{{");
      expect(neutralizeHtml(raw)).not.toContain("{{");
      expect(neutralizeText(neutralizeText(raw))).toBe(neutralizeText(raw));
    }
  });
});

describe("itemCategories", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNodTestDb();
    // list_categories' ministries/sectors rows are already seeded by the subscriber-model
    // backfill migration (0005) — only the `lists` rows this test needs are inserted here.
    await tdb.db.execute(sql`
      INSERT INTO lists (list_key, category, key, name, topic_url) VALUES
        ('ministries:health', 'ministries', 'health', 'Health', 'https://news.gov.bc.ca/topics/health'),
        ('ministries:education', 'ministries', 'education', 'Education', ''),
        ('sectors:mining', 'sectors', 'mining', 'Mining', 'https://news.gov.bc.ca/topics/mining');
    `);
  });
  afterAll(async () => tdb.drop());

  it("returns names sorted alphabetically case-insensitively, with url from topic_url", async () => {
    const result = await itemCategories(tdb.db, ["sectors:mining", "ministries:health"]);
    expect(result).toEqual([
      { name: "Health", url: "https://news.gov.bc.ca/topics/health" },
      { name: "Mining", url: "https://news.gov.bc.ca/topics/mining" },
    ]);
  });

  it("skips a key with no lists row", async () => {
    const result = await itemCategories(tdb.db, ["ministries:health", "ministries:no-such-key"]);
    expect(result).toEqual([{ name: "Health", url: "https://news.gov.bc.ca/topics/health" }]);
  });

  it("returns a null url when topic_url is empty", async () => {
    const result = await itemCategories(tdb.db, ["ministries:education"]);
    expect(result).toEqual([{ name: "Education", url: null }]);
  });

  it("returns an empty array for an empty list of keys", async () => {
    expect(await itemCategories(tdb.db, [])).toEqual([]);
  });
});
