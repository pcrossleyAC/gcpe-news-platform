import { useCallback, useEffect, useRef, useState } from "react";
import { AlertDialog, DialogTrigger, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { formatWhen } from "../../format/dates";
import { useAnnouncer } from "../../shared/Announcer";
import { Button } from "../../shared/BusyButton";
import { useShortcut } from "../../shared/shortcuts";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { DragHandle, useDragReorder } from "../../shared/useDragReorder";
import { useMoveFocusRestore } from "../../shared/useMoveFocusRestore";
import { HiddenPrefixLabel } from "../../shared/ShortLabel";
import { SchedulePicker, type ScheduleValue } from "../release/sections/SchedulePicker";
import { canManageWebsite } from "./access";
import { IMAGE_TOO_BIG, MAX_IMAGE_BYTES, imageUploadMessage, slideAddressErrors } from "./slideChecks";
import { moveItemBy, moveItemTo } from "./reorder";
import { RELOAD_MESSAGE, useVersionedSave } from "./useVersionedSave";
import type { CarouselsResponse, CarouselView, SlideView } from "./types";

/** A slide's editable fields, as the slides-order PUT (saveCarouselSchema) takes them — `id`
 * omitted means "a new slide", same convention as Documents' reorder. `clientKey` is this
 * form's own stable identity (never sent to the server): `id` alone can't identify a slide
 * that hasn't been saved yet, and a plain array index isn't stable across a reorder (I4 needs
 * an id-shaped key to restore keyboard focus to the moved slide's own Move button). */
interface SlideForm {
  clientKey: string;
  id?: string;
  headline: string;
  summary: string;
  actionUrl: string;
  actionLabel: string;
  facebookPostUrl: string;
  justify: "left" | "right";
  /** Audit #9: an image chosen for this slide, staged on the server, set by the next Save/Publish. */
  imageUpload?: string;
  /** The chosen file's name, shown beside it (never sent). */
  imageName?: string;
}

function toForm(slides: SlideView[]): SlideForm[] {
  return slides.map((s) => ({ clientKey: s.id, id: s.id, headline: s.headline, summary: s.summary, actionUrl: s.actionUrl, actionLabel: s.actionLabel, facebookPostUrl: s.facebookPostUrl, justify: s.justify }));
}

interface SlideEditorProps {
  carousel: CarouselView;
  canEdit: boolean;
  /** Only the "next" carousel's go-live time can usefully be changed here. */
  allowGoLiveEdit: boolean;
  timeZone: string;
  onSaved(): void;
}

/** One carousel's slide list — shared by the live and next cards (past carousels use a
 * read-only renderer instead, below). Both drag reorder and the keyboard Move up/down buttons
 * end up building the same full `slides` array (constraints.md: every drag needs a keyboard
 * alternative), and a single Save sends the whole list plus (optionally) a new go-live time in
 * one `PUT .../carousels/:id`. */
function SlideEditor({ carousel, canEdit, allowGoLiveEdit, timeZone, onSaved }: SlideEditorProps): React.JSX.Element {
  const section = useVersionedSave<CarouselView>();
  const [slides, setSlides] = useState<SlideForm[]>(() => toForm(carousel.slides));
  const [goLive, setGoLive] = useState<ScheduleValue | null>(null);
  const [removeIndex, setRemoveIndex] = useState<number | null>(null);
  // Owner decision 2026-10-29: the live carousel is the public home page, so saving it is
  // publishing — its button says so and asks first. The next carousel's Save stays as it was.
  const isLive = carousel.state === "live";
  const [publishOpen, setPublishOpen] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  // Images being staged: Save/Publish wait for them, so a chosen image can't be left behind.
  const [staging, setStaging] = useState(0);
  const busy = section.saving || staging > 0;
  const [addressErrors, setAddressErrors] = useState<Record<string, { actionUrl?: string; facebookPostUrl?: string }>>({});
  const addressProblems = slides.flatMap((slide, i) => Object.values(addressErrors[slide.clientKey] ?? {}).map((m) => `Slide ${i + 1}: ${m}`));
  const { announce } = useAnnouncer();
  const moveFocus = useMoveFocusRestore<HTMLDivElement>();
  const nextClientKey = useRef(0);

  // I4: local reorders (unlike Documents, moving a slide isn't saved until "Save carousel" or, on the live card, "Publish carousel changes")
  // re-render synchronously, so restoring focus right after the triggering state update (in an
  // effect keyed on `slides`) is enough — no need to wait on a network round trip.
  useEffect(() => {
    moveFocus.restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slides]);

  const update = (index: number, patch: Partial<SlideForm>) => setSlides((s) => s.map((slide, i) => (i === index ? { ...slide, ...patch } : slide)));
  const moveUp = (index: number) => {
    moveFocus.remember(slides[index]!.clientKey, "up");
    announce(`Slide ${index + 1} moved to position ${index}`);
    setSlides((s) => moveItemBy(s, index, -1));
  };
  const moveDown = (index: number) => {
    moveFocus.remember(slides[index]!.clientKey, "down");
    announce(`Slide ${index + 1} moved to position ${index + 2}`);
    setSlides((s) => moveItemBy(s, index, 1));
  };

  const dragReorder = useDragReorder({
    enabled: canEdit && !section.saving,
    onReorder: (from, to) => setSlides((s) => moveItemTo(s, from, to)),
  });

  const save = () => {
    const found = Object.fromEntries(slides.map((slide) => [slide.clientKey, slideAddressErrors(slide)]));
    setAddressErrors(found);
    if (Object.values(found).some((e) => Object.keys(e).length > 0)) {
      setPublishOpen(false);
      return;
    }
    void section
      .run(() =>
        apiFetch<CarouselView>(`/nrms/api/site/carousels/${carousel.id}`, {
          method: "PUT",
          body: {
            version: carousel.version,
            ...(allowGoLiveEdit && goLive ? { goLiveAtLocal: goLive.local } : {}),
            slides: slides.map(({ clientKey, imageName, ...slide }) => slide),
          },
        }),
      )
      .then((next) => {
        // Closed either way: a failure's message shows on the card, which the dialog would cover.
        setPublishOpen(false);
        if (next) onSaved();
      });
  };

  // ⌘/Ctrl+S saves the next carousel you're in. Not the live one: saving it publishes, which
  // keeps its own button and confirmation.
  useShortcut("save", canEdit && !isLive ? () => void (busy ? undefined : save()) : null, { within: moveFocus.containerRef });

  const confirmRemove = () => {
    if (removeIndex === null) return;
    setSlides((s) => s.filter((_, i) => i !== removeIndex));
    setRemoveIndex(null);
  };

  // Audit #9 (owner decision 2026-10-31): choosing an image only stages it. The slide gets it
  // with the carousel's Save, or on the live carousel with the confirmed Publish, so a new slide
  // can have its image before it goes live and no image reaches the home page unconfirmed.
  const chooseImage = async (clientKey: string, file: File) => {
    setImageError(null);
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError(IMAGE_TOO_BIG);
      return;
    }
    setStaging((n) => n + 1);
    try {
      const { upload } = await apiFetch<{ upload: string }>("/nrms/api/site/slide-images", { method: "POST", raw: file });
      setSlides((s) => s.map((slide) => (slide.clientKey === clientKey ? { ...slide, imageUpload: upload, imageName: file.name } : slide)));
    } catch (caught) {
      setImageError(imageUploadMessage(caught));
    } finally {
      setStaging((n) => n - 1);
    }
  };
  const imageWhen = isLive ? "goes live when you publish the carousel changes" : "is saved when you save the carousel";

  return (
    <div className="gcpe-carousel__slides" ref={moveFocus.containerRef}>
      {section.conflict && <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} buttons={<Button onPress={onSaved}>Reload</Button>} />}
      {section.problems && (
        <ul role="alert" className="gcpe-release-editor__problems">
          {section.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {addressProblems.length > 0 && (
        <div role="alert">
          <ul className="gcpe-release-editor__problems">
          {addressProblems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        </div>
      )}
      {section.error && <InlineAlert variant="danger" role="alert" description={section.error} />}
      {imageError && <InlineAlert variant="danger" role="alert" description={imageError} />}

      {allowGoLiveEdit && (
        <SchedulePicker timeZone={timeZone} legend="Go live at (BC time)" idPrefix={`carousel-${carousel.id}-golive`} onChange={setGoLive} />
      )}

      {slides.map((slide, index) => {
        const n = index + 1;
        const prefix = `Slide ${n}`;
        // TextField types `label` as a string, but renders it as the label's content: the visible
        // label drops the "Slide N" the card heading already shows; the accessible name keeps it.
        const label = (text: string) => (<HiddenPrefixLabel prefix={prefix} text={text} />) as unknown as string;
        const imageUrl = carousel.slides.find((s) => s.id === slide.id)?.imageUrl;
        return (
          <div key={slide.clientKey} className="gcpe-carousel__slide" {...dragReorder.dropZoneProps(index)}>
            <div className="gcpe-carousel__slide-head">
              {canEdit && <DragHandle reorder={dragReorder} index={index} label={`Drag to reorder slide ${n}`} />}
              <h3>Slide {n}</h3>
              {canEdit && (
                <div className="gcpe-carousel__slide-tools">
                  <span data-move-id={slide.clientKey} data-move-dir="up">
                    <Button size="small" variant="secondary" onPress={() => moveUp(index)} isDisabled={index === 0} isPending={section.saving}>
                      <span>
                        Move <span className="gcpe-visually-hidden">slide {n}</span> up
                      </span>
                    </Button>
                  </span>
                  <span data-move-id={slide.clientKey} data-move-dir="down">
                    <Button size="small" variant="secondary" onPress={() => moveDown(index)} isDisabled={index === slides.length - 1} isPending={section.saving}>
                      <span>
                        Move <span className="gcpe-visually-hidden">slide {n}</span> down
                      </span>
                    </Button>
                  </span>
                  <DialogTrigger isOpen={removeIndex === index} onOpenChange={(open) => setRemoveIndex(open ? index : null)}>
                    <Button size="small" variant="secondary" danger isPending={section.saving}>
                      <span>
                        Remove <span className="gcpe-visually-hidden">slide {n}</span>
                      </span>
                    </Button>
                    <Modal isDismissable>
                      <AlertDialog
                        variant="destructive"
                        title={`Remove slide ${n}?`}
                        buttons={
                          <>
                            <Button onPress={() => setRemoveIndex(null)}>Cancel</Button>
                            <Button danger onPress={confirmRemove}>
                              Confirm remove
                            </Button>
                          </>
                        }
                      >
                        <p>{isLive ? "This removes the slide from the live carousel once you publish the carousel changes." : "This removes the slide from this carousel. Save to commit the change."}</p>
                      </AlertDialog>
                    </Modal>
                  </DialogTrigger>
                </div>
              )}
            </div>
            <div className="gcpe-carousel__slide-fields">
              <TextField label={label("headline")} value={slide.headline} onChange={(v) => update(index, { headline: v })} isDisabled={!canEdit} />
              <TextField label={label("summary")} value={slide.summary} onChange={(v) => update(index, { summary: v })} isDisabled={!canEdit} />
              <TextField label={label("action URL")} value={slide.actionUrl} onChange={(v) => update(index, { actionUrl: v })} isDisabled={!canEdit} isInvalid={addressErrors[slide.clientKey]?.actionUrl !== undefined} errorMessage={addressErrors[slide.clientKey]?.actionUrl} />
              <TextField label={label("action label")} description="The link text. Leave empty for the default set in Navigation and labels." value={slide.actionLabel} onChange={(v) => update(index, { actionLabel: v })} isDisabled={!canEdit} />
              <TextField label={label("Facebook post URL")} value={slide.facebookPostUrl} onChange={(v) => update(index, { facebookPostUrl: v })} isDisabled={!canEdit} isInvalid={addressErrors[slide.clientKey]?.facebookPostUrl !== undefined} errorMessage={addressErrors[slide.clientKey]?.facebookPostUrl} />
              <div className="gcpe-field">
                <label htmlFor={`slide-${slide.clientKey}-justify`}>
                  <HiddenPrefixLabel prefix={prefix} text="justify" />
                </label>
                <select id={`slide-${slide.clientKey}-justify`} value={slide.justify} onChange={(e) => update(index, { justify: e.target.value as "left" | "right" })} disabled={!canEdit}>
                  <option value="left">Left</option>
                  <option value="right">Right</option>
                </select>
              </div>
              {(canEdit || imageUrl) && (
                <div className="gcpe-carousel__image">
                  {canEdit && (
                    <>
                      <label className="gcpe-file-input">
                        <span>
                          <HiddenPrefixLabel prefix={prefix} text="image (JPEG or PNG, up to 2 MB)" />
                        </span>
                        <input
                          type="file"
                          accept="image/png,image/jpeg"
                          aria-describedby={`slide-${slide.clientKey}-image-hint`}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = "";
                            if (file) void chooseImage(slide.clientKey, file);
                          }}
                        />
                      </label>
                      <p className="gcpe-hint" id={`slide-${slide.clientKey}-image-hint`}>
                        {slide.imageName ? `New image chosen: ${slide.imageName}. It ${imageWhen}.` : `The image ${imageWhen}.`}
                      </p>
                    </>
                  )}
                  {imageUrl && <img src={imageUrl} alt={isLive ? `${prefix} image now live` : `${prefix} saved image`} width={160} />}
                </div>
              )}
            </div>
          </div>
        );
      })}

      <div className="gcpe-actions gcpe-carousel__actions">
      {canEdit && (
        <Button
          variant="secondary"
          onPress={() => setSlides((s) => [...s, { clientKey: `new-${nextClientKey.current++}`, headline: "", summary: "", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "left" }])}
          isPending={section.saving}
        >
          Add slide
        </Button>
      )}
      {canEdit && !isLive && (
        <Button onPress={save} isPending={busy} shortcut="save">
          Save carousel
        </Button>
      )}
      {canEdit && isLive && (
        <DialogTrigger isOpen={publishOpen} onOpenChange={setPublishOpen}>
          <Button isPending={busy}>Publish carousel changes</Button>
          <Modal isDismissable>
            <AlertDialog
              variant="warning"
              title="Publish these carousel changes now?"
              buttons={
                <>
                  <Button variant="secondary" onPress={() => setPublishOpen(false)} isPending={section.saving}>
                    Cancel
                  </Button>
                  <Button onPress={save} isPending={section.saving} pendingLabel="Publishing…">
                    Publish carousel changes
                  </Button>
                </>
              }
            >
              <p>This is the live carousel, so the public home page shows your changes within a few minutes.</p>
            </AlertDialog>
          </Modal>
        </DialogTrigger>
      )}
      </div>
    </div>
  );
}

function PastCarousel({ carousel, timeZone }: { carousel: CarouselView; timeZone: string }): React.JSX.Element {
  return (
    <div className="gcpe-carousel__past-item">
      <p>{carousel.wentLiveAt ? `Retired — went live ${formatWhen(carousel.wentLiveAt, new Date(), timeZone)}` : "Retired"}</p>
      <ul>
        {carousel.slides.map((s) => (
          <li key={s.id}>{s.headline || "(no headline)"}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * `/hub/website/carousel` (task-5-brief.md): the home-page carousel's live/next/past states.
 * Writes need `NRMS.SiteEditor`; every other read role sees the same screen with no inputs.
 */
export function CarouselScreen(): React.JSX.Element {
  const session = useSession();
  const timeZone = useTenantTimeZone();
  useDocumentTitle("Carousel");
  const canManage = canManageWebsite(session);
  const canEdit = session.has("NRMS.SiteEditor");
  const [data, setData] = useState<CarouselsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [makeLiveOpen, setMakeLiveOpen] = useState(false);
  const createNext = useVersionedSave<CarouselView>();
  const makeLive = useVersionedSave<{ switched: boolean }>();
  const deleteNext = useVersionedSave<void>();
  const [goLive, setGoLive] = useState<ScheduleValue | null>(null);

  const reload = useCallback(() => {
    apiFetch<CarouselsResponse>("/nrms/api/site/carousels").then(setData, () => setLoadError("Couldn't load the carousels."));
  }, []);

  // Minors: WebsiteScreen's own gate now lets every read role through for Featured/Log — this
  // screen stays NRMS.SiteEditor/Core.Admin only, so it checks for itself (defense in depth
  // for a direct deep link) and never even fetches carousel data for anyone else.
  useEffect(() => {
    if (canManage) reload();
  }, [canManage, reload]);

  if (!canManage) {
    return (
      <div className="gcpe-carousel">
        <h1>Carousel</h1>
        <p>You don&rsquo;t have permission to view the carousel.</p>
      </div>
    );
  }

  const onCreateNext = () => {
    if (!goLive) return;
    void createNext.run(() => apiFetch<CarouselView>("/nrms/api/site/carousels/next", { method: "POST", body: { goLiveAtLocal: goLive.local } })).then((created) => {
      if (created) {
        setGoLive(null);
        reload();
      }
    });
  };

  const onMakeLive = () => {
    void makeLive.run(() => apiFetch("/nrms/api/site/carousels/next/make-live", { method: "POST" })).then((result) => {
      if (result) {
        setMakeLiveOpen(false);
        reload();
      }
    });
  };

  const onDeleteNext = () => {
    if (!data?.next) return;
    // DELETE resolves to `undefined` (204, no body) on success — `run` only ever resolves to
    // `null` on failure, so `undefined !== null` is exactly "this succeeded".
    void deleteNext.run(() => apiFetch<void>(`/nrms/api/site/carousels/next?version=${data.next!.version}`, { method: "DELETE" })).then((result) => {
      if (result !== null) {
        setDeleteOpen(false);
        reload();
      }
    });
  };

  if (loadError) {
    return (
      <div className="gcpe-carousel">
        <h1>Carousel</h1>
        <InlineAlert variant="danger" role="alert" description={loadError} />
      </div>
    );
  }
  if (!data) return <p>Loading…</p>;

  return (
    <div className="gcpe-carousel">
      <h1>Carousel</h1>

      <section aria-label="Live carousel">
        <h2>Live</h2>
        {data.live ? (
          <SlideEditor key={`${data.live.id}:${data.live.version}`} carousel={data.live} canEdit={canEdit} allowGoLiveEdit={false} timeZone={timeZone} onSaved={reload} />
        ) : (
          <p>No carousel is live.</p>
        )}
      </section>

      <section aria-label="Next carousel">
        <h2>Next</h2>
        {data.next ? (
          <>
            <SlideEditor key={`${data.next.id}:${data.next.version}`} carousel={data.next} canEdit={canEdit} allowGoLiveEdit={canEdit} timeZone={timeZone} onSaved={reload} />
            {canEdit && (
              <>
                {makeLive.conflict && <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} buttons={<Button onPress={reload}>Reload</Button>} />}
                {makeLive.error && <InlineAlert variant="danger" role="alert" description={makeLive.error} />}
                <DialogTrigger isOpen={makeLiveOpen} onOpenChange={setMakeLiveOpen}>
                  <Button isPending={makeLive.saving} pendingLabel="Making live…">Make live now</Button>
                  <Modal isDismissable>
                    <AlertDialog
                      variant="warning"
                      title="Make the next carousel live now?"
                      buttons={
                        <>
                          <Button onPress={() => setMakeLiveOpen(false)}>Cancel</Button>
                          <Button danger onPress={onMakeLive}>
                            Confirm make live
                          </Button>
                        </>
                      }
                    >
                      <p>This replaces the live carousel immediately, ignoring its scheduled go-live time.</p>
                    </AlertDialog>
                  </Modal>
                </DialogTrigger>

                {deleteNext.conflict && <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} buttons={<Button onPress={reload}>Reload</Button>} />}
                {deleteNext.error && <InlineAlert variant="danger" role="alert" description={deleteNext.error} />}
                <DialogTrigger isOpen={deleteOpen} onOpenChange={setDeleteOpen}>
                  <Button variant="secondary" danger isPending={deleteNext.saving} pendingLabel="Deleting…">
                    Delete next carousel
                  </Button>
                  <Modal isDismissable>
                    <AlertDialog
                      variant="destructive"
                      title="Delete the next carousel?"
                      buttons={
                        <>
                          <Button onPress={() => setDeleteOpen(false)}>Cancel</Button>
                          <Button danger onPress={onDeleteNext}>
                            Confirm delete
                          </Button>
                        </>
                      }
                    >
                      <p>This deletes the next carousel and its slides. It can&rsquo;t be undone.</p>
                    </AlertDialog>
                  </Modal>
                </DialogTrigger>
              </>
            )}
          </>
        ) : (
          <>
            <p>There is no next carousel.</p>
            {canEdit && (
              <>
                {createNext.problems && (
                  <ul role="alert" className="gcpe-release-editor__problems">
                    {createNext.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                )}
                {createNext.conflict && <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} buttons={<Button onPress={reload}>Reload</Button>} />}
                {createNext.error && <InlineAlert variant="danger" role="alert" description={createNext.error} />}
                <SchedulePicker timeZone={timeZone} legend="Go live at (BC time)" idPrefix="carousel-create-next" onChange={setGoLive} />
                <Button onPress={onCreateNext} isPending={createNext.saving} isDisabled={!goLive} pendingLabel="Creating…">
                  Create next carousel
                </Button>
              </>
            )}
          </>
        )}
      </section>

      <section aria-label="Past carousels">
        <h2>Past</h2>
        {data.past.length === 0 && <p>No past carousels yet.</p>}
        {data.past.map((c) => (
          <PastCarousel key={c.id} carousel={c} timeZone={timeZone} />
        ))}
      </section>
    </div>
  );
}
