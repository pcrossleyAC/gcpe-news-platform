import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AlertDialog, Form, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import { LANG_EN, LANG_FR, LAYOUTS, RELEASE_TYPES, TYPE_LABEL, type Layout, type ReleaseType } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { Button } from "../../../shared/BusyButton";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";

const TITLE = "Release page titles";
const TITLE_REQUIRED = "Page title is required.";
const TITLE_PLAIN = "Page title can't contain < or >.";
const ORDER_RANGE = "Order must be a whole number from 0 to 9999.";
const LANGUAGES = [
  { id: LANG_EN, label: "English" },
  { id: LANG_FR, label: "French" },
];
const LAYOUT_LABEL: Record<Layout, string> = { formal: "Formal", informal: "Informal" };

type PageType = { pageTitle: string; languageId: number; releaseType: ReleaseType; sortOrder: number; layout: Layout; pageImageId: string | null };
type PageImage = { id: string; name: string };
type Fields = { pageTitle: string; languageId: number; sortOrder: string; layout: Layout; pageImageId: string };
type Problem = { field: "title" | "language" | "order" | "form"; text: string; stale?: boolean };

/** The server's own 409/400 wording is shown as is; a schema rejection ("invalid request") gets a plain-language line.
 * `stale` means the row was changed or removed elsewhere, so the list should be reloaded. */
function explain(err: unknown): Problem {
  if (err instanceof ApiError) {
    if (err.status === 404) return { field: "form", text: "That page title no longer exists.", stale: true };
    if (err.status === 403) return { field: "form", text: "You don't have permission to change page titles." };
    if (err.status === 409 || err.status === 400) {
      if (err.message !== "invalid request") return { field: "form", text: err.message };
      return { field: "form", text: "Check the page title (1 to 50 characters) and the order (0 to 9999)." };
    }
  }
  return { field: "form", text: "Couldn't save. Try again." };
}

/** Client checks that mirror the server's, so a typing mistake never costs a round trip. */
function check(f: Fields): Problem | null {
  const title = f.pageTitle.trim();
  if (!title) return { field: "title", text: TITLE_REQUIRED };
  if (/[<>]/.test(title)) return { field: "title", text: TITLE_PLAIN };
  if (!LANGUAGES.some((l) => l.id === f.languageId)) return { field: "language", text: "Choose English or French." };
  const n = Number(f.sortOrder);
  if (f.sortOrder.trim() === "" || !Number.isInteger(n) || n < 0 || n > 9999) return { field: "order", text: ORDER_RANGE };
  return null;
}

const body = (f: Fields, releaseType: ReleaseType) => ({
  pageTitle: f.pageTitle.trim(),
  languageId: f.languageId,
  releaseType,
  sortOrder: Number(f.sortOrder),
  layout: f.layout,
  pageImageId: f.pageImageId || null,
});

const rowKey = (r: { languageId: number; pageTitle: string }) => `${r.languageId}/${r.pageTitle}`;

function ErrorAlert({ id, text, wrapperRef }: { id: string; text: string; wrapperRef?: React.RefObject<HTMLDivElement | null> }): React.JSX.Element {
  return (
    <div id={id} tabIndex={-1} ref={wrapperRef}>
      <InlineAlert variant="danger" role="alert" isCloseable={false} description={text} />
    </div>
  );
}

/** `/hub/release-page-titles`: owners edit the page titles a release can choose (News Release, Information Bulletin…)
 * without a developer. Core.Admin only, the role NRMS's page-type writes require. */
export function PageTitlesScreen(): React.JSX.Element {
  useDocumentTitle(TITLE);
  if (!useSession().has("Core.Admin")) {
    return (
      <div className="gcpe-admin__page-titles">
        <h1>{TITLE}</h1>
        <p>You don't have permission to manage release page titles.</p>
      </div>
    );
  }
  return <PageTitlesEditor />;
}

function PageTitlesEditor(): React.JSX.Element {
  const [rows, setRows] = useState<PageType[] | null>(null);
  const [images, setImages] = useState<PageImage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ key: string | null; nonce: number }>({ key: null, nonce: 0 });
  const statusRef = useRef<HTMLParagraphElement>(null);
  // After a delete the row (and its dialog) are gone once the reload lands; only then is the status line a safe place for focus.
  const focusStatusAfterLoad = useRef(false);

  // Only the latest load may land: an earlier, slower one must not put back stale rows.
  const latest = useRef(0);
  const reload = useCallback(() => {
    const seq = ++latest.current;
    apiFetch<PageType[]>("/nrms/api/page-types").then(
      (r) => {
        if (seq !== latest.current) return;
        setRows(r);
        setLoadError(null);
        if (pendingMessage.current) setMessage(pendingMessage.current);
        pendingMessage.current = null;
      },
      () => {
        if (seq === latest.current) setLoadError("Couldn't load the page titles.");
      },
    );
  }, []);
  useEffect(() => {
    reload();
    apiFetch<PageImage[]>("/nrms/api/page-images").then(setImages, () => setImageError("Couldn't load the page images."));
  }, [reload]);
  useEffect(() => {
    if (rows && focusStatusAfterLoad.current) {
      focusStatusAfterLoad.current = false;
      statusRef.current?.focus();
    }
  }, [rows]);

  const saved = (text: string, key: string | null) => {
    setMessage(text);
    setFocus((f) => ({ key, nonce: f.nonce + 1 }));
    reload();
  };
  // A title that vanished is explained in the status line once the reload has removed its row; the row's own alert would go with it.
  const pendingMessage = useRef<string | null>(null);
  const failed = (stale: boolean, text?: string) => {
    setMessage(null);
    if (stale) {
      pendingMessage.current = text ?? null;
      reload();
    }
  };
  const nextOrder = (t: ReleaseType) => Math.max(0, ...(rows ?? []).filter((r) => r.releaseType === t).map((r) => r.sortOrder)) + 1;

  return (
    <div className="gcpe-admin__page-titles">
      <h1>{TITLE}</h1>
      <p>
        These are the page titles a new release can choose, such as News Release or Information Bulletin. The title shows above the headline on the
        public release page. A release keeps the title it was given: to change a published release's title, edit that release.
      </p>
      {loadError && <p role="alert">{loadError}</p>}
      {imageError && <p role="alert">{imageError}</p>}
      <p role="status" tabIndex={-1} ref={statusRef}>
        {message}
      </p>
      {rows === null && !loadError && <p>Loading…</p>}
      {rows &&
        RELEASE_TYPES.map((t) => {
          const mine = rows.filter((r) => r.releaseType === t);
          return (
            <section key={t}>
              <h2>{TYPE_LABEL[t]}</h2>
              {mine.length === 0 ? (
                <p>No page titles yet.</p>
              ) : (
                <table aria-label={`${TYPE_LABEL[t]} page titles`} className="gcpe-table">
                  <thead>
                    <tr>
                      <th scope="col">Page title</th>
                      <th scope="col">Language</th>
                      <th scope="col">Order</th>
                      <th scope="col">Layout</th>
                      <th scope="col">Page image</th>
                      <th scope="col">Save</th>
                      <th scope="col">Delete</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mine.map((r) => (
                      <TitleRow
                        key={rowKey(r)}
                        record={r}
                        images={images}
                        focusNonce={focus.key === rowKey(r) ? focus.nonce : 0}
                        onSaved={saved}
                        onFailed={failed}
                        onDeleted={(text) => {
                          focusStatusAfterLoad.current = true;
                          saved(text, null);
                        }}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
      <AddForm images={images} ready={rows !== null} nextOrder={nextOrder} onAdded={saved} onFailed={failed} />
    </div>
  );
}


/** Option lists shared by a row and the Add form. A page image that is no longer active stays selectable so a save doesn't silently drop it. */
function LanguageOptions({ current }: { current: number }): React.JSX.Element {
  return (
    <>
      {!LANGUAGES.some((l) => l.id === current) && <option value={current}>{`Other language (${current})`}</option>}
      {LANGUAGES.map((l) => (
        <option key={l.id} value={l.id}>
          {l.label}
        </option>
      ))}
    </>
  );
}
function LayoutOptions(): React.JSX.Element {
  return (
    <>
      {LAYOUTS.map((l) => (
        <option key={l} value={l}>
          {LAYOUT_LABEL[l]}
        </option>
      ))}
    </>
  );
}
function ImageOptions({ images, current }: { images: PageImage[]; current: string }): React.JSX.Element {
  return (
    <>
      <option value="">None</option>
      {current !== "" && !images.some((i) => i.id === current) && <option value={current}>Current image (no longer available)</option>}
      {images.map((i) => (
        <option key={i.id} value={i.id}>
          {i.name}
        </option>
      ))}
    </>
  );
}

function TitleRow({
  record, images, focusNonce, onSaved, onFailed, onDeleted,
}: {
  record: PageType;
  images: PageImage[];
  focusNonce: number;
  onSaved(text: string, focusKey: string): void;
  onFailed(stale: boolean, text?: string): void;
  onDeleted(text: string): void;
}): React.JSX.Element {
  const [f, setF] = useState<Fields>({
    pageTitle: record.pageTitle, languageId: record.languageId, sortOrder: String(record.sortOrder), layout: record.layout, pageImageId: record.pageImageId ?? "",
  });
  const [error, setError] = useState<Problem | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const rowEl = useRef<HTMLTableRowElement>(null);
  const errorId = useId();
  const set = (p: Partial<Fields>) => setF((x) => ({ ...x, ...p }));
  // The row's identity on the server. A successful rename moves it at once, so a quick second Save targets the new title, not a 404.
  const [ident, setIdent] = useState({ pageTitle: record.pageTitle, languageId: record.languageId });
  const alertEl = useRef<HTMLDivElement>(null);
  const focusAlert = useRef(false);
  const name = ident.pageTitle;
  const url = `/nrms/api/page-types/${ident.languageId}/${encodeURIComponent(ident.pageTitle)}`;

  useEffect(() => {
    if (focusNonce > 0) rowEl.current?.querySelector<HTMLInputElement>("input[type=text]")?.focus();
  }, [focusNonce]);

  const show = (e: Problem) => {
    setError(e);
    if (e.field === "title") rowEl.current?.querySelector<HTMLInputElement>("input[type=text]")?.focus();
    else if (e.field === "order") rowEl.current?.querySelector<HTMLInputElement>("input[type=number]")?.focus();
    else if (e.field === "language") rowEl.current?.querySelector<HTMLSelectElement>("select")?.focus();
  };
  // Once the delete dialog has unmounted, focus goes to the row's alert so the failure is read out in place.
  useEffect(() => {
    if (!error || !focusAlert.current) return;
    focusAlert.current = false;
    const id = requestAnimationFrame(() => alertEl.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [error]);
  const run = async (action: () => Promise<void>, inDialog = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      const problem = explain(err);
      setConfirmDelete(false);
      onFailed(problem.stale === true, problem.text);
      if (problem.stale) return;
      if (inDialog) {
        focusAlert.current = true;
        setError(problem);
      } else {
        // A save error that isn't about Order goes back to the title field, as on the Add form.
        show(problem.field === "form" ? { ...problem, field: "title" } : problem);
        setError(problem);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const save = () => {
    const invalid = check(f);
    if (invalid) return show(invalid);
    return run(async () => {
      const saved = await apiFetch<Partial<PageType> | undefined>(url, { method: "PUT", body: body(f, record.releaseType) });
      setIdent({ pageTitle: saved?.pageTitle ?? f.pageTitle.trim(), languageId: saved?.languageId ?? f.languageId });
      onSaved(`Saved ${f.pageTitle.trim()}.`, rowKey({ languageId: f.languageId, pageTitle: f.pageTitle.trim() }));
    });
  };
  const remove = () =>
    run(async () => {
      await apiFetch(url, { method: "DELETE" });
      setConfirmDelete(false);
      onDeleted(`Deleted ${name}.`);
    }, true);

  const described = (field: Problem["field"]) => (error && (error.field === field || (field === "title" && error.field === "form")) ? errorId : undefined);

  return (
    <tr ref={rowEl}>
      <td>
        <TextField
          aria-label={`Page title for ${name}`}
          value={f.pageTitle}
          onChange={(v) => set({ pageTitle: v })}
          maxLength={50}
          isInvalid={error?.field === "title"}
          aria-describedby={described("title")}
        />
      </td>
      <td>
        <select
          aria-label={`Language for ${name}`}
          value={f.languageId}
          aria-invalid={error?.field === "language" || undefined}
          aria-describedby={described("language")}
          onChange={(e) => set({ languageId: Number(e.target.value) })}>
          <LanguageOptions current={f.languageId} />
        </select>
      </td>
      <td>
        <input
          type="number"
          aria-label={`Order for ${name}`}
          value={f.sortOrder}
          onChange={(e) => set({ sortOrder: e.target.value })}
          aria-invalid={error?.field === "order" || undefined}
          aria-describedby={described("order")}
        />
      </td>
      <td>
        <select aria-label={`Layout for ${name}`} value={f.layout} onChange={(e) => set({ layout: e.target.value as Layout })}>
          <LayoutOptions />
        </select>
      </td>
      <td>
        <select aria-label={`Page image for ${name}`} value={f.pageImageId} onChange={(e) => set({ pageImageId: e.target.value })}>
          <ImageOptions images={images} current={f.pageImageId} />
        </select>
      </td>
      <td>
        <Button variant="secondary" isPending={busy} onPress={() => void save()}>
          <span>
            Save <span className="gcpe-visually-hidden">{name}</span>
          </span>
        </Button>
        {error && <ErrorAlert id={errorId} text={error.text} wrapperRef={alertEl} />}
      </td>
      <td>
        <Button variant="secondary" isDisabled={busy} onPress={() => setConfirmDelete(true)}>
          <span>
            Delete <span className="gcpe-visually-hidden">{name}</span>
          </span>
        </Button>
        {confirmDelete && (
          <Modal isOpen onOpenChange={(open) => { if (!open) setConfirmDelete(false); }} isDismissable>
            <AlertDialog
              role="alertdialog"
              variant="warning"
              title={`Delete ${name}?`}
              buttons={
                <>
                  <Button onPress={() => setConfirmDelete(false)} isPending={busy}>
                    Cancel
                  </Button>
                  <Button onPress={() => void remove()} isPending={busy}>
                    Delete
                  </Button>
                </>
              }
            >
              <p>New releases can no longer choose it. Releases that already use it keep it.</p>
            </AlertDialog>
          </Modal>
        )}
      </td>
    </tr>
  );
}

function AddForm({
  images, ready, nextOrder, onAdded, onFailed,
}: {
  images: PageImage[];
  ready: boolean;
  nextOrder(t: ReleaseType): number;
  onAdded(text: string, focusKey: string): void;
  onFailed(stale: boolean, text?: string): void;
}): React.JSX.Element {
  const [type, setType] = useState<ReleaseType>("release");
  const [f, setF] = useState<Fields>({ pageTitle: "", languageId: LANG_EN, sortOrder: "", layout: "formal", pageImageId: "" });
  const [orderEdited, setOrderEdited] = useState(false);
  const [error, setError] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const formEl = useRef<HTMLFormElement | null>(null);
  const ids = useId();
  const errorId = `${ids}-error`;
  const set = (p: Partial<Fields>) => setF((x) => ({ ...x, ...p }));
  const order = orderEdited ? f.sortOrder : String(nextOrder(type));

  const fail = (e: Problem) => {
    setError(e);
    const sel = e.field === "order" ? "input[type=number]" : "input[type=text]";
    formEl.current?.querySelector<HTMLInputElement>(sel)?.focus();
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    formEl.current = e.currentTarget;
    if (busyRef.current) return;
    const fields = { ...f, sortOrder: order };
    const invalid = check(fields);
    if (invalid) return fail(invalid);
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/nrms/api/page-types", { method: "POST", body: body(fields, type) });
      const title = fields.pageTitle.trim();
      set({ pageTitle: "" });
      setOrderEdited(false);
      onAdded(`Added ${title}.`, rowKey({ languageId: fields.languageId, pageTitle: title }));
    } catch (err) {
      onFailed(false);
      fail(explain(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const describedTitle = error && error.field !== "order" ? errorId : undefined;
  return (
    <>
      <h2>Add a page title</h2>
      <Form onSubmit={(e) => void onSubmit(e)} aria-label="Add a page title" className="gcpe-field-row">
        <div>
          <label htmlFor={`${ids}-type`}>Type</label>
          <select id={`${ids}-type`} value={type} onChange={(e) => setType(e.target.value as ReleaseType)}>
            {RELEASE_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <TextField
          label="Page title"
          name="pageTitle"
          value={f.pageTitle}
          onChange={(v) => set({ pageTitle: v })}
          maxLength={50}
          isInvalid={error !== null && error.field !== "order"}
          aria-describedby={describedTitle}
        />
        <div>
          <label htmlFor={`${ids}-language`}>Language</label>
          <select id={`${ids}-language`} value={f.languageId} onChange={(e) => set({ languageId: Number(e.target.value) })}>
            <LanguageOptions current={f.languageId} />
          </select>
        </div>
        <div>
          <label htmlFor={`${ids}-order`}>Order</label>
          <input
            id={`${ids}-order`}
            type="number"
            value={order}
            onChange={(e) => {
              setOrderEdited(true);
              set({ sortOrder: e.target.value });
            }}
            aria-invalid={error?.field === "order" || undefined}
            aria-describedby={error?.field === "order" ? errorId : undefined}
          />
        </div>
        <div>
          <label htmlFor={`${ids}-layout`}>Layout</label>
          <select id={`${ids}-layout`} value={f.layout} onChange={(e) => set({ layout: e.target.value as Layout })}>
            <LayoutOptions />
          </select>
        </div>
        <div>
          <label htmlFor={`${ids}-image`}>Page image</label>
          <select id={`${ids}-image`} value={f.pageImageId} onChange={(e) => set({ pageImageId: e.target.value })}>
            <ImageOptions images={images} current={f.pageImageId} />
          </select>
        </div>
        <Button type="submit" isPending={busy} isDisabled={!ready} pendingLabel="Adding…">
          Add page title
        </Button>
      </Form>
      {error && <ErrorAlert id={errorId} text={error.text} />}
    </>
  );
}
