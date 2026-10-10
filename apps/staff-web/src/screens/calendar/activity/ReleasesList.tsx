import { Link } from "react-router";
import { TYPE_LABEL, type ReleaseType } from "@gcpe/nrms-contract";
import type { ReleaseLinkView } from "@gcpe/calendar-contract";
import { timeText } from "../list/dates";

const STATUS: Record<string, string> = {
  draft: "Draft", approved: "Approved", scheduled: "Scheduled", publishing: "Publishing", published: "Published", unpublishing: "Unpublishing", failed: "Failed",
};
const when = (iso: string, timeZone: string) => `${new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso))} ${timeText(iso, timeZone)}`;

/** "BC Gov News" (spec addendum §8.2, §11): the releases linked to this activity. The link is for NRMS users; NRMS guards the release itself. */
export function ReleasesList({ releases, timeZone, canOpen }: { releases: readonly ReleaseLinkView[]; timeZone: string; canOpen: boolean }): React.JSX.Element {
  return (
    <section aria-labelledby="bc-gov-news" className="gcpe-release-links">
      <h3 id="bc-gov-news">BC Gov News</h3>
      {releases.length === 0 ? (
        <p>No releases are linked to this activity.</p>
      ) : (
        <ul>
          {releases.map((r) => {
            const at = r.releasedAt ?? r.publishAt;
            const label = `${TYPE_LABEL[r.type as ReleaseType] ?? r.type}${r.reference ? ` ${r.reference}` : ""}: ${STATUS[r.status] ?? r.status}${at ? `, ${when(at, timeZone)}` : ""}`;
            return (
              <li key={r.releaseId}>
                <span className={`gcpe-release-swatch gcpe-release-swatch--${r.type}`} aria-hidden="true" />
                {canOpen ? <Link to={`/releases/${r.releaseId}`}>{label}</Link> : label}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
