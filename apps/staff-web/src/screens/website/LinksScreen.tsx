import { useCallback, useEffect, useState } from "react";
import { Button, InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { DragHandle, useDragReorder } from "../../shared/useDragReorder";
import { moveItemBy, moveItemTo } from "./reorder";
import { RELOAD_MESSAGE, useVersionedSave } from "./useVersionedSave";
import type { LinksView, ResourceLinkView } from "./types";

interface LinkForm {
  id?: string;
  text: string;
  url: string;
}

function toForm(links: ResourceLinkView[]): LinkForm[] {
  return links.map((l) => ({ id: l.id, text: l.text, url: l.url }));
}

/**
 * `/hub/website/links` (task-5-brief.md): the ordered resource-links list. Drag reorder plus
 * the keyboard-operable Move up/down buttons both build the same ordering, saved in one `PUT
 * .../links` with the whole list — same shape as DocumentsSection.tsx's reorder.
 */
export function LinksScreen(): React.JSX.Element {
  const session = useSession();
  const canEdit = session.has("NRMS.SiteEditor");
  const section = useVersionedSave<LinksView>();
  const [view, setView] = useState<LinksView | null>(null);
  const [links, setLinks] = useState<LinkForm[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const resetFrom = (v: LinksView) => {
    setView(v);
    setLinks(toForm(v.links));
  };

  const reload = useCallback(() => {
    apiFetch<LinksView>("/nrms/api/site/links").then(resetFrom, () => setLoadError("Couldn't load the resource links."));
  }, []);

  useEffect(reload, [reload]);

  const update = (index: number, patch: Partial<LinkForm>) => setLinks((l) => l.map((link, i) => (i === index ? { ...link, ...patch } : link)));
  const moveUp = (index: number) => setLinks((l) => moveItemBy(l, index, -1));
  const moveDown = (index: number) => setLinks((l) => moveItemBy(l, index, 1));
  const remove = (index: number) => setLinks((l) => l.filter((_, i) => i !== index));

  const dragReorder = useDragReorder({
    enabled: canEdit && !section.saving,
    onReorder: (from, to) => setLinks((l) => moveItemTo(l, from, to)),
  });

  const save = () => {
    if (!view) return;
    void section.run(() => apiFetch<LinksView>("/nrms/api/site/links", { method: "PUT", body: { version: view.version, links } })).then((next) => {
      if (next) resetFrom(next);
    });
  };

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
    <div className="gcpe-links">
      <h1>Resource links</h1>

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
        <div key={link.id ?? `new-${index}`} className="gcpe-links__item" {...dragReorder.dropZoneProps(index)}>
          {canEdit && <DragHandle reorder={dragReorder} index={index} label={`Drag to reorder link ${index + 1}`} />}
          <TextField label={`Link ${index + 1} text`} value={link.text} onChange={(v) => update(index, { text: v })} isDisabled={!canEdit} />
          <TextField label={`Link ${index + 1} URL`} value={link.url} onChange={(v) => update(index, { url: v })} isDisabled={!canEdit} />
          {canEdit && (
            <>
              <Button variant="secondary" onPress={() => moveUp(index)} isDisabled={index === 0 || section.saving}>
                Move link {index + 1} up
              </Button>
              <Button variant="secondary" onPress={() => moveDown(index)} isDisabled={index === links.length - 1 || section.saving}>
                Move link {index + 1} down
              </Button>
              <Button variant="secondary" danger onPress={() => remove(index)} isDisabled={section.saving}>
                Remove link {index + 1}
              </Button>
            </>
          )}
        </div>
      ))}
      {links.length === 0 && <p>No resource links yet.</p>}

      {canEdit && (
        <>
          <Button variant="secondary" onPress={() => setLinks((l) => [...l, { text: "", url: "" }])} isDisabled={section.saving}>
            Add link
          </Button>
          <Button onPress={save} isDisabled={section.saving}>
            Save links
          </Button>
        </>
      )}
    </div>
  );
}
