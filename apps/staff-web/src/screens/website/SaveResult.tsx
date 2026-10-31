/**
 * W8 (suite review, owner approved 2026-10-31): the visible result of the last save or publish on
 * a Website screen ("Saved at 2:30 PM. Live now: …"), so an editor under time pressure can see
 * what happened without reloading or checking the public site.
 *
 * Always rendered, empty until a save, so the text that appears in it is announced, as the
 * Calendar user screen's rank result does. Screens using it run their saves with
 * `useVersionedSave({ quiet: true })`, so a screen reader hears this one message, not "Saved" too.
 * Place it outside anything keyed on the saved version, or it remounts with its text and is not
 * announced.
 */
export function SaveResult({ text }: { text: string }): React.JSX.Element {
  return (
    <p role="status" className="gcpe-notice gcpe-save-result">
      {text}
    </p>
  );
}

/** The time of day in the tenant's zone, as the Hub shows times: "2:30 PM". */
export function clockTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(at);
}
