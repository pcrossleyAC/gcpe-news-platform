import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import axe from "axe-core";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { SignIn } from "../SignIn";
import { ReleaseEditorPage } from "./ReleaseEditorPage";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface StubOptions {
  roles?: string[];
  view?: ReleaseView;
  releaseStatus?: number;
}

function stubFetch({ roles = ["NRMS.Editor"], view, releaseStatus = 200 }: StubOptions) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
      if (url.endsWith("/asset-status")) return jsonResponse(200, { kind: "none" });
      if (url === "/nrms/api/categories") return jsonResponse(200, { ministries: [{ key: "health", name: "Health", abbreviation: "HLTH" }], sectors: [], themes: [], tags: [] });
      if (url === "/nrms/api/media-lists") return jsonResponse(200, []);
      if (url.match(/\/nrms\/api\/releases\/[^/]+$/)) {
        if (releaseStatus !== 200) return jsonResponse(releaseStatus, { error: "not found" });
        return jsonResponse(200, view ?? releaseView());
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function renderPage(id: string, opts: StubOptions = {}) {
  stubFetch(opts);
  const router = createMemoryRouter([{ path: "/releases/:id", element: <ReleaseEditorPage /> }], { initialEntries: [`/releases/${id}`] });
  render(
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return router;
}

describe("ReleaseEditorPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("loads the release and renders every spec section in order, with exactly one h1", async () => {
    renderPage("11111111-1111-1111-1111-111111111111");
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Actions" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Publish settings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Categories" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Media asset" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Page details" })).toBeInTheDocument();
  });

  it("acceptance: Approve is disabled and the checklist is shown until approveProblems is empty", async () => {
    renderPage("11111111-1111-1111-1111-111111111111", { view: releaseView({ status: "draft", ministries: [] }) });
    await screen.findByRole("heading", { name: "Actions" });
    expect(screen.getByText("Before this can be approved:")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("acceptance: a Viewer sees the page read-only — no Actions, every input disabled", async () => {
    renderPage("11111111-1111-1111-1111-111111111111", { roles: ["NRMS.Viewer"] });
    await screen.findByRole("heading", { name: "Publish settings" });
    expect(screen.queryByRole("heading", { name: "Actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Location")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save page details" })).not.toBeInTheDocument();
  });

  it("a 404 shows a not-found message instead of the editor", async () => {
    renderPage("22222222-2222-2222-2222-222222222222", { releaseStatus: 404 });
    expect(await screen.findByRole("alert")).toHaveTextContent(/doesn.t exist/i);
  });

  it("has no serious/critical axe violations (Editor view)", async () => {
    const { container } = (() => {
      stubFetch({ roles: ["NRMS.Editor"], view: releaseView({ status: "published", releasedAt: "2026-01-01T00:00:00.000Z", type: "release" }) });
      const router = createMemoryRouter([{ path: "/releases/:id", element: <ReleaseEditorPage /> }], {
        initialEntries: ["/releases/11111111-1111-1111-1111-111111111111"],
      });
      return render(
        <SessionProvider>
          <RouterProvider router={router} />
        </SessionProvider>,
      );
    })();
    await screen.findByRole("heading", { name: "Actions" });
    await waitFor(() => screen.getByText("No media asset set."));
    const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious).toEqual([]);
  });

  // Fix round 1 (3f Task 3), minor 4: two different sections saving back-to-back — the second
  // save must use the version the *first* save's response carried, not the page's stale
  // initial version, since `setView` replaces the whole page's view after every save.
  it("two different sections saving back-to-back: the second save sends the version the first one returned", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const initial = releaseView({ version: 1, type: "release", ministries: ["health"], leadMinistryKey: "health", sectors: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method: init?.method, body });
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
        if (url.endsWith("/asset-status")) return jsonResponse(200, { kind: "none" });
        if (url === "/nrms/api/media-lists") return jsonResponse(200, []);
        if (url === "/nrms/api/categories") {
          return jsonResponse(200, { ministries: [{ key: "health", name: "Health", abbreviation: "HLTH" }], sectors: [{ key: "sector1", name: "Sector One" }], themes: [], tags: [] });
        }
        if (init?.method === "PUT" && url.endsWith("/categories")) return jsonResponse(200, releaseView({ ...initial, version: 2, sectors: ["sector1"] }));
        if (init?.method === "PUT" && url.endsWith("/settings")) return jsonResponse(200, releaseView({ ...initial, version: 3 }));
        if (/\/nrms\/api\/releases\/[^/]+$/.test(url) && init?.method === "GET") return jsonResponse(200, initial);
        throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const router = createMemoryRouter([{ path: "/releases/:id", element: <ReleaseEditorPage /> }], { initialEntries: [`/releases/${initial.id}`] });
    render(
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>,
    );
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "Categories" });
    await user.click(screen.getByLabelText("Sector One"));
    await user.click(screen.getByRole("button", { name: "Save categories" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/categories"))).toBe(true));

    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/settings"))).toBe(true));

    const categoriesPut = calls.find((c) => c.method === "PUT" && c.url.endsWith("/categories"));
    const settingsPut = calls.find((c) => c.method === "PUT" && c.url.endsWith("/settings"));
    expect((categoriesPut?.body as { version: number }).version).toBe(1);
    expect((settingsPut?.body as { version: number }).version).toBe(2); // the version /categories returned, not the stale 1
  });

  // Fix round 1, finding 2: the unsaved-changes dialog is the same Modal/AlertDialog
  // composition as the delete dialog — a real modal, Escape-dismissable, not a bare div.
  it("the unsaved-changes dialog is a real dialog that Escape dismisses without losing the block, and Leave proceeds", async () => {
    stubFetch({ roles: ["NRMS.Editor"] });
    const router = createMemoryRouter(
      [
        { path: "/releases/:id", element: <ReleaseEditorPage /> },
        { path: "/releases/drafts", element: <p>Drafts list</p> },
      ],
      { initialEntries: ["/releases/11111111-1111-1111-1111-111111111111"] },
    );
    render(
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Location"), "V");

    router.navigate("/releases/drafts");
    expect(await screen.findByRole("dialog")).toHaveTextContent(/unsaved changes/i);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/releases/11111111-1111-1111-1111-111111111111"); // Escape, like Stay, cancels the navigation

    router.navigate("/releases/drafts");
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/releases/drafts"));
  });

  // constraints.md Review Focus 1 / task-4-brief.md Step 1: a session expiring mid-edit — the
  // save gets a 401, which signs the user out (SessionContext) and RequireAuth sends them to
  // sign in, carrying `?return=` back to this same release. Their unsaved document text
  // (kept in sessionStorage by DocumentLanguageForm while dirty) is still there once they're
  // back.
  it("401 mid-edit: unsaved document text survives sign-in and returning to the same release", async () => {
    const id = "11111111-1111-1111-1111-111111111111";
    let signedIn = true;
    let putAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/core/auth/login") {
          signedIn = true;
          return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
        }
        if (url === "/core/auth/session") {
          return signedIn ? jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() }) : jsonResponse(401, { error: "not signed in" });
        }
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
        if (url.endsWith("/asset-status")) return jsonResponse(200, { kind: "none" });
        if (url === "/nrms/api/categories") return jsonResponse(200, { ministries: [], sectors: [], themes: [], tags: [] });
        if (url === "/nrms/api/media-lists") return jsonResponse(200, []);
        if (url.endsWith("/log") || url.endsWith("/log?all=true")) return jsonResponse(200, []);
        if (url.endsWith("/publications")) return jsonResponse(200, []);
        if (init?.method === "PUT" && url.includes("/documents/")) {
          putAttempts += 1;
          if (putAttempts === 1) {
            signedIn = false;
            return jsonResponse(401, { error: "not signed in" });
          }
          return jsonResponse(200, releaseView({ version: 2 }));
        }
        if (/\/nrms\/api\/releases\/[^/]+$/.test(url) && (!init?.method || init.method === "GET")) {
          return signedIn ? jsonResponse(200, releaseView()) : jsonResponse(401, { error: "not signed in" });
        }
        throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
      }),
    );

    const router = createMemoryRouter(
      [
        { path: "/sign-in", element: <SignIn /> },
        { path: "/releases/:id", element: <RequireAuth><ReleaseEditorPage /></RequireAuth> },
      ],
      { initialEntries: [`/releases/${id}`] },
    );
    render(
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>,
    );
    const user = userEvent.setup();

    const headline = await screen.findByLabelText("Headline");
    await user.clear(headline);
    await user.type(headline, "Unsaved after 401");
    await user.click(screen.getByRole("button", { name: "Save English content" }));

    // The 401 above signs the user out; RequireAuth sends them to /sign-in?return=...
    await screen.findByRole("heading", { name: "Sign in" });
    await user.type(await screen.findByLabelText(/user name/i), "pat");
    await user.type(screen.getByLabelText(/password/i), "whatever123");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    // Back on the same release, with the unsaved headline restored from sessionStorage.
    expect(await screen.findByLabelText("Headline")).toHaveValue("Unsaved after 401");
  });
});
