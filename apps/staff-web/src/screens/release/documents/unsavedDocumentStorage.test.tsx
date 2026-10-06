import { afterEach, describe, expect, it } from "vitest";
import { clearAllDrafts, clearDraft, loadDraft, saveDraft } from "./unsavedDocumentStorage";

const key = { userId: "user-a", releaseId: "r1", documentId: "d1", languageId: 4105 };

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

  // Fix round 1, finding 1: a shared machine — user B signing in on the same tab must never see
  // user A's unsaved text, even for the exact same release/document/language.
  it("keys by signed-in user id — a different user's draft is invisible", () => {
    saveDraft(key, { headline: "A's draft" });
    expect(loadDraft<{ headline: string }>({ ...key, userId: "user-b" })).toBeNull();
    expect(loadDraft<{ headline: string }>(key)).toEqual({ headline: "A's draft" });
  });

  it("clearAllDrafts removes every draft, for every user and release, but leaves other sessionStorage keys alone", () => {
    saveDraft(key, { headline: "A's draft" });
    saveDraft({ ...key, userId: "user-b", releaseId: "r2" }, { headline: "B's draft" });
    sessionStorage.setItem("unrelated-key", "keep me");

    clearAllDrafts();

    expect(loadDraft(key)).toBeNull();
    expect(loadDraft({ ...key, userId: "user-b", releaseId: "r2" })).toBeNull();
    expect(sessionStorage.getItem("unrelated-key")).toBe("keep me");
  });
});
