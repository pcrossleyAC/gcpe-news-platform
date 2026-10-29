import { useEffect, useRef, useState } from "react";
import { Accordion } from "@bcgov/design-system-react-components";
import { REVEAL_EVENT } from "./scrollToSection";

export interface SectionDisclosureProps {
  /** The toggle's text, which is also its accessible name. It doesn't change when it opens;
   * the button's own expanded state says that. */
  label: string;
  /** One line saying what is inside while it's closed (e.g. the current selection). */
  summary?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * A long part of a release editor card (Categories' ~60 checkboxes, the Top/Feature switches,
 * Similar releases) behind the design system's disclosure, with a one-line summary above it, so
 * the release body is reachable without tabbing through every option. Closed, the panel's
 * contents stay mounted (React Aria hides them with `hidden="until-found"`), so a form inside
 * keeps its unsaved state and find-in-page still opens it. A "why is this unavailable" link that
 * takes the user to the enclosing section (shared/scrollToSection.ts) opens it too.
 */
export function SectionDisclosure({ label, summary, children }: SectionDisclosureProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const section = ref.current?.closest("section");
    if (!section) return;
    const reveal = () => setOpen(true);
    section.addEventListener(REVEAL_EVENT, reveal);
    return () => section.removeEventListener(REVEAL_EVENT, reveal);
  }, []);

  return (
    <div ref={ref} className="gcpe-section-disclosure">
      {summary && <p className="gcpe-section-disclosure__summary">{summary}</p>}
      <Accordion label={label} isExpanded={open} onExpandedChange={setOpen}>
        {children}
      </Accordion>
    </div>
  );
}
