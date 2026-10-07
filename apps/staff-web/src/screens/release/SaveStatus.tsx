/** Shown beside a section's Save button while its save is under way: "Waiting to save…" while
 * it's queued behind another section's save (saveQueue.tsx), then "Saving…" once it's been
 * sent. Plain text, not a live region — the page already announces "Saved" once it lands. */
export function SaveStatus({ saving, waiting }: { saving: boolean; waiting: boolean }): React.JSX.Element | null {
  if (!saving) return null;
  return <span className="gcpe-release-editor__save-status">{waiting ? "Waiting to save…" : "Saving…"}</span>;
}
