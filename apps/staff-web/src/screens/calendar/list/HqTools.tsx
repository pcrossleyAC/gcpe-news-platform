import { useState } from "react";
import { HelpToggle } from "../../../shared/HelpToggle";
import { CORPORATE_STATUSES, type CorporateQuery, type CorporateStatus, type ListQuery, type LookAheadFilter } from "@gcpe/calendar-contract";
import { AlertDialog, Modal } from "@bcgov/design-system-react-components";
import { Button } from "../../../shared/BusyButton";
import { afterDialogsClose } from "../../../shared/afterDialogsClose";
import { messagesOf } from "../../admin/messages";
import { downloadExport, listApi } from "./api";
import { corporateSummary, LOOK_AHEAD_LABELS } from "./FilterPanel";
import { ToolMessages } from "./ToolMessages";

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

/**
 * Review selected (UCFlexiGrid.ascx.cs:21-27; HQ Administrators). Rows changed since the list loaded
 * are skipped. It asks first, naming how many, as legacy did (UCFlexiGrid.ascx:4-22; suite review
 * CAL-6): the marks it clears can't be put back. A secondary button, so New activity leads.
 */
export function ReviewSelected({ selected, onDone }: { selected: Map<number, { version: number; label: string }>; onDone: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    const items = [...selected].map(([id, s]) => ({ id, version: s.version }));
    setConfirm(false);
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
      <Button variant="secondary" isPending={busy} isDisabled={selected.size === 0 || tooMany} pendingLabel="Reviewing…" onPress={() => setConfirm(true)}>{`Review selected (${selected.size})`}</Button>
      {tooMany && <p className="gcpe-hint">{`Select at most ${REVIEW_SELECTED_MAX} at a time.`}</p>}
      <Result status={status} error={error} />
      <Modal isOpen={confirm} onOpenChange={setConfirm} isDismissable>
        <AlertDialog
          role="alertdialog"
          aria-label={`Review ${plural(selected.size)}?`}
          variant="warning"
          title={`Review ${plural(selected.size)}?`}
          buttons={
            <>
              <Button variant="secondary" onPress={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button onPress={() => void run()}>Review</Button>
            </>
          }
        >
          <p>Their &ldquo;Changed: needs review&rdquo; marks are cleared and they become Reviewed. This can&rsquo;t be undone.</p>
        </AlertDialog>
      </Modal>
    </div>
  );
}

/**
 * Clear LA Status (Default.aspx.cs:44-53; HQ Editors and above): every visible activity starting
 * within the days given. Owner decision 2026-10-29: it asks first, saying how many activities it
 * will change (the Calendar's count for the same rule — the list on screen is filtered and paged,
 * so it can't tell); with none to change it just says so.
 */
export function ClearLaStatus({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [days, setDays] = useState("8");
  const [busy, setBusy] = useState(false);
  const [counting, setCounting] = useState(false);
  const [confirm, setConfirm] = useState<{ days: number; count: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valid = /^\d{1,3}$/.test(days) && Number(days) <= 366;
  const ask = async () => {
    const n = Number(days);
    setCounting(true);
    setStatus(null);
    setError(null);
    try {
      const { count } = await listApi.countLaStatus(n);
      if (count === 0) setStatus(`No activities up to ${n} ${n === 1 ? "day" : "days"} ahead have an LA status to clear.`);
      else setConfirm({ days: n, count });
    } catch (caught) {
      setError(messagesOf(caught).join(" "));
    } finally {
      setCounting(false);
    }
  };
  const run = async (n: number) => {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const out = await listApi.clearLaStatus(n);
      setConfirm(null);
      // Shown (and so announced) only once the confirmation has fully closed.
      afterDialogsClose(() => {
        if (out.failed) setError(`The LA status of ${plural(out.cleared)} was cleared before a later batch failed. Run Clear LA Status again to finish.`);
        else setStatus(`Cleared the LA status of ${plural(out.cleared)}.`);
      });
      onDone();
    } catch (caught) {
      setConfirm(null);
      const messages = messagesOf(caught).join(" ");
      afterDialogsClose(() => setError(messages));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="gcpe-label-row">
        <label htmlFor="la-days">Days ahead (Clear LA Status)</label>
        <HelpToggle entry="la-status" />
      </div>
      <input id="la-days" type="number" min={0} max={366} value={days} aria-invalid={!valid} onChange={(e) => setDays(e.target.value)} />
      <Button variant="secondary" isPending={counting || busy} isDisabled={!valid} pendingLabel={busy ? "Clearing…" : "Checking…"} onPress={() => void ask()}>
        Clear LA Status
      </Button>
      <ToolMessages>
        <Result status={status} error={error} />
      </ToolMessages>
      <Modal
        isOpen={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
        isDismissable
      >
        <AlertDialog
          role="alertdialog"
          variant="warning"
          title={`Clear the LA status of ${confirm ? plural(confirm.count) : ""}?`}
          buttons={
            <>
              <Button variant="secondary" isPending={busy} onPress={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button isPending={busy} pendingLabel="Clearing…" onPress={() => confirm && void run(confirm.days)}>
                Clear LA Status
              </Button>
            </>
          }
        >
          <p>
            {confirm &&
              `Every activity you can see that starts up to ${confirm.days} ${confirm.days === 1 ? "day" : "days"} ahead, past ones included, loses its LA New or LA Changed status. Each change is recorded in the activity's history.`}
          </p>
        </AlertDialog>
      </Modal>
    </div>
  );
}

const CORPORATE_LABELS: Record<CorporateStatus, string> = { new: "New", changed: "Changed", reviewed: "Reviewed", deleted: "Deleted", la_new: "LA New", la_changed: "LA Changed" };

/**
 * Corporate Queries (Default.aspx:628-660; HQ Advanced and above): every ministry's upcoming
 * activities by status. Its choices are only a form until run: while no corporate query is
 * running it says so, so its ticked boxes never read as the list's filter. A running one is
 * announced by CorporateBanner above the list instead.
 */
export function CorporateQueries({ active, onRun }: { active: CorporateQuery | null; onRun: (c: CorporateQuery) => void }): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const [days, setDays] = useState("8");
  const [statuses, setStatuses] = useState<CorporateStatus[]>(["new", "changed"]);
  const valid = statuses.length > 0 && (showAll || (/^\d{1,3}$/.test(days) && Number(days) <= 366));
  return (
    <section aria-labelledby="corporate-heading" className="gcpe-saved-views__part">
      <h2 id="corporate-heading">Corporate Queries</h2>
      <p className="gcpe-hint">{active ? `Running now: the list shows the corporate query (${corporateSummary(active)}).` : "Not applied: the list shows your filters. Choose below and run it to list every ministry's activities by status."}</p>
      <form
        aria-label="Corporate query"
        className="gcpe-corporate-query"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onRun({ days: showAll ? null : Number(days), statuses: CORPORATE_STATUSES.filter((s) => statuses.includes(s)) });
        }}
      >
        <fieldset className="gcpe-calendar-filter__group">
          <legend>Upcoming activities to show</legend>
          <div className="gcpe-check">
            <input type="radio" id="corp-all" name="corp-range" checked={showAll} onChange={() => setShowAll(true)} />
            <label htmlFor="corp-all">Show all</label>
          </div>
          <div className="gcpe-check gcpe-corporate-query__days">
            <input type="radio" id="corp-days" name="corp-range" checked={!showAll} onChange={() => setShowAll(false)} />
            <label htmlFor="corp-days">For the next</label>{" "}
            <input aria-label="Days ahead (corporate query)" type="number" min={0} max={366} value={days} disabled={showAll} onChange={(e) => setDays(e.target.value)} /> days
          </div>
        </fieldset>
        <fieldset className="gcpe-calendar-filter__group">
          <legend>With status of</legend>
          <div className="gcpe-corporate-query__statuses">
            {CORPORATE_STATUSES.map((s) => (
              <div key={s} className="gcpe-check">
                <input type="checkbox" id={`corp-${s}`} checked={statuses.includes(s)} onChange={(e) => setStatuses((xs) => (e.target.checked ? [...xs, s] : xs.filter((x) => x !== s)))} />
                <label htmlFor={`corp-${s}`}>{CORPORATE_LABELS[s]}</label>
              </div>
            ))}
          </div>
        </fieldset>
        <div className="gcpe-actions">
          <Button type="submit" variant="secondary" isDisabled={!valid}>
            Run corporate query
          </Button>
        </div>
      </form>
    </section>
  );
}

/** While a corporate query is running: said above the list, with the way back to the filter. */
export function CorporateBanner({ active, onClear }: { active: CorporateQuery; onClear: () => void }): React.JSX.Element {
  return (
    <div className="gcpe-corporate-banner">
      <p role="status">
        <strong>Showing a corporate query.</strong> {`Every ministry's activities: ${corporateSummary(active)}.`}
      </p>
      <Button variant="secondary" onPress={onClear}>
        Back to the filter
      </Button>
    </div>
  );
}

/** The Admin Settings' Look Ahead filter (Default.aspx:684-698; HQ Advanced and above), named the Confidential filter. */
export function LookAheadFilterChoice({ value, onChange }: { value: LookAheadFilter; onChange: (v: LookAheadFilter) => void }): React.JSX.Element {
  return (
    <fieldset role="group" aria-labelledby="la-filter-legend" className="gcpe-inline-choice">
      <legend id="la-filter-legend">Confidential filter</legend>
      {(Object.keys(LOOK_AHEAD_LABELS) as LookAheadFilter[]).map((v) => (
        <div key={v} className="gcpe-check">
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
      <Button variant="secondary" isPending={busy} pendingLabel="Exporting…" onPress={() => void run()}>
        Excel export
      </Button>
      <ToolMessages>{error && <p role="alert">{error}</p>}</ToolMessages>
    </div>
  );
}
