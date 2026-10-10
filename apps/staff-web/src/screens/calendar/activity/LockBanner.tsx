import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { timeText } from "../list/dates";
import type { EditLock } from "./useEditLock";

/** The lock as the person at this page needs to know it (spec addendum §7.5). Nothing shows while it is theirs. */
export function LockBanner({ lock, timeZone }: { lock: EditLock; timeZone: string }): React.JSX.Element | null {
  const s = lock.state;
  if (s.kind === "other") {
    return (
      <div role="status">
        <InlineAlert
          variant="info"
          title="Someone else is editing"
          description={`${s.holderName} is editing this activity (since ${timeText(s.since, timeZone)}). It opens for editing when they save or cancel, or after 15 minutes without input.`}
        />
      </div>
    );
  }
  if (s.kind === "elsewhere") {
    return (
      <InlineAlert
        variant="warning"
        title="Open in another tab"
        description="You're editing this activity in another tab."
        buttons={<Button onPress={() => void lock.continueHere()}>Continue here</Button>}
      />
    );
  }
  if (s.kind === "lapsed") {
    return (
      <div role="status">
        <InlineAlert
          variant="warning"
          title="Edit lock lapsed"
          description="Your edit lock lapsed. Save will work only if no one else has taken it or changed the activity."
        />
      </div>
    );
  }
  if (s.kind === "gone") {
    return <InlineAlert variant="danger" role="alert" description="This activity is no longer available." />;
  }
  return lock.problem ? <InlineAlert variant="danger" role="alert" description={lock.problem} /> : null;
}
