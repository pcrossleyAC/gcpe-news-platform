import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import type { AssetStatus, ReleaseView } from "@gcpe/nrms-contract";
import { AssetSection } from "./AssetSection";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch(assetStatus: AssetStatus = { kind: "none" }, onPut?: (body: unknown) => Response) {
  const calls: { url: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, body });
      if (url.endsWith("/asset-status")) return jsonResponse(200, assetStatus);
      if (onPut) return onPut(body);
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

function renderSection(view: ReleaseView, setView: (v: ReleaseView) => void = () => {}, readOnly = false) {
  return render(<AssetSection view={view} setView={setView} readOnly={readOnly} />);
}

describe("AssetSection (acceptance: asset URL validation messages)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("shows no error for an empty URL (clearing the asset is allowed)", () => {
    stubFetch();
    renderSection(releaseView({ type: "release", assetUrl: null }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save media asset" })).toBeEnabled();
  });

  it("flags a Facebook URL with the exact legacy rule message, and disables Save", async () => {
    stubFetch();
    renderSection(releaseView({ type: "release", assetUrl: null }));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Asset URL"), "https://facebook.com/x");
    expect(screen.getByText("Facebook is no longer supported due to privacy concerns. Use YouTube or Flickr URLs instead.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save media asset" })).toBeDisabled();
  });

  it("accepts a Flickr URL with no error", async () => {
    stubFetch();
    renderSection(releaseView({ type: "release", assetUrl: null }));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Asset URL"), "https://flickr.com/photos/bcgov/123");
    expect(screen.queryByText(/use a youtube or flickr url/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save media asset" })).toBeEnabled();
  });

  it("flags a non-http URL", async () => {
    stubFetch();
    renderSection(releaseView({ type: "release", assetUrl: null }));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Asset URL"), "not a url");
    expect(screen.getByText("The asset URL must be an absolute URL.")).toBeInTheDocument();
  });

  it("shows the GET asset-status message", async () => {
    stubFetch({ kind: "flickr", photoId: "123", state: "public", message: "Public on Flickr." });
    renderSection(releaseView({ type: "release" }));
    expect(await screen.findByText("Public on Flickr.")).toBeInTheDocument();
  });

  it("has no media asset for an Advisory, and shows why", () => {
    stubFetch();
    renderSection(releaseView({ type: "advisory", assetUrl: null, mediaListKeys: ["list1"] }));
    expect(screen.getByText("A Advisory has no media asset.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Asset URL")).not.toBeInTheDocument();
  });

  it("saves with PUT /asset, sending null for an emptied URL", async () => {
    const saved = releaseView({ version: 2, assetUrl: null });
    const calls = stubFetch({ kind: "none" }, () => jsonResponse(200, saved));
    const v = releaseView({ type: "release", version: 1, assetUrl: "https://flickr.com/x" });
    const setView = vi.fn();
    renderSection(v, setView);

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Asset URL"));
    await user.click(screen.getByRole("button", { name: "Save media asset" }));

    await waitFor(() => expect(setView).toHaveBeenCalledWith(saved));
    const put = calls.find((c) => c.url === `/nrms/api/releases/${v.id}/asset`);
    expect(put?.body).toMatchObject({ version: 1, assetUrl: null });
  });

  it("a 409 shows the reload message and keeps the user's typed URL", async () => {
    const calls = stubFetch({ kind: "none" }, () => jsonResponse(409, { error: "version conflict" }));
    renderSection(releaseView({ type: "release", version: 1, assetUrl: null }));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Asset URL"), "https://flickr.com/photos/bcgov/999");
    await user.click(screen.getByRole("button", { name: "Save media asset" }));

    expect(await screen.findByText(/someone else changed this/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Asset URL")).toHaveValue("https://flickr.com/photos/bcgov/999");
    expect(calls.filter((c) => c.url.endsWith("/asset")).length).toBe(1);
  });

  it("read-only disables the fields and hides Save", () => {
    stubFetch();
    renderSection(releaseView({ type: "release" }), () => {}, true);
    expect(screen.getByLabelText("Asset URL")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save media asset" })).not.toBeInTheDocument();
  });
});
