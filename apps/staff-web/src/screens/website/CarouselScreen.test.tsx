import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { AnnouncerProvider } from "../../shared/Announcer";
import { CarouselScreen } from "./CarouselScreen";
import type { CarouselsResponse, CarouselView } from "./types";

function withAuth(children: React.ReactNode) {
  return (
    <AnnouncerProvider>
      <SessionProvider>
        <MemoryRouter>
          <RequireAuth>{children}</RequireAuth>
        </MemoryRouter>
      </SessionProvider>
    </AnnouncerProvider>
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
    // I5: document.title matches the h1.
    await waitFor(() => expect(document.title).toBe("Carousel — GCPE News Staff"));

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
      slides: [{ headline: "Big news", summary: "", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "left" }],
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

  // Minors: Carousel stays NRMS.SiteEditor/Core.Admin only even though WebsiteScreen itself
  // now lets every read role through for Featured/Log — a Viewer gets the permission-denied
  // message, not the read-only screen (that's reserved for Core.Admin, below).
  // Owner decision 2026-10-29: saving the live carousel changes the public home page at once, so
  // its button says so and asks first. The next carousel keeps Save carousel.
  it("the live carousel's Publish carousel changes asks first; only its confirm sends the PUT", async () => {
    const live: CarouselView = {
      id: "live-1",
      state: "live",
      goLiveAt: null,
      wentLiveAt: "2026-10-01T12:00:00.000Z",
      version: 4,
      slides: [{ id: "slide-1", headline: "Live headline", summary: "", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null }],
    };
    const puts: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: false });
        if (url === "/nrms/api/site/carousels") return jsonResponse(200, { live, next: NEXT_CAROUSEL, past: [] });
        if (url === "/nrms/api/site/carousels/live-1" && init?.method === "PUT") {
          puts.push({ url, body: JSON.parse(init.body as string) });
          return jsonResponse(200, { ...live, version: 5 });
        }
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<CarouselScreen />));
    const liveSection = (await screen.findByRole("region", { name: "Live carousel" })) as HTMLElement;
    const nextSection = screen.getByRole("region", { name: "Next carousel" }) as HTMLElement;
    expect(within(liveSection).queryByRole("button", { name: "Save carousel" })).toBeNull();
    expect(within(nextSection).getByRole("button", { name: "Save carousel" })).toBeInTheDocument();
    const user = userEvent.setup();
    const headline = within(liveSection).getByLabelText("Slide 1 headline");
    await user.clear(headline);
    await user.type(headline, "New live headline");

    await user.click(within(liveSection).getByRole("button", { name: "Publish carousel changes" }));
    let dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Publish these carousel changes now?");
    expect(dialog).toHaveTextContent("the public home page shows your changes within a few minutes.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(puts).toHaveLength(0);

    await user.click(within(liveSection).getByRole("button", { name: "Publish carousel changes" }));
    dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Publish carousel changes" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toMatchObject({ version: 4, slides: [{ id: "slide-1", headline: "New live headline" }] });
  });

  it("a Viewer can't reach Carousel at all (Featured/Log opened up to every role, not this)", async () => {
    stubBasicFetch(["NRMS.Viewer"], EMPTY);
    render(withAuth(<CarouselScreen />));
    await screen.findByText("You don’t have permission to view the carousel.");
    expect(screen.queryByText("There is no next carousel.")).toBeNull();
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
    const withSlide: CarouselsResponse = { ...EMPTY, next: { ...NEXT_CAROUSEL, slides: [{ id: "slide-1", headline: "H", summary: "", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null }] } };
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

  it("edits a slide's Action label (with its hint), sends actionLabel, and shows a 422 message", async () => {
    const next: CarouselView = {
      ...NEXT_CAROUSEL,
      slides: [{ id: "slide-1", headline: "H", summary: "", actionUrl: "", actionLabel: "Old label", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null }],
    };
    const puts: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: false });
        if (url === "/nrms/api/site/carousels") return jsonResponse(200, { live: null, next, past: [] });
        if (url === "/nrms/api/site/carousels/next-1" && init?.method === "PUT") {
          puts.push(JSON.parse(init.body as string));
          return jsonResponse(422, { errors: ["Keep the action label to 40 characters or fewer, in plain text."] });
        }
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<CarouselScreen />));
    const field = await screen.findByLabelText("Slide 1 action label");
    expect(field).toHaveValue("Old label");
    expect(screen.getByText("The link text. Leave empty for the default set in Navigation and labels.")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.clear(field);
    await user.type(field, "Read the update");
    await user.click(screen.getByRole("button", { name: "Save carousel" }));
    expect(await screen.findByText("Keep the action label to 40 characters or fewer, in plain text.")).toBeInTheDocument();
    expect((puts[0]!.slides as { actionLabel: string }[])[0]!.actionLabel).toBe("Read the update");
  });

  // I1: a 409 on save must not leave the form showing the editor's stale local text once the
  // user reloads — reload must re-seed the form from the server's current values.
  it("409 on save -> Reload shows the server's current values, not the local edit", async () => {
    let next: CarouselView = {
      ...NEXT_CAROUSEL,
      slides: [{ id: "slide-1", headline: "Old headline", summary: "", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null }],
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

  // I3: dragging the whole slide made it impossible to mouse-select text in its inputs. Only
  // the dedicated grip handle is draggable; the slide row and its fields are not.
  it("only the drag handle is draggable, not the slide row or its inputs", async () => {
    const withSlide: CarouselsResponse = { ...EMPTY, next: { ...NEXT_CAROUSEL, slides: [{ id: "slide-1", headline: "H", summary: "", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null }] } };
    stubBasicFetch(["NRMS.SiteEditor"], withSlide);
    render(withAuth(<CarouselScreen />));
    const handle = await screen.findByRole("img", { name: "Drag to reorder slide 1" });
    expect(handle).toHaveAttribute("draggable", "true");

    const row = document.querySelector(".gcpe-carousel__slide")!;
    expect(row).not.toHaveAttribute("draggable");
    const headline = screen.getByLabelText("Slide 1 headline");
    expect(headline.closest("[draggable='true']")).toBeNull();
  });

  // I4: moving a slide to the first/last position disables that same direction's own button —
  // the one the user just pressed — the instant it re-renders at its new position, which drops
  // focus to <body> unless it's explicitly restored. Also announces the move.
  it("keyboard Move down on the last-but-one slide restores focus (falling back to Move up) and announces the move", async () => {
    const withSlides: CarouselsResponse = {
      ...EMPTY,
      next: {
        ...NEXT_CAROUSEL,
        slides: [
          { id: "slide-1", headline: "One", summary: "", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null },
          { id: "slide-2", headline: "Two", summary: "", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null },
        ],
      },
    };
    stubBasicFetch(["NRMS.SiteEditor"], withSlides);
    render(withAuth(<CarouselScreen />));

    const user = userEvent.setup();
    const moveDown = await screen.findByRole("button", { name: "Move slide 1 down" });
    moveDown.focus();
    await user.click(moveDown);

    expect(await screen.findByRole("status")).toHaveTextContent("Slide 1 moved to position 2");
    // slide-1 is now last — its own "down" is the new boundary (disabled); fall back to "up".
    await waitFor(() => expect(screen.getByRole("button", { name: "Move slide 2 up" })).toHaveFocus());
  });

  it("a too-large slide image upload (413) shows a clear message", async () => {
    const withSlide: CarouselsResponse = { ...EMPTY, next: { ...NEXT_CAROUSEL, slides: [{ id: "slide-1", headline: "H", summary: "", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null }] } };
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
    expect(await screen.findByText("That image is over 2 MB. Choose a smaller image.")).toBeInTheDocument();
    expect(screen.queryByText("request entity too large")).toBeNull();
  });

  it("an image over 2 MB is refused in the Hub, before anything is sent", async () => {
    const withSlide: CarouselsResponse = { ...EMPTY, next: { ...NEXT_CAROUSEL, slides: [{ id: "slide-1", headline: "H", summary: "", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null }] } };
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: false });
        if (url === "/nrms/api/site/carousels") return jsonResponse(200, withSlide);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<CarouselScreen />));
    const input = await screen.findByLabelText("Slide 1 image (JPEG or PNG, up to 2 MB)");
    const user = userEvent.setup();
    await user.upload(input, new File([new Uint8Array(2 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }));
    expect(await screen.findByText("That image is over 2 MB. Choose a smaller image.")).toBeInTheDocument();
    expect(calls.some((c) => c.startsWith("PUT"))).toBe(false);
  });

  it.each([
    ["Slide 1 action URL", "Slide 1: Enter a full web address for Action URL, starting with http:// or https://"],
    ["Slide 1 Facebook post URL", "Slide 1: Enter a full web address for Facebook post URL, starting with http:// or https://"],
  ])("a bad web address in %s is named before saving, and nothing is sent", async (label, message) => {
    const withSlide: CarouselsResponse = { ...EMPTY, next: { ...NEXT_CAROUSEL, slides: [{ id: "slide-1", headline: "H", summary: "", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null }] } };
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: false });
        if (url === "/nrms/api/site/carousels") return jsonResponse(200, withSlide);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<CarouselScreen />));
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(label), "www.example.com");
    await user.click(screen.getByRole("button", { name: "Save carousel" }));
    expect((await screen.findAllByText(message)).length).toBeGreaterThan(0);
    expect(calls.some((c) => c.startsWith("PUT"))).toBe(false);
    const field = screen.getByLabelText(label);
    expect(field).toBeInvalid();
    expect(field).toHaveAccessibleDescription(expect.stringContaining(message.replace("Slide 1: ", "")));
    const found = await axe.run(document.body, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    expect(found.violations.map((v) => `${v.id} (${v.impact})`)).toEqual([]);
  });
});
