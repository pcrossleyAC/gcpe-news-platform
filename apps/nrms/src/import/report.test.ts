import { describe, expect, it } from "vitest";
import { ImportReport } from "./report";

describe("ImportReport", () => {
  it("balances when every legacy row is accounted for as imported or skipped", () => {
    const report = new ImportReport();
    report.count("releases", "legacy", 3);
    report.count("releases", "imported", 2);
    report.skip("releases", "11111111-1111-1111-1111-111111111111", "edited in NRMS since the last import");
    expect(report.balanced()).toBe(true);
  });

  it("a missing skip makes balanced() false", () => {
    const report = new ImportReport();
    report.count("releases", "legacy", 3);
    report.count("releases", "imported", 2);
    expect(report.balanced()).toBe(false);
  });

  it("toText lists skipped rows with reasons and validation warnings", () => {
    const report = new ImportReport();
    report.count("releases", "legacy", 2);
    report.count("releases", "imported", 1);
    report.skip("releases", "11111111-1111-1111-1111-111111111111", "edited in NRMS since the last import");
    report.warn("22222222-2222-2222-2222-222222222222", "2026HLTH0001-000001", ["Missing required field: headline"]);
    const text = report.toText();
    expect(text).toContain("11111111-1111-1111-1111-111111111111");
    expect(text).toContain("edited in NRMS since the last import");
    expect(text).toContain("22222222-2222-2222-2222-222222222222");
    expect(text).toContain("Missing required field: headline");
  });

  it("never prints connection details such as a URL or password", () => {
    const report = new ImportReport();
    report.count("releases", "legacy", 1);
    report.count("releases", "imported", 1);
    const text = report.toText();
    const json = JSON.stringify(report.toJSON());
    for (const secret of ["LEGACY_SQL_PASSWORD", "postgres://", "sqlserver://", "password"]) {
      expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
      expect(json.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  it("toJSON reports per-table counts and whether the report balances", () => {
    const report = new ImportReport();
    report.count("releases", "legacy", 2);
    report.count("releases", "imported", 2);
    expect(report.toJSON()).toMatchObject({ balanced: true, tables: { releases: { legacy: 2, imported: 2, skipped: 0 } } });
  });

  // I2: a whole stage skipped outright (e.g. the website import, when an edit blocks it) has no
  // legacy/imported row count to balance -- it's a note for a human, not a table.
  it("skipStage records a whole-stage skip without affecting balanced() or any table's counts", () => {
    const report = new ImportReport();
    report.count("releases", "legacy", 2);
    report.count("releases", "imported", 2);
    report.skipStage("website", "website edited in NRMS since the last import");
    expect(report.balanced()).toBe(true);
    expect(report.toJSON().tables.website).toBeUndefined();
    expect(report.toJSON().skippedStages).toEqual([{ stage: "website", reason: "website edited in NRMS since the last import" }]);
  });

  it("toText lists a skipped stage with its reason", () => {
    const report = new ImportReport();
    report.skipStage("website", "website edited in NRMS since the last import");
    const text = report.toText();
    expect(text).toContain("website");
    expect(text).toContain("website edited in NRMS since the last import");
  });
});
