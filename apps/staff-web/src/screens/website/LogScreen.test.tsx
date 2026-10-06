import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { jsonResponse } from "../../../test/jsonResponse";
import { LogScreen } from "./LogScreen";
import type { SiteLogEntry } from "./types";

const ENTRIES: SiteLogEntry[] = [
  { at: "2026-10-05T12:00:00.000Z", actorName: "Pat", area: "carousel", text: "Saved the live carousel" },
];

describe("LogScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // I5: document.title matches the h1.
  it("sets the document title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url.startsWith("/nrms/api/site/log")) return jsonResponse(200, ENTRIES);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(<LogScreen />);
    await screen.findByRole("heading", { name: "Website log", level: 1 });
    expect(document.title).toBe("Website log — GCPE News Staff");
  });

  it("loads the unfiltered log, then refetches with the chosen area", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url === "/nrms/api/site/log?limit=200") return jsonResponse(200, ENTRIES);
        if (url === "/nrms/api/site/log?area=blue-bridge&limit=200") return jsonResponse(200, []);
        throw new Error(`unhandled: ${url}`);
      }),
    );

    render(<LogScreen />);
    await screen.findByText("Saved the live carousel");

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Filter by area"), "Project Blue Bridge");

    await waitFor(() => expect(calls).toContain("/nrms/api/site/log?area=blue-bridge&limit=200"));
    await screen.findByText("No log entries yet.");
  });
});
