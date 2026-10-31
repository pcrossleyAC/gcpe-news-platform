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
import { renderWithSaveBar } from "../saveBarHarness";
import { loadDraft, saveDraft } from "./unsavedDocumentStorage";

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

/** BASE's English language as the form holds it. */
const FORM_OF_BASE = { pageTitle: "News Release", organizations: "Ministry of Health", headline: "Clinics open", subheadline: "", byline: "", bodyHtml: "<p>Body</p>", contacts: ["Media Relations\n250-555-0100"] };

function draftKeyFor(userId = "user-a") {
  return { userId, releaseId: BASE.id, documentId: "doc-1", languageId: LANG_EN };
}

// Fix round 1, finding 1: wrapped in RequireAuth, same as production (ReleaseEditorPage sits
// inside it too) — RequireAuth renders nothing until the session has actually resolved, so
// DocumentLanguageForm is never mounted with a not-yet-known `session.user`, the way it would
// be if this test rendered the bare component straight inside SessionProvider.
function renderForm(view: ReleaseView, setView = (_v: ReleaseView) => {}, readOnly = false) {
  return renderWithSaveBar(
    <RequireAuth>
      <DocumentLanguageForm view={view} setView={setView} documentId="doc-1" languageId={LANG_EN} readOnly={readOnly} />
    </RequireAuth>,
    (router) => <SessionProvider>{router}</SessionProvider>,
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

  it("the Body editor offers Italic (owner decision: releases may hold italics)", async () => {
    stubFetch(() => jsonResponse(200, {}));
    renderForm(BASE);
    await screen.findByLabelText("Headline");
    expect(await screen.findByRole("button", { name: "Italic" })).toBeInTheDocument();
  });

  it("read-only: every field disabled, no Save button", async () => {
    stubFetch(() => jsonResponse(200, {}));
    renderForm(BASE, () => {}, true);
    expect(await screen.findByLabelText("Headline")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Save changes" }));

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
    await user.type(await screen.findByLabelText("Headline"), " more");
    await user.click(await screen.findByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/someone else changed this/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.queryByText(/someone else changed this/i)).not.toBeInTheDocument());
  });

  it("422 shows the server's problems", async () => {
    stubFetch(() => jsonResponse(422, { error: "bad", problems: ["Headline is required."] }));
    renderForm(BASE);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Headline"), " more");
    await user.click(await screen.findByRole("button", { name: "Save changes" }));
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

  // Suite review R3: like the Calendar, unsaved text is kept only when a 401 is about to send
  // the user to sign in; leaving the page (Leave in "Unsaved changes") or the form going away for
  // any other reason keeps nothing.
  it("keeps unsaved text when a 401 interrupts, with the version it was based on", async () => {
    stubFetch((_url, init) => (init?.method === "PUT" ? jsonResponse(401, { error: "not signed in" }) : jsonResponse(200, {})));
    renderForm(BASE);
    const user = userEvent.setup();
    await user.clear(await screen.findByLabelText("Headline"));
    await user.type(screen.getByLabelText("Headline"), "Unsaved draft text");
    expect(loadDraft(draftKeyFor())).toBeNull(); // nothing kept just for typing
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(loadDraft<{ headline: string }>(draftKeyFor())).toMatchObject({ version: 1, form: { headline: "Unsaved draft text" } }));
  });

  it("keeps nothing when the form goes away without a 401", async () => {
    stubFetch(() => jsonResponse(200, {}));
    const { unmount } = renderForm(BASE);
    const user = userEvent.setup();
    await user.clear(await screen.findByLabelText("Headline"));
    await user.type(screen.getByLabelText("Headline"), "Discarded text");
    unmount();
    expect(loadDraft(draftKeyFor())).toBeNull();

    renderForm(BASE);
    expect(await screen.findByLabelText("Headline")).toHaveValue("Clinics open");
    expect(screen.queryByText(/unsaved changes were restored/i)).not.toBeInTheDocument();
  });

  it("restores a kept draft, says so, and saves it against the version it was based on", async () => {
    saveDraft(draftKeyFor(), { version: 1, form: { ...FORM_OF_BASE, headline: "Kept headline" } });
    const calls: { url: string; init?: RequestInit }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, releaseView({ ...BASE, version: 2 }));
    });
    renderForm(BASE);
    expect(await screen.findByLabelText("Headline")).toHaveValue("Kept headline");
    expect(screen.getByText("Your unsaved changes were restored.")).toBeInTheDocument();
    // Now held by the form only: closing or reloading the tab can't bring it back again.
    await waitFor(() => expect(loadDraft(draftKeyFor())).toBeNull());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.parse(calls[0]!.init?.body as string)).toMatchObject({ version: 1, headline: "Kept headline" });
  });

  // A draft based on an older version must not silently overwrite what's there now: it's saved
  // with its own version, which the server refuses (409) when the release changed since.
  it("a kept draft from before a newer change saves with its old version and meets the conflict", async () => {
    saveDraft(draftKeyFor(), { version: 1, form: { ...FORM_OF_BASE, headline: "Stale headline" } });
    const calls: { url: string; init?: RequestInit }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, init });
      return init?.method === "PUT" ? jsonResponse(409, { error: "conflict" }) : jsonResponse(200, releaseView({ ...BASE, version: 4 }));
    });
    renderForm(releaseView({ ...BASE, version: 4 }));
    expect(await screen.findByLabelText("Headline")).toHaveValue("Stale headline");
    expect(screen.getByText(/this release has changed since/i)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/someone else changed this/i)).toBeInTheDocument();
    expect(JSON.parse(calls.find((c) => c.init?.method === "PUT")!.init?.body as string)).toMatchObject({ version: 1 });
    await user.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByLabelText("Headline")).toHaveValue("Clinics open"));
    expect(loadDraft(draftKeyFor())).toBeNull();
  });

  it("clears the draft after a successful save", async () => {
    saveDraft(draftKeyFor(), { version: 1, form: { ...FORM_OF_BASE, headline: "Changed" } });
    stubFetch(() => jsonResponse(200, releaseView({ ...BASE, version: 2 })));
    renderForm(BASE);
    const user = userEvent.setup();
    expect(await screen.findByLabelText("Headline")).toHaveValue("Changed");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
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
    saveDraft(draftKeyFor("user-a"), { version: 1, form: { ...FORM_OF_BASE, headline: "A's unsaved text" } });
    stubFetch(() => jsonResponse(200, {}), "user-b");
    renderForm(BASE);
    expect(await screen.findByLabelText("Headline")).toHaveValue("Clinics open");
    expect(loadDraft(draftKeyFor("user-a"))).not.toBeNull(); // untouched, still recoverable by user A
  });

  // forms-b #1: the server keeps Organizations only on a Formal document and Byline only on an
  // Informal one (apps/nrms/src/releases/service.ts saveDocumentLanguage), so only that field is
  // offered. Text a document already holds in the other one stays visible, read-only, with a note.
  describe("layout decides Organizations or Byline", () => {
    const withLanguage = (layout: "formal" | "informal", fields: { organizations: string | null; byline: string | null }, type: ReleaseView["type"] = "release") =>
      releaseView({ ...BASE, type, documents: [{ ...BASE.documents[0]!, layout, languages: [{ ...BASE.documents[0]!.languages[0]!, ...fields }] }] });

    it("Formal: Organizations, needed before publishing; no Byline", async () => {
      stubFetch(() => jsonResponse(200, {}));
      renderForm(withLanguage("formal", { organizations: "Ministry of Health", byline: null }));
      const orgs = await screen.findByRole("textbox", { name: "Organizations" });
      expect(orgs).toHaveValue("Ministry of Health");
      expect(orgs).toHaveAccessibleDescription("Needed before publishing.");
      expect(screen.queryByRole("textbox", { name: /Byline/ })).not.toBeInTheDocument();
    });

    it("Formal advisory: Organizations isn't needed to publish, so no note", async () => {
      stubFetch(() => jsonResponse(200, {}));
      renderForm(withLanguage("formal", { organizations: null, byline: null }, "advisory"));
      expect(await screen.findByRole("textbox", { name: "Organizations" })).not.toHaveAccessibleDescription(/publishing/);
    });

    it("Informal: Byline; no Organizations", async () => {
      stubFetch(() => jsonResponse(200, {}));
      renderForm(withLanguage("informal", { organizations: null, byline: "By Pat" }));
      expect(await screen.findByRole("textbox", { name: "Byline" })).toHaveValue("By Pat");
      expect(screen.queryByRole("textbox", { name: /Organizations/ })).not.toBeInTheDocument();
    });

    it("Formal holding a byline: shown read-only with a note, and the save sends what it sent before", async () => {
      const calls: { url: string; init?: RequestInit }[] = [];
      stubFetch((url, init) => {
        calls.push({ url, init });
        return jsonResponse(200, releaseView({ ...BASE, version: 2 }));
      });
      renderForm(withLanguage("formal", { organizations: "Ministry of Health", byline: "By Pat" }));
      const byline = await screen.findByRole("textbox", { name: "Byline" });
      expect(byline).toHaveValue("By Pat");
      expect(byline).toHaveAttribute("readonly");
      expect(byline).toHaveAccessibleDescription("A formal document doesn't keep a byline. It's removed the next time this tab is saved.");

      const user = userEvent.setup();
      await user.type(screen.getByLabelText("Headline"), " today");
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(JSON.parse(calls[0]!.init?.body as string)).toMatchObject({ layout: "formal", organizations: "Ministry of Health", byline: "By Pat" });
    });

    it("Informal holding organizations: shown read-only with a note", async () => {
      stubFetch(() => jsonResponse(200, {}));
      renderForm(withLanguage("informal", { organizations: "Ministry of Health", byline: null }));
      const orgs = await screen.findByRole("textbox", { name: "Organizations" });
      expect(orgs).toHaveAttribute("readonly");
      expect(orgs).toHaveAccessibleDescription("An informal document doesn't keep organizations. They're removed the next time this tab is saved.");
      expect(screen.getByRole("textbox", { name: "Byline" })).not.toHaveAttribute("readonly");
    });

    it("read-only viewer: no required markers or publishing notes", async () => {
      stubFetch(() => jsonResponse(200, {}));
      renderForm(withLanguage("formal", { organizations: "Ministry of Health", byline: null }), () => {}, true);
      expect(await screen.findByRole("textbox", { name: "Page title" })).not.toBeRequired();
      expect(screen.getByRole("textbox", { name: "Organizations" })).not.toHaveAccessibleDescription(/publishing/);
    });
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
