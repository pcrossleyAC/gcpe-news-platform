import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import axe from "axe-core";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { fixturePage } from "../../manuals/test-fixtures";
import { HelpScreen } from "./HelpScreen";
import { ManualReviewScreen } from "./ManualReviewScreen";

const HASH_NEW = "1".repeat(64);
const HASH_OLD = "2".repeat(64);
const HASH_TERMS = "3".repeat(64);

const DATA = {
  pages: [
    fixturePage({ id: "government-terms", manual: "core-admin", title: "Government terms", changed: "2026-10-05", hash: HASH_TERMS, html: "<p>Terms now.</p>" }),
    fixturePage({ id: "brand-new", manual: "core-admin", title: "Brand new page", changed: "2026-10-29", hash: HASH_NEW, html: "<p>Fresh words.</p>" }),
    fixturePage({ id: "already-done", manual: "nrms-editor", title: "Already done", changed: "2026-10-20", hash: HASH_OLD, html: "<p>Done.</p>" }),
  ],
};

/** What the screen loads on its own: each page's previous version (none for a new page). */
const PREVIOUS = { "government-terms": { html: "<p>Terms before.</p>", changed: "2026-09-01" }, "brand-new": null, "already-done": null };

type Review = { pageId: string; hash: string; reviewedBy: string; reviewedAt: string };
const STALE: Review = { pageId: "government-terms", hash: "9".repeat(64), reviewedBy: "Old Reviewer", reviewedAt: "2026-09-02T18:00:00.000Z" };
const DONE: Review = { pageId: "already-done", hash: HASH_OLD, reviewedBy: "Sam Lee", reviewedAt: "2026-10-30T03:30:00.000Z" };
const ALL_DONE: Review[] = DATA.pages.map((p) => ({ pageId: p.id, hash: p.hash, reviewedBy: "Sam Lee", reviewedAt: "2026-10-30T03:30:00.000Z" }));

const sessionBody = (roles: string[]) => ({ user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });

interface Options {
  /** Answer the POST with this instead of recording it. */
  post?: Response;
  /** Record the POST as this reviewer at this time (another admin got there first). */
  recordedAs?: { reviewedBy: string; reviewedAt: string };
  /** Answer the list reload that follows a saved review with this status. */
  reloadStatus?: number;
  /** How the previous versions load (the screen's own import otherwise). */
  loadPrevious?: () => Promise<typeof PREVIOUS>;
}

function renderScreen(roles: string[], reviews: Review[], opts: Options = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const store = [...reviews];
  let saved = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/core/auth/session") return jsonResponse(200, sessionBody(roles));
      if (url === "/core/api/manual-reviews" && (init?.method ?? "GET") === "GET") {
        if (saved && opts.reloadStatus) return jsonResponse(opts.reloadStatus, { error: "internal error" });
        return jsonResponse(200, store);
      }
      if (url === "/core/api/manual-reviews" && init?.method === "POST") {
        if (opts.post) return opts.post;
        const body = JSON.parse(init.body as string) as { pageId: string; hash: string };
        store.push({ ...body, ...(opts.recordedAs ?? { reviewedBy: "Pat", reviewedAt: "2026-10-30T20:00:00.000Z" }) });
        saved = true;
        return new Response(null, { status: 201 });
      }
      throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    }),
  );
  const view = render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/help/manuals-review"]}>
        <RequireAuth>
          <Routes>
            <Route path="/help" element={<HelpScreen />} />
            <Route path="/help/manuals-review" element={<ManualReviewScreen data={DATA} loadPrevious={opts.loadPrevious ?? (async () => PREVIOUS)} />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
  return { ...view, calls };
}

function renderHelp(roles: string[]) {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, sessionBody(roles))));
  return render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/help"]}>
        <RequireAuth>
          <HelpScreen />
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

describe("ManualReviewScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists unreviewed pages newest change first, each with Before and Now, a new page as New page", async () => {
    renderScreen(["Core.Admin"], [DONE]);
    await screen.findByRole("button", { name: "Mark reviewed: Government terms" });
    expect(screen.getByRole("heading", { level: 1, name: "Changed since your last review" })).toBeInTheDocument();
    const items = screen.getAllByRole("listitem").filter((li) => within(li).queryByRole("button", { name: /Mark reviewed/ }));
    expect(items.map((li) => within(li).getByRole("heading", { level: 2 }).textContent)).toEqual(["Brand new page", "Government terms"]);

    const fresh = items[0]!;
    expect(within(fresh).getByText(/Core administrator manual\. Changed October 29, 2026\./)).toBeInTheDocument();
    expect(within(fresh).getByRole("heading", { name: "New page" })).toBeInTheDocument();
    expect(within(fresh).queryByRole("heading", { name: "Before" })).toBeNull();
    expect(within(fresh).getByText("Fresh words.")).toBeInTheDocument();

    const terms = items[1]!;
    expect(within(terms).getByRole("heading", { name: "Before" })).toBeInTheDocument();
    expect(within(terms).getByText("Terms before.")).toBeInTheDocument();
    expect(within(terms).getByRole("heading", { name: "Now" })).toBeInTheDocument();
    expect(within(terms).getByText("Terms now.")).toBeInTheDocument();
  });

  it("waits for the previous versions, which load on their own, before listing the pages", async () => {
    let resolve: (v: typeof PREVIOUS) => void = () => {};
    renderScreen(["Core.Admin"], [], { loadPrevious: () => new Promise((r) => (resolve = r)) });
    expect(await screen.findByText("Loading…")).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith("/core/api/manual-reviews", expect.anything()));
    expect(screen.queryByRole("heading", { level: 2, name: "Government terms" })).toBeNull();
    resolve(PREVIOUS);
    const terms = (await screen.findByRole("heading", { level: 2, name: "Government terms" })).closest("li")!;
    expect(within(terms).getByText("Terms before.")).toBeInTheDocument();
  });

  it("says so when the previous versions can't be loaded", async () => {
    renderScreen(["Core.Admin"], [], { loadPrevious: () => Promise.reject(new Error("chunk failed")) });
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the reviews. Reload the page to try again.");
  });

  it("Mark reviewed sends the page and its hash, then moves the entry to Reviewed with who and when", async () => {
    const user = userEvent.setup();
    const { calls } = renderScreen(["Core.Admin"], []);
    await user.click(await screen.findByRole("button", { name: "Mark reviewed: Brand new page" }));

    const reviewed = await screen.findByRole("region", { name: "Reviewed" });
    expect(within(reviewed).getByRole("link", { name: "Brand new page" })).toBeInTheDocument();
    expect(reviewed).toHaveTextContent("Reviewed by Pat on October 30, 2026");
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ pageId: "brand-new", hash: HASH_NEW });
    expect(screen.queryByRole("button", { name: "Mark reviewed: Brand new page" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mark reviewed: Government terms" })).toBeInTheDocument();
  });

  it("shows the first reviewer when another admin got there first", async () => {
    const user = userEvent.setup();
    renderScreen(["Core.Admin"], [], { recordedAs: { reviewedBy: "Sam Lee", reviewedAt: "2026-10-29T10:00:00.000Z" } });
    await user.click(await screen.findByRole("button", { name: "Mark reviewed: Government terms" }));
    expect(await screen.findByText(/Reviewed by Sam Lee on October 29, 2026/)).toBeInTheDocument();
  });

  it("ignores a review of a hash the page no longer has, and of a page that is gone", async () => {
    renderScreen(["Core.Admin"], [STALE, { pageId: "deleted-page", hash: HASH_NEW, reviewedBy: "Ghost", reviewedAt: "2026-09-02T18:00:00.000Z" }]);
    expect(await screen.findByRole("button", { name: "Mark reviewed: Government terms" })).toBeInTheDocument();
    expect(screen.queryByText(/Old Reviewer/)).toBeNull();
    expect(screen.queryByText(/Ghost/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Reviewed" })).toBeNull();
  });

  it("says so when every change is reviewed", async () => {
    renderScreen(["Core.Admin"], ALL_DONE);
    expect(await screen.findByText("Nothing to review. Every manual change has been reviewed.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mark reviewed/ })).toBeNull();
    expect(screen.getAllByText(/Reviewed by Sam Lee on October 29, 2026/)).toHaveLength(3);
  });

  it("shows an alert and keeps the entry in the list when saving fails", async () => {
    const user = userEvent.setup();
    renderScreen(["Core.Admin"], [], { post: jsonResponse(500, { error: "internal error" }) });
    await user.click(await screen.findByRole("button", { name: "Mark reviewed: Brand new page" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't mark it reviewed");
    expect(screen.getByRole("button", { name: "Mark reviewed: Brand new page" })).toBeEnabled();
  });

  it("says the list could not be reloaded, not that saving failed, when the review saved but the reload did not", async () => {
    const user = userEvent.setup();
    const { calls } = renderScreen(["Core.Admin"], [], { reloadStatus: 500 });
    await user.click(await screen.findByRole("button", { name: "Mark reviewed: Brand new page" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the reviews");
    expect(screen.queryByText(/Couldn't mark it reviewed/)).toBeNull();
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
  });

  it("moves focus to the next unreviewed page's heading and announces it", async () => {
    const user = userEvent.setup();
    renderScreen(["Core.Admin"], [DONE]);
    await user.click(await screen.findByRole("button", { name: "Mark reviewed: Brand new page" }));
    const next = await screen.findByRole("heading", { level: 2, name: "Government terms" });
    await waitFor(() => expect(next).toHaveFocus());
    expect(next).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("status")).toHaveTextContent("Marked reviewed.");
  });

  it("moves focus to the Reviewed heading when the last page is reviewed", async () => {
    const user = userEvent.setup();
    renderScreen(["Core.Admin"], ALL_DONE.filter((r) => r.pageId !== "brand-new"));
    await user.click(await screen.findByRole("button", { name: "Mark reviewed: Brand new page" }));
    const heading = await screen.findByRole("heading", { level: 2, name: "Reviewed" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent("Marked reviewed.");
  });

  it("is not available to a site editor, who never asks Core for the reviews", async () => {
    const { calls } = renderScreen(["NRMS.SiteEditor"], []);
    expect(await screen.findByRole("heading", { level: 1, name: "Not available" })).toBeInTheDocument();
    expect(screen.getByText("This page isn't available for your role.")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/core/api/manual-reviews")).toBe(false);
  });

  it("Help links only a Core admin to it", async () => {
    renderHelp(["Core.Admin"]);
    expect(await screen.findByRole("link", { name: "Changed since your last review" })).toHaveAttribute("href", "/help/manuals-review");
    cleanup();
    renderHelp(["NRMS.SiteEditor"]);
    await screen.findByRole("heading", { level: 1, name: "Help" });
    expect(screen.queryByRole("link", { name: "Changed since your last review" })).toBeNull();
  });

  it("has no serious or critical axe violations (list and empty state)", async () => {
    const { container } = renderScreen(["Core.Admin"], [DONE]);
    await screen.findByRole("button", { name: "Mark reviewed: Government terms" });
    expect(await seriousViolations(container)).toEqual([]);
    cleanup();
    const empty = renderScreen(["Core.Admin"], ALL_DONE);
    await waitFor(() => expect(screen.getByText(/Nothing to review/)).toBeInTheDocument());
    expect(await seriousViolations(empty.container)).toEqual([]);
  });
});
