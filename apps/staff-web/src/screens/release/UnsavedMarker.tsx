/** The small "Unsaved" tag beside a release-editor section's heading while that section has
 * edits the page's one Save hasn't saved yet (the sticky bar lists them too). Inside the heading,
 * so a screen reader hears it as part of the heading's name: "Page details, unsaved changes". */
export function UnsavedMarker({ show }: { show: boolean }): React.JSX.Element | null {
  if (!show) return null;
  return (
    <>
      <span className="gcpe-visually-hidden">, unsaved changes</span>
      <span className="gcpe-unsaved-marker" aria-hidden="true">
        Unsaved
      </span>
    </>
  );
}
