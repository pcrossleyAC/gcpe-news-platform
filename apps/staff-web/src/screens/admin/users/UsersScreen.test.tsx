import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { UsersScreen } from "./UsersScreen";
import type { UserView } from "./UsersScreen";

function withAuth(children: React.ReactNode) {
  return (
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>{children}</RequireAuth>
      </MemoryRouter>
    </SessionProvider>
  );
}

const SELF: UserView = { id: "self-1", email: "self@x.invalid", displayName: "Self", isActive: true, signInMethod: "local", roles: ["Core.Admin"] };
const OTHER: UserView = { id: "other-1", email: "other@x.invalid", displayName: "Other", isActive: true, signInMethod: "local", roles: ["NRMS.Viewer"] };

function stubSession(calls: { url: string; init?: RequestInit }[], extra: (url: string, init?: RequestInit) => Response | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "self-1", name: "Self", email: "self@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
      const handled = extra(url, init);
      if (handled) return handled;
      throw new Error(`unhandled: ${url} ${init?.method ?? "GET"}`);
    }),
  );
}

describe("UsersScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  // I5: document.title matches the h1.
  it("sets the document title", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF]);
      return null;
    });
    render(withAuth(<UsersScreen />));
    await screen.findByRole("heading", { name: "Users", level: 1 });
    expect(document.title).toBe("Users — GCPE News Staff");
  });

  it("creates a user with email, display name, roles and an optional password", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF]);
      if (url === "/core/api/users" && init?.method === "POST") return jsonResponse(201, { ...OTHER });
      return null;
    });
    render(withAuth(<UsersScreen />));
    const user = userEvent.setup();
    const form = (await screen.findByRole("form", { name: "Add a user" })) as HTMLFormElement;

    await user.type(within(form).getByLabelText(/^Email/), "new@x.invalid");
    await user.type(within(form).getByLabelText(/^Display name/), "New Person");
    await user.click(within(form).getByLabelText("NRMS.Editor — Create, edit, and publish news releases."));
    await user.click(within(form).getByLabelText("Set a password now"));
    await user.type(within(form).getByLabelText("Password (at least 12 characters)"), "correct-horse-battery");
    await user.click(within(form).getByRole("button", { name: "Add user" }));

    await waitFor(() => expect(calls.some((c) => c.url === "/core/api/users" && c.init?.method === "POST")).toBe(true));
    const call = calls.find((c) => c.url === "/core/api/users" && c.init?.method === "POST")!;
    expect(JSON.parse(call.init!.body as string)).toEqual({
      email: "new@x.invalid",
      displayName: "New Person",
      roles: ["NRMS.Editor"],
      password: "correct-horse-battery",
    });
  });

  it("shows the server's self-lockout message when deactivating your own account", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF]);
      if (url === "/core/api/users/self-1" && init?.method === "PATCH") return jsonResponse(409, { error: "you can't remove your own admin access" });
      return null;
    });
    render(withAuth(<UsersScreen />));
    const user = userEvent.setup();
    const toggle = await screen.findByRole("switch", { name: "self@x.invalid is active" });
    await user.click(toggle);

    expect(await screen.findByText("you can't remove your own admin access")).toBeInTheDocument();
  });

  it("shows the server's self-lockout message when removing your own Core.Admin role", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF]);
      if (url === "/core/api/users/self-1/roles" && init?.method === "PUT") return jsonResponse(409, { error: "you can't remove your own admin access" });
      return null;
    });
    render(withAuth(<UsersScreen />));
    const user = userEvent.setup();
    const row = (await screen.findByText("self@x.invalid")).closest("li")!;
    await user.click(within(row).getByLabelText(/^Core\.Admin —/));
    await user.click(within(row).getByRole("button", { name: "Save roles" }));

    expect(await screen.findByText("you can't remove your own admin access")).toBeInTheDocument();
  });

  it("sends a new password once, clears the field afterward, and shows a success message", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF]);
      if (url === "/core/api/users/self-1/password" && init?.method === "POST") return new Response(null, { status: 204 });
      return null;
    });
    render(withAuth(<UsersScreen />));
    const user = userEvent.setup();
    const passwordField = (await screen.findByLabelText("self@x.invalid new password")) as HTMLInputElement;
    // Minors: autocomplete="new-password" — never offers to autofill the user's own existing
    // sign-in password into a field that's setting a *different* user's.
    expect(passwordField).toHaveAttribute("autocomplete", "new-password");
    await user.type(passwordField, "a-new-strong-password");
    await user.click(screen.getByRole("button", { name: "Set password" }));

    await waitFor(() => expect(calls.some((c) => c.url === "/core/api/users/self-1/password")).toBe(true));
    const call = calls.find((c) => c.url === "/core/api/users/self-1/password")!;
    expect(JSON.parse(call.init!.body as string)).toEqual({ password: "a-new-strong-password" });
    await waitFor(() => expect(passwordField.value).toBe(""));
    // Minors: a visible success message — the field going blank again used to be
    // indistinguishable from a failed save that also clears it.
    expect(await screen.findByText("Password updated.")).toBeInTheDocument();
  });

  // Fix round 1, item 3: onCreate clears the password field on failure too (not just success),
  // same rule as savePassword — a typed password is never left sitting in the form.
  it("clears the create form's password field even when creation fails", async () => {
    stubSession([], (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF]);
      if (url === "/core/api/users" && init?.method === "POST") return jsonResponse(409, { error: "a user with that email already exists" });
      return null;
    });
    render(withAuth(<UsersScreen />));
    const user = userEvent.setup();
    const form = (await screen.findByRole("form", { name: "Add a user" })) as HTMLFormElement;

    await user.type(within(form).getByLabelText(/^Email/), "new@x.invalid");
    await user.type(within(form).getByLabelText(/^Display name/), "New Person");
    await user.click(within(form).getByLabelText("Set a password now"));
    const passwordField = within(form).getByLabelText("Password (at least 12 characters)") as HTMLInputElement;
    await user.type(passwordField, "correct-horse-battery");
    await user.click(within(form).getByRole("button", { name: "Add user" }));

    expect(await screen.findByText("a user with that email already exists")).toBeInTheDocument();
    expect(passwordField.value).toBe("");
  });
});
