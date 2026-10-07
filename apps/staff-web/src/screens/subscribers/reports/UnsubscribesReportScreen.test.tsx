import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { calledUrls, renderAt, stubReports } from "../../../../test/reportFixtures";
import { UnsubscribesReportScreen } from "./UnsubscribesReportScreen";

const PATTERN = "/subscribers/reports/unsubscribes";

describe("UnsubscribesReportScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows who left, how and when in BC time, the window's counts, and a Viewer gets counts only", async () => {
    stubReports(["NoD.Viewer"]);
    renderAt(PATTERN, PATTERN, <UnsubscribesReportScreen />);
    expect(await screen.findByText("Since 2026-07-09: 12 new subscriptions, 3 returning, 5 unsubscribed, 1 deleted by staff.")).toBeInTheDocument();
    expect(screen.getByText("2 people unsubscribed or were deleted since 2026-07-09.")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /gone@example\.test Unsubscribed 2026-10-05 09:30 Deleted 2026-01-02/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /back@example\.test Deleted by staff 2026-10-01 09:30 Active 2025-05-02/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download daily counts (CSV)" })).toHaveAttribute("href", "/nod/api/reports/unsubscribes/daily.csv");
    expect(screen.queryByRole("link", { name: "Download list with addresses (CSV)" })).toBeNull();
    await waitFor(() => expect(document.title).toBe("Recent unsubscribes — GCPE News Staff"));
  });

  it("gives an Editor the address CSV", async () => {
    stubReports(["NoD.Editor"]);
    renderAt(PATTERN, PATTERN, <UnsubscribesReportScreen />);
    expect(await screen.findByRole("link", { name: "Download list with addresses (CSV)" })).toHaveAttribute("href", "/nod/api/reports/unsubscribes.csv");
  });

  it("takes its page from the URL", async () => {
    const fetchMock = stubReports(["NoD.Viewer"]);
    renderAt(`${PATTERN}?page=2`, PATTERN, <UnsubscribesReportScreen />);
    await waitFor(() => expect(calledUrls(fetchMock)).toContain("/nod/api/reports/unsubscribes?page=2"));
  });
});
