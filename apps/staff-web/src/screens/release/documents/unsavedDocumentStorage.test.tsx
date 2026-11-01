import { afterEach, describe, expect, it } from "vitest";
import { clearAllDrafts, clearDraft, clearReleaseDrafts, loadDraft, saveDraft } from "./unsavedDocumentStorage";

const key = { userId: "user-a", releaseId: "r1", documentId: "d1", languageId: 4105 };

describe("document draft storage (session-expiry recovery)", () => {
  afterEach(() => sessionStorage.clear());

  it("round-trips a draft", () => {
    expect(loadDraft(key)).toBeNull();
    saveDraft(key, { version: 1, form: { headline: "Hi" } });
    expect(loadDraft<{ headline: string }>(key)).toEqual({ version: 1, form: { headline: "Hi" } });
  });

  it("keys by release id, document id and language separately", () => {
    saveDraft(key, { version: 1, form: { headline: "EN" } });
    saveDraft({ ...key, languageId: 3084 }, { version: 1, form: { headline: "FR" } });
    expect(loadDraft<{ headline: string }>(key)).toEqual({ version: 1, form: { headline: "EN" } });
    expect(loadDraft<{ headline: string }>({ ...key, languageId: 3084 })).toEqual({ version: 1, form: { headline: "FR" } });
  });

  it("clear removes it", () => {
    saveDraft(key, { version: 1, form: { headline: "Hi" } });
    clearDraft(key);
    expect(loadDraft(key)).toBeNull();
  });

  // Fix round 1, finding 1: a shared machine — user B signing in on the same tab must never see
  // user A's unsaved text, even for the exact same release/document/language.
  it("keys by signed-in user id — a different user's draft is invisible", () => {
    saveDraft(key, { version: 1, form: { headline: "A's draft" } });
    expect(loadDraft<{ headline: string }>({ ...key, userId: "user-b" })).toBeNull();
    expect(loadDraft<{ headline: string }>(key)).toEqual({ version: 1, form: { headline: "A's draft" } });
  });

  it("clearAllDrafts removes every draft, for every user and release, but leaves other sessionStorage keys alone", () => {
    saveDraft(key, { version: 1, form: { headline: "A's draft" } });
    saveDraft({ ...key, userId: "user-b", releaseId: "r2" }, { version: 1, form: { headline: "B's draft" } });
    sessionStorage.setItem("unrelated-key", "keep me");

    clearAllDrafts();

    expect(loadDraft(key)).toBeNull();
    expect(loadDraft({ ...key, userId: "user-b", releaseId: "r2" })).toBeNull();
    expect(sessionStorage.getItem("unrelated-key")).toBe("keep me");
  });

  // Suite review R3: a draft carries the release version it was based on, so a restored draft
  // over newer content is a conflict rather than a silent overwrite.
  it("keeps the version the draft was based on", () => {
    saveDraft(key, { version: 7, form: { headline: "Hi" } });
    expect(loadDraft<{ headline: string }>(key)).toEqual({ version: 7, form: { headline: "Hi" } });
  });

  it("ignores a draft kept in the old shape, with no version", () => {
    sessionStorage.setItem(`gcpe-nrms-draft:${key.userId}:${key.releaseId}:${key.documentId}:${key.languageId}`, JSON.stringify({ headline: "Old" }));
    expect(loadDraft(key)).toBeNull();
  });

  // Suite review R3: Leave discards the changes, so every kept draft of that release (for that
  // user) goes too; other releases' and other users' drafts stay.
  it("clearReleaseDrafts removes one user's drafts of one release only", () => {
    saveDraft(key, { version: 1, form: { headline: "EN" } });
    saveDraft({ ...key, documentId: "d2", languageId: 3084 }, { version: 1, form: { headline: "FR" } });
    saveDraft({ ...key, releaseId: "r2" }, { version: 1, form: { headline: "Other release" } });
    saveDraft({ ...key, userId: "user-b" }, { version: 1, form: { headline: "Other user" } });

    clearReleaseDrafts(key.userId, key.releaseId);

    expect(loadDraft(key)).toBeNull();
    expect(loadDraft({ ...key, documentId: "d2", languageId: 3084 })).toBeNull();
    expect(loadDraft({ ...key, releaseId: "r2" })).not.toBeNull();
    expect(loadDraft({ ...key, userId: "user-b" })).not.toBeNull();
  });
});
