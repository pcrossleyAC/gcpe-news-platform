import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { useSearchShortcut } from "../../../shared/shortcuts";
import { Button } from "@bcgov/design-system-react-components";
import { ACTIVITY_STATUSES, EMPTY_LIST_FILTER, LIST_DISPLAYS, type CorporateQuery, type CorporateStatus, type ListDisplay, type ListFilter, type ListOptions, type ListQuery, type LookAheadFilter } from "@gcpe/calendar-contract";

const DISPLAY_LABELS: Record<ListDisplay, string> = {
  all: "Show All", my_ministries: "My Ministries' Activities Only", my_activities: "My Activities Only", my_watchlist: "My Watchlist Only",
};
const STATUS_LABELS = { new: "New", changed: "Changed", reviewed: "Reviewed" } as const;
/**
 * HqTools' Look Ahead filter. Legacy's "Look Ahead Only" and "Not for Look Ahead Only" mean not
 * confidential and confidential (form-order audit #7), so they are named for what they do.
 */
export const LOOK_AHEAD_LABELS: Record<LookAheadFilter, string> = { all: "Show All", look_ahead_only: "Not confidential only", not_for_look_ahead_only: "Confidential only" };
/** HqTools' Corporate Queries labels. */
const CORPORATE_LABELS: Record<CorporateStatus, string> = { new: "New", changed: "Changed", reviewed: "Reviewed", deleted: "Deleted", la_new: "LA New", la_changed: "LA Changed" };
const tri = (v: boolean | null) => (v === null ? "" : String(v));
const fromTri = (s: string) => (s === "" ? null : s === "true");
const num = (v: number | null) => (v === null ? "" : String(v));
const fromNum = (s: string) => (s === "" ? null : Number(s));
const choices = (xs: { id: number; name: string }[]) => xs.map((x) => ({ value: String(x.id), label: x.name }));
/** A value the query still filters by after its lookup row went away: shown, selected, so it can be cleared. */
const GONE = "(no longer available)";

function Choice({ id, label, value, onChange, options, any }: { id: string; label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; any: string }) {
  return (
    <div className="gcpe-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{any}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {value !== "" && !options.some((o) => o.value === value) && <option value={value}>{GONE}</option>}
      </select>
    </div>
  );
}

/** A corporate query in words: "next 8 days, New and Changed", "all upcoming, Deleted". */
export function corporateSummary(c: CorporateQuery): string {
  const statuses = c.statuses.map((s) => CORPORATE_LABELS[s]);
  const list = statuses.length > 1 ? `${statuses.slice(0, -1).join(", ")} and ${statuses.at(-1)}` : statuses[0];
  return `${c.days === null ? "all upcoming" : `next ${c.days} ${c.days === 1 ? "day" : "days"}`}, ${list}`;
}

const nameOf = (xs: { id: number; name: string }[], id: number | null) => (id === null ? null : (xs.find((x) => x.id === id)?.name ?? GONE));

/**
 * The filter the list is running, as short "Label: value" parts ("Lead Ministry: HLTH",
 * "Dates: 2026-11-01 to 2026-11-14"), for the closed Filters disclosure. Empty when nothing
 * narrows the list.
 */
export function activeFilterParts(query: ListQuery, options: ListOptions): string[] {
  // A corporate query replaces the filter and the display altogether (the server lists by it alone).
  if (query.corporate) return [`Corporate query: ${corporateSummary(query.corporate)}`];
  const f = query.filter;
  const parts: string[] = [];
  if (f.thisDayOnly && f.from) parts.push(`Date: ${f.from}`);
  else if (f.from && f.to) parts.push(`Dates: ${f.from} to ${f.to}`);
  else if (f.from) parts.push(`From ${f.from}`);
  else if (f.to) parts.push(`To ${f.to}`);
  if (f.quickSearch) parts.push(`Search: “${f.quickSearch}”`);
  if (f.keywordIds.length) parts.push(`HQ Tags: ${f.keywordIds.map((id) => nameOf(options.keywords, id)).join(", ")}`);
  if (f.isIssue !== null) parts.push(f.isIssue ? "Is an Issue" : "Not an Issue");
  if (f.dateConfirmed !== null) parts.push(f.dateConfirmed ? "Date is Confirmed" : "Date is not Confirmed");
  if (f.status) parts.push(`Status: ${STATUS_LABELS[f.status]}`);
  if (f.categoryId !== null) parts.push(`Category: ${nameOf(options.categories, f.categoryId)}`);
  if (f.ministryKey) {
    const m = options.ministries.find((x) => x.key === f.ministryKey);
    parts.push(`Lead Ministry: ${m ? (m.abbreviation ?? m.name) : GONE}`);
  }
  if (f.commContactUserId) parts.push(`Comm Contact: ${options.commContacts.find((c) => c.userId === f.commContactUserId)?.name ?? GONE}`);
  if (f.representativeId !== null) parts.push(`Representative: ${nameOf(options.representatives, f.representativeId)}`);
  if (f.initiativeId !== null) parts.push(`HQ Initiatives & Leads: ${nameOf(options.initiatives, f.initiativeId)}`);
  if (f.premierRequestedId !== null) parts.push(`Premier Requested: ${nameOf(options.premierRequested, f.premierRequestedId)}`);
  if (f.distributionId !== null) parts.push(`Distribution: ${nameOf(options.distributions, f.distributionId)}`);
  if (query.display !== "all") parts.push(DISPLAY_LABELS[query.display]);
  // The Confidential filter sits outside the panel and applies at once, but it narrows the list too (form-order audit #14).
  if (query.lookAhead !== "all") parts.push(LOOK_AHEAD_LABELS[query.lookAhead]);
  return parts;
}

/** The filter Apply filters would send: what the panel's fields hold, tidied as submit tidies them. */
const applied = (f: ListFilter): ListFilter => ({ ...f, quickSearch: f.quickSearch.trim(), to: f.thisDayOnly ? null : f.to });
const filterKey = (f: ListFilter) => JSON.stringify(Object.keys(f).sort().map((k) => [k, f[k as keyof ListFilter]]));

/** Whether Filters is open, for this browser tab only: the screen keeps no other per-user UI state locally. */
const OPEN_KEY = "gcpe.calendar.filtersOpen";
function storedOpen(): boolean | null {
  try {
    const v = sessionStorage.getItem(OPEN_KEY);
    return v === null ? null : v === "true";
  } catch {
    return null;
  }
}

/**
 * The Filter panel (Default.aspx:524-622). Apply filters runs it; the display chosen here is also
 * saved for next time. It starts closed, with the running filter (or "No filters") shown as one
 * line beside "Filters", so the activities start within the first screen; opening or closing it
 * is remembered for the tab.
 */
export function FilterPanel({ query, options, onSearch, onPending }: {
  query: ListQuery;
  options: ListOptions;
  onSearch: (q: ListQuery) => void;
  /** Hears whether the panel's filter differs from the one the list is running (not yet applied). */
  onPending?: (pending: boolean) => void;
}): React.JSX.Element {
  const [filter, setFilter] = useState<ListFilter>(query.filter);
  const [display, setDisplay] = useState<ListDisplay>(query.display);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([query.filter, query.display]);
  useEffect(() => {
    setFilter(query.filter);
    setDisplay(query.display);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const parts = activeFilterParts(query, options);
  const pending = filterKey(applied(filter)) !== filterKey(applied(query.filter));
  useEffect(() => onPending?.(pending), [pending]); // eslint-disable-line react-hooks/exhaustive-deps
  // Open, the panel is most of a screen (three on a phone) before the first activity: closed until asked for.
  const [open, setOpen] = useState<boolean>(() => storedOpen() ?? false);
  // ⌘/Ctrl+K: opens Filters (if closed) and goes to Search for.
  useSearchShortcut("list-search", () => flushSync(() => setOpen(true)));
  // Every HQ tag, then any the filter still names after its tag went away (shown so it can be cleared).
  const tagChoices = [...options.keywords.map((k) => ({ id: k.id, name: k.name })), ...filter.keywordIds.filter((id) => !options.keywords.some((k) => k.id === id)).map((id) => ({ id, name: GONE }))];
  const set = <K extends keyof ListFilter>(k: K, v: ListFilter[K]) => setFilter((f) => ({ ...f, [k]: v }));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (filter.from && filter.to && filter.from > filter.to && !filter.thisDayOnly) return setError("From must be on or before To.");
    setError(null);
    onSearch({ ...query, corporate: null, display, filter: applied(filter) });
  };
  return (
    <details
      className="gcpe-disclosure gcpe-calendar-filters"
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        // Browsers also fire toggle when a details first renders open: only a real change is the user's.
        if (next === open) return;
        setOpen(next);
        try {
          sessionStorage.setItem(OPEN_KEY, String(next));
        } catch {
          /* private mode: just not remembered */
        }
      }}
    >
      <summary>
        Filters
        <span className="gcpe-calendar-filters__summary">{parts.length ? parts.join(" · ") : "No filters"}</span>
      </summary>
      <form aria-label="Filter activities" className="gcpe-calendar-filter" onSubmit={submit}>
        <fieldset className="gcpe-calendar-filter__group">
          <legend>Dates</legend>
          <div className="gcpe-field">
            <label htmlFor="list-from">From</label>
            <input id="list-from" type="date" value={filter.from ?? ""} onChange={(e) => set("from", e.target.value || null)} />
          </div>
          <div className="gcpe-field">
            <label htmlFor="list-to">To</label>
            <input id="list-to" type="date" value={filter.to ?? ""} disabled={filter.thisDayOnly} onChange={(e) => set("to", e.target.value || null)} />
          </div>
          <div className="gcpe-check">
            <input id="list-this-day" type="checkbox" checked={filter.thisDayOnly} onChange={(e) => set("thisDayOnly", e.target.checked)} />
            <label htmlFor="list-this-day">This day only</label>
          </div>
        </fieldset>
        <div className="gcpe-field">
          <label htmlFor="list-search">Search for</label>
          <input id="list-search" type="search" maxLength={200} value={filter.quickSearch} aria-describedby="list-search-hint" onChange={(e) => set("quickSearch", e.target.value)} />
          <p id="list-search-hint" className="gcpe-hint">An activity number (such as HLTH-12345), or words in the title, summary, city and other text.</p>
        </div>
        <fieldset className="gcpe-calendar-filter__group gcpe-calendar-filter__tags">
          <legend>HQ Tags</legend>
          {tagChoices.length === 0 ? (
            <p className="gcpe-hint">No HQ tags yet.</p>
          ) : (
            <div className="gcpe-calendar-filter__tag-list">
              {tagChoices.map((t) => (
                <div key={t.id} className="gcpe-check">
                  <input
                    type="checkbox"
                    id={`list-tag-${t.id}`}
                    checked={filter.keywordIds.includes(t.id)}
                    onChange={(e) => {
                      const on = new Set(filter.keywordIds);
                      if (e.target.checked) on.add(t.id);
                      else on.delete(t.id);
                      // In the list's own order, as the multi-select used to send them.
                      set("keywordIds", tagChoices.map((x) => x.id).filter((id) => on.has(id)));
                    }}
                  />
                  <label htmlFor={`list-tag-${t.id}`}>{t.name}</label>
                </div>
              ))}
            </div>
          )}
        </fieldset>
        <Choice id="list-issue" label="Issue" value={tri(filter.isIssue)} onChange={(v) => set("isIssue", fromTri(v))} options={[{ value: "true", label: "Is an Issue" }, { value: "false", label: "Not an Issue" }]} any="Any" />
        <Choice id="list-confirmed" label="Dates Confirmed" value={tri(filter.dateConfirmed)} onChange={(v) => set("dateConfirmed", fromTri(v))} options={[{ value: "true", label: "Date is Confirmed" }, { value: "false", label: "Date is not Confirmed" }]} any="Any" />
        <Choice id="list-status" label="Status" value={filter.status ?? ""} onChange={(v) => set("status", v === "" ? null : (v as ListFilter["status"]))} options={ACTIVITY_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))} any="Any status" />
        <Choice id="list-category" label="Category" value={num(filter.categoryId)} onChange={(v) => set("categoryId", fromNum(v))} options={choices(options.categories)} any="Any category" />
        <Choice id="list-ministry" label="Lead Ministry" value={filter.ministryKey ?? ""} onChange={(v) => set("ministryKey", v || null)} options={options.ministries.map((m) => ({ value: m.key, label: m.abbreviation ?? m.name }))} any="Any ministry" />
        <Choice id="list-contact" label="Comm Contact" value={filter.commContactUserId ?? ""} onChange={(v) => set("commContactUserId", v || null)} options={options.commContacts.map((c) => ({ value: c.userId, label: c.name }))} any="Any comm contact" />
        <Choice id="list-representative" label="Representative" value={num(filter.representativeId)} onChange={(v) => set("representativeId", fromNum(v))} options={choices(options.representatives)} any="Any representative" />
        <Choice id="list-initiative" label="HQ Initiatives & Leads" value={num(filter.initiativeId)} onChange={(v) => set("initiativeId", fromNum(v))} options={choices(options.initiatives)} any="Any initiative" />
        <Choice id="list-premier" label="Premier Requested" value={num(filter.premierRequestedId)} onChange={(v) => set("premierRequestedId", fromNum(v))} options={choices(options.premierRequested)} any="Any" />
        <Choice id="list-distribution" label="Distribution" value={num(filter.distributionId)} onChange={(v) => set("distributionId", fromNum(v))} options={choices(options.distributions)} any="Any distribution" />
        <fieldset className="gcpe-calendar-filter__group">
          <legend>Display</legend>
          <p className="gcpe-hint">Kept for next time. A saved query doesn&rsquo;t include it.</p>
          {LIST_DISPLAYS.map((d) => (
            <div key={d} className="gcpe-check">
              <input type="radio" id={`list-display-${d}`} name="list-display" checked={display === d} onChange={() => setDisplay(d)} />
              <label htmlFor={`list-display-${d}`}>{DISPLAY_LABELS[d]}</label>
            </div>
          ))}
        </fieldset>
        {error && (
          <p role="alert" className="gcpe-calendar-filter__error">
            {error}
          </p>
        )}
        <div className="gcpe-actions gcpe-calendar-filter__actions">
          <Button type="submit">Apply filters</Button>
          <Button type="button" variant="secondary" onPress={() => setFilter(EMPTY_LIST_FILTER)}>
            Reset
          </Button>
        </div>
      </form>
    </details>
  );
}
