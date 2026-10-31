import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { CategoriesSection } from "./CategoriesSection";
import { renderWithSaveBar } from "../saveBarHarness";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const CATEGORIES = {
  ministries: [
    { key: "health", name: "Health", abbreviation: "HLTH" },
    { key: "education", name: "Education", abbreviation: "EDUC" },
  ],
  sectors: [{ key: "sector1", name: "Sector One" }],
  themes: [{ key: "theme1", name: "Theme One" }],
  tags: [],
};

function stubFetch(onPut?: (body: unknown) => Response) {
  const calls: { url: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, body });
      if (url === "/nrms/api/categories") return jsonResponse(200, CATEGORIES);
      if (onPut) return onPut(body);
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

function renderSection(view: ReleaseView, setView: (v: ReleaseView) => void = () => {}, readOnly = false) {
  const result = renderWithSaveBar(<CategoriesSection view={view} setView={setView} readOnly={readOnly} />);
  // The checkbox lists and the Top/Feature switches sit behind their cards' disclosures (closed
  // by default); open both, as a user would.
  fireEvent.click(screen.getByRole("button", { name: /(Edit|Show) categories/ }));
  fireEvent.click(screen.getByRole("button", { name: /Top \/ Feature/ }));
  return result;
}

describe("CategoriesSection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("checks the ministries the release currently has", async () => {
    stubFetch();
    renderSection(releaseView({ type: "release", ministries: ["health"], sectors: [] }));
    expect(await screen.findByLabelText("Health")).toBeChecked();
    expect(screen.getByLabelText("Education")).not.toBeChecked();
  });

  it("hides sectors/themes/tags for a type with no categoriesBeyondMinistries", async () => {
    stubFetch();
    renderSection(releaseView({ type: "advisory" }));
    await screen.findByLabelText("Health");
    expect(screen.queryByText("Sectors")).not.toBeInTheDocument();
  });

  it("shows the lead ministry picker once more than one ministry is chosen", async () => {
    stubFetch();
    renderSection(releaseView({ type: "release", ministries: ["health"], leadMinistryKey: "health" }));
    await screen.findByLabelText("Health");
    expect(screen.queryByRole("combobox", { name: /Lead ministry/ })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Education"));
    expect(screen.getByRole("combobox", { name: /Lead ministry/ })).toBeInTheDocument();
  });

  // forms-b #23: a lead is needed to approve (approveProblems), so "(none)" isn't offered: the
  // empty choice only prompts. An advisory doesn't need one and keeps "(none)".
  it("the lead ministry says it's needed before approving and offers no \"(none)\"; an advisory keeps (none)", async () => {
    stubFetch();
    const { unmount } = renderSection(releaseView({ type: "release", ministries: ["health", "education"], leadMinistryKey: null }));
    const lead = await screen.findByRole("combobox", { name: "Lead ministry (needed before approving)" });
    expect(lead).toHaveValue("");
    const prompt = screen.getByRole("option", { name: "Choose the lead ministry" });
    expect(prompt).toBeDisabled();
    expect(screen.queryByRole("option", { name: "(none)" })).not.toBeInTheDocument();
    unmount();

    renderSection(releaseView({ type: "advisory", ministries: ["health", "education"], leadMinistryKey: null }));
    expect(await screen.findByRole("combobox", { name: "Lead ministry" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "(none)" })).toBeEnabled();
  });

  it("read-only: the lead ministry has no marker", async () => {
    stubFetch();
    renderSection(releaseView({ type: "release", ministries: ["health", "education"], leadMinistryKey: "health" }), () => {}, true);
    expect(await screen.findByRole("combobox", { name: "Lead ministry" })).toBeDisabled();
  });

  it("saves with PUT /categories carrying the current version and selections", async () => {
    const saved = releaseView({ version: 2 });
    const calls = stubFetch(() => jsonResponse(200, saved));
    const v = releaseView({ type: "release", version: 1, ministries: ["health"], leadMinistryKey: "health", sectors: [] });
    const setView = vi.fn();
    renderSection(v, setView);
    await screen.findByLabelText("Health");

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Sector One"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(setView).toHaveBeenCalledWith(saved));
    const put = calls.find((c) => c.url === `/nrms/api/releases/${v.id}/categories`);
    expect(put?.body).toMatchObject({ version: 1, ministries: ["health"], sectors: ["sector1"] });
  });

  it("renders the Home feature-switch place plus one per current ministry/sector/theme", async () => {
    stubFetch();
    renderSection(releaseView({ type: "release", status: "published", releasedAt: "2026-01-01T00:00:00.000Z", ministries: ["health"], sectors: ["sector1"], themes: ["theme1"] }));
    await screen.findByLabelText("Health");
    expect(screen.getByRole("group", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Health" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Sector One" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Theme One" })).toBeInTheDocument();
  });

  it("read-only hides the Save button, disables every checkbox, and disables the feature switches too", async () => {
    stubFetch();
    renderSection(releaseView({ type: "release", status: "published", releasedAt: "2026-01-01T00:00:00.000Z" }), () => {}, true);
    expect(await screen.findByLabelText("Health")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    for (const sw of screen.getAllByRole("switch")) expect(sw).toBeDisabled();
  });
});
