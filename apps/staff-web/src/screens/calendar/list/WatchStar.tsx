import { useState } from "react";
import { listApi } from "./api";

export interface WatchState {
  isWatched: boolean;
  watcherNames: string[];
}

/** The watchlist star (Activity.aspx.cs:1519-1535; C176): a toggle naming who watches, on the activity page and the list. Not frozen. */
export function WatchStar({ id, label, watch, myName, onChange }: { id: number; label: string; watch: WatchState; myName: string; onChange: (w: WatchState) => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tip = watch.watcherNames.length ? `Watched by ${watch.watcherNames.join(", ")}` : "Nobody watches this yet";
  const toggle = async () => {
    const on = !watch.isWatched;
    setBusy(true);
    setError(null);
    try {
      await listApi.watch(id, on);
      const others = watch.watcherNames.filter((n) => n !== myName);
      onChange({ isWatched: on, watcherNames: on ? [...others, myName].sort((a, b) => a.localeCompare(b)) : others });
    } catch {
      setError("Couldn't change your watchlist.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span>
      <button type="button" className="gcpe-star" aria-label={`Watch ${label}`} aria-pressed={watch.isWatched} aria-describedby={`watchers-${id}`} title={tip} disabled={busy} onClick={() => void toggle()}>
        {watch.isWatched ? "★" : "☆"}
      </button>
      <span id={`watchers-${id}`} className="gcpe-visually-hidden">
        {tip}
      </span>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
