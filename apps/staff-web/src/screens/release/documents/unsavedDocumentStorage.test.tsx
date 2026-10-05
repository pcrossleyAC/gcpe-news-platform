import { afterEach, describe, expect, it } from "vitest";
import { clearDraft, loadDraft, saveDraft } from "./unsavedDocumentStorage";

const key = { releaseId: "r1", documentId: "d1", languageId: 4105 };

describe("document draft storage (session-expiry recovery)", () => {
  afterEach(() => sessionStorage.clear());

  it("round-trips a draft", () => {
    expect(loadDraft(key)).toBeNull();
    saveDraft(key, { headline: "Hi" });
    expect(loadDraft<{ headline: string }>(key)).toEqual({ headline: "Hi" });
  });

  it("keys by release id, document id and language separately", () => {
    saveDraft(key, { headline: "EN" });
    saveDraft({ ...key, languageId: 3084 }, { headline: "FR" });
    expect(loadDraft<{ headline: string }>(key)).toEqual({ headline: "EN" });
    expect(loadDraft<{ headline: string }>({ ...key, languageId: 3084 })).toEqual({ headline: "FR" });
  });

  it("clear removes it", () => {
    saveDraft(key, { headline: "Hi" });
    clearDraft(key);
    expect(loadDraft(key)).toBeNull();
  });
});
