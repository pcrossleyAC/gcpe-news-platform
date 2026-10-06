import { Switch } from "@bcgov/design-system-react-components";
import { FEATURE_SLOTS, type FeatureKind, type ReleaseView } from "@gcpe/nrms-contract";
import { RELOAD_MESSAGE, useReleaseSection } from "../useReleaseSection";

export interface FeaturePlace {
  kind: FeatureKind;
  key: string;
  label: string;
}

export interface FeatureSwitchesProps {
  view: ReleaseView;
  setView(v: ReleaseView): void;
  /** Home plus every ministry/sector/theme this release is currently (as saved — not whatever
   * the Categories form has typed but not yet saved) filed under. */
  places: FeaturePlace[];
  /** A Viewer (no `NRMS.Editor`) never gets a write control, regardless of publish status. */
  readOnly: boolean;
}

const SLOT_LABEL: Record<(typeof FEATURE_SLOTS)[number], string> = { top: "Top", feature: "Feature" };

/**
 * Spec's Top/Feature switches (`POST .../features`): "only enabled on a published release, with
 * the reason shown when disabled" — a draft/scheduled/etc. release simply can't hold a Top or
 * Feature slot (apps/nrms/src/website/features.ts's `setFeature` refuses it with a 409 even if
 * this client-side gate were somehow bypassed).
 */
export function FeatureSwitches({ view, setView, places, readOnly }: FeatureSwitchesProps): React.JSX.Element {
  const section = useReleaseSection(view, setView);
  const enabled = !readOnly && view.status === "published";

  const isOn = (place: FeaturePlace, slot: string) => view.features.some((f) => f.kind === place.kind && f.key === place.key && f.slot === slot);

  const toggle = (place: FeaturePlace, slot: (typeof FEATURE_SLOTS)[number], on: boolean) => {
    void section.save("/features", { kind: place.kind, key: place.key, slot, on }, "POST");
  };

  return (
    <div className="gcpe-release-editor__features">
      <h3>Top / Feature</h3>
      {!readOnly && view.status !== "published" && <p>Feature switches are only available once this release is published.</p>}
      {section.conflict && <p role="alert">{RELOAD_MESSAGE}</p>}
      {section.error && <p role="alert">{section.error}</p>}

      {places.map((place) => (
        <fieldset key={`${place.kind}:${place.key}`} className="gcpe-release-editor__feature-place">
          <legend>{place.label}</legend>
          {FEATURE_SLOTS.map((slot) => (
            <Switch key={slot} isSelected={isOn(place, slot)} isDisabled={!enabled || section.saving} onChange={(on) => toggle(place, slot, on)}>
              {SLOT_LABEL[slot]}
            </Switch>
          ))}
        </fieldset>
      ))}
    </div>
  );
}
