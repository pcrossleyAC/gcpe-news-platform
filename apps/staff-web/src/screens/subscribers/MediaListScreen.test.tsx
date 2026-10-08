import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { MediaListScreen } from "./MediaListScreen";
import type { MediaMember } from "./types";

const ID1 = "11111111-1111-1111-1111-111111111111";
const ID2 = "22222222-2222-2222-2222-222222222222";
const MEMBERS: MediaMember[] = [
  { subscriberId: ID1, email: "sam@riverbend.example.test", source: "media-hub", mediaHubContactId: 42, mediaHubEmailRef: "personal", needsAttention: "email-gone", attentionAt: "2026-10-06T09:00:00.000Z" },
  { subscriberId: ID2, email: "lee@example.test", source: "manual-media", mediaHubContactId: null, mediaHubEmailRef: null, needsAttention: "bouncing", attentionAt: "2026-10-06T09:00:00.000Z" },
];
const OPTED = { items: [{ subscriberId: "33333333-3333-3333-3333-333333333333", email: "gone@example.test", at: "2026-09-01T17:00:00.000Z", member: false }], truncated: false };
const CONTACT = {
  id: 42, firstName: "Sam", lastName: "Reporter", outlet: "Riverbend Gazette", deletedAt: null,
  emails: [
    { ref: "personal", address: "sam@riverbend.example.test", kind: "personal", organization: null, preferred: true },
    { ref: "workplace:1", address: "sam@gazette.example.test", kind: "workplace", organization: "Riverbend Gazette", preferred: false },
  ],
};

type Call = { url: string; method: string; body: unknown };
interface StubOptions {
  onAdd?: (body: Record<string, unknown>) => Response;
  onSearch?: (body: Record<string, unknown>) => Response | Promise<Response>;
  members?: () => Response;
  onRemove?: () => Response;
  onResolve?: () => Response;
}
function stub(roles: string[], opts: StubOptions = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
    if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
    if (url === "/nod/api/media-lists") return jsonResponse(200, [{ listKey: "media-distribution-lists:budget", key: "budget", name: "Budget", active: true, members: 2, needsAttention: 2 }]);
    if (url === "/nod/api/media-lists/budget/members" && method === "GET") return opts.members?.() ?? jsonResponse(200, MEMBERS);
    if (url === "/nod/api/media-lists/budget/members" && method === "POST") return opts.onAdd?.(body) ?? jsonResponse(201, { subscriberId: "x", created: true });
    if (url === "/nod/api/media-lists/budget/opted-out") return jsonResponse(200, OPTED);
    if (url === "/nod/api/media-hub/contacts/search") return opts.onSearch?.(body) ?? jsonResponse(200, { contacts: [CONTACT], page: 1, pageSize: 25, total: 1 });
    if (url === "/nod/api/media-hub/contacts/42") return jsonResponse(200, CONTACT);
    if (url.startsWith("/nod/api/media-lists/budget/members/") && method === "DELETE") return opts.onRemove?.() ?? new Response(null, { status: 204 });
    if (url.endsWith("/resolve")) return opts.onResolve?.() ?? jsonResponse(200, { ok: true });
    throw new Error(`unhandled: ${method} ${url}`);
  }));
  return calls;
}
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</div>;
}
function renderIt() {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/subscribers/media-lists/budget"]}>
        <RequireAuth>
          <Routes>
            <Route path="/subscribers/media-lists/:key" element={<MediaListScreen />} />
          </Routes>
          <LocationProbe />
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("MediaListScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows members with source and flag, and the opt-outs; a Viewer has no controls", async () => {
    stub(["NoD.Viewer"]);
    renderIt();
    const members = await screen.findByRole("table", { name: "Members" });
    expect(within(members).getByRole("row", { name: /sam@riverbend\.example\.test Media Hub Media Hub email removed/ })).toBeInTheDocument();
    expect(within(members).getByRole("row", { name: /lee@example\.test Added by hand Bouncing/ })).toBeInTheDocument();
    const opted = screen.getByRole("table", { name: "Left this list by unsubscribing" });
    expect(within(opted).getByRole("row", { name: /gone@example\.test .* No/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Email address" })).toBeNull();
    expect(screen.getByText("Budget")).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("Media list — GCPE News Staff"));
  });

  it("opted-out add asks first, shows when they left, and sends confirmOptOut only on confirm", async () => {
    const calls = stub(["NoD.Editor"], { onAdd: (body) => (body.confirmOptOut ? jsonResponse(200, { subscriberId: "x", created: false }) : jsonResponse(409, { error: "opted-out", at: "2026-09-01T17:00:00.000Z" })) });
    renderIt();
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Email address" }), "gone@example.test");
    await user.click(screen.getByRole("button", { name: "Add to list" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("They unsubscribed");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/members"))).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Add to list" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Add anyway" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/media-lists/budget/members", method: "POST", body: { email: "gone@example.test", confirmOptOut: true } }));
    expect(await screen.findByRole("status")).toHaveTextContent("Added to the list.");
  });

  it("Media Hub search posts the term (never in the URL) and adds the chosen email", async () => {
    const calls = stub(["NoD.Editor"]);
    renderIt();
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Name, email or outlet" }), "Sam");
    await user.click(screen.getByRole("button", { name: "Search Media Hub" }));
    await user.click(await screen.findByRole("button", { name: "Add sam@gazette.example.test" }));
    expect(calls).toContainEqual({ url: "/nod/api/media-hub/contacts/search", method: "POST", body: { q: "Sam", page: 1 } });
    expect(calls.some((c) => c.url.includes("Sam"))).toBe(false);
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/subscribers\/media-lists\/budget$/);
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/media-lists/budget/members", method: "POST", body: { mediaHubContactId: 42, emailRef: "workplace:1" } }));
  });

  it("a slower, earlier Media Hub search never replaces the latest results", async () => {
    let releaseFirst: (r: Response) => void = () => {};
    const OLD = { ...CONTACT, id: 7, firstName: "Old", lastName: "Result", emails: [{ ref: "personal", address: "old@example.test", kind: "personal", organization: null, preferred: true }] };
    stub(["NoD.Editor"], {
      onSearch: (body) =>
        body.q === "Old"
          ? new Promise<Response>((resolve) => {
              releaseFirst = resolve;
            })
          : jsonResponse(200, { contacts: [CONTACT], page: 1, pageSize: 25, total: 1 }),
    });
    renderIt();
    const user = userEvent.setup();
    const box = await screen.findByRole("textbox", { name: "Name, email or outlet" });
    await user.type(box, "Old");
    await user.click(screen.getByRole("button", { name: "Search Media Hub" }));
    await user.clear(box);
    await user.type(box, "Sam");
    await user.click(screen.getByRole("button", { name: "Search Media Hub" }));
    await screen.findByRole("button", { name: "Add sam@gazette.example.test" });
    releaseFirst(jsonResponse(200, { contacts: [OLD], page: 1, pageSize: 25, total: 1 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "Add old@example.test" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add sam@gazette.example.test" })).toBeInTheDocument();
  });

  it("remove asks first, then DELETEs", async () => {
    const calls = stub(["NoD.Editor"]);
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Remove lee@example.test" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(calls).toContainEqual({ url: `/nod/api/media-lists/budget/members/${ID2}`, method: "DELETE", body: undefined }));
  });

  it("a failed remove is shown inside the open dialog, not behind it", async () => {
    stub(["NoD.Editor"], { onRemove: () => jsonResponse(500, { error: "internal error" }) });
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Remove lee@example.test" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Confirm remove" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't remove. Try again.");
  });

  it("a failed \"Add anyway\" is shown inside the open dialog, not behind it", async () => {
    stub(["NoD.Editor"], { onAdd: (body) => (body.confirmOptOut ? jsonResponse(500, { error: "internal error" }) : jsonResponse(409, { error: "opted-out", at: "2026-09-01T17:00:00.000Z" })) });
    renderIt();
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Email address" }), "gone@example.test");
    await user.click(screen.getByRole("button", { name: "Add to list" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Add anyway" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("internal error");
  });

  it("resolve: bouncing clears with an empty body and says the count restarts; a Media Hub flag offers the contact's emails", async () => {
    const calls = stub(["NoD.Editor"]);
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Resolve lee@example.test" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Clear flag" }));
    await waitFor(() => expect(calls).toContainEqual({ url: `/nod/api/media-members/${ID2}/resolve`, method: "POST", body: {} }));
    expect(await screen.findByRole("status")).toHaveTextContent("Resolved. Their bounce count starts again.");
    await user.click(await screen.findByRole("button", { name: "Resolve sam@riverbend.example.test" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(await within(dialog).findByRole("radio", { name: /sam@gazette\.example\.test/ }));
    await user.click(within(dialog).getByRole("button", { name: "Use this email" }));
    await waitFor(() => expect(calls).toContainEqual({ url: `/nod/api/media-members/${ID1}/resolve`, method: "POST", body: { emailRef: "workplace:1" } }));
    expect(await screen.findByRole("status")).toHaveTextContent("Email updated and flag cleared.");
  });

  it("resolve: an email that opted out of a media list the member is on is refused inside the dialog", async () => {
    stub(["NoD.Editor"], {
      members: () => jsonResponse(200, [{ ...MEMBERS[0]!, needsAttention: "opted-out-address" }]),
      onResolve: () => jsonResponse(409, { error: "opted-out-address" }),
    });
    renderIt();
    const user = userEvent.setup();
    const members = await screen.findByRole("table", { name: "Members" });
    expect(within(members).getByRole("row", { name: /Media Hub email opted out of a media list this member is on/ })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Resolve sam@riverbend.example.test" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(await within(dialog).findByRole("radio", { name: /sam@gazette\.example\.test/ }));
    await user.click(within(dialog).getByRole("button", { name: "Use this email" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("That address opted out of a media list this member is on.");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("remove them and add them again, confirming the opt-out");
  });

  it("resolve: for an opted-out address, says clearing the flag lasts only until the next sync, and how to resolve it", async () => {
    const calls = stub(["NoD.Editor"], { members: () => jsonResponse(200, [{ ...MEMBERS[0]!, needsAttention: "opted-out-address" }]) });
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Resolve sam@riverbend.example.test" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("The next Media Hub sync flags them again");
    expect(dialog).toHaveTextContent("update the contact in Media Hub");
    await user.click(within(dialog).getByRole("button", { name: "Clear the flag only" }));
    await waitFor(() => expect(calls).toContainEqual({ url: `/nod/api/media-members/${ID1}/resolve`, method: "POST", body: {} }));
    expect(await screen.findByRole("status")).toHaveTextContent("Flag cleared until the next Media Hub sync.");
  });

  it("a failed load says so instead of loading forever; an unknown list says there's no such list", async () => {
    stub(["NoD.Viewer"], { members: () => jsonResponse(500, { error: "boom" }) });
    renderIt();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load this media list.");
    expect(screen.queryByText("Loading…")).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
    stub(["NoD.Viewer"], { members: () => jsonResponse(404, { error: "not found" }) });
    renderIt();
    expect(await screen.findByRole("alert")).toHaveTextContent("There's no media list with that key.");
  });
});
