import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { OperationsScreen } from "./OperationsScreen";
import type { OperationsStatus } from "./types";

const OPS: OperationsStatus = {
  nod: { paused: false, lastDigestCutoff: "2026-10-07T00:00:00.000Z" },
  distribution: { paused: false },
  bounceSource: "fake",
  bounceSummary: { address: "server@example.test", from: "server" },
};

type Call = { url: string; method: string; body: unknown };
function stub(roles: string[], ops: OperationsStatus = OPS) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
    if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
    if (url === "/nod/api/operations") return jsonResponse(200, ops);
    if (url.endsWith("/pause")) return jsonResponse(200, { paused: true, changed: true });
    if (url === "/nod/api/operations/bounce-summary-address") return jsonResponse(200, { changed: true, bounceSummary: { address: "staff@example.test", from: "setting" } });
    if (url === "/nod/api/bounces/inbox") return jsonResponse(201, { id: "b1" });
    throw new Error(`unhandled: ${method} ${url}`);
  }));
  return calls;
}
function renderIt() {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/subscribers/operations"]}>
        <RequireAuth>
          <Routes>
            <Route path="/subscribers/operations" element={<OperationsScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("OperationsScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("an Editor is told it's for admins and nothing is fetched", async () => {
    const calls = stub(["NoD.Editor"]);
    renderIt();
    expect(await screen.findByText("You don’t have permission to use Operations.")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/nod/api/operations")).toBe(false);
    await waitFor(() => expect(document.title).toBe("Operations — GCPE News Staff"));
  });

  it("pausing NoD asks first, then posts and reloads", async () => {
    const calls = stub(["NoD.Admin"]);
    renderIt();
    const user = userEvent.setup();
    const nod = await screen.findByRole("region", { name: "News On Demand sending" });
    expect(within(nod).getByText("Running")).toBeInTheDocument();
    await user.click(within(nod).getByRole("button", { name: "Pause News On Demand sending" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Nothing is dropped");
    await user.click(within(dialog).getByRole("button", { name: "Confirm pause" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/settings/pause", method: "POST", body: undefined }));
    expect(calls.filter((c) => c.url === "/nod/api/operations").length).toBeGreaterThanOrEqual(2);
  });

  it("Distribution unavailable: says so, offers no Distribution button, NoD controls still work", async () => {
    stub(["NoD.Admin"], { ...OPS, distribution: null, bounceSource: null });
    renderIt();
    const dist = await screen.findByRole("region", { name: "Distribution" });
    expect(within(dist).getByText(/Distribution isn’t responding/)).toBeInTheDocument();
    expect(within(dist).queryByRole("button")).toBeNull();
    expect(screen.getByRole("button", { name: "Pause News On Demand sending" })).toBeEnabled();
    expect(screen.queryByRole("region", { name: "Test bounce upload" })).toBeNull();
  });

  it("sets the summary address and offers the server default back", async () => {
    const calls = stub(["NoD.Admin"]);
    renderIt();
    const user = userEvent.setup();
    expect(await screen.findByText("Using the server default.")).toBeInTheDocument();
    const field = screen.getByRole("textbox", { name: "Bounce summary email" });
    await user.clear(field);
    await user.type(field, "staff@example.test");
    await user.click(screen.getByRole("button", { name: "Save address" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/operations/bounce-summary-address", method: "PUT", body: { address: "staff@example.test" } }));
    expect(await screen.findByRole("status")).toHaveTextContent("Bounce summary address saved.");
  });

  it("uploads a pasted bounce on a fake-mailbox site", async () => {
    const calls = stub(["NoD.Admin"]);
    renderIt();
    const user = userEvent.setup();
    const upload = await screen.findByRole("region", { name: "Test bounce upload" });
    await user.type(within(upload).getByRole("textbox", { name: "Or paste the message" }), "Subject: Undeliverable");
    await user.click(within(upload).getByRole("button", { name: "Upload bounce" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/bounces/inbox", method: "POST", body: { raw: "Subject: Undeliverable" } }));
  });
});
