import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { jsonResponse } from "../../test/jsonResponse";
import { saveDraft, loadDraft } from "../screens/release/documents/unsavedDocumentStorage";
import { SessionProvider, useSession } from "./SessionContext";
import { FIELDS } from "../screens/calendar/activity/fixtures";
import { loadActivityDraft, saveActivityDraft } from "../screens/calendar/activity/draft";

/** A minimal consumer so these tests can drive `signOut` through the public hook, the same way
 * every real screen does — SessionContext itself renders nothing. */
function Consumer(): React.JSX.Element {
  const session = useSession();
  // `.catch(() => {})`: a failed logout request is a pre-existing, separate concern (AppShell's
  // own sign-out handler doesn't catch it either) — these tests only care that the draft wipe
  // in `signOut`'s `finally` runs regardless, not about an unhandled rejection in the harness.
  return <button onClick={() => void session.signOut().catch(() => {})}>Sign out</button>;
}

const DRAFT_KEY = { userId: "user-a", releaseId: "r1", documentId: "d1", languageId: 4105 };

describe("SessionContext signOut (Fix round 1, finding 1)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("an explicit sign-out clears every unsaved document draft", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "user-a", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
        if (url === "/core/auth/logout") return new Response(null, { status: 204 });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    saveDraft(DRAFT_KEY, { headline: "Unsaved" });

    render(
      <SessionProvider>
        <Consumer />
      </SessionProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(loadDraft(DRAFT_KEY)).toBeNull());
  });

  it("an explicit sign-out clears every kept Calendar activity draft too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "user-a", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Editor"] }, expiresAt: new Date().toISOString() });
        if (url === "/core/auth/logout") return new Response(null, { status: 204 });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    saveActivityDraft("user-a", { activityId: 20001, version: 3, fields: FIELDS });
    render(
      <SessionProvider>
        <Consumer />
      </SessionProvider>,
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(loadActivityDraft("user-a", 20001)).toBeNull());
  });

  it("drafts still get cleared even if the logout request itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "user-a", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
        if (url === "/core/auth/logout") return jsonResponse(500, { error: "boom" });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    saveDraft(DRAFT_KEY, { headline: "Unsaved" });

    render(
      <SessionProvider>
        <Consumer />
      </SessionProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(loadDraft(DRAFT_KEY)).toBeNull());
  });
});

describe("SessionContext: checking in when the tab comes back", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function Who(): React.JSX.Element {
    const { user } = useSession();
    return <p>{user ? `Signed in as ${user.name}` : "Signed out"}</p>;
  }
  const signedIn = () => jsonResponse(200, { user: { id: "user-a", name: "Pat", email: "pat@x.invalid", roles: [] }, expiresAt: new Date().toISOString() });
  const showTab = () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  };

  it("an expired session is found as soon as the tab is visible again", async () => {
    let expired = false;
    const fetch = vi.fn(async () => (expired ? jsonResponse(401, { error: "Sign in" }) : signedIn()));
    vi.stubGlobal("fetch", fetch);
    render(
      <SessionProvider>
        <Who />
      </SessionProvider>,
    );
    await screen.findByText("Signed in as Pat");
    expired = true;
    showTab();
    expect(await screen.findByText("Signed out")).toBeInTheDocument();
  });

  it("a network failure on that check doesn't sign anyone out", async () => {
    let offline = false;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (offline) throw new TypeError("Failed to fetch");
      return signedIn();
    }));
    render(
      <SessionProvider>
        <Who />
      </SessionProvider>,
    );
    await screen.findByText("Signed in as Pat");
    offline = true;
    showTab();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("Signed in as Pat")).toBeInTheDocument();
  });
});
