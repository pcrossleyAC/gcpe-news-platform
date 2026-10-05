import { useCallback, useEffect, useState } from "react";
import { Button, InlineAlert, Switch, TextField } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { canManageWebsite } from "./access";
import { RELOAD_MESSAGE, useVersionedSave } from "./useVersionedSave";
import type { LiveFeedView } from "./types";

/** Server wording (apps/nrms/src/website/settings.ts's saveLiveFeed) — shown client-side too so
 * an editor sees it before submitting, not only after a round trip. */
const M3U_REQUIRED_MESSAGE = "Add the M3U playlist URL before turning the Live Feed on.";

/**
 * `/hub/website/live-feed` (task-5-brief.md): the home page's Live Feed switch and its two
 * URLs. Writes need `NRMS.SiteEditor`.
 */
export function LiveFeedScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle("Live Feed");
  const canManage = canManageWebsite(session);
  const canEdit = session.has("NRMS.SiteEditor");
  const section = useVersionedSave<LiveFeedView>();
  const [feed, setFeed] = useState<LiveFeedView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [manifestUrl, setManifestUrl] = useState("");
  const [m3uUrl, setM3uUrl] = useState("");
  const [clientProblem, setClientProblem] = useState<string | null>(null);

  const resetFrom = (v: LiveFeedView) => {
    setFeed(v);
    setEnabled(v.enabled);
    setManifestUrl(v.manifestUrl);
    setM3uUrl(v.m3uUrl);
  };

  const reload = useCallback(() => {
    apiFetch<LiveFeedView>("/nrms/api/site/live-feed").then(resetFrom, () => setLoadError("Couldn't load the Live Feed settings."));
  }, []);

  // Minors: stays NRMS.SiteEditor/Core.Admin only — defense in depth for a direct deep link,
  // now that WebsiteScreen itself lets every read role through for Featured/Log.
  useEffect(() => {
    if (canManage) reload();
  }, [canManage, reload]);

  if (!canManage) {
    return (
      <div className="gcpe-live-feed">
        <h1>Live Feed</h1>
        <p>You don&rsquo;t have permission to view the Live Feed settings.</p>
      </div>
    );
  }

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setClientProblem(null);
    if (!feed) return;
    if (enabled && !m3uUrl.trim()) {
      setClientProblem(M3U_REQUIRED_MESSAGE);
      return;
    }
    void section.run(() => apiFetch<LiveFeedView>("/nrms/api/site/live-feed", { method: "PUT", body: { version: feed.version, enabled, manifestUrl, m3uUrl } })).then((next) => {
      if (next) resetFrom(next);
    });
  };

  if (loadError) {
    return (
      <div className="gcpe-live-feed">
        <h1>Live Feed</h1>
        <InlineAlert variant="danger" role="alert" description={loadError} />
      </div>
    );
  }
  if (!feed) return <p>Loading…</p>;

  return (
    <div className="gcpe-live-feed">
      <h1>Live Feed</h1>

      {section.conflict && <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} buttons={<Button onPress={reload}>Reload</Button>} />}
      {(clientProblem || section.problems) && (
        <ul role="alert" className="gcpe-release-editor__problems">
          {(clientProblem ? [clientProblem] : section.problems!).map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {section.error && <InlineAlert variant="danger" role="alert" description={section.error} />}

      <form onSubmit={onSubmit} aria-label="Live Feed settings">
        <Switch isSelected={enabled} isDisabled={!canEdit || section.saving} onChange={setEnabled}>
          Live Feed on
        </Switch>
        <TextField label="Manifest URL" value={manifestUrl} onChange={setManifestUrl} isDisabled={!canEdit} />
        <TextField label="M3U URL" value={m3uUrl} onChange={setM3uUrl} isDisabled={!canEdit} />
        {canEdit && (
          <Button type="submit" isDisabled={section.saving}>
            Save Live Feed
          </Button>
        )}
      </form>
    </div>
  );
}
