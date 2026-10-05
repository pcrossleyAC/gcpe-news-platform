import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { HistorySection } from "./HistorySection";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const VIEW = releaseView();

describe("HistorySection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads the log (without `all`) and the publications list on mount", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes("/log")) return jsonResponse(200, [{ at: "Today 2:30 PM", actorName: "Pat", text: "Approved" }]);
        return jsonResponse(200, [{ id: 1, publishedAt: "Today 3:00 PM", actorName: "Pat" }]);
      }),
    );
    render(<HistorySection view={VIEW} />);
    expect(await screen.findByText(/Approved/)).toBeInTheDocument();
    expect(await screen.findByText(/Today 3:00 PM/)).toBeInTheDocument();
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
    render(<HistorySection view={VIEW} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "Show all" }));
    await waitFor(() => expect(calls).toContain(`/nrms/api/releases/${VIEW.id}/log?all=true`));
  });
});
