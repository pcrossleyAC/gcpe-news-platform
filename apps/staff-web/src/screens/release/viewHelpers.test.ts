import { describe, expect, it } from "vitest";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { englishOf, firstDocument, headlineOf, releaseLanguageOf } from "./viewHelpers";

describe("firstDocument / headlineOf", () => {
  it("picks the document with the lowest sortIndex, regardless of array order", () => {
    const v = releaseView({
      documents: [
        { id: "second", sortIndex: 1, layout: "formal", languages: [{ languageId: 4105, pageTitle: "p", headline: "Second", subheadline: null, organizations: null, byline: null, bodyHtml: "<p>b</p>", pageImageId: null, contacts: [] }] },
        { id: "first", sortIndex: 0, layout: "formal", languages: [{ languageId: 4105, pageTitle: "p", headline: "First", subheadline: null, organizations: null, byline: null, bodyHtml: "<p>b</p>", pageImageId: null, contacts: [] }] },
      ],
    });
    expect(firstDocument(v)?.id).toBe("first");
    expect(headlineOf(v)).toBe("First");
  });

  it("returns an empty headline when there are no documents", () => {
    const v = releaseView({ documents: [] });
    expect(headlineOf(v)).toBe("");
  });

  it("englishOf finds the LANG_EN language entry, not just the first one", () => {
    const doc = firstDocument(
      releaseView({
        documents: [
          {
            id: "d1", sortIndex: 0, layout: "formal",
            languages: [
              { languageId: 3084, pageTitle: "p", headline: "Titre", subheadline: null, organizations: null, byline: null, bodyHtml: "<p>c</p>", pageImageId: null, contacts: [] },
              { languageId: 4105, pageTitle: "p", headline: "Title", subheadline: null, organizations: null, byline: null, bodyHtml: "<p>b</p>", pageImageId: null, contacts: [] },
            ],
          },
        ],
      }),
    );
    expect(englishOf(doc)?.headline).toBe("Title");
  });
});

describe("releaseLanguageOf", () => {
  it("defaults to English", () => {
    const v = releaseView({ languages: [{ languageId: 4105, location: "VICTORIA", summary: "S", summaryEdited: false, socialMediaSummary: null }] });
    expect(releaseLanguageOf(v)?.location).toBe("VICTORIA");
  });

  it("returns undefined when that language has no row", () => {
    const v = releaseView({ languages: [] });
    expect(releaseLanguageOf(v)).toBeUndefined();
  });
});
