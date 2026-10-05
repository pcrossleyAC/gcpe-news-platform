import { useState } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import type { ReleaseFileView, ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../../api/client";
import { RELOAD_MESSAGE } from "../useReleaseSection";

export interface FilesSectionProps {
  view: ReleaseView;
  setView(v: ReleaseView): void;
  readOnly: boolean;
}

type Kind = "translation" | "asset";

interface GroupState {
  busy: boolean;
  conflict: boolean;
  problems: string[] | null;
  error: string | null;
}
const INITIAL: GroupState = { busy: false, conflict: false, problems: null, error: null };

/** Uploaded translation PDFs and media asset files (task-4-brief.md) — both go through the
 * same raw-body endpoint (`POST .../files?kind=...&version=...&name=...`), which is why this
 * is one component with two groups rather than two separate ones. */
export function FilesSection({ view, setView, readOnly }: FilesSectionProps): React.JSX.Element {
  const [state, setState] = useState<Record<Kind, GroupState>>({ translation: INITIAL, asset: INITIAL });

  const setGroup = (kind: Kind, patch: Partial<GroupState>) => setState((s) => ({ ...s, [kind]: { ...s[kind], ...patch } }));

  const upload = async (kind: Kind, file: File) => {
    setGroup(kind, { ...INITIAL, busy: true });
    try {
      const next = await apiFetch<ReleaseView>(
        `/nrms/api/releases/${view.id}/files?kind=${kind}&version=${view.version}&name=${encodeURIComponent(file.name)}`,
        { method: "POST", raw: file },
      );
      setView(next);
      setGroup(kind, INITIAL);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) setGroup(kind, { busy: false, conflict: true, problems: null, error: null });
      else if (caught instanceof ApiError && caught.status === 422) setGroup(kind, { busy: false, conflict: false, problems: caught.problems ?? [caught.message], error: null });
      else setGroup(kind, { busy: false, conflict: false, problems: null, error: caught instanceof ApiError ? caught.message : "Upload failed." });
    }
  };

  const remove = async (kind: Kind, file: ReleaseFileView) => {
    setGroup(kind, { ...INITIAL, busy: true });
    try {
      const next = await apiFetch<ReleaseView>(`/nrms/api/releases/${view.id}/files/${file.id}/remove`, { method: "POST", body: { version: view.version } });
      setView(next);
      setGroup(kind, INITIAL);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) setGroup(kind, { busy: false, conflict: true, problems: null, error: null });
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
                <Button variant="secondary" onPress={() => void remove(kind, f)} isDisabled={s.busy}>
                  Remove {f.label}
                </Button>
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
