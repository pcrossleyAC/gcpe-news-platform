import { describe, expect, it } from "vitest";
import { approveProblems, assetUrlProblem, publishProblems, statusText, typeRules } from "./rules";
import { view } from "./testing";

describe("typeRules", () => {
  it("matches legacy per-type behaviour", () => {
    expect(typeRules("advisory")).toMatchObject({ mediaListsAllowed: true, mediaListRequired: true, categoriesBeyondMinistries: false, assetsAllowed: false, keyEditable: false, unpublishable: false, generatesKey: true, pageImageAllowed: false });
    expect(typeRules("story")).toMatchObject({ mediaListsAllowed: false, keyEditable: true, generatesKey: false, nodAllowed: true });
    expect(typeRules("update")).toMatchObject({ mediaListsAllowed: false, generatesKey: true, nodAllowed: false, creatable: false });
    expect(typeRules("release").defaultPublishOptions(false)).toEqual({ toWeb: true, toSubscribers: true, toMediaLists: false });
    expect(typeRules("factsheet").defaultPublishOptions(true)).toEqual({ toWeb: true, toSubscribers: false, toMediaLists: true });
    expect(typeRules("advisory").defaultPublishOptions(true)).toEqual({ toWeb: false, toSubscribers: false, toMediaLists: true });
  });
});

describe("assetUrlProblem", () => {
  it("accepts Flickr, YouTube and the live page; refuses Facebook and others", () => {
    for (const ok of ["https://www.flickr.com/photos/bcgovphotos/123/", "https://flic.kr/p/2abc", "https://www.youtube.com/watch?v=x", "https://youtu.be/x", "https://news.gov.bc.ca/live"]) expect(assetUrlProblem(ok)).toBeNull();
    expect(assetUrlProblem("https://www.facebook.com/x")).toMatch(/Facebook is no longer supported/);
    expect(assetUrlProblem("ftp://flickr.com/x")).toMatch(/http/);
    expect(assetUrlProblem("not a url")).toMatch(/absolute/);
    expect(assetUrlProblem("https://example.com/x")).toMatch(/YouTube or Flickr/);
  });
});

describe("statusText", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  it("uses legacy wording", () => {
    expect(statusText({ status: "draft", type: "release", reference: null, publishAt: null }, now)).toBe("Draft");
    expect(statusText({ status: "approved", type: "release", reference: "NEWS-00001", publishAt: null }, now)).toBe("Approved");
    expect(statusText({ status: "approved", type: "release", reference: "NEWS-00001", publishAt: "2026-10-04T12:00:00Z" }, now)).toBe("Planned");
    expect(statusText({ status: "scheduled", type: "release", reference: "NEWS-00001", publishAt: "2026-10-04T12:00:00Z" }, now)).toBe("Scheduled");
    expect(statusText({ status: "scheduled", type: "release", reference: "NEWS-00001", publishAt: "2026-10-03T11:59:00Z" }, now)).toBe("Publishing...");
    expect(statusText({ status: "publishing", type: "release", reference: "NEWS-00001", publishAt: null }, now)).toBe("Republishing...");
    expect(statusText({ status: "published", type: "advisory", reference: "NEWS-00001", publishAt: null }, now)).toBe("Sent");
    expect(statusText({ status: "unpublishing", type: "advisory", reference: "NEWS-00001", publishAt: null }, now)).toBe("Unscheduling...");
    expect(statusText({ status: "unpublishing", type: "release", reference: "NEWS-00001", publishAt: null }, now)).toBe("Unpublishing...");
  });
});

describe("approveProblems / publishProblems", () => {
  it("non-advisories need a lead ministry to approve", () => {
    expect(approveProblems(view())).toEqual([]);
    expect(approveProblems(view({ leadMinistryKey: null, ministries: [] }))).toEqual(["Choose at least one ministry."]);
    expect(approveProblems(view({ leadMinistryKey: null, ministries: ["health", "finance"] }))).toEqual(["Choose the lead ministry."]);
    expect(approveProblems(view({ type: "advisory", leadMinistryKey: null, ministries: [] }))).toEqual([]);
  });
  it("lists everything that blocks publishing", () => {
    expect(publishProblems(view({ publishAt: "2026-10-04T12:00:00Z" }))).toEqual([]);
    const bad = view({
      sectors: [],
      documents: [{ id: "d1", sortIndex: 0, layout: "formal", languages: [
        { languageId: 4105, pageTitle: "", headline: " ", subheadline: null, organizations: null, byline: null, bodyHtml: "<p></p>", pageImageId: null, contacts: [] },
        { languageId: 3084, pageTitle: "Communiqué", headline: "Titre", subheadline: null, organizations: "Ministère", byline: null, bodyHtml: "", pageImageId: null, contacts: [] },
      ] }],
    });
    expect(publishProblems(bad)).toEqual([
      "Choose at least one sector.",
      "Document 1 (English) needs a headline.",
      "Document 1 (English) needs body text.",
      "Document 1 (English) needs organizations (formal layout).",
      "Document 1 (French) needs body text.",
    ]);
    expect(publishProblems(view({ type: "advisory", sectors: [], mediaListKeys: [] }))).toContain("Choose at least one media distribution list.");
  });
});
