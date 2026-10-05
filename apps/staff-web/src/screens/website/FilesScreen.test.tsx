import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { FilesScreen } from "./FilesScreen";
import type { ListFilesResult } from "./types";

function withAuth(children: React.ReactNode) {
  return (
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>{children}</RequireAuth>
      </MemoryRouter>
    </SessionProvider>
  );
}

const EMPTY: ListFilesResult = { total: 0, files: [] };
const ONE_FILE: ListFilesResult = { total: 1, files: [{ id: "f1", name: "report.pdf", url: "/files/report.pdf", contentType: "application/pdf", size: 10, createdAt: "2026-01-01T00:00:00.000Z", createdBy: "u" }] };

describe("FilesScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("a new upload that collides (409) offers to replace, and replacing resends with replace=true", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let listing = EMPTY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url.startsWith("/nrms/api/site/files?name=report.pdf&replace=false")) return jsonResponse(409, { error: "A file with that name already exists." });
        if (url.startsWith("/nrms/api/site/files?name=report.pdf&replace=true")) {
          listing = ONE_FILE;
          return jsonResponse(201, ONE_FILE.files[0]);
        }
        if (url.startsWith("/nrms/api/site/files?q=")) return jsonResponse(200, listing);
        throw new Error(`unhandled: ${url}`);
      }),
    );

    render(withAuth(<FilesScreen />));
    await screen.findByText("No files found.");

    const file = new File(["bytes"], "report.pdf", { type: "application/pdf" });
    const input = screen.getByLabelText("Upload a file (PDF, PNG or JPEG)") as HTMLInputElement;
    const user = userEvent.setup();
    await user.upload(input, file);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText('A file named "report.pdf" already exists')).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Replace it" }));

    await waitFor(() => expect(calls.some((c) => c.url.includes("replace=true"))).toBe(true));
    await screen.findByText("report.pdf");
  });

  it("deletes a file after confirming", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/files/f1" && init?.method === "DELETE") return new Response(null, { status: 204 });
        if (url.startsWith("/nrms/api/site/files?q=")) return jsonResponse(200, ONE_FILE);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<FilesScreen />));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete report.pdf" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Confirm delete" }));

    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/files/f1" && c.init?.method === "DELETE")).toBe(true));
  });

  it("a Viewer sees no upload input or delete buttons", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Viewer"] }, expiresAt: new Date().toISOString() });
        if (url.startsWith("/nrms/api/site/files?q=")) return jsonResponse(200, ONE_FILE);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<FilesScreen />));
    await screen.findByText("report.pdf");
    expect(screen.queryByLabelText("Upload a file (PDF, PNG or JPEG)")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete report.pdf" })).toBeNull();
  });
});
