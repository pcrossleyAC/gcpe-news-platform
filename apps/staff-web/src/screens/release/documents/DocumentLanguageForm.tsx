import { useEffect, useState, type FormEvent } from "react";
import { Button, Form, InlineAlert, TextArea, TextField } from "@bcgov/design-system-react-components";
import { LANGUAGE_NAME, type LanguageId, type ReleaseView } from "@gcpe/nrms-contract";
import { RELOAD_MESSAGE, useReleaseSection } from "../useReleaseSection";
import { useRegisterDirty } from "../useUnsavedChanges";
import { useSession } from "../../../session/SessionContext";
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
 * Review Focus 1 (session-expiry recovery): while dirty, the form's own fields are mirrored
 * into `sessionStorage` keyed by signed-in user id + release id + document id + language
 * (unsavedDocumentStorage.ts) — restored on mount (e.g. after a 401 sent the user to sign in
 * and RequireAuth brought them back to this same release) and cleared on a successful save.
 * Never written at all for a read-only viewer, or if (defensively — this component only ever
 * renders inside the authenticated area) no user is signed in.
 *
 * Fix round 1, finding 1: the user id is part of the draft key — on a shared machine, user B
 * signing in on the same tab must never be handed user A's unsaved text. An expired session
 * (a 401) leaves the draft in place for the *same* user to recover; a different user's drafts
 * are simply never readable under their own key. Explicit sign-out additionally wipes every
 * draft outright (SessionContext.tsx's `signOut`), so a stale draft can't resurface even for a
 * returning version of the same person on a machine other people also use.
 */
export function DocumentLanguageForm({ view, setView, documentId, languageId, readOnly }: DocumentLanguageFormProps): React.JSX.Element {
  const section = useReleaseSection(view, setView);
  const session = useSession();
  const userId = session.user?.id ?? null;
  const canPersistDraft = !readOnly && userId !== null;
  const draftKey = userId !== null ? { userId, releaseId: view.id, documentId, languageId } : null;
  const [form, setForm] = useState<FormState>(() => {
    if (!canPersistDraft || !draftKey) return fromView(view, documentId, languageId);
    return loadDraft<FormState>(draftKey) ?? fromView(view, documentId, languageId);
  });

  const serverForm = fromView(view, documentId, languageId);
  const dirty = !readOnly && JSON.stringify(form) !== JSON.stringify(serverForm);
  useRegisterDirty(`document-${documentId}-${languageId}`, dirty);

  useEffect(() => {
    if (!canPersistDraft || !draftKey) return;
    if (dirty) saveDraft(draftKey, form);
    else clearDraft(draftKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, canPersistDraft]);

  const doc = findDocument(view, documentId);
  const lang = findLanguage(doc, languageId);
  if (!doc || !lang) return <p role="alert">This document or language no longer exists.</p>;

  const idBase = `doc-${documentId}-${languageId}`;
  const languageLabel = LANGUAGE_NAME[languageId];

  const setContact = (index: number, value: string) => setForm((f) => ({ ...f, contacts: f.contacts.map((c, i) => (i === index ? value : c)) }));
  const removeContact = (index: number) => setForm((f) => ({ ...f, contacts: f.contacts.filter((_, i) => i !== index) }));
  const addContact = () => setForm((f) => ({ ...f, contacts: [...f.contacts, ""] }));

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void section
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
      )
      .then((next) => {
        if (!next) return;
        if (draftKey) clearDraft(draftKey);
        setForm(fromView(next, documentId, languageId));
      });
  };

  const reload = () => void section.reload().then((next) => setForm(fromView(next, documentId, languageId)));

  return (
    <div className="gcpe-document-language" aria-label={`${languageLabel} document content`}>
      {section.conflict && <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} buttons={<Button onPress={reload}>Reload</Button>} />}
      {section.problems && (
        <ul role="alert" className="gcpe-release-editor__problems">
          {section.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {section.error && <InlineAlert variant="danger" role="alert" description={section.error} />}

      <Form onSubmit={onSubmit}>
        <TextField label="Page title" value={form.pageTitle} onChange={(v) => setForm((f) => ({ ...f, pageTitle: v }))} isDisabled={readOnly} isRequired maxLength={50} />
        <TextField label="Organizations" value={form.organizations} onChange={(v) => setForm((f) => ({ ...f, organizations: v }))} isDisabled={readOnly} />
        <TextField label="Headline" value={form.headline} onChange={(v) => setForm((f) => ({ ...f, headline: v }))} isDisabled={readOnly} maxLength={255} />
        <TextField label="Subheadline" value={form.subheadline} onChange={(v) => setForm((f) => ({ ...f, subheadline: v }))} isDisabled={readOnly} maxLength={100} />
        <TextField label="Byline" value={form.byline} onChange={(v) => setForm((f) => ({ ...f, byline: v }))} isDisabled={readOnly} maxLength={250} />

        <BodyEditor id={`${idBase}-body`} label="Body" value={form.bodyHtml} onChange={(html) => setForm((f) => ({ ...f, bodyHtml: html }))} readOnly={readOnly} />

        <fieldset>
          <legend>Contacts</legend>
          {form.contacts.map((contact, i) => (
            <div key={i} className="gcpe-document-language__contact">
              <TextArea label={`Contact ${i + 1}`} value={contact} onChange={(v) => setContact(i, v)} isDisabled={readOnly} maxLength={250} />
              {!readOnly && <Button variant="secondary" onPress={() => removeContact(i)}>Remove contact {i + 1}</Button>}
            </div>
          ))}
          {!readOnly && form.contacts.length < 20 && <Button variant="secondary" onPress={addContact}>Add contact</Button>}
        </fieldset>

        {!readOnly && (
          <Button type="submit" isDisabled={section.saving}>
            Save {languageLabel} content
          </Button>
        )}
      </Form>
    </div>
  );
}
