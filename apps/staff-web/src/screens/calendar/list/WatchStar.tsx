import { useState } from "react";
import { listApi } from "./api";

export interface WatchState {
  isWatched: boolean;
  watcherNames: string[];
}

/** A drawn star, outlined or filled; the button's name and aria-pressed carry its meaning. */
function StarIcon({ filled }: { filled: boolean }): React.JSX.Element {
  return (
    <svg className="gcpe-star__icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 2.75l2.86 5.8 6.4.93-4.63 4.51 1.09 6.37L12 17.35l-5.72 3.01 1.09-6.37-4.63-4.51 6.4-.93z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
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
        <StarIcon filled={watch.isWatched} />
      </button>
      <span id={`watchers-${id}`} className="gcpe-visually-hidden">
        {tip}
      </span>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
