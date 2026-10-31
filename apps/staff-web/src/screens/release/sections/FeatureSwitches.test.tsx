import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { FeatureSwitches, type FeaturePlace } from "./FeatureSwitches";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The switches sit behind the card's disclosure (closed by default); open it as a user would. */
const openDisclosure = () => fireEvent.click(screen.getByRole("button", { name: /Top \/ Feature/ }));

const HOME: FeaturePlace = { kind: "home", key: "default", label: "Home" };
const HEALTH: FeaturePlace = { kind: "ministries", key: "health", label: "Health" };

describe("FeatureSwitches (acceptance: posts the right kind/key/slot, disabled on drafts)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("every switch is disabled on a draft, with the reason shown", () => {
    const v = releaseView({ status: "draft" });
    render(<FeatureSwitches view={v} setView={() => {}} places={[HOME, HEALTH]} readOnly={false} />);
    openDisclosure();
    expect(screen.getByText("Feature switches are only available once this release is published.")).toBeInTheDocument();
    for (const sw of screen.getAllByRole("switch")) expect(sw).toBeDisabled();
  });

  it("switches are enabled on a published release, and reflect the release's current features", () => {
    const v = releaseView({ status: "published", releasedAt: "2026-01-01T00:00:00.000Z", features: [{ kind: "home", key: "default", slot: "top" }] });
    render(<FeatureSwitches view={v} setView={() => {}} places={[HOME, HEALTH]} readOnly={false} />);
    openDisclosure();
    expect(screen.queryByText(/only available once/)).not.toBeInTheDocument();

    const homeFieldset = screen.getByRole("group", { name: "Home" });
    expect(within(homeFieldset).getByRole("switch", { name: "Top" })).toBeChecked();
    expect(within(homeFieldset).getByRole("switch", { name: "Feature" })).not.toBeChecked();
    for (const sw of screen.getAllByRole("switch")) expect(sw).toBeEnabled();
  });

  it("toggling a switch POSTs /features with exactly that place's kind/key/slot and the new value", async () => {
    const v = releaseView({ id: "rel-1", status: "published", releasedAt: "2026-01-01T00:00:00.000Z", features: [] });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/nrms/api/releases/rel-1/features");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ kind: "ministries", key: "health", slot: "feature", on: true });
      return jsonResponse(200, releaseView({ id: "rel-1", status: "published", features: [{ kind: "ministries", key: "health", slot: "feature" }] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const setView = vi.fn();
    render(<FeatureSwitches view={v} setView={setView} places={[HOME, HEALTH]} readOnly={false} />);
    openDisclosure();

    const healthFieldset = screen.getByRole("group", { name: "Health" });
    const user = userEvent.setup();
    await user.click(within(healthFieldset).getByRole("switch", { name: "Feature" }));

    await waitFor(() => expect(setView).toHaveBeenCalled());
  });

  it("a Viewer (readOnly) never gets a write control, even on a published release", () => {
    const v = releaseView({ status: "published", releasedAt: "2026-01-01T00:00:00.000Z", features: [{ kind: "home", key: "default", slot: "top" }] });
    render(<FeatureSwitches view={v} setView={() => {}} places={[HOME]} readOnly={true} />);
    openDisclosure();
    for (const sw of screen.getAllByRole("switch")) expect(sw).toBeDisabled();
    // The "once this release is published" reason would be misleading here — it IS published,
    // the viewer just has no write access — so it must not show.
    expect(screen.queryByText(/only available once/)).not.toBeInTheDocument();
  });

  it("a 409 while toggling shows the reload message", async () => {
    const v = releaseView({ id: "rel-2", status: "published", releasedAt: "2026-01-01T00:00:00.000Z", features: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(409, { error: "conflict" })),
    );
    render(<FeatureSwitches view={v} setView={() => {}} places={[HOME]} readOnly={false} />);
    openDisclosure();
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("switch")[0]!);
    expect(await screen.findByText(/someone else changed this/i)).toBeInTheDocument();
  });

  it("audit #11: on a published release it says the switches act at once, and a category ticked but not saved is listed as \"Save to feature here\" with no switch", () => {
    const v = releaseView({ status: "published", releasedAt: "2026-01-01T00:00:00.000Z", features: [] });
    const ROADS: FeaturePlace = { kind: "ministries", key: "roads", label: "Transportation" };
    render(<FeatureSwitches view={v} setView={() => {}} places={[HOME, HEALTH]} unsavedPlaces={[ROADS]} readOnly={false} />);
    openDisclosure();
    expect(screen.getByText("Each switch changes the live site straight away. A ministry, sector or theme ticked in Categories appears here once you save.")).toBeInTheDocument();
    const roads = screen.getByRole("group", { name: "Transportation" });
    expect(within(roads).queryByRole("switch")).toBeNull();
    expect(roads).toHaveTextContent("Save to feature here.");
    expect(screen.getAllByRole("switch")).toHaveLength(4);
  });

  it("audit #11: a viewer sees neither the hint nor unsaved places", () => {
    const v = releaseView({ status: "published", releasedAt: "2026-01-01T00:00:00.000Z", features: [] });
    render(<FeatureSwitches view={v} setView={() => {}} places={[HOME]} unsavedPlaces={[{ kind: "ministries", key: "roads", label: "Transportation" }]} readOnly />);
    openDisclosure();
    expect(screen.queryByText(/changes the live site straight away/)).toBeNull();
    expect(screen.queryByRole("group", { name: "Transportation" })).toBeNull();
  });
});
