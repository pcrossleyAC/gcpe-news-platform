import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { jsonResponse } from "../../../../test/jsonResponse";
import { calledUrls, RELEASE_SENDS, renderAt, stubReports } from "../../../../test/reportFixtures";
import { ReleaseSendsReportScreen } from "./ReleaseSendsReportScreen";

const PATTERN = "/subscribers/reports/release-sends";

describe("ReleaseSendsReportScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows each release's counts by mode in BC time, with the range the server used and its CSV", async () => {
    stubReports(["NoD.Viewer"]);
    renderAt(PATTERN, PATTERN, <ReleaseSendsReportScreen />);
    expect(await screen.findByRole("row", { name: /^2026-10-06 09:30 Budget 2027 News release 4 1 2 1 1 1 0 0$/ })).toBeInTheDocument();
    expect(screen.getByLabelText("From (BC date)")).toHaveValue("2026-09-08");
    expect(screen.getByLabelText("To (BC date)")).toHaveValue("2026-10-07");
    expect(screen.getByRole("link", { name: "Download (CSV)" })).toHaveAttribute("href", "/nod/api/reports/release-sends.csv?from=2026-09-08&to=2026-10-07");
    await waitFor(() => expect(document.title).toBe("Sends per release — GCPE News Staff"));
  });

  it("asks for the range in the URL, and for a new one when staff change it", async () => {
    const fetchMock = stubReports(["NoD.Viewer"]);
    renderAt(`${PATTERN}?from=2026-09-01&to=2026-09-30`, PATTERN, <ReleaseSendsReportScreen />);
    await waitFor(() => expect(calledUrls(fetchMock)).toContain("/nod/api/reports/release-sends?from=2026-09-01&to=2026-09-30"));
    await screen.findByRole("row", { name: /Budget 2027/ });
    fireEvent.change(screen.getByLabelText("From (BC date)"), { target: { value: "2026-08-01" } });
    fireEvent.change(screen.getByLabelText("To (BC date)"), { target: { value: "2026-08-31" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(calledUrls(fetchMock)).toContain("/nod/api/reports/release-sends?from=2026-08-01&to=2026-08-31"));
  });

  it("keeps what staff type while the first report is still loading, and fills in the rest", async () => {
    let answer: (r: Response) => void = () => undefined;
    stubReports(["NoD.Viewer"], { "/nod/api/reports/release-sends": () => new Promise<Response>((resolve) => (answer = resolve)) });
    renderAt(PATTERN, PATTERN, <ReleaseSendsReportScreen />);
    fireEvent.change(await screen.findByLabelText("From (BC date)"), { target: { value: "2026-08-01" } });
    answer(jsonResponse(200, RELEASE_SENDS));
    await screen.findByRole("row", { name: /Budget 2027/ });
    expect(screen.getByLabelText("From (BC date)")).toHaveValue("2026-08-01");
    expect(screen.getByLabelText("To (BC date)")).toHaveValue("2026-10-07");
  });

  it("says its counts are handed off and not bounced, not delivered, and where the rest are", async () => {
    stubReports(["NoD.Viewer"]);
    renderAt(PATTERN, PATTERN, <ReleaseSendsReportScreen />);
    await screen.findByRole("row", { name: /Budget 2027/ });
    expect(screen.getAllByRole("columnheader", { name: "Handed off, not bounced" })).toHaveLength(2);
    expect(screen.queryByRole("columnheader", { name: /delivered/i })).toBeNull();
    expect(screen.getByText(/counts emails handed to Distribution, minus bounces/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Distribution sent and bounced" })).toHaveAttribute("href", "/subscribers/reports/distribution");
  });

  it("explains a range that's too long", async () => {
    stubReports(["NoD.Viewer"], {
      "/nod/api/reports/release-sends": () => new Response(JSON.stringify({ error: "range-too-long", maxDays: 92 }), { status: 400, headers: { "content-type": "application/json" } }),
    });
    renderAt(`${PATTERN}?from=2026-01-01&to=2026-06-30`, PATTERN, <ReleaseSendsReportScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a range of 92 days or fewer.");
    expect(screen.queryByRole("link", { name: "Download (CSV)" })).toBeNull();
  });
});
