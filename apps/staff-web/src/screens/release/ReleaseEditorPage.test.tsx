import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import axe from "axe-core";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { SignIn } from "../SignIn";
import { ReleaseEditorPage, SETTLING_REFRESH_MS, settlingDelay } from "./ReleaseEditorPage";
import { RELOAD_MESSAGE } from "./useReleaseSection";

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
    // Several tests below share the same release id and the same signed-in user id — without
    // this, a draft DocumentLanguageForm saved to sessionStorage (session-expiry recovery) in
    // one test leaks into the next and pre-dirties it.
    sessionStorage.clear();
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

  // Section saves are queued: each one waits for the save before it and then sends the version
  // that save returned, so saving a second section (or the same one again) while a save is
  // still in flight never 409s against our own earlier save.
  describe("queued section saves", () => {
    interface HeldWrite {
      url: string;
      method?: string;
      body: { version?: number; sectors?: string[] };
      respond(res: Response): void;
    }

    const initial = releaseView({ version: 1, type: "release", ministries: ["health"], leadMinistryKey: "health", sectors: [] });

    /** Renders the editor with every PUT/POST held until the test calls `respond` on it. */
    function renderWithHeldWrites() {
      const writes: HeldWrite[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
          if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
          if (url.endsWith("/asset-status")) return jsonResponse(200, { kind: "none" });
          if (url === "/nrms/api/media-lists") return jsonResponse(200, []);
          if (url === "/nrms/api/categories") {
            return jsonResponse(200, { ministries: [{ key: "health", name: "Health", abbreviation: "HLTH" }], sectors: [{ key: "sector1", name: "Sector One" }], themes: [], tags: [] });
          }
          if (init?.method === "PUT" || init?.method === "POST") {
            const body = init.body ? JSON.parse(init.body as string) : {};
            return new Promise<Response>((resolve) => writes.push({ url, method: init.method, body, respond: resolve }));
          }
          if (/\/nrms\/api\/releases\/[^/]+$/.test(url)) return jsonResponse(200, initial);
          throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
        }),
      );
      const router = createMemoryRouter([{ path: "/releases/:id", element: <ReleaseEditorPage /> }], { initialEntries: [`/releases/${initial.id}`] });
      render(
        <SessionProvider>
          <RouterProvider router={router} />
        </SessionProvider>,
      );
      return { writes, user: userEvent.setup() };
    }

    /** Ticks Sector One (dirtying Categories) and saves Categories from its own inline button;
     * resolves once that PUT is in flight. */
    async function startCategoriesSave(writes: HeldWrite[], user: ReturnType<typeof userEvent.setup>) {
      // The checkbox list comes from its own GET /categories, which can land after the section's
      // heading has already rendered.
      await user.click(await screen.findByLabelText("Sector One"));
      // Checking that box also dirties the sticky save bar, which gets its own "Save categories"
      // button — scope to the Categories section itself for its inline one.
      await screen.findByRole("region", { name: "Unsaved changes" });
      await user.click(within(screen.getByRole("region", { name: "Categories" })).getByRole("button", { name: "Save categories" }));
      await waitFor(() => expect(writes).toHaveLength(1));
    }

    const categoriesRegion = () => screen.getByRole("region", { name: "Categories" });
    const settingsRegion = () => screen.getByRole("region", { name: "Publish settings" });

    it("a second section saved while the first is in flight waits, then sends the version the first returned", async () => {
      const { writes, user } = renderWithHeldWrites();
      await startCategoriesSave(writes, user);
      expect(within(categoriesRegion()).getByText("Saving…")).toBeInTheDocument();

      await user.click(within(settingsRegion()).getByRole("button", { name: "Save settings" }));
      expect(await within(settingsRegion()).findByText("Waiting to save…")).toBeInTheDocument();
      expect(within(settingsRegion()).getByRole("button", { name: "Save settings" })).toBeDisabled();
      expect(writes).toHaveLength(1); // held: Settings has not gone out yet

      writes[0]!.respond(jsonResponse(200, releaseView({ ...initial, version: 2, sectors: ["sector1"] })));
      await waitFor(() => expect(writes).toHaveLength(2));
      expect(writes[0]!.url).toMatch(/\/categories$/);
      expect(writes[0]!.body.version).toBe(1);
      expect(writes[1]!.url).toMatch(/\/settings$/);
      expect(writes[1]!.body.version).toBe(2); // the version /categories returned, not the stale 1
      expect(await within(settingsRegion()).findByText("Saving…")).toBeInTheDocument();

      writes[1]!.respond(jsonResponse(200, releaseView({ ...initial, version: 3, sectors: ["sector1"] })));
      await waitFor(() => expect(within(settingsRegion()).getByRole("button", { name: "Save settings" })).toBeEnabled());
      expect(within(settingsRegion()).queryByText(/Saving…|Waiting to save…/)).not.toBeInTheDocument();
      expect(within(categoriesRegion()).queryByText(/Saving…|Waiting to save…/)).not.toBeInTheDocument();
      expect(within(settingsRegion()).queryByRole("alert")).not.toBeInTheDocument();
      expect(within(categoriesRegion()).queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Sector One")).toBeChecked(); // the user's edit survived
      expect(writes).toHaveLength(2);
    });

    it("the same section saved twice in quick succession runs both saves, in order", async () => {
      const { writes, user } = renderWithHeldWrites();
      await startCategoriesSave(writes, user);

      // The sticky bar's button is a second way to reach the same section's save.
      const bar = screen.getByRole("region", { name: "Unsaved changes" });
      await user.click(within(bar).getByRole("button", { name: "Save categories" }));
      expect(writes).toHaveLength(1); // the second save waits for the first

      writes[0]!.respond(jsonResponse(200, releaseView({ ...initial, version: 2, sectors: ["sector1"] })));
      await waitFor(() => expect(writes).toHaveLength(2));
      expect(within(categoriesRegion()).getByText("Saving…")).toBeInTheDocument(); // still busy with the second
      writes[1]!.respond(jsonResponse(200, releaseView({ ...initial, version: 3, sectors: ["sector1"] })));

      await waitFor(() => expect(within(categoriesRegion()).queryByText("Saving…")).not.toBeInTheDocument());
      expect(writes.map((w) => [w.url.replace(/^.*\//, ""), w.body.version])).toEqual([
        ["categories", 1],
        ["categories", 2],
      ]);
      expect(writes[1]!.body.sectors).toEqual(["sector1"]);
      expect(within(categoriesRegion()).queryByRole("alert")).not.toBeInTheDocument();
    });

    it("a genuine conflict (someone else moved the version) still shows the reload message", async () => {
      const { writes, user } = renderWithHeldWrites();
      await startCategoriesSave(writes, user);
      await user.click(within(settingsRegion()).getByRole("button", { name: "Save settings" }));
      writes[0]!.respond(jsonResponse(200, releaseView({ ...initial, version: 2, sectors: ["sector1"] })));
      await waitFor(() => expect(writes).toHaveLength(2));
      expect(writes[1]!.body.version).toBe(2);

      // The server is already past version 2 — someone else saved in between.
      writes[1]!.respond(jsonResponse(409, { error: "version conflict", code: "version_conflict" }));
      expect(await within(settingsRegion()).findByRole("alert")).toHaveTextContent(RELOAD_MESSAGE);
      expect(within(categoriesRegion()).queryByRole("alert")).not.toBeInTheDocument();
      expect(within(settingsRegion()).queryByText(/Saving…|Waiting to save…/)).not.toBeInTheDocument();
    });

    it("a failed save shows its own error and the queue carries on with the last good version", async () => {
      const { writes, user } = renderWithHeldWrites();
      await startCategoriesSave(writes, user);
      await user.click(within(settingsRegion()).getByRole("button", { name: "Save settings" }));
      expect(await within(settingsRegion()).findByText("Waiting to save…")).toBeInTheDocument();

      writes[0]!.respond(jsonResponse(500, { error: "Something went wrong saving categories." }));
      await waitFor(() => expect(writes).toHaveLength(2));
      expect(writes[1]!.url).toMatch(/\/settings$/);
      expect(writes[1]!.body.version).toBe(1); // the failed save moved nothing
      writes[1]!.respond(jsonResponse(200, releaseView({ ...initial, version: 2 })));

      expect(await within(categoriesRegion()).findByRole("alert")).toHaveTextContent("Something went wrong saving categories.");
      await waitFor(() => expect(within(settingsRegion()).getByRole("button", { name: "Save settings" })).toBeEnabled());
      expect(within(settingsRegion()).queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Sector One")).toBeChecked(); // the failed section keeps its edit
    });

    it("has no serious/critical axe violations while a save is waiting", async () => {
      const { writes, user } = renderWithHeldWrites();
      await startCategoriesSave(writes, user);
      await user.click(within(settingsRegion()).getByRole("button", { name: "Save settings" }));
      await within(settingsRegion()).findByText("Waiting to save…");
      const results = await axe.run(document.body, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
      const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(serious).toEqual([]);
    });
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

  // Hand-check feedback: the page sat on "Republishing..." until it was reloaded by hand.
  it("re-fetches the release on its own while it's publishing, and stops once it has settled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      const statuses: ReleaseView["status"][] = ["publishing", "publishing", "published"];
      let gets = 0;
      const base = { status: "published" as const, reference: "NEWS-00001", key: "k", releasedAt: "2026-01-01T00:00:00.000Z" };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
          if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
          if (url === "/nrms/api/categories") return jsonResponse(200, { ministries: [], sectors: [], themes: [], tags: [] });
          if (url === "/nrms/api/media-lists") return jsonResponse(200, []);
          if (url.endsWith("/asset-status")) return jsonResponse(200, { kind: "none" });
          if (url.match(/\/nrms\/api\/releases\/[^/]+$/)) {
            const status = statuses[Math.min(gets, statuses.length - 1)]!;
            gets += 1;
            // A distinct reference per response, so the test can see each refresh land on the page.
            return jsonResponse(200, releaseView({ ...base, status, reference: `NEWS-0000${gets}` }));
          }
          return jsonResponse(200, []);
        }),
      );
      const router = createMemoryRouter([{ path: "/releases/:id", element: <ReleaseEditorPage /> }], { initialEntries: ["/releases/r1"] });
      render(
        <SessionProvider>
          <RouterProvider router={router} />
        </SessionProvider>,
      );
      expect(await screen.findByText("Republishing...")).toBeInTheDocument();
      expect(screen.getByText(/updates on its own/)).toBeInTheDocument();
      expect(gets).toBe(1);

      // Each refresh schedules the next one only once its response has re-rendered the page, so
      // wait for that before moving the clock on — otherwise the next poll lands past the advance.
      await act(() => vi.advanceTimersByTimeAsync(SETTLING_REFRESH_MS));
      expect(await screen.findAllByText("NEWS-00002")).not.toHaveLength(0);
      expect(gets).toBe(2);
      await act(() => vi.advanceTimersByTimeAsync(SETTLING_REFRESH_MS));
      expect(await screen.findByText("Published")).toBeInTheDocument();
      expect(screen.getAllByText("NEWS-00003")).not.toHaveLength(0);
      expect(screen.queryByText(/updates on its own/)).not.toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(SETTLING_REFRESH_MS * 3));
      expect(gets).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-fetch while the tab is hidden, but picks back up once it's visible again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const visibilitySpy = vi.spyOn(document, "visibilityState", "get");
    try {
      let gets = 0;
      const base = { status: "publishing" as const, reference: "NEWS-00001", key: "k", releasedAt: "2026-01-01T00:00:00.000Z" };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
          if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
          if (url === "/nrms/api/categories") return jsonResponse(200, { ministries: [], sectors: [], themes: [], tags: [] });
          if (url === "/nrms/api/media-lists") return jsonResponse(200, []);
          if (url.endsWith("/asset-status")) return jsonResponse(200, { kind: "none" });
          if (url.match(/\/nrms\/api\/releases\/[^/]+$/)) {
            gets += 1;
            return jsonResponse(200, releaseView({ ...base, status: "publishing" }));
          }
          return jsonResponse(200, []);
        }),
      );
      const router = createMemoryRouter([{ path: "/releases/:id", element: <ReleaseEditorPage /> }], { initialEntries: ["/releases/r2"] });
      render(
        <SessionProvider>
          <RouterProvider router={router} />
        </SessionProvider>,
      );
      await screen.findByText("Republishing...");
      expect(gets).toBe(1);

      // act(): a hidden tick only bumps state, and the page schedules its next check in the
      // effect that follows — act flushes that render before the clock moves on again, so the
      // next check is pending before the second advance (outside act it sometimes landed after).
      visibilitySpy.mockReturnValue("hidden");
      await act(() => vi.advanceTimersByTimeAsync(SETTLING_REFRESH_MS));
      expect(gets).toBe(1); // hidden — skipped the fetch

      visibilitySpy.mockReturnValue("visible");
      await act(() => vi.advanceTimersByTimeAsync(SETTLING_REFRESH_MS));
      await waitFor(() => expect(gets).toBe(2)); // visible again — picked back up
    } finally {
      visibilitySpy.mockRestore();
      vi.useRealTimers();
    }
  });

  // Hand-check feedback: a long document body pushed its own Save button far down the page —
  // this bar is always visible, and its button is the same save (same request/409/422 handling).
  it("the sticky save bar is hidden while clean, appears with the right label once dirty, and its button saves and makes it disappear", async () => {
    const v = releaseView({ version: 1 });
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
        if (url === "/nrms/api/categories") return jsonResponse(200, { ministries: [], sectors: [], themes: [], tags: [] });
        if (url === "/nrms/api/media-lists") return jsonResponse(200, []);
        if (url.endsWith("/asset-status")) return jsonResponse(200, { kind: "none" });
        if (init?.method === "PUT" && url.includes("/documents/")) {
          calls.push({ url, init });
          return jsonResponse(200, releaseView({ ...v, version: 2 }));
        }
        if (/\/nrms\/api\/releases\/[^/]+$/.test(url)) return jsonResponse(200, v);
        throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const router = createMemoryRouter([{ path: "/releases/:id", element: <ReleaseEditorPage /> }], { initialEntries: [`/releases/${v.id}`] });
    render(
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>,
    );
    const headline = await screen.findByLabelText("Headline");
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(headline, " more");
    const bar = await screen.findByRole("region", { name: "Unsaved changes" });
    expect(bar).toHaveTextContent("You have unsaved changes in: English content (Document 1)");
    const barButton = within(bar).getByRole("button", { name: "Save English content (Document 1)" });

    await user.click(barButton);
    await waitFor(() => expect(calls).toHaveLength(1));
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body).toMatchObject({ version: 1, headline: "Clinics open more" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Unsaved changes" })).not.toBeInTheDocument());
  });

  it("two dirty sections show two buttons in the bar", async () => {
    renderPage("11111111-1111-1111-1111-111111111111");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Headline"), " more");
    await user.type(await screen.findByLabelText("Location"), "V");
    const bar = await screen.findByRole("region", { name: "Unsaved changes" });
    expect(within(bar).getByRole("button", { name: "Save English content (Document 1)" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Save page details" })).toBeInTheDocument();
  });

  it("a read-only Viewer never sees the sticky save bar", async () => {
    renderPage("11111111-1111-1111-1111-111111111111", { roles: ["NRMS.Viewer"] });
    await screen.findByRole("heading", { name: "Publish settings" });
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).not.toBeInTheDocument();
  });

  it("has no serious/critical axe violations with the sticky save bar visible", async () => {
    renderPage("11111111-1111-1111-1111-111111111111");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Headline"), " more");
    await screen.findByRole("region", { name: "Unsaved changes" });
    const results = await axe.run(document.body, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious).toEqual([]);
  });
});

describe("settlingDelay", () => {
  const now = Date.parse("2026-10-05T20:00:00.000Z");

  it("polls while publishing or unpublishing", () => {
    expect(settlingDelay({ status: "publishing", publishAt: null }, now)).toBe(SETTLING_REFRESH_MS);
    expect(settlingDelay({ status: "unpublishing", publishAt: null }, now)).toBe(SETTLING_REFRESH_MS);
  });

  it("waits for a future schedule, then polls once it's due", () => {
    expect(settlingDelay({ status: "scheduled", publishAt: "2026-10-05T20:10:00.000Z" }, now)).toBe(10 * 60_000 + 1_000);
    expect(settlingDelay({ status: "scheduled", publishAt: "2026-10-05T19:59:00.000Z" }, now)).toBe(SETTLING_REFRESH_MS);
    expect(settlingDelay({ status: "scheduled", publishAt: "2026-12-25T20:00:00.000Z" }, now)).toBe(60 * 60_000);
  });

  it("does nothing for a settled release", () => {
    for (const status of ["draft", "approved", "published", "failed", "deleted"] as const) {
      expect(settlingDelay({ status, publishAt: null }, now)).toBeNull();
    }
  });
});
