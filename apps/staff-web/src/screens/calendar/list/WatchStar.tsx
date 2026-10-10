import { useState } from "react";
import type { ListRow } from "@gcpe/calendar-contract";
import { listApi } from "./api";
import { minId } from "./cells";

/** The watchlist star (Activity.aspx.cs:1519-1535): a toggle, naming who watches. Not frozen. */
export function WatchStar({ row, myName, update }: { row: ListRow; myName: string; update: (patch: Partial<ListRow>) => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tip = row.watcherNames.length ? `Watched by ${row.watcherNames.join(", ")}` : "Nobody watches this yet";
  const toggle = async () => {
    const on = !row.isWatched;
    setBusy(true);
    setError(null);
    try {
      await listApi.watch(row.id, on);
      const others = row.watcherNames.filter((n) => n !== myName);
      update({ isWatched: on, watcherNames: on ? [...others, myName].sort((a, b) => a.localeCompare(b)) : others });
    } catch {
      setError("Couldn't change your watchlist.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span>
      <button
        type="button"
        className="gcpe-star"
        aria-label={`Watch ${minId(row)}`}
        aria-pressed={row.isWatched}
        aria-describedby={`watchers-${row.id}`}
        title={tip}
        disabled={busy}
        onClick={() => void toggle()}
      >
        {row.isWatched ? "★" : "☆"}
      </button>
      <span id={`watchers-${row.id}`} className="gcpe-visually-hidden">
        {tip}
      </span>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
