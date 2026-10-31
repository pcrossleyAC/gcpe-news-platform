import { useCallback, useEffect, useRef, useState } from "react";
import { InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { useAnnouncer } from "../../shared/Announcer";
import { Button } from "../../shared/BusyButton";
import { useShortcut } from "../../shared/shortcuts";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { HostWarning } from "../../shared/HostWarning";
import { staffHostWarning, usePublicFilesOrigin } from "../../shared/publicAddress";
import { DragHandle, useDragReorder } from "../../shared/useDragReorder";
import { useMoveFocusRestore } from "../../shared/useMoveFocusRestore";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { canManageWebsite } from "./access";
import { SaveResult, clockTime } from "./SaveResult";
import { moveItemBy, moveItemTo } from "./reorder";
import { RELOAD_MESSAGE, useVersionedSave } from "./useVersionedSave";
import { LeavePageGuard } from "../../shared/LeaveGuard";
import type { LinksView, ResourceLinkView } from "./types";

/** `clientKey` is this form's own stable identity (never sent to the server) — `id` alone
 * can't identify a link that hasn't been saved yet, and a plain array index isn't stable
 * across a reorder (I4 needs an id-shaped key to restore keyboard focus to the moved link's
 * own Move button). */
interface LinkForm {
  clientKey: string;
  id?: string;
  text: string;
  url: string;
}

function toForm(links: ResourceLinkView[]): LinkForm[] {
  return links.map((l) => ({ clientKey: l.id, id: l.id, text: l.text, url: l.url }));
}

/**
 * `/hub/website/links` (task-5-brief.md): the ordered resource-links list. Drag reorder plus
 * the keyboard-operable Move up/down buttons both build the same ordering, saved in one `PUT
 * .../links` with the whole list — same shape as DocumentsSection.tsx's reorder.
 */
export function LinksScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle("Resource links");
  const canManage = canManageWebsite(session);
  const canEdit = session.has("NRMS.SiteEditor");
  const section = useVersionedSave<LinksView>({ quiet: true });
  const timeZone = useTenantTimeZone();
  // W8: what the last save did, on screen.
  const [result, setResult] = useState("");
  const [view, setView] = useState<LinksView | null>(null);
  const [links, setLinks] = useState<LinkForm[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { announce } = useAnnouncer();
  const moveFocus = useMoveFocusRestore<HTMLDivElement>();
  const nextClientKey = useRef(0);
  const publicOrigin = usePublicFilesOrigin();

  const resetFrom = (v: LinksView) => {
    setView(v);
    setLinks(toForm(v.links));
  };

  const reload = useCallback(() => {
    apiFetch<LinksView>("/nrms/api/site/links").then(resetFrom, () => setLoadError("Couldn't load the resource links."));
  }, []);

  // Minors: stays NRMS.SiteEditor/Core.Admin only — defense in depth for a direct deep link,
  // now that WebsiteScreen itself lets every read role through for Featured/Log.
  useEffect(() => {
    if (canManage) reload();
  }, [canManage, reload]);

  // I4: same local-reorder timing as Carousel — restore focus right after the triggering state
  // update re-renders, no network round trip to wait for.
  useEffect(() => {
    moveFocus.restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links]);

  const update = (index: number, patch: Partial<LinkForm>) => setLinks((l) => l.map((link, i) => (i === index ? { ...link, ...patch } : link)));
  const moveUp = (index: number) => {
    moveFocus.remember(links[index]!.clientKey, "up");
    announce(`Link ${index + 1} moved to position ${index}`);
    setLinks((l) => moveItemBy(l, index, -1));
  };
  const moveDown = (index: number) => {
    moveFocus.remember(links[index]!.clientKey, "down");
    announce(`Link ${index + 1} moved to position ${index + 2}`);
    setLinks((l) => moveItemBy(l, index, 1));
  };
  const remove = (index: number) => setLinks((l) => l.filter((_, i) => i !== index));

  const dragReorder = useDragReorder({
    enabled: canEdit && !section.saving,
    onReorder: (from, to) => setLinks((l) => moveItemTo(l, from, to)),
  });

  const save = () => {
    if (!view) return;
    void section
      .run(() => apiFetch<LinksView>("/nrms/api/site/links", { method: "PUT", body: { version: view.version, links: links.map(({ clientKey, ...link }) => link) } }))
      .then((next) => {
        if (!next) return;
        resetFrom(next);
        setResult(`Saved at ${clockTime(new Date(), timeZone)}. Live now: the public home page shows the resource links within a few minutes.`);
      });
  };
  useShortcut("save", canManage && canEdit && view ? () => void (section.saving ? undefined : save()) : null);

  if (!canManage) {
    return (
      <div className="gcpe-links">
        <h1>Resource links</h1>
        <p>You don&rsquo;t have permission to view the resource links.</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="gcpe-links">
        <h1>Resource links</h1>
        <InlineAlert variant="danger" role="alert" description={loadError} />
      </div>
    );
  }
  if (!view) return <p>Loading…</p>;

  return (
    <div className="gcpe-links" ref={moveFocus.containerRef}>
      <h1>Resource links</h1>
      {/* Suite review W9: asks before leaving with links changed, added, removed or moved but not saved. */}
      <LeavePageGuard dirty={canEdit && JSON.stringify(links) !== JSON.stringify(toForm(view.links))} />

      {section.conflict && <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} buttons={<Button onPress={reload}>Reload</Button>} />}
      {section.problems && (
        <ul role="alert" className="gcpe-release-editor__problems">
          {section.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {section.error && <InlineAlert variant="danger" role="alert" description={section.error} />}

      {links.map((link, index) => (
        <div key={link.clientKey} className="gcpe-links__item" {...dragReorder.dropZoneProps(index)}>
          {canEdit && <DragHandle reorder={dragReorder} index={index} label={`Drag to reorder link ${index + 1}`} />}
          <TextField label={`Link ${index + 1} text`} value={link.text} onChange={(v) => update(index, { text: v })} isDisabled={!canEdit} />
          <TextField label={`Link ${index + 1} URL`} value={link.url} onChange={(v) => update(index, { url: v })} isDisabled={!canEdit} aria-describedby={staffHostWarning(link.url, publicOrigin) ? `link-${link.clientKey}-host` : undefined} />
          <HostWarning id={`link-${link.clientKey}-host`} text={staffHostWarning(link.url, publicOrigin)} />
          {canEdit && (
            <>
              <span data-move-id={link.clientKey} data-move-dir="up">
                <Button variant="secondary" onPress={() => moveUp(index)} isDisabled={index === 0} isPending={section.saving}>
                  Move link {index + 1} up
                </Button>
              </span>
              <span data-move-id={link.clientKey} data-move-dir="down">
                <Button variant="secondary" onPress={() => moveDown(index)} isDisabled={index === links.length - 1} isPending={section.saving}>
                  Move link {index + 1} down
                </Button>
              </span>
              <Button variant="secondary" danger onPress={() => remove(index)} isPending={section.saving}>
                Remove link {index + 1}
              </Button>
            </>
          )}
        </div>
      ))}
      {links.length === 0 && <p>No resource links yet.</p>}

      {canEdit && (
        <>
          <Button variant="secondary" onPress={() => setLinks((l) => [...l, { clientKey: `new-${nextClientKey.current++}`, text: "", url: "" }])} isPending={section.saving}>
            Add link
          </Button>
          <Button onPress={save} isPending={section.saving} shortcut="save">
            Save links
          </Button>
        </>
      )}
      <SaveResult text={result} />
    </div>
  );
}
