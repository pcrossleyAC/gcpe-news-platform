import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { createMemoryRouter, Link, RouterProvider } from "react-router";
import { jsonResponse } from "../../test/jsonResponse";
import { SessionProvider } from "./SessionContext";
import { RequireAuth } from "./RequireAuth";
import { AppShell } from "../shell/AppShell";
import { SignIn } from "../screens/SignIn";
import { LeavePageGuard } from "../shared/LeaveGuard";
import { apiFetch } from "../api/client";
import { saveDraft, loadDraft } from "../screens/release/documents/unsavedDocumentStorage";
import axe from "axe-core";

/** A stand-in edit screen: one field, guarded by the Hub's shared leave-page rule. */
function EditScreen(): React.JSX.Element {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <h1>Edit something</h1>
      <label>
        Bio
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <Link to="/elsewhere">Somewhere else</Link>
      <button type="button" onClick={() => apiFetch("/core/api/thing", { method: "PUT", body: { text } }).then(() => setError("Saved"), (e: Error) => setError(e.message))}>
        Save
      </button>
      {error && <p role="alert">{error}</p>}
      <LeavePageGuard dirty={text !== ""} />
    </>
  );
}

let sessionOk = true;
function stub() {
  sessionOk = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/core/auth/session") {
        return sessionOk
          ? jsonResponse(200, { user: { id: "user-a", name: "Pat", email: "pat@example.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() })
          : jsonResponse(401, { error: "not signed in" });
      }
      if (url === "/core/auth/logout") return new Response(null, { status: 204 });
      if (url === "/core/api/thing") return sessionOk ? jsonResponse(200, {}) : jsonResponse(401, { error: "missing bearer token" });
      if (url === "/core/auth/methods") return jsonResponse(200, { entra: false, local: true });
      if (url === "/core/api/time-zone-check") return jsonResponse(200, { timeZone: "America/Vancouver" });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function renderHub() {
  const router = createMemoryRouter(
    [
      { path: "/sign-in", element: <SignIn /> },
      {
        element: (
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        ),
        children: [
          { path: "/edit", element: <EditScreen /> },
          { path: "/elsewhere", element: <h1>Somewhere else</h1> },
        ],
      },
    ],
    { initialEntries: ["/edit"] },
  );
  render(
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return router;
}

/** The session check the Hub makes when the tab comes back into view. */
function showTab() {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("when the session ends (suite review H1)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("with unsaved changes, the screen stays as it was and the Hub explains, then Sign in again goes to sign-in", async () => {
    stub();
    const router = renderHub();
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Bio" }), "Half-written bio");
    sessionOk = false;
    showTab();

    const dialog = await screen.findByRole("alertdialog", { name: "Your session has ended" });
    expect(dialog).toHaveTextContent("You were signed out, so the changes on this page can’t be saved until you sign in again.");
    // Owner decision 2026-10-31: the 12-hour limit is one of the reasons, said plainly.
    expect(dialog).toHaveTextContent("Sessions last 12 hours.");
    expect(dialog).toHaveTextContent("Unsaved changes on this page are lost when you sign in again here, so copy anything you need first.");
    await user.click(within(dialog).getByRole("button", { name: "Stay on this page" }));
    // Still there to copy from, with a notice that stays.
    expect(screen.getByRole("textbox", { name: "Bio" })).toHaveValue("Half-written bio");
    expect(screen.getByRole("alert", { name: "Your session has ended" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toBe(`?return=${encodeURIComponent("/edit")}`);
    expect(screen.getByText("Your session ended. Sign in to carry on where you left off.")).toBeInTheDocument();
  });

  // Fix round 1 (I1): staying on the page after the session ended, a Save says why it can't, in
  // plain words, and the dialog comes back on each new refusal.
  it("after Stay on this page, Save says the session has ended and the dialog comes back", async () => {
    stub();
    renderHub();
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Bio" }), "Half-written bio");
    sessionOk = false;
    showTab();
    await user.click(within(await screen.findByRole("alertdialog", { name: "Your session has ended" })).getByRole("button", { name: "Stay on this page" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alertdialog", { name: "Your session has ended" })).toBeInTheDocument();
    expect(screen.getByText("Your session has ended. Sign in again to save — your changes are still here.")).toBeInTheDocument();
    expect(screen.queryByText(/bearer/)).toBeNull();
    expect(screen.getByRole("textbox", { name: "Bio", hidden: true })).toHaveValue("Half-written bio");
  });

  it("a background check-in refused again doesn't bring the dialog back", async () => {
    stub();
    renderHub();
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Bio" }), "x");
    sessionOk = false;
    showTab();
    await user.click(within(await screen.findByRole("alertdialog", { name: "Your session has ended" })).getByRole("button", { name: "Stay on this page" }));
    const calls = vi.mocked(fetch).mock.calls.length;
    showTab();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(calls));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("alert", { name: "Your session has ended" })).toBeInTheDocument();
  });

  it("with nothing unsaved, goes straight to sign-in, which says why", async () => {
    stub();
    const router = renderHub();
    await screen.findByRole("textbox", { name: "Bio" });
    sessionOk = false;
    showTab();
    expect(await screen.findByText("Your session ended. Sign in to carry on where you left off.")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sign-in");
  });

  it("signing in again in another tab is picked up when they come back, and the screen carries on", async () => {
    stub();
    renderHub();
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Bio" }), "Half-written bio");
    sessionOk = false;
    showTab();
    await user.click(within(await screen.findByRole("alertdialog", { name: "Your session has ended" })).getByRole("button", { name: "Stay on this page" }));
    sessionOk = true;
    showTab();
    await waitFor(() => expect(screen.queryByRole("alert", { name: "Your session has ended" })).toBeNull());
    expect(screen.getByRole("textbox", { name: "Bio" })).toHaveValue("Half-written bio");
  });

  it("a kept draft survives Sign in again (it isn't cleared like an explicit sign-out)", async () => {
    stub();
    renderHub();
    const key = { userId: "user-a", releaseId: "r1", documentId: "d1", languageId: 4105 };
    saveDraft(key, { version: 1, form: { headline: "Unsaved" } });
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Bio" }), "x");
    sessionOk = false;
    showTab();
    await user.click(within(await screen.findByRole("alertdialog", { name: "Your session has ended" })).getByRole("button", { name: "Sign in again" }));
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(loadDraft(key)).not.toBeNull();
  });
});

describe("Sign out with unsaved changes (suite review H1)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("asks first: Stay keeps the changes, Sign out signs out", async () => {
    stub();
    const router = renderHub();
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Bio" }), "Half-written bio");
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    expect(dialog).toHaveTextContent("You have unsaved changes on this page. Sign out anyway and discard them?");
    await user.click(within(dialog).getByRole("button", { name: "Stay" }));
    expect(screen.getByRole("textbox", { name: "Bio" })).toHaveValue("Half-written bio");
    expect(fetch).not.toHaveBeenCalledWith("/core/auth/logout", expect.anything());

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "Unsaved changes" })).getByRole("button", { name: "Sign out" }));
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(fetch).toHaveBeenCalledWith("/core/auth/logout", expect.anything());
    expect(screen.queryByText("Your session ended. Sign in to carry on where you left off.")).toBeNull();
  });

  it("signs out at once when nothing is unsaved", async () => {
    stub();
    renderHub();
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Bio" });
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("leaving a screen with unsaved changes, inside the shell (suite review H2)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("the side menu or a link asks first; Stay keeps the changes, Leave goes", async () => {
    stub();
    const router = renderHub();
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Bio" }), "Half-written bio");
    await user.click(screen.getByRole("link", { name: "Somewhere else" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    expect(dialog).toHaveTextContent("You have unsaved changes on this page. Leave anyway and discard them?");
    await user.click(within(dialog).getByRole("button", { name: "Stay" }));
    expect(router.state.location.pathname).toBe("/edit");
    expect(screen.getByRole("textbox", { name: "Bio" })).toHaveValue("Half-written bio");

    await user.click(screen.getByRole("link", { name: "Users" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "Unsaved changes" })).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/users"));
  });

  it("closing or reloading the tab gets the browser's own prompt only while something is unsaved", async () => {
    stub();
    renderHub();
    const user = userEvent.setup();
    const field = await screen.findByRole("textbox", { name: "Bio" });
    const unload = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload()).toBe(false);
    await user.type(field, "x");
    expect(unload()).toBe(true);
    await user.clear(field);
    expect(unload()).toBe(false);
  });
});

/** React Aria makes the page behind a dialog inert in real browsers; jsdom has no `inert`, so axe
 * sees aria-hidden alone over focusable fields. That one rule is off while a dialog is open, as in
 * the Calendar and Subscribers dialogs' axe tests; the e2e axe sweep checks a real browser. */
const WITH_DIALOG = { rules: { "aria-hidden-focus": { enabled: false } } };
async function seriousViolations(container: Element, options: axe.RunOptions = {}) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] }, ...options });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id);
}

describe("accessibility of the session and leave questions", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("the Your session has ended dialog, the notice it leaves, and sign-in's explanation", async () => {
    stub();
    renderHub();
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Bio" }), "x");
    sessionOk = false;
    showTab();
    const dialog = await screen.findByRole("alertdialog", { name: "Your session has ended" });
    expect(await seriousViolations(document.body, WITH_DIALOG)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Stay on this page" }));
    expect(await seriousViolations(document.body)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    await screen.findByText("Your session ended. Sign in to carry on where you left off.");
    expect(await seriousViolations(document.body)).toEqual([]);
  });

  it("the Sign out and leave-page questions", async () => {
    stub();
    renderHub();
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Bio" }), "x");
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    const signOut = await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    expect(await seriousViolations(document.body, WITH_DIALOG)).toEqual([]);
    await user.click(within(signOut).getByRole("button", { name: "Stay" }));
    await user.click(screen.getByRole("link", { name: "Somewhere else" }));
    await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    expect(await seriousViolations(document.body, WITH_DIALOG)).toEqual([]);
  });
});

