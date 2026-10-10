import { useEffect, useRef, useState } from "react";
import { AlertDialog, Button, Modal } from "@bcgov/design-system-react-components";
import { ATTACHMENT_ACCEPT, ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_FILES, type ActivityFileView, type FieldError } from "@gcpe/calendar-contract";
import { ApiError } from "../../../api/client";
import { activityApi } from "./api";

const TOO_BIG = "A file can be at most 25 MB.";
/** The server's own words for a full activity (apps/calendar/src/activities/files.ts). */
const FULL = `An activity holds at most ${ATTACHMENT_MAX_FILES} files. Remove one first.`;
/** A same-name upload replaces the old file. Lenient on purpose: the server has the last word on what counts as the same name. */
const nameKey = (name: string) => name.toLowerCase();
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const day = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));

/**
 * Whether the page says it instead, once: the freeze or a lock (423), the activity gone (404) or
 * deleted (409), or a sign-in (401). A remove's 404 is only the file gone.
 */
const forThePage = (e: unknown, { fileGone }: { fileGone: boolean }) =>
  e instanceof ApiError && (e.status === 423 || e.status === 401 || (e.status === 409 && e.code === "deleted") || (e.status === 404 && !fileGone));

function messageOf(e: unknown): string {
  if (e instanceof ApiError && e.status === 422) return (e.body as { errors?: FieldError[] } | undefined)?.errors?.[0]?.message ?? e.message;
  if (e instanceof ApiError && e.status === 413) return TOO_BIG;
  if (e instanceof ApiError && e.status < 500) return e.message;
  if (e instanceof ApiError) return "The server couldn't do that. Try again.";
  return "Couldn't reach the server. Try again.";
}

/**
 * Records (spec addendum §8.4): each file is added or removed at once, on its own, after the edit
 * lock is taken. A file change doesn't touch the activity's version, so the form's unsaved changes
 * stay as they are. Downloads go through the Calendar's authorised route.
 */
export function RecordsSection({ activityId, files, canChange, beforeChange, onFiles, refused, timeZone }: {
  activityId: number;
  files: readonly ActivityFileView[];
  canChange: boolean;
  /** Takes the edit lock, or keeps it alive; false means the lock's banner has said why not. */
  beforeChange: () => Promise<boolean>;
  onFiles: (files: ActivityFileView[]) => void;
  /** A refusal the page itself shows (the lock's banner, or the activity deleted), so it is said once. */
  refused: (e: unknown) => void;
  timeZone: string;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [removing, setRemoving] = useState<ActivityFileView | null>(null);
  const input = useRef<HTMLInputElement>(null);
  /** Counts completed removes: each moves the keyboard to Add files once the input is enabled again. */
  const [removed, setRemoved] = useState(0);
  useEffect(() => {
    // The file's own Remove button has gone: keep the keyboard in the section.
    if (removed) input.current?.focus();
  }, [removed]);

  const begin = async (): Promise<boolean> => {
    setBusy(true);
    setProblems([]);
    setStatus("");
    if (await beforeChange()) return true;
    setBusy(false);
    return false;
  };

  const add = async (picked: File[]) => {
    if (picked.length === 0 || !(await begin())) return;
    const failed: string[] = [];
    let added = 0;
    // What the activity holds, kept current from each reply: a file past the limit is refused
    // before its bytes are sent, while a same-name replacement still goes.
    let names = new Set(files.map((f) => nameKey(f.fileName)));
    let count = files.length;
    for (const [i, file] of picked.entries()) {
      if (file.size > ATTACHMENT_MAX_BYTES) {
        failed.push(`${file.name}: ${TOO_BIG}`);
        continue;
      }
      if (count >= ATTACHMENT_MAX_FILES && !names.has(nameKey(file.name))) {
        failed.push(`${file.name}: ${FULL}`);
        continue;
      }
      setStatus(picked.length > 1 ? `Adding ${file.name} (${i + 1} of ${picked.length})…` : `Adding ${file.name}…`);
      try {
        const now = await activityApi.addFile(activityId, file);
        onFiles(now);
        names = new Set(now.map((f) => nameKey(f.fileName)));
        count = now.length;
        added++;
      } catch (e) {
        if (forThePage(e, { fileGone: false })) {
          refused(e);
          // The page says why; a batch also needs to know which of its files didn't get in.
          if (picked.length > 1) failed.push(`Not added: ${picked.slice(i).map((f) => f.name).join(", ")}.`);
          break;
        }
        const message = messageOf(e);
        if (message === FULL) count = ATTACHMENT_MAX_FILES;
        failed.push(`${file.name}: ${message}`);
      }
    }
    setBusy(false);
    setProblems(failed);
    setStatus(added ? `Added ${added} file${added === 1 ? "" : "s"}.` : "");
  };

  const remove = async (file: ActivityFileView) => {
    setRemoving(null);
    if (!(await begin())) return;
    setStatus(`Removing ${file.fileName}…`);
    try {
      onFiles(await activityApi.removeFile(activityId, file.id));
      setStatus(`Removed ${file.fileName}.`);
      setRemoved((n) => n + 1);
    } catch (e) {
      setStatus("");
      if (e instanceof ApiError && e.status === 404) {
        // Someone else removed it: what the user wanted has happened.
        onFiles(files.filter((f) => f.id !== file.id));
        setStatus("That file was already removed.");
        setRemoved((n) => n + 1);
      } else if (forThePage(e, { fileGone: true })) refused(e);
      else setProblems([`${file.fileName}: ${messageOf(e)}`]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="gcpe-fieldset gcpe-records">
      <legend>Records</legend>
      {files.length === 0 ? (
        <p>No files yet.</p>
      ) : (
        <ul>
          {files.map((f) => (
            <li key={f.id}>
              <a href={activityApi.fileUrl(activityId, f.id)}>{f.fileName}</a>{" "}
              <span className="gcpe-hint">{`${size(f.length)}, added ${day(f.uploadedAt, timeZone)}${f.uploadedByName ? ` by ${f.uploadedByName}` : ""}`}</span>
              {canChange && (
                <>
                  {" "}
                  <Button variant="secondary" isDisabled={busy} aria-label={`Remove ${f.fileName}`} onPress={() => setRemoving(f)}>
                    Remove
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {canChange && (
        <div className="gcpe-field">
          <label htmlFor="activity-files">Add files</label>
          <input
            ref={input}
            id="activity-files"
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            disabled={busy}
            aria-describedby="activity-files-hint"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              e.target.value = "";
              void add(picked);
            }}
          />
          <span id="activity-files-hint" className="gcpe-hint">
            PDF, PNG, JPEG or GIF images, Word, Excel, PowerPoint, Outlook messages, RTF, text or CSV, up to 25 MB each. A file with the same name replaces the old one.
          </span>
        </div>
      )}
      {/* Always present, so a screen reader hears each change to it. */}
      <p role="status">{status}</p>
      {problems.length > 0 && (
        <div role="alert">
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <Modal isOpen={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }} isDismissable>
        <AlertDialog
          role="alertdialog"
          aria-label={`Remove ${removing?.fileName ?? ""}?`}
          variant="destructive"
          title={`Remove ${removing?.fileName ?? ""}?`}
          buttons={
            <>
              <Button variant="secondary" onPress={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button danger onPress={() => removing && void remove(removing)}>
                Remove
              </Button>
            </>
          }
        >
          <p>The file is deleted from this activity.</p>
        </AlertDialog>
      </Modal>
    </fieldset>
  );
}
