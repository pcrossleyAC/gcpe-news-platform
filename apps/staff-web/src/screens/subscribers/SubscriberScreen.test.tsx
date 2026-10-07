import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { SubscriberScreen } from "./SubscriberScreen";
import type { SubscriberDetail } from "./types";

const ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "99999999-9999-9999-9999-999999999999";

const OPTIONS = {
  categories: [
    {
      key: "ministries",
      name: "Ministries",
      lists: [
        { listKey: "ministries:health", name: "Health" },
        { listKey: "ministries:agri", name: "Agriculture" },
      ],
    },
  ],
};

function detail(overrides: Partial<SubscriberDetail> = {}): SubscriberDetail {
  return {
    id: ID,
    email: "pat@example.test",
    status: "disabled",
    source: "self",
    asItHappens: false,
    digest: false,
    createdAt: "2026-09-01T17:00:00.000Z",
    needsAttention: null,
    verifiedAt: "2026-09-01T17:05:00.000Z",
    endedAt: null,
    attentionAt: null,
    allNews: false,
    listKeys: ["ministries:health"],
    mediaLists: [{ listKey: "media-distribution-lists:budget", name: "Budget" }],
    disabledReason: "bounces",
    bouncedEmails: 0,
    bounceWindowDays: 15,
    ...overrides,
  };
}

type Call = { url: string; method: string; body: unknown };

/** `getDetail` is read fresh on every GET of the detail route, so a handler in `responses` can
 * advance it (closing over a `let` in the test) to model what the server would show after its
 * own write — the same shape as a real reload. */
function stub(roles: string[], getDetail: () => SubscriberDetail, responses: Record<string, (body: unknown) => [number, unknown]> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Jamie Staff", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
      if (url === "/nod/api/subscriber-list-options") return jsonResponse(200, OPTIONS);
      if (method === "GET" && url === `/nod/api/subscribers/${ID}`) return jsonResponse(200, getDetail());
      const handler = responses[`${method} ${url}`];
      if (handler) {
        const [status, respBody] = handler(body);
        return jsonResponse(status, respBody);
      }
      throw new Error(`unhandled: ${method} ${url}`);
    }),
  );
  return calls;
}

function renderAt(path = `/subscribers/${ID}`) {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <RequireAuth>
          <Routes>
            <Route path="/subscribers/:id" element={<SubscriberScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("SubscriberScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows the address, status with its reason, media lists read-only, and a fixed title", async () => {
    stub(["NoD.Viewer"], () => detail());
    renderAt();
    expect(await screen.findByText("pat@example.test")).toBeInTheDocument();
    expect(screen.getByText("Disabled — after repeated bounces")).toBeInTheDocument();
    expect(screen.getByText("Budget")).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("Subscriber — GCPE News Staff"));
  });

  it("a Viewer gets no edit controls at all", async () => {
    stub(["NoD.Viewer"], () => detail());
    renderAt();
    await screen.findByText("pat@example.test");
    for (const name of ["Save preferences", "Activate", "Deactivate", "Change email", "Delete"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("an Editor saves timing and public lists; the body never carries a media key", async () => {
    const calls = stub(["NoD.Editor"], () => detail(), {
      [`PUT /nod/api/subscribers/${ID}/preferences`]: () => [200, { ok: true }],
    });
    renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Agriculture" }));
    await user.click(screen.getByRole("checkbox", { name: "Daily digest" }));
    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        asItHappens: false,
        digest: true,
        allNews: false,
        listKeys: ["ministries:health", "ministries:agri"],
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Preferences saved.");
  });

  it("shows the server's 400 message", async () => {
    stub(["NoD.Editor"], () => detail(), {
      [`PUT /nod/api/subscribers/${ID}/preferences`]: () => [400, { error: "Choose at least one list, or all news." }],
    });
    renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Health" }));
    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose at least one list, or all news.");
  });

  it("Activate a disabled subscriber posts status active and reloads", async () => {
    let current = detail({ status: "disabled", disabledReason: "bounces" });
    const calls = stub(["NoD.Editor"], () => current, {
      [`POST /nod/api/subscribers/${ID}/status`]: () => {
        current = { ...current, status: "active", disabledReason: null };
        return [200, { changed: true }];
      },
    });
    renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Activate" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/status"))?.body).toEqual({ status: "active" }));
    expect(await screen.findByText("Active")).toBeInTheDocument();
  });

  it("Deactivate asks first", async () => {
    let current = detail({ status: "active", disabledReason: null });
    const calls = stub(["NoD.Editor"], () => current, {
      [`POST /nod/api/subscribers/${ID}/status`]: () => {
        current = { ...current, status: "disabled", disabledReason: "staff" };
        return [200, { changed: true }];
      },
    });
    renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Deactivate" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Deactivate this subscriber?");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Confirm deactivate" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/status"))?.body).toEqual({ status: "disabled" }));
    expect(await screen.findByText("Disabled — by staff")).toBeInTheDocument();
  });

  it("Delete asks first, then shows the ended state with no edit controls", async () => {
    let current = detail({ status: "active", disabledReason: null });
    const calls = stub(["NoD.Editor"], () => current, {
      [`DELETE /nod/api/subscribers/${ID}`]: () => {
        current = { ...current, status: "deleted", endedAt: "2026-10-05T12:00:00.000Z" };
        return [200, { changed: true }];
      },
    });
    renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete this subscriber?");
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect((await screen.findAllByText(/Unsubscribed or deleted/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Save preferences" })).toBeNull();
  });

  it("Change email: mismatch is refused; email-taken links to the other record", async () => {
    const calls = stub(["NoD.Editor"], () => detail({ status: "active", disabledReason: null }), {
      [`POST /nod/api/subscribers/${ID}/email`]: () => [409, { error: "email-taken", id: OTHER_ID }],
    });
    renderAt();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("New email"), "x@example.test");
    await user.type(screen.getByLabelText("Confirm new email"), "y@example.test");
    await user.click(screen.getByRole("button", { name: "Change email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The two email addresses don't match.");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/email"))).toBe(false);

    await user.clear(screen.getByLabelText("Confirm new email"));
    await user.type(screen.getByLabelText("Confirm new email"), "x@example.test");
    await user.click(screen.getByRole("button", { name: "Change email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Another subscriber record already has that address.");
    expect(await screen.findByRole("link", { name: "Open that record" })).toHaveAttribute("href", `/subscribers/${OTHER_ID}`);
  });

  it("a Media Hub member's email can't be changed here", async () => {
    stub(["NoD.Editor"], () => detail({ status: "active", disabledReason: null, source: "media-hub" }));
    renderAt();
    await screen.findByText("pat@example.test");
    expect(screen.queryByRole("button", { name: "Change email" })).toBeNull();
    expect(screen.getByText("This address comes from Media Hub.")).toBeInTheDocument();
  });
});
