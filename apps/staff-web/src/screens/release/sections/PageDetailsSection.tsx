import { useState, type FormEvent } from "react";
import { Button, Form, InlineAlert, TextArea, TextField } from "@bcgov/design-system-react-components";
import { typeRules, TYPE_LABEL, type ReleaseView } from "@gcpe/nrms-contract";
import { RELOAD_MESSAGE, useReleaseSection } from "../useReleaseSection";
import { useRegisterDirty } from "../useUnsavedChanges";
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
 * Factsheet, and only while still a draft or approved), redirect URL, location, English summary,
 * social-media summary, and keywords. */
export function PageDetailsSection({ view, setView, readOnly }: PageDetailsSectionProps): React.JSX.Element {
  const section = useReleaseSection(view, setView);
  const rules = typeRules(view.type);
  const [form, setForm] = useState<FormState>(() => fromView(view));

  const dirty = !readOnly && JSON.stringify(form) !== JSON.stringify(fromView(view));
  useRegisterDirty("page-details", dirty);

  const keyEditable = rules.keyEditable && EDITABLE_KEY_STATUSES.has(view.status);
  const showSummaryFields = rules.categoriesBeyondMinistries;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void section
      .save("/meta", {
        version: view.version,
        key: keyEditable ? form.key.trim() || null : null,
        redirectUrl: form.redirectUrl.trim() || null,
        location: form.location,
        summary: showSummaryFields ? form.summary : "",
        socialMediaSummary: showSummaryFields ? form.socialMediaSummary.trim() || null : null,
        keywords: showSummaryFields ? form.keywords.trim() || null : null,
      })
      .then((next) => {
        if (next) setForm(fromView(next));
      });
  };

  return (
    <section className="gcpe-release-editor__page-details" aria-label="Page details">
      <h2>Page details</h2>

      {section.conflict && (
        <InlineAlert
          variant="danger"
          role="alert"
          description={RELOAD_MESSAGE}
          buttons={<Button onPress={() => void section.reload().then((next) => setForm(fromView(next)))}>Reload</Button>}
        />
      )}
      {section.problems && (
        <ul role="alert" className="gcpe-release-editor__problems">
          {section.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <Form onSubmit={onSubmit}>
        <TextField
          label="URL key"
          value={form.key}
          onChange={(v) => setForm((f) => ({ ...f, key: v }))}
          isDisabled={readOnly || !keyEditable}
          description={!rules.keyEditable ? `A ${TYPE_LABEL[view.type]}'s URL key is generated automatically.` : !keyEditable ? "The URL key can no longer be changed." : undefined}
        />
        <TextField label="Redirect URL" value={form.redirectUrl} onChange={(v) => setForm((f) => ({ ...f, redirectUrl: v }))} isDisabled={readOnly} />
        <TextField label="Location" value={form.location} onChange={(v) => setForm((f) => ({ ...f, location: v }))} isDisabled={readOnly} maxLength={50} />

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
        {!showSummaryFields && <p>A {TYPE_LABEL[view.type]} has no summary, keywords or social media summary.</p>}

        {!readOnly && (
          <Button type="submit" isDisabled={section.saving}>
            Save page details
          </Button>
        )}
      </Form>
    </section>
  );
}
