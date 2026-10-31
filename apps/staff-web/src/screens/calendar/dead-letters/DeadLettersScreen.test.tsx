import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { DeadLettersScreen } from "./DeadLettersScreen";

const ROW = { eventId: "11111111-1111-4111-8111-111111111111", subscriber: "nrms", type: "activity.updated", aggregateId: "activity:7", activityReference: "HLTH-7", attempts: 9, lastError: "HTTP 503", createdAt: "2026-09-01T00:00:00.000Z", queuedAtBc: "2026-08-31 17:00" };

const RETRY_NAME = "Retry Activity changed for HLTH-7 to Releases, queued 2026-08-31 17:00";
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
    const row = (await screen.findByText("HLTH-7")).closest("tr")!;
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

  it("shows the event, activity and app in plain words, never the internal names", async () => {
    stub([], []);
    renderScreen();
    const row = (await screen.findByText("HLTH-7")).closest("tr")!;
    expect(within(row).getAllByRole("cell").map((c) => c.textContent).slice(0, 3)).toEqual(["Activity changed", "HLTH-7", "Releases"]);
    for (const raw of ["activity.updated", "activity:7", "nrms"]) expect(screen.queryByText(raw)).toBeNull();
  });

  it.each([
    ["activity.created", "New activity"],
    ["activity.deleted", "Activity deleted"],
  ])("names %s as %s; an activity the System Administrator can't see by its number only", async (type, label) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, SESSION);
        if (url === "/calendar/api/dead-letters") return jsonResponse(200, { items: [{ ...ROW, type, activityReference: null }], truncated: false });
        throw new Error(`unhandled: ${url}`);
      }),
    );
    renderScreen();
    const row = (await screen.findByText(label)).closest("tr")!;
    expect(within(row).getByText("Activity 7")).toBeInTheDocument();
  });

  it("never shows an activity's payload, only its reference", async () => {
    stub([], []);
    renderScreen();
    const row = (await screen.findByText("HLTH-7")).closest("tr")!;
    expect(within(row).queryByText(/payload/i)).toBeNull();
    for (const key of Object.keys(ROW)) {
      if (key !== "activityReference" && key !== "aggregateId" && key !== "type" && key !== "subscriber" && key !== "attempts" && key !== "lastError" && key !== "queuedAtBc") {
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
    await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "true"));
    expect(button).not.toHaveAttribute("disabled");
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

  const failing = (status: number) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, SESSION);
        if (url === "/calendar/api/dead-letters") return jsonResponse(status, { error: status === 403 ? "forbidden" : "boom" });
        throw new Error(`unhandled: ${url}`);
      }),
    );

  it("keeps its h1 in every state: a 403 is the app's usual permission message, anything else a load failure", async () => {
    failing(403);
    renderScreen();
    expect(await screen.findByText("You don’t have permission to view undelivered events.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Undelivered events" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();
    failing(503);
    renderScreen();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load undelivered events.");
    expect(screen.getByRole("heading", { level: 1, name: "Undelivered events" })).toBeInTheDocument();
  });
});
