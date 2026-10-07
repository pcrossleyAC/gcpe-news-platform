import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { renderAt, stubReports } from "../../../../test/reportFixtures";
import { ReportsScreen } from "./ReportsScreen";

describe("ReportsScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("links every report", async () => {
    stubReports(["NoD.Viewer"]);
    renderAt("/subscribers/reports", "/subscribers/reports", <ReportsScreen />);
    const expected: [string, string][] = [
      ["Active subscribers by list", "/subscribers/reports/subscribers-by-list"],
      ["Recent unsubscribes", "/subscribers/reports/unsubscribes"],
      ["Sends per release", "/subscribers/reports/release-sends"],
      ["Daily digest runs", "/subscribers/reports/digest-runs"],
      ["Distribution sent and bounced", "/subscribers/reports/distribution"],
    ];
    for (const [name, href] of expected) expect(await screen.findByRole("link", { name })).toHaveAttribute("href", href);
    await waitFor(() => expect(document.title).toBe("Reports — GCPE News Staff"));
  });
});
