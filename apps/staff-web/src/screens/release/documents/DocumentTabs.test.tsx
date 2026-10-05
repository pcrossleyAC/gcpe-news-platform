import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { jsonResponse } from "../../../../test/jsonResponse";
import { LANG_EN, LANG_FR, type ReleaseView } from "@gcpe/nrms-contract";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { DocumentTabs } from "./DocumentTabs";

const EN_ONLY = releaseView({
  documents: [
    { id: "doc-1", sortIndex: 0, layout: "formal", languages: [{ languageId: LANG_EN, pageTitle: "News Release", headline: "Clinics open", subheadline: null, organizations: null, byline: null, bodyHtml: "<p>Body</p>", pageImageId: null, contacts: [] }] },
  ],
});

/** Stubs `/core/auth/session` and delegates everything else to `handler` (default: a bare 200,
 * for tests that never make a mutating call). */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response> = () => jsonResponse(200, {})) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "user-a", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
      return handler(url, init);
    }),
  );
}

// Wrapped in RequireAuth (same as production) so DocumentTabs's own DocumentLanguageForm child
// — which reads the signed-in user id for draft-recovery scoping — never mounts before the
// session has actually resolved.
function renderTabs(view: ReleaseView, setView: (v: ReleaseView) => void = () => {}, readOnly = false) {
  return render(
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>
          <DocumentTabs view={view} setView={setView} documentId="doc-1" readOnly={readOnly} />
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("DocumentTabs", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows the English tab and an Add French translation button when there's no French yet", async () => {
    stubFetch();
    renderTabs(EN_ONLY);
    expect(await screen.findByRole("tab", { name: "English" })).toHaveAttribute("aria-selected", "true");
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
    const calls: { url: string; init?: RequestInit }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, withFr);
    });
    let current = EN_ONLY;
    renderTabs(EN_ONLY, (v) => (current = v));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add French translation" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(`/nrms/api/releases/${EN_ONLY.id}/documents/doc-1/translations`);
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ version: 1, languageId: LANG_FR });
    expect(current.version).toBe(2);
  });

  it("switching tabs shows that language's own fields; Remove translation is offered once both exist", async () => {
    stubFetch();
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
    renderTabs(both);
    const user = userEvent.setup();
    expect(await screen.findByLabelText("Headline")).toHaveValue("Clinics open");
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
    const calls: { url: string; init?: RequestInit }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, releaseView({ ...both, version: 2, documents: [{ ...both.documents[0]!, languages: [both.documents[0]!.languages[0]!] }] }));
    });
    renderTabs(both);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Remove French translation" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(calls).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(`/nrms/api/releases/${both.id}/documents/doc-1/translations/${LANG_FR}/remove`);
  });

  it("read-only: no Add/Remove translation buttons", async () => {
    stubFetch();
    renderTabs(EN_ONLY, () => {}, true);
    await screen.findByRole("tab", { name: "English" });
    expect(screen.queryByRole("button", { name: "Add French translation" })).not.toBeInTheDocument();
  });
});
