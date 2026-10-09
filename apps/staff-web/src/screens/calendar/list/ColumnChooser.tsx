import { HIDEABLE_COLUMNS, LIST_COLUMN_LABELS, type HideableColumn } from "@gcpe/calendar-contract";

/** Each user's column choice (spec addendum §8.1). The Activity Id column always shows. */
export function ColumnChooser({ hidden, onChange }: { hidden: readonly HideableColumn[]; onChange: (hidden: HideableColumn[]) => void }): React.JSX.Element {
  return (
    <details className="gcpe-columns">
      <summary>Columns</summary>
      <fieldset>
        <legend>Show these columns</legend>
        {HIDEABLE_COLUMNS.map((c) => (
          <div key={c}>
            <input
              type="checkbox"
              id={`list-col-${c}`}
              checked={!hidden.includes(c)}
              onChange={(e) => onChange(e.target.checked ? hidden.filter((h) => h !== c) : [...hidden, c])}
            />
            <label htmlFor={`list-col-${c}`}>{LIST_COLUMN_LABELS[c]}</label>
          </div>
        ))}
      </fieldset>
    </details>
  );
}
