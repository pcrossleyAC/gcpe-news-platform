import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { DEFAULT_LIST_QUERY, listQuerySchema, type ListDisplay, type ListOptions, type ListPreferences, type ListQuery, type ListRow } from "@gcpe/calendar-contract";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
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

/** Legacy's standing note (UCFlexiGrid.ascx:124), and an alert while the freeze applies to this user (spec addendum §7.4). */
function FreezeNotice({ freeze }: { freeze: CalendarConfigView["freeze"] }) {
  if (freeze.start === freeze.end) return null;
  return freeze.appliesToYou ? <InlineAlert variant="warning" title="Change freeze" description={freeze.message} /> : <p className="gcpe-hint">{freeze.message}</p>;
}

/** `/hub/calendar` (spec addendum §8.1): the activity list. */
export function ActivityListScreen(): React.JSX.Element {
  useDocumentTitle("Corporate Calendar");
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
  const query = useMemo<ListQuery | null>(() => fromUrl ?? (prefs ? { ...DEFAULT_LIST_QUERY, display: prefs.display } : null), [fromUrl, prefs]);
  const setQuery = (next: ListQuery) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set("q", JSON.stringify(next));
      return n;
    });
  const savePrefs = async (next: ListPreferences) => {
    setPrefs(next);
    setPrefsError(null);
    try {
      setPrefs(await listApi.savePreferences(next));
    } catch {
      setPrefsError("Couldn't save your list settings.");
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
    renderStar: (r, update) => <WatchStar row={r} myName={me.displayName} update={update} />,
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
        {config.list.reviewSelected && <ReviewSelected selected={selected} onDone={reload} />}
        {config.list.clearLaStatus && <ClearLaStatus onDone={reload} />}
        <ExportButton query={query} />
      </section>
      <ViewSwitch view={view} onChange={(v) => setParam("view", v === "list" ? null : v)} />
    </div>
  );
}
