import { useState } from "react";
import { AlertDialog, Button, DialogTrigger, InlineAlert, Modal } from "@bcgov/design-system-react-components";
import type { ReleaseFileView, ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../../api/client";
import { RELOAD_MESSAGE } from "../useReleaseSection";
import { useSaveQueue, withVersion } from "../saveQueue";
import { SaveStatus } from "../SaveStatus";

export interface FilesSectionProps {
  view: ReleaseView;
  setView(v: ReleaseView): void;
  readOnly: boolean;
}

type Kind = "translation" | "asset";

interface GroupState {
  busy: boolean;
  /** Queued behind another save on the page (saveQueue.tsx); `busy` is also true. */
  waiting: boolean;
  conflict: boolean;
  problems: string[] | null;
  error: string | null;
}
const INITIAL: GroupState = { busy: false, waiting: false, conflict: false, problems: null, error: null };

/** Uploaded translation PDFs and media asset files (task-4-brief.md) — both go through the
 * same raw-body endpoint (`POST .../files?kind=...&version=...&name=...`), which is why this
 * is one component with two groups rather than two separate ones. Both go through the page's
 * save queue like every other section save, with the version read when the request is sent. */
export function FilesSection({ view, setView, readOnly }: FilesSectionProps): React.JSX.Element {
  const [state, setState] = useState<Record<Kind, GroupState>>({ translation: INITIAL, asset: INITIAL });
  const queue = useSaveQueue();
  // Fix round 1, finding 2: a file pending remove confirmation (same AlertDialog pattern as
  // document/translation removal — this used to fire with no confirmation at all).
  const [removeTarget, setRemoveTarget] = useState<{ kind: Kind; file: ReleaseFileView } | null>(null);

  const setGroup = (kind: Kind, patch: Partial<GroupState>) => setState((s) => ({ ...s, [kind]: { ...s[kind], ...patch } }));

  const upload = async (kind: Kind, file: File) => {
    setGroup(kind, { ...INITIAL, busy: true, waiting: true });
    try {
      const next = await queue.run((version) => {
        setGroup(kind, { waiting: false });
        return apiFetch<ReleaseView>(
          `/nrms/api/releases/${view.id}/files?kind=${kind}&version=${version ?? view.version}&name=${encodeURIComponent(file.name)}`,
          { method: "POST", raw: file },
        );
      });
      setView(next);
      setGroup(kind, INITIAL);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) setGroup(kind, { busy: false, conflict: true, problems: null, error: null });
      else if (caught instanceof ApiError && caught.status === 422) setGroup(kind, { busy: false, conflict: false, problems: caught.problems ?? [caught.message], error: null });
      else setGroup(kind, { busy: false, conflict: false, problems: null, error: caught instanceof ApiError ? caught.message : "Upload failed." });
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    const { kind, file } = removeTarget;
    setGroup(kind, { ...INITIAL, busy: true, waiting: true });
    try {
      const next = await queue.run((version) => {
        setGroup(kind, { waiting: false });
        return apiFetch<ReleaseView>(`/nrms/api/releases/${view.id}/files/${file.id}/remove`, { method: "POST", body: withVersion({ version: view.version }, version) });
      });
      setView(next);
      setGroup(kind, INITIAL);
      setRemoveTarget(null);
    } catch (caught) {
      // Fix round 1, finding 2: 422 problems now surface the same way upload's do, instead of
      // falling into the generic `error` message.
      if (caught instanceof ApiError && caught.status === 409) setGroup(kind, { busy: false, conflict: true, problems: null, error: null });
      else if (caught instanceof ApiError && caught.status === 422) setGroup(kind, { busy: false, conflict: false, problems: caught.problems ?? [caught.message], error: null });
      else setGroup(kind, { busy: false, conflict: false, problems: null, error: caught instanceof ApiError ? caught.message : "Remove failed." });
    }
  };

  const onPick = (kind: Kind) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void upload(kind, file);
  };

  const group = (kind: Kind, title: string, accept: string | undefined, inputLabel: string) => {
    const files = view.files.filter((f) => f.kind === kind);
    const s = state[kind];
    return (
      <div className="gcpe-files-section__group">
        <h3>{title}</h3>
        {s.conflict && <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} />}
        {s.problems && (
          <ul role="alert" className="gcpe-release-editor__problems">
            {s.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {s.error && <InlineAlert variant="danger" role="alert" description={s.error} />}
        <ul>
          {files.map((f) => (
            <li key={f.id}>
              <a href={f.url}>{f.label}</a>
              {!readOnly && (
                <DialogTrigger isOpen={removeTarget?.file.id === f.id} onOpenChange={(open) => setRemoveTarget(open ? { kind, file: f } : null)}>
                  <Button variant="secondary" danger isDisabled={s.busy}>
                    Remove {f.label}
                  </Button>
                  <Modal isDismissable>
                    <AlertDialog
                      variant="destructive"
                      title={`Remove ${f.label}?`}
                      buttons={
                        <>
                          <Button onPress={() => setRemoveTarget(null)} isDisabled={s.busy}>
                            Cancel
                          </Button>
                          <Button danger onPress={() => void confirmRemove()} isDisabled={s.busy}>
                            Confirm remove
                          </Button>
                        </>
                      }
                    >
                      <p>This removes the uploaded file. It can&rsquo;t be undone.</p>
                    </AlertDialog>
                  </Modal>
                </DialogTrigger>
              )}
            </li>
          ))}
          {files.length === 0 && <li>No files yet.</li>}
        </ul>
        {!readOnly && (
          <label>
            {inputLabel}
            <input type="file" accept={accept} onChange={onPick(kind)} disabled={s.busy} />
          </label>
        )}
        {!readOnly && <SaveStatus saving={s.busy} waiting={s.waiting} />}
      </div>
    );
  };

  return (
    <section className="gcpe-release-editor__files" aria-label="Files">
      <h2>Files</h2>
      {group("translation", "Translations", "application/pdf", "Upload a translation (PDF)")}
      {group("asset", "Media files", undefined, "Upload a media file")}
    </section>
  );
}
