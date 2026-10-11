import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { FEED_KEYWORD_MAX, FEED_MAX_ITEMS, friendlyDateRange, type FeedAction, type FeedItem, type FeedPage, type FeedQuery } from "@gcpe/calendar-contract";
import { ApiError } from "../../../api/client";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { minIdOf } from "../activity/form";
import { listApi } from "../list/api";
import { TitleLink } from "../list/cells";
import { addDaysTo, dateTimeText, todayIn } from "../list/dates";
import { feedApi } from "./api";
import { feedQueryOf, paramsOf } from "./url";

/** Legacy's wording for each kind of update (Activity.aspx.cs:1051-1567). */
const VERB: Record<FeedAction, string> = {
  created: "added activity", updated: "changed activity", reviewed: "reviewed activity", deleted: "deleted activity", cloned: "added new clone",
};
const PAST: Record<FeedAction, string> = { created: "added", updated: "changed", reviewed: "reviewed", deleted: "deleted", cloned: "cloned" };
/** History.aspx's Update type list, in its order. */
const TYPE_OPTIONS: { value: FeedAction | ""; label: string }[] = [
  { value: "", label: "All" }, { value: "updated", label: "Changed" }, { value: "created", label: "Added" },
  { value: "deleted", label: "Deleted" }, { value: "reviewed", label: "Reviewed" }, { value: "cloned", label: "Cloned" },
];

interface FormState {
  from: string;
  to: string;
  type: FeedAction | "";
  keyword: string;
}
const formOf = (q: FeedQuery | null): FormState =>
  q?.mode === "range" ? { from: q.from ?? "", to: q.to ?? "", type: q.type ?? "", keyword: q.keyword ?? "" } : { from: "", to: "", type: "", keyword: "" };

/** The result's heading, as legacy's ("Today's updates:", "Activities changed from … to …", "Updates for Activity …"). */
export function headingOf(q: FeedQuery, page: FeedPage | null): string {
  if (page?.mode === "activity" && page.activityId !== null) {
    const first = page.items[0];
    return `Updates for ${first ? minIdOf({ id: page.activityId, ministryAbbreviation: first.ministryAbbreviation }) : `activity ${page.activityId}`}`;
  }
  switch (q.mode) {
    case "latest":
      return "Latest 5 updates";
    case "today":
      return "Today's updates";
    case "activity":
      return `Updates for activity ${q.activity}`;
    case "range": {
      let text = `Activities ${q.type ? PAST[q.type] : "updated"}`;
      if (q.from) text += ` from ${q.from}`;
      if (q.to) text += ` to ${q.to}`;
      if (q.keyword) text += ` matching "${q.keyword}"`;
      return text;
    }
  }
}

function FeedEntry({ item, timeZone, today }: { item: FeedItem; timeZone: string; today: string }): React.JSX.Element {
  return (
    <li>
      <time dateTime={item.at}>{dateTimeText(item.at, timeZone)}</time>
      {` — ${item.actorName} ${VERB[item.action]} `}
      <TitleLink id={item.activityId}>{minIdOf({ id: item.activityId, ministryAbbreviation: item.ministryAbbreviation })}</TitleLink>
      {item.isDeleted ? " (deleted): " : ": "}
      <span title={item.details || undefined}>{item.title}</span>
      {` (${friendlyDateRange(item, { timeZone, today })})`}
    </li>
  );
}

/** Calendar → Updates (History.aspx; spec addendum §9.1): recent changes to the activities this user can see. */
export function UpdatesScreen(): React.JSX.Element {
  useDocumentTitle("Updates");
  const [params, setParams] = useSearchParams();
  const search = params.toString();
  const parsed = feedQueryOf(params);
  const query = "query" in parsed ? parsed.query : null;
  const [startedOnRange] = useState(query?.mode === "range");
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const [loaded, setLoaded] = useState<{ search: string; page?: FeedPage; failure?: "not_found" | "error" } | null>(null);
  const [form, setForm] = useState<FormState>(() => formOf(query));
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listApi.config().then(
      (c) => {
        if (!live) return;
        setTimeZone(c.timeZone);
        // Legacy's From starts at yesterday (History.aspx), unless the address already holds a range.
        if (!startedOnRange) setForm((f) => (f.from ? f : { ...f, from: addDaysTo(todayIn(c.timeZone), -1) }));
      },
      () => {
        if (live) setConfigFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [startedOnRange]);

  useEffect(() => {
    const p = feedQueryOf(new URLSearchParams(search));
    if (!("query" in p)) return;
    if (p.query.mode === "range") setForm(formOf(p.query));
    let live = true;
    feedApi.read(p.query).then(
      (page) => {
        if (live) setLoaded({ search, page });
      },
      (e: unknown) => {
        if (live) setLoaded({ search, failure: e instanceof ApiError && e.status === 404 ? "not_found" : "error" });
      },
    );
    return () => {
      live = false;
    };
  }, [search]);

  const current = loaded?.search === search ? loaded : null;
  const page = current?.page ?? null;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (form.from && form.to && form.from > form.to) return setFormError("From must be on or before To.");
    setFormError(null);
    setParams(paramsOf({ mode: "range", from: form.from || undefined, to: form.to || undefined, type: form.type || undefined, keyword: form.keyword.trim() || undefined }));
  };

  return (
    <div className="gcpe-updates-page">
      <h1>Updates</h1>
      <nav aria-label="Updates views" className="gcpe-updates-views">
        <ul>
          <li>
            <Link to="/calendar/updates?mode=latest" aria-current={query?.mode === "latest" ? "page" : undefined}>
              Latest 5 updates
            </Link>
          </li>
          <li>
            <Link to="/calendar/updates" aria-current={query?.mode === "today" ? "page" : undefined}>
              Today&apos;s updates
            </Link>
          </li>
        </ul>
      </nav>
      <form aria-label="Filter updates" onSubmit={submit} noValidate>
        <div className="gcpe-field-row">
          <div className="gcpe-field">
            <label htmlFor="updates-from">From</label>
            <input id="updates-from" type="date" value={form.from} onChange={(e) => set("from", e.target.value)} />
          </div>
          <div className="gcpe-field">
            <label htmlFor="updates-to">To</label>
            <input id="updates-to" type="date" value={form.to} onChange={(e) => set("to", e.target.value)} />
          </div>
          <div className="gcpe-field">
            <label htmlFor="updates-type">Update type</label>
            <select id="updates-type" value={form.type} onChange={(e) => set("type", e.target.value as FeedAction | "")}>
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="gcpe-field">
            <label htmlFor="updates-keyword">Search for</label>
            <input
              id="updates-keyword"
              type="search"
              maxLength={FEED_KEYWORD_MAX}
              value={form.keyword}
              aria-describedby="updates-keyword-hint"
              onChange={(e) => set("keyword", e.target.value)}
            />
          </div>
          <Button type="submit">Search</Button>
        </div>
        <p id="updates-keyword-hint" className="gcpe-hint">
          Words in the title or summary, or the name of who made the change. An activity number above 10,000 (such as HLTH-20001) shows that activity&apos;s updates.
        </p>
        {formError && <p role="alert">{formError}</p>}
      </form>
      <section aria-labelledby="updates-result">
        <h2 id="updates-result">{query ? headingOf(query, page) : "These updates can't be shown"}</h2>
        {"problem" in parsed && <InlineAlert variant="danger" role="alert" description={parsed.problem} />}
        {(configFailed || current?.failure === "error") && <InlineAlert variant="danger" role="alert" description="Couldn't load the updates." />}
        {current?.failure === "not_found" && <p>{"Activity not found: it doesn't exist, or you can't see it."}</p>}
        {query && !configFailed && !current?.failure && !(page && timeZone) && <p>Loading…</p>}
        {page && timeZone && !configFailed && (
          <>
            <p role="status">{`Total ${page.items.length} ${page.items.length === 1 ? "item" : "items"}`}</p>
            {page.truncated && <p>{`Showing the newest ${FEED_MAX_ITEMS.toLocaleString("en-CA")}. Narrow the dates or the search to see older updates.`}</p>}
            {page.items.length === 0 ? (
              <p>No updates.</p>
            ) : (
              <ol className="gcpe-changes gcpe-updates">
                {page.items.map((i) => (
                  <FeedEntry key={i.id} item={i} timeZone={timeZone} today={todayIn(timeZone)} />
                ))}
              </ol>
            )}
          </>
        )}
      </section>
    </div>
  );
}
