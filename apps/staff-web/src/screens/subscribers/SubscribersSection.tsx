import { NavLink, Outlet } from "react-router";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { canAdminSubscribers, canEditSubscribers, canReadSubscribers } from "./access";

/** `/hub/subscribers/*`: the section's sub-nav plus `<Outlet/>`. No h1 of its own except the
 * permission-denied branch (each sub-screen owns its h1 and title). */
export function SubscribersSection(): React.JSX.Element {
  const session = useSession();
  const canRead = canReadSubscribers(session);
  useDocumentTitle(!canRead ? "Subscribers" : null);
  if (!canRead) {
    return (
      <div className="gcpe-subscribers">
        <h1>Subscribers</h1>
        <p>You don&rsquo;t have permission to view subscribers.</p>
      </div>
    );
  }
  return (
    <div className="gcpe-subscribers">
      <nav aria-label="Subscribers sections">
        <ul>
          <li>
            <NavLink to="/subscribers" end>
              Find subscribers
            </NavLink>
          </li>
          {canEditSubscribers(session) && (
            <li>
              <NavLink to="/subscribers/new">Add a subscriber</NavLink>
            </li>
          )}
          <li>
            <NavLink to="/subscribers/lists">Lists and categories</NavLink>
          </li>
          <li>
            <NavLink to="/subscribers/media-lists">Media lists</NavLink>
          </li>
          {canAdminSubscribers(session) && (
            <li>
              <NavLink to="/subscribers/operations">Operations</NavLink>
            </li>
          )}
        </ul>
      </nav>
      <Outlet />
    </div>
  );
}
