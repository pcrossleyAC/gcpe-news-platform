import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { AddSubscriberScreen } from "./AddSubscriberScreen";

const OPTIONS = { categories: [{ key: "ministries", name: "Ministries", lists: [{ listKey: "ministries:health", name: "Health" }] }] };

type Call = { url: string; method: string; body: unknown };
type AddReply = { status: number; body: unknown };

function stub(roles: string[], onAdd?: (body: unknown) => AddReply, opts: { listOptionsFails?: boolean } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
      if (url === "/nod/api/subscriber-list-options") return opts.listOptionsFails ? jsonResponse(500, { error: "internal error" }) : jsonResponse(200, OPTIONS);
      if (url === "/nod/api/subscribers" && init?.method === "POST") {
        const reply = onAdd?.(body) ?? { status: 201, body: { id: "33333333-3333-3333-3333-333333333333" } };
        return jsonResponse(reply.status, reply.body);
      }
      throw new Error(`unhandled: ${url}`);
    }),
  );
  return calls;
}

function renderAt(path = "/subscribers/new") {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <RequireAuth>
          <Routes>
            <Route path="/subscribers/new" element={<AddSubscriberScreen />} />
            <Route path="/subscribers/:id" element={<p>detail page</p>} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("AddSubscriberScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("refuses a confirm-email mismatch without sending", async () => {
    const calls = stub(["NoD.Editor"]);
    renderAt();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Email/), "a@example.test");
    await user.type(screen.getByLabelText(/^Confirm email/), "b@example.test");
    await user.click(await screen.findByRole("checkbox", { name: "Health" }));
    await user.click(screen.getByRole("button", { name: "Add subscriber" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The two email addresses don't match.");
    expect(calls.some((c) => c.url === "/nod/api/subscribers" && c.method === "POST")).toBe(false);
  });

  it("posts email, lists and timing and opens the new subscriber", async () => {
    const calls = stub(["NoD.Editor"]);
    renderAt();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Email/), "new@example.test");
    await user.type(screen.getByLabelText(/^Confirm email/), "new@example.test");
    await user.click(await screen.findByRole("checkbox", { name: "Health" }));
    await user.click(screen.getByRole("button", { name: "Add subscriber" }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === "/nod/api/subscribers" && c.method === "POST")?.body).toEqual({
        email: "new@example.test",
        lists: ["ministries:health"],
        asItHappens: true,
        digest: false,
      }),
    );
    expect(await screen.findByText("detail page")).toBeInTheDocument();
  });

  it("sends lists: 'all' when All news is ticked", async () => {
    const calls = stub(["NoD.Editor"]);
    renderAt();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Email/), "new@example.test");
    await user.type(screen.getByLabelText(/^Confirm email/), "new@example.test");
    await user.click(await screen.findByRole("checkbox", { name: "All news" }));
    await user.click(screen.getByRole("button", { name: "Add subscriber" }));
    await waitFor(() => expect((calls.find((c) => c.url === "/nod/api/subscribers" && c.method === "POST")?.body as { lists?: unknown } | undefined)?.lists).toBe("all"));
  });

  it("an existing address links to that subscriber", async () => {
    stub(["NoD.Editor"], () => ({ status: 409, body: { error: "subscriber exists", id: "44444444-4444-4444-4444-444444444444" } }));
    renderAt();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Email/), "dup@example.test");
    await user.type(screen.getByLabelText(/^Confirm email/), "dup@example.test");
    await user.click(await screen.findByRole("checkbox", { name: "Health" }));
    await user.click(screen.getByRole("button", { name: "Add subscriber" }));
    expect(await screen.findByRole("link", { name: "Open their record" })).toHaveAttribute("href", "/subscribers/44444444-4444-4444-4444-444444444444");
  });

  it("a Viewer sees a permission message, not the form", async () => {
    stub(["NoD.Viewer"]);
    renderAt();
    expect(await screen.findByRole("heading", { level: 1, name: "Add a subscriber" })).toBeInTheDocument();
    expect(await screen.findByText("You don’t have permission to add subscribers.")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Email/)).toBeNull();
  });

  it("shows an alert when the list options fail to load, and the form still works", async () => {
    stub(["NoD.Editor"], undefined, { listOptionsFails: true });
    renderAt();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the list of lists.");
    // The form itself still renders and "All news" alone still works with no lists offered.
    expect(await screen.findByLabelText(/^Email/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "All news" })).toBeInTheDocument();
  });
});
