import { useEffect, useState, type FormEvent } from "react";
import { Form, InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { typeRules, type ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch } from "../../../api/client";
import { Button } from "../../../shared/BusyButton";
import { RELOAD_MESSAGE, useReleaseSection } from "../useReleaseSection";
import { UnsavedMarker } from "../UnsavedMarker";
import { useRegisterDirty, useSaveAll } from "../useUnsavedChanges";
import { useSeededForm } from "../useSeededForm";
import { instantToBcLocal } from "../timezone";
import { ActivityLookupPanel, useActivityLookup } from "../ActivityLookupPanel";
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
  /** The Calendar activity ID as typed (digits only). */
  activityText: string;
  toSubscribers: boolean;
  mediaListKeys: string[];
  planned: ScheduleValue | null;
}

function fromView(view: ReleaseView, timeZone: string): FormState {
  return {
    activityText: view.activityId === null ? "" : String(view.activityId),
    toSubscribers: view.publishOptions.toSubscribers,
    mediaListKeys: view.mediaListKeys,
    planned: view.publishAt ? scheduleValueFromInstant(view.publishAt, timeZone) : null,
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
 * publish time (for planning only — Schedule/Publish now in {@link ActionsSection} commit a time),
 * whether it goes out to News On Demand subscribers, and which media distribution lists get it. */
export function SettingsSection({ view, setView, timeZone, readOnly }: SettingsSectionProps): React.JSX.Element {
  const section = useReleaseSection(view, setView);
  const rules = typeRules(view.type);
  // Compared against what it was seeded from, not the live view (useSeededForm.ts): Publish now,
  // Schedule and Approve change `publishAt` and the rest of the view server-side, and that must
  // never read as an unsaved edit here.
  const { form, setForm, dirty: edited, baseline, reseed, staleVersion } = useSeededForm<FormState>(fromView(view, timeZone), view.version);
  const typedActivityId = form.activityText === "" ? null : Number(form.activityText);
  // The id the activity lookup runs for: the typed id once the field loses focus (as the number
  // stepper this replaced committed it), so it isn't looked up on every keystroke.
  const [lookupId, setLookupId] = useState<number | null>(view.activityId);
  const [lists, setLists] = useState<MediaListOption[]>([]);
  const { lookup, error: lookupError } = useActivityLookup(lookupId);

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
    reseed(fromView(next, timeZone), next.version);
    setLookupId(next.activityId);
  };

  // Fix round 1, finding 1: whether the media email goes out follows the saved flag
  // (publishOptions.toMediaLists; NoD's items.ts and media-send.ts), and an imported release can
  // have lists ticked with it off. Any settings save sets it from the lists (saveSettings). Only
  // lists still offered count: a retired one gets nothing either way (fix round 2, finding 3).
  // - Never released: the section says so and counts as unsaved, so Save turns it on.
  // - Released before and now off the site (fix round 2, finding 2): republishing emails whoever
  //   wasn't reached, and a save would turn it on for lists the old system may already have
  //   emailed, so it's only said, never forced.
  // - Live: a correction emails nobody, so there's nothing to say.
  const activeTicked = view.mediaListKeys.filter((k) => lists.some((l) => l.key === k && l.isActive));
  const onlyRetired = rules.mediaListsAllowed && view.mediaListKeys.length > 0 && activeTicked.length === 0 && view.mediaListKeys.every((k) => lists.some((l) => l.key === k && !l.isActive));
  const flagOff = rules.mediaListsAllowed && !view.publishOptions.toMediaLists && activeTicked.length > 0 && !view.live;
  const mediaFlagOff = flagOff && view.releasedAt === null;
  const flagOffForRepublish = flagOff && view.releasedAt !== null;
  const dirty = !readOnly && (edited || mediaFlagOff);
  const plannedValue = form.planned;
  const setPlannedValue = (planned: ScheduleValue | null) => setForm((f) => ({ ...f, planned }));

  const toggleMediaList = (key: string) =>
    setForm((f) => ({ ...f, mediaListKeys: f.mediaListKeys.includes(key) ? f.mediaListKeys.filter((k) => k !== key) : [...f.mediaListKeys, key] }));

  // I2: the planned date is only ever truncated to the minute once it's round-tripped through
  // the BC-local picker (`plannedValue.local` has no seconds) — fine when the user actually
  // picked a new time, but re-sending that truncated local for a date the user never touched
  // can silently change the stored instant by a few seconds. For a published/approved release
  // that's not a no-op in the server's eyes (saveSettings only allows an unplanned-time change
  // from draft/approved/failed — see service.rules.test.ts) — it was rejected as a state error
  // on every retry, forever. So: if the user hasn't changed the planned date, re-send the
  // release's current instant unchanged instead of recomputing it.
  const plannedUnchanged = JSON.stringify(plannedValue) === JSON.stringify(baseline.planned);

  const doSave = () =>
    section
      .save("/settings", {
        version: view.version,
        activityId: typedActivityId,
        ...(plannedUnchanged
          ? { plannedPublishAt: view.publishAt }
          : plannedValue
            ? { plannedPublishAtLocal: plannedValue.local }
            : { plannedPublishAt: null }),
        // A type without News On Demand is refused `true` (saveSettings); an imported advisory can
        // still carry legacy's bit (fix round 2, finding 1), so it's sent off. Nothing else changes.
        toSubscribers: rules.nodAllowed ? form.toSubscribers : false,
        // The server sets this from the lists itself (saveSettings); sent to match.
        toMediaLists: form.mediaListKeys.length > 0,
        mediaListKeys: form.mediaListKeys,
      }, "PUT", staleVersion, { quiet: true })
      .then((next) => {
        if (next) resetFrom(next);
        return next !== null;
      });
  useRegisterDirty("settings", dirty, !readOnly ? { label: "Save settings", save: doSave } : undefined);

  // Enter in a field saves the page, the same as its one Save.
  const saveAll = useSaveAll();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    saveAll();
  };

  const initialPlanned = plannedValue ? instantToBcLocal(plannedValue.instant, timeZone) : null;

  return (
    <section className="gcpe-release-editor__settings" aria-label="Publish settings" id="section-settings" tabIndex={-1}>
      <h2>
        Publish settings<UnsavedMarker show={dirty} />
      </h2>

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

      <Form onSubmit={onSubmit} className="gcpe-stack">
        <TextField
          label="Calendar activity ID"
          inputMode="numeric"
          maxLength={9}
          value={form.activityText}
          onChange={(v) => setForm((f) => ({ ...f, activityText: v.replace(/\D/g, "") }))}
          onBlur={() => setLookupId(typedActivityId)}
          isDisabled={readOnly}
        />
        <ActivityLookupPanel lookup={lookup} error={lookupError} storedId={view.activityId} timeZone={timeZone} />

        <SchedulePicker
          // A new baseline (re-seeded from the release, or after a save) restarts the picker
          // from it; the user's own typing never does.
          key={baseline.planned?.instant ?? "none"}
          timeZone={timeZone}
          legend="Planned publish date (for planning only)"
          idPrefix="planned"
          initialDate={initialPlanned?.date}
          initialTime={initialPlanned?.time}
          onChange={setPlannedValue}
          isDisabled={readOnly}
        />
        {!readOnly && <p className="gcpe-hint gcpe-release-editor__planned-note">Shows on the Forecast. Nothing is published at this time: Schedule, under Actions, sets when it goes out.</p>}
        {plannedValue && !readOnly && (
          <Button size="small" variant="secondary" onPress={() => setPlannedValue(null)}>
            Clear planned date
          </Button>
        )}

        <label className="gcpe-check">
          <input type="checkbox" checked={form.toSubscribers} disabled={readOnly || !rules.nodAllowed} onChange={(e) => setForm((f) => ({ ...f, toSubscribers: e.target.checked }))} />
          Send to News On Demand subscribers
        </label>
        {!rules.nodAllowed && <p>Not available for this release type.</p>}

        {rules.mediaListsAllowed && (
          // No separate "Send to media distribution lists" box: the server sends the media email
          // to the ticked lists whatever such a box said (saveSettings), so the lists alone decide.
          <fieldset className="gcpe-options" aria-describedby="settings-media-lists-hint">
            <legend>Media distribution lists</legend>
            {onlyRetired ? (
              <p id="settings-media-lists-hint" className="gcpe-options__wide gcpe-release-editor__media-warning">
                {"The ticked lists are retired and won't get the media email."}
              </p>
            ) : flagOffForRepublish ? (
              <p id="settings-media-lists-hint" className="gcpe-options__wide gcpe-release-editor__media-warning">
                {"As saved, these lists won't get the media email when it's republished."}
              </p>
            ) : mediaFlagOff ? (
              <p id="settings-media-lists-hint" className="gcpe-options__wide gcpe-release-editor__media-warning">
                {readOnly ? "As saved, these lists won't get the media email." : "As saved, these lists won't get the media email. Save Publish settings and they will."}
              </p>
            ) : (
              <p id="settings-media-lists-hint" className="gcpe-options__wide gcpe-hint">
                {readOnly ? "The lists ticked here get the media email when this is published." : "The lists you tick get the media email when this is published. With none ticked, no media email goes out."}
              </p>
            )}
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

      </Form>
    </section>
  );
}
