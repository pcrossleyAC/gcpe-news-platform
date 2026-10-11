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
    expect(ok({ q: "  wildfire  " })).toEqual({ q: "wildfire", page: 1 });
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

  it("keeps ministry, sector and type", () => {
    expect(ok({ q: "x", ministry: "Health", sector: "economy", type: "stories", page: "3" })).toEqual({
      q: "x", ministry: "Health", sector: "economy", type: "stories", page: 3,
    });
  });

  it.each([
    [{}, "q"],
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
