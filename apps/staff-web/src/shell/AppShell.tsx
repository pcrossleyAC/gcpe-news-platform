import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { AlertDialog, Header, InlineAlert, Modal } from "@bcgov/design-system-react-components";
import { Button } from "../shared/Button";
import { useSession } from "../session/SessionContext";
import { hasAnyReadRole, NAV_GROUPS } from "./nav";
import { FindRelease } from "./FindRelease";
import { useTimeZoneWarning } from "../format/timeZoneWarning";
import { AnnouncerProvider } from "../shared/Announcer";
import { useFocusH1OnRouteChange } from "../shared/useFocusH1OnRouteChange";
import { useEscapeClosesPanels } from "../shared/escapeClosesPanels";
import { helpFor, helpTargetFor } from "../manuals/help-target";
import { useUnsavedChangesState } from "../shared/LeaveGuard";
import { useSignInAgain } from "../session/RequireAuth";

export { helpFor };

export function AppShell(): React.JSX.Element {
  const session = useSession();
  const navigate = useNavigate();
  const tzMismatch = useTimeZoneWarning();
  // I5 (WCAG 2.4.2): move focus to the new screen's h1 on every route change.
  const mainRef = useFocusH1OnRouteChange<HTMLElement>();
  // Esc closes the panel or disclosure the user is in, on every screen (dialogs close themselves).
  useEscapeClosesPanels();
  const uid = useId();
  const { pathname } = useLocation();
  // On narrow screens the section menu folds away behind a "Menu" button (the CSS hides the
  // button, and shows the menu regardless, on wider ones). Choosing a section closes it again.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [pathname]);
  const menuButton = useRef<HTMLButtonElement>(null);
  // Following any link in the open menu closes it, the current page's own link included (which
  // changes no pathname). Escape closes it too and puts focus back on the Menu button.
  const onMenuClick = (e: React.MouseEvent) => {
    if (e.target instanceof Element && e.target.closest("a")) setMenuOpen(false);
  };
  const onNavKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || !menuOpen) return;
    e.preventDefault();
    setMenuOpen(false);
    menuButton.current?.focus();
  };
  const groups = NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((item) => item.show(session)) })).filter((g) => g.items.length > 0);

  const unsaved = useUnsavedChangesState();
  // Suite review H1: Sign out asks first when the screen has unsaved changes.
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const signOut = async () => {
    setConfirmSignOut(false);
    await session.signOut();
    navigate("/sign-in", { replace: true });
  };
  const onSignOut = () => {
    if (unsaved?.anyDirty) setConfirmSignOut(true);
    else void signOut();
  };
  // H1: the session ended while this screen had unsaved changes (RequireAuth kept it on screen
  // and explained in a dialog). This notice stays until they sign in again.
  const signInAgain = useSignInAgain();

  return (
    <AnnouncerProvider>
      <div className="gcpe-shell">
        <a className="gcpe-skip-link" href="#main-content">
          Skip to main content
        </a>
        <Header title="GCPE News — Staff">
          <div className="gcpe-shell__user">
            {session.user && <span>Signed in as {session.user.name}</span>}
            <Link to={helpTargetFor(pathname, session)} className="gcpe-shell__help">
              Help
            </Link>
            <Button size="small" variant="secondary" onPress={onSignOut}>
              Sign out
            </Button>
          </div>
        </Header>
        <nav className="gcpe-shell__nav" aria-label="Sections" onKeyDown={onNavKeyDown}>
          <div className="gcpe-shell__menu-toggle">
            <Button ref={menuButton} size="small" variant="secondary" aria-expanded={menuOpen} aria-controls={`${uid}-menu`} onPress={() => setMenuOpen((open) => !open)}>
              Menu
            </Button>
          </div>
          <div id={`${uid}-menu`} className="gcpe-shell__menu" data-open={menuOpen || undefined} onClick={onMenuClick}>
            {/* Phones only: the header has room for the title and Sign out, so who is signed in moves here. */}
            {session.user && (
              <p className="gcpe-shell__menu-user">
                <span>Signed in</span> <strong>{session.user.name}</strong>
              </p>
            )}
            {/* Search has its own box; everywhere else a release is one step away. */}
            {hasAnyReadRole(session) && pathname !== "/search" && <FindRelease reveal={() => flushSync(() => setMenuOpen(true))} />}
            {groups.map((group) => (
              <div key={group.label} className="gcpe-shell__nav-group">
                <p id={`${uid}-${group.label}`} className="gcpe-shell__nav-heading">
                  {group.label}
                </p>
                <ul aria-labelledby={`${uid}-${group.label}`}>
                  {group.items.map((item) => (
                    <li key={item.to}>
                      <NavLink to={item.to}>{item.label}</NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>
        <main id="main-content" tabIndex={-1} className="gcpe-shell__main" ref={mainRef}>
          {/* Each routed screen owns its own single h1 (constraints.md); the shell itself has none. */}
          {/* Fix round 1, finding 3: persistent — not closeable — since it stays true for the
           * whole session; the only real fix is updating the browser. The title is what the design
           * system's alert names itself by (its aria-labelledby always points at a title). */}
          {session.ended && (
            <InlineAlert
              variant="danger"
              role="alert"
              isCloseable={false}
              title="Your session has ended"
              description="Nothing on this page can be saved until you sign in again."
              buttons={
                <Button size="small" variant="secondary" onPress={signInAgain}>
                  Sign in again
                </Button>
              }
            />
          )}
          {tzMismatch && (
            <InlineAlert
              variant="warning"
              role="alert"
              isCloseable={false}
              title="Check the times shown"
              description="Your browser's time-zone information is out of date, so times shown here may be off by an hour. Update your browser."
            />
          )}
          <Outlet />
        </main>
      </div>
      <Modal isOpen={confirmSignOut} onOpenChange={(open) => { if (!open) setConfirmSignOut(false); }} isDismissable>
        <AlertDialog
          role="alertdialog"
          aria-label="Unsaved changes"
          variant="warning"
          title="Unsaved changes"
          buttons={
            <>
              <Button onPress={() => setConfirmSignOut(false)}>Stay</Button>
              <Button danger onPress={() => void signOut()}>
                Sign out
              </Button>
            </>
          }
        >
          <p>You have unsaved changes on this page. Sign out anyway and discard them?</p>
        </AlertDialog>
      </Modal>
    </AnnouncerProvider>
  );
}
