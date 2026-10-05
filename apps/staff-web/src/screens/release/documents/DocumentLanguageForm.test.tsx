import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { jsonResponse } from "../../../../test/jsonResponse";
import { LANG_EN, LANG_FR, type ReleaseView } from "@gcpe/nrms-contract";
import { MemoryRouter } from "react-router";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { DocumentLanguageForm } from "./DocumentLanguageForm";
import { loadDraft } from "./unsavedDocumentStorage";

const BASE = releaseView({
  id: "00000000-0000-4000-8000-000000000099",
  documents: [
    {
      id: "doc-1",
      sortIndex: 0,
      layout: "formal",
      languages: [
        { languageId: LANG_EN, pageTitle: "News Release", headline: "Clinics open", subheadline: null, organizations: "Ministry of Health", byline: null, bodyHtml: "<p>Body</p>", pageImageId: null, contacts: ["Media Relations\n250-555-0100"] },
      ],
    },
  ],
});

/** Stubs `/core/auth/session` (as the given user, "user-a" by default — Fix round 1, finding 1:
 * draft persistence is keyed by this id) and delegates every other URL to `handler`. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, userId = "user-a") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: userId, name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
      return handler(url, init);
    }),
  );
}

function draftKeyFor(userId = "user-a") {
  return { userId, releaseId: BASE.id, documentId: "doc-1", languageId: LANG_EN };
}

// Fix round 1, finding 1: wrapped in RequireAuth, same as production (ReleaseEditorPage sits
// inside it too) — RequireAuth renders nothing until the session has actually resolved, so
// DocumentLanguageForm is never mounted with a not-yet-known `session.user`, the way it would
// be if this test rendered the bare component straight inside SessionProvider.
function renderForm(view: ReleaseView, setView = (_v: ReleaseView) => {}, readOnly = false) {
  return render(
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>
          <DocumentLanguageForm view={view} setView={setView} documentId="doc-1" languageId={LANG_EN} readOnly={readOnly} />
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("DocumentLanguageForm", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("renders the document's current fields", async () => {
    stubFetch(() => jsonResponse(200, {}));
    renderForm(BASE);
    expect(await screen.findByLabelText("Headline")).toHaveValue("Clinics open");
    expect(screen.getByLabelText("Organizations")).toHaveValue("Ministry of Health");
    expect(screen.getByLabelText("Contact 1")).toHaveValue("Media Relations\n250-555-0100");
    expect(screen.getByLabelText("Body")).toBeInTheDocument();
  });

  it("read-only: every field disabled, no Save button", async () => {
    stubFetch(() => jsonResponse(200, {}));
    renderForm(BASE, () => {}, true);
    expect(await screen.findByLabelText("Headline")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Save .* content/ })).not.toBeInTheDocument();
  });

  it("saves the edited fields to PUT .../documents/:docId/:lang", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, releaseView({ ...BASE, version: 2 }));
    });
    let current = BASE;
    renderForm(BASE, (v) => {
      current = v;
    });
    const user = userEvent.setup();
    await user.clear(await screen.findByLabelText("Headline"));
    await user.type(screen.getByLabelText("Headline"), "New headline");
    await user.click(screen.getByRole("button", { name: "Save English content" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(`/nrms/api/releases/${BASE.id}/documents/doc-1/${LANG_EN}`);
    expect(calls[0]!.init?.method).toBe("PUT");
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body).toMatchObject({ version: 1, headline: "New headline", pageTitle: "News Release" });
    expect(current.version).toBe(2);
  });

  it("409 shows the reload message with a working Reload button", async () => {
    stubFetch((url, init) => {
      if (init?.method === "PUT") return jsonResponse(409, { error: "conflict" });
      return jsonResponse(200, releaseView({ ...BASE, version: 5 }));
    });
    renderForm(BASE);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Save English content" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/someone else changed this/i);
    await user.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("422 shows the server's problems", async () => {
    stubFetch(() => jsonResponse(422, { error: "bad", problems: ["Headline is required."] }));
    renderForm(BASE);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Save English content" }));
    expect(await screen.findByText("Headline is required.")).toBeInTheDocument();
  });

  it("adds and removes contacts", async () => {
    stubFetch(() => jsonResponse(200, {}));
    renderForm(BASE);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add contact" }));
    expect(screen.getByLabelText("Contact 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove contact 2" }));
    expect(screen.queryByLabelText("Contact 2")).not.toBeInTheDocument();
  });

  it("restores unsaved text after an unmount/remount (session-expiry recovery)", async () => {
    stubFetch(() => jsonResponse(200, {}));
    const { unmount } = renderForm(BASE);
    const user = userEvent.setup();
    await user.clear(await screen.findByLabelText("Headline"));
    await user.type(screen.getByLabelText("Headline"), "Unsaved draft text");
    await waitFor(() => expect(loadDraft(draftKeyFor())).not.toBeNull());
    unmount();

    renderForm(BASE);
    expect(await screen.findByLabelText("Headline")).toHaveValue("Unsaved draft text");
  });

  it("clears the draft after a successful save", async () => {
    stubFetch(() => jsonResponse(200, releaseView({ ...BASE, version: 2 })));
    renderForm(BASE);
    const user = userEvent.setup();
    await user.clear(await screen.findByLabelText("Headline"));
    await user.type(screen.getByLabelText("Headline"), "Changed");
    await waitFor(() => expect(loadDraft(draftKeyFor())).not.toBeNull());
    await user.click(screen.getByRole("button", { name: "Save English content" }));
    await waitFor(() => expect(loadDraft(draftKeyFor())).toBeNull());
  });

  it("never writes a draft for a read-only viewer", async () => {
    stubFetch(() => jsonResponse(200, {}));
    renderForm(BASE, () => {}, true);
    await screen.findByLabelText("Headline");
    expect(loadDraft(draftKeyFor())).toBeNull();
  });

  // Fix round 1, finding 1: a shared machine — user B signing in on the same tab must never see
  // user A's unsaved text for the same release/document/language.
  it("doesn't restore a different signed-in user's draft", async () => {
    stubFetch(() => jsonResponse(200, {}), "user-a");
    const { unmount } = renderForm(BASE);
    const user = userEvent.setup();
    await user.clear(await screen.findByLabelText("Headline"));
    await user.type(screen.getByLabelText("Headline"), "A's unsaved text");
    await waitFor(() => expect(loadDraft(draftKeyFor("user-a"))).not.toBeNull());
    unmount();
    vi.unstubAllGlobals();

    stubFetch(() => jsonResponse(200, {}), "user-b");
    renderForm(BASE);
    expect(await screen.findByLabelText("Headline")).toHaveValue("Clinics open");
    expect(loadDraft(draftKeyFor("user-a"))).not.toBeNull(); // untouched, still recoverable by user A
  });

  it("shows the French tab's own content independently when rendered for LANG_FR", async () => {
    stubFetch(() => jsonResponse(200, {}));
    const withFr = releaseView({
      ...BASE,
      documents: [
        {
          ...BASE.documents[0]!,
          languages: [...BASE.documents[0]!.languages, { languageId: LANG_FR, pageTitle: "Communiqué", headline: "Cliniques ouvertes", subheadline: null, organizations: null, byline: null, bodyHtml: "<p>Corps</p>", pageImageId: null, contacts: [] }],
        },
      ],
    });
    render(
      <SessionProvider>
        <MemoryRouter>
          <RequireAuth>
            <DocumentLanguageForm view={withFr} setView={() => {}} documentId="doc-1" languageId={LANG_FR} readOnly={false} />
          </RequireAuth>
        </MemoryRouter>
      </SessionProvider>,
    );
    expect(await screen.findByLabelText("Headline")).toHaveValue("Cliniques ouvertes");
    expect(screen.queryByText(/^Summary:/)).not.toBeInTheDocument();
  });
});
