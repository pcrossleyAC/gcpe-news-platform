import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import axe from "axe-core";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { SignIn } from "../SignIn";
import { AnnouncerProvider } from "../../shared/Announcer";
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
  // Owner decision 2026-10-29: one Save for the page. It saves every changed section to its own
  // endpoint, one after another — each waits for the one before and sends the version it
  // returned — and stops at the first that doesn't save, so nothing is lost or overwritten.
  describe("one Save for every changed section", () => {
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
        <AnnouncerProvider>
          <SessionProvider>
            <RouterProvider router={router} />
          </SessionProvider>
        </AnnouncerProvider>,
      );
      return { writes, user: userEvent.setup() };
    }

    const categoriesRegion = () => screen.getByRole("region", { name: "Categories" });
    const settingsRegion = () => screen.getByRole("region", { name: "Publish settings" });
    const bar = () => screen.getByRole("region", { name: "Unsaved changes" });

    /** Ticks Sector One (Categories) and the News On Demand box (Publish settings): two changed
     * sections, saved to two endpoints. */
    async function editCategoriesAndSettings(user: ReturnType<typeof userEvent.setup>) {
      // The lists sit behind the card's disclosure (closed by default): open it as a user would.
      // The checkbox list comes from its own GET /categories, which can land after the heading.
      await user.click(await screen.findByRole("button", { name: "Edit categories" }));
      await user.click(await screen.findByLabelText("Sector One"));
      await user.click(within(settingsRegion()).getByLabelText("Send to News On Demand subscribers"));
      await screen.findByRole("region", { name: "Unsaved changes" });
    }

    it("has no Save per section: one Save changes in the bar, and an Unsaved marker on each changed section's heading", async () => {
      const { user } = renderWithHeldWrites();
      await editCategoriesAndSettings(user);
      expect(screen.queryByRole("button", { name: /^Save (categories|settings|page details|media asset|English content)/ })).not.toBeInTheDocument();
      expect(within(bar()).getAllByRole("button")).toHaveLength(1);
      expect(within(bar()).getByRole("button", { name: "Save changes" })).toBeInTheDocument();
      expect(within(categoriesRegion()).getByRole("heading", { level: 2, name: "Categories, unsaved changes" })).toHaveTextContent(/Unsaved$/);
      expect(within(settingsRegion()).getByRole("heading", { level: 2, name: "Publish settings, unsaved changes" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Page details" })).not.toHaveTextContent("Unsaved");
    });

    it("Save changes saves every changed section, each sent once the one before has saved, with the version it returned; one \"Saved\" is announced", async () => {
      const { writes, user } = renderWithHeldWrites();
      await editCategoriesAndSettings(user);
      // The app's one polite announcer (other parts of the page have role=status too).
      const status = screen.getAllByRole("status").find((el) => el.getAttribute("aria-live") === "polite")!;
      await user.click(within(bar()).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(writes).toHaveLength(1));
      expect(within(bar()).getByRole("button", { name: "Saving…" })).toHaveAttribute("aria-disabled", "true");
      expect(writes[0]!.url).toMatch(/\/categories$/);
      expect(writes[0]!.body.version).toBe(1);

      writes[0]!.respond(jsonResponse(200, releaseView({ ...initial, version: 2, sectors: ["sector1"] })));
      await waitFor(() => expect(writes).toHaveLength(2));
      expect(writes[1]!.url).toMatch(/\/settings$/);
      expect(writes[1]!.body.version).toBe(2); // the version /categories returned, not the stale 1
      expect(status).not.toHaveTextContent(/^Saved/);

      writes[1]!.respond(jsonResponse(200, releaseView({ ...initial, version: 3, sectors: ["sector1"], publishOptions: { ...initial.publishOptions, toSubscribers: !initial.publishOptions.toSubscribers } })));
      expect(await screen.findByRole("region", { name: "Save status" })).toHaveTextContent("All changes saved.");
      await waitFor(() => expect(status).toHaveTextContent(/^Saved/));
      expect(screen.queryByRole("region", { name: "Unsaved changes" })).not.toBeInTheDocument();
      expect(screen.getByLabelText("Sector One")).toBeChecked();
      expect(writes).toHaveLength(2);
    });

    it("a conflict stops the save: that section shows the reload message, the bar names it, and the sections after it are not sent and keep their edits", async () => {
      const { writes, user } = renderWithHeldWrites();
      await editCategoriesAndSettings(user);
      await user.click(within(bar()).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(writes).toHaveLength(1));
      // Someone else saved the release in between.
      writes[0]!.respond(jsonResponse(409, { error: "version conflict", code: "version_conflict" }));
      expect(await within(categoriesRegion()).findByText(RELOAD_MESSAGE)).toBeInTheDocument();
      const problem = await within(bar()).findByRole("alert");
      expect(problem).toHaveTextContent("Couldn’t save categories. See why in that section. Not saved yet: settings.");
      expect(within(problem).getByRole("link", { name: "See why in that section" })).toHaveAttribute("href", "#section-categories");
      await new Promise((r) => setTimeout(r, 20));
      expect(writes).toHaveLength(1); // Publish settings was never sent
      expect(screen.getByLabelText("Sector One")).toBeChecked();
      expect(within(settingsRegion()).getByLabelText("Send to News On Demand subscribers")).toHaveProperty("checked", !initial.publishOptions.toSubscribers);
      expect(bar()).toHaveTextContent("You have unsaved changes in: categories, settings");
    });

    it("a failed save stops it too, and that section keeps its edits and says why", async () => {
      const { writes, user } = renderWithHeldWrites();
      await editCategoriesAndSettings(user);
      await user.click(within(bar()).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(writes).toHaveLength(1));
      writes[0]!.respond(jsonResponse(500, { error: "Something went wrong saving categories." }));
      expect(await within(categoriesRegion()).findByText("Something went wrong saving categories.")).toBeInTheDocument();
      expect(await within(bar()).findByRole("alert")).toHaveTextContent("Couldn’t save categories.");
      expect(writes).toHaveLength(1);
      expect(screen.getByLabelText("Sector One")).toBeChecked();
      // Saving again picks up where it stopped.
      await user.click(within(bar()).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(writes).toHaveLength(2));
      expect(writes[1]!.url).toMatch(/\/categories$/);
      expect(writes[1]!.body.version).toBe(1); // the failed save moved nothing
    });

    it("Ctrl+S (⌘S on a Mac), even from inside a text field, is the same one Save; the button shows the keys", async () => {
      const { writes, user } = renderWithHeldWrites();
      await editCategoriesAndSettings(user);
      const button = within(bar()).getByRole("button", { name: "Save changes" });
      expect(button).toHaveAttribute("aria-keyshortcuts", "Control+S");
      expect(button).toHaveTextContent("Ctrl+S");
      await user.click(screen.getByLabelText("Location"));
      const notCancelled = fireEvent.keyDown(screen.getByLabelText("Location"), { key: "s", ctrlKey: true });
      expect(notCancelled).toBe(false); // the browser's Save page is kept away
      await waitFor(() => expect(writes).toHaveLength(1));
      expect(writes[0]!.url).toMatch(/\/categories$/);
    });

    it("has no serious/critical axe violations while saving", async () => {
      const { writes, user } = renderWithHeldWrites();
      await editCategoriesAndSettings(user);
      await user.click(within(bar()).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(writes).toHaveLength(1));
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
    await user.click(screen.getByRole("button", { name: "Save changes" }));

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
  it("the sticky save bar is hidden while clean, appears naming the section once dirty, and its Save changes saves it and makes it go", async () => {
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
    const barButton = within(bar).getByRole("button", { name: "Save changes" });

    await user.click(barButton);
    await waitFor(() => expect(calls).toHaveLength(1));
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body).toMatchObject({ version: 1, headline: "Clinics open more" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Unsaved changes" })).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "Save status" })).toHaveTextContent("All changes saved.");
  });

  // Owner decision 2026-10-29: Publish now/Schedule act on the release as saved, so they wait
  // until every edit on the page is saved.
  it("Publish now is disabled with a 'save first' blocker while a section is dirty, and enabled again once it's saved", async () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001", version: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
        if (url === "/nrms/api/categories") return jsonResponse(200, { ministries: [], sectors: [], themes: [], tags: [] });
        if (url === "/nrms/api/media-lists") return jsonResponse(200, []);
        if (url.endsWith("/asset-status")) return jsonResponse(200, { kind: "none" });
        if (init?.method === "PUT" && url.endsWith("/meta")) {
          const body = JSON.parse(init.body as string);
          return jsonResponse(200, releaseView({ ...v, version: 2, languages: [{ ...v.languages[0]!, location: body.location }] }));
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
    const user = userEvent.setup();
    expect(await screen.findByRole("button", { name: "Publish now" })).toBeEnabled();

    await user.type(await screen.findByLabelText("Location"), "X");
    await waitFor(() => expect(screen.getByRole("button", { name: "Publish now" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Schedule" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Save your changes to page details first." })).toHaveAttribute("href", "#section-page-details");

    await user.click(within(screen.getByRole("region", { name: "Unsaved changes" })).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Publish now" })).toBeEnabled());
    expect(screen.queryByText(/Save your changes/)).not.toBeInTheDocument();
  });

  it("a blocker link to Categories opens its closed disclosure and focuses the section", async () => {
    renderPage("11111111-1111-1111-1111-111111111111", { view: releaseView({ status: "draft", ministries: [], leadMinistryKey: null }) });
    const toggle = await screen.findByRole("button", { name: "Edit categories" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.setup().click(screen.getByRole("link", { name: "Choose at least one ministry." }));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "true"));
    expect(screen.getByRole("region", { name: "Categories" })).toHaveFocus();
    expect(screen.getByRole("group", { name: "Ministries" })).toBeVisible();
  });

  // Review P1: every section compares its form with what it was seeded from, so a change the
  // server makes (Approve's key/reference, Publish now/Schedule's publishAt) or a Reload in
  // another section never reads as an unsaved edit that blocks publishing.
  describe("server-side changes are never unsaved edits", () => {
    /** The editor over a live `current` view: GET returns it; each listed write replaces it. */
    function renderLive(initial: ReleaseView, writes: Record<string, (v: ReleaseView, body: Record<string, unknown>) => Response | ReleaseView>) {
      let current = initial;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
          if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
          if (url === "/nrms/api/categories") return jsonResponse(200, { ministries: [{ key: "health", name: "Health", abbreviation: "HLTH" }], sectors: [{ key: "health", name: "Health" }, { key: "sector1", name: "Sector One" }], themes: [], tags: [] });
          if (url === "/nrms/api/media-lists") return jsonResponse(200, []);
          if (url.endsWith("/asset-status")) return jsonResponse(200, { kind: "none" });
          const write = Object.entries(writes).find(([suffix]) => url.endsWith(suffix));
          if (write && init?.method && init.method !== "GET") {
            const result = write[1](current, init.body ? JSON.parse(init.body as string) : {});
            if (result instanceof Response) return result;
            current = result;
            return jsonResponse(200, current);
          }
          if (/\/nrms\/api\/releases\/[^/]+$/.test(url)) return jsonResponse(200, current);
          throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
        }),
      );
      const router = createMemoryRouter([{ path: "/releases/:id", element: <ReleaseEditorPage /> }], { initialEntries: [`/releases/${initial.id}`] });
      render(
        <SessionProvider>
          <RouterProvider router={router} />
        </SessionProvider>,
      );
      return { setCurrent: (v: ReleaseView) => (current = v) };
    }

    it("Approve (which assigns the key and reference) leaves Publish now enabled", async () => {
      const v = releaseView({ status: "draft", key: null, reference: null, version: 1 });
      renderLive(v, { "/approve": (cur) => ({ ...cur, status: "approved", key: "2026HLTH0001-000001", reference: "NEWS-00001", version: cur.version + 1 }) });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Approve" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Approve" }));
      const publish = await screen.findByRole("button", { name: "Publish now" });
      await waitFor(() => expect(publish).toBeEnabled());
      expect(screen.queryByText(/Save your changes/)).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Unsaved changes" })).not.toBeInTheDocument();
    });

    it("Schedule, then Cancel schedule (publishAt stays set): Publish now is enabled again", async () => {
      const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001", version: 1 });
      renderLive(v, {
        "/schedule": (cur, body) => ({ ...cur, status: "scheduled", publishAt: body.publishAtLocal ? "2031-06-11T17:00:00.000Z" : cur.publishAt, version: cur.version + 1 }),
        "/cancel": (cur) => ({ ...cur, status: "approved", version: cur.version + 1 }),
      });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Schedule" }));
      const actions = screen.getByRole("region", { name: "Actions" });
      fireEvent.change(within(actions).getByLabelText("Date"), { target: { value: "2031-06-11" } });
      fireEvent.change(within(actions).getByLabelText("Time (BC time)"), { target: { value: "10:00" } });
      await user.click(screen.getByRole("button", { name: "Confirm schedule" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Schedule" }));
      await user.click(await screen.findByRole("button", { name: "Cancel schedule" }));
      const publish = await screen.findByRole("button", { name: "Publish now" });
      await waitFor(() => expect(publish).toBeEnabled());
      expect(screen.queryByText(/Save your changes/)).not.toBeInTheDocument();
      // And Publish settings now shows the date the release holds.
      expect(within(screen.getByRole("region", { name: "Publish settings" })).getByLabelText("Date")).toHaveValue("2031-06-11");
    });

    it("a publish that failed (publishAt set by the attempt) leaves Publish now enabled", async () => {
      const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001", version: 1 });
      renderLive(v, { "/schedule": (cur) => ({ ...cur, status: "failed", publishAt: "2026-10-29T08:00:00.000Z", lastError: "The News API was unavailable.", version: cur.version + 1 }) });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Publish now" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Publish now" }));
      await screen.findByText("The News API was unavailable.");
      await waitFor(() => expect(screen.getByRole("button", { name: "Publish now" })).toBeEnabled());
      expect(screen.queryByText(/Save your changes/)).not.toBeInTheDocument();
    });

    /** Location typed into (Page details) and the headline (Document 1) edited; then someone
     * else's save makes the release `next`; Save changes stops at the document's 409, and its
     * Reload brings `next` in — under Page details' still-unsaved edit. */
    async function editThenReloadUnder(v: ReleaseView, next: ReleaseView, meta: (cur: ReleaseView, body: Record<string, unknown>) => Response | ReleaseView) {
      const live = renderLive(v, { "/4105": () => jsonResponse(409, { error: "version conflict", code: "version_conflict" }), "/meta": meta });
      const user = userEvent.setup();
      const location = await screen.findByLabelText("Location");
      await user.type(location, "X");
      await user.type(screen.getByLabelText("Headline"), " more");
      live.setCurrent(next);
      await user.click(within(screen.getByRole("region", { name: "Unsaved changes" })).getByRole("button", { name: "Save changes" }));
      const documents = screen.getByRole("region", { name: "Documents" });
      await user.click(await within(documents).findByRole("button", { name: "Reload" }));
      await waitFor(() => expect(screen.getByLabelText("Headline")).toHaveValue(next.documents[0]!.languages[0]!.headline));
      return { user, location };
    }

    it("reverting an edit after the release changed underneath shows the release's new value, not the old one", async () => {
      const v = releaseView({ status: "draft", version: 1 });
      const { user, location } = await editThenReloadUnder(v, { ...v, version: 3, languages: [{ ...v.languages[0]!, location: "KAMLOOPS" }] }, (cur) => cur);
      await waitFor(() => expect(screen.getByRole("region", { name: "Unsaved changes" })).toHaveTextContent("page details"));
      // The user takes their own edit back out: the form now matches what they started from,
      // which is stale — it shows the release's current location instead.
      await user.type(location, "{Backspace}");
      await waitFor(() => expect(location).toHaveValue("KAMLOOPS"));
      expect(screen.queryByRole("region", { name: "Unsaved changes" })).not.toBeInTheDocument();
    });

    it("saving an edit whose fields changed underneath it sends the version it started from, so the server answers 409 instead of overwriting", async () => {
      const v = releaseView({ status: "draft", version: 1 });
      const metaVersions: unknown[] = [];
      const { user } = await editThenReloadUnder(v, { ...v, version: 3, languages: [{ ...v.languages[0]!, location: "KAMLOOPS" }] }, (cur, body) => {
        metaVersions.push(body.version);
        return body.version === cur.version ? { ...cur, version: cur.version + 1 } : jsonResponse(409, { error: "version conflict", code: "version_conflict" });
      });
      await user.click(within(screen.getByRole("region", { name: "Unsaved changes" })).getByRole("button", { name: "Save changes" }));
      const pageDetails = screen.getByRole("region", { name: "Page details" });
      expect(await within(pageDetails).findByText(/someone else changed this/i)).toBeInTheDocument();
      expect(metaVersions).toEqual([1]);
    });

    it("an edit whose fields did not change underneath still saves with the latest version", async () => {
      const v = releaseView({ status: "draft", version: 1 });
      const metaVersions: unknown[] = [];
      const { user } = await editThenReloadUnder(v, { ...v, version: 3 }, (cur, body) => {
        metaVersions.push(body.version);
        return body.version === cur.version ? { ...cur, version: cur.version + 1 } : jsonResponse(409, { error: "version conflict", code: "version_conflict" });
      });
      await user.click(within(screen.getByRole("region", { name: "Unsaved changes" })).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(metaVersions).toEqual([3]));
      expect(within(screen.getByRole("region", { name: "Page details" })).queryByText(/someone else changed this/i)).not.toBeInTheDocument();
    });

    it("a 409 Reload in one section brings in someone else's changes without making other sections dirty", async () => {
      const v = releaseView({ status: "draft", version: 1, sectors: ["health"] });
      const live = renderLive(v, { "/meta": () => jsonResponse(409, { error: "version conflict" }) });
      const user = userEvent.setup();
      await user.type(await screen.findByLabelText("Location"), "X");
      const pageDetails = screen.getByRole("region", { name: "Page details" });
      await user.click(within(screen.getByRole("region", { name: "Unsaved changes" })).getByRole("button", { name: "Save changes" }));
      // Meanwhile someone else changed the sectors, the NoD option and the headline.
      live.setCurrent({
        ...v, version: 5, sectors: ["health", "sector1"], publishOptions: { ...v.publishOptions, toSubscribers: false },
        documents: [{ ...v.documents[0]!, languages: [{ ...v.documents[0]!.languages[0]!, headline: "Someone else's headline" }] }],
      });
      await user.click(await within(pageDetails).findByRole("button", { name: "Reload" }));
      await waitFor(() => expect(screen.queryByRole("region", { name: "Unsaved changes" })).not.toBeInTheDocument());
      expect(screen.getByLabelText("Headline")).toHaveValue("Someone else's headline");
    });
  });

  // Review P1: an edited language tab that isn't showing still holds unsaved text; it must keep
  // blocking Publish now (and keep its button in the save bar) after switching tabs.
  it("an edited French tab keeps Publish now blocked after switching back to English", async () => {
    const base = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001" });
    const v = releaseView({
      ...base,
      documents: [{ ...base.documents[0]!, languages: [...base.documents[0]!.languages, { ...base.documents[0]!.languages[0]!, languageId: 3084, pageTitle: "Communiqué", headline: "Cliniques ouvertes" }] }],
    });
    renderPage(v.id, { view: v });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "French" }));
    await user.type(within(screen.getByRole("tabpanel")).getByLabelText("Headline"), " le samedi");
    await user.click(screen.getByRole("tab", { name: "English" }));
    expect(within(screen.getByRole("tabpanel")).getByLabelText("Headline")).toHaveValue("Clinics open");
    expect(screen.getByRole("button", { name: "Publish now" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Save your changes to French content (Document 1) first." })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Unsaved changes" })).toHaveTextContent("You have unsaved changes in: French content (Document 1)");
    // The document's heading says it holds unsaved edits.
    expect(screen.getByRole("heading", { level: 3, name: "Document 1, unsaved changes" })).toBeInTheDocument();
  });

  it("the 'save French first' blocker link shows the French tab and focuses its panel", async () => {
    const base = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001" });
    const v = releaseView({
      ...base,
      documents: [{ ...base.documents[0]!, languages: [...base.documents[0]!.languages, { ...base.documents[0]!.languages[0]!, languageId: 3084, pageTitle: "Communiqué", headline: "Cliniques ouvertes" }] }],
    });
    renderPage(v.id, { view: v });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "French" }));
    await user.type(within(screen.getByRole("tabpanel")).getByLabelText("Headline"), " le samedi");
    await user.click(screen.getByRole("tab", { name: "English" }));
    await user.click(screen.getByRole("link", { name: "Save your changes to French content (Document 1) first." }));
    expect(screen.getByRole("tab", { name: "French" })).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveFocus();
    expect(within(panel).getByLabelText("Headline")).toHaveValue("Cliniques ouvertes le samedi");
  });

  it("two dirty sections are both named in the bar, which still has one Save", async () => {
    renderPage("11111111-1111-1111-1111-111111111111");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Headline"), " more");
    await user.type(await screen.findByLabelText("Location"), "V");
    const bar = await screen.findByRole("region", { name: "Unsaved changes" });
    expect(bar).toHaveTextContent("You have unsaved changes in: English content (Document 1), page details");
    expect(within(bar).getAllByRole("button")).toHaveLength(1);
    expect(within(bar).getByRole("button", { name: "Save changes" })).toBeInTheDocument();
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
