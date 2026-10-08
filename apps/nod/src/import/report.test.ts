import { describe, expect, it } from "vitest";
import { NodImportReport } from "./report";

const G1 = "b0000000-0000-4000-8000-000000000001";
const G2 = "c0000000-0000-4000-8000-000000000002";

describe("NodImportReport", () => {
  it("balances legacy = imported + skipped per table", () => {
    const r = new NodImportReport();
    r.count("Subscriber", "legacy", 3);
    r.count("Subscriber", "imported", 2);
    r.skip("Subscriber", "invalid email address", G1);
    expect(r.balanced()).toBe(true);
    r.count("Subscriber", "legacy");
    expect(r.balanced()).toBe(false);
  });

  it("groups skips by table and reason, with a count and at most 10 sample ids", () => {
    const r = new NodImportReport();
    for (let i = 0; i < 12; i++) r.skip("SubscriberList", "subscriber not imported", `${G1}/${G2}`);
    expect(r.toJSON().skipped).toEqual([{ table: "SubscriberList", reason: "subscriber not imported", count: 12, sample: Array(10).fill(`${G1}/${G2}`) }]);
  });

  it("withholds any id that isn't a GUID, so an address can never land in the report", () => {
    const r = new NodImportReport();
    r.skip("Subscriber", "invalid email address", "someone@example.test");
    const json = JSON.stringify(r.toJSON());
    expect(json).toContain("(id withheld)");
    expect(json).not.toContain("@");
    expect(r.toText()).not.toContain("@");
  });

  it("a failed run is never balanced, and its text says where it stopped", () => {
    const r = new NodImportReport();
    r.note("Sends: articles published in legacy's last 30 days, with their recipients.");
    r.markFailed("articles", "connection reset");
    expect(r.balanced()).toBe(false);
    expect(r.toText()).toMatch(/^NoD import report — NOT BALANCED — failed during articles: connection reset/);
    expect(r.toText()).toContain("Sends: articles published");
  });
});
