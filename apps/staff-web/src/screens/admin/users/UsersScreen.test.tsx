import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { UsersScreen } from "./UsersScreen";
import type { UserView } from "./UsersScreen";
import { visibleText } from "../../../../test/visibleText";

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

function stubSession(calls: { url: string; init?: RequestInit }[], extra: (url: string, init?: RequestInit) => Response | Promise<Response> | null) {
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

/** Opens a user's editor from their row in the users table (the table's Edit button). */
async function openEditor(who: string, user = userEvent.setup()): Promise<void> {
  await user.click(await screen.findByRole("button", { name: `Edit ${who}` }));
}


/** Records, the moment a live region first gets text, whether it was hidden from assistive
 * technology then (inside an aria-hidden ancestor, as a still-open modal leaves the page). */
function watchFirstText(region: Element): { hiddenWhenSet: boolean | null } {
  const seen = { hiddenWhenSet: null as boolean | null };
  const observer = new MutationObserver(() => {
    if (seen.hiddenWhenSet === null && region.textContent) {
      seen.hiddenWhenSet = region.closest('[aria-hidden="true"]') !== null || document.querySelector('[role="alertdialog"]') !== null;
      observer.disconnect();
    }
  });
  observer.observe(region, { childList: true, subtree: true, characterData: true });
  return seen;
}

describe("UsersScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows each user's fields under short visible labels, keeping the full names for assistive technology", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF]);
      return null;
    });
    render(withAuth(<UsersScreen />));
    await openEditor("self@x.invalid");
    const row = (await screen.findByRole("heading", { name: "self@x.invalid", level: 3 })).closest<HTMLElement>(".gcpe-users__editor")!;
    const name = within(row).getByRole("textbox", { name: "self@x.invalid display name" });
    expect(visibleText(row.querySelector(`label[for="${name.id}"]`)!)).toBe("display name");
    expect(visibleText(within(row).getByRole("switch", { name: "self@x.invalid is active" }).closest("label")!)).toBe("Active");
    const admin = within(row).getByLabelText(/^Core\.Admin — Manage staff users/);
    expect(admin.closest("label")!.querySelector("strong")).toHaveTextContent("Core.Admin");
  });

  it("shows a Calendar role read-only in the Roles column, with the way to Calendar access", async () => {
    const CAL: UserView = { id: "cal-1", email: "cal@x.invalid", displayName: "Cal", isActive: true, signInMethod: "local", roles: [] };
    stubSession([], (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF, CAL]);
      if (url === "/core/api/calendar-access") return jsonResponse(200, [{ id: "cal-1", email: "cal@x.invalid", displayName: "Cal", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["health"] }]);
      if (url === "/core/api/organizations") return jsonResponse(200, [{ key: "health", displayName: "Health", abbreviation: "HLTH", isActive: true, isHq: false, isPublic: true }]);
      return null;
    });
    render(withAuth(<UsersScreen />));
    const table = await screen.findByRole("table", { name: "Staff users" });
    const row = within(table).getByRole("rowheader", { name: "Cal" }).closest("tr")!;
    expect(await within(row).findByText(/^Calendar: Editor \(HLTH\)/)).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "manage in Calendar access" })).toHaveAttribute("href", "/calendar-access");
    expect(within(row).queryByText("None")).toBeNull();
  });

  it("lists users in a table, filters them by name, email or role, and opens one user's editor in place", async () => {
    stubSession([], (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF, OTHER]);
      return null;
    });
    render(withAuth(<UsersScreen />));
    const user = userEvent.setup();
    const table = await screen.findByRole("table", { name: "Staff users" });
    expect(within(table).getByRole("rowheader", { name: "Self" })).toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: "Other" })).toBeInTheDocument();
    expect(within(within(table).getByRole("rowheader", { name: "Other" }).closest("tr")!).getByText("NRMS Viewer")).toBeInTheDocument();
    // Closed until asked for.
    expect(screen.queryByRole("switch")).toBeNull();

    await user.type(screen.getByRole("searchbox", { name: /Filter users/ }), "nrms.viewer");
    expect(within(table).queryByRole("rowheader", { name: "Self" })).toBeNull();
    expect(within(table).getByRole("rowheader", { name: "Other" })).toBeInTheDocument();
    expect(await screen.findByText("Showing 1 of 2 users")).toBeInTheDocument();

    const edit = screen.getByRole("button", { name: "Edit other@x.invalid" });
    expect(edit).toHaveAttribute("aria-expanded", "false");
    await user.click(edit);
    expect(screen.getByRole("button", { name: "Close other@x.invalid" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("switch", { name: "other@x.invalid is active" })).toBeInTheDocument();
  });

  it("keeps an editor's unsaved edits when its row is closed or filtered out, and shows them again", async () => {
    stubSession([], (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF, OTHER]);
      return null;
    });
    render(withAuth(<UsersScreen />));
    const user = userEvent.setup();
    await openEditor("other@x.invalid", user);
    const name = screen.getByRole("textbox", { name: "other@x.invalid display name" });
    await user.clear(name);
    await user.type(name, "Other Person");
    await user.click(screen.getByRole("button", { name: "Close other@x.invalid" }));
    await user.type(screen.getByRole("searchbox", { name: /Filter users/ }), "self");
    expect(screen.queryByRole("rowheader", { name: "Other" })).toBeNull();
    await user.clear(screen.getByRole("searchbox", { name: /Filter users/ }));
    await openEditor("other@x.invalid", user);
    expect(screen.getByRole("textbox", { name: "other@x.invalid display name" })).toHaveValue("Other Person");
  });

  it("matches a status as a whole word: active finds no inactive user", async () => {
    stubSession([], (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF, { ...OTHER, isActive: false }]);
      return null;
    });
    render(withAuth(<UsersScreen />));
    const user = userEvent.setup();
    await screen.findByRole("rowheader", { name: "Other" });
    await user.type(screen.getByRole("searchbox", { name: /Filter users/ }), "active");
    expect(screen.queryByRole("rowheader", { name: "Other" })).toBeNull();
    expect(screen.getByRole("rowheader", { name: "Self" })).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: /Filter users/ }));
    await user.type(screen.getByRole("searchbox", { name: /Filter users/ }), "inactive");
    expect(screen.queryByRole("rowheader", { name: "Self" })).toBeNull();
    expect(screen.getByRole("rowheader", { name: "Other" })).toBeInTheDocument();
    // The count is announced once typing pauses.
    expect(await screen.findByText("Showing 1 of 2 users")).toBeInTheDocument();
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
    await waitFor(() => expect(document.title).toBe("Users — GCPE News Staff"));
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
    await openEditor("self@x.invalid");
    const user = userEvent.setup();
    const toggle = await screen.findByRole("switch", { name: "self@x.invalid is active" });
    await user.click(toggle);
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Deactivate" }));

    expect(await screen.findByText("you can't remove your own admin access")).toBeInTheDocument();
  });

  // Owner decision 2026-10-29: switching Active off asks first; switching it on stays instant.
  it("asks before deactivating a user; Cancel leaves them active and posts nothing", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF, OTHER]);
      return null;
    });
    render(withAuth(<UsersScreen />));
    await openEditor("other@x.invalid");
    const user = userEvent.setup();
    const toggle = await screen.findByRole("switch", { name: "other@x.invalid is active" });
    await user.click(toggle);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Deactivate Other?");
    expect(dialog).toHaveTextContent(/They can[’']t sign in until reactivated\./);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(toggle).toBeChecked();
    expect(calls.some((c) => c.init?.method === "PATCH")).toBe(false);
  });

  it("deactivates a user once confirmed, and says Saved next to the switch", async () => {
    let other = OTHER;
    const calls: { url: string; init?: RequestInit }[] = [];
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF, other]);
      if (url === "/core/api/users/other-1" && init?.method === "PATCH") {
        other = { ...OTHER, isActive: false };
        return jsonResponse(200, other);
      }
      return null;
    });
    render(withAuth(<UsersScreen />));
    await openEditor("other@x.invalid");
    const user = userEvent.setup();
    const toggleBefore = await screen.findByRole("switch", { name: "other@x.invalid is active" });
    const seen = watchFirstText(toggleBefore.closest(".gcpe-inline-control")!.querySelector("[aria-live='polite']")!);
    await user.click(toggleBefore);
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/core/api/users/other-1" && c.init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.init?.method === "PATCH")!.init!.body as string)).toEqual({ isActive: false });
    const toggle = await screen.findByRole("switch", { name: "other@x.invalid is inactive" });
    expect(toggle).not.toBeChecked();
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    // Only once the dialog has gone (the page no longer aria-hidden), so it is announced.
    expect(seen.hiddenWhenSet).toBe(false);
  });

  it("reactivates a user at once, with no question, and says Saved", async () => {
    let other: UserView = { ...OTHER, isActive: false };
    const calls: { url: string; init?: RequestInit }[] = [];
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF, other]);
      if (url === "/core/api/users/other-1" && init?.method === "PATCH") {
        other = { ...OTHER, isActive: true };
        return jsonResponse(200, other);
      }
      return null;
    });
    render(withAuth(<UsersScreen />));
    await openEditor("other@x.invalid");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "other@x.invalid is inactive" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(calls.some((c) => c.url === "/core/api/users/other-1" && c.init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.init?.method === "PATCH")!.init!.body as string)).toEqual({ isActive: true });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("shows the server's self-lockout message when removing your own Core.Admin role", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF]);
      if (url === "/core/api/users/self-1/roles" && init?.method === "PUT") return jsonResponse(409, { error: "you can't remove your own admin access" });
      return null;
    });
    render(withAuth(<UsersScreen />));
    await openEditor("self@x.invalid");
    const user = userEvent.setup();
    const row = (await screen.findByRole("heading", { name: "self@x.invalid" })).closest<HTMLElement>(".gcpe-users__editor")!;
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
    await openEditor("self@x.invalid");
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

  it("pressing Enter twice while the password save is in flight sends only one request", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let resolvePost!: (v: Response) => void;
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF]);
      if (url === "/core/api/users/self-1/password" && init?.method === "POST") return new Promise<Response>((resolve) => (resolvePost = resolve));
      return null;
    });
    render(withAuth(<UsersScreen />));
    await openEditor("self@x.invalid");
    const user = userEvent.setup();
    const passwordField = (await screen.findByLabelText("self@x.invalid new password")) as HTMLInputElement;
    await user.type(passwordField, "a-new-strong-password{Enter}");
    await waitFor(() => expect(calls.filter((c) => c.url === "/core/api/users/self-1/password")).toHaveLength(1));

    await user.type(passwordField, "{Enter}");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.url === "/core/api/users/self-1/password")).toHaveLength(1);

    resolvePost(new Response(null, { status: 204 }));
    await screen.findByText("Password updated.");
    expect(calls.filter((c) => c.url === "/core/api/users/self-1/password")).toHaveLength(1);
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

  it("shows a user with no email as such, and links them to an email", async () => {
    const IMPORTED: UserView = { id: "old-1", email: null, displayName: "Kim Imported", isActive: false, signInMethod: "local", roles: [] };
    const calls: { url: string; init?: RequestInit }[] = [];
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF, IMPORTED]);
      if (url === "/core/api/users/old-1/link" && init?.method === "POST") return jsonResponse(200, { ...IMPORTED, email: "kim.imported@x.invalid", isActive: true });
      return null;
    });
    render(withAuth(<UsersScreen />));
    await openEditor("Kim Imported (no email)");
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "Kim Imported (no email) (inactive)" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /Kim Imported/ })).toBeNull();
    const form = screen.getByRole("form", { name: "Link Kim Imported to an email" });
    await user.type(within(form).getByLabelText(/^Email for Kim Imported/), "kim.imported@x.invalid");
    await user.click(within(form).getByRole("button", { name: "Link and activate" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/core/api/users/old-1/link")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url === "/core/api/users/old-1/link")!.init!.body as string)).toEqual({ email: "kim.imported@x.invalid" });
  });

  it("pressing Enter twice in the link-to-email field while linking sends only one request", async () => {
    const IMPORTED: UserView = { id: "old-1", email: null, displayName: "Kim Imported", isActive: false, signInMethod: "local", roles: [] };
    const calls: { url: string; init?: RequestInit }[] = [];
    let resolvePost!: (v: Response) => void;
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF, IMPORTED]);
      if (url === "/core/api/users/old-1/link" && init?.method === "POST") return new Promise<Response>((resolve) => (resolvePost = resolve));
      return null;
    });
    render(withAuth(<UsersScreen />));
    await openEditor("Kim Imported (no email)");
    const user = userEvent.setup();
    const form = await screen.findByRole("form", { name: "Link Kim Imported to an email" });
    const email = within(form).getByLabelText(/^Email for Kim Imported/);
    await user.type(email, "kim.imported@x.invalid{Enter}");
    await waitFor(() => expect(calls.filter((c) => c.url === "/core/api/users/old-1/link")).toHaveLength(1));

    await user.type(email, "{Enter}");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.url === "/core/api/users/old-1/link")).toHaveLength(1);

    resolvePost(jsonResponse(200, { ...IMPORTED, email: "kim.imported@x.invalid", isActive: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.url === "/core/api/users/old-1/link")).toHaveLength(1);
  });

  it("unlinks a user's Microsoft sign-in, then offers a password again", async () => {
    const LINKED: UserView = { ...OTHER, signInMethod: "entra" };
    let current = LINKED;
    const calls: { url: string; init?: RequestInit }[] = [];
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF, current]);
      if (url === "/core/api/users/other-1/unlink-entra" && init?.method === "POST") {
        current = { ...OTHER, signInMethod: "local" };
        return jsonResponse(200, current);
      }
      return null;
    });
    render(withAuth(<UsersScreen />));
    await openEditor("other@x.invalid");
    const row = (await screen.findByRole("heading", { name: "other@x.invalid", level: 3 })).closest<HTMLElement>(".gcpe-users__editor")!;
    expect(within(row).getByText("Sign-in: Microsoft (Entra)")).toBeInTheDocument();
    expect(within(row).queryByLabelText("other@x.invalid new password")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(row).getByRole("button", { name: "Unlink other@x.invalid from Microsoft sign-in" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Unlink" }));

    await waitFor(() => expect(calls.some((c) => c.url === "/core/api/users/other-1/unlink-entra" && c.init?.method === "POST")).toBe(true));
    const after = (await screen.findByRole("heading", { name: "other@x.invalid", level: 3 })).closest<HTMLElement>(".gcpe-users__editor")!;
    expect(await within(after).findByText("Sign-in: Local password")).toBeInTheDocument();
    expect(within(after).getByLabelText("other@x.invalid new password")).toBeInTheDocument();
    expect(within(after).queryByRole("button", { name: /unlink/i })).not.toBeInTheDocument();
  });

  it("shows the server's message when unlinking fails", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF, { ...OTHER, signInMethod: "entra" }]);
      if (url === "/core/api/users/other-1/unlink-entra") return jsonResponse(404, { error: "not found" });
      return null;
    });
    render(withAuth(<UsersScreen />));
    await openEditor("other@x.invalid");
    const row = (await screen.findByRole("heading", { name: "other@x.invalid", level: 3 })).closest<HTMLElement>(".gcpe-users__editor")!;
    const user = userEvent.setup();
    await user.click(within(row).getByRole("button", { name: "Unlink other@x.invalid from Microsoft sign-in" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Unlink" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent("not found");
  });

  it("asks before unlinking, and does nothing on Cancel", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF, { ...OTHER, signInMethod: "entra" }]);
      if (url === "/core/api/users/other-1/unlink-entra") return jsonResponse(200, { ...OTHER, signInMethod: "local" });
      return null;
    });
    render(withAuth(<UsersScreen />));
    await openEditor("other@x.invalid");
    const row = (await screen.findByRole("heading", { name: "other@x.invalid", level: 3 })).closest<HTMLElement>(".gcpe-users__editor")!;
    const user = userEvent.setup();
    await user.click(within(row).getByRole("button", { name: "Unlink other@x.invalid from Microsoft sign-in" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.url === "/core/api/users/other-1/unlink-entra")).toBe(false);
    expect(within(row).getByText("Sign-in: Microsoft (Entra)")).toBeInTheDocument();
  });
});
