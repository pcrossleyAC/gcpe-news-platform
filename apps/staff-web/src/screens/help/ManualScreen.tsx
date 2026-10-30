import type { MouseEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { formatLongDate } from "@gcpe/nrms-contract";
import type { ManualsData } from "../../../../../scripts/manuals-lib.mjs";
import { MANUALS } from "../../manuals/catalog";
import { canOpenManual, MANUALS_DATA, openablePage } from "../../manuals/visible-pages";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";

/** The Hub is mounted at /hub/; links inside a page's html are written with that prefix. */
const HUB_PREFIX = "/hub";

/**
 * `/hub/help/manuals/<manualId>` (a manual's pages) and `/hub/help/manuals/<manualId>/<pageId>`
 * (one page). A manual or page the reader may not open shows only the "not available" line, never
 * the content. The page html is build-time content from docs/manuals/, escaped and link-checked by
 * the compiler (scripts/manuals-lib.mjs).
 */
export function ManualScreen({ data = MANUALS_DATA }: { data?: ManualsData }): React.JSX.Element {
  const session = useSession();
  const navigate = useNavigate();
  const { manualId = "", pageId } = useParams();

  const manual = MANUALS.find((m) => m.id === manualId);
  const page = pageId === undefined ? null : openablePage(data, manualId, pageId, session);
  const manualPages = manual && !pageId && canOpenManual(manualId, session) ? data.pages.filter((p) => p.manual === manualId) : null;

  const heading = page ? page.title : manualPages && manual ? manual.title : "Manual not available";
  useDocumentTitle(heading);

  // A link inside the page html goes to another Hub page: open it in the app, not as a page load.
  const onContentClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href");
    if (!a || !href?.startsWith(`${HUB_PREFIX}/`) || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(href.slice(HUB_PREFIX.length));
  };

  if (!page && !manualPages) {
    return (
      <div className="gcpe-help gcpe-manual">
        <h1>Manual not available</h1>
        <p>{"This manual isn't available for your role."}</p>
        <p>
          <Link to="/help">Back to Help</Link>
        </p>
      </div>
    );
  }

  if (page) {
    const owner = MANUALS.find((m) => m.id === page.manual);
    return (
      <div className="gcpe-help gcpe-manual">
        <p className="gcpe-manual__crumb">{owner ? <Link to={`/help/manuals/${owner.id}`}>{owner.title}</Link> : <Link to="/help">Help</Link>}</p>
        <h1>{page.title}</h1>
        {/* eslint-disable-next-line react/no-danger -- build-time content, already escaped and link-checked */}
        <div className="gcpe-manual__content" onClick={onContentClick} dangerouslySetInnerHTML={{ __html: page.html }} />
        <p className="gcpe-manual__changed">Last changed {formatLongDate(page.changed)}</p>
      </div>
    );
  }

  return (
    <div className="gcpe-help gcpe-manual">
      <p className="gcpe-manual__crumb">
        <Link to="/help">Help</Link>
      </p>
      <h1>{manual!.title}</h1>
      <p>For: {manual!.forRoles}</p>
      {manualPages!.length === 0 ? (
        <p>This manual has no pages yet.</p>
      ) : (
        <ul className="gcpe-help__list">
          {manualPages!.map((p) => (
            <li key={p.id}>
              <Link to={`/help/manuals/${p.manual}/${p.id}`}>{p.title}</Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
