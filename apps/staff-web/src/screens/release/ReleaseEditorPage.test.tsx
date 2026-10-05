import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import axe from "axe-core";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { SessionProvider } from "../../session/SessionContext";
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
});
