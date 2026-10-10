import { useState } from "react";
import { Button } from "@bcgov/design-system-react-components";
import { CORPORATE_STATUSES, type CorporateQuery, type CorporateStatus, type ListQuery, type LookAheadFilter } from "@gcpe/calendar-contract";
import { messagesOf } from "../../admin/messages";
import { downloadExport, listApi } from "./api";

/** POST /activities/review-selected takes at most this many. */
export const REVIEW_SELECTED_MAX = 500;
const plural = (n: number) => `${n} ${n === 1 ? "activity" : "activities"}`;

function Result({ status, error }: { status: string | null; error: string | null }) {
  return (
    <>
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </>
  );
}

/** Review selected (UCFlexiGrid.ascx.cs:21-27; HQ Administrators). Rows changed since the list loaded are skipped. */
export function ReviewSelected({ selected, onDone }: { selected: Map<number, { version: number; label: string }>; onDone: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    const items = [...selected].map(([id, s]) => ({ id, version: s.version }));
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const out = await listApi.reviewSelected(items);
      // A 207: a later batch rolled back after earlier ones committed; only `reviewed` is real.
      if (out.failed) {
        const skipped = out.skipped.length ? `, and ${out.skipped.length} ${out.skipped.length === 1 ? "was" : "were"} skipped` : "";
        setError(`Only ${out.reviewed.length} of ${plural(items.length)} were reviewed before a later batch failed${skipped}. Select the rest and review them again.`);
      } else {
        const label = (id: number) => selected.get(id)?.label ?? String(id);
        const changed = out.skipped.filter((s) => s.reason === "changed").map((s) => label(s.id));
        const gone = out.skipped.filter((s) => s.reason === "not_found").map((s) => label(s.id));
        setStatus(
          [
            `Reviewed ${plural(out.reviewed.length)}.`,
            changed.length ? `${changed.length} skipped because ${changed.length === 1 ? "it" : "they"} changed since the list loaded: ${changed.join(", ")}.` : "",
            gone.length ? `${gone.length} skipped because ${gone.length === 1 ? "it is" : "they are"} no longer visible: ${gone.join(", ")}.` : "",
          ].filter(Boolean).join(" "),
        );
      }
      onDone();
    } catch (caught) {
      setError(messagesOf(caught).join(" "));
    } finally {
      setBusy(false);
    }
  };
  const tooMany = selected.size > REVIEW_SELECTED_MAX;
  return (
    <div>
      <Button isDisabled={busy || selected.size === 0 || tooMany} onPress={() => void run()}>{`Review selected (${selected.size})`}</Button>
      {tooMany && <p className="gcpe-hint">{`Select at most ${REVIEW_SELECTED_MAX} at a time.`}</p>}
      <Result status={status} error={error} />
    </div>
  );
}

/** Clear LA Status (Default.aspx.cs:44-53; HQ Editors and above): every visible activity starting within the days given. */
export function ClearLaStatus({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [days, setDays] = useState("8");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valid = /^\d{1,3}$/.test(days) && Number(days) <= 366;
  const run = async () => {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const out = await listApi.clearLaStatus(Number(days));
      if (out.failed) setError(`The LA status of ${plural(out.cleared)} was cleared before a later batch failed. Run Clear LA Status again to finish.`);
      else setStatus(`Cleared the LA status of ${plural(out.cleared)}.`);
      onDone();
    } catch (caught) {
      setError(messagesOf(caught).join(" "));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <label htmlFor="la-days">Days ahead</label>
      <input id="la-days" type="number" min={0} max={366} value={days} aria-invalid={!valid} onChange={(e) => setDays(e.target.value)} />
      <Button variant="secondary" isDisabled={busy || !valid} onPress={() => void run()}>
        Clear LA Status
      </Button>
      <Result status={status} error={error} />
    </div>
  );
}

const CORPORATE_LABELS: Record<CorporateStatus, string> = { new: "New", changed: "Changed", reviewed: "Reviewed", deleted: "Deleted", la_new: "LA New", la_changed: "LA Changed" };

/** Corporate Queries (Default.aspx:628-660; HQ Advanced and above): every ministry's upcoming activities by status. */
export function CorporateQueries({ active, onRun, onClear }: { active: CorporateQuery | null; onRun: (c: CorporateQuery) => void; onClear: () => void }): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const [days, setDays] = useState("8");
  const [statuses, setStatuses] = useState<CorporateStatus[]>(["new", "changed"]);
  const valid = statuses.length > 0 && (showAll || (/^\d{1,3}$/.test(days) && Number(days) <= 366));
  return (
    <section aria-labelledby="corporate-heading">
      <h2 id="corporate-heading">Corporate Queries</h2>
      {active && (
        <p role="status">
          Showing a corporate query.{" "}
          <Button variant="tertiary" onPress={onClear}>
            Back to the filter
          </Button>
        </p>
      )}
      <form
        aria-label="Corporate query"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onRun({ days: showAll ? null : Number(days), statuses: CORPORATE_STATUSES.filter((s) => statuses.includes(s)) });
        }}
      >
        <fieldset>
          <legend>Upcoming activities to show</legend>
          <div>
            <input type="radio" id="corp-all" name="corp-range" checked={showAll} onChange={() => setShowAll(true)} />
            <label htmlFor="corp-all">Show all</label>
          </div>
          <div>
            <input type="radio" id="corp-days" name="corp-range" checked={!showAll} onChange={() => setShowAll(false)} />
            <label htmlFor="corp-days">For the next</label> <input aria-label="Number of days" type="number" min={0} max={366} value={days} disabled={showAll} onChange={(e) => setDays(e.target.value)} /> days
          </div>
        </fieldset>
        <fieldset>
          <legend>With status of</legend>
          {CORPORATE_STATUSES.map((s) => (
            <div key={s}>
              <input type="checkbox" id={`corp-${s}`} checked={statuses.includes(s)} onChange={(e) => setStatuses((xs) => (e.target.checked ? [...xs, s] : xs.filter((x) => x !== s)))} />
              <label htmlFor={`corp-${s}`}>{CORPORATE_LABELS[s]}</label>
            </div>
          ))}
        </fieldset>
        <Button type="submit" isDisabled={!valid}>
          Search
        </Button>
      </form>
    </section>
  );
}

const LOOK_AHEAD_LABELS: Record<LookAheadFilter, string> = { all: "Show All", look_ahead_only: "Look Ahead Only", not_for_look_ahead_only: "Not for Look Ahead Only" };

/** The Admin Settings' Look Ahead filter (Default.aspx:684-698; HQ Advanced and above). */
export function LookAheadFilterChoice({ value, onChange }: { value: LookAheadFilter; onChange: (v: LookAheadFilter) => void }): React.JSX.Element {
  return (
    <fieldset role="group" aria-labelledby="la-filter-legend">
      <legend id="la-filter-legend">Look Ahead filter</legend>
      {(Object.keys(LOOK_AHEAD_LABELS) as LookAheadFilter[]).map((v) => (
        <div key={v}>
          <input type="radio" id={`la-filter-${v}`} name="la-filter" checked={value === v} onChange={() => onChange(v)} />
          <label htmlFor={`la-filter-${v}`}>{LOOK_AHEAD_LABELS[v]}</label>
        </div>
      ))}
    </fieldset>
  );
}

/** The Excel export (C151): the current query's visible rows as .xlsx. */
export function ExportButton({ query }: { query: ListQuery }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await downloadExport(query);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't export the list.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <Button variant="secondary" isDisabled={busy} onPress={() => void run()}>
        Excel export
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
