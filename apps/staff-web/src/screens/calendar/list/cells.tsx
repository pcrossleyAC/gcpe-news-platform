import { friendlyDateRange, friendlySpan, type ListColumn, type ListRow, type NeedsReviewKey } from "@gcpe/calendar-contract";

/** Which needs-review flags mark which column (ActivityListProvider.ashx.cs's ApplyMarkup calls). */
const FLAGS: Partial<Record<ListColumn, NeedsReviewKey[]>> = {
  keywords: ["tags"], status: ["active"], dateTime: ["start_date", "end_date"], title: ["title", "details"], categories: ["categories"],
  commMaterials: ["comm_materials"], premier: ["premier_requested"], leadOrg: ["lead_organization"], translations: ["translations_required"],
  city: ["city", "venue"], governmentRep: ["representative"],
};
export const needsReviewOf = (c: ListColumn, r: ListRow) => (FLAGS[c] ?? []).some((k) => r.needsReview.includes(k));
/** The list's "MIN-Id". */
export const minId = (r: Pick<ListRow, "id" | "ministryAbbreviation">) => `${r.ministryAbbreviation ?? "—"}-${r.id}`;

const STATUS = { new: "New", changed: "Changed", reviewed: "Reviewed" } as const;
const shortDate = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));

export interface TableTools {
  /** Rows ticked for Review selected, by id. */
  selected?: Map<number, { version: number; label: string }>;
  onSelect?: (row: ListRow, on: boolean) => void;
  renderStar?: (row: ListRow, update: (patch: Partial<ListRow>) => void) => React.ReactNode;
}

export function CellContent({ column, row: r, today, timeZone, tools, update }: { column: ListColumn; row: ListRow; today: string; timeZone: string; tools?: TableTools; update: (patch: Partial<ListRow>) => void }): React.JSX.Element {
  switch (column) {
    case "activity": {
      // Legacy's eye icon: reviewed and live, or a deletion already reviewed.
      const reviewed = r.isDeleted ? !r.needsReview.includes("active") : r.status === "reviewed";
      return (
        <div className="gcpe-activity-cell">
          {tools?.onSelect && (
            <input type="checkbox" aria-label={`Select ${minId(r)}`} checked={tools.selected?.has(r.id) ?? false} onChange={(e) => tools.onSelect!(r, e.target.checked)} />
          )}
          {tools?.renderStar?.(r, update)}
          <span>
            {reviewed && <span className="gcpe-badge">Reviewed</span>}
            {r.isShared && <span className="gcpe-badge">Shared</span>}
            {r.hasRelease && <span className="gcpe-badge">Release</span>}
          </span>
          <strong>{minId(r)}</strong>
          <span className="gcpe-hint">{`updated ${friendlySpan(new Date(r.lastUpdatedAt), new Date(), timeZone)} ago${r.lastUpdatedByName ? ` by ${r.lastUpdatedByName}` : ""}`}</span>
          <span className="gcpe-hint">{`created ${shortDate(r.createdAt, timeZone)}`}</span>
        </div>
      );
    }
    case "keywords":
      return <>{r.keywords.join(", ")}</>;
    case "ministry":
      return <>{r.ministryAbbreviation ?? ""}</>;
    case "status":
      return (
        <>
          {r.isDeleted ? "Deleted" : STATUS[r.status]}
          {r.hqStatus && (
            <>
              <br />
              <small>{`LA ${STATUS[r.hqStatus]}`}</small>
            </>
          )}
        </>
      );
    case "dateTime":
      return <span title={r.schedule ? `Considerations: ${r.schedule}` : undefined}>{friendlyDateRange(r, { timeZone, today, weekday: true })}</span>;
    case "title":
      return (
        <div title={r.significance || undefined}>
          <strong className="gcpe-activity-title">{r.title}</strong>
          {r.details && <div>{r.details}</div>}
        </div>
      );
    case "categories":
      return (
        <>
          {[...(r.isIssue ? ["Issue"] : []), ...r.categories].join(", ")}
          {r.isConfidential && (
            <>
              <br />
              <small className="gcpe-not-la">Not for Look Ahead</small>
            </>
          )}
        </>
      );
    case "commMaterials": {
      const hover = [r.nrOrigins.join(", "), r.nrDistribution ?? ""].filter(Boolean).join("\n");
      return <span title={hover || undefined}>{r.commMaterials.join(", ")}</span>;
    }
    case "premier":
      return <>{r.premierRequested ?? ""}</>;
    case "leadOrg":
      return <>{r.leadOrganization}</>;
    case "translations":
      return <>{r.translations.join(", ")}</>;
    case "city":
      return (
        <>
          {r.city ?? ""}
          {r.venue && (
            <>
              <br />
              {r.venue}
            </>
          )}
        </>
      );
    case "commContact":
      return r.commContact ? (
        <>
          {r.commContact.name}
          {r.commContact.phone && (
            <>
              <br />
              {r.commContact.phone}
            </>
          )}
        </>
      ) : (
        <></>
      );
    case "governmentRep":
      return <>{r.governmentRepresentative ?? ""}</>;
  }
}
