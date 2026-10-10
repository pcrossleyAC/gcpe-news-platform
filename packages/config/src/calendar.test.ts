import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { calendarTenantSchema } from "./calendar";
import { loadTenantConfig } from "./tenant";

const bc = () => loadTenantConfig(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url)));

describe("the tenant calendar section", () => {
  it("BC carries legacy's values (spec addendum §5.1)", () => {
    const c = bc().calendar!;
    expect(c.freeze).toEqual({ start: "16:00", end: "17:00" });
    expect(c.releaseCategoryIds).toEqual([12, 58]);
    expect(c.awarenessCategoryIds).toEqual([2]);
    expect(c.otherCityId).toBe(311);
    expect(c.unconfirmedIssueCommMaterialId).toBe(61);
    expect(c.consultationsMinistryAbbreviation).toBe("CITENG");
    expect(c.contactMinistryExcludedAbbreviations).toEqual(["UNK", "BCWS"]);
    expect(c.translationsDefault).toHaveLength(25);
    expect(c.required).toEqual({ significance: true, scheduling: true, strategy: false });
    expect(c.showHqCommentsField).toBe(false);
    expect(c.showRecordsSection).toBe(false);
    expect(c.cloneKeptKeywordNames).toEqual(["30-60-90"]);
    // Scripts/activityhelper.ts:170-196: the categories that hide the Release fieldset.
    expect(c.releaseHiddenCategoryNames).toHaveLength(8);
    expect(c.releaseHiddenCategoryNames).toContain("Awareness Day / Week / Month");
    expect(c.lookAheadCoverImage).toBeNull();
  });

  it("BC's report texts and RLS codes are legacy's (ActivityHandler.ashx.cs:1176-1257, C148)", () => {
    const r = bc().calendar!.reports;
    expect(r.rlsMaterials.map((m) => m.code)).toEqual(["NR", "IB", "OpEd", "Report", "STMT", "TA", "NYCU", "Fact Sheet", "e-news"]);
    expect(r.rlsMaterials.find((m) => m.code === "Fact Sheet")!.contains).toEqual(["Fact Sheet", "Factsheet"]);
    expect(r.rlsMaterials.filter((m) => m.notInEvents).map((m) => m.code)).toEqual(["Report", "e-news"]);
    expect(r.rlsOrigins.map((o) => o.code)).toEqual(["BCGov", "Joint", "3rd party", "Fed"]);
    expect(r.leadAbbreviations).toEqual({ GCPEHQ: "HQ" });
    expect(r.cover.lines).toEqual(["BC GOVERNMENT", "CORPORATE LOOK AHEAD"]);
  });

  it("refuses a report rule with no text to match", () => {
    const c = bc().calendar!;
    expect(calendarTenantSchema.safeParse({ ...c, reports: { ...c.reports, rlsOrigins: [{ contains: [], code: "X" }] } }).success).toBe(false);
  });

  it("is optional: a tenant without it still loads", () => {
    const nb = loadTenantConfig(fileURLToPath(new URL("../../../config/tenants/nb.json", import.meta.url)));
    expect(nb.calendar).toBeUndefined();
  });

  it("refuses a malformed time and an unknown key", () => {
    const c = bc().calendar!;
    expect(calendarTenantSchema.safeParse({ ...c, freeze: { start: "4pm", end: "17:00" } }).success).toBe(false);
    expect(calendarTenantSchema.safeParse({ ...c, freezeZone: "UTC" }).success).toBe(false);
  });
});
