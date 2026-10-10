import { useEffect, useState } from "react";
import { Link, NavLink, useSearchParams } from "react-router";
import { RELEASE_TYPES, TYPE_LABEL, type ReleaseListItem, type ReleasePage, type ReleaseType } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { ReleaseRow } from "./ReleaseRow";
import { Pagination } from "./Pagination";

export type Folder = "drafts" | "scheduled" | "published";
const FOLDERS: Folder[] = ["drafts", "scheduled", "published"];
const FOLDER_LABEL: Record<Folder, string> = { drafts: "Drafts", scheduled: "Scheduled", published: "Published" };

/** The type filter never offers "Update" — the brief: "Updates appear under All only" (legacy
 * imports stay editable but new Updates can't be created). */
const FILTERABLE_TYPES = RELEASE_TYPES.filter((t): t is Exclude<ReleaseType, "update"> => t !== "update");

const PAGE_SIZE = 25;

export interface ReleaseListScreenProps {
  folder: Folder;
}

/** Drafts / Scheduled / Published (spec §2/§5): tabs, a type filter, paging, and the "New
 * release" button (Editors only) — `GET /nrms/api/releases?folder=&type=&page=&pageSize=25`. */
export function ReleaseListScreen({ folder }: ReleaseListScreenProps): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const session = useSession();
  const timeZone = useTenantTimeZone();
  useDocumentTitle("Releases");
  const [result, setResult] = useState<ReleasePage<ReleaseListItem> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const type = (searchParams.get("type") ?? "all") as "all" | ReleaseType;
  const page = Number(searchParams.get("page") ?? "1") || 1;

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ folder, type, page: String(page), pageSize: String(PAGE_SIZE) });
    apiFetch<ReleasePage<ReleaseListItem>>(`/nrms/api/releases?${query}`).then(
      (data) => {
        if (active) {
          setResult(data);
          setError(null);
        }
      },
      (e: unknown) => {
        if (active) setError(e instanceof ApiError ? e.message : "Couldn't load releases.");
      },
    );
    return () => {
      active = false;
    };
  }, [folder, type, page]);

  // Fix round 1, finding 3: if the page the URL asks for no longer has any items (the result
  // set shrank — someone deleted releases, a filter now matches fewer — but `page` itself is
  // still in the URL), replace it with the last page that actually has something, rather than
  // leaving the screen stuck showing an empty page with a nonsensical "Showing" line. A
  // `replace` (not a push) so going back doesn't land on the same dead page again.
  useEffect(() => {
    if (!result || result.total === 0 || result.items.length > 0) return;
    const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
    if (page > lastPage) {
      const params = new URLSearchParams(searchParams);
      params.set("page", String(lastPage));
      setSearchParams(params, { replace: true });
    }
  }, [result, page]);

  const onTypeChange = (next: string) => {
    const params = new URLSearchParams(searchParams);
    if (next === "all") params.delete("type");
    else params.set("type", next);
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
    <div className="gcpe-release-list">
      <nav aria-label="Release folders" className="gcpe-section-tabs">
        <ul>
          {FOLDERS.map((f) => (
            <li key={f}>
              <NavLink to={`/releases/${f}`}>{FOLDER_LABEL[f]}</NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <h1>Releases</h1>

      <div className="gcpe-release-list__toolbar">
        <label htmlFor="release-type-filter">Type</label>
        <select id="release-type-filter" value={type} onChange={(e) => onTypeChange(e.target.value)}>
          <option value="all">All</option>
          {FILTERABLE_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>

        {session.has("NRMS.Editor") && (
          <Link to="/releases/new" className="gcpe-button-link">
            New release
          </Link>
        )}
      </div>

      {error && <p role="alert">{error}</p>}
      {!error && result && result.items.length === 0 && <p>No releases.</p>}

      {!error && result && result.items.length > 0 && (
        <ul className="gcpe-release-list__rows">
          {result.items.map((item) => (
            <ReleaseRow key={item.id} item={item} now={now} timeZone={timeZone} />
          ))}
        </ul>
      )}

      {!error && result && <Pagination page={result.page} pageSize={result.pageSize} total={result.total} onPageChange={onPageChange} />}
    </div>
  );
}
