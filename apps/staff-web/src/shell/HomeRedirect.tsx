import { Navigate } from "react-router";
import { useSession } from "../session/SessionContext";
import { canReadSubscribers } from "../screens/subscribers/access";
import { canManageCalendarAccess } from "../screens/admin/calendar-access/calendar-roles";
import { hasCalendarRole } from "../screens/calendar/access";

/** The staff app's landing page: Drafts for anyone with an NRMS role (unchanged),
 * Subscribers for someone whose only staff roles are NoD ones, the Calendar itself for any
 * Calendar role — administrators included (owner decision 2026-10-29: Calendar access stays in
 * the nav) — and Calendar access for someone who manages it without a Calendar role of their own
 * (Core.Admin). They'd otherwise land on a Releases screen they can't use. */
export function HomeRedirect(): React.JSX.Element {
  const session = useSession();
  const nrms = session.has("NRMS.Viewer") || session.has("NRMS.Editor") || session.has("NRMS.SiteEditor");
  const target = nrms
    ? "/releases/drafts"
    : canReadSubscribers(session)
      ? "/subscribers"
      : hasCalendarRole(session)
        ? "/calendar"
        : canManageCalendarAccess(session)
          ? "/calendar-access"
          : "/releases/drafts";
  return <Navigate to={target} replace />;
}
