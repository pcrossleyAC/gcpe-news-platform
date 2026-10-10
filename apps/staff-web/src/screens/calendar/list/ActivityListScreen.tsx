import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { DEFAULT_LIST_QUERY, listQuerySchema, type ListDisplay, type ListOptions, type ListPreferences, type ListQuery, type ListRow } from "@gcpe/calendar-contract";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { activityPath } from "../activity/paths";
import { useCalendarContext } from "../CalendarSection";
import { ActivityTable } from "./ActivityTable";
import { listApi } from "./api";
import { minId, type TableTools } from "./cells";
import { ColumnChooser } from "./ColumnChooser";
import { CalendarGrid, ViewSwitch } from "./CalendarGrid";
import { isValidBcDate, todayIn } from "./dates";
import { FilterPanel } from "./FilterPanel";
import { ClearLaStatus, CorporateQueries, ExportButton, LookAheadFilterChoice, ReviewSelected } from "./HqTools";
import { MyQueries } from "./MyQueries";
import type { CalendarConfigView, ListView } from "./types";
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

/** Legacy's standing note (UCFlexiGrid.ascx:124), and an alert while the freeze applies to this user (spec addendum §7.4). */
function FreezeNotice({ freeze }: { freeze: CalendarConfigView["freeze"] }) {
  if (freeze.start === freeze.end) return null;
  return freeze.appliesToYou ? <InlineAlert variant="warning" title="Change freeze" description={freeze.message} /> : <p className="gcpe-hint">{freeze.message}</p>;
}

/** `/hub/calendar` (spec addendum §8.1): the activity list. */
export function ActivityListScreen(): React.JSX.Element {
  useDocumentTitle("Corporate Calendar");
  const here = useLocation();
  const notice = (here.state as { calendarNotice?: string } | null)?.calendarNotice ?? null;
  const me = useCalendarContext();
  const [params, setParams] = useSearchParams();
  const [config, setConfig] = useState<CalendarConfigView | null>(null);
  const [options, setOptions] = useState<ListOptions | null>(null);
  const [prefs, setPrefs] = useState<ListPreferences | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
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
      />
      <MyQueries current={query.filter} onRun={(filter) => setQuery({ ...query, corporate: null, filter })} />
      {config.list.corporateQueries && (
        <CorporateQueries active={query.corporate} onRun={(corporate) => setQuery({ ...query, corporate })} onClear={() => setQuery({ ...query, corporate: null })} />
      )}
      {config.list.lookAheadFilter && <LookAheadFilterChoice value={query.lookAhead} onChange={(lookAhead) => setQuery({ ...query, lookAhead })} />}
      <ColumnChooser hidden={prefs.hiddenColumns} onChange={(hiddenColumns) => void savePrefs({ ...prefs, hiddenColumns })} />
      {prefsError && <p role="alert">{prefsError}</p>}
      {view === "list" ? (
        <ActivityTable query={query} hidden={prefs.hiddenColumns} timeZone={config.timeZone} reloadToken={reloadToken} onSort={(sort, dir) => setQuery({ ...query, sort, dir })} tools={tools} />
      ) : (
        <CalendarGrid
          query={query}
          view={view}
          anchor={isValidBcDate(params.get("on") ?? "") ? params.get("on")! : todayIn(config.timeZone)}
          timeZone={config.timeZone}
          onAnchor={(d) => setParam("on", d)}
        />
      )}
      <section aria-label="List actions" className="gcpe-actions">
        {config.editor.create && !config.freeze.appliesToYou && (
          <Link className="gcpe-button-link" to={activityPath("new", `${here.pathname}${here.search}`)}>
            New activity
          </Link>
        )}
        {config.list.reviewSelected && <ReviewSelected selected={selected} onDone={reload} />}
        {config.list.clearLaStatus && <ClearLaStatus onDone={reload} />}
        <ExportButton query={query} />
      </section>
      <ViewSwitch view={view} onChange={(v) => setParam("view", v === "list" ? null : v)} />
    </div>
  );
}
