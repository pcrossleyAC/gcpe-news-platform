import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { DEFAULT_LIST_QUERY, listQuerySchema, type ListDisplay, type ListOptions, type ListPreferences, type ListQuery, type ListRow } from "@gcpe/calendar-contract";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { useSession } from "../../../session/SessionContext";
import { canManageCalendarAccess } from "../../admin/calendar-access/calendar-roles";
import { activityPath } from "../activity/paths";
import { useCalendarContext } from "../CalendarSection";
import { ActivityTable } from "./ActivityTable";
import { listApi } from "./api";
import { minId, type TableTools } from "./cells";
import { ColumnChooser } from "./ColumnChooser";
import { CalendarGrid, ViewSwitch } from "./CalendarGrid";
import { isValidBcDate, todayIn } from "./dates";
import { FilterPanel } from "./FilterPanel";
import { ClearLaStatus, CorporateBanner, CorporateQueries, ExportButton, LookAheadFilterChoice, ReviewSelected } from "./HqTools";
import { MyQueries } from "./MyQueries";
import { ReportButtons } from "./Reports";
import type { CalendarConfigView, ListView } from "./types";
import { ToolMessageSlot } from "./ToolMessages";
import { WatchStar } from "./WatchStar";

/** The list query, from `?q=`. Anything that no longer parses gives way to the defaults. */
export function queryFromParams(params: URLSearchParams): ListQuery | null {
  const raw = params.get("q");
  if (!raw) return null;
  try {
    const parsed = listQuerySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A shared link can carry parts of a query this viewer can't use; the server refuses those with 403,
 * so they're dropped before anything is asked of it, and Search and My Queries never resend them. */
export function usableQuery(query: ListQuery, list: CalendarConfigView["list"]): ListQuery {
  const lookAhead = list.lookAheadFilter ? query.lookAhead : "all";
  const corporate = list.corporateQueries ? query.corporate : null;
  return lookAhead === query.lookAhead && corporate === query.corporate ? query : { ...query, lookAhead, corporate };
}

/**
 * Legacy's standing note (UCFlexiGrid.ascx:124): a warning alert while the freeze applies to this
 * user (spec addendum §7.4); the rest of the day, one quiet line, since it is up all day and only
 * says when the freeze is.
 */
function FreezeNotice({ freeze }: { freeze: CalendarConfigView["freeze"] }) {
  if (freeze.start === freeze.end) return null;
  return freeze.appliesToYou ? (
    <InlineAlert variant="warning" title="Change freeze" description={freeze.message} />
  ) : (
    <p className="gcpe-freeze-line">
      <svg className="gcpe-freeze-line__icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 7v4.5M8 4.5v.01" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
      <span>
        <strong>Daily change freeze.</strong> <span>{freeze.message}</span>
      </span>
    </p>
  );
}

type ListTool = "columns" | "export" | "la";

/**
 * The list's secondary tools, each behind a disclosure on one quiet line beside the Look Ahead
 * filter, so the list's own actions lead. One panel shows at a time, under the line. Closed panels
 * stay mounted (only hidden), so a report still being prepared or a result message is kept.
 */
function ListTools({ lookAhead, panels }: { lookAhead: React.ReactNode; panels: { id: ListTool; label: string; content: React.ReactNode }[] }): React.JSX.Element {
  const [open, setOpen] = useState<ListTool | null>(null);
  // The panels' status and error lines render here, outside the panels, so closing a panel never
  // hides or silences a result still to come (ToolMessages).
  const [messages, setMessages] = useState<HTMLElement | null>(null);
  return (
    <ToolMessageSlot.Provider value={messages}>
      <div className="gcpe-calendar-viewbar">
        {lookAhead}
        <div className="gcpe-list-tools">
          {panels.map((p) => (
            <button
              key={p.id}
              type="button"
              id={`list-tool-${p.id}-toggle`}
              className="gcpe-disclosure-toggle"
              aria-expanded={open === p.id}
              aria-controls={`list-tool-${p.id}`}
              onClick={() => setOpen((o) => (o === p.id ? null : p.id))}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {panels.map((p) => (
        <div key={p.id} id={`list-tool-${p.id}`} role="group" aria-labelledby={`list-tool-${p.id}-toggle`} className="gcpe-list-tool-panel" hidden={open !== p.id}>
          {p.content}
        </div>
      ))}
      <div ref={setMessages} className="gcpe-list-tool-messages" />
    </ToolMessageSlot.Provider>
  );
}

/**
 * My Queries and Corporate Queries behind one disclosure, closed at first: the list comes first.
 * Closed, it names the view the list is running (a saved query, or a corporate query), if any.
 */
function SavedViews({ running, children }: { running: string | null; children: React.ReactNode }) {
  return (
    <details className="gcpe-disclosure gcpe-calendar-filters gcpe-saved-views">
      <summary>
        <span>Saved views</span>
        <span className="gcpe-calendar-filters__summary">{running ?? "None running"}</span>
      </summary>
      <div className="gcpe-saved-views__body">{children}</div>
    </details>
  );
}

/** `/hub/calendar` (spec addendum §8.1): the activity list. */
export function ActivityListScreen(): React.JSX.Element {
  useDocumentTitle("Corporate Calendar");
  const here = useLocation();
  const arrival = here.state as { calendarNotice?: string; calendarActivityId?: number } | null;
  const notice = arrival?.calendarNotice ?? null;
  const returnedFrom = typeof arrival?.calendarActivityId === "number" ? arrival.calendarActivityId : null;
  const me = useCalendarContext();
  const session = useSession();
  const canManage = canManageCalendarAccess(session);
  const [params, setParams] = useSearchParams();
  const [config, setConfig] = useState<CalendarConfigView | null>(null);
  const [options, setOptions] = useState<ListOptions | null>(null);
  const [prefs, setPrefs] = useState<ListPreferences | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [runningQuery, setRunningQuery] = useState<string | null>(null);
  /** The Filters panel holds changes not yet applied, so My Queries won't save the old filter as if it were them. */
  const [filterUnapplied, setFilterUnapplied] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    const call = ++latest.current;
    Promise.all([listApi.config(), listApi.options(), listApi.preferences()]).then(
      ([c, o, p]) => {
        if (call !== latest.current) return;
        setConfig(c);
        setOptions(o);
        setPrefs(p);
      },
      () => call === latest.current && setLoadError("Couldn't load the Calendar list."),
    );
  }, []);

  const fromUrl = useMemo(() => queryFromParams(params), [params]);
  const query = useMemo<ListQuery | null>(() => {
    const q = fromUrl ?? (prefs ? { ...DEFAULT_LIST_QUERY, display: prefs.display } : null);
    return q && config ? usableQuery(q, config.list) : q;
  }, [fromUrl, prefs, config]);
  const setQuery = (next: ListQuery) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set("q", JSON.stringify(next));
      return n;
    });
  // Only the latest save's answer is shown: an older one arriving late would undo a newer choice.
  const latestSave = useRef(0);
  const savePrefs = async (next: ListPreferences) => {
    const call = ++latestSave.current;
    setPrefs(next);
    setPrefsError(null);
    try {
      const saved = await listApi.savePreferences(next);
      if (call === latestSave.current) setPrefs(saved);
    } catch {
      if (call === latestSave.current) setPrefsError("Couldn't save your list settings.");
    }
  };
  // A search's new display is saved once the URL carries the search: saving it first would list
  // the default query with the new display for a moment, a needless fetch and a reset filter panel.
  const displayToSave = useRef<ListDisplay | null>(null);
  useEffect(() => {
    const display = displayToSave.current;
    if (!display || !prefs || fromUrl?.display !== display) return;
    displayToSave.current = null;
    if (display !== prefs.display) void savePrefs({ ...prefs, display });
  }, [fromUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const [selected, setSelected] = useState<Map<number, { version: number; label: string }>>(new Map());
  const queryKey = JSON.stringify(query);
  useEffect(() => setSelected(new Map()), [queryKey, reloadToken]);
  const reload = () => setReloadToken((n) => n + 1);

  const viewParam = params.get("view");
  const view: ListView = viewParam === "month" || viewParam === "week" ? viewParam : "list";
  const setParam = (name: string, value: string | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (value === null) n.delete(name);
      else n.set(name, value);
      return n;
    });

  if (loadError) {
    return (
      <div>
        <h1>Corporate Calendar</h1>
        <InlineAlert variant="danger" role="alert" description={loadError} />
      </div>
    );
  }
  if (!config || !options || !prefs || !query) {
    return (
      <div>
        <h1>Corporate Calendar</h1>
        <p>Loading…</p>
      </div>
    );
  }
  const tools: TableTools = {
    renderStar: (r, update) => <WatchStar id={r.id} label={minId(r)} watch={{ isWatched: r.isWatched, watcherNames: r.watcherNames }} myName={me.displayName} onChange={update} />,
    ...(config.list.reviewSelected
      ? {
          selected,
          onSelect: (r: ListRow, on: boolean) =>
            setSelected((s) => {
              const n = new Map(s);
              if (on) n.set(r.id, { version: r.version, label: minId(r) });
              else n.delete(r.id);
              return n;
            }),
        }
      : {}),
  };
  return (
    <div className="gcpe-calendar-list">
      <h1>Corporate Calendar</h1>
      {me.ministryKeys.length === 0 && !me.isHq && (
        // Owner decision 2026-10-29: say why the list is empty rather than leave a dead end.
        <p className="gcpe-notice">
          You aren&rsquo;t in any ministry yet, so there are no activities to show you.{" "}
          {/* Only a Core admin may change their own Calendar access: anyone else would find their own row locked. */}
          {session.has("Core.Admin") ? (
            <>
              Ministries are given in <Link to="/calendar-access">Calendar access</Link>.
            </>
          ) : canManage ? (
            "Ask another Calendar administrator or a Core administrator to add your ministry."
          ) : (
            "Ask a Calendar administrator."
          )}
        </p>
      )}
      {notice && (
        <p role="status" className="gcpe-notice">
          {notice}
        </p>
      )}
      <FreezeNotice freeze={config.freeze} />
      <FilterPanel
        query={query}
        options={options}
        onSearch={(q) => {
          if (q.display !== prefs.display) displayToSave.current = q.display;
          setQuery(q);
        }}
        onUnapplied={setFilterUnapplied}
      />
      <SavedViews running={query.corporate ? "Running a corporate query" : runningQuery && `Running “${runningQuery}”`}>
        <MyQueries current={query.filter} unapplied={filterUnapplied} onRun={(filter) => setQuery({ ...query, corporate: null, filter })} onRunning={setRunningQuery} />
        {config.list.corporateQueries && <CorporateQueries active={query.corporate} onRun={(corporate) => setQuery({ ...query, corporate })} />}
      </SavedViews>
      {query.corporate && <CorporateBanner active={query.corporate} onClear={() => setQuery({ ...query, corporate: null })} />}
      <div className="gcpe-calendar-toolbar">
        <section aria-label="List actions" className="gcpe-actions">
          {config.editor.create && !config.freeze.appliesToYou && (
            <Link className="gcpe-button-link gcpe-button-link--primary" to={activityPath("new", `${here.pathname}${here.search}`)}>
              New activity
            </Link>
          )}
          {config.list.reviewSelected && <ReviewSelected selected={selected} onDone={reload} />}
        </section>
        <ViewSwitch view={view} onChange={(v) => setParam("view", v === "list" ? null : v)} />
      </div>
      <ListTools
        lookAhead={config.list.lookAheadFilter && <LookAheadFilterChoice value={query.lookAhead} onChange={(lookAhead) => setQuery({ ...query, lookAhead })} />}
        panels={[
          { id: "columns", label: "Columns", content: <ColumnChooser hidden={prefs.hiddenColumns} onChange={(hiddenColumns) => void savePrefs({ ...prefs, hiddenColumns })} /> },
          {
            id: "export",
            label: "Export and reports",
            content: (
              <>
                <ExportButton query={query} />
                <ReportButtons query={query} execLookAhead={config.list.execLookAhead} />
              </>
            ),
          },
          ...(config.list.clearLaStatus ? [{ id: "la" as const, label: "LA status", content: <ClearLaStatus onDone={reload} /> }] : []),
        ]}
      />
      {prefsError && <p role="alert">{prefsError}</p>}
      {view === "list" ? (
        <ActivityTable query={query} hidden={prefs.hiddenColumns} timeZone={config.timeZone} reloadToken={reloadToken} onSort={(sort, dir) => setQuery({ ...query, sort, dir })} tools={tools} returnedFrom={returnedFrom} />
      ) : (
        <CalendarGrid
          query={query}
          view={view}
          anchor={isValidBcDate(params.get("on") ?? "") ? params.get("on")! : todayIn(config.timeZone)}
          timeZone={config.timeZone}
          onAnchor={(d) => setParam("on", d)}
        />
      )}
    </div>
  );
}
