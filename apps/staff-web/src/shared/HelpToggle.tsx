import { useId, useState } from "react";
import { Link } from "react-router";
import { glossaryEntry } from "./glossary";

/**
 * A small "?" button beside a piece of jargon that shows (and hides) its short explanation, from
 * the glossary (shared/glossary.ts), with a link to the full Help page entry. A real button —
 * reachable and operable from the keyboard, its state announced (`aria-expanded`), named for
 * what it explains ("What is LA Status?") — and the text shows in the page below it, not in a
 * hover-only tooltip. Esc closes it (shared/escapeClosesPanels.ts).
 *
 * Renders the button and the explanation as siblings: put them where the label is, in a
 * `gcpe-label-row` (the explanation takes the row's full width under the label).
 */
export function HelpToggle({ entry }: { entry: string }): React.JSX.Element {
  const { id, term, definition } = glossaryEntry(entry);
  const [open, setOpen] = useState(false);
  const panelId = `help-${id}-${useId()}`;
  return (
    <>
      <button type="button" className="gcpe-help-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">?</span>
        <span className="gcpe-visually-hidden">What is {term}?</span>
      </button>
      <div id={panelId} className="gcpe-help-text" hidden={!open}>
        <p>
          {definition} <Link to={`/help#glossary-${id}`}>More in Help</Link>
        </p>
      </div>
    </>
  );
}
