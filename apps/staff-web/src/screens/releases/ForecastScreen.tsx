import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import type { ForecastPage } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { ForecastActivityRow } from "./ForecastActivityRow";
import { Pagination } from "./Pagination";
import { ReleaseFolderTabs } from "./ReleaseFolderTabs";
import { ReleaseRow } from "./ReleaseRow";

/**
 * The Forecast tab (spec addendum §11): releases planned or scheduled from now on, and the Calendar
 * activities a release may be planned for, by time (`GET /nrms/api/forecast?page=`). No type filter,
 * as legacy hid it on Forecast.
 */
export function ForecastScreen(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const session = useSession();
  const timeZone = useTenantTimeZone();
  useDocumentTitle("Forecast");
  const [result, setResult] = useState<ForecastPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const page = Number(searchParams.get("page") ?? "1") || 1;

  useEffect(() => {
    let active = true;
    apiFetch<ForecastPage>(`/nrms/api/forecast?page=${page}`).then(
      (data) => {
        if (!active) return;
        setResult(data);
        setError(null);
      },
      (e: unknown) => {
        if (!active) return;
        // A 403 (no NRMS role) or 404 carries the server's own explanation; anything else
        // (a 500, a network failure) gets the generic message instead.
        setError(e instanceof ApiError && (e.status === 403 || e.status === 404) ? e.message : "Couldn't load the Forecast.");
      },
    );
    return () => {
      active = false;
    };
  }, [page]);

  const onPageChange = (next: number) => {
    const params = new URLSearchParams(searchParams);
    params.set("page", String(next));
    setSearchParams(params);
  };

  const now = new Date();
  const canStartRelease = session.has("NRMS.Editor");

  return (
    <div className="gcpe-release-list">
      <ReleaseFolderTabs />
      <h1>Forecast</h1>

      {result && !result.calendarActivities && <p>Calendar activities are listed here for people with Calendar access. Ask a Calendar administrator if you need it.</p>}
      {error && <p role="alert">{error}</p>}
      {!error && result && result.items.length === 0 && <p>Nothing is planned from now on.</p>}

      {!error && result && result.items.length > 0 && (
        <ul className="gcpe-release-list__rows">
          {result.items.map((i) =>
            i.kind === "release" ? (
              <ReleaseRow key={i.release.id} item={i.release} now={now} timeZone={timeZone} />
            ) : (
              <ForecastActivityRow key={`activity-${i.activity.activityId}`} activity={i.activity} at={i.at} now={now} timeZone={timeZone} canStartRelease={canStartRelease} />
            ),
          )}
        </ul>
      )}

      {!error && result && <Pagination page={result.page} pageSize={result.pageSize} total={result.total} onPageChange={onPageChange} />}
    </div>
  );
}
