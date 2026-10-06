import { describe, expect, it } from "vitest";
import { releaseRecordSchema } from "@gcpe/events";
import { view } from "@gcpe/nrms-contract/testing";
import { assertPublishable, splitContact, toReleaseRecord } from "./record";
import { ReleaseTooLargeError } from "./errors";

const at = { publishDate: "2026-10-04T16:00:00.000Z", timestamp: "2026-10-04T16:00:05.000Z" };

describe("toReleaseRecord", () => {
  it("maps a view to a valid release record", () => {
    const v = view({ key: "2026HLTH0001-000001", reference: "NEWS-00001", publishAt: at.publishDate });
    const r = toReleaseRecord(v, at);
    expect(releaseRecordSchema.parse(r)).toEqual(r);
    expect(r).toMatchObject({ key: "2026HLTH0001-000001", kind: "releases", reference: "NEWS-00001", atomId: `uuid:${v.id}`, location: "VICTORIA", summary: "Clinics open.", isNewsOnDemand: true, renditions: null });
    expect(r.documents[0]).toEqual({ pageTitle: "News Release", languageId: 4105, headline: "Clinics open", subheadline: null, detailsHtml: "<p>Body</p>", byline: null, contacts: [{ title: "Media Relations", details: "250-555-0100" }] });
  });
  it("orders English documents before French and keeps bylines only for informal layout", () => {
    const v = view({
      key: "k",
      documents: [
        { id: "d1", sortIndex: 0, layout: "informal", languages: [
          { languageId: 3084, pageTitle: "FR", headline: "Fr", subheadline: null, organizations: null, byline: "Par X", bodyHtml: "<p>f</p>", pageImageId: null, contacts: [] },
          { languageId: 4105, pageTitle: "EN", headline: "En", subheadline: null, organizations: null, byline: "By X", bodyHtml: "<p>e</p>", pageImageId: null, contacts: [] },
        ] },
        { id: "d2", sortIndex: 1, layout: "formal", languages: [{ languageId: 4105, pageTitle: "BG", headline: "Bg", subheadline: null, organizations: "Org", byline: "x", bodyHtml: "<p>b</p>", pageImageId: null, contacts: [] }] },
      ],
    });
    expect(toReleaseRecord(v, at).documents.map((d) => [d.languageId, d.headline, d.byline])).toEqual([[4105, "En", "By X"], [4105, "Bg", null], [3084, "Fr", "Par X"]]);
  });
  it("sanitises body HTML so copied or legacy markup never reaches the News API unsanitised", () => {
    const v = view({
      key: "k",
      documents: [{ id: "d", sortIndex: 0, layout: "formal", languages: [{
        languageId: 4105, pageTitle: "T", headline: "H", subheadline: null, organizations: "O", byline: null,
        bodyHtml: '<p>Hi<img src="x" onerror="alert(1)"> <a href="javascript:bad()">there</a></p><script>bad()</script>', pageImageId: null, contacts: [],
      }] }],
    });
    expect(toReleaseRecord(v, at).documents[0]!.detailsHtml).toBe("<p>Hi <a>there</a></p>");
  });
  it("splitContact and the size guard", () => {
    expect(splitContact("Title\r\nLine 1\nLine 2")).toEqual({ title: "Title", details: "Line 1\nLine 2" });
    const huge = view({ key: "k", documents: [{ id: "d", sortIndex: 0, layout: "formal", languages: [{ languageId: 4105, pageTitle: "T", headline: "H", subheadline: null, organizations: "O", byline: null, bodyHtml: "x".repeat(2_000_000), pageImageId: null, contacts: [] }] }] });
    expect(() => assertPublishable(toReleaseRecord(huge, at))).toThrow(ReleaseTooLargeError);
  });
});
