import { Navigate } from "react-router";
import { useSession } from "../session/SessionContext";
import { canReadSubscribers } from "../screens/subscribers/access";

/** The staff app's landing page: Drafts for anyone with an NRMS role (unchanged), Subscribers
 * for someone whose only staff roles are NoD ones — they'd otherwise land on a Releases
 * screen they can't use. */
export function HomeRedirect(): React.JSX.Element {
  const session = useSession();
  const nrms = session.has("NRMS.Viewer") || session.has("NRMS.Editor") || session.has("NRMS.SiteEditor");
  return <Navigate to={!nrms && canReadSubscribers(session) ? "/subscribers" : "/releases/drafts"} replace />;
}
