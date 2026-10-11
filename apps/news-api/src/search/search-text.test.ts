import { describe, expect, it } from "vitest";
import { sampleRelease } from "@gcpe/events/testing";
import { SEARCH_TEXT_MAX_CHARS, searchTextFor } from "./search-text";

describe("searchTextFor", () => {
  it("joins headline, summary, keywords, location, subheadline and the stripped body, skipping empty fields", () => {
    expect(searchTextFor(sampleRelease)).toBe(
      "Traffic-pattern change planned for Highway 11 at Highway 1 Drivers can expect major traffic-pattern changes on Highway 11. Abbotsford Drivers can expect…",
    );
  });

  it("puts every document's headline first, then each document's subheadline and body", () => {
    const doc = sampleRelease.documents[0]!;
    const text = searchTextFor({
      summary: "Summary.",
      keywords: "ferries, schedules",
      location: "Victoria",
      documents: [
        { ...doc, headline: "Main headline", subheadline: "Main sub", detailsHtml: "<p>Main&nbsp;body</p>" },
        { ...doc, languageId: 1036, headline: "Titre", subheadline: null, detailsHtml: "<p>Corps</p>" },
      ],
    });
    expect(text).toBe("Main headline Titre Summary. ferries, schedules Victoria Main sub Main body Corps");
  });

  it("caps the text at 100,000 characters", () => {
    const doc = sampleRelease.documents[0]!;
    const text = searchTextFor({ summary: null, keywords: null, location: null, documents: [{ ...doc, headline: null, detailsHtml: `<p>${"word ".repeat(30_000)}</p>` }] });
    expect(text.length).toBe(SEARCH_TEXT_MAX_CHARS);
  });
});
