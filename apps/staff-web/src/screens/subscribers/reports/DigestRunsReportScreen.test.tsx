import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { renderAt, stubReports } from "../../../../test/reportFixtures";
import { DigestRunsReportScreen } from "./DigestRunsReportScreen";

const PATTERN = "/subscribers/reports/digest-runs";

describe("DigestRunsReportScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows each run in BC time with its email counts and the CSV", async () => {
    stubReports(["NoD.Viewer"]);
    renderAt(PATTERN, PATTERN, <DigestRunsReportScreen />);
    expect(await screen.findByRole("row", { name: /^2026-10-06 17:00 2026-10-06 17:00 7 2750 2740 6 4$/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download (CSV)" })).toHaveAttribute("href", "/nod/api/reports/digest-runs.csv?from=2026-09-08&to=2026-10-07");
    await waitFor(() => expect(document.title).toBe("Daily digest runs — GCPE News Staff"));
  });
});
