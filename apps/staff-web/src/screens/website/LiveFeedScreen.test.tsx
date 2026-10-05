import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { LiveFeedScreen } from "./LiveFeedScreen";
import type { LiveFeedView } from "./types";

function withAuth(children: React.ReactNode) {
  return (
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>{children}</RequireAuth>
      </MemoryRouter>
    </SessionProvider>
  );
}

const OFF: LiveFeedView = { enabled: false, manifestUrl: "", m3uUrl: "", version: 1 };

function stub(roles: string[], feed: LiveFeedView, calls: { url: string; init?: RequestInit }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/site/live-feed" && (init?.method ?? "GET") === "GET") return jsonResponse(200, feed);
      throw new Error(`unhandled: ${url} ${init?.method ?? "GET"}`);
    }),
  );
}

describe("LiveFeedScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  // I5: document.title matches the h1.
  it("sets the document title", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(["NRMS.SiteEditor"], OFF, calls);
    render(withAuth(<LiveFeedScreen />));
    await screen.findByRole("heading", { name: "Live Feed", level: 1 });
    expect(document.title).toBe("Live Feed — GCPE News Staff");
  });

  it("refuses to enable with no M3U URL, client-side, without calling the server", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(["NRMS.SiteEditor"], OFF, calls);
    render(withAuth(<LiveFeedScreen />));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "Live Feed on" }));
    await user.click(screen.getByRole("button", { name: "Save Live Feed" }));

    expect(await screen.findByText("Add the M3U playlist URL before turning the Live Feed on.")).toBeInTheDocument();
    expect(calls.some((c) => c.init?.method === "PUT")).toBe(false);
  });

  it("saves enabled + both URLs via PUT when a valid M3U URL is present", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/live-feed" && init?.method === "PUT") {
          const body = JSON.parse(init.body as string);
          return jsonResponse(200, { ...body, version: 2 });
        }
        if (url === "/nrms/api/site/live-feed") return jsonResponse(200, OFF);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<LiveFeedScreen />));
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("M3U URL"), "https://example.invalid/feed.m3u8");
    await user.click(screen.getByRole("switch", { name: "Live Feed on" }));
    await user.click(screen.getByRole("button", { name: "Save Live Feed" }));

    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/live-feed" && c.init?.method === "PUT")).toBe(true));
    const call = calls.find((c) => c.url === "/nrms/api/site/live-feed" && c.init?.method === "PUT")!;
    expect(JSON.parse(call.init!.body as string)).toEqual({ version: 1, enabled: true, manifestUrl: "", m3uUrl: "https://example.invalid/feed.m3u8" });
  });

  it("a Viewer sees the settings read-only, with no Save button", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(["NRMS.Viewer"], OFF, calls);
    render(withAuth(<LiveFeedScreen />));
    await screen.findByRole("switch", { name: "Live Feed on" });
    expect(screen.queryByRole("button", { name: "Save Live Feed" })).toBeNull();
  });
});
