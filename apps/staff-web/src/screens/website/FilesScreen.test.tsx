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

  const SESSION = (roles = ["NRMS.SiteEditor"]) => jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
  const file = (i: number) => ({ id: `f${i}`, name: `file-${i}.pdf`, url: `/files/file-${i}.pdf`, contentType: "application/pdf", size: 10, createdAt: "2026-01-01T00:00:00.000Z", createdBy: "u" });

  it("C332: Upload files sits above the list, which says newest first and how many of how many it shows", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url === "/core/auth/session" ? SESSION() : jsonResponse(200, { total: 120, files: [file(1), file(2)] }))));
    render(withAuth(<FilesScreen />));
    const upload = await screen.findByRole("heading", { name: "Upload files", level: 2 });
    const list = screen.getByRole("heading", { name: "Uploaded files", level: 2 });
    expect(upload.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText("Choose one or more files (any type, up to 512 MB each)")).toHaveAttribute("multiple");
    expect(screen.getByText("Newest first. Showing 2 of 120 files.")).toBeInTheDocument();
    // Each Delete button shows just "Delete"; the file's name is in its accessible name.
    const del = screen.getByRole("button", { name: "Delete file-1.pdf" });
    expect(del).toHaveTextContent(/^Delete file-1\.pdf$/);
    expect(within(del).getByText("file-1.pdf")).toHaveClass("gcpe-visually-hidden");
  });

  it("C332: Show more files adds the next 50 under the ones shown, until all are shown", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url === "/core/auth/session") return SESSION();
        if (url.endsWith("&page=2")) return jsonResponse(200, { total: 3, files: [file(3)] });
        return jsonResponse(200, { total: 3, files: [file(1), file(2)] });
      }),
    );
    render(withAuth(<FilesScreen />));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Show more files" }));
    expect(await screen.findByRole("link", { name: "file-3.pdf" })).toBeInTheDocument();
    expect(screen.getAllByRole("link").map((l) => l.textContent)).toEqual(["file-1.pdf", "file-2.pdf", "file-3.pdf"]);
    expect(urls).toContain("/nrms/api/site/files?q=&page=2");
    expect(screen.getByText("Newest first. Showing 3 of 3 files.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more files" })).not.toBeInTheDocument();
  });

  it("C332: several files upload one after another; each name already taken is asked about in turn", async () => {
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/core/auth/session") return SESSION();
        if (init?.method === "POST") {
          const name = nameOf(init);
          posts.push(`${name}${url.endsWith("replace=true") ? " (replace)" : ""}`);
          if (url.endsWith("replace=false") && (name === "a.pdf" || name === "c.pdf")) return jsonResponse(409, { error: "exists" });
          return jsonResponse(201, { ...file(9), name });
        }
        return jsonResponse(200, EMPTY);
      }),
    );
    render(withAuth(<FilesScreen />));
    const user = userEvent.setup();
    const input = await screen.findByLabelText("Choose one or more files (any type, up to 512 MB each)");
    await user.upload(input, ["a.pdf", "b.pdf", "c.pdf"].map((n) => new File(["%PDF"], n, { type: "application/pdf" })));

    const first = await screen.findByRole("dialog");
    expect(within(first).getByText('A file named "a.pdf" already exists')).toBeInTheDocument();
    expect(posts).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
    await user.click(within(first).getByRole("button", { name: "Replace it" }));
    const second = await within(document.body).findByText('A file named "c.pdf" already exists').then(() => screen.getByRole("dialog"));
    await user.click(within(second).getByRole("button", { name: "Keep the existing file" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(posts).toEqual(["a.pdf", "b.pdf", "c.pdf", "a.pdf (replace)"]);
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
    const input = screen.getByLabelText("Choose one or more files (any type, up to 512 MB each)") as HTMLInputElement;
    const user = userEvent.setup();
    await user.upload(input, file);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText('A file named "report.pdf" already exists')).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Replace it" }));

    await waitFor(() => expect(calls.some((c) => c.url.includes("replace=true"))).toBe(true));
    await screen.findByRole("link", { name: "report.pdf" });
  });

  it("W1: each file shows its public address on the public site's base, not the Hub's host, and Copy public address copies it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "https://news.gov.bc.ca", publicSiteUrl: "https://news.gov.bc.ca", filesBase: "https://news.gov.bc.ca", isTestSite: false });
        if (url.startsWith("/nrms/api/site/files?q=")) return jsonResponse(200, ONE_FILE);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    // The Hub runs on its own (here: jsdom's localhost) host.
    expect(window.location.host).not.toBe("news.gov.bc.ca");
    render(withAuth(<FilesScreen />));
    const user = userEvent.setup();
    expect(await screen.findByText("https://news.gov.bc.ca/files/report.pdf")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "report.pdf" })).toHaveAttribute("href", "https://news.gov.bc.ca/files/report.pdf");
    await user.click(screen.getByRole("button", { name: "Copy public address of report.pdf" }));
    expect(await navigator.clipboard.readText()).toBe("https://news.gov.bc.ca/files/report.pdf");
    expect(await screen.findByRole("status")).toHaveTextContent("Copied the public address of report.pdf.");
  });

  it("I3: until the public site's address is known, no address is shown or copied and Copy says why", async () => {
    let answerConfig: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return new Promise<Response>((resolve) => (answerConfig = resolve));
        if (url.startsWith("/nrms/api/site/files?q=")) return jsonResponse(200, ONE_FILE);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<FilesScreen />));
    const copy = await screen.findByRole("button", { name: "Copy public address of report.pdf" });
    expect(copy).toBeDisabled();
    expect(copy).toHaveAccessibleDescription("Working out the public address…");
    expect(screen.queryByText(/\/files\/report\.pdf$/)).toBeNull();
    answerConfig(jsonResponse(500, { error: "boom" }));
    await waitFor(() => expect(copy).toHaveAccessibleDescription("Couldn\u2019t work out the public address. Reload the page."));
    expect(copy).toBeDisabled();
    expect(screen.queryByText(/\/files\/report\.pdf$/)).toBeNull();
  });

  it("I3: with no public base configured (a development stack), the page's own address is used", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
        if (url.startsWith("/nrms/api/site/files?q=")) return jsonResponse(200, ONE_FILE);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<FilesScreen />));
    expect(await screen.findByText(`${window.location.origin}/files/report.pdf`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy public address of report.pdf" })).toBeEnabled();
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
    const input = (await screen.findByLabelText("Choose one or more files (any type, up to 512 MB each)")) as HTMLInputElement;
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
    const input = (await screen.findByLabelText("Choose one or more files (any type, up to 512 MB each)")) as HTMLInputElement;
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
    const input = (await screen.findByLabelText("Choose one or more files (any type, up to 512 MB each)")) as HTMLInputElement;
    const user = userEvent.setup();
    await user.upload(input, new File([new Uint8Array(10)], "big.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("big.pdf: A file can be at most 512 MB.")).toBeInTheDocument();
    expect(screen.queryByText("request entity too large")).toBeNull();
  });

  it("a schema rejection (400 invalid request) shows a plain message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/files?replace=false" && init?.method === "POST") return jsonResponse(400, { error: "invalid request" });
        if (url.startsWith("/nrms/api/site/files?q=")) return jsonResponse(200, EMPTY);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<FilesScreen />));
    const input = (await screen.findByLabelText("Choose one or more files (any type, up to 512 MB each)")) as HTMLInputElement;
    await userEvent.setup().upload(input, new File([new Uint8Array(10)], "a.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("The upload wasn't accepted. Reload the page and try again.")).toBeInTheDocument();
    expect(screen.queryByText("invalid request")).toBeNull();
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
    expect(screen.queryByLabelText("Choose one or more files (any type, up to 512 MB each)")).toBeNull();
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
    await userEvent.setup().upload(screen.getByLabelText("Choose one or more files (any type, up to 512 MB each)"), new File(["bytes"], name, { type: "application/pdf" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe("/nrms/api/site/files?replace=false");
    expect(posts[0]!.url).not.toContain(encodeURIComponent(name));
    expect(new Headers(posts[0]!.init!.headers).get("X-GCPE-File-Name")).toBe(encodeURIComponent(name));
  });
});
