import { useEffect, useState, type FormEvent } from "react";
import { Button, Form, InlineAlert, NumberField } from "@bcgov/design-system-react-components";
import { typeRules, type ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../../api/client";
import { RELOAD_MESSAGE, useReleaseSection } from "../useReleaseSection";
import { useRegisterDirty } from "../useUnsavedChanges";
import { instantToBcLocal } from "../timezone";
import { SchedulePicker } from "./SchedulePicker";

export interface SettingsSectionProps {
  view: ReleaseView;
  setView(v: ReleaseView): void;
  timeZone: string;
  readOnly: boolean;
}

interface MediaListOption {
  id: string;
  key: string;
  name: string;
}

interface FormState {
  activityId: number | null;
  plannedPublishAt: string | null;
  toSubscribers: boolean;
  toMediaLists: boolean;
  mediaListKeys: string[];
}

function fromView(view: ReleaseView): FormState {
  return {
    activityId: view.activityId,
    plannedPublishAt: view.publishAt,
    toSubscribers: view.publishOptions.toSubscribers,
    toMediaLists: view.publishOptions.toMediaLists,
    mediaListKeys: view.mediaListKeys,
  };
}


/** Spec's "Publish settings" section (`PUT .../settings`): Calendar activity id, the planned
 * (not yet committed — Schedule/Publish now in {@link ActionsSection} commit it) publish time,
 * and whether/where this goes out to News On Demand subscribers and media distribution lists. */
export function SettingsSection({ view, setView, timeZone, readOnly }: SettingsSectionProps): React.JSX.Element {
  const section = useReleaseSection(view, setView);
  const rules = typeRules(view.type);
  const [form, setForm] = useState<FormState>(() => fromView(view));
  const [plannedIso, setPlannedIso] = useState<string | null>(view.publishAt);
  const [lists, setLists] = useState<MediaListOption[]>([]);

  useEffect(() => {
    apiFetch<MediaListOption[]>("/nrms/api/media-lists").then(setLists, () => {
      // The checkbox list just won't be offered — the rest of the form still works.
    });
  }, []);

  const resetFrom = (next: ReleaseView) => {
    setForm(fromView(next));
    setPlannedIso(next.publishAt);
  };

  const dirty = !readOnly && JSON.stringify({ ...form, plannedPublishAt: plannedIso }) !== JSON.stringify(fromView(view));
  useRegisterDirty("settings", dirty);

  const toggleMediaList = (key: string) =>
    setForm((f) => ({ ...f, mediaListKeys: f.mediaListKeys.includes(key) ? f.mediaListKeys.filter((k) => k !== key) : [...f.mediaListKeys, key] }));

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void section
      .save("/settings", {
        version: view.version,
        activityId: form.activityId,
        plannedPublishAt: plannedIso,
        toSubscribers: form.toSubscribers,
        toMediaLists: form.toMediaLists,
        mediaListKeys: form.mediaListKeys,
      })
      .then((next) => {
        if (next) resetFrom(next);
      });
  };

  const initialPlanned = view.publishAt ? instantToBcLocal(view.publishAt, timeZone) : null;

  return (
    <section className="gcpe-release-editor__settings" aria-label="Publish settings">
      <h2>Publish settings</h2>

      {section.conflict && (
        <InlineAlert
          variant="danger"
          role="alert"
          description={RELOAD_MESSAGE}
          buttons={<Button onPress={() => void section.reload().then(resetFrom)}>Reload</Button>}
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
        <NumberField
          label="Calendar activity ID"
          value={form.activityId ?? undefined}
          onChange={(v) => setForm((f) => ({ ...f, activityId: Number.isFinite(v) ? v : null }))}
          isDisabled={readOnly}
        />

        {/* Out of 3f Task 3 fix round 1 finding 3's scope: plannedPublishAt (unlike
         * scheduleSchema's publishAt/publishAtLocal) still takes a client-converted instant —
         * this is only a *planned*, not-yet-committed time, re-converted by Schedule/Publish
         * now in ActionsSection when it's actually committed. */}
        <SchedulePicker
          timeZone={timeZone}
          legend="Planned publish date (not yet committed)"
          idPrefix="planned"
          initialDate={initialPlanned?.date}
          initialTime={initialPlanned?.time}
          onChange={(v) => setPlannedIso(v?.instant ?? null)}
        />
        {plannedIso && !readOnly && (
          <button type="button" onClick={() => setPlannedIso(null)}>
            Clear planned date
          </button>
        )}

        <label>
          <input type="checkbox" checked={form.toSubscribers} disabled={readOnly || !rules.nodAllowed} onChange={(e) => setForm((f) => ({ ...f, toSubscribers: e.target.checked }))} />
          Send to News On Demand subscribers
        </label>
        {!rules.nodAllowed && <p>Not available for this release type.</p>}

        {rules.mediaListsAllowed && (
          <fieldset>
            <legend>Media distribution lists</legend>
            <label>
              <input type="checkbox" checked={form.toMediaLists} disabled={readOnly} onChange={(e) => setForm((f) => ({ ...f, toMediaLists: e.target.checked }))} />
              Send to media distribution lists
            </label>
            {lists.map((l) => (
              <label key={l.id}>
                <input type="checkbox" checked={form.mediaListKeys.includes(l.key)} disabled={readOnly} onChange={() => toggleMediaList(l.key)} />
                {l.name}
              </label>
            ))}
          </fieldset>
        )}

        {!readOnly && (
          <Button type="submit" isDisabled={section.saving}>
            Save settings
          </Button>
        )}
      </Form>
    </section>
  );
}
