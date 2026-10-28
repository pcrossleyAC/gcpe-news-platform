import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "./query";

const TZ = "America/Vancouver";
const ok = (raw: Record<string, unknown>) => {
  const r = parseSearchQuery(raw, TZ);
  if (!r.ok) throw new Error(`expected ok, got ${r.parameter}`);
  return r.query;
};

describe("parseSearchQuery", () => {
  it("trims q and defaults page to 1", () => {
    expect(ok({ q: "  wildfire  " })).toEqual({ q: "wildfire", page: 1, pageSize: 20 });
  });

  it("counts q in code points: 200 emoji pass, 201 characters fail", () => {
    expect(ok({ q: "🔥".repeat(200) }).q).toHaveLength(400);
    expect(parseSearchQuery({ q: "a".repeat(201) }, TZ)).toMatchObject({ ok: false, parameter: "q" });
  });

  it("turns from and to into whole BC calendar days", () => {
    const q = ok({ q: "x", from: "2026-10-01", to: "2026-10-01" });
    expect(q.from?.toISOString()).toBe("2026-10-01T07:00:00.000Z");
    expect(q.toExclusive?.toISOString()).toBe("2026-10-02T07:00:00.000Z");
    // After BC's permanent UTC-7 (2026-11-01) and before it, the offset comes from tzdata.
    expect(ok({ q: "x", from: "2027-01-15" }).from?.toISOString()).toBe("2027-01-15T07:00:00.000Z");
  });

  it("q may be missing or blank when a filter is given (filter-only search); not otherwise", () => {
    expect(ok({ ministry: "citizens-services" })).toEqual({ q: "", ministry: "citizens-services", page: 1, pageSize: 20 });
    expect(ok({ q: "  ", sector: "economy", page: "2" })).toEqual({ q: "", sector: "economy", page: 2, pageSize: 20 });
    expect(ok({ type: "stories" }).q).toBe("");
    expect(ok({ from: "2026-10-01" }).q).toBe("");
    expect(ok({ to: "2026-10-01" }).q).toBe("");
    expect(parseSearchQuery({ page: "2" }, TZ)).toMatchObject({ ok: false, parameter: "q" });
  });

  it("keeps ministry, sector and type", () => {
    expect(ok({ q: "x", ministry: "Health", sector: "economy", type: "stories", page: "3" })).toEqual({
      q: "x", ministry: "Health", sector: "economy", type: "stories", page: 3, pageSize: 20,
    });
  });

  it("pageSize is 10 or 20 (default 20); the page limit is 1000 / pageSize", () => {
    expect(ok({ q: "x", pageSize: "10", page: "100" })).toMatchObject({ pageSize: 10, page: 100 });
    expect(ok({ q: "x", pageSize: "20", page: "50" })).toMatchObject({ pageSize: 20, page: 50 });
    expect(ok({ q: "x" }).pageSize).toBe(20);
    const bad = parseSearchQuery({ q: "x", pageSize: "15" }, TZ);
    expect(bad).toEqual({ ok: false, parameter: "pageSize", message: "pageSize must be 10 or 20" });
    expect(parseSearchQuery({ q: "x", pageSize: "10", page: "101" }, TZ)).toEqual({ ok: false, parameter: "page", message: "page must be a whole number from 1 to 100" });
    expect(parseSearchQuery({ q: "x", page: "51" }, TZ)).toEqual({ ok: false, parameter: "page", message: "page must be a whole number from 1 to 50" });
  });

  it("facets=1 asks for facets; absent means none; any other value is refused", () => {
    expect(ok({ q: "x", facets: "1" }).facets).toBe(true);
    expect(ok({ q: "x" }).facets).toBeUndefined();
    expect(parseSearchQuery({ q: "x", facets: "0" }, TZ)).toMatchObject({ ok: false, parameter: "facets" });
    expect(parseSearchQuery({ q: "x", facets: ["1", "1"] }, TZ)).toMatchObject({ ok: false, parameter: "facets" });
  });

  it.each([
    [{}, "q"],
    [{ q: "x", pageSize: "" }, "pageSize"],
    [{ q: "x", pageSize: "010" }, "pageSize"],
    [{ q: "x", pageSize: ["10", "20"] }, "pageSize"],
    [{ q: "   " }, "q"],
    [{ q: ["a", "b"] }, "q"],
    [{ q: "x", page: "0" }, "page"],
    [{ q: "x", page: "51" }, "page"],
    [{ q: "x", page: "1.5" }, "page"],
    [{ q: "x", page: "abc" }, "page"],
    [{ q: "x", page: ["1", "2"] }, "page"],
    [{ q: "x", type: "memos" }, "type"],
    [{ q: "x", ministry: "" }, "ministry"],
    [{ q: "x", sector: "s".repeat(101) }, "sector"],
    [{ q: "x", from: "2026-02-30" }, "from"],
    [{ q: "x", from: "0099-01-01" }, "from"],
    [{ q: "x", from: "2026-1-5" }, "from"],
    [{ q: "x", to: "2200-01-01" }, "to"],
    [{ q: "x", from: "2026-10-02", to: "2026-10-01" }, "to"],
    [{ q: "x\u0000y" }, "q"],
    [{ q: "x", ministry: "Health\u0000" }, "ministry"],
    [{ q: "x", sector: "\u0000economy" }, "sector"],
  ])("refuses %j, naming %s", (raw, parameter) => {
    const r = parseSearchQuery(raw as Record<string, unknown>, TZ);
    expect(r).toMatchObject({ ok: false, parameter });
  });
});
