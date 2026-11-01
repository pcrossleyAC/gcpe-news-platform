import { Link } from "react-router";
import { Header } from "@bcgov/design-system-react-components";
import { Button } from "../shared/Button";
import { useDocumentTitle } from "../shared/useDocumentTitle";

/**
 * Suite review H3 (owner 2026-10-31): a screen that crashes shows this inside the shell — the side
 * menu and Sign out stay — instead of React Router's developer error page. The router's
 * `errorElement` (router.tsx); following any link clears it. Like the Calendar's own boundary
 * (screens/calendar/ErrorBoundary.tsx), it shows and logs nothing of the error itself: its text
 * and stack can carry what the user typed.
 *
 * `standalone` is for a crash outside the shell (the sign-in page, or the shell itself), so it
 * brings its own header.
 */
export function HubErrorPage({ standalone = false }: { standalone?: boolean }): React.JSX.Element {
  useDocumentTitle("Something went wrong");
  const body = (
    <div className="gcpe-hub-message">
      <h1>Something went wrong</h1>
      <p>This page couldn&rsquo;t be shown. Reload the page to try again.</p>
      <div className="gcpe-hub-message__actions">
        <Button variant="primary" onPress={() => window.location.reload()}>
          Reload
        </Button>
        {/* A plain page load when outside the shell: whatever broke may be the router's own state. */}
        {standalone ? <a href="/hub/">Go to the start page</a> : <Link to="/">Go to the start page</Link>}
      </div>
    </div>
  );
  if (!standalone) return body;
  return (
    <main className="gcpe-sign-in">
      <Header title="GCPE News — Staff" />
      {body}
    </main>
  );
}

/** Suite review H4: an address inside /hub that no screen answers. */
export function NotFoundScreen(): React.JSX.Element {
  useDocumentTitle("Page not found");
  return (
    <div className="gcpe-hub-message">
      <h1>Page not found</h1>
      <p>There&rsquo;s no page at this address. The link may be out of date, or the address may have been typed wrong.</p>
      <div className="gcpe-hub-message__actions">
        <Link to="/">Go to the start page</Link>
      </div>
    </div>
  );
}
