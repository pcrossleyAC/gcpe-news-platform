import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button, Form, TextField } from "@bcgov/design-system-react-components";
import { isRealDay, RELEASE_TYPES, TYPE_LABEL, type ReleaseListItem, type ReleasePage, type ReleaseType } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../api/client";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { useSearchShortcut } from "../../shared/shortcuts";
import { ReleaseRow } from "../releases/ReleaseRow";
import { Pagination } from "../releases/Pagination";
import { gotoReleaseId } from "./findRelease";

/** `GET /nrms/api/categories`'s shape, trimmed to what this screen needs (ministries/sectors)
 * — defined locally rather than imported from apps/nrms, which is Node-only. */
interface Categories {
  ministries: { key: string; name: string }[];
  sectors: { key: string; name: string }[];
}

/** The Type filter offers what the release folders' does (ReleaseListScreen.tsx): never "Update". */
const FILTERABLE_TYPES = RELEASE_TYPES.filter((t): t is Exclude<ReleaseType, "update"> => t !== "update");

/** The URL parameters that narrow a search, in the order they're sent. */
const FILTER_KEYS = ["ministry", "sector", "type", "from", "to"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

const BACKWARDS_RANGE = "The From date is after the To date.";

/** `/hub/search?q=&ministry=&sector=&type=&from=&to=&page=` (spec §2): one search box that tries
 * `GET /nrms/api/goto` first on submit — a hit navigates straight to the release — and otherwise
 * falls back to `GET /nrms/api/search`, with the ministry, sector, type (suite review R9) and
 * From/To release-date filters combined with AND. */
export function SearchScreen(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const timeZone = useTenantTimeZone();
  useDocumentTitle("Search");
  useSearchShortcut("search-q");

  const q = searchParams.get("q") ?? "";
  const ministry = searchParams.get("ministry") ?? "";
  const sector = searchParams.get("sector") ?? "";
  const typeParam = searchParams.get("type") ?? "";
  const type = (FILTERABLE_TYPES as readonly string[]).includes(typeParam) ? typeParam : "";
  // An impossible day in a hand-edited address ("2026-02-30") is no filter, never a failed search.
  const dayParam = (key: "from" | "to") => {
    const v = searchParams.get(key) ?? "";
    return isRealDay(v) ? v : "";
  };
  const from = dayParam("from");
  const to = dayParam("to");
  const backwards = from !== "" && to !== "" && from > to;
  const filters: Record<FilterKey, string> = { ministry, sector, type, from, to };
  const filtered = FILTER_KEYS.some((k) => filters[k] !== "");
  // Words, or any filter on its own (fix round 1: "everything from last week" needs no words).
  const searching = q !== "" || filtered;
  const page = Number(searchParams.get("page") ?? "1") || 1;

  const [qInput, setQInput] = useState(q);
  const [categories, setCategories] = useState<Categories | null>(null);
  const [result, setResult] = useState<ReleasePage<ReleaseListItem> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keeps the box in sync with the URL (e.g. the browser back button), without fighting
  // ordinary typing: it only runs when the URL's own q changes.
  useEffect(() => setQInput(q), [q]);

  // Before any search: the five most recently published releases, under the hint. Nothing at
  // all if they can't be loaded; the hint and the search box still work.
  const [recent, setRecent] = useState<ReleaseListItem[] | null>(null);
  useEffect(() => {
    if (searching || recent) return;
    let active = true;
    apiFetch<ReleasePage<ReleaseListItem>>("/nrms/api/releases?folder=published&type=all&page=1&pageSize=5").then(
      (data) => active && setRecent(data.items),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [searching]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    apiFetch<Categories>("/nrms/api/categories").then(setCategories, () => {
      // Filters just won't be offered; the search box itself still works.
    });
  }, []);

  useEffect(() => {
    if (!searching || backwards) {
      setResult(null);
      return;
    }
    let active = true;
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    params.set("page", String(page));
    for (const k of FILTER_KEYS) if (filters[k]) params.set(k, filters[k]);
    apiFetch<ReleasePage<ReleaseListItem>>(`/nrms/api/search?${params}`).then(
      (data) => {
        if (active) {
          setResult(data);
          setError(null);
        }
      },
      (e: unknown) => {
        if (active) setError(e instanceof ApiError ? e.message : "Search failed.");
      },
    );
    return () => {
      active = false;
    };
  }, [q, ministry, sector, type, from, to, searching, backwards, page]);

  // Fix round 1, finding 3: if `page` no longer has any results (the result set shrank —
  // a filter now matches fewer, or someone deleted releases) but is still in the URL, replace
  // it with the last page that actually has something, rather than leaving the screen stuck on
  // an empty page with a nonsensical "Showing" line. A `replace` (not a push) so going back
  // doesn't land on the same dead page again.
  useEffect(() => {
    if (!result || result.total === 0 || result.items.length > 0) return;
    const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
    if (page > lastPage) {
      const params = new URLSearchParams(searchParams);
      params.set("page", String(lastPage));
      setSearchParams(params, { replace: true });
    }
  }, [result, page]);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const typed = qInput.trim();
    if (!typed) return;
    setError(null);
    try {
      const hit = await gotoReleaseId(typed);
      if (hit) {
        navigate(`/releases/${hit}`);
        return;
      }
      // Merge into the existing params (fix round 1, finding 2) — a bare `setSearchParams({ q
      // })` would drop any ministry/sector filter already selected.
      const params = new URLSearchParams(searchParams);
      params.set("q", typed);
      params.delete("page");
      setSearchParams(params);
    } catch (caught: unknown) {
      setError(caught instanceof ApiError ? caught.message : "Search failed.");
    }
  };

  const updateFilter = (key: FilterKey, value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value) params.set(key, value);
    else params.delete(key);
    params.delete("page");
    setSearchParams(params);
  };

  const onPageChange = (next: number) => {
    const params = new URLSearchParams(searchParams);
    params.set("page", String(next));
    setSearchParams(params);
  };

  const now = new Date();

  return (
    <div className="gcpe-search">
      <h1>Search</h1>

      <Form onSubmit={onSubmit} className="gcpe-search__form">
        <div className="gcpe-search__row">
          <TextField id="search-q" label="Search" name="q" value={qInput} onChange={setQInput} className="bcds-react-aria-TextField gcpe-search__q" />
          <div className="gcpe-field">
            <label htmlFor="search-ministry-filter">Ministry</label>
            <select id="search-ministry-filter" value={ministry} onChange={(e) => updateFilter("ministry", e.target.value)}>
              <option value="">All ministries</option>
              {categories?.ministries.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="gcpe-field">
            <label htmlFor="search-sector-filter">Sector</label>
            <select id="search-sector-filter" value={sector} onChange={(e) => updateFilter("sector", e.target.value)}>
              <option value="">All sectors</option>
              {categories?.sectors.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="gcpe-field">
            <label htmlFor="search-type-filter">Type</label>
            <select id="search-type-filter" value={type} onChange={(e) => updateFilter("type", e.target.value)}>
              <option value="">All types</option>
              {FILTERABLE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="gcpe-field">
            <label htmlFor="search-from-filter">From</label>
            <input id="search-from-filter" type="date" value={from} onChange={(e) => updateFilter("from", e.target.value)} />
          </div>
          <div className="gcpe-field">
            <label htmlFor="search-to-filter">To</label>
            <input id="search-to-filter" type="date" value={to} onChange={(e) => updateFilter("to", e.target.value)} aria-invalid={backwards || undefined} aria-describedby={backwards ? "search-range-error" : undefined} />
          </div>
          <Button type="submit">Search</Button>
        </div>
      </Form>
      {backwards && (
        <p id="search-range-error" role="alert" className="gcpe-field-error">
          {BACKWARDS_RANGE}
        </p>
      )}

      {!searching && (
        <>
          <p className="gcpe-search__hint">Type part of a headline, a reference number or a web address, or choose a ministry, sector, type or dates.</p>
          {recent && recent.length > 0 && (
            <section aria-labelledby="search-recent-heading">
              <h2 id="search-recent-heading" className="gcpe-search__recent-heading">
                Recently published
              </h2>
              <ul className="gcpe-release-list__rows">
                {recent.map((item) => (
                  <ReleaseRow key={item.id} item={item} now={now} timeZone={timeZone} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {error && <p role="alert">{error}</p>}
      {!error && searching && result && result.items.length === 0 && (
        <div className="gcpe-search__empty">
          <p>{q ? `No releases match “${q}”.` : "No releases match these filters."}</p>
          {filtered && (
            <p>
              <Link to={`?${new URLSearchParams(q ? { q } : {})}`}>Clear filters</Link>
            </p>
          )}
        </div>
      )}

      {!error && result && result.items.length > 0 && (
        <ul className="gcpe-release-list__rows">
          {result.items.map((item) => (
            <ReleaseRow key={item.id} item={item} now={now} timeZone={timeZone} />
          ))}
        </ul>
      )}

      {!error && result && result.items.length > 0 && (
        <Pagination page={result.page} pageSize={result.pageSize} total={result.total} onPageChange={onPageChange} />
      )}
    </div>
  );
}
