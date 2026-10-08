import { NavLink, Outlet, useOutletContext } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { CALENDAR_ADMIN_LEVEL, type CalendarMe } from "./access";
import { useCalendarMe } from "./useCalendarMe";

/** `/hub/calendar/*`: the Calendar's sub-nav and its screens. Each screen owns its h1 and title,
 * except the messages below, which own theirs. */
export function CalendarSection(): React.JSX.Element {
  const { me, denied, error } = useCalendarMe();
  useDocumentTitle(denied || error ? "Corporate Calendar" : null);
  if (denied || error) {
    return (
      <div className="gcpe-calendar">
        <h1>Corporate Calendar</h1>
        {denied ? <p>You don&rsquo;t have Calendar access. Ask a Calendar administrator.</p> : <InlineAlert variant="danger" role="alert" description={error!} />}
      </div>
    );
  }
  if (!me) return <p>Loading…</p>;
  return (
    <div className="gcpe-calendar">
      <nav aria-label="Calendar sections">
        <ul>
          <li>
            <NavLink to="/calendar" end>
              Calendar
            </NavLink>
          </li>
          {me.level >= CALENDAR_ADMIN_LEVEL && (
            <li>
              <NavLink to="/calendar/lookups">Lookups</NavLink>
            </li>
          )}
        </ul>
      </nav>
      <Outlet context={me} />
    </div>
  );
}

/** The caller's Calendar access, for a screen rendered inside CalendarSection. */
export function useCalendarContext(): CalendarMe {
  return useOutletContext<CalendarMe>();
}
