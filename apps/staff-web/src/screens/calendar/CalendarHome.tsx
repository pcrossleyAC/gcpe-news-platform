import { Link } from "react-router";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { CALENDAR_ADMIN_LEVEL } from "./access";
import { useCalendarContext } from "./CalendarSection";

/** The Calendar's landing page until the activity list exists. */
export function CalendarHome(): React.JSX.Element {
  const me = useCalendarContext();
  useDocumentTitle("Corporate Calendar");
  return (
    <div>
      <h1>Corporate Calendar</h1>
      <p>Activities, the list and reports are on their way. Your Calendar access is in place.</p>
      {me.level >= CALENDAR_ADMIN_LEVEL && (
        <p>
          <Link to="/calendar/lookups">Manage the Calendar&rsquo;s lookups</Link>
        </p>
      )}
      {me.level >= CALENDAR_ADMIN_LEVEL && (
        <p>
          <Link to="/calendar/users">Manage Calendar users</Link>
        </p>
      )}
      {me.level >= CALENDAR_ADMIN_LEVEL && (
        <p>
          <Link to="/calendar/transfer">Transfer activities between comm contacts</Link>
        </p>
      )}
    </div>
  );
}
