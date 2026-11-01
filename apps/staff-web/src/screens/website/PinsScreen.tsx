import { useCallback, useEffect, useRef, useState } from "react";
import { InlineAlert, Switch, TextField } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { Button } from "../../shared/BusyButton";
import { useShortcut } from "../../shared/shortcuts";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { HostWarning } from "../../shared/HostWarning";
import { useStaffHostWarning } from "../../shared/publicAddress";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { canManageWebsite } from "./access";
import { SaveResult, clockTime } from "./SaveResult";
import { IMAGE_TOO_BIG, MAX_IMAGE_BYTES, imageUploadMessage, slideAddressErrors } from "./slideChecks";
import { RELOAD_MESSAGE, useVersionedSave } from "./useVersionedSave";
import { LeavePageGuard, useDirtyParts, useReportDirty, type ReportDirty } from "../../shared/LeaveGuard";
import type { Justify, PinSlot, PinView } from "./types";

interface PinFormProps {
  pin: PinView;
  canEdit: boolean;
  /** Reloads the pins: after a save `result` is what to show (W8); a plain reload passes none. */
  onSaved(result?: string): void;
  timeZone: string;
  /** Suite review W9: tells the screen's leave-page guard whether this notice has unsaved edits. */
  reportDirty?: ReportDirty;
}

const SLOT_LABEL: Record<PinSlot, string> = { primary: "Primary", secondary: "Secondary" };

/** W8: what a save did, said on screen. A pinned notice is on the public home page. */
const LIVE_NOW = "Live now: the home page shows it within a few minutes.";

function PinForm({ pin, canEdit, onSaved, timeZone, reportDirty }: PinFormProps): React.JSX.Element {
  const section = useVersionedSave<PinView>({ quiet: true });
  const at = () => clockTime(new Date(), timeZone);
  const [headline, setHeadline] = useState(pin.slide.headline);
  const [summary, setSummary] = useState(pin.slide.summary);
  const [actionUrl, setActionUrl] = useState(pin.slide.actionUrl);
  const [actionLabel, setActionLabel] = useState(pin.slide.actionLabel);
  const [facebookPostUrl, setFacebookPostUrl] = useState(pin.slide.facebookPostUrl);
  const [justify, setJustify] = useState<Justify>(pin.slide.justify);
  const [imageError, setImageError] = useState<string | null>(null);
  const staffHostWarning = useStaffHostWarning();
  const actionWarning = staffHostWarning(actionUrl);

  const [addressErrors, setAddressErrors] = useState<{ actionUrl?: string; facebookPostUrl?: string }>({});
  const addressProblems = Object.values(addressErrors);

  const save = () => {
    const found = slideAddressErrors({ actionUrl, facebookPostUrl });
    setAddressErrors(found);
    if (Object.keys(found).length > 0) return;
    void section
      .run(() =>
        apiFetch<PinView>(`/nrms/api/site/pins/${pin.slot}`, { method: "PUT", body: { version: pin.version, headline, summary, actionUrl, actionLabel, facebookPostUrl, justify } }),
      )
      .then((next) => {
        if (next) onSaved(next.pinned ? `Saved at ${at()}. ${LIVE_NOW}` : `Saved at ${at()}. Not on the home page: this notice isn\u2019t pinned.`);
      });
  };

  // ⌘/Ctrl+S saves the pin you're in (each pin has its own Save).
  const sectionRef = useRef<HTMLElement>(null);
  useShortcut("save", canEdit ? () => void (section.saving ? undefined : save()) : null, { within: sectionRef });

  const hasUnsavedEdits =
    headline !== pin.slide.headline ||
    summary !== pin.slide.summary ||
    actionUrl !== pin.slide.actionUrl ||
    actionLabel !== pin.slide.actionLabel ||
    facebookPostUrl !== pin.slide.facebookPostUrl ||
    justify !== pin.slide.justify;
  useReportDirty(reportDirty, pin.slot, canEdit && hasUnsavedEdits);

  // The switch saves only the pin state, and the notice then reloads (its key changes with its version), which
  // would discard anything typed. So with unsaved edits it refuses rather than lose them.
  const [switchRefused, setSwitchRefused] = useState(false);
  const togglePinned = (next: boolean) => {
    if (hasUnsavedEdits) {
      setSwitchRefused(true);
      return;
    }
    setSwitchRefused(false);
    void section.run(() => apiFetch<PinView>(`/nrms/api/site/pins/${pin.slot}/pinned`, { method: "POST", body: { version: pin.version, pinned: next } })).then((result) => {
      if (result) {
        onSaved(
          result.pinned
            ? `Pinned at ${at()}. Live now: the home page shows this notice within a few minutes.`
            : `Unpinned at ${at()}. The home page stops showing this notice within a few minutes.`,
        );
      }
    });
  };

  const uploadImage = async (file: File) => {
    setImageError(null);
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError(IMAGE_TOO_BIG);
      return;
    }
    try {
      await apiFetch(`/nrms/api/site/pins/${pin.slot}/image`, { method: "PUT", raw: file });
      // W7: the reload brings the image's new address, so the new picture shows at once.
      onSaved(pin.pinned ? `Image saved at ${at()}. ${LIVE_NOW}` : `Image saved at ${at()}.`);
    } catch (caught) {
      setImageError(imageUploadMessage(caught));
    }
  };

  return (
    <section ref={sectionRef} aria-label={`${SLOT_LABEL[pin.slot]} emergency pin`}>
      <h2>{SLOT_LABEL[pin.slot]}</h2>

      {section.conflict && <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} buttons={<Button onPress={() => onSaved()}>Reload</Button>} />}
      {section.problems && (
        <ul role="alert" className="gcpe-release-editor__problems">
          {section.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {addressProblems.length > 0 && (
        <div role="alert">
          <ul className="gcpe-release-editor__problems">
          {addressProblems.map((p) => (
            <li key={p}>{`${SLOT_LABEL[pin.slot]}: ${p}`}</li>
          ))}
        </ul>
        </div>
      )}
      {section.error && <InlineAlert variant="danger" role="alert" description={section.error} />}
      {imageError && <InlineAlert variant="danger" role="alert" description={imageError} />}

      <TextField label={`${SLOT_LABEL[pin.slot]} headline`} value={headline} onChange={setHeadline} isDisabled={!canEdit} />
      <TextField label={`${SLOT_LABEL[pin.slot]} summary`} value={summary} onChange={setSummary} isDisabled={!canEdit} />
      <TextField label={`${SLOT_LABEL[pin.slot]} action URL`} value={actionUrl} onChange={setActionUrl} isDisabled={!canEdit} isInvalid={addressErrors.actionUrl !== undefined} errorMessage={addressErrors.actionUrl} aria-describedby={actionWarning ? `pin-${pin.slot}-action-host` : undefined} />
      <HostWarning id={`pin-${pin.slot}-action-host`} text={actionWarning} />
      <TextField label={`${SLOT_LABEL[pin.slot]} action label`} description="The link text. Leave empty for the default set in Navigation and labels." value={actionLabel} onChange={setActionLabel} isDisabled={!canEdit} />
      <TextField label={`${SLOT_LABEL[pin.slot]} Facebook post URL`} value={facebookPostUrl} onChange={setFacebookPostUrl} isDisabled={!canEdit} isInvalid={addressErrors.facebookPostUrl !== undefined} errorMessage={addressErrors.facebookPostUrl} />
      <label>
        {SLOT_LABEL[pin.slot]} justify
        <select value={justify} onChange={(e) => setJustify(e.target.value as Justify)} disabled={!canEdit}>
          <option value="left">Left</option>
          <option value="right">Right</option>
        </select>
      </label>

      {pin.slide.imageUrl && (
        // eslint-disable-next-line jsx-a11y/alt-text
        <img src={pin.slide.imageUrl} alt="" width={120} />
      )}
      {canEdit && (
        <label>
          {SLOT_LABEL[pin.slot]} image (JPEG or PNG, up to 2 MB)
          <input
            type="file"
            accept="image/png,image/jpeg"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void uploadImage(file);
            }}
          />
        </label>
      )}

      {canEdit && (
        <Button onPress={save} isPending={section.saving} pendingLabel="Saving…" shortcut="save">
          Save {SLOT_LABEL[pin.slot].toLowerCase()} pin
        </Button>
      )}

      {/* Audit #6: edit, save, then pin. The switch pins the saved notice, so it follows Save. */}
      <Switch isSelected={pin.pinned} isDisabled={!canEdit} isReadOnly={section.saving} onChange={togglePinned}>
        {pin.pinned ? `${SLOT_LABEL[pin.slot]} is pinned` : `${SLOT_LABEL[pin.slot]} is not pinned`}
      </Switch>
      {switchRefused && hasUnsavedEdits && <InlineAlert variant="danger" role="alert" description="Save your changes first." />}
    </section>
  );
}

/**
 * `/hub/website/pins` (task-5-brief.md): the two emergency pins. Writes need `NRMS.SiteEditor`.
 */
export function PinsScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle("Emergency pins");
  const canManage = canManageWebsite(session);
  const canEdit = session.has("NRMS.SiteEditor");
  const [pins, setPins] = useState<PinView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const timeZone = useTenantTimeZone();
  const [results, setResults] = useState<Partial<Record<PinSlot, string>>>({});
  const forms = useDirtyParts();

  const reload = useCallback(() => {
    apiFetch<PinView[]>("/nrms/api/site/pins").then(setPins, () => setLoadError("Couldn't load the emergency pins."));
  }, []);

  // Minors: stays NRMS.SiteEditor/Core.Admin only — defense in depth for a direct deep link,
  // now that WebsiteScreen itself lets every read role through for Featured/Log.
  useEffect(() => {
    if (canManage) reload();
  }, [canManage, reload]);

  if (!canManage) {
    return (
      <div className="gcpe-pins">
        <h1>Emergency pins</h1>
        <p>You don&rsquo;t have permission to view the emergency pins.</p>
      </div>
    );
  }

  return (
    <div className="gcpe-pins">
      <h1>Emergency pins</h1>
      <LeavePageGuard dirty={forms.anyDirty} />
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {pins === null && !loadError && <p>Loading…</p>}
      {pins?.map((pin) => (
        // The form remounts with each saved version; its result sits outside it so it stays put (and is announced).
        <div key={pin.slot}>
          <PinForm
            key={`${pin.slot}:${pin.version}`}
            pin={pin}
            canEdit={canEdit}
            timeZone={timeZone}
            reportDirty={forms.report}
            onSaved={(result) => {
              if (result) setResults((r) => ({ ...r, [pin.slot]: result }));
              reload();
            }}
          />
          <SaveResult text={results[pin.slot] ?? ""} />
        </div>
      ))}
    </div>
  );
}
