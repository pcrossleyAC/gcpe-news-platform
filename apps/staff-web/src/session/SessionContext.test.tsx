import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { jsonResponse } from "../../test/jsonResponse";
import { saveDraft, loadDraft } from "../screens/release/documents/unsavedDocumentStorage";
import { SessionProvider, useSession } from "./SessionContext";

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
