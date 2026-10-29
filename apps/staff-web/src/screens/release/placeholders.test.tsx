import { describe, expect, it } from "vitest";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { placeholderHits } from "./placeholders";

const withDoc = (over: Record<string, unknown>) => {
  const v = releaseView();
  const doc = v.documents[0]!;
  return releaseView({ documents: [{ ...doc, languages: [{ ...doc.languages[0]!, ...over }] }] });
};

describe("placeholderHits", () => {
  it("finds nothing in ordinary text", () => {
    expect(placeholderHits(withDoc({ headline: "Exxon and the TBDX report", bodyHtml: "<p>Nothing left to fill in.</p>" }))).toEqual([]);
  });

  it("finds each placeholder, case-insensitively, and says where it is with some context", () => {
    const hits = placeholderHits(
      withDoc({
        headline: "Funding tbd",
        bodyHtml: "<p>The minister will speak at <b>[INSERT VENUE]</b>. Quote to come. Cost is $XX million; date TBC.</p>",
      }),
    );
    expect(hits).toEqual([
      { where: "Document 1 (English) headline", text: "tbd", context: "Funding tbd" },
      { where: "Document 1 (English) body", text: "[INSERT", context: "The minister will speak at [INSERT VENUE]. Quote to come. Cost…" },
      { where: "Document 1 (English) body", text: "to come", context: "…at [INSERT VENUE]. Quote to come. Cost is $XX million; date…" },
      { where: "Document 1 (English) body", text: "XX", context: "…Quote to come. Cost is $XX million; date TBC." },
      { where: "Document 1 (English) body", text: "TBC", context: "…Cost is $XX million; date TBC." },
    ]);
  });

  it("looks in the summary and location too", () => {
    const v = releaseView();
    const hits = placeholderHits(releaseView({ languages: [{ ...v.languages[0]!, location: "XXX", summary: "Details to come" }] }));
    expect(hits.map((h) => h.where)).toEqual(["Location (English)", "Summary (English)"]);
  });
});
