import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { jsonResponse } from "../../../../test/jsonResponse";
import { HistorySection } from "./HistorySection";

const VIEW = releaseView();

describe("HistorySection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows each entry's time in BC time with the app's date wording, not the raw ISO instant", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-10T17:00:00Z") });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/log")) return jsonResponse(200, [{ at: "2026-10-10T16:49:04.637Z", actorName: "Pat", text: "Approved" }]);
        return jsonResponse(200, [{ id: 1, publishedAt: "2026-10-03T19:05:00.000Z", actorName: "Pat" }]);
      }),
    );
    render(<HistorySection view={VIEW} timeZone="America/Vancouver" />);
    expect(await screen.findByText("Today 9:49 AM — Pat: Approved")).toBeInTheDocument();
    expect(await screen.findByText("Oct 3, 2026 12:05 PM — Pat")).toBeInTheDocument();
    expect(screen.queryByText(/2026-10-10T16:49/)).toBeNull();
    vi.useRealTimers();
  });

  it("loads the log (without `all`) and the publications list on mount", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes("/log")) return jsonResponse(200, [{ at: "2026-10-10T21:30:00Z", actorName: "Pat", text: "Approved" }]);
        return jsonResponse(200, [{ id: 1, publishedAt: "2026-01-15T23:00:00Z", actorName: "Pat" }]);
      }),
    );
    render(<HistorySection view={VIEW} timeZone="America/Vancouver" />);
    expect(await screen.findByText(/Approved/)).toBeInTheDocument();
    expect(await screen.findByText(/Jan 15, 2026 3:00 PM/)).toBeInTheDocument();
    await waitFor(() => expect(calls).toContain(`/nrms/api/releases/${VIEW.id}/log`));
  });

  it("Show all adds ?all=true to the log request", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(200, []);
      }),
    );
    render(<HistorySection view={VIEW} timeZone="America/Vancouver" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "Show all" }));
    await waitFor(() => expect(calls).toContain(`/nrms/api/releases/${VIEW.id}/log?all=true`));
  });
});
