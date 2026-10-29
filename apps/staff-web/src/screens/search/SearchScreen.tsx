import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button, Form, TextField } from "@bcgov/design-system-react-components";
import type { ReleaseListItem, ReleasePage } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../api/client";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { ReleaseRow } from "../releases/ReleaseRow";
import { Pagination } from "../releases/Pagination";

/** `GET /nrms/api/categories`'s shape, trimmed to what this screen needs (ministries/sectors)
 * — defined locally rather than imported from apps/nrms, which is Node-only. */
interface Categories {
  ministries: { key: string; name: string }[];
  sectors: { key: string; name: string }[];
}

interface GotoHit {
  id: string;
}

/** `/hub/search?q=&ministry=&sector=&page=` (spec §2): one search box that tries `GET
 * /nrms/api/goto` first on submit — a hit navigates straight to the release — and otherwise
 * falls back to `GET /nrms/api/search`, with ministry/sector filters combined with AND. */
export function SearchScreen(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const timeZone = useTenantTimeZone();
  useDocumentTitle("Search");

  const q = searchParams.get("q") ?? "";
  const ministry = searchParams.get("ministry") ?? "";
  const sector = searchParams.get("sector") ?? "";
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
    if (q || recent) return;
    let active = true;
    apiFetch<ReleasePage<ReleaseListItem>>("/nrms/api/releases?folder=published&type=all&page=1&pageSize=5").then(
      (data) => active && setRecent(data.items),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    apiFetch<Categories>("/nrms/api/categories").then(setCategories, () => {
      // Filters just won't be offered; the search box itself still works.
    });
  }, []);

  useEffect(() => {
    if (!q) {
      setResult(null);
      return;
    }
    let active = true;
    const params = new URLSearchParams({ q, page: String(page) });
    if (ministry) params.set("ministry", ministry);
    if (sector) params.set("sector", sector);
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
  }, [q, ministry, sector, page]);

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
      const hit = await apiFetch<GotoHit>(`/nrms/api/goto?q=${encodeURIComponent(typed)}`).catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 404) return null;
        throw caught;
      });
      if (hit) {
        navigate(`/releases/${hit.id}`);
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

  const updateFilter = (key: "ministry" | "sector", value: string) => {
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
          <TextField label="Search" name="q" value={qInput} onChange={setQInput} className="bcds-react-aria-TextField gcpe-search__q" />
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
          <Button type="submit">Search</Button>
        </div>
      </Form>

      {!q && (
        <>
          <p className="gcpe-search__hint">Search releases by words in the headline, summary or body; filter by ministry or sector.</p>
          {/* Unfiltered, so not shown once a ministry or sector is chosen. */}
          {!ministry && !sector && recent && recent.length > 0 && (
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
      {!error && q && result && result.items.length === 0 && (
        <div className="gcpe-search__empty">
          <p>{`No releases match “${q}”.`}</p>
          {(ministry || sector) && (
            <p>
              <Link to={`?${new URLSearchParams({ q })}`}>Clear ministry and sector filters</Link>
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
