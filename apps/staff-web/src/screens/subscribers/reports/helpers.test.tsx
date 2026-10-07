import { describe, expect, it } from "vitest";
import { ApiError } from "../../../api/client";
import { reportErrorText } from "./errors";
import { bcDate, bcDateTime } from "./format";
import { reportUrl } from "./reportUrl";

describe("report helpers", () => {
  it("builds report URLs from filters only, dropping anything else and empty values", () => {
    expect(reportUrl("/nod/api/reports/x", { list: "ministries:health", timing: "digest", page: 2 })).toBe("/nod/api/reports/x?list=ministries%3Ahealth&timing=digest&page=2");
    expect(reportUrl("/nod/api/reports/x", { from: "", to: undefined })).toBe("/nod/api/reports/x");
    expect(reportUrl("/nod/api/reports/x", { q: "pat@example.test" } as never)).toBe("/nod/api/reports/x");
  });

  it("formats BC dates and times, including after BC stops changing clocks", () => {
    expect(bcDateTime("2026-10-05T16:30:00.000Z", "America/Vancouver")).toBe("2026-10-05 09:30");
    expect(bcDateTime("2026-11-15T20:05:00.000Z", "America/Vancouver")).toBe("2026-11-15 13:05");
    expect(bcDate("2026-11-01T06:30:00.000Z", "America/Vancouver")).toBe("2026-10-31");
  });

  it("explains report errors in plain words", () => {
    const err = (status: number, error?: string) => new ApiError({ status, message: "x", body: error ? { error } : undefined });
    expect(reportErrorText(err(400, "range-too-long"))).toBe("Choose a range of 92 days or fewer.");
    expect(reportErrorText(err(400, "range-reversed"))).toBe("The start date must be on or before the end date.");
    expect(reportErrorText(err(502))).toBe("Distribution is unavailable right now. Try again in a few minutes.");
    expect(reportErrorText(new Error("network"))).toBe("Couldn't load the report. Try again.");
  });
});
