import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { PageDetailsSection } from "./PageDetailsSection";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubPut(onPut: (body: unknown) => Response) {
  const calls: { url: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, body });
      return onPut(body);
    }),
  );
  return calls;
}

function renderSection(view: ReleaseView, setView: (v: ReleaseView) => void = () => {}, readOnly = false) {
  return render(<PageDetailsSection view={view} setView={setView} readOnly={readOnly} />);
}

describe("PageDetailsSection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("the URL key is editable for a draft Story", () => {
    renderSection(releaseView({ type: "story", status: "draft", key: "my-story" }));
    expect(screen.getByLabelText("URL key")).toBeEnabled();
    expect(screen.getByLabelText("URL key")).toHaveValue("my-story");
  });

  it("the URL key is disabled for a Release (system-generated), with a reason", () => {
    renderSection(releaseView({ type: "release", status: "draft", key: null }));
    expect(screen.getByLabelText("URL key")).toBeDisabled();
    expect(screen.getByText("A Release's URL key is generated automatically.")).toBeInTheDocument();
  });

  it("the URL key is disabled for a Story once scheduled, with a different reason", () => {
    renderSection(releaseView({ type: "story", status: "scheduled", key: "my-story" }));
    expect(screen.getByLabelText("URL key")).toBeDisabled();
    expect(screen.getByText("The URL key can no longer be changed.")).toBeInTheDocument();
  });

  it("shows the English summary/keywords/social fields for a Release, and hides them for an Advisory", () => {
    const { rerender } = render(<PageDetailsSection view={releaseView({ type: "release" })} setView={() => {}} readOnly={false} />);
    expect(screen.getByLabelText("Summary")).toBeInTheDocument();

    rerender(<PageDetailsSection view={releaseView({ type: "advisory" })} setView={() => {}} readOnly={false} />);
    expect(screen.queryByLabelText("Summary")).not.toBeInTheDocument();
    expect(screen.getByText("A Advisory has no summary, keywords or social media summary.")).toBeInTheDocument();
  });

  it("saves with PUT /meta carrying the current version and the English release-language fields", async () => {
    const saved = releaseView({ version: 2 });
    const calls = stubPut(() => jsonResponse(200, saved));
    const v = releaseView({
      type: "release", version: 1, redirectUrl: null, keywords: null,
      languages: [{ languageId: 4105, location: "VICTORIA", summary: "Old summary.", summaryEdited: false, socialMediaSummary: null }],
    });
    const setView = vi.fn();
    renderSection(v, setView);

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Summary"));
    await user.type(screen.getByLabelText("Summary"), "New summary.");
    await user.click(screen.getByRole("button", { name: "Save page details" }));

    await waitFor(() => expect(setView).toHaveBeenCalledWith(saved));
    const put = calls.find((c) => c.url === `/nrms/api/releases/${v.id}/meta`);
    expect(put?.body).toMatchObject({ version: 1, location: "VICTORIA", summary: "New summary." });
  });

  it("a 409 shows the reload message and keeps the user's typed location", async () => {
    stubPut(() => jsonResponse(409, { error: "version conflict" }));
    renderSection(releaseView({ type: "release", version: 1 }));
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Location"));
    await user.type(screen.getByLabelText("Location"), "VANCOUVER");
    await user.click(screen.getByRole("button", { name: "Save page details" }));

    expect(await screen.findByText(/someone else changed this/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Location")).toHaveValue("VANCOUVER");
  });

  it("read-only disables every field and hides Save", () => {
    renderSection(releaseView({ type: "story", status: "draft" }), () => {}, true);
    expect(screen.getByLabelText("URL key")).toBeDisabled();
    expect(screen.getByLabelText("Location")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save page details" })).not.toBeInTheDocument();
  });
});
