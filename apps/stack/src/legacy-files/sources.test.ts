import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { applyRelease } from "../../../news-api/src/projections";
import { createNewsTestDb } from "../../../news-api/test/helpers";
import { extractFromFileText, scanDatabase, SCAN_TABLES } from "./sources";

describe("extractFromFileText (--scan-file)", () => {
  it("searches every string of a JSON file, so HTML attributes inside JSON keep names with spaces", () => {
    const json = JSON.stringify([{ details: '<a href="https://news.gov.bc.ca/files/Two Words.pdf">x</a>' }, { other: "no links" }]);
    expect(extractFromFileText(json).paths).toEqual(["Two Words.pdf"]);
  });
  it("searches any other file as text (an IIS log)", () => {
    expect(extractFromFileText("2026-10-01 00:00:01 GET /files/From%20Log.pdf - 443 - 1.2.3.4 200\n").paths).toEqual(["From Log.pdf"]);
  });
});

describe("scanDatabase (News API database)", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
    const body = `<p>See <a href="https://news.gov.bc.ca/files/Q1_%20MediaDeck.pdf">the deck</a> and <img src="/files/Newsroom/Images/Map.png"></p>`;
    await tdb.db.transaction((tx) =>
      applyRelease(tx, { ...sampleRelease, summary: "Summary links http://www.news.gov.bc.ca/files/Summary.pdf too.", documents: [{ ...sampleRelease.documents[0]!, detailsHtml: body }] }, { notify: false, origin: "legacy" }),
    );
    await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "2026TT0104-001122", reference: "NEWS-1", documents: [{ ...sampleRelease.documents[0]!, detailsHtml: "<p>nothing</p>" }] }, { notify: false, origin: "legacy" }));
    await tdb.pool.query("INSERT INTO resource_links (sort_index, text, uri, timestamp) VALUES (1, 'Licence', 'https://news.gov.bc.ca/files/News_Footage_License_British_Columbia.pdf', now()), (2, 'Bad', '/files/../../etc/passwd', now())");
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it("finds every legacy /files/ link in post bodies, summaries and other tables, decoded, and skips tables it doesn't have", async () => {
    const r = await scanDatabase(tdb.pool, [...SCAN_TABLES.NEWSAPI, "no_such_table"]);
    expect([...r.extracted.paths].sort()).toEqual(["News_Footage_License_British_Columbia.pdf", "Newsroom/Images/Map.png", "Q1_ MediaDeck.pdf", "Summary.pdf"].sort());
    expect(r.extracted.rejected.map((x) => x.reference)).toEqual(["../../etc/passwd"]);
    expect(r.rows).toMatchObject({ posts: 1, resource_links: 2 });
    expect(r.rows.no_such_table).toBeUndefined();
  });
});
