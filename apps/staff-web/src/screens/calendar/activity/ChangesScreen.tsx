import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import type { ActivityChangeView, ActivityView, ChangeAction } from "@gcpe/calendar-contract";
import { ApiError } from "../../../api/client";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { listApi } from "../list/api";
import { timeText } from "../list/dates";
import { activityApi } from "./api";
import { minIdOf } from "./form";
import { activityPath, safeCalendarReturn } from "./paths";

const ACTIONS: Record<ChangeAction, string> = {
  created: "created it", updated: "changed it", cloned: "created it as a clone", reviewed: "reviewed it", deleted: "deleted it",
  transferred: "transferred it", la_status_cleared: "cleared its LA status",
};
const when = (iso: string, timeZone: string) => `${new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso))} ${timeText(iso, timeZone)}`;

export function ChangesRoute(): React.JSX.Element {
  const { id } = useParams();
  return <ChangesScreen key={id} idParam={id ?? ""} />;
}

/** "View changes" (spec addendum §8.3; C133): the activity's history, newest first, for anyone who can see it. */
export function ChangesScreen({ idParam }: { idParam: string }): React.JSX.Element {
  const [params] = useSearchParams();
  const ret = params.get("return");
  const id = /^\d{1,9}$/.test(idParam) ? Number(idParam) : null;
  const [data, setData] = useState<{ view: ActivityView; changes: ActivityChangeView[]; timeZone: string } | null>(null);
  const [failure, setFailure] = useState<"not_found" | "error" | null>(id === null ? "not_found" : null);
  const heading = data ? `Changes to ${minIdOf(data.view)}` : failure === "not_found" ? "Activity not found" : "Changes";
  useDocumentTitle(heading);

  useEffect(() => {
    if (id === null) return;
    let live = true;
    Promise.all([activityApi.get(id), activityApi.changes(id), listApi.config()]).then(
      ([view, changes, config]) => {
        if (live) setData({ view, changes, timeZone: config.timeZone });
      },
      (e: unknown) => {
        if (live) setFailure(e instanceof ApiError && e.status === 404 ? "not_found" : "error");
      },
    );
    return () => {
      live = false;
    };
  }, [id]);

  const back = failure === "not_found" || id === null ? safeCalendarReturn(ret) : activityPath(id, ret ? safeCalendarReturn(ret) : undefined);
  return (
    <div className="gcpe-changes-page">
      <h1>{heading}</h1>
      <p>
        <Link to={back}>{failure === "not_found" ? "Back to the Calendar" : "Back to the activity"}</Link>
      </p>
      {failure === "not_found" && <p>It doesn&rsquo;t exist, or you can&rsquo;t see it.</p>}
      {failure === "error" && <InlineAlert variant="danger" role="alert" description="Couldn't load the changes." />}
      {!data && !failure && <p>Loading…</p>}
      {data &&
        (data.changes.length === 0 ? (
          <p>No changes are recorded yet.</p>
        ) : (
          <ol className="gcpe-changes">
            {data.changes.map((c) => (
              <li key={c.id}>
                <h2>{`${when(c.at, data.timeZone)}: ${c.actorName} ${ACTIONS[c.action]}`}</h2>
                {c.source === "legacy_log" && <p className="gcpe-badge">from legacy log</p>}
                {c.fields.length > 0 && (
                  <table className="gcpe-calendar-table">
                    <caption className="gcpe-visually-hidden">Fields changed</caption>
                    <thead>
                      <tr>
                        <th scope="col">Field</th>
                        <th scope="col">Before</th>
                        <th scope="col">After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.fields.map((f) => (
                        <tr key={f.key}>
                          <th scope="row">{f.label}</th>
                          <td>{f.old ?? "—"}</td>
                          <td>{f.new ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </li>
            ))}
          </ol>
        ))}
    </div>
  );
}
