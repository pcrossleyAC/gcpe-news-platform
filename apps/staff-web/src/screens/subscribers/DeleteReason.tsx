import { Radio, RadioGroup } from "@bcgov/design-system-react-components";

/** Why staff are deleting (N5 on the record, N2 for Delete selected, owner 2026-10-31). "asked"
 * keeps it as their unsubscribe (a media list re-add then asks first); "other" is the plain
 * cleanup delete. No default, so it's a real choice. */
export type DeleteReason = "asked" | "other";

export const DELETE_REASON_REQUIRED = "Choose why you’re deleting them.";

/** The one copy of the choice, so the record's Delete and Delete selected read the same. */
export function DeleteReasonField({ value, error, onChange }: { value: DeleteReason | null; error: string | null; onChange(v: DeleteReason): void }): React.JSX.Element {
  return (
    <>
      <RadioGroup
        label="Why are you deleting them?"
        value={value ?? ""}
        onChange={(v) => onChange(v === "asked" ? "asked" : "other")}
        isRequired
        isInvalid={error !== null}
        errorMessage={error ?? undefined}
      >
        <Radio value="asked">They asked us to stop sending them email</Radio>
        <Radio value="other">Something else, such as a duplicate or test record</Radio>
      </RadioGroup>
      {value === "asked" && <p>This is kept as their unsubscribe. If anyone adds them to a media list later, the Hub asks first.</p>}
    </>
  );
}
