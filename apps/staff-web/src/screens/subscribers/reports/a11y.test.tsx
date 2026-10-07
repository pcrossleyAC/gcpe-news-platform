/** axe checks for the Reports screens (wcag2a/wcag2aa, serious and critical). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import axe from "axe-core";
import { renderAt, stubReports } from "../../../../test/reportFixtures";
import { DigestRunsReportScreen } from "./DigestRunsReportScreen";
import { DistributionReportScreen } from "./DistributionReportScreen";
import { ReleaseSendsReportScreen } from "./ReleaseSendsReportScreen";
import { ReportsScreen } from "./ReportsScreen";
import { SubscribersByListReportScreen } from "./SubscribersByListReportScreen";
import { UnsubscribesReportScreen } from "./UnsubscribesReportScreen";

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

describe("accessibility — Reports", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("ReportsScreen", async () => {
    stubReports(["NoD.Viewer"]);
    const { container } = renderAt("/subscribers/reports", "/subscribers/reports", <ReportsScreen />);
    await screen.findByRole("link", { name: "Recent unsubscribes" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("SubscribersByListReportScreen with members open (Editor)", async () => {
    stubReports(["NoD.Editor"]);
    const path = "/subscribers/reports/subscribers-by-list";
    const { container } = renderAt(`${path}?list=ministries%3Ahealth`, path, <SubscribersByListReportScreen />);
    await screen.findByRole("link", { name: "pat@example.test" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("UnsubscribesReportScreen (Editor)", async () => {
    stubReports(["NoD.Editor"]);
    const path = "/subscribers/reports/unsubscribes";
    const { container } = renderAt(path, path, <UnsubscribesReportScreen />);
    await screen.findByRole("link", { name: "gone@example.test" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it.each([
    ["release-sends", () => <ReleaseSendsReportScreen />, "Budget 2027"],
    ["digest-runs", () => <DigestRunsReportScreen />, "2750"],
    ["distribution", () => <DistributionReportScreen />, "nrms-client"],
  ])("%s report", async (slug, element, text) => {
    stubReports(["NoD.Viewer"]);
    const path = `/subscribers/reports/${slug}`;
    const { container } = renderAt(path, path, element());
    await screen.findAllByText(text);
    expect(await seriousViolations(container)).toEqual([]);
  });
});
