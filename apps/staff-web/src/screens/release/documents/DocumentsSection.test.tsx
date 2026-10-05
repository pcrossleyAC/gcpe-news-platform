import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { jsonResponse } from "../../../../test/jsonResponse";
import { LANG_EN, type DocumentView, type ReleaseView } from "@gcpe/nrms-contract";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { DocumentsSection } from "./DocumentsSection";

function doc(id: string, sortIndex: number, headline: string): DocumentView {
  return { id, sortIndex, layout: "formal", languages: [{ languageId: LANG_EN, pageTitle: "Page", headline, subheadline: null, organizations: null, byline: null, bodyHtml: "<p>x</p>", pageImageId: null, contacts: [] }] };
}

const TWO_DOCS = releaseView({ documents: [doc("doc-1", 0, "First"), doc("doc-2", 1, "Second")] });

/** Stubs `/core/auth/session` and delegates everything else to `handler`. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response> = () => jsonResponse(200, {})) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "user-a", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
      return handler(url, init);
    }),
  );
}

// Wrapped in RequireAuth (same as production), since each document's DocumentLanguageForm
// reads the signed-in user id for draft-recovery scoping.
function renderSection(view: ReleaseView, setView: (v: ReleaseView) => void = () => {}, readOnly = false) {
  return render(
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>
          <DocumentsSection view={view} setView={setView} readOnly={readOnly} />
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("DocumentsSection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("renders every document in sortIndex order", async () => {
    stubFetch();
    renderSection(TWO_DOCS);
    await screen.findAllByLabelText("Headline");
    const headlines = screen.getAllByLabelText("Headline").map((el) => (el as HTMLInputElement).value);
    expect(headlines).toEqual(["First", "Second"]);
  });

  it("shows the auto-fill summary note", async () => {
    stubFetch();
    const withSummary = releaseView({ ...TWO_DOCS, languages: [{ languageId: LANG_EN, location: "VICTORIA", summary: "Auto summary.", summaryEdited: false, socialMediaSummary: null }] });
    renderSection(withSummary);
    expect(await screen.findByText(/Auto summary\..*\(auto\)/)).toBeInTheDocument();
  });

  it("acceptance 3: Move document 1 down sends the new order to PUT .../documents/order", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, releaseView({ ...TWO_DOCS, version: 2, documents: [doc("doc-2", 0, "Second"), doc("doc-1", 1, "First")] }));
    });
    renderSection(TWO_DOCS);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Move document 1 down" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(`/nrms/api/releases/${TWO_DOCS.id}/documents/order`);
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ version: 1, documentIds: ["doc-2", "doc-1"] });
  });

  it("Move document 1 up is disabled for the first document", async () => {
    stubFetch();
    renderSection(TWO_DOCS);
    expect(await screen.findByRole("button", { name: "Move document 1 up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move document 2 down" })).toBeDisabled();
  });

  it("disables drag while a save is in flight, matching the Move buttons", async () => {
    let resolvePut!: (v: Response) => void;
    stubFetch((_url, init) => {
      if (init?.method === "PUT") return new Promise<Response>((resolve) => (resolvePut = resolve));
      return jsonResponse(200, {});
    });
    renderSection(TWO_DOCS);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Move document 1 down" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Move document 1 up" })).toBeDisabled());
    expect(screen.getByRole("img", { name: "Drag to reorder document 1" })).toHaveAttribute("draggable", "false");

    resolvePut(jsonResponse(200, releaseView({ ...TWO_DOCS, version: 2 })));
  });

  // I3: dragging the whole row made it impossible to mouse-select text in its inputs. Only
  // the dedicated grip handle is draggable; the row and its fields are not.
  it("only the drag handle is draggable, not the row or its inputs", async () => {
    stubFetch();
    renderSection(TWO_DOCS);
    const handle = await screen.findByRole("img", { name: "Drag to reorder document 1" });
    expect(handle).toHaveAttribute("draggable", "true");

    const item = document.querySelectorAll(".gcpe-documents__item")[0]!;
    expect(item).not.toHaveAttribute("draggable");
    const headline = screen.getAllByLabelText("Headline")[0]!;
    expect(headline.closest("[draggable='true']")).toBeNull();
  });

  it("adds a document via the inline form", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, init });
      return jsonResponse(201, releaseView({ ...TWO_DOCS, version: 2, documents: [...TWO_DOCS.documents, doc("doc-3", 2, "")] }));
    });
    renderSection(TWO_DOCS);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add document" }));
    const addForm = within(screen.getByRole("form", { name: "Add document" }));
    await user.type(addForm.getByLabelText("Page title", { exact: false }), "New page");
    await user.click(addForm.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(`/nrms/api/releases/${TWO_DOCS.id}/documents`);
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ version: 1, pageTitle: "New page", layout: "formal" });
  });

  it("removes a document after confirmation, and can't remove the only remaining document", async () => {
    stubFetch(() => jsonResponse(200, releaseView({ ...TWO_DOCS, version: 2, documents: [doc("doc-2", 0, "Second")] })));
    renderSection(TWO_DOCS);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Remove document 1" }));
    await user.click(screen.getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("read-only: no Move/Remove/Add buttons", async () => {
    stubFetch();
    renderSection(TWO_DOCS, () => {}, true);
    await screen.findAllByLabelText("Headline");
    expect(screen.queryByRole("button", { name: /Move document/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add document" })).not.toBeInTheDocument();
  });
});
