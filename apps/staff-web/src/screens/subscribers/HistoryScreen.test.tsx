import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { HistoryScreen } from "./HistoryScreen";

const ID = "11111111-1111-1111-1111-111111111111";

function stub(roles: string[], onHistory: () => [number, unknown]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
      if (url === `/nod/api/subscribers/${ID}/history`) {
        const [status, body] = onHistory();
        return jsonResponse(status, body);
      }
      throw new Error(`unhandled: ${url}`);
    }),
  );
}

function renderAt(path = `/subscribers/${ID}/history`) {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <RequireAuth>
          <Routes>
            <Route path="/subscribers/:id/history" element={<HistoryScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("HistoryScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("lists history newest first with readable actions and actors, and links back", async () => {
    stub(["NoD.Viewer"], () => [
      200,
      {
        items: [
          { at: "2026-10-02T17:00:00.000Z", actor: "Jamie Staff", action: "staff-deactivated", detail: "" },
          { at: "2026-10-01T17:00:00.000Z", actor: "subscriber", action: "subscribed", detail: "ministries:health" },
        ],
      },
    ]);
    renderAt();

    const rows = await screen.findAllByRole("row");
    // rows[0] is the header row.
    expect(rows[1]).toHaveTextContent("Deactivated by staff");
    expect(rows[1]).toHaveTextContent("Jamie Staff");
    expect(rows[2]).toHaveTextContent("Subscribed (confirmed by email)");
    expect(rows[2]).toHaveTextContent("Subscriber");
    expect(rows[2]).toHaveTextContent("ministries:health");

    expect(screen.getByRole("link", { name: "Back to subscriber" })).toHaveAttribute("href", `/subscribers/${ID}`);
    await waitFor(() => expect(document.title).toBe("Subscriber history — GCPE News Staff"));
  });

  it("an unknown subscriber shows not found", async () => {
    stub(["NoD.Viewer"], () => [404, { error: "not found" }]);
    renderAt();
    expect(await screen.findByText("Subscriber not found.")).toBeInTheDocument();
  });
});
