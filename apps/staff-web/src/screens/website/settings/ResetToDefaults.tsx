import { useEffect, useState } from "react";
import { InlineAlert } from "@bcgov/design-system-react-components";
import type { SiteSettings } from "@gcpe/site-settings";
import { ApiError } from "../../../api/client";
import { useAnnouncer } from "../../../shared/Announcer";
import { Button } from "../../../shared/BusyButton";
import { getSettingsDefaults } from "./api";
import type { SettingsEditor } from "./useSettingsEditor";

interface ResetToDefaultsProps {
  editor: SettingsEditor<unknown>;
  /** Puts the tenant defaults in the form (the caller picks its section out of them). */
  apply(defaults: SiteSettings): void;
  /** Shown after a reset: "Colours reset to the defaults. Save or publish to keep them." */
  done: string;
}

/**
 * "Reset to defaults" (spec "Hub screens"): fetches the tenant's defaults and fills the form
 * with them. Nothing is saved — the editor still has to save or publish — so this only reads.
 * The note stays until an action of the editor's own (save, publish…) says something else.
 */
export function ResetToDefaults({ editor, apply, done }: ResetToDefaultsProps): React.JSX.Element {
  const { announce } = useAnnouncer();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editor.status) setNote(null);
  }, [editor.status]);

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      apply(await getSettingsDefaults());
      setNote(done);
      announce(done);
    } catch (caught) {
      setNote(null);
      setError(caught instanceof ApiError ? caught.message : "Couldn't load the defaults. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gcpe-settings-reset">
      <Button variant="secondary" onPress={() => void reset()} isPending={busy || editor.busy}>
        Reset to defaults
      </Button>
      {note && <p>{note}</p>}
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
    </div>
  );
}
