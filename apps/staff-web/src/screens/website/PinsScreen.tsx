import { useCallback, useEffect, useState } from "react";
import { Button, InlineAlert, Switch, TextField } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { RELOAD_MESSAGE, useVersionedSave } from "./useVersionedSave";
import type { Justify, PinSlot, PinView } from "./types";

interface PinFormProps {
  pin: PinView;
  canEdit: boolean;
  onSaved(): void;
}

const SLOT_LABEL: Record<PinSlot, string> = { primary: "Primary", secondary: "Secondary" };

function PinForm({ pin, canEdit, onSaved }: PinFormProps): React.JSX.Element {
  const section = useVersionedSave<PinView>();
  const [headline, setHeadline] = useState(pin.slide.headline);
  const [summary, setSummary] = useState(pin.slide.summary);
  const [actionUrl, setActionUrl] = useState(pin.slide.actionUrl);
  const [facebookPostUrl, setFacebookPostUrl] = useState(pin.slide.facebookPostUrl);
  const [justify, setJustify] = useState<Justify>(pin.slide.justify);
  const [imageError, setImageError] = useState<string | null>(null);

  const save = () => {
    void section
      .run(() =>
        apiFetch<PinView>(`/nrms/api/site/pins/${pin.slot}`, { method: "PUT", body: { version: pin.version, headline, summary, actionUrl, facebookPostUrl, justify } }),
      )
      .then((next) => {
        if (next) onSaved();
      });
  };

  const togglePinned = (next: boolean) => {
    void section.run(() => apiFetch<PinView>(`/nrms/api/site/pins/${pin.slot}/pinned`, { method: "POST", body: { version: pin.version, pinned: next } })).then((result) => {
      if (result) onSaved();
    });
  };

  const uploadImage = async (file: File) => {
    setImageError(null);
    try {
      await apiFetch(`/nrms/api/site/pins/${pin.slot}/image`, { method: "PUT", raw: file });
      onSaved();
    } catch (caught) {
      setImageError(caught instanceof Error ? caught.message : "Image upload failed.");
    }
  };

  return (
    <section aria-label={`${SLOT_LABEL[pin.slot]} emergency pin`}>
      <h2>{SLOT_LABEL[pin.slot]}</h2>

      {section.conflict && <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} buttons={<Button onPress={onSaved}>Reload</Button>} />}
      {section.problems && (
        <ul role="alert" className="gcpe-release-editor__problems">
          {section.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {section.error && <InlineAlert variant="danger" role="alert" description={section.error} />}
      {imageError && <InlineAlert variant="danger" role="alert" description={imageError} />}

      <Switch isSelected={pin.pinned} isDisabled={!canEdit || section.saving} onChange={togglePinned}>
        {pin.pinned ? `${SLOT_LABEL[pin.slot]} is pinned` : `${SLOT_LABEL[pin.slot]} is not pinned`}
      </Switch>

      <TextField label={`${SLOT_LABEL[pin.slot]} headline`} value={headline} onChange={setHeadline} isDisabled={!canEdit} />
      <TextField label={`${SLOT_LABEL[pin.slot]} summary`} value={summary} onChange={setSummary} isDisabled={!canEdit} />
      <TextField label={`${SLOT_LABEL[pin.slot]} action URL`} value={actionUrl} onChange={setActionUrl} isDisabled={!canEdit} />
      <TextField label={`${SLOT_LABEL[pin.slot]} Facebook post URL`} value={facebookPostUrl} onChange={setFacebookPostUrl} isDisabled={!canEdit} />
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
        <Button onPress={save} isDisabled={section.saving}>
          Save {SLOT_LABEL[pin.slot].toLowerCase()} pin
        </Button>
      )}
    </section>
  );
}

/**
 * `/hub/website/pins` (task-5-brief.md): the two emergency pins. Writes need `NRMS.SiteEditor`.
 */
export function PinsScreen(): React.JSX.Element {
  const session = useSession();
  const canEdit = session.has("NRMS.SiteEditor");
  const [pins, setPins] = useState<PinView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(() => {
    apiFetch<PinView[]>("/nrms/api/site/pins").then(setPins, () => setLoadError("Couldn't load the emergency pins."));
  }, []);

  useEffect(reload, [reload]);

  return (
    <div className="gcpe-pins">
      <h1>Emergency pins</h1>
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {pins === null && !loadError && <p>Loading…</p>}
      {pins?.map((pin) => <PinForm key={pin.slot} pin={pin} canEdit={canEdit} onSaved={reload} />)}
    </div>
  );
}
