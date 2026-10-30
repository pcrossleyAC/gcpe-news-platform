import { useEffect } from "react";
import { Navigate, NavLink, useLocation } from "react-router";
import { useSession } from "../../session/SessionContext";
import { readRememberedView, rememberView } from "../../shared/rememberedView";

/** Legacy's release menu (ReleaseManagement.master.cs:21-27): Forecast first, then the folders. */
const TABS = [
  ["forecast", "Forecast"],
  ["drafts", "Drafts"],
  ["scheduled", "Scheduled"],
  ["published", "Published"],
] as const;

type FolderPath = (typeof TABS)[number][0];
const isFolder = (value: string | null | undefined): value is FolderPath => TABS.some(([path]) => path === value);

export function ReleaseFolderTabs(): React.JSX.Element {
  // The folder on screen is remembered for this user in this browser: Releases, in the side
  // menu, comes back to it (ReleasesIndex) — after opening a scheduled release, say.
  const userId = useSession().user?.id;
  const folder = useLocation().pathname.split("/").pop();
  useEffect(() => {
    if (isFolder(folder)) rememberView(userId, "release-folder", folder);
  }, [userId, folder]);
  return (
    <nav aria-label="Release folders" className="gcpe-section-tabs">
      <ul>
        {TABS.map(([path, label]) => (
          <li key={path}>
            <NavLink to={`/releases/${path}`}>{label}</NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** `/releases` (the side menu's Releases): the folder this user last had open, or Drafts. */
export function ReleasesIndex(): React.JSX.Element {
  const remembered = readRememberedView(useSession().user?.id, "release-folder");
  return <Navigate to={`/releases/${isFolder(remembered) ? remembered : "drafts"}`} replace />;
}
