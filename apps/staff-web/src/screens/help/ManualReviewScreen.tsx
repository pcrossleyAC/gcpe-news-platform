import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { formatLongDate } from "@gcpe/nrms-contract";
import type { HubManualPage as ManualPage, HubManualsData as ManualsData, ManualPreviousVersions } from "../../../../../scripts/manuals-lib.mjs";
import { ApiError, apiFetch } from "../../api/client";
import { MANUALS } from "../../manuals/catalog";
import { loadPreviousVersions, MANUALS_DATA } from "../../manuals/visible-pages";
import { useSession } from "../../session/SessionContext";
import { Button } from "../../shared/BusyButton";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { messagesOf } from "../admin/messages";
import { isCoreAdmin } from "../admin/organizations/access";

const API = "/core/api/manual-reviews";

/** A review as Core keeps it: one page version (its content hash), who reviewed it, and when. */
interface Review {
  pageId: string;
  hash: string;
  reviewedBy: string;
  reviewedAt: string;
}

const key = (pageId: string, hash: string) => `${pageId}\u0000${hash}`;

/** The calendar date a moment falls on in Pacific time, so "reviewed on" matches the clock staff use. */
function pacificDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

const manualTitle = (page: ManualPage) => MANUALS.find((m) => m.id === page.manual)?.title ?? "Shared topics";

/** Newest change first; pages changed the same day by title, so the order never jumps. */
const newestFirst = (a: ManualPage, b: ManualPage) => b.changed.localeCompare(a.changed) || a.title.localeCompare(b.title);

function PageHtml({ html }: { html: string }): React.JSX.Element {
  // eslint-disable-next-line react/no-danger -- build-time content, already escaped and link-checked
  return <div className="gcpe-manual__content" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** What a page said before this version, or that it is new. */
function Before({ version }: { version: ManualPreviousVersions[string] }): React.JSX.Element {
  return version ? (
    <>
      <h3>Before</h3>
      <PageHtml html={version.html} />
    </>
  ) : (
    <>
      <h3>New page</h3>
      <p>This page did not exist before.</p>
    </>
  );
}

/**
 * `/hub/help/manuals-review` (Core.Admin only): the manual pages whose current version nobody has
 * marked reviewed, each with what it said before. A page's version is its content hash, so editing
 * a page makes it unreviewed again; a review of a hash or page the Hub no longer has is ignored.
 * The previous versions load on their own (`loadPrevious`), so only this screen fetches them.
 */
export function ManualReviewScreen({ data = MANUALS_DATA, loadPrevious = loadPreviousVersions }: { data?: ManualsData; loadPrevious?: () => Promise<ManualPreviousVersions> }): React.JSX.Element {
  const session = useSession();
  const allowed = isCoreAdmin(session);
  useDocumentTitle(allowed ? "Changed since your last review" : "Not available");

  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [previous, setPrevious] = useState<ManualPreviousVersions | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState("");
  /** The element id to focus once the list has re-rendered without the page just reviewed. */
  const [focusId, setFocusId] = useState<string | null>(null);

  useEffect(() => {
    if (!focusId) return;
    document.getElementById(focusId)?.focus();
    setFocusId(null);
  }, [focusId, reviews]);

  const load = useCallback(() => apiFetch<Review[]>(API).then(setReviews), []);

  useEffect(() => {
    if (!allowed) return;
    load().catch(() => setLoadError(true));
    loadPrevious().then(setPrevious, () => setLoadError(true));
  }, [allowed, load, loadPrevious]);

  if (!allowed) {
    return (
      <div className="gcpe-help">
        <h1>Not available</h1>
        <p>{"This page isn't available for your role."}</p>
        <p>
          <Link to="/help">Back to Help</Link>
        </p>
      </div>
    );
  }

  const byVersion = new Map((reviews ?? []).map((r) => [key(r.pageId, r.hash), r]));
  const ready = reviews !== null && previous !== null;
  const unreviewed = ready ? data.pages.filter((p) => !byVersion.has(key(p.id, p.hash))).sort(newestFirst) : [];
  const reviewed = ready
    ? data.pages
        .flatMap((p) => {
          const r = byVersion.get(key(p.id, p.hash));
          return r ? [{ page: p, review: r }] : [];
        })
        .sort((a, b) => b.review.reviewedAt.localeCompare(a.review.reviewedAt) || a.page.title.localeCompare(b.page.title))
    : [];

  const markReviewed = async (page: ManualPage) => {
    if (saving !== null) return;
    setSaving(page.id);
    setProblems([]);
    setAnnouncement("");
    try {
      await apiFetch(API, { method: "POST", body: { pageId: page.id, hash: page.hash } });
    } catch (caught) {
      setProblems(caught instanceof ApiError || caught instanceof Error ? messagesOf(caught) : ["Something went wrong."]);
      setSaving(null);
      return;
    }
    // Saved. Whatever happens to the reload, the review is not reported as failed.
    const index = unreviewed.indexOf(page);
    const remaining = unreviewed.filter((p) => p !== page);
    const next = remaining[Math.min(index, remaining.length - 1)];
    try {
      await load();
      setAnnouncement("Marked reviewed.");
      setFocusId(next ? `review-${next.id}` : "reviewed");
    } catch {
      setLoadError(true);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="gcpe-help gcpe-manual-review">
      <p className="gcpe-manual__crumb">
        <Link to="/help">Help</Link>
      </p>
      <h1>Changed since your last review</h1>
      <div role="status" className="gcpe-visually-hidden">
        {announcement}
      </div>

      {loadError && <InlineAlert variant="danger" role="alert" description="Couldn't load the reviews. Reload the page to try again." />}
      {problems.length > 0 && <InlineAlert variant="danger" role="alert" title="Couldn't mark it reviewed" description={problems.join(" ")} />}
      {!loadError && !ready && <p>Loading…</p>}

      {ready && unreviewed.length === 0 && <p>Nothing to review. Every manual change has been reviewed.</p>}
      {unreviewed.length > 0 && (
        <ul className="gcpe-manual-review__list">
          {unreviewed.map((p) => (
            <li key={p.id} className="gcpe-manual-review__item">
              <h2 id={`review-${p.id}`} tabIndex={-1}>
                <Link to={`/help/manuals/${p.manual}/${p.id}`}>{p.title}</Link>
              </h2>
              <p className="gcpe-manual__changed">
                {manualTitle(p)}. Changed {formatLongDate(p.changed)}.
              </p>
              <div className="gcpe-manual-review__compare">
                <section aria-label={`Before: ${p.title}`}>
                  <Before version={previous?.[p.id] ?? null} />
                </section>
                <section aria-label={`Now: ${p.title}`}>
                  <h3>Now</h3>
                  <PageHtml html={p.html} />
                </section>
              </div>
              <Button variant="primary" aria-label={`Mark reviewed: ${p.title}`} isPending={saving === p.id} pendingLabel="Saving…" onPress={() => void markReviewed(p)}>
                Mark reviewed
              </Button>
            </li>
          ))}
        </ul>
      )}

      {reviewed.length > 0 && (
        <section aria-labelledby="reviewed">
          <h2 id="reviewed" tabIndex={-1}>Reviewed</h2>
          <ul className="gcpe-help__list">
            {reviewed.map(({ page, review }) => (
              <li key={page.id}>
                <Link to={`/help/manuals/${page.manual}/${page.id}`}>{page.title}</Link>
                <span className="gcpe-help__aka">
                  {" "}
                  Reviewed by {review.reviewedBy} on {formatLongDate(pacificDate(review.reviewedAt))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
