import { describe, expect, it } from "vitest";
import { ALL_QUERIES, MAX_SINCE_DAYS, qArticles, qSubscriberArticles } from "./queries";

describe("legacy NoD queries", () => {
  it("every query names itself on its first line (the fake source is keyed by it)", () => {
    for (const q of [...ALL_QUERIES, qArticles(30), qSubscriberArticles("c0000000-0000-4000-8000-000000000001")]) expect(q.split("\n")[0]).toMatch(/^-- name: \S+$/);
  });

  it("no query reads SysLog's EntityData or EventData, or any address column but Subscriber's own", () => {
    for (const q of ALL_QUERIES) {
      expect(q).not.toMatch(/EntityData|EventData|SubscriberInfo/);
      if (!q.startsWith("-- name: subscribers\n")) expect(q).not.toMatch(/EmailAddress/);
    }
  });

  it("the window is a whole number of days, 1 to 92", () => {
    expect(qArticles(30)).toContain("DATEADD(day, -30, SYSDATETIMEOFFSET())");
    for (const bad of [0, MAX_SINCE_DAYS + 1, 1.5, Number.NaN]) expect(() => qArticles(bad)).toThrow(RangeError);
  });

  it("an article id must be a GUID before it reaches SQL text", () => {
    expect(qSubscriberArticles("C0000000-0000-4000-8000-000000000001")).toContain("'c0000000-0000-4000-8000-000000000001'");
    expect(() => qSubscriberArticles("x'; DROP TABLE Subscriber; --")).toThrow(RangeError);
  });
});
