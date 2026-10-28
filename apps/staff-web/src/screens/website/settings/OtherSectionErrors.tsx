import { useId } from "react";
import { SECTION_LABEL, type FieldError } from "@gcpe/site-settings";
import { sectionOfField } from "./useSettingsEditor";

/** Problems in other parts of the draft (they block publishing this screen too), each prefixed with its section's name. */
export function OtherSectionErrors({ errors }: { errors: FieldError[] }): React.JSX.Element | null {
  const labelId = useId();
  if (errors.length === 0) return null;
  return (
    <section aria-labelledby={labelId} className="gcpe-settings-other-errors">
      <p id={labelId}>Other parts of the draft have problems that block publishing:</p>
      <ul>
        {errors.map((e) => (
          <li key={`${e.field}:${e.message}`}>{`${SECTION_LABEL[sectionOfField(e.field)] ?? e.field}: ${e.message}`}</li>
        ))}
      </ul>
    </section>
  );
}
