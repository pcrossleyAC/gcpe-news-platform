import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { TransferScreen } from "./TransferScreen";

const CONTACTS = [
  { id: 1, userId: "u1", displayName: "Robin Staff", ministryKey: "health", ministryAbbreviation: "HLTH", ministryName: "Health", isActive: true, userIsActive: true, canReceive: true, label: "Robin Staff (HLTH)" },
  { id: 2, userId: "u2", displayName: "Kim Imported", ministryKey: "health", ministryAbbreviation: "HLTH", ministryName: "Health", isActive: false, userIsActive: true, canReceive: false, label: "Kim Imported (HLTH)" },
  { id: 3, userId: "u3", displayName: "Sam Finance", ministryKey: "finance", ministryAbbreviation: "FIN", ministryName: "Finance", isActive: true, userIsActive: true, canReceive: true, label: "Sam Finance (FIN)" },
  // Active, but its ministry can't lead (apps/calendar/src/transfer.ts's receiveRefusal) — isActive alone would wrongly offer it as To.
  { id: 4, userId: "u4", displayName: "Jess Excluded", ministryKey: "excluded", ministryAbbreviation: "EXC", ministryName: "Excluded", isActive: true, userIsActive: true, canReceive: false, label: "Jess Excluded (EXC)" },
  // An active contact whose person's account is inactive.
  { id: 5, userId: "u5", displayName: "Lee Dormant", ministryKey: "health", ministryAbbreviation: "HLTH", ministryName: "Health", isActive: true, userIsActive: false, canReceive: false, label: "Lee Dormant (HLTH)" },
];

function stub(calls: { url: string; init?: RequestInit }[], transferred = 3) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "a1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
      if (url === "/calendar/api/transfer/comm-contacts") return jsonResponse(200, CONTACTS);
      if (url.startsWith("/calendar/api/transfer/preview")) return jsonResponse(200, { from: CONTACTS[1], to: CONTACTS[2], count: 2 });
      if (url === "/calendar/api/transfer") return jsonResponse(200, { transferred });
      throw new Error(`unhandled: ${url}`);
    }),
  );
}

const renderScreen = () =>
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/calendar/transfer"]}>
        <RequireAuth>
          <Routes>
            <Route path="/calendar/transfer" element={<TransferScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );

describe("TransferScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers every contact as From, inactive ones included, and only those that canReceive as To", async () => {
    stub([]);
    renderScreen();
    await screen.findByRole("heading", { level: 1, name: "Transfer activities" });
    const from = (await screen.findByLabelText("From comm contact")) as HTMLSelectElement;
    const to = screen.getByLabelText("To comm contact") as HTMLSelectElement;
    await waitFor(() =>
      expect([...from.options].map((o) => o.text)).toEqual([
        "Choose a comm contact",
        "Robin Staff (HLTH)",
        "Kim Imported (HLTH) — inactive",
        "Sam Finance (FIN)",
        "Jess Excluded (EXC)",
        "Lee Dormant (HLTH) — inactive",
      ]),
    );
    // Kim is inactive and Jess's ministry can't lead: both are excluded, by canReceive, not by isActive alone.
    expect([...to.options].map((o) => o.text)).toEqual(["Choose a comm contact", "Robin Staff (HLTH)", "Sam Finance (FIN)"]);
    await waitFor(() => expect(document.title).toContain("Transfer activities"));
  });

  it("previews the count and the new lead ministry, then transfers and shows the run's own count", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls, 3);
    renderScreen();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("From comm contact"), "2");
    await user.selectOptions(screen.getByLabelText("To comm contact"), "3");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText("2 activities will move from Kim Imported (HLTH) to Sam Finance (FIN). Their lead ministry becomes Finance.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Transfer 2 activities" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Transferred 3 activities from Kim Imported (HLTH) to Sam Finance (FIN).");
    const post = calls.find((c) => c.url === "/calendar/api/transfer")!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ from: 2, to: 3 });
  });

  it("shows the server's refusal next to the form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "a1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
        if (url === "/calendar/api/transfer/comm-contacts") return jsonResponse(200, CONTACTS);
        return jsonResponse(422, { error: "Choose two different comm contacts" });
      }),
    );
    renderScreen();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("From comm contact"), "1");
    await user.selectOptions(screen.getByLabelText("To comm contact"), "3");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose two different comm contacts");
  });

  it("clears an earlier result when previewing or transferring again", async () => {
    let transfers = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "a1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
        if (url === "/calendar/api/transfer/comm-contacts") return jsonResponse(200, CONTACTS);
        if (url.startsWith("/calendar/api/transfer/preview")) return jsonResponse(200, { from: CONTACTS[1], to: CONTACTS[2], count: 2 });
        if (url === "/calendar/api/transfer") return ++transfers === 1 ? jsonResponse(200, { transferred: 2 }) : jsonResponse(422, { error: "That person's account is inactive" });
        throw new Error(`unhandled: ${url}`);
      }),
    );
    renderScreen();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("From comm contact"), "2");
    await user.selectOptions(screen.getByLabelText("To comm contact"), "3");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await user.click(await screen.findByRole("button", { name: "Transfer 2 activities" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Transferred 2 activities");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await user.click(await screen.findByRole("button", { name: "Transfer 2 activities" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That person's account is inactive");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says to reload when a chosen contact is no longer available (404), on preview and on transfer", async () => {
    let previewStatus = 404;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "a1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
        if (url === "/calendar/api/transfer/comm-contacts") return jsonResponse(200, CONTACTS);
        if (url.startsWith("/calendar/api/transfer/preview")) return previewStatus === 404 ? jsonResponse(404, { error: "not found" }) : jsonResponse(200, { from: CONTACTS[0], to: CONTACTS[2], count: 1 });
        if (url === "/calendar/api/transfer") return jsonResponse(404, { error: "not found" });
        throw new Error(`unhandled: ${url}`);
      }),
    );
    renderScreen();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("From comm contact"), "1");
    await user.selectOptions(screen.getByLabelText("To comm contact"), "3");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That comm contact is no longer available: reload the page.");
    previewStatus = 200;
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await user.click(await screen.findByRole("button", { name: "Transfer 1 activity" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That comm contact is no longer available: reload the page.");
  });

  it("shows a clear error naming the count that moved when a later batch fails (207)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "a1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
        if (url === "/calendar/api/transfer/comm-contacts") return jsonResponse(200, CONTACTS);
        if (url.startsWith("/calendar/api/transfer/preview")) return jsonResponse(200, { from: CONTACTS[1], to: CONTACTS[2], count: 150 });
        if (url === "/calendar/api/transfer") return jsonResponse(207, { transferred: 100, failed: true });
        throw new Error(`unhandled: ${url}`);
      }),
    );
    renderScreen();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("From comm contact"), "2");
    await user.selectOptions(screen.getByLabelText("To comm contact"), "3");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await user.click(await screen.findByRole("button", { name: "Transfer 150 activities" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only 100 activities moved from Kim Imported (HLTH) to Sam Finance (FIN) before a later batch failed.");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
