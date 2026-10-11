import { NavLink } from "react-router";

/** Legacy's release menu (ReleaseManagement.master.cs:21-27): Forecast first, then the folders. */
const TABS = [
  ["forecast", "Forecast"],
  ["drafts", "Drafts"],
  ["scheduled", "Scheduled"],
  ["published", "Published"],
] as const;

export function ReleaseFolderTabs(): React.JSX.Element {
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
