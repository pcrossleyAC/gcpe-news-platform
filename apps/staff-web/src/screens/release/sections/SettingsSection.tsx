import { useEffect, useState, type FormEvent } from "react";
import { Button, Form, InlineAlert, NumberField } from "@bcgov/design-system-react-components";
import { typeRules, type ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch } from "../../../api/client";
import { RELOAD_MESSAGE, useReleaseSection } from "../useReleaseSection";
import { SaveStatus } from "../SaveStatus";
import { useRegisterDirty } from "../useUnsavedChanges";
import { instantToBcLocal } from "../timezone";
import { SchedulePicker, type ScheduleValue } from "./SchedulePicker";

export interface SettingsSectionProps {
  view: ReleaseView;
  setView(v: ReleaseView): void;
  timeZone: string;
  readOnly: boolean;
}

interface MediaListOption {
  key: string;
  displayName: string;
  isActive: boolean;
}

interface FormState {
  activityId: number | null;
  toSubscribers: boolean;
  toMediaLists: boolean;
  mediaListKeys: string[];
}

function fromView(view: ReleaseView): FormState {
  return {
    activityId: view.activityId,
    toSubscribers: view.publishOptions.toSubscribers,
    toMediaLists: view.publishOptions.toMediaLists,
    mediaListKeys: view.mediaListKeys,
  };
}

/** `view.publishAt` (a real instant) as a {@link ScheduleValue} — `local` is derived via
 * {@link instantToBcLocal} so the picker can be pre-filled and, if left unchanged, re-saved as
 * the same `plannedPublishAtLocal` the server would convert right back to this instant. */
function scheduleValueFromInstant(iso: string, timeZone: string): ScheduleValue {
  const { date, time } = instantToBcLocal(iso, timeZone);
  return { local: `${date}T${time}`, instant: iso };
}

/** Spec's "Publish settings" section (`PUT .../settings`): Calendar activity id, the planned
 * (not yet committed — Schedule/Publish now in {@link ActionsSection} commit it) publish time,
 * and whether/where this goes out to News On Demand subscribers and media distribution lists. */
export function SettingsSection({ view, setView, timeZone, readOnly }: SettingsSectionProps): React.JSX.Element {
  const section = useReleaseSection(view, setView);
  const rules = typeRules(view.type);
  const [form, setForm] = useState<FormState>(() => fromView(view));
  const [plannedValue, setPlannedValue] = useState<ScheduleValue | null>(view.publishAt ? scheduleValueFromInstant(view.publishAt, timeZone) : null);
  const [lists, setLists] = useState<MediaListOption[]>([]);

  useEffect(() => {
    // GET /media-lists also returns retired lists: kept here so a release already targeting
    // one can show it (below), but only active ones are ever offered.
    apiFetch<MediaListOption[]>("/nrms/api/media-lists").then(
      (all) => setLists(all),
      () => {
        // The checkbox list just won't be offered — the rest of the form still works.
      },
    );
  }, []);

  const resetFrom = (next: ReleaseView) => {
    setForm(fromView(next));
    setPlannedValue(next.publishAt ? scheduleValueFromInstant(next.publishAt, timeZone) : null);
  };

  const dirty = !readOnly && (JSON.stringify(form) !== JSON.stringify(fromView(view)) || (plannedValue?.instant ?? null) !== view.publishAt);

  const toggleMediaList = (key: string) =>
    setForm((f) => ({ ...f, mediaListKeys: f.mediaListKeys.includes(key) ? f.mediaListKeys.filter((k) => k !== key) : [...f.mediaListKeys, key] }));

  // I2: the planned date is only ever truncated to the minute once it's round-tripped through
  // the BC-local picker (`plannedValue.local` has no seconds) — fine when the user actually
  // picked a new time, but re-sending that truncated local for a date the user never touched
  // can silently change the stored instant by a few seconds. For a published/approved release
  // that's not a no-op in the server's eyes (saveSettings only allows an unplanned-time change
  // from draft/approved/failed — see service.rules.test.ts) — it was rejected as a state error
  // on every retry, forever. Same check as the `dirty` flag above: if the picker shows exactly
  // what the release already has, re-send that exact instant unchanged instead of recomputing it.
  const plannedUnchanged = (plannedValue?.instant ?? null) === view.publishAt;

  const doSave = () =>
    section
      .save("/settings", {
        version: view.version,
        activityId: form.activityId,
        ...(plannedUnchanged
          ? { plannedPublishAt: view.publishAt }
          : plannedValue
            ? { plannedPublishAtLocal: plannedValue.local }
            : { plannedPublishAt: null }),
        toSubscribers: form.toSubscribers,
        toMediaLists: form.toMediaLists,
        mediaListKeys: form.mediaListKeys,
      })
      .then((next) => {
        if (next) resetFrom(next);
      });
  useRegisterDirty("settings", dirty, !readOnly ? { label: "Save settings", save: doSave } : undefined);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void doSave();
  };

  const initialPlanned = view.publishAt ? instantToBcLocal(view.publishAt, timeZone) : null;

  return (
    <section className="gcpe-release-editor__settings" aria-label="Publish settings" id="section-settings" tabIndex={-1}>
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
      {section.error && <InlineAlert variant="danger" role="alert" description={section.error} />}

      <Form onSubmit={onSubmit}>
        <NumberField
          label="Calendar activity ID"
          value={form.activityId ?? undefined}
          onChange={(v) => setForm((f) => ({ ...f, activityId: Number.isFinite(v) ? v : null }))}
          isDisabled={readOnly}
        />

        <SchedulePicker
          timeZone={timeZone}
          legend="Planned publish date (not yet committed)"
          idPrefix="planned"
          initialDate={initialPlanned?.date}
          initialTime={initialPlanned?.time}
          onChange={setPlannedValue}
        />
        {plannedValue && !readOnly && (
          <button type="button" onClick={() => setPlannedValue(null)}>
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
            {lists
              .filter((l) => l.isActive || view.mediaListKeys.includes(l.key))
              .map((l) =>
                l.isActive ? (
                  <label key={l.key}>
                    <input type="checkbox" checked={form.mediaListKeys.includes(l.key)} disabled={readOnly} onChange={() => toggleMediaList(l.key)} />
                    {l.displayName}
                  </label>
                ) : (
                  // A retired list the release already targets: shown so editors can see it, and
                  // kept on save (NRMS keeps it; NoD sends nothing to a retired list), but it
                  // can't be changed here.
                  <label key={l.key}>
                    <input type="checkbox" checked={form.mediaListKeys.includes(l.key)} disabled />
                    {l.displayName} (retired)
                  </label>
                ),
              )}
          </fieldset>
        )}

        {!readOnly && (
          <Button type="submit" isDisabled={section.saving}>
            Save settings
          </Button>
        )}
        {!readOnly && <SaveStatus saving={section.saving} waiting={section.waiting} />}
      </Form>
    </section>
  );
}
