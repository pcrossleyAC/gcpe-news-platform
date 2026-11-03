import { useId } from "react";

/** Legacy's question (Release.aspx), once a release has more than one ministry. */
export const LEAD_QUESTION = "Which of the ministries is the lead ministry?";

/**
 * The release's Lead ministry, shown once more than one ministry is ticked (Categories, and New
 * release): legacy's question with one radio button per ticked ministry (C328). Approving needs a
 * lead then (approveProblems), except on an advisory, so the question says so and nothing is chosen
 * until the user chooses (forms-b #23). An advisory, which needs no lead, also offers "(none)". A
 * read-only view, or a release already past approval, has no marker. `id` goes on the group, which
 * takes focus, so a "choose the lead" problem can move focus to it.
 */
export function LeadMinistrySelect({
  id,
  value,
  ministries,
  needed,
  readOnly = false,
  beforeApproval = true,
  onChange,
}: {
  id?: string;
  value: string | null;
  /** The ticked ministries, in order, with their names. */
  ministries: { key: string; name: string }[];
  /** The release's type needs a lead to approve. */
  needed: boolean;
  readOnly?: boolean;
  /** Still a draft: approving is ahead, so the marker applies. */
  beforeApproval?: boolean;
  onChange(key: string | null): void;
}): React.JSX.Element {
  const name = useId();
  const marked = needed && !readOnly && beforeApproval;
  const choices = [...(needed ? [] : [{ key: null, name: "(none)" }]), ...ministries];
  return (
    <fieldset id={id} tabIndex={-1} className="gcpe-options" disabled={readOnly}>
      <legend>{marked ? `${LEAD_QUESTION} (needed before approving)` : "Lead ministry"}</legend>
      {choices.map((m) => (
        <label key={m.key ?? ""}>
          <input type="radio" name={name} checked={value === m.key} onChange={() => onChange(m.key)} />
          {m.name}
        </label>
      ))}
    </fieldset>
  );
}
