import { useEffect, useState, type FormEvent } from "react";
import { Button, Form, InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { assetUrlProblem, typeRules, TYPE_LABEL, type AssetStatus, type ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch } from "../../../api/client";
import { RELOAD_MESSAGE, useReleaseSection } from "../useReleaseSection";
import { useRegisterDirty } from "../useUnsavedChanges";

export interface AssetSectionProps {
  view: ReleaseView;
  setView(v: ReleaseView): void;
  readOnly: boolean;
}

interface FormState {
  assetUrl: string;
  assetAltText: string;
  hasMediaAssets: boolean;
}

function fromView(view: ReleaseView): FormState {
  return { assetUrl: view.assetUrl ?? "", assetAltText: view.assetAltText ?? "", hasMediaAssets: view.hasMediaAssets };
}

function statusMessage(status: AssetStatus): string {
  switch (status.kind) {
    case "none":
      return "No media asset set.";
    case "youtube":
      return "YouTube video.";
    case "live":
      return "Live broadcast embed.";
    case "flickr":
      return status.message;
  }
}


/** Spec's "Media asset" section (`PUT .../asset`): the asset URL (validated client-side with
 * the shared {@link assetUrlProblem} rule, the same one the server enforces), alt text, and the
 * "includes additional media assets" flag — plus `GET .../asset-status`'s current state. */
export function AssetSection({ view, setView, readOnly }: AssetSectionProps): React.JSX.Element {
  const section = useReleaseSection(view, setView);
  const rules = typeRules(view.type);
  const [form, setForm] = useState<FormState>(() => fromView(view));
  const [status, setStatus] = useState<AssetStatus | null>(null);

  useEffect(() => {
    if (!rules.assetsAllowed) return;
    apiFetch<AssetStatus>(`/nrms/api/releases/${view.id}/asset-status`).then(setStatus, () => {
      // The status line just won't be shown — the rest of the form still works.
    });
    // Re-checks after a save changes the asset (view.assetUrl) or any other save bumps the
    // version (e.g. a Flickr job completing elsewhere could change the status text).
  }, [view.id, view.assetUrl, view.version]);

  const dirty = !readOnly && JSON.stringify(form) !== JSON.stringify(fromView(view));
  const trimmedUrl = form.assetUrl.trim();
  const urlProblem = trimmedUrl ? assetUrlProblem(trimmedUrl) : null;

  const doSave = () => {
    if (urlProblem) return Promise.resolve();
    return section
      .save("/asset", {
        version: view.version,
        assetUrl: trimmedUrl || null,
        assetAltText: form.assetAltText.trim() || null,
        hasMediaAssets: form.hasMediaAssets,
      })
      .then((next) => {
        if (next) setForm(fromView(next));
      });
  };
  useRegisterDirty("asset", dirty, !readOnly ? { label: "Save media asset", save: doSave } : undefined);

  if (!rules.assetsAllowed) {
    return (
      <section className="gcpe-release-editor__asset" aria-label="Media asset" id="section-asset" tabIndex={-1}>
        <h2>Media asset</h2>
        <p>A {TYPE_LABEL[view.type]} has no media asset.</p>
      </section>
    );
  }

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void doSave();
  };

  return (
    <section className="gcpe-release-editor__asset" aria-label="Media asset" id="section-asset" tabIndex={-1}>
      <h2>Media asset</h2>

      {status && <p className="gcpe-release-editor__asset-status">{statusMessage(status)}</p>}

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
          label="Asset URL"
          value={form.assetUrl}
          onChange={(v) => setForm((f) => ({ ...f, assetUrl: v }))}
          isDisabled={readOnly}
          isInvalid={urlProblem !== null}
          errorMessage={urlProblem ?? undefined}
        />
        <TextField label="Alt text" value={form.assetAltText} onChange={(v) => setForm((f) => ({ ...f, assetAltText: v }))} isDisabled={readOnly} maxLength={149} />
        <label>
          <input type="checkbox" checked={form.hasMediaAssets} disabled={readOnly} onChange={(e) => setForm((f) => ({ ...f, hasMediaAssets: e.target.checked }))} />
          Includes additional media assets
        </label>
        {!readOnly && (
          <Button type="submit" isDisabled={section.saving || urlProblem !== null}>
            Save media asset
          </Button>
        )}
      </Form>
    </section>
  );
}
