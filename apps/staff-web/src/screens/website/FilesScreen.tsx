import { useCallback, useEffect, useState } from "react";
import { AlertDialog, Button, DialogTrigger, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { canManageWebsite } from "./access";
import type { ListFilesResult, SiteFileView } from "./types";

interface UploadState {
  busy: boolean;
  error: string | null;
  /** A new upload collided with an existing file name (409) — offer to replace it. */
  replacePrompt: File | null;
}
const INITIAL_UPLOAD: UploadState = { busy: false, error: null, replacePrompt: null };

/**
 * `/hub/website/files` (task-5-brief.md): general files served at `/files/<name>`. Writes need
 * `NRMS.SiteEditor`. A new upload whose name collides with an existing file gets a 409
 * (apps/nrms/src/website/files.ts's SiteConflictError) — the brief's "replace prompt": offer to
 * resend the same bytes with `replace=true` rather than silently failing or silently replacing.
 */
export function FilesScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle("Files");
  const canManage = canManageWebsite(session);
  const canEdit = session.has("NRMS.SiteEditor");
  const [result, setResult] = useState<ListFilesResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [upload, setUpload] = useState<UploadState>(INITIAL_UPLOAD);
  const [removeTarget, setRemoveTarget] = useState<SiteFileView | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const reload = useCallback((query: string) => {
    apiFetch<ListFilesResult>(`/nrms/api/site/files?q=${encodeURIComponent(query)}`).then(setResult, () => setLoadError("Couldn't load files."));
  }, []);

  // Minors: stays NRMS.SiteEditor/Core.Admin only — defense in depth for a direct deep link,
  // now that WebsiteScreen itself lets every read role through for Featured/Log.
  useEffect(() => {
    if (canManage) reload("");
  }, [canManage, reload]);

  if (!canManage) {
    return (
      <div className="gcpe-files">
        <h1>Files</h1>
        <p>You don&rsquo;t have permission to view the files.</p>
      </div>
    );
  }

  const onSearch = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    reload(q);
  };

  const doUpload = async (file: File, replace: boolean) => {
    setUpload({ busy: true, error: null, replacePrompt: null });
    try {
      await apiFetch<SiteFileView>(`/nrms/api/site/files?name=${encodeURIComponent(file.name)}&replace=${replace}`, { method: "POST", raw: file });
      setUpload(INITIAL_UPLOAD);
      reload(q);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setUpload({ busy: false, error: null, replacePrompt: file });
      } else {
        setUpload({ busy: false, error: caught instanceof ApiError ? caught.message : "Upload failed.", replacePrompt: null });
      }
    }
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void doUpload(file, false);
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    setRemoveError(null);
    try {
      await apiFetch(`/nrms/api/site/files/${removeTarget.id}`, { method: "DELETE" });
      setRemoveTarget(null);
      reload(q);
    } catch (caught) {
      setRemoveError(caught instanceof ApiError ? caught.message : "Delete failed.");
    }
  };

  if (loadError) {
    return (
      <div className="gcpe-files">
        <h1>Files</h1>
        <InlineAlert variant="danger" role="alert" description={loadError} />
      </div>
    );
  }
  if (!result) return <p>Loading…</p>;

  return (
    <div className="gcpe-files">
      <h1>Files</h1>

      <form onSubmit={onSearch} role="search" aria-label="Search files">
        <TextField label="Search files" value={q} onChange={setQ} />
        <Button type="submit">Search</Button>
      </form>

      {upload.error && <InlineAlert variant="danger" role="alert" description={upload.error} />}
      {removeError && <InlineAlert variant="danger" role="alert" description={removeError} />}

      <ul>
        {result.files.map((f) => (
          <li key={f.id}>
            <a href={f.url}>{f.name}</a>
            {canEdit && (
              <DialogTrigger isOpen={removeTarget?.id === f.id} onOpenChange={(open) => setRemoveTarget(open ? f : null)}>
                <Button variant="secondary" danger isDisabled={upload.busy}>
                  Delete {f.name}
                </Button>
                <Modal isDismissable>
                  <AlertDialog
                    variant="destructive"
                    title={`Delete ${f.name}?`}
                    buttons={
                      <>
                        <Button onPress={() => setRemoveTarget(null)}>Cancel</Button>
                        <Button danger onPress={() => void confirmRemove()}>
                          Confirm delete
                        </Button>
                      </>
                    }
                  >
                    <p>This deletes the file from the public site. It can&rsquo;t be undone.</p>
                  </AlertDialog>
                </Modal>
              </DialogTrigger>
            )}
          </li>
        ))}
        {result.files.length === 0 && <li>No files found.</li>}
      </ul>

      {canEdit && (
        <>
          <label>
            Upload a file (PDF, PNG or JPEG)
            <input type="file" accept="application/pdf,image/png,image/jpeg" onChange={onPick} disabled={upload.busy} />
          </label>

          <Modal isOpen={upload.replacePrompt !== null} onOpenChange={(open) => { if (!open) setUpload(INITIAL_UPLOAD); }} isDismissable>
            <AlertDialog
              variant="warning"
              title={`A file named "${upload.replacePrompt?.name}" already exists`}
              buttons={
                <>
                  <Button onPress={() => setUpload(INITIAL_UPLOAD)}>Cancel</Button>
                  <Button
                    danger
                    onPress={() => {
                      if (upload.replacePrompt) void doUpload(upload.replacePrompt, true);
                    }}
                  >
                    Replace it
                  </Button>
                </>
              }
            >
              <p>Replace the existing file with this upload?</p>
            </AlertDialog>
          </Modal>
        </>
      )}
    </div>
  );
}
