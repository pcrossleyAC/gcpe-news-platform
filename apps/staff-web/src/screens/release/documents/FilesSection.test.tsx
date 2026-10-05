import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { FilesSection } from "./FilesSection";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const BASE = releaseView({
  files: [
    { id: "f1", kind: "translation", label: "fr.pdf", url: "/files/f1", contentType: "application/pdf", size: 100 },
    { id: "f2", kind: "asset", label: "photo.jpg", url: "/files/f2", contentType: "image/jpeg", size: 200 },
  ],
});

describe("FilesSection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists existing translation and media files separately, with a remove button each", () => {
    render(<FilesSection view={BASE} setView={() => {}} readOnly={false} />);
    expect(screen.getByText("fr.pdf")).toBeInTheDocument();
    expect(screen.getByText("photo.jpg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove fr.pdf" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove photo.jpg" })).toBeInTheDocument();
  });

  it("uploads a translation file as a raw body to POST .../files?kind=translation&version=...&name=...", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(201, releaseView({ ...BASE, version: 2 }));
      }),
    );
    let current = BASE;
    render(<FilesSection view={BASE} setView={(v) => (current = v)} readOnly={false} />);
    const file = new File(["%PDF-1.4"], "translation.pdf", { type: "application/pdf" });
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("Upload a translation (PDF)"), file);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(`/nrms/api/releases/${BASE.id}/files?kind=translation&version=${BASE.version}&name=translation.pdf`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(file);
    expect(current.version).toBe(2);
  });

  it("shows a 422 message from the server on upload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(422, { error: "bad", problems: ["That file type isn't allowed."] })));
    render(<FilesSection view={BASE} setView={() => {}} readOnly={false} />);
    const file = new File(["x"], "bad.exe", { type: "application/octet-stream" });
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("Upload a media file"), file);
    expect(await screen.findByText("That file type isn't allowed.")).toBeInTheDocument();
  });

  it("shows a 413 message from the server on upload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(413, { error: "release too large" })));
    render(<FilesSection view={BASE} setView={() => {}} readOnly={false} />);
    const file = new File(["x"], "huge.pdf", { type: "application/pdf" });
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("Upload a translation (PDF)"), file);
    expect(await screen.findByText("release too large")).toBeInTheDocument();
  });

  it("removes a file via POST .../files/:fileId/remove", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(200, releaseView({ ...BASE, version: 2, files: [BASE.files[1]!] }));
      }),
    );
    render(<FilesSection view={BASE} setView={() => {}} readOnly={false} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove fr.pdf" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(`/nrms/api/releases/${BASE.id}/files/f1/remove`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ version: BASE.version });
  });

  it("read-only: no upload inputs or remove buttons", () => {
    render(<FilesSection view={BASE} setView={() => {}} readOnly />);
    expect(screen.queryByLabelText("Upload a translation (PDF)")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove fr.pdf" })).not.toBeInTheDocument();
  });
});
