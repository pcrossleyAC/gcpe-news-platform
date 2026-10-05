import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { CarouselScreen } from "./CarouselScreen";
import type { CarouselsResponse, CarouselView } from "./types";

function withAuth(children: React.ReactNode) {
  return (
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>{children}</RequireAuth>
      </MemoryRouter>
    </SessionProvider>
  );
}

function stubBasicFetch(roles: string[], carousels: CarouselsResponse) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "user-a", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: false });
      if (url === "/nrms/api/site/carousels") return jsonResponse(200, carousels);
      throw new Error(`unhandled fetch: ${url}`);
    }),
  );
}

const EMPTY: CarouselsResponse = { live: null, next: null, past: [] };

const NEXT_CAROUSEL: CarouselView = {
  id: "next-1",
  state: "next",
  goLiveAt: "2027-01-01T12:00:00.000Z",
  wentLiveAt: null,
  version: 1,
  slides: [],
};

describe("CarouselScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("create next -> add + save a slide -> make live, each calling the right endpoint", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let carousels: CarouselsResponse = EMPTY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === "/core/auth/session") {
          return jsonResponse(200, { user: { id: "user-a", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        }
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: false });
        if (url === "/nrms/api/site/carousels") return jsonResponse(200, carousels);
        if (url === "/nrms/api/site/carousels/next" && init?.method === "POST") {
          carousels = { ...carousels, next: NEXT_CAROUSEL };
          return jsonResponse(201, NEXT_CAROUSEL);
        }
        if (url === "/nrms/api/site/carousels/next-1" && init?.method === "PUT") {
          const body = JSON.parse(init.body as string) as { slides: Record<string, unknown>[] };
          const saved: CarouselView = {
            ...NEXT_CAROUSEL,
            version: 2,
            slides: body.slides.map((s, i) => ({ ...(s as Omit<CarouselView["slides"][number], "id" | "hasImage" | "imageUrl">), id: `slide-${i}`, hasImage: false, imageUrl: null })),
          };
          carousels = { ...carousels, next: saved };
          return jsonResponse(200, saved);
        }
        if (url === "/nrms/api/site/carousels/next/make-live" && init?.method === "POST") {
          carousels = { live: { ...carousels.next!, state: "live" }, next: null, past: [] };
          return jsonResponse(200, { switched: true });
        }
        throw new Error(`unhandled fetch: ${url} ${init?.method ?? "GET"}`);
      }),
    );

    render(withAuth(<CarouselScreen />));
    await screen.findByRole("heading", { name: "Carousel", level: 1 });
    await screen.findByText("There is no next carousel.");

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Date"), "2027-01-01");
    await user.type(screen.getByLabelText("Time (BC time)"), "09:00");
    await user.click(screen.getByRole("button", { name: "Create next carousel" }));

    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/carousels/next" && c.init?.method === "POST")).toBe(true));
    const createCall = calls.find((c) => c.url === "/nrms/api/site/carousels/next" && c.init?.method === "POST")!;
    expect(JSON.parse(createCall.init!.body as string)).toEqual({ goLiveAt: expect.stringContaining("2027-01-01") });

    await screen.findByRole("button", { name: "Add slide" });
    await user.click(screen.getByRole("button", { name: "Add slide" }));
    await user.type(screen.getByLabelText("Slide 1 headline"), "Big news");
    await user.click(screen.getByRole("button", { name: "Save carousel" }));

    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/carousels/next-1" && c.init?.method === "PUT")).toBe(true));
    const saveCall = calls.find((c) => c.url === "/nrms/api/site/carousels/next-1" && c.init?.method === "PUT")!;
    expect(JSON.parse(saveCall.init!.body as string)).toEqual({
      version: 1,
      slides: [{ headline: "Big news", summary: "", actionUrl: "", facebookPostUrl: "", justify: "left" }],
    });

    await user.click(await screen.findByRole("button", { name: "Make live now" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Confirm make live" }));

    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/carousels/next/make-live" && c.init?.method === "POST")).toBe(true));
  });

  it("a Viewer sees no write controls", async () => {
    stubBasicFetch(["NRMS.Viewer"], EMPTY);
    render(withAuth(<CarouselScreen />));
    await screen.findByText("There is no next carousel.");
    expect(screen.queryByRole("button", { name: "Create next carousel" })).toBeNull();
    expect(screen.queryByLabelText("Date")).toBeNull();
  });

  it("a Core.Admin without NRMS.SiteEditor also sees no write controls (read-only)", async () => {
    stubBasicFetch(["Core.Admin"], EMPTY);
    render(withAuth(<CarouselScreen />));
    await screen.findByText("There is no next carousel.");
    expect(screen.queryByRole("button", { name: "Create next carousel" })).toBeNull();
  });
});
