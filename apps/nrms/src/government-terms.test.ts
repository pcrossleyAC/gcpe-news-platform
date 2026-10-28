import { describe, expect, it } from "vitest";
import { addDays, publicTerms, termSpans } from "./government-terms";
import type { governmentTerms } from "./db/schema";

type Row = typeof governmentTerms.$inferSelect;

let n = 0;
function row(name: string, startDate: string | null, extra: Partial<Row> = {}): Row {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name,
    isCurrent: false,
    legacyId: null,
    startDate,
    label: null,
    legacyArchiveUrl: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...extra,
  };
}

describe("termSpans", () => {
  it("computes non-overlapping ranges", () => {
    const spans = termSpans([row("2024-2028", "2024-11-18"), row("2020-2024", "2020-11-26")], "2026-10-28");
    expect(spans.map((s) => ({ startDate: s.startDate, endDate: s.endDate, status: s.status }))).toEqual([
      { startDate: "2020-11-26", endDate: "2024-11-17", status: "past" },
      { startDate: "2024-11-18", endDate: null, status: "current" },
    ]);
    expect(spans[0]!.slug).toBe("2020-2024");
  });

  it("a future term is scheduled and closes the current one in the Hub view only", () => {
    const spans = termSpans([row("2020-2024", "2020-11-26"), row("2024-2028", "2024-11-18"), row("2028-11-20", "2028-11-20")], "2026-10-28");
    expect(spans.map((s) => s.status)).toEqual(["past", "current", "scheduled"]);
    expect(spans[1]!.endDate).toBe("2028-11-19");
    expect(spans[2]!.endDate).toBeNull();
    const pub = publicTerms(spans);
    expect(pub).toHaveLength(2);
    expect(pub[0]).toMatchObject({ slug: "2024-2028", endDate: null });
    expect(pub[1]).toMatchObject({ slug: "2020-2024", endDate: "2024-11-17" });
  });

  it("undated rows are listed last and never current", () => {
    const spans = termSpans([row("tbd", null), row("2024-2028", "2024-11-18"), row("2020-2024", "2020-11-26")], "2026-10-28");
    expect(spans.map((s) => s.slug)).toEqual(["2020-2024", "2024-2028", "tbd"]);
    expect(spans[2]).toMatchObject({ status: "undated", startDate: null, endDate: null });
    expect(publicTerms(spans).map((t) => t.slug)).toEqual(["2024-2028", "2020-2024"]);
  });

  it("the day of the start date is current", () => {
    const rows = [row("2024-2028", "2024-11-18"), row("2028-11-20", "2028-11-20")];
    expect(termSpans(rows, "2028-11-19")[1]!.status).toBe("scheduled");
    const spans = termSpans(rows, "2028-11-20");
    expect(spans.map((s) => s.status)).toEqual(["past", "current"]);
    expect(spans[0]!.endDate).toBe("2028-11-19");
  });

  it("everything is scheduled before the first term starts; none is current", () => {
    const spans = termSpans([row("a", "2030-01-01")], "2026-10-28");
    expect(spans.map((s) => s.status)).toEqual(["scheduled"]);
    expect(publicTerms(spans)).toEqual([]);
  });

  it("carries label, archive url and legacy id through", () => {
    const [s] = termSpans([row("2024-2028", "2024-11-18", { label: "Eby government", legacyArchiveUrl: "https://x/y.htm", legacyId: "abc" })], "2026-10-28");
    expect(s).toMatchObject({ label: "Eby government", legacyArchiveUrl: "https://x/y.htm", legacyId: "abc" });
  });
});

describe("addDays", () => {
  it("does UTC date arithmetic across month, year and leap boundaries", () => {
    expect(addDays("2024-11-18", -1)).toBe("2024-11-17");
    expect(addDays("2025-01-01", -1)).toBe("2024-12-31");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2023-02-28", 1)).toBe("2023-03-01");
    expect(addDays("2026-03-08", 0)).toBe("2026-03-08");
  });
});
