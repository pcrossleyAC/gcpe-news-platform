import { useId } from "react";
import { Link } from "react-router";
import { SECTION_KEYS, type FieldError, type SectionKey } from "@gcpe/site-settings";
import { settingsScreenFor } from "../WebsiteScreen";
import { sectionOfField } from "./useSettingsEditor";

/** Problems in other parts of the draft (they block publishing this screen too), each led by a link to the screen that fixes it. */
export function OtherSectionErrors({ errors }: { errors: FieldError[] }): React.JSX.Element | null {
  const labelId = useId();
  if (errors.length === 0) return null;
  return (
    <section aria-labelledby={labelId} className="gcpe-settings-other-errors">
      <p id={labelId}>Other parts of the draft have problems that block publishing:</p>
      <ul>
        {errors.map((e) => {
          const section = sectionOfField(e.field);
          const screen = (SECTION_KEYS as readonly string[]).includes(section) ? settingsScreenFor(section as SectionKey) : null;
          return (
            <li key={`${e.field}:${e.message}`}>
              {screen ? <Link to={screen.path}>{screen.label}</Link> : e.field}: {e.message}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
