import { POST_KIND, type ReleaseView } from "@gcpe/nrms-contract";
import { usePublicSiteUrl } from "./usePublicSiteUrl";

export interface ViewLinksProps {
  view: ReleaseView;
}

/** "View on site" (the public URL, `${publicSiteUrl}/${POST_KIND[type]}/${key}` —
 * apps/nrms/src/releases/queries.ts's own path shape) and "View PDF"
 * (`/nrms/api/releases/:id/pdf`), both opened in a new tab. "View on site" is only offered once
 * the release has a key (unpublished releases have none yet, and there would be nothing to
 * link to). */
export function ViewLinks({ view }: ViewLinksProps): React.JSX.Element {
  const publicSiteUrl = usePublicSiteUrl();
  const siteHref = view.key ? `${publicSiteUrl.replace(/\/$/, "")}/${POST_KIND[view.type]}/${view.key}` : null;

  return (
    <nav className="gcpe-sidebar__view-links" aria-label="View">
      <ul>
        {siteHref && (
          <li>
            <a href={siteHref} target="_blank" rel="noreferrer">
              View on site
            </a>
          </li>
        )}
        <li>
          <a href={`/nrms/api/releases/${view.id}/pdf`} target="_blank" rel="noreferrer">
            View PDF
          </a>
        </li>
      </ul>
    </nav>
  );
}
