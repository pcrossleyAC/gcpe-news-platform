import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { Button } from "@bcgov/design-system-react-components";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useUnsavedChangesGuard } from "./useUnsavedChanges";
import { HeaderSection } from "./sections/HeaderSection";
import { ActionsSection } from "./sections/ActionsSection";
import { SettingsSection } from "./sections/SettingsSection";
import { CategoriesSection } from "./sections/CategoriesSection";
import { AssetSection } from "./sections/AssetSection";
import { PageDetailsSection } from "./sections/PageDetailsSection";

/**
 * `/hub/releases/:id` (task-3-brief.md): loads the view once, holds it in one piece of state
 * (`view`/`setView`), and renders every section in spec order. Each section saves
 * independently (via its own {@link useReleaseSection} call) and, on success, replaces the
 * *whole* `view` with the server's response — so every other section's `version` field stays
 * current too, even though only one section's fields actually changed.
 *
 * Task 4 adds Documents, Translations/files, History and a side bar to this same page — see the
 * marked slot below — without needing to touch anything above it.
 */
export function ReleaseEditorPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const timeZone = useTenantTimeZone();
  const [view, setView] = useState<ReleaseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const guard = useUnsavedChangesGuard();

  useEffect(() => {
    if (!id) return;
    let active = true;
    setView(null);
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
  }, [id]);

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

  return (
    <guard.Provider>
      <div className="gcpe-release-editor">
        <HeaderSection view={view} />

        {guard.blocker.state === "blocked" && (
          <div role="alertdialog" aria-label="Unsaved changes" className="gcpe-release-editor__unsaved-dialog">
            <p>You have unsaved changes on this page. Leave anyway and discard them?</p>
            <Button onPress={() => guard.blocker.reset?.()}>Stay</Button>
            <Button danger onPress={() => guard.blocker.proceed?.()}>
              Leave
            </Button>
          </div>
        )}

        {canEdit && <ActionsSection view={view} setView={setView} timeZone={timeZone} />}
        <SettingsSection view={view} setView={setView} timeZone={timeZone} readOnly={!canEdit} />
        <CategoriesSection view={view} setView={setView} readOnly={!canEdit} />
        <AssetSection view={view} setView={setView} readOnly={!canEdit} />
        <PageDetailsSection view={view} setView={setView} readOnly={!canEdit} />

        {/* Task 4 adds Documents, Translations/files, History and a side bar here. */}
      </div>
    </guard.Provider>
  );
}
