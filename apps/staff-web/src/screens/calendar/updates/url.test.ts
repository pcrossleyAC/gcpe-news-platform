import { describe, expect, it } from "vitest";
import type { FeedQuery } from "@gcpe/calendar-contract";
import { feedQueryOf, paramsOf } from "./url";

const problem = (s: string) => {
  const r = feedQueryOf(new URLSearchParams(s));
  return "problem" in r ? r.problem : null;
};

describe("the Updates screen's address", () => {
  it("opens on Today's updates, as legacy's page did", () => {
    expect(feedQueryOf(new URLSearchParams(""))).toEqual({ query: { mode: "today" } });
  });

  it("reads each view back from what it writes, and writes only what is set", () => {
    const views: FeedQuery[] = [
      { mode: "latest" },
      { mode: "today" },
      { mode: "activity", activity: 20001 },
      { mode: "range", from: "2026-11-01", to: "2026-11-03", type: "created", keyword: "sample" },
      { mode: "range" },
    ];
    for (const q of views) expect(feedQueryOf(paramsOf(q))).toEqual({ query: q });
    expect(paramsOf({ mode: "range", from: "2026-11-01" }).toString()).toBe("mode=range&from=2026-11-01");
  });

  it("trims the search and drops empty values", () => {
    expect(feedQueryOf(new URLSearchParams("mode=range&from=&keyword=%20%20"))).toEqual({ query: { mode: "range" } });
  });

  it("names what is wrong with a hand-edited address", () => {
    expect(problem("mode=bogus")).toBe("That address isn't one of the updates views.");
    expect(problem("mode=range&from=2026-02-30")).toBe("Enter dates as YYYY-MM-DD.");
    expect(problem("mode=range&from=2026-11-05&to=2026-11-01")).toBe("From must be on or before To.");
    expect(problem("mode=range&type=transferred")).toBe("Choose an update type from the list.");
    expect(problem(`mode=range&keyword=${"x".repeat(201)}`)).toBe("Search for at most 200 characters.");
    expect(problem("mode=activity&activity=abc")).toBe("That address doesn't name an activity.");
    expect(problem("mode=activity&activity=0")).toBe("That address doesn't name an activity.");
  });
});
