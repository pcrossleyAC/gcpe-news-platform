import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { itemCategories, neutralizeHtml, neutralizeText, renderAsItHappens, renderDigest, renderEmergency, renderMedia, renderSystemShell, type RenderItem, type RenderOptions } from "./render";

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

  // Controller ruling: an empty title's subject still carries the prefix —
  // "<prefix> - <key>", not the bare key alone.
  it("falls back to '<prefix> - <key>' (not the bare key) for an empty or whitespace-only title", () => {
    expect(renderAsItHappens(item({ key: "2026CITZ0001-000004", title: "" }), RENDER).subject).toBe("BC Gov News - 2026CITZ0001-000004");
    expect(renderEmergency(item({ key: "K-WS", title: "   \t\n  " }), RENDER).subject).toBe("Emergency Info BC - K-WS");
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

  // Ported from the old as-it-happens.test.ts (these pins must not be lost in the
  // render.ts move): collapses CR/LF/tabs to single spaces, trims, and still neutralises '{{'.
  // A raw title with embedded CR/LF/tabs would otherwise smuggle extra header lines into
  // the SMTP Subject header (Distribution 400s on line breaks — terminal, nobody mailed).
  it("collapses CR/LF/tabs in the subject to single spaces, trims, and neutralises '{{'", () => {
    const subject = renderAsItHappens(item({ title: "  Highway 11\r\nclosure\tand {{manageUrl}} update  " }), RENDER).subject;
    expect(subject).toBe("BC Gov News - Highway 11 closure and { {manageUrl}} update");
    expect(subject).not.toMatch(/[\r\n\t]/);
  });

  // Ported from the old as-it-happens.test.ts. Distribution's own max(998) is
  // `z.string().max(998)`, which counts UTF-16 *code units* — a code-point-based truncation
  // would let a 600-emoji title (600 code points, but 1200 UTF-16 units — astral emoji are
  // surrogate pairs) straight through unmodified, well over the real limit. Also proves no
  // lone surrogate is left dangling at the cut point.
  it("truncates a subject measured in UTF-16 units, not code points, without splitting a surrogate pair (600 emoji)", () => {
    const subject = renderAsItHappens(item({ title: "😀".repeat(600) }), RENDER).subject; // 600 code points, 1200 UTF-16 units
    expect(subject.length).toBeLessThanOrEqual(998);
    expect(subject.endsWith("…")).toBe(true);
    const prefix = "BC Gov News - ";
    expect(subject.startsWith(prefix)).toBe(true);
    const emoji = subject.slice(prefix.length, -1);
    // An even number of units and every code point a complete "😀" proves no dangling half
    // of a surrogate pair was left in.
    expect(emoji.length % 2).toBe(0);
    expect([...emoji].every((ch) => ch === "😀")).toBe(true);
  });

  // Ported from the old as-it-happens.test.ts. P2-R25 item 2: replacing each `{{` pair
  // once left a bypass — `{{{manageUrl}}` became `{ {{manageUrl}}`, whose tail is a live
  // placeholder again. Every `{` next to another `{` is broken up, so no `{{name}}` can survive
  // in item content, however many braces lead it. (Distribution matches
  // /\{\{([A-Za-z0-9_]+)\}\}/ — apps/distribution/src/substitute.ts.) Only the two real footer
  // placeholders (`{{manageUrl}}`, `{{unsubscribeUrl}}`) stay live, in both html and text.
  describe("the '{{{manageUrl}}' bypass stays closed", () => {
    const livePlaceholders = (s: string) => s.match(/\{\{([A-Za-z0-9_]+)\}\}/g) ?? [];

    it.each([
      ["{{{manageUrl}}", "{ { {manageUrl}}", "{&#123;&#123;manageUrl}}"],
      ["{{{{manageUrl}}}}", "{ { { {manageUrl}}}}", "{&#123;&#123;&#123;manageUrl}}}}"],
      ["{ {manageUrl}}", "{ {manageUrl}}", "{ {manageUrl}}"],
    ])("neutralises %j in item content so only the two footer placeholders are live", (raw, expectedText, expectedHtml) => {
      const { subject, html, text } = renderAsItHappens(item({ title: raw, summary: raw }), RENDER);

      expect(livePlaceholders(text)).toEqual(["{{manageUrl}}", "{{unsubscribeUrl}}"]);
      expect(livePlaceholders(html)).toEqual(["{{manageUrl}}", "{{unsubscribeUrl}}"]);
      expect(livePlaceholders(subject)).toEqual([]);
      expect(text).toContain(`${expectedText}\n\n${expectedText}`);
      expect(html).toContain(expectedHtml);
      expect(subject).toBe(`BC Gov News - ${expectedText}`);
    });
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

describe("renderMedia", () => {
  function mediaItem(over: Partial<RenderItem & { mediaText: string; postKind: string | null }> = {}) {
    return {
      ...item(),
      postKind: "releases" as string | null,
      mediaText: "Paragraph one.\r\n\r\nParagraph two,\r\nsecond line.",
      ...over,
    };
  }

  it("has no banner, and the standard footer with '{{manageUrl}}'/'{{unsubscribeUrl}}' exactly once each", () => {
    const { html, text } = renderMedia(mediaItem(), RENDER);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("Government of B.C.");
    expect(html.match(/\{\{manageUrl\}\}/g)).toHaveLength(1);
    expect(html.match(/\{\{unsubscribeUrl\}\}/g)).toHaveLength(1);
    expect(text.match(/\{\{manageUrl\}\}/g)).toHaveLength(1);
    expect(text.match(/\{\{unsubscribeUrl\}\}/g)).toHaveLength(1);
  });

  it("renders the full text as paragraphs, with its own single newlines as <br>", () => {
    const { html, text } = renderMedia(mediaItem(), RENDER);
    expect(html).toContain("<p style=\"margin:0 0 16px;\">Paragraph one.</p>");
    expect(html).toContain("<p style=\"margin:0 0 16px;\">Paragraph two,<br>second line.</p>");
    expect(text).toContain("Paragraph one.\n\nParagraph two,\nsecond line.");
  });

  it("'▶ READ MORE' is present for a release, absent for an advisory", () => {
    const release = renderMedia(mediaItem({ postKind: "releases" }), RENDER);
    expect(release.html).toContain("READ MORE");
    expect(release.text).toContain(`Read more: ${mediaItem().url}`);

    const advisory = renderMedia(mediaItem({ postKind: "advisories" }), RENDER);
    expect(advisory.html).not.toContain("READ MORE");
    expect(advisory.text).not.toContain("Read more:");
  });

  it("the advisory subject is the bare title; the release subject is 'BC Gov News - <title>'", () => {
    const advisory = renderMedia(mediaItem({ postKind: "advisories", title: "Road closure tour" }), RENDER);
    expect(advisory.subject).toBe("Road closure tour");

    const release = renderMedia(mediaItem({ postKind: "releases", title: "Road closure tour" }), RENDER);
    expect(release.subject).toBe("BC Gov News - Road closure tour");
  });

  it("the advisory subject falls back to the item key when the title is empty", () => {
    const advisory = renderMedia(mediaItem({ postKind: "advisories", title: "   ", key: "2026ADV0001-000001" }), RENDER);
    expect(advisory.subject).toBe("2026ADV0001-000001");
  });

  it("drops the lines following 'MEDIA ADVISORY - EVENT REMINDER' up to the next blank line", () => {
    const mediaText = "MEDIA ADVISORY - EVENT REMINDER\r\nPremier to announce housing plan\r\nMore details here.\r\n\r\nLocation stays the same.";
    const { text } = renderMedia(mediaItem({ postKind: "advisories", mediaText }), RENDER);
    expect(text).toContain("MEDIA ADVISORY - EVENT REMINDER");
    expect(text).not.toContain("Premier to announce housing plan");
    expect(text).not.toContain("More details here.");
    expect(text).toContain("Location stays the same.");
  });

  it("does not drop the reminder's following lines for a non-advisory post kind", () => {
    const mediaText = "MEDIA ADVISORY - EVENT REMINDER\r\nPremier to announce housing plan\r\n\r\nLocation stays the same.";
    const { text } = renderMedia(mediaItem({ postKind: "releases", mediaText }), RENDER);
    expect(text).toContain("Premier to announce housing plan");
  });

  it("the text is HTML-escaped", () => {
    const { html } = renderMedia(mediaItem({ mediaText: "<b>Bold</b> & co" }), RENDER);
    expect(html).not.toContain("<b>Bold</b>");
    expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt; &amp; co");
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
