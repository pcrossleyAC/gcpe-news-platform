import { describe, expect, it, vi } from "vitest";
import type { DistributionClient } from "../distribution-client";
import { csvLine } from "./csv";
import { distributionCsvRows, distributionReport } from "./distribution";
import { resolveRange } from "./range";

const BC = "America/Vancouver";

describe("distribution report", () => {
  it("asks Distribution for BC-midnight boundaries and labels, totals and dates its rows", async () => {
    const dailyReport = vi.fn().mockResolvedValue({
      rows: [
        { day: 0, appId: "nod-client", sent: 10, hardBounced: 1, softBounced: 2, failed: 1 },
        { day: 1, appId: "nod-client", sent: 5, hardBounced: 0, softBounced: 0, failed: 0 },
        { day: 1, appId: "nrms-client", sent: 3, hardBounced: 1, softBounced: 0, failed: 0 },
      ],
    });
    const range = resolveRange({ from: "2026-10-31", to: "2026-11-01" }, "2026-11-05", BC);
    const report = await distributionReport({ dailyReport } as unknown as Pick<DistributionClient, "dailyReport">, range, "nod-client");

    expect(dailyReport).toHaveBeenCalledWith(["2026-10-31T07:00:00.000Z", "2026-11-01T07:00:00.000Z", "2026-11-02T07:00:00.000Z"]);
    expect(report.totals).toEqual({ sent: 18, delivered: 14, hardBounced: 2, softBounced: 2, failed: 1 });
    expect(report.apps).toEqual([
      { app: "News On Demand", sent: 15, delivered: 12, hardBounced: 1, softBounced: 2, failed: 1 },
      { app: "nrms-client", sent: 3, delivered: 2, hardBounced: 1, softBounced: 0, failed: 0 },
    ]);
    expect(report.days.map((d) => [d.date, d.app, d.sent])).toEqual([
      ["2026-11-01", "News On Demand", 5],
      ["2026-11-01", "nrms-client", 3],
      ["2026-10-31", "News On Demand", 10],
    ]);
    expect(distributionCsvRows(report).map((r) => csvLine(r))).toContain("2026-10-31,News On Demand,10,7,1,2,1\r\n");
  });
});
