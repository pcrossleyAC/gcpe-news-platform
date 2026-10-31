import type { FormEvent } from "react";
import { Form, InlineAlert, TextArea, TextField } from "@bcgov/design-system-react-components";
import { aType, TYPE_LABEL, typeRules, type ReleaseView } from "@gcpe/nrms-contract";
import { Button } from "../../../shared/BusyButton";
import { RELOAD_MESSAGE, useReleaseSection } from "../useReleaseSection";
import { UnsavedMarker } from "../UnsavedMarker";
import { useRegisterDirty, useSaveAll } from "../useUnsavedChanges";
import { useSeededForm } from "../useSeededForm";
import { releaseLanguageOf } from "../viewHelpers";

export interface PageDetailsSectionProps {
  view: ReleaseView;
  setView(v: ReleaseView): void;
  readOnly: boolean;
}

interface FormState {
  key: string;
  redirectUrl: string;
  location: string;
  summary: string;
  socialMediaSummary: string;
  keywords: string;
}

/** apps/nrms/src/releases/service.ts's EDITABLE_KEY_STATUSES. */
const EDITABLE_KEY_STATUSES = new Set(["draft", "approved"]);

function fromView(view: ReleaseView): FormState {
  const en = releaseLanguageOf(view);
  return {
    key: view.key ?? "",
    redirectUrl: view.redirectUrl ?? "",
    location: en?.location ?? "",
    summary: en?.summary ?? "",
    socialMediaSummary: en?.socialMediaSummary ?? "",
    keywords: view.keywords ?? "",
  };
}


/** Spec's "Page details" section (`PUT .../meta`): the URL key/slug (editable only for Story/
 * Factsheet, only while still a draft or approved, and never once it has been published), redirect URL, location, English summary,
 * social-media summary, and keywords. */
export function PageDetailsSection({ view, setView, readOnly }: PageDetailsSectionProps): React.JSX.Element {
  const section = useReleaseSection(view, setView);
  const rules = typeRules(view.type);
  const { form, setForm, dirty: edited, reseed, staleVersion } = useSeededForm<FormState>(fromView(view), view.version);

  const dirty = !readOnly && edited;

  // Suite review R2: once on the public site (the server's own test: a release date, an atom id or
  // a publication record), the key is a web address people were sent, so it stays fixed even after
  // an unpublish puts the release back to approved.
  const everPublished = view.everPublished;
  const keyEditable = rules.keyEditable && EDITABLE_KEY_STATUSES.has(view.status) && !everPublished;
  const keyNote = !rules.keyEditable
    ? `${aType(view.type)}'s URL key is generated automatically.`
    : everPublished
      ? `This ${TYPE_LABEL[view.type]} has been published, so its URL key can't change.`
      : !keyEditable
        ? "The URL key can no longer be changed."
        : undefined;
  const showSummaryFields = rules.categoriesBeyondMinistries;

  const doSave = () =>
    section
      .save("/meta", {
        version: view.version,
        key: keyEditable ? form.key.trim() || null : null,
        redirectUrl: form.redirectUrl.trim() || null,
        location: form.location,
        summary: showSummaryFields ? form.summary : "",
        socialMediaSummary: showSummaryFields ? form.socialMediaSummary.trim() || null : null,
        keywords: showSummaryFields ? form.keywords.trim() || null : null,
      }, "PUT", staleVersion, { quiet: true })
      .then((next) => {
        if (next) reseed(fromView(next), next.version);
        return next !== null;
      });
  useRegisterDirty("page-details", dirty, !readOnly ? { label: "Save page details", save: doSave } : undefined);

  // Enter in a field saves the page, the same as its one Save.
  const saveAll = useSaveAll();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    saveAll();
  };

  return (
    <section className="gcpe-release-editor__page-details" aria-label="Page details" id="section-page-details" tabIndex={-1}>
      <h2>
        Page details<UnsavedMarker show={dirty} />
      </h2>

      {section.conflict && (
        <InlineAlert
          variant="danger"
          role="alert"
          description={RELOAD_MESSAGE}
          buttons={<Button onPress={() => void section.reload().then((next) => reseed(fromView(next), next.version))}>Reload</Button>}
        />
      )}
      {section.problems && (
        <ul role="alert" className="gcpe-release-editor__problems">
          {section.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {section.error && <InlineAlert variant="danger" role="alert" description={section.error} />}

      <Form onSubmit={onSubmit} className="gcpe-stack">
        <div className="gcpe-form-grid">
          <TextField
            label="URL key"
            value={form.key}
            onChange={(v) => setForm((f) => ({ ...f, key: v }))}
            isDisabled={readOnly || !keyEditable}
            description={keyNote}
          />
          <TextField label="Redirect URL" value={form.redirectUrl} onChange={(v) => setForm((f) => ({ ...f, redirectUrl: v }))} isDisabled={readOnly} />
          <TextField label="Location" value={form.location} onChange={(v) => setForm((f) => ({ ...f, location: v }))} isDisabled={readOnly} maxLength={50} />
        </div>

        {showSummaryFields && (
          <>
            <TextArea label="Summary" value={form.summary} onChange={(v) => setForm((f) => ({ ...f, summary: v }))} isDisabled={readOnly} />
            <TextArea
              label="Social media summary"
              value={form.socialMediaSummary}
              onChange={(v) => setForm((f) => ({ ...f, socialMediaSummary: v }))}
              isDisabled={readOnly}
            />
            <TextField label="Keywords" value={form.keywords} onChange={(v) => setForm((f) => ({ ...f, keywords: v }))} isDisabled={readOnly} />
          </>
        )}
        {!showSummaryFields && <p>{aType(view.type)} has no summary, keywords or social media summary.</p>}

      </Form>
    </section>
  );
}
