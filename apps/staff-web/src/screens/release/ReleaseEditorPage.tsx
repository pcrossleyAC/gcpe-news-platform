import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { AlertDialog, Button, Modal } from "@bcgov/design-system-react-components";
import { statusText, type ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { useAnnouncer } from "../../shared/Announcer";
import { useUnsavedChangesGuard } from "./useUnsavedChanges";
import { UnsavedChangesBar } from "./UnsavedChangesBar";
import { HeaderSection } from "./sections/HeaderSection";
import { ActionsSection } from "./sections/ActionsSection";
import { SettingsSection } from "./sections/SettingsSection";
import { CategoriesSection } from "./sections/CategoriesSection";
import { AssetSection } from "./sections/AssetSection";
import { PageDetailsSection } from "./sections/PageDetailsSection";
import { DocumentsSection } from "./documents/DocumentsSection";
import { FilesSection } from "./documents/FilesSection";
import { SideBar } from "./sidebar/SideBar";
import { SaveQueueContext, useSaveQueueController } from "./saveQueue";

/**
 * `/hub/releases/:id` (task-3-brief.md): loads the view once, holds it in one piece of state
 * (`view`/`setView`), and renders every section in spec order. Each section saves
 * independently (via its own {@link useReleaseSection} call) and, on success, replaces the
 * *whole* `view` with the server's response — so every other section's `version` field stays
 * current too, even though only one section's fields actually changed.
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
  const canEdit = session.has("NRMS.Editor");
  const settling = settlingDelay(view, Date.now()) === SETTLING_REFRESH_MS;

  return (
    <SaveQueueContext.Provider value={saveQueue.queue}>
      <guard.Provider>
        <div className={`gcpe-release-editor${guard.dirtySections.length > 0 ? " gcpe-release-editor--save-bar-open" : ""}`}>
          <HeaderSection view={view} />
          {settling && <p className="gcpe-release-editor__settling">This page updates on its own until the release is done — no need to reload.</p>}

          {/* Fix round 1, finding 2: a real Modal/AlertDialog instead of an inline div — traps
           * focus, restores it on close, and closes on Escape (treated the same as "Stay": the
           * blocker is simply left blocked, so the in-app navigation stays cancelled). */}
          <Modal isOpen={guard.blocker.state === "blocked"} onOpenChange={(open) => { if (!open) guard.blocker.reset?.(); }} isDismissable>
            <AlertDialog
              variant="warning"
              title="Unsaved changes"
              buttons={
                <>
                  <Button onPress={() => guard.blocker.reset?.()}>Stay</Button>
                  <Button danger onPress={() => guard.blocker.proceed?.()}>
                    Leave
                  </Button>
                </>
              }
            >
              <p>You have unsaved changes on this page. Leave anyway and discard them?</p>
            </AlertDialog>
          </Modal>

          {canEdit && <ActionsSection view={view} setView={setView} timeZone={timeZone} />}
          <SettingsSection view={view} setView={setView} timeZone={timeZone} readOnly={!canEdit} />
          <CategoriesSection view={view} setView={setView} readOnly={!canEdit} />
          <AssetSection view={view} setView={setView} readOnly={!canEdit} />
          <PageDetailsSection view={view} setView={setView} readOnly={!canEdit} />
          <DocumentsSection view={view} setView={setView} readOnly={!canEdit} />
          <FilesSection view={view} setView={setView} readOnly={!canEdit} />
          <SideBar view={view} />
        </div>
        <UnsavedChangesBar sections={guard.dirtySections} />
      </guard.Provider>
    </SaveQueueContext.Provider>
  );
}
