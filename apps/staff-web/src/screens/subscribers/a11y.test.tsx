/** axe checks for the Subscribers section (task-5-brief.md's "axe clean on every screen"). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import axe from "axe-core";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { SubscribersScreen } from "./SubscribersScreen";
import { AddSubscriberScreen } from "./AddSubscriberScreen";
import type { SubscriberPage } from "./types";

async function seriousViolations(container: Element, options?: Parameters<typeof axe.run>[1]) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] }, ...options });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

const PAGE: SubscriberPage = {
  total: 2,
  page: 1,
  pageSize: 50,
  items: [
    { id: "11111111-1111-1111-1111-111111111111", email: "pat@example.test", status: "active", source: "self", asItHappens: true, digest: false, createdAt: "2026-10-01T17:00:00.000Z", needsAttention: null },
    { id: "22222222-2222-2222-2222-222222222222", email: "lee@example.test", status: "disabled", source: "admin", asItHappens: false, digest: true, createdAt: "2026-10-02T17:00:00.000Z", needsAttention: null },
  ],
};
const OPTIONS = { categories: [{ key: "ministries", name: "Ministries", lists: [{ listKey: "ministries:health", name: "Health" }] }] };

function stubCommon(roles: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
      if (url === "/nod/api/subscribers/search") return jsonResponse(200, PAGE);
      if (url === "/nod/api/subscriber-list-options") return jsonResponse(200, OPTIONS);
      if (url === "/nod/api/subscribers/bulk") return jsonResponse(200, { changed: 0, skipped: [] });
      return jsonResponse(200, {});
    }),
  );
}

function withAuth(children: React.ReactNode) {
  return (
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>{children}</RequireAuth>
      </MemoryRouter>
    </SessionProvider>
  );
}

describe("accessibility — Subscribers", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("SubscribersScreen (Editor: checkboxes and bulk buttons present)", async () => {
    stubCommon(["NoD.Editor"]);
    const { container } = render(withAuth(<SubscribersScreen />));
    await screen.findByRole("link", { name: "pat@example.test" });
    expect(screen.getByRole("checkbox", { name: "Select all on this page" })).toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("SubscribersScreen with the bulk delete dialog open", async () => {
    stubCommon(["NoD.Editor"]);
    const { container } = render(withAuth(<SubscribersScreen />));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Select all on this page" }));
    await user.click(screen.getByRole("button", { name: "Delete selected (2)" }));
    await screen.findByRole("alertdialog");
    // React Aria hides the rest of the page from screen readers via `inert` on real browsers
    // (verified in @bcgov/design-system-react-components's ModalOverlay: it asks for
    // `shouldUseInert: true`), which also makes that content unfocusable. jsdom doesn't
    // implement `inert` at all, so the fallback here is aria-hidden alone, which axe correctly
    // flags as leaving focusable elements behind — a gap in this test environment, not in the
    // rendered page: this one rule is excluded from the check for that reason.
    expect(await seriousViolations(container, { rules: { "aria-hidden-focus": { enabled: false } } })).toEqual([]);
  });

  it("AddSubscriberScreen with options loaded", async () => {
    stubCommon(["NoD.Editor"]);
    const { container } = render(
      <SessionProvider>
        <MemoryRouter initialEntries={["/subscribers/new"]}>
          <RequireAuth>
            <Routes>
              <Route path="/subscribers/new" element={<AddSubscriberScreen />} />
            </Routes>
          </RequireAuth>
        </MemoryRouter>
      </SessionProvider>,
    );
    await screen.findByRole("checkbox", { name: "Health" });
    expect(await seriousViolations(container)).toEqual([]);
  });
});
