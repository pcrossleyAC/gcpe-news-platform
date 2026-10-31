import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { statusText, type ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { useAnnouncer } from "../../shared/Announcer";
import { useShortcut } from "../../shared/shortcuts";
import { DirtyKeysProvider, useUnsavedChangesGuard } from "./useUnsavedChanges";
import { unsavedTarget } from "./unsavedTarget";
import { UnsavedChangesBar } from "./UnsavedChangesBar";
import { HeaderSection } from "./sections/HeaderSection";
import { ActionsSection } from "./sections/ActionsSection";
import { SettingsSection } from "./sections/SettingsSection";
import { CategoriesSection } from "./sections/CategoriesSection";
import { AssetSection } from "./sections/AssetSection";
import { PageDetailsSection } from "./sections/PageDetailsSection";
import { DocumentsSection } from "./documents/DocumentsSection";
import { FilesSection } from "./documents/FilesSection";
import { SimilarReleasesPanel } from "./SimilarReleasesPanel";
import { SideBar } from "./sidebar/SideBar";
import { SaveQueueContext, useSaveQueueController } from "./saveQueue";
import { clearReleaseDrafts } from "./documents/unsavedDocumentStorage";
import { LeavePageDialog } from "../../shared/LeaveGuard";

/**
 * `/hub/releases/:id` (task-3-brief.md): loads the view once, holds it in one piece of state
 * (`view`/`setView`), and renders every section in spec order. Each section saves to its own
 * endpoint (via its own {@link useReleaseSection} call) and, on success, replaces the *whole*
 * `view` with the server's response — so every other section's `version` field stays current
 * too. The page has one Save (the sticky bar, Enter in a field, Ctrl/⌘+S): it saves every
 * changed section in turn (useUnsavedChanges' saveAll).
 *
 * Section saves never overlap: they go through one page-wide queue (saveQueue.tsx), so a save
 * requested while another is still in flight waits for it and then sends the version it
 * returned, instead of sending the old version and 409ing against our own earlier save.
 *
 * Task 4 adds Documents, Translations/files, History and a side bar (DocumentsSection,
 * FilesSection, SideBar below) after Task 3's sections, without needing to touch anything above
 * them.
 */
/** How often the page re-fetches the release while it's on its way to a settled status. */
export const SETTLING_REFRESH_MS = 5_000;
/** setTimeout's ceiling is ~24.8 days; a far-off schedule just re-checks hourly instead. */
const MAX_WAIT_MS = 60 * 60_000;

/**
 * How long to wait before re-fetching the release on its own, or null for "don't": every
 * {@link SETTLING_REFRESH_MS} while it's publishing/unpublishing (or scheduled and already due —
 * the background tick just hasn't picked it up yet), and at the scheduled moment itself while
 * it's scheduled for later. Hand-check feedback on boxs.ca: the page sat on "Republishing..."
 * until it was reloaded by hand.
 */
export function settlingDelay(view: Pick<ReleaseView, "status" | "publishAt">, nowMs: number): number | null {
  if (view.status === "publishing" || view.status === "unpublishing") return SETTLING_REFRESH_MS;
  if (view.status === "scheduled" && view.publishAt) {
    const until = Date.parse(view.publishAt) - nowMs;
    return until <= 0 ? SETTLING_REFRESH_MS : Math.min(until + 1_000, MAX_WAIT_MS);
  }
  return null;
}

export function ReleaseEditorPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const timeZone = useTenantTimeZone();
  const [view, setViewState] = useState<ReleaseView | null>(null);
  const saveQueue = useSaveQueueController();
  // Every new view (load, background refresh, a section's save or Reload) also tells the save
  // queue the release's latest version, which the next queued save sends.
  const { noteVersion } = saveQueue;
  const setView = useCallback(
    (v: ReleaseView) => {
      noteVersion(v.version);
      setViewState(v);
    },
    [noteVersion],
  );
  const [error, setError] = useState<string | null>(null);
  const guard = useUnsavedChangesGuard();
  const { announce } = useAnnouncer();
  // Bumped when a background refresh fails, so the effect below schedules another try even
  // though `view` didn't change.
  const [retry, setRetry] = useState(0);
  const lastStatus = useRef<string | null>(null);
  // ⌘/Ctrl+S: the page's one Save, from anywhere on the page (text fields included) — for an
  // editor; a viewer has nothing to save.
  const canEdit = session.has("NRMS.Editor");
  useShortcut(
    "save",
    view && canEdit
      ? () => {
          if (guard.dirtySections.length === 0) announce("No unsaved changes.");
          else void guard.saveAll();
        }
      : null,
  );
  // The happy-path title (the release's own headline) is HeaderSection's job, below — this
  // only owns it for the error state, whose h1 ("Release") HeaderSection never renders.
  useDocumentTitle(error ? "Release" : null);

  useEffect(() => {
    if (!id) return;
    let active = true;
    setViewState(null);
    saveQueue.reset();
    setError(null);
    apiFetch<ReleaseView>(`/nrms/api/releases/${id}`).then(
      (v) => {
        if (active) setView(v);
      },
      (caught: unknown) => {
        if (!active) return;
        setError(caught instanceof ApiError && caught.status === 404 ? "This release doesn't exist, or has been deleted." : "Couldn't load this release.");
      },
    );
    return () => {
      active = false;
    };
  }, [id, setView, saveQueue]);

  // Re-fetch on its own while the release is on its way somewhere (see settlingDelay). Each
  // successful fetch replaces `view`, which re-runs this effect — the loop ends by itself once
  // the release settles. Sections seed their own form state once, so a refresh never clobbers
  // unsaved edits. Only while the tab is visible (same reasoning as SessionContext's renewal
  // check) — a backgrounded tab just checks again at the next tick instead of fetching.
  useEffect(() => {
    if (!view) return;
    const delay = settlingDelay(view, Date.now());
    if (delay === null) return;
    let active = true;
    const timer = setTimeout(() => {
      if (document.visibilityState !== "visible") {
        if (active) setRetry((n) => n + 1);
        return;
      }
      apiFetch<ReleaseView>(`/nrms/api/releases/${view.id}`).then(
        (fresh) => {
          if (active) setView(fresh);
        },
        () => {
          if (active) setRetry((n) => n + 1);
        },
      );
    }, delay);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [view, retry, setView]);

  // Say so when a refresh (or anything else) moves the release to a new status.
  useEffect(() => {
    if (!view) return;
    const text = statusText(view, Date.now());
    if (lastStatus.current !== null && lastStatus.current !== text) announce(`Status: ${text}`);
    lastStatus.current = text;
  }, [view, announce]);

  if (error) {
    return (
      <div className="gcpe-release-editor">
        <h1>Release</h1>
        <p role="alert">{error}</p>
      </div>
    );
  }

  if (!view) return <p>Loading…</p>;

  // constraints.md: a viewer (no NRMS.Editor) sees the page read-only — every section still
  // shows the release's data, just with no inputs enabled and no Actions at all (every action
  // is an Editor-only write).
  const settling = settlingDelay(view, Date.now()) === SETTLING_REFRESH_MS;

  return (
    <SaveQueueContext.Provider value={saveQueue.queue}>
      <guard.Provider>
        <DirtyKeysProvider keys={guard.dirtyKeys}>
          <div className={`gcpe-release-editor${guard.dirtySections.length > 0 || guard.saveState.status === "saved" ? " gcpe-release-editor--save-bar-open" : ""}`}>
            <div className="gcpe-release-editor__top">
              <HeaderSection view={view} canEdit={canEdit} />
              {settling && <p className="gcpe-release-editor__settling">This page updates on its own until the release is done — no need to reload.</p>}
            </div>

            {/* Fix round 1, finding 2: a real dialog — traps focus, restores it on close, and
             * closes on Escape (treated the same as "Stay"). The Hub's shared one (H2). */}
            <LeavePageDialog
              blocker={guard.blocker}
              plainDialog
              onLeave={() => {
                // Suite review R3: discarded means discarded. A draft kept from a 401 and
                // restored here must not come back the next time the release is opened.
                if (session.user) clearReleaseDrafts(session.user.id, view.id);
              }}
            />

            {/* One column below 80rem, in reading order: Actions, the release itself (Documents
             * first), then Publish settings and the release's facts. From 80rem, two columns: the
             * release on the left; Actions and, under it, a sticky rail with Publish settings and
             * the facts on the right (styles/global.css). The DOM order is the same at every width,
             * so keyboard order always matches what's on screen, and no section is ever remounted
             * (losing its unsaved edits) when the window crosses the breakpoint. */}
            {canEdit && <ActionsSection view={view} setView={setView} timeZone={timeZone} unsaved={guard.dirtySections} />}
            <div className="gcpe-release-editor__main">
              <DocumentsSection view={view} setView={setView} readOnly={!canEdit} />
              <PageDetailsSection view={view} setView={setView} readOnly={!canEdit} />
              <CategoriesSection view={view} setView={setView} readOnly={!canEdit} />
              <AssetSection view={view} setView={setView} readOnly={!canEdit} />
              <FilesSection view={view} setView={setView} readOnly={!canEdit} />
              {canEdit && <SimilarReleasesPanel view={view} timeZone={timeZone} />}
            </div>
            <div className="gcpe-release-editor__rail">
              <SettingsSection view={view} setView={setView} timeZone={timeZone} readOnly={!canEdit} />
              <SideBar view={view} timeZone={timeZone} />
            </div>
          </div>
          <UnsavedChangesBar
            sections={guard.dirtySections}
            state={guard.saveState}
            onSave={() => void guard.saveAll()}
            targetOf={(key) => unsavedTarget(key, view)}
            // Suite review R7: a save of a published release republishes it (apps/nrms store.ts
            // mutateRelease); one still publishing goes out as it is when the publisher gets to it.
            republishes={view.live && (view.status === "published" || view.status === "publishing")}
          />
        </DirtyKeysProvider>
      </guard.Provider>
    </SaveQueueContext.Provider>
  );
}
