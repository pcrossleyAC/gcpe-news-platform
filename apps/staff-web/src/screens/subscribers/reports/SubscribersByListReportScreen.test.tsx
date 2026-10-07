import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { calledUrls, renderAt, stubReports } from "../../../../test/reportFixtures";
import { SubscribersByListReportScreen } from "./SubscribersByListReportScreen";

const PATTERN = "/subscribers/reports/subscribers-by-list";

describe("SubscribersByListReportScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows counts by list, and a Viewer gets the counts CSV but not the members CSV", async () => {
    stubReports(["NoD.Viewer"]);
    renderAt(`${PATTERN}?list=ministries%3Ahealth`, PATTERN, <SubscribersByListReportScreen />);
    expect(await screen.findByRole("row", { name: /^All active subscribers 120 100 40/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /^Health 40 35 12/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /^Old ministry \(retired\) 2 2 0/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Themes" })).toBeNull();
    expect(screen.getByRole("link", { name: "Download counts (CSV)" })).toHaveAttribute("href", "/nod/api/reports/subscribers-by-list.csv");
    expect(await screen.findByRole("link", { name: "pat@example.test" })).toHaveAttribute("href", "/subscribers/11111111-1111-1111-1111-111111111111");
    expect(screen.getByRole("row", { name: /lee@example\.test Daily digest Added by staff 2026-11-15/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Download members (CSV)" })).toBeNull();
    await waitFor(() => expect(document.title).toBe("Active subscribers by list — GCPE News Staff"));
  });

  it("gives an Editor the members CSV for the chosen list and timing", async () => {
    stubReports(["NoD.Editor"]);
    renderAt(`${PATTERN}?list=ministries%3Ahealth&timing=digest`, PATTERN, <SubscribersByListReportScreen />);
    expect(await screen.findByRole("link", { name: "Download members (CSV)" })).toHaveAttribute(
      "href",
      "/nod/api/reports/subscribers-by-list/members.csv?list=ministries%3Ahealth&timing=digest",
    );
  });

  it("loads the members of the list chosen, and again when the timing changes", async () => {
    const fetchMock = stubReports(["NoD.Viewer"]);
    renderAt(PATTERN, PATTERN, <SubscribersByListReportScreen />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: "Show members of Health" }));
    await waitFor(() => expect(calledUrls(fetchMock)).toContain("/nod/api/reports/subscribers-by-list/members?list=ministries%3Ahealth&timing=any"));
    await user.selectOptions(await screen.findByLabelText("Timing"), "digest");
    await waitFor(() => expect(calledUrls(fetchMock)).toContain("/nod/api/reports/subscribers-by-list/members?list=ministries%3Ahealth&timing=digest"));
  });

  it("says so when a list no longer exists", async () => {
    stubReports(["NoD.Viewer"], { "/nod/api/reports/subscribers-by-list/members": () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }) });
    renderAt(`${PATTERN}?list=ministries%3Agone`, PATTERN, <SubscribersByListReportScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("That list doesn't exist any more.");
  });
});
