import { Button } from "../../shared/BusyButton";
import { scrollToAndFocus } from "../../shared/scrollToSection";
import type { DirtySection, SaveAllState } from "./useUnsavedChanges";

export interface UnsavedChangesBarProps {
  sections: DirtySection[];
  /** Where the page's one Save is up to (useUnsavedChangesGuard's `saveState`). */
  state: SaveAllState;
  /** The page's one Save (useUnsavedChangesGuard's `saveAll`). */
  onSave(): void;
  /** The id of the element a section's failure message links to, if any. */
  targetOf?(key: string): string | null;
}

/** A dirty section's label ("Save page details") as the word(s) a sentence names it by
 * ("page details") — just that text with a leading "Save " stripped. */
export function sectionName(label: string): string {
  return label.replace(/^save\s+/i, "");
}

/**
 * Fixed to the bottom of the viewport while any release-editor section has unsaved edits: says
 * which, and holds the page's one Save, which saves every one of them (owner decision
 * 2026-10-29: one Save instead of a Save per section). The sections' own requests, version
 * checks and messages are unchanged — the guard's `saveAll` calls each in turn.
 *
 * If a section doesn't save, the bar says which (linking to it, where its own message is) and
 * which sections after it were not sent; they keep their edits. After everything saved it shows
 * "All changes saved" for a moment (the polite "Saved" announcement is the guard's).
 */
export function UnsavedChangesBar({ sections, state, onSave, targetOf = () => null }: UnsavedChangesBarProps): React.JSX.Element | null {
  if (sections.length === 0) {
    if (state.status !== "saved") return null;
    return (
      <div className="gcpe-save-bar gcpe-save-bar--saved" role="region" aria-label="Save status">
        <p className="gcpe-save-bar__message">All changes saved.</p>
      </div>
    );
  }

  const failed = state.status === "failed" ? state.failed : undefined;
  const failedTarget = failed ? targetOf(failed.key) : null;
  const notSaved = (state.status === "failed" ? state.notSaved ?? [] : []).filter((n) => sections.some((s) => s.key === n.key));

  return (
    <div className="gcpe-save-bar" role="region" aria-label="Unsaved changes">
      <div className="gcpe-save-bar__text">
        <p className="gcpe-save-bar__message">You have unsaved changes in: {sections.map((s) => sectionName(s.label)).join(", ")}</p>
        {failed && (
          <p role="alert" className="gcpe-save-bar__problem">
            Couldn&rsquo;t save {sectionName(failed.label)}.{" "}
            {failedTarget ? (
              <a
                href={`#${failedTarget}`}
                onClick={(e) => {
                  e.preventDefault();
                  scrollToAndFocus(failedTarget);
                }}
              >
                See why in that section
              </a>
            ) : (
              "See why in that section"
            )}
            .{notSaved.length > 0 ? ` Not saved yet: ${notSaved.map((n) => sectionName(n.label)).join(", ")}.` : ""}
          </p>
        )}
      </div>
      <div className="gcpe-save-bar__buttons">
        <Button onPress={onSave} isPending={state.status === "saving"} pendingLabel="Saving…">
          Save changes
        </Button>
      </div>
    </div>
  );
}
