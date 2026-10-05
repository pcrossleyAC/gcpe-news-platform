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
    // Fix round 1 (controller ruling): the client sends the BC wall-clock goLiveAtLocal, never
    // a browser-converted instant — the server (apps/nrms/src/website/carousel.ts's
    // resolveGoLiveAt) does that conversion with its own tzdata.
    expect(JSON.parse(createCall.init!.body as string)).toEqual({ goLiveAtLocal: "2027-01-01T09:00" });

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

    // I1: the saved slide now has a server-assigned id — the image upload control (only
    // rendered once a slide has an id) must appear without a manual re-render trigger.
    await screen.findByLabelText("Slide 1 image (JPEG or PNG, up to 2 MB)");

    await user.click(await screen.findByRole("button", { name: "Make live now" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Confirm make live" }));

    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/carousels/next/make-live" && c.init?.method === "POST")).toBe(true));

    // I1: the live editor must show the slides that just went live, not whatever stale local
    // state its SlideEditor instance was carrying (there was no live carousel before this).
    const liveSection = (await screen.findByRole("region", { name: "Live carousel" })) as HTMLElement;
    await waitFor(() => expect(within(liveSection).getByLabelText("Slide 1 headline")).toHaveValue("Big news"));
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

  // Fix round 1, item 4: a wrong-type or too-large slide image upload must show something a
  // human can act on, not a blank/undefined error.
  it("a wrong-type slide image upload shows the server's 422 message", async () => {
    const withSlide: CarouselsResponse = { ...EMPTY, next: { ...NEXT_CAROUSEL, slides: [{ id: "slide-1", headline: "H", summary: "", actionUrl: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null }] } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: false });
        if (url === "/nrms/api/site/carousels") return jsonResponse(200, withSlide);
        if (url === "/nrms/api/site/slides/slide-1/image" && init?.method === "PUT") return jsonResponse(422, { errors: ["Upload a JPEG or PNG image."] });
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<CarouselScreen />));
    const input = await screen.findByLabelText("Slide 1 image (JPEG or PNG, up to 2 MB)");
    const user = userEvent.setup();
    // user-event's upload() enforces the input's own `accept` — a wrong-type upload is caught
    // server-side on the real bytes (magic-byte sniffing), not by the input's `accept`, so this
    // declares a matching MIME type (as a real browser's file picker would let through) and
    // relies on the mocked fetch below to stand in for the server's actual content check.
    await user.upload(input, new File(["not actually an image"], "notes.png", { type: "image/png" }));
    expect(await screen.findByText("Upload a JPEG or PNG image.")).toBeInTheDocument();
  });

  // I1: a 409 on save must not leave the form showing the editor's stale local text once the
  // user reloads — reload must re-seed the form from the server's current values.
  it("409 on save -> Reload shows the server's current values, not the local edit", async () => {
    let next: CarouselView = {
      ...NEXT_CAROUSEL,
      slides: [{ id: "slide-1", headline: "Old headline", summary: "", actionUrl: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: false });
        if (url === "/nrms/api/site/carousels") return jsonResponse(200, { live: null, next, past: [] });
        if (url === "/nrms/api/site/carousels/next-1" && init?.method === "PUT") return jsonResponse(409, { error: "conflict", code: "version_conflict" });
        throw new Error(`unhandled: ${url}`);
      }),
    );

    render(withAuth(<CarouselScreen />));
    const headlineField = await screen.findByLabelText("Slide 1 headline");
    expect(headlineField).toHaveValue("Old headline");

    const user = userEvent.setup();
    await user.clear(headlineField);
    await user.type(headlineField, "My local edit");
    await user.click(screen.getByRole("button", { name: "Save carousel" }));

    await screen.findByText("Someone else changed this — reload to see their changes.");

    // Someone else's save landed in the meantime.
    next = { ...next, version: 2, slides: [{ ...next.slides[0]!, headline: "Server headline" }] };

    await user.click(screen.getByRole("button", { name: "Reload" }));

    const reloaded = await screen.findByLabelText("Slide 1 headline");
    expect(reloaded).toHaveValue("Server headline");
    expect(screen.queryByText("Someone else changed this — reload to see their changes.")).toBeNull();
  });

  it("a too-large slide image upload (413) shows a clear message", async () => {
    const withSlide: CarouselsResponse = { ...EMPTY, next: { ...NEXT_CAROUSEL, slides: [{ id: "slide-1", headline: "H", summary: "", actionUrl: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null }] } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: false });
        if (url === "/nrms/api/site/carousels") return jsonResponse(200, withSlide);
        if (url === "/nrms/api/site/slides/slide-1/image" && init?.method === "PUT") return jsonResponse(413, { error: "request entity too large" });
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<CarouselScreen />));
    const input = await screen.findByLabelText("Slide 1 image (JPEG or PNG, up to 2 MB)");
    const user = userEvent.setup();
    await user.upload(input, new File([new Uint8Array(10)], "big.png", { type: "image/png" }));
    expect(await screen.findByText("request entity too large")).toBeInTheDocument();
  });
});
