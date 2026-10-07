import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { jsonResponse } from "../../../../test/jsonResponse";
import { renderAt, stubReports } from "../../../../test/reportFixtures";
import { DistributionReportScreen } from "./DistributionReportScreen";

const PATTERN = "/subscribers/reports/distribution";

describe("DistributionReportScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows totals by sending app and counts by day", async () => {
    stubReports(["NoD.Viewer"]);
    renderAt(PATTERN, PATTERN, <DistributionReportScreen />);
    const totals = await screen.findByRole("table", { name: "Totals" });
    expect(within(totals).getByRole("row", { name: /^News On Demand 15 12 1 2 1$/ })).toBeInTheDocument();
    expect(within(totals).getByRole("row", { name: /^All senders 18 14 2 2 1$/ })).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "By day" })).getByRole("row", { name: /^2026-10-06 nrms-client 3 2 1 0 0$/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download (CSV)" })).toHaveAttribute("href", "/nod/api/reports/distribution.csv?from=2026-09-08&to=2026-10-07");
    await waitFor(() => expect(document.title).toBe("Distribution sent and bounced — GCPE News Staff"));
  });

  it("Distribution unavailable: says so, offers no CSV, and keeps the range form", async () => {
    stubReports(["NoD.Viewer"], { "/nod/api/reports/distribution": () => jsonResponse(502, { error: "distribution unavailable" }) });
    renderAt(PATTERN, PATTERN, <DistributionReportScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Distribution is unavailable right now. Try again in a few minutes.");
    expect(screen.queryByRole("link", { name: "Download (CSV)" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show" })).toBeInTheDocument();
  });
});
