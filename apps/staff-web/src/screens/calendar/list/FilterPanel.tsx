import { useEffect, useState } from "react";
import { Button } from "@bcgov/design-system-react-components";
import { ACTIVITY_STATUSES, EMPTY_LIST_FILTER, LIST_DISPLAYS, type ListDisplay, type ListFilter, type ListOptions, type ListQuery } from "@gcpe/calendar-contract";

const DISPLAY_LABELS: Record<ListDisplay, string> = {
  all: "Show All", my_ministries: "My Ministries' Activities Only", my_activities: "My Activities Only", my_watchlist: "My Watchlist Only",
};
const STATUS_LABELS = { new: "New", changed: "Changed", reviewed: "Reviewed" } as const;
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

/** The Filter panel (Default.aspx:524-622). Search runs it; the display chosen here is also saved for next time. */
export function FilterPanel({ query, options, onSearch }: { query: ListQuery; options: ListOptions; onSearch: (q: ListQuery) => void }): React.JSX.Element {
  const [filter, setFilter] = useState<ListFilter>(query.filter);
  const [display, setDisplay] = useState<ListDisplay>(query.display);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([query.filter, query.display]);
  useEffect(() => {
    setFilter(query.filter);
    setDisplay(query.display);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof ListFilter>(k: K, v: ListFilter[K]) => setFilter((f) => ({ ...f, [k]: v }));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (filter.from && filter.to && filter.from > filter.to && !filter.thisDayOnly) return setError("From must be on or before To.");
    setError(null);
    onSearch({ ...query, corporate: null, display, filter: { ...filter, quickSearch: filter.quickSearch.trim(), to: filter.thisDayOnly ? null : filter.to } });
  };
  return (
    <form aria-label="Filter activities" className="gcpe-calendar-filter" onSubmit={submit}>
      <fieldset>
        <legend>Dates</legend>
        <div className="gcpe-field">
          <label htmlFor="list-from">From</label>
          <input id="list-from" type="date" value={filter.from ?? ""} onChange={(e) => set("from", e.target.value || null)} />
        </div>
        <div className="gcpe-field">
          <label htmlFor="list-to">To</label>
          <input id="list-to" type="date" value={filter.to ?? ""} disabled={filter.thisDayOnly} onChange={(e) => set("to", e.target.value || null)} />
        </div>
        <div>
          <input id="list-this-day" type="checkbox" checked={filter.thisDayOnly} onChange={(e) => set("thisDayOnly", e.target.checked)} />
          <label htmlFor="list-this-day">This day only</label>
        </div>
      </fieldset>
      <div className="gcpe-field">
        <label htmlFor="list-search">Search for</label>
        <input id="list-search" type="search" maxLength={200} value={filter.quickSearch} aria-describedby="list-search-hint" onChange={(e) => set("quickSearch", e.target.value)} />
        <p id="list-search-hint" className="gcpe-hint">An activity number (such as HLTH-12345), or words in the title, summary, city and other text.</p>
      </div>
      <div className="gcpe-field">
        <label htmlFor="list-tags">HQ Tags</label>
        <select id="list-tags" multiple value={filter.keywordIds.map(String)} onChange={(e) => set("keywordIds", [...e.target.selectedOptions].map((o) => Number(o.value)))}>
          {options.keywords.map((k) => (
            <option key={k.id} value={String(k.id)}>
              {k.name}
            </option>
          ))}
          {filter.keywordIds
            .filter((id) => !options.keywords.some((k) => k.id === id))
            .map((id) => (
              <option key={id} value={String(id)}>
                {GONE}
              </option>
            ))}
        </select>
      </div>
      <Choice id="list-issue" label="Issue" value={tri(filter.isIssue)} onChange={(v) => set("isIssue", fromTri(v))} options={[{ value: "true", label: "Is an Issue" }, { value: "false", label: "Not an Issue" }]} any="Any" />
      <Choice id="list-confirmed" label="Date Confirmed" value={tri(filter.dateConfirmed)} onChange={(v) => set("dateConfirmed", fromTri(v))} options={[{ value: "true", label: "Date is Confirmed" }, { value: "false", label: "Date is not Confirmed" }]} any="Any" />
      <Choice id="list-status" label="Status" value={filter.status ?? ""} onChange={(v) => set("status", v === "" ? null : (v as ListFilter["status"]))} options={ACTIVITY_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))} any="Any status" />
      <Choice id="list-category" label="Category" value={num(filter.categoryId)} onChange={(v) => set("categoryId", fromNum(v))} options={choices(options.categories)} any="Any category" />
      <Choice id="list-ministry" label="Lead Ministry" value={filter.ministryKey ?? ""} onChange={(v) => set("ministryKey", v || null)} options={options.ministries.map((m) => ({ value: m.key, label: m.abbreviation ?? m.name }))} any="Any ministry" />
      <Choice id="list-contact" label="Comm Contact" value={filter.commContactUserId ?? ""} onChange={(v) => set("commContactUserId", v || null)} options={options.commContacts.map((c) => ({ value: c.userId, label: c.name }))} any="Any comm contact" />
      <Choice id="list-representative" label="Representative" value={num(filter.representativeId)} onChange={(v) => set("representativeId", fromNum(v))} options={choices(options.representatives)} any="Any representative" />
      <Choice id="list-initiative" label="Initiative" value={num(filter.initiativeId)} onChange={(v) => set("initiativeId", fromNum(v))} options={choices(options.initiatives)} any="Any initiative" />
      <Choice id="list-premier" label="Premier Requested" value={num(filter.premierRequestedId)} onChange={(v) => set("premierRequestedId", fromNum(v))} options={choices(options.premierRequested)} any="Any" />
      <Choice id="list-distribution" label="Distribution" value={num(filter.distributionId)} onChange={(v) => set("distributionId", fromNum(v))} options={choices(options.distributions)} any="Any distribution" />
      <fieldset>
        <legend>Display</legend>
        {LIST_DISPLAYS.map((d) => (
          <div key={d}>
            <input type="radio" id={`list-display-${d}`} name="list-display" checked={display === d} onChange={() => setDisplay(d)} />
            <label htmlFor={`list-display-${d}`}>{DISPLAY_LABELS[d]}</label>
          </div>
        ))}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <div className="gcpe-actions">
        <Button type="submit">Search</Button>
        <Button type="button" variant="secondary" onPress={() => setFilter(EMPTY_LIST_FILTER)}>
          Reset
        </Button>
      </div>
    </form>
  );
}
