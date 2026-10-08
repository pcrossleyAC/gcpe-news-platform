import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { DeadLettersScreen } from "./DeadLettersScreen";

const ROW = { eventId: "11111111-1111-4111-8111-111111111111", subscriber: "nrms", type: "activity.updated", aggregateId: "activity:7", attempts: 9, lastError: "HTTP 503", createdAt: "2026-09-01T00:00:00.000Z", queuedAtBc: "2026-08-31 17:00" };

const RETRY_NAME = "Retry activity.updated for activity:7 to nrms, queued 2026-08-31 17:00";
const SESSION = { user: { id: "s1", name: "Sam", email: "sam@x.invalid", roles: ["Calendar.SysAdmin"] }, expiresAt: new Date().toISOString() };

function stub(calls: string[], rowsAfterRetry: unknown[]) {
  let retried = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "s1", name: "Sam", email: "sam@x.invalid", roles: ["Calendar.SysAdmin"] }, expiresAt: new Date().toISOString() });
      if (url === "/calendar/api/dead-letters") return jsonResponse(200, { items: retried ? rowsAfterRetry : [ROW], truncated: false });
      if (url === "/calendar/api/dead-letters/retry") {
        retried = true;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unhandled: ${url}`);
    }),
  );
}

const renderScreen = () =>
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/calendar/dead-letters"]}>
        <RequireAuth>
          <Routes>
            <Route path="/calendar/dead-letters" element={<DeadLettersScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );

describe("DeadLettersScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists undelivered events and retries one", async () => {
    const calls: string[] = [];
    stub(calls, []);
    renderScreen();
    const row = (await screen.findByText("activity:7")).closest("tr")!;
    expect(within(row).getByText("HTTP 503")).toBeInTheDocument();
    await userEvent.setup().click(within(row).getByRole("button", { name: RETRY_NAME }));
    expect(await screen.findByRole("status")).toHaveTextContent("Queued for delivery again.");
    expect(calls).toContain("POST /calendar/api/dead-letters/retry");
    expect(await screen.findByText("Nothing is waiting: every event was delivered.")).toBeInTheDocument();
  });

  it("says to check the subscriber when a retried event is back on the list", async () => {
    stub([], [ROW]);
    renderScreen();
    await userEvent.setup().click(await screen.findByRole("button", { name: RETRY_NAME }));
    expect(await screen.findByRole("status")).toHaveTextContent("Queued for delivery again. If it comes back here after the next minute, the receiving app is still refusing it: check it before retrying.");
  });

  it("never shows an activity's payload, only its id", async () => {
    stub([], []);
    renderScreen();
    const row = (await screen.findByText("activity:7")).closest("tr")!;
    expect(within(row).queryByText(/payload/i)).toBeNull();
    for (const key of Object.keys(ROW)) {
      if (key !== "aggregateId" && key !== "type" && key !== "subscriber" && key !== "attempts" && key !== "lastError" && key !== "queuedAtBc") {
        expect(screen.queryByText(String((ROW as Record<string, unknown>)[key]))).toBeNull();
      }
    }
  });

  it("clears an earlier result when a retry fails", async () => {
    let retries = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, SESSION);
        if (url === "/calendar/api/dead-letters") return jsonResponse(200, { items: [ROW], truncated: false });
        if (url === "/calendar/api/dead-letters/retry") return ++retries === 1 ? new Response(null, { status: 204 }) : jsonResponse(404, { error: "not found" });
        throw new Error(`unhandled: ${url}`);
      }),
    );
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: RETRY_NAME }));
    expect(await screen.findByRole("status")).toHaveTextContent("Queued for delivery again.");
    await user.click(screen.getByRole("button", { name: RETRY_NAME }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not found");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("disables Retry while its request is in flight", async () => {
    let finish!: (r: Response) => void;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/core/auth/session") return jsonResponse(200, SESSION);
        if (url === "/calendar/api/dead-letters") return jsonResponse(200, { items: [ROW], truncated: false });
        if (url === "/calendar/api/dead-letters/retry") return new Promise<Response>((r) => (finish = r));
        throw new Error(`unhandled: ${url}`);
      }),
    );
    renderScreen();
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: RETRY_NAME });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);
    expect(calls.filter((c) => c === "POST /calendar/api/dead-letters/retry")).toHaveLength(1);
    finish(new Response(null, { status: 204 }));
    expect(await screen.findByRole("status")).toHaveTextContent("Queued for delivery again.");
  });

  it("says when only the most recent are listed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, SESSION);
        if (url === "/calendar/api/dead-letters") return jsonResponse(200, { items: [ROW], truncated: true });
        throw new Error(`unhandled: ${url}`);
      }),
    );
    renderScreen();
    expect(await screen.findByText("Only the 200 most recent are listed.")).toBeInTheDocument();
  });
});
