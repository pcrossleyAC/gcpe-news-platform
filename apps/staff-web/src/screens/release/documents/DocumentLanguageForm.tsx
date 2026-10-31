import { useEffect, useRef, useState, type FormEvent } from "react";
import { Form, InlineAlert, TextArea, TextField } from "@bcgov/design-system-react-components";
import { LANGUAGE_NAME, typeRules, type LanguageId, type ReleaseView } from "@gcpe/nrms-contract";
import { RELOAD_MESSAGE, useReleaseSection } from "../useReleaseSection";
import { useRegisterDirty, useSaveAll } from "../useUnsavedChanges";
import { useSeededForm } from "../useSeededForm";
import { useSession } from "../../../session/SessionContext";
import { onUnauthorized } from "../../../api/client";
import { Button } from "../../../shared/BusyButton";
import { BodyEditor } from "../../../editor/BodyEditor";
import { findDocument, findLanguage } from "./documentHelpers";
import { clearDraft, loadDraft, saveDraft } from "./unsavedDocumentStorage";

export interface DocumentLanguageFormProps {
  view: ReleaseView;
  setView(v: ReleaseView): void;
  documentId: string;
  languageId: LanguageId;
  readOnly: boolean;
}

const DROPPED_BYLINE = "A formal document doesn't keep a byline. It's removed the next time this tab is saved.";
const DROPPED_ORGANIZATIONS = "An informal document doesn't keep organizations. They're removed the next time this tab is saved.";

interface FormState {
  pageTitle: string;
  organizations: string;
  headline: string;
  subheadline: string;
  byline: string;
  bodyHtml: string;
  contacts: string[];
}

function fromView(view: ReleaseView, documentId: string, languageId: LanguageId): FormState {
  const lang = findLanguage(findDocument(view, documentId), languageId);
  return {
    pageTitle: lang?.pageTitle ?? "",
    organizations: lang?.organizations ?? "",
    headline: lang?.headline ?? "",
    subheadline: lang?.subheadline ?? "",
    byline: lang?.byline ?? "",
    bodyHtml: lang?.bodyHtml ?? "",
    contacts: lang?.contacts ?? [],
  };
}

/**
 * One document's one language tab (task-4-brief.md): page title, organizations, headline,
 * subheadline, byline, body (TipTap, editor/BodyEditor.tsx) and the contacts list — saved via
 * `PUT .../documents/:docId/:lang` (`documentLanguageSchema`).
 *
 * Review Focus 1 (session-expiry recovery), the Calendar's way (suite review R3): when a 401 is
 * about to send the user to sign in while the form is dirty, its fields are kept in
 * `sessionStorage` with the release version they were based on (unsavedDocumentStorage.ts), and
 * restored, with "Your unsaved changes were restored.", when the same user opens the same release
 * again. Nothing is kept for any other reason, so changes discarded with Leave never come back
 * (ReleaseEditorPage also clears this release's kept drafts on Leave). A restored draft based on
 * an older version saves with that version, so the server's 409 stops it overwriting newer
 * content. Never written for a read-only viewer, or if (defensively — this component only ever
 * renders inside the authenticated area) no user is signed in.
 *
 * Fix round 1, finding 1: the user id is part of the draft key — on a shared machine, user B
 * signing in on the same tab must never be handed user A's unsaved text. Explicit sign-out wipes
 * every draft outright (SessionContext.tsx's `signOut`).
 */
export function DocumentLanguageForm({ view, setView, documentId, languageId, readOnly }: DocumentLanguageFormProps): React.JSX.Element {
  const section = useReleaseSection(view, setView);
  const session = useSession();
  const userId = session.user?.id ?? null;
  const canPersistDraft = !readOnly && userId !== null;
  const draftKey = userId !== null ? { userId, releaseId: view.id, documentId, languageId } : null;
  // Compared against what it was seeded from, not the live view (useSeededForm.ts), so a change
  // made elsewhere (another section's Reload, a background refresh) never reads as an edit here.
  // A restored session-expiry draft seeds the form but not the baseline, so it counts as dirty.
  const [restored] = useState(() => (canPersistDraft && draftKey ? loadDraft<FormState>(draftKey) : null));
  // A restored draft based on an older version than the release now has: saved with that version,
  // so the server refuses it (409, Reload) rather than letting it overwrite the newer content.
  // Dropped once this form re-seeds from the server (its own save, or Reload).
  const [staleDraftVersion, setStaleDraftVersion] = useState<number | null>(() => (restored && restored.version !== view.version ? restored.version : null));
  const seeded = useSeededForm<FormState>(fromView(view, documentId, languageId), view.version, () => restored?.form ?? fromView(view, documentId, languageId));
  const { form, setForm, dirty: edited } = seeded;
  const reseed = (next: FormState, version: number) => {
    setStaleDraftVersion(null);
    seeded.reseed(next, version);
  };
  const pinVersion = staleDraftVersion ?? seeded.staleVersion;
  const dirty = !readOnly && edited;
  const languageLabel = LANGUAGE_NAME[languageId];

  const doc = findDocument(view, documentId);
  const lang = findLanguage(doc, languageId);

  const doSave = (): Promise<boolean> => {
    if (!doc || !lang) return Promise.resolve(false);
    return section
      .save(
        `/documents/${documentId}/${languageId}`,
        {
          version: view.version,
          pageTitle: form.pageTitle.trim(),
          layout: doc.layout,
          headline: form.headline.trim(),
          subheadline: form.subheadline.trim() || null,
          organizations: form.organizations.trim() || null,
          byline: form.byline.trim() || null,
          bodyHtml: form.bodyHtml,
          pageImageId: lang.pageImageId,
          contacts: form.contacts.map((c) => c.trim()).filter((c) => c !== ""),
        },
        "PUT",
        pinVersion,
        { quiet: true },
      )
      .then((next) => {
        if (!next) return false;
        if (draftKey) clearDraft(draftKey);
        reseed(fromView(next, documentId, languageId), next.version);
        return true;
      });
  };
  // "Save English content (Document 1)": the bar lists every dirty section, so it says which
  // document.
  const barLabel = `Save ${languageLabel} content${doc ? ` (Document ${doc.sortIndex + 1})` : ""}`;
  useRegisterDirty(`document-${documentId}-${languageId}`, dirty, !readOnly && doc && lang ? { label: barLabel, save: doSave } : undefined);

  // A 401 is about to send the user to sign in (RequireAuth unmounts this page first, so the
  // leave-page guard can't ask): keep the unsaved changes, and the version they were based on, for
  // when they come back.
  const latest = useRef({ dirty, form, version: pinVersion ?? view.version });
  latest.current = { dirty, form, version: pinVersion ?? view.version };
  const releaseId = view.id;
  useEffect(() => {
    if (!canPersistDraft || userId === null) return;
    const key = { userId, releaseId, documentId, languageId };
    return onUnauthorized(() => {
      if (latest.current.dirty) saveDraft(key, { version: latest.current.version, form: latest.current.form });
    });
  }, [canPersistDraft, userId, releaseId, documentId, languageId]);
  // Back to clean (saved, reloaded, or the edits taken back out): nothing left to keep.
  useEffect(() => {
    if (canPersistDraft && draftKey && !dirty) clearDraft(draftKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, canPersistDraft]);

  if (!doc || !lang) return <p role="alert">This document or language no longer exists.</p>;

  const idBase = `doc-${documentId}-${languageId}`;
  // The server keeps Organizations only on a Formal document and Byline only on an Informal one
  // (apps/nrms/src/releases/service.ts saveDocumentLanguage), so only that field is offered.
  // Text the document already holds in the other one (imported, or from before a layout change)
  // stays in view, read-only, saying it goes on the next save. The save itself is unchanged.
  const formal = doc.layout === "formal";
  const orgsNeededToPublish = typeRules(view.type).categoriesBeyondMinistries;
  const heldOrganizations = !formal ? (lang.organizations ?? "").trim() : "";
  const heldByline = formal ? (lang.byline ?? "").trim() : "";

  const setContact = (index: number, value: string) => setForm((f) => ({ ...f, contacts: f.contacts.map((c, i) => (i === index ? value : c)) }));
  const removeContact = (index: number) => setForm((f) => ({ ...f, contacts: f.contacts.filter((_, i) => i !== index) }));
  const addContact = () => setForm((f) => ({ ...f, contacts: [...f.contacts, ""] }));

  // Enter in a field saves the page, the same as its one Save.
  const saveAll = useSaveAll();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    saveAll();
  };

  const reload = () => void section.reload().then((next) => reseed(fromView(next, documentId, languageId), next.version));

  return (
    <div className="gcpe-document-language" role="group" aria-label={`${languageLabel} document content`}>
      {restored && dirty && (
        <p role="status" className="gcpe-notice">
          Your unsaved changes were restored.
          {staleDraftVersion !== null && " This release has changed since you made them, so saving them will ask you to reload first."}
        </p>
      )}
      {section.conflict && <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} buttons={<Button onPress={reload}>Reload</Button>} />}
      {section.problems && (
        <ul role="alert" className="gcpe-release-editor__problems">
          {section.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {section.error && <InlineAlert variant="danger" role="alert" description={section.error} />}

      <Form onSubmit={onSubmit} className="gcpe-doc-form">
        <div className="gcpe-form-grid">
          <TextField label="Page title" value={form.pageTitle} onChange={(v) => setForm((f) => ({ ...f, pageTitle: v }))} isDisabled={readOnly} isRequired={!readOnly} maxLength={50} />
          {formal ? (
            <TextField
              label="Organizations"
              value={form.organizations}
              onChange={(v) => setForm((f) => ({ ...f, organizations: v }))}
              isDisabled={readOnly}
              description={!readOnly && orgsNeededToPublish ? "Needed before publishing." : undefined}
            />
          ) : (
            heldOrganizations && <TextField label="Organizations" value={heldOrganizations} isReadOnly isDisabled={readOnly} description={DROPPED_ORGANIZATIONS} />
          )}
        </div>
        <TextField label="Headline" value={form.headline} onChange={(v) => setForm((f) => ({ ...f, headline: v }))} isDisabled={readOnly} maxLength={255} />
        <TextField label="Subheadline" value={form.subheadline} onChange={(v) => setForm((f) => ({ ...f, subheadline: v }))} isDisabled={readOnly} maxLength={100} />
        {formal ? (
          heldByline && (
            <div className="gcpe-form-grid">
              <TextField label="Byline" value={heldByline} isReadOnly isDisabled={readOnly} description={DROPPED_BYLINE} />
            </div>
          )
        ) : (
          <div className="gcpe-form-grid">
            <TextField label="Byline" value={form.byline} onChange={(v) => setForm((f) => ({ ...f, byline: v }))} isDisabled={readOnly} maxLength={250} />
          </div>
        )}

        <BodyEditor id={`${idBase}-body`} label="Body" value={form.bodyHtml} onChange={(html) => setForm((f) => ({ ...f, bodyHtml: html }))} readOnly={readOnly} allowItalic />

        <fieldset className="gcpe-fieldset">
          <legend>Contacts</legend>
          {form.contacts.map((contact, i) => (
            <div key={i} className="gcpe-document-language__contact">
              <TextArea label={`Contact ${i + 1}`} value={contact} onChange={(v) => setContact(i, v)} isDisabled={readOnly} maxLength={250} />
              {!readOnly && (
                <Button size="small" variant="secondary" onPress={() => removeContact(i)}>
                  Remove contact {i + 1}
                </Button>
              )}
            </div>
          ))}
          {!readOnly && form.contacts.length < 20 && (
            <Button size="small" variant="secondary" onPress={addContact}>
              Add contact
            </Button>
          )}
        </fieldset>

      </Form>
    </div>
  );
}
