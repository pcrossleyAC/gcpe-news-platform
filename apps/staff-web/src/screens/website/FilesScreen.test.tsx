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
const nameOf = (init?: RequestInit) => decodeURIComponent(new Headers(init?.headers).get("X-GCPE-File-Name") ?? "");

describe("FilesScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  // I5: document.title matches the h1.
  it("sets the document title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url.startsWith("/nrms/api/site/files")) return jsonResponse(200, EMPTY);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<FilesScreen />));
    await screen.findByRole("heading", { name: "Files", level: 1 });
    await waitFor(() => expect(document.title).toBe("Files — GCPE News Staff"));
  });

  it("a new upload that collides (409) offers to replace, and replacing resends with replace=true", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let listing = EMPTY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/files?replace=false" && nameOf(init) === "report.pdf") return jsonResponse(409, { error: "A file with that name already exists." });
        if (url === "/nrms/api/site/files?replace=true" && nameOf(init) === "report.pdf") {
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
    const input = screen.getByLabelText("Upload a file (any type, up to 512 MB)") as HTMLInputElement;
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

  // Fix round 1, item 4: a wrong-type or too-large general-file upload must show something a
  // human can act on, not a blank/undefined error.
  it("any type can be picked and is sent (no accept filter, like legacy); a server refusal (422) shows its message", async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/files?replace=false" && init?.method === "POST") {
          sent.push(nameOf(init)!);
          if (nameOf(init) === "empty.txt") return jsonResponse(422, { errors: ["The file is empty."] });
          return jsonResponse(201, { id: "f1", name: nameOf(init), url: `/files/${nameOf(init)}`, contentType: "application/octet-stream", size: 5, createdAt: "", createdBy: "u" });
        }
        if (url.startsWith("/nrms/api/site/files?q=")) return jsonResponse(200, EMPTY);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<FilesScreen />));
    const input = (await screen.findByLabelText("Upload a file (any type, up to 512 MB)")) as HTMLInputElement;
    expect(input.getAttribute("accept")).toBeNull();
    const user = userEvent.setup({ applyAccept: true });
    await user.upload(input, new File(["<p>x</p>"], "page.html", { type: "text/html" }));
    await waitFor(() => expect(sent).toEqual(["page.html"]));
    await user.upload(input, new File([""], "empty.txt", { type: "text/plain" }));
    expect(await screen.findByText("The file is empty.")).toBeInTheDocument();
  });

  it("a file over 512 MB is refused in the browser without sending it", async () => {
    const posts = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (init?.method === "POST") posts();
        if (url.startsWith("/nrms/api/site/files?q=")) return jsonResponse(200, EMPTY);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<FilesScreen />));
    const input = (await screen.findByLabelText("Upload a file (any type, up to 512 MB)")) as HTMLInputElement;
    const huge = new File(["x"], "huge.mp4", { type: "video/mp4" });
    Object.defineProperty(huge, "size", { value: 512 * 1024 * 1024 + 1 });
    await userEvent.setup().upload(input, huge);
    expect(await screen.findByText("huge.mp4: A file can be at most 512 MB.")).toBeInTheDocument();
    expect(posts).not.toHaveBeenCalled();
  });

  it("a too-large file upload (413) shows a clear message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/files?replace=false" && nameOf(init) === "big.pdf" && init?.method === "POST") return jsonResponse(413, { error: "request entity too large" });
        if (url.startsWith("/nrms/api/site/files?q=")) return jsonResponse(200, EMPTY);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<FilesScreen />));
    const input = (await screen.findByLabelText("Upload a file (any type, up to 512 MB)")) as HTMLInputElement;
    const user = userEvent.setup();
    await user.upload(input, new File([new Uint8Array(10)], "big.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("request entity too large")).toBeInTheDocument();
  });

  // Minors: Files stays NRMS.SiteEditor/Core.Admin only even though WebsiteScreen itself now
  // lets every read role through for Featured/Log.
  it("a Viewer can't reach Files at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Viewer"] }, expiresAt: new Date().toISOString() });
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<FilesScreen />));
    await screen.findByText("You don’t have permission to view the files.");
    expect(screen.queryByText("report.pdf")).toBeNull();
    expect(screen.queryByLabelText("Upload a file (any type, up to 512 MB)")).toBeNull();
  });

  it("never puts the file name in the URL: it goes in X-GCPE-File-Name, percent-encoded", async () => {
    const posts: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url.startsWith("/nrms/api/site/files?q=")) return jsonResponse(200, EMPTY);
        if (init?.method === "POST") {
          posts.push({ url, init });
          return jsonResponse(201, ONE_FILE.files[0]);
        }
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<FilesScreen />));
    await screen.findByText("No files found.");
    const name = "Résumé 100% final.pdf";
    await userEvent.setup().upload(screen.getByLabelText("Upload a file (any type, up to 512 MB)"), new File(["bytes"], name, { type: "application/pdf" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe("/nrms/api/site/files?replace=false");
    expect(posts[0]!.url).not.toContain(encodeURIComponent(name));
    expect(new Headers(posts[0]!.init!.headers).get("X-GCPE-File-Name")).toBe(encodeURIComponent(name));
  });
});
