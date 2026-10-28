import { ApiError } from "../../../api/client";

export const ABBREVIATION_HINT =
  "Used in release numbers, e.g. 2026HLTH0001. Changing it affects only releases approved from now on.";

/** Core's 409 `{ error: "abbreviation-taken", takenBy }` as the field's message, or null for any other error. */
export function abbreviationTakenMessage(caught: unknown): string | null {
  if (!(caught instanceof ApiError) || caught.status !== 409) return null;
  const body = caught.body as { error?: string; takenBy?: string } | undefined;
  return body?.error === "abbreviation-taken"
    ? `That abbreviation is already used by ${body.takenBy ?? "another ministry"}.`
    : null;
}

/** What Core stores: trimmed and upper-cased. */
export const normalizeAbbreviation = (value: string): string =>
  value.trim().toUpperCase();

/** The Abbreviation field (Core.Admin only) of the Add ministry and edit forms. */
export function AbbreviationField({
  id,
  value,
  onChange,
  error,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}): React.JSX.Element {
  return (
    <div className="gcpe-field gcpe-field--abbr">
      <label htmlFor={id}>Abbreviation</label>
      <p id={`${id}-hint`}>{ABBREVIATION_HINT}</p>
      <input
        id={id}
        type="text"
        autoCapitalize="characters"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error !== undefined}
        aria-describedby={
          error !== undefined ? `${id}-hint ${id}-err` : `${id}-hint`
        }
      />
      {error !== undefined && <p id={`${id}-err`}>{error}</p>}
    </div>
  );
}
