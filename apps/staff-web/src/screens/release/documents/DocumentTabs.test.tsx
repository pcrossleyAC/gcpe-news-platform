import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { LANG_EN, LANG_FR } from "@gcpe/nrms-contract";
import { DocumentTabs } from "./DocumentTabs";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const EN_ONLY = releaseView({
  documents: [
    { id: "doc-1", sortIndex: 0, layout: "formal", languages: [{ languageId: LANG_EN, pageTitle: "News Release", headline: "Clinics open", subheadline: null, organizations: null, byline: null, bodyHtml: "<p>Body</p>", pageImageId: null, contacts: [] }] },
  ],
});

describe("DocumentTabs", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows the English tab and an Add French translation button when there's no French yet", () => {
    render(<DocumentTabs view={EN_ONLY} setView={() => {}} documentId="doc-1" readOnly={false} />);
    expect(screen.getByRole("tab", { name: "English" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "French" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add French translation" })).toBeInTheDocument();
    // Can't remove the only language.
    expect(screen.queryByRole("button", { name: /Remove .* translation/ })).not.toBeInTheDocument();
  });

  it("adding a French translation calls POST .../documents/:docId/translations and switches to it", async () => {
    const withFr = releaseView({
      ...EN_ONLY,
      version: 2,
      documents: [{ ...EN_ONLY.documents[0]!, languages: [...EN_ONLY.documents[0]!.languages, { languageId: LANG_FR, pageTitle: "Communiqué", headline: "", subheadline: null, organizations: null, byline: null, bodyHtml: "", pageImageId: null, contacts: [] }] }],
    });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(200, withFr);
      }),
    );
    let current = EN_ONLY;
    render(<DocumentTabs view={EN_ONLY} setView={(v) => (current = v)} documentId="doc-1" readOnly={false} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add French translation" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(`/nrms/api/releases/${EN_ONLY.id}/documents/doc-1/translations`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ version: 1, languageId: LANG_FR });
    expect(current.version).toBe(2);
  });

  it("switching tabs shows that language's own fields; Remove translation is offered once both exist", async () => {
    const both = releaseView({
      documents: [
        {
          id: "doc-1",
          sortIndex: 0,
          layout: "formal",
          languages: [
            { languageId: LANG_EN, pageTitle: "News Release", headline: "Clinics open", subheadline: null, organizations: null, byline: null, bodyHtml: "<p>Body</p>", pageImageId: null, contacts: [] },
            { languageId: LANG_FR, pageTitle: "Communiqué", headline: "Cliniques ouvertes", subheadline: null, organizations: null, byline: null, bodyHtml: "<p>Corps</p>", pageImageId: null, contacts: [] },
          ],
        },
      ],
    });
    render(<DocumentTabs view={both} setView={() => {}} documentId="doc-1" readOnly={false} />);
    const user = userEvent.setup();
    expect(screen.getByLabelText("Headline")).toHaveValue("Clinics open");
    expect(screen.getByRole("button", { name: "Remove French translation" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "French" }));
    expect(screen.getByLabelText("Headline")).toHaveValue("Cliniques ouvertes");
  });

  it("removing a translation asks for confirmation before calling the remove endpoint", async () => {
    const both = releaseView({
      documents: [
        {
          id: "doc-1",
          sortIndex: 0,
          layout: "formal",
          languages: [
            { languageId: LANG_EN, pageTitle: "News Release", headline: "Clinics open", subheadline: null, organizations: null, byline: null, bodyHtml: "<p>Body</p>", pageImageId: null, contacts: [] },
            { languageId: LANG_FR, pageTitle: "Communiqué", headline: "Cliniques ouvertes", subheadline: null, organizations: null, byline: null, bodyHtml: "<p>Corps</p>", pageImageId: null, contacts: [] },
          ],
        },
      ],
    });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(200, releaseView({ ...both, version: 2, documents: [{ ...both.documents[0]!, languages: [both.documents[0]!.languages[0]!] }] }));
      }),
    );
    render(<DocumentTabs view={both} setView={() => {}} documentId="doc-1" readOnly={false} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove French translation" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(calls).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(`/nrms/api/releases/${both.id}/documents/doc-1/translations/${LANG_FR}/remove`);
  });

  it("read-only: no Add/Remove translation buttons", () => {
    render(<DocumentTabs view={EN_ONLY} setView={() => {}} documentId="doc-1" readOnly />);
    expect(screen.queryByRole("button", { name: "Add French translation" })).not.toBeInTheDocument();
  });
});
