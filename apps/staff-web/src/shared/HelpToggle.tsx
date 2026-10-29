import { Link } from "react-router";
import { glossaryEntry } from "./glossary";

/**
 * A small "?" beside a piece of jargon that shows (and hides) its short explanation, from the
 * glossary (shared/glossary.ts), with a link to the full Help page entry.
 *
 * A native disclosure (`<details>`/`<summary>`): reachable and operable from the keyboard (Enter
 * or Space), announced as a collapsed/expanded button, named for what it explains ("What is LA
 * Status?"), and the text shows in the page, not in a hover-only tooltip. Esc closes it
 * (shared/escapeClosesPanels.ts). Unlike a `<button>`, a summary isn't disabled by a disabled
 * `<fieldset>` — so a read-only form (an activity a viewer can't edit) still explains itself.
 *
 * Put it in a `gcpe-label-row` beside the label; open, it takes the row's full width.
 */
export function HelpToggle({ entry }: { entry: string }): React.JSX.Element {
  const { id, term, definition } = glossaryEntry(entry);
  return (
    <details className="gcpe-help-toggle">
      <summary>
        <span className="gcpe-help-toggle__mark" aria-hidden="true">
          ?
        </span>
        <span className="gcpe-visually-hidden">What is {term}?</span>
      </summary>
      <div className="gcpe-help-text">
        <p>
          {definition} <Link to={`/help#glossary-${id}`}>More in Help</Link>
        </p>
      </div>
    </details>
  );
}
