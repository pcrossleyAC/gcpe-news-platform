/**
 * The release's Lead ministry, shown once more than one ministry is ticked (Categories, and New
 * release). Approving needs a lead then (approveProblems), except on an advisory, so the label says
 * so and the empty choice only prompts: it can't be picked (forms-b #23). An advisory, which needs
 * no lead, keeps "(none)". A read-only view has no marker.
 */
export function LeadMinistrySelect({
  id,
  value,
  ministries,
  needed,
  readOnly = false,
  onChange,
}: {
  id?: string;
  value: string | null;
  /** The ticked ministries, in order, with their names. */
  ministries: { key: string; name: string }[];
  /** The release's type needs a lead to approve. */
  needed: boolean;
  readOnly?: boolean;
  onChange(key: string | null): void;
}): React.JSX.Element {
  const marked = needed && !readOnly;
  return (
    <label className="gcpe-field">
      {marked ? "Lead ministry (needed before approving)" : "Lead ministry"}
      <select id={id} value={value ?? ""} disabled={readOnly} onChange={(e) => onChange(e.target.value || null)}>
        {needed ? (
          <option value="" disabled>
            Choose the lead ministry
          </option>
        ) : (
          <option value="">(none)</option>
        )}
        {ministries.map((m) => (
          <option key={m.key} value={m.key}>
            {m.name}
          </option>
        ))}
      </select>
    </label>
  );
}
