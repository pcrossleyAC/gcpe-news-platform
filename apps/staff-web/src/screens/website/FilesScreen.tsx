import { useCallback, useEffect, useState } from "react";
import { AlertDialog, DialogTrigger, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { Button } from "../../shared/BusyButton";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { publicFileUrl, usePublicFiles } from "../../shared/publicAddress";
import { canManageWebsite } from "./access";
import type { ListFilesResult, SiteFileView } from "./types";

interface UploadState {
  busy: boolean;
  /** Each file that couldn't be uploaded, with why. */
  errors: string[];
  /** New uploads whose names an existing file has (409), asked about one at a time: the first is
   * the one the replace prompt is showing. */
  conflicts: File[];
}
const INITIAL_UPLOAD: UploadState = { busy: false, errors: [], conflicts: [] };
/** Any type, up to 512 MiB (owner decision 2026-10-29, like the legacy Hub's Files screen). */
const MAX_FILE_BYTES = 512 * 1024 * 1024;

/** Plain wording for a failed upload: the server's 413 and schema-rejection 400 would otherwise show as raw text. */
function uploadMessage(caught: unknown, file: File): string {
  if (caught instanceof ApiError) {
    if (caught.status === 413) return `${file.name}: A file can be at most 512 MB.`;
    if (caught.status === 400 && caught.message === "invalid request") return "The upload wasn't accepted. Reload the page and try again.";
    return caught.message;
  }
  return "Upload failed.";
}

/**
 * `/hub/website/files` (task-5-brief.md): general files served at `/files/<name>`. Writes need
 * `NRMS.SiteEditor`. A new upload whose name collides with an existing file gets a 409
 * (apps/nrms/src/website/files.ts's SiteConflictError) — the brief's "replace prompt": offer to
 * resend the same bytes with `replace=true` rather than silently failing or silently replacing.
 *
 * C332 (QA, legacy's File Management): Upload sits at the top, above hundreds of files, and takes
 * several at once; the list is newest first (the server's order), 50 at a time with Show more.
 */
export function FilesScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle("Files");
  const canManage = canManageWebsite(session);
  const canEdit = session.has("NRMS.SiteEditor");
  const [result, setResult] = useState<ListFilesResult | null>(null);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [upload, setUpload] = useState<UploadState>(INITIAL_UPLOAD);
  const [removeTarget, setRemoveTarget] = useState<SiteFileView | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // W1: addresses to copy are on the public site's base, never the Hub's own (internal) host.
  // Fix round 1 (I3): nothing is shown or copied as "the public address" until it is known.
  const publicFiles = usePublicFiles();
  const addressKnown = publicFiles.status === "ready";
  const addressOf = (f: SiteFileView) => publicFileUrl(f.url, publicFiles.origin);
  const [copyResult, setCopyResult] = useState("");

  const reload = useCallback((query: string) => {
    apiFetch<ListFilesResult>(`/nrms/api/site/files?q=${encodeURIComponent(query)}`).then(
      (r) => {
        setResult(r);
        setPage(1);
      },
      () => setLoadError("Couldn't load files."),
    );
  }, []);

  /** The next 50, newest first, added under the ones shown. */
  const showMore = async () => {
    setLoadingMore(true);
    try {
      const next = await apiFetch<ListFilesResult>(`/nrms/api/site/files?q=${encodeURIComponent(q)}&page=${page + 1}`);
      setResult((r) => (r ? { total: next.total, files: [...r.files, ...next.files.filter((f) => !r.files.some((x) => x.id === f.id))] } : next));
      setPage((p) => p + 1);
    } catch {
      setLoadError("Couldn't load files.");
    } finally {
      setLoadingMore(false);
    }
  };

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

  const send = (file: File, replace: boolean) =>
    apiFetch<SiteFileView>(`/nrms/api/site/files?replace=${replace}`, { method: "POST", raw: file, headers: { "X-GCPE-File-Name": encodeURIComponent(file.name) } });

  /** Uploads the picked files one after another; a name already taken waits for the replace prompt. */
  const uploadAll = async (files: File[]) => {
    const errors: string[] = [];
    const conflicts: File[] = [];
    setUpload({ busy: true, errors: [], conflicts: [] });
    for (const file of files) {
      // The server's cap (apps/nrms/src/website/files.ts MAX_SITE_FILE_BYTES): refused here without sending half a gigabyte first.
      if (file.size > MAX_FILE_BYTES) {
        errors.push(`${file.name}: A file can be at most 512 MB.`);
        continue;
      }
      try {
        await send(file, false);
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 409) conflicts.push(file);
        else errors.push(uploadMessage(caught, file));
      }
    }
    setUpload({ busy: false, errors, conflicts });
    reload(q);
  };

  /** The replace prompt's answer for the file it shows; then the next clash, if any. */
  const answerConflict = async (replace: boolean) => {
    const [file, ...rest] = upload.conflicts;
    if (!file) return;
    if (!replace) return void setUpload((u) => ({ ...u, conflicts: rest }));
    setUpload((u) => ({ ...u, busy: true }));
    try {
      await send(file, true);
      setUpload((u) => ({ ...u, busy: false, conflicts: rest }));
    } catch (caught) {
      setUpload((u) => ({ busy: false, conflicts: rest, errors: [...u.errors, uploadMessage(caught, file)] }));
    }
    reload(q);
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length) void uploadAll(files);
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

  const copyAddress = async (f: SiteFileView) => {
    try {
      if (!addressKnown) return;
      await navigator.clipboard.writeText(addressOf(f));
      setCopyResult(`Copied the public address of ${f.name}.`);
    } catch {
      setCopyResult(`Couldn\u2019t copy. Select the address of ${f.name} and copy it.`);
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

      {canEdit && (
        <section className="gcpe-files__upload" aria-labelledby="files-upload-heading">
          <h2 id="files-upload-heading">Upload files</h2>
          <label>
            Choose one or more files (any type, up to 512 MB each)
            <input type="file" multiple onChange={onPick} disabled={upload.busy} />
          </label>
          <p className="gcpe-hint">
            Any file type, like the old Hub. PDFs, images, Office documents, audio, video and text open in the browser; anything else (a web page, an SVG, a program) is
            downloaded, never shown on the site.
          </p>
          {upload.busy && <p role="status">Uploading&hellip;</p>}
          {upload.errors.length > 0 && (
            <ul role="alert" className="gcpe-release-editor__problems">
              {upload.errors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}

          <Modal isOpen={upload.conflicts.length > 0 && !upload.busy} onOpenChange={(open) => { if (!open) void answerConflict(false); }} isDismissable>
            <AlertDialog
              variant="warning"
              title={`A file named "${upload.conflicts[0]?.name}" already exists`}
              buttons={
                <>
                  <Button onPress={() => void answerConflict(false)}>Keep the existing file</Button>
                  <Button danger onPress={() => void answerConflict(true)}>
                    Replace it
                  </Button>
                </>
              }
            >
              <p>Replace the existing file with this upload?</p>
            </AlertDialog>
          </Modal>
        </section>
      )}


      {removeError && <InlineAlert variant="danger" role="alert" description={removeError} />}
      <p className="gcpe-hint">Each file&rsquo;s public address is shown under its name. Use Copy public address when you paste a file into a slide, a pin, a link or a minister&rsquo;s photo.</p>
      {!addressKnown && (
        <p id="files-address-pending" className="gcpe-hint">
          {publicFiles.status === "loading" ? "Working out the public address\u2026" : "Couldn\u2019t work out the public address. Reload the page."}
        </p>
      )}
      {/* Mounted from the start, empty, so a screen reader hears the first result too. */}
      <p role="status" className="gcpe-hint">
        {copyResult}
      </p>

      <h2>Uploaded files</h2>
      <p className="gcpe-hint">
        Newest first. Showing {result.files.length} of {result.total} {result.total === 1 ? "file" : "files"}.
      </p>
      <ul>
        {result.files.map((f) => (
          <li key={f.id}>
            <span className="gcpe-files__file">
              <a href={addressKnown ? addressOf(f) : f.url}>{f.name}</a>
              {addressKnown && <span className="gcpe-files__address">{addressOf(f)}</span>}
            </span>
            <Button variant="secondary" onPress={() => void copyAddress(f)} isDisabled={!addressKnown} aria-describedby={addressKnown ? undefined : "files-address-pending"}>
              <span>
                Copy public address <span className="gcpe-visually-hidden">of {f.name}</span>
              </span>
            </Button>
            {canEdit && (
              <DialogTrigger isOpen={removeTarget?.id === f.id} onOpenChange={(open) => setRemoveTarget(open ? f : null)}>
                <Button variant="secondary" danger>
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
      {result.files.length < result.total && (
        <Button variant="secondary" onPress={() => void showMore()} isPending={loadingMore}>
          Show more files
        </Button>
      )}

    </div>
  );
}
