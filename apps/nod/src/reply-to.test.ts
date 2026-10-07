import { describe, expect, it } from "vitest";
import { replyToFor } from "./reply-to";

const opts = { news: "news-reply@example.test" };

describe("replyToFor", () => {
  it("NRMS release items (releases, advisories, stories, factsheets, legacy updates) reply to NOD_REPLY_TO", () => {
    expect(replyToFor("release", opts)).toBe("news-reply@example.test");
  });
  it("everything else carries no Reply-To: emergency items, digests (no item), system mail", () => {
    expect(replyToFor("emergency", opts)).toBeUndefined();
    expect(replyToFor(null, opts)).toBeUndefined();
  });
  it("no Reply-To at all when NOD_REPLY_TO is unset (test sites)", () => {
    expect(replyToFor("release", {})).toBeUndefined();
  });
});
