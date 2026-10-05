import { useState } from "react";
import { Button } from "@bcgov/design-system-react-components";
import type { DirtySection } from "./useUnsavedChanges";

export interface UnsavedChangesBarProps {
  sections: DirtySection[];
}

/** A dirty section's own button text ("Save page details") as the word(s) the bar's intro
 * sentence names it by ("page details") — just that text with a leading "Save " stripped. */
function sectionName(label: string): string {
  return label.replace(/^save\s+/i, "");
}

/**
 * Fixed to the bottom of the viewport while any release-editor section has unsaved edits
 * (hand-check feedback on boxs.ca: a document with a long body pushed its own Save button far
 * down the page, out of view). One button per dirty section, each calling straight through to
 * that section's own save — same request, same 409/422 handling (useReleaseSection) — never a
 * duplicate of that logic. A section's own inline Save button at the bottom of its form keeps
 * working exactly as before; this is an additional, always-visible way to reach it.
 *
 * Deliberately no single "Save all": every section save bumps the release's `version`, so
 * saving two sections at once would 409 the second.
 */
export function UnsavedChangesBar({ sections }: UnsavedChangesBarProps): React.JSX.Element | null {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  if (sections.length === 0) return null;

  const onSave = (section: DirtySection) => {
    setPending((p) => new Set(p).add(section.key));
    void Promise.resolve(section.save()).finally(() => {
      setPending((p) => {
        if (!p.has(section.key)) return p;
        const next = new Set(p);
        next.delete(section.key);
        return next;
      });
    });
  };

  return (
    <div className="gcpe-save-bar" role="region" aria-label="Unsaved changes">
      <p className="gcpe-save-bar__message">You have unsaved changes in: {sections.map((s) => sectionName(s.label)).join(", ")}</p>
      <div className="gcpe-save-bar__buttons">
        {sections.map((section) => (
          <Button key={section.key} onPress={() => onSave(section)} isDisabled={pending.has(section.key)}>
            {section.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
