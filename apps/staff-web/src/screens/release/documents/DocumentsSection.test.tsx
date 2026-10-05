import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { LANG_EN, type DocumentView, type ReleaseView } from "@gcpe/nrms-contract";
import { DocumentsSection } from "./DocumentsSection";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function doc(id: string, sortIndex: number, headline: string): DocumentView {
  return { id, sortIndex, layout: "formal", languages: [{ languageId: LANG_EN, pageTitle: "Page", headline, subheadline: null, organizations: null, byline: null, bodyHtml: "<p>x</p>", pageImageId: null, contacts: [] }] };
}

const TWO_DOCS = releaseView({ documents: [doc("doc-1", 0, "First"), doc("doc-2", 1, "Second")] });

describe("DocumentsSection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("renders every document in sortIndex order", () => {
    render(<DocumentsSection view={TWO_DOCS} setView={() => {}} readOnly={false} />);
    const headlines = screen.getAllByLabelText("Headline").map((el) => (el as HTMLInputElement).value);
    expect(headlines).toEqual(["First", "Second"]);
  });

  it("shows the auto-fill summary note", () => {
    const withSummary = releaseView({ ...TWO_DOCS, languages: [{ languageId: LANG_EN, location: "VICTORIA", summary: "Auto summary.", summaryEdited: false, socialMediaSummary: null }] });
    render(<DocumentsSection view={withSummary} setView={() => {}} readOnly={false} />);
    expect(screen.getByText(/Auto summary\..*\(auto\)/)).toBeInTheDocument();
  });

  it("acceptance 3: Move document 1 down sends the new order to PUT .../documents/order", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(200, releaseView({ ...TWO_DOCS, version: 2, documents: [doc("doc-2", 0, "Second"), doc("doc-1", 1, "First")] }));
      }),
    );
    render(<DocumentsSection view={TWO_DOCS} setView={() => {}} readOnly={false} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Move document 1 down" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(`/nrms/api/releases/${TWO_DOCS.id}/documents/order`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ version: 1, documentIds: ["doc-2", "doc-1"] });
  });

  it("Move document 1 up is disabled for the first document", () => {
    render(<DocumentsSection view={TWO_DOCS} setView={() => {}} readOnly={false} />);
    expect(screen.getByRole("button", { name: "Move document 1 up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move document 2 down" })).toBeDisabled();
  });

  it("adds a document via the inline form", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(201, releaseView({ ...TWO_DOCS, version: 2, documents: [...TWO_DOCS.documents, doc("doc-3", 2, "")] }));
      }),
    );
    render(<DocumentsSection view={TWO_DOCS} setView={() => {}} readOnly={false} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add document" }));
    const addForm = within(screen.getByRole("form", { name: "Add document" }));
    await user.type(addForm.getByLabelText("Page title", { exact: false }), "New page");
    await user.click(addForm.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(`/nrms/api/releases/${TWO_DOCS.id}/documents`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ version: 1, pageTitle: "New page", layout: "formal" });
  });

  it("removes a document after confirmation, and can't remove the only remaining document", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, releaseView({ ...TWO_DOCS, version: 2, documents: [doc("doc-2", 0, "Second")] }))));
    render(<DocumentsSection view={TWO_DOCS} setView={() => {}} readOnly={false} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove document 1" }));
    await user.click(screen.getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("read-only: no Move/Remove/Add buttons", () => {
    render(<DocumentsSection view={TWO_DOCS} setView={() => {}} readOnly />);
    expect(screen.queryByRole("button", { name: /Move document/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add document" })).not.toBeInTheDocument();
  });
});
