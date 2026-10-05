import { useCallback, useEffect, useState, type DragEvent } from "react";
import { AlertDialog, Button, DialogTrigger, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { formatWhen } from "../../format/dates";
import { SchedulePicker, type ScheduleValue } from "../release/sections/SchedulePicker";
import { moveItemBy, moveItemTo } from "./reorder";
import { RELOAD_MESSAGE, useVersionedSave } from "./useVersionedSave";
import type { CarouselsResponse, CarouselView, SlideView } from "./types";

/** A slide's editable fields, as the slides-order PUT (saveCarouselSchema) takes them — `id`
 * omitted means "a new slide", same convention as Documents' reorder. */
interface SlideForm {
  id?: string;
  headline: string;
  summary: string;
  actionUrl: string;
  facebookPostUrl: string;
  justify: "left" | "right";
}

const BLANK_SLIDE: SlideForm = { headline: "", summary: "", actionUrl: "", facebookPostUrl: "", justify: "left" };

function toForm(slides: SlideView[]): SlideForm[] {
  return slides.map((s) => ({ id: s.id, headline: s.headline, summary: s.summary, actionUrl: s.actionUrl, facebookPostUrl: s.facebookPostUrl, justify: s.justify }));
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
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [removeIndex, setRemoveIndex] = useState<number | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  const update = (index: number, patch: Partial<SlideForm>) => setSlides((s) => s.map((slide, i) => (i === index ? { ...slide, ...patch } : slide)));
  const moveUp = (index: number) => setSlides((s) => moveItemBy(s, index, -1));
  const moveDown = (index: number) => setSlides((s) => moveItemBy(s, index, 1));

  const onDragStart = (index: number) => (e: DragEvent<HTMLDivElement>) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => e.preventDefault();
  const onDrop = (index: number) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== index) setSlides((s) => moveItemTo(s, dragIndex, index));
    setDragIndex(null);
  };

  const save = () => {
    void section
      .run(() =>
        apiFetch<CarouselView>(`/nrms/api/site/carousels/${carousel.id}`, {
          method: "PUT",
          body: { version: carousel.version, ...(allowGoLiveEdit && goLive ? { goLiveAt: goLive.instant } : {}), slides },
        }),
      )
      .then((next) => {
        if (next) onSaved();
      });
  };

  const confirmRemove = () => {
    if (removeIndex === null) return;
    setSlides((s) => s.filter((_, i) => i !== removeIndex));
    setRemoveIndex(null);
  };

  const uploadImage = async (slideId: string, file: File) => {
    setImageError(null);
    try {
      await apiFetch(`/nrms/api/site/slides/${slideId}/image`, { method: "PUT", raw: file });
      onSaved();
    } catch (caught) {
      setImageError(caught instanceof Error ? caught.message : "Image upload failed.");
    }
  };

  return (
    <div className="gcpe-carousel__slides">
      {section.conflict && <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} buttons={<Button onPress={onSaved}>Reload</Button>} />}
      {section.problems && (
        <ul role="alert" className="gcpe-release-editor__problems">
          {section.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {section.error && <InlineAlert variant="danger" role="alert" description={section.error} />}
      {imageError && <InlineAlert variant="danger" role="alert" description={imageError} />}

      {allowGoLiveEdit && (
        <SchedulePicker timeZone={timeZone} legend="Go live at (BC time)" idPrefix={`carousel-${carousel.id}-golive`} onChange={setGoLive} />
      )}

      {slides.map((slide, index) => (
        <div
          key={slide.id ?? `new-${index}`}
          className="gcpe-carousel__slide"
          draggable={canEdit && !section.saving}
          onDragStart={canEdit && !section.saving ? onDragStart(index) : undefined}
          onDragOver={canEdit && !section.saving ? onDragOver : undefined}
          onDrop={canEdit && !section.saving ? onDrop(index) : undefined}
        >
          <h4>Slide {index + 1}</h4>
          <TextField label={`Slide ${index + 1} headline`} value={slide.headline} onChange={(v) => update(index, { headline: v })} isDisabled={!canEdit} />
          <TextField label={`Slide ${index + 1} summary`} value={slide.summary} onChange={(v) => update(index, { summary: v })} isDisabled={!canEdit} />
          <TextField label={`Slide ${index + 1} action URL`} value={slide.actionUrl} onChange={(v) => update(index, { actionUrl: v })} isDisabled={!canEdit} />
          <TextField label={`Slide ${index + 1} Facebook post URL`} value={slide.facebookPostUrl} onChange={(v) => update(index, { facebookPostUrl: v })} isDisabled={!canEdit} />
          <label>
            Slide {index + 1} justify
            <select value={slide.justify} onChange={(e) => update(index, { justify: e.target.value as "left" | "right" })} disabled={!canEdit}>
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </label>
          {canEdit && (
            <>
              <Button variant="secondary" onPress={() => moveUp(index)} isDisabled={index === 0 || section.saving}>
                Move slide {index + 1} up
              </Button>
              <Button variant="secondary" onPress={() => moveDown(index)} isDisabled={index === slides.length - 1 || section.saving}>
                Move slide {index + 1} down
              </Button>
              <DialogTrigger isOpen={removeIndex === index} onOpenChange={(open) => setRemoveIndex(open ? index : null)}>
                <Button variant="secondary" danger isDisabled={section.saving}>
                  Remove slide {index + 1}
                </Button>
                <Modal isDismissable>
                  <AlertDialog
                    variant="destructive"
                    title={`Remove slide ${index + 1}?`}
                    buttons={
                      <>
                        <Button onPress={() => setRemoveIndex(null)}>Cancel</Button>
                        <Button danger onPress={confirmRemove}>
                          Confirm remove
                        </Button>
                      </>
                    }
                  >
                    <p>This removes the slide from this carousel. Save to commit the change.</p>
                  </AlertDialog>
                </Modal>
              </DialogTrigger>
            </>
          )}
          {slide.id && canEdit && (
            <label>
              Slide {index + 1} image (JPEG or PNG, up to 2 MB)
              <input
                type="file"
                accept="image/png,image/jpeg"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file && slide.id) void uploadImage(slide.id, file);
                }}
              />
            </label>
          )}
          {carousel.slides.find((s) => s.id === slide.id)?.imageUrl && (
            // eslint-disable-next-line jsx-a11y/alt-text
            <img src={carousel.slides.find((s) => s.id === slide.id)!.imageUrl!} alt="" width={120} />
          )}
        </div>
      ))}

      {canEdit && (
        <Button variant="secondary" onPress={() => setSlides((s) => [...s, { ...BLANK_SLIDE }])} isDisabled={section.saving}>
          Add slide
        </Button>
      )}
      {canEdit && (
        <Button onPress={save} isDisabled={section.saving}>
          Save carousel
        </Button>
      )}
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

  useEffect(reload, [reload]);

  const onCreateNext = () => {
    if (!goLive) return;
    void createNext.run(() => apiFetch<CarouselView>("/nrms/api/site/carousels/next", { method: "POST", body: { goLiveAt: goLive.instant } })).then((created) => {
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
          <SlideEditor carousel={data.live} canEdit={canEdit} allowGoLiveEdit={false} timeZone={timeZone} onSaved={reload} />
        ) : (
          <p>No carousel is live.</p>
        )}
      </section>

      <section aria-label="Next carousel">
        <h2>Next</h2>
        {data.next ? (
          <>
            <SlideEditor carousel={data.next} canEdit={canEdit} allowGoLiveEdit={canEdit} timeZone={timeZone} onSaved={reload} />
            {canEdit && (
              <>
                {makeLive.conflict && <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} buttons={<Button onPress={reload}>Reload</Button>} />}
                {makeLive.error && <InlineAlert variant="danger" role="alert" description={makeLive.error} />}
                <DialogTrigger isOpen={makeLiveOpen} onOpenChange={setMakeLiveOpen}>
                  <Button isDisabled={makeLive.saving}>Make live now</Button>
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
                  <Button variant="secondary" danger isDisabled={deleteNext.saving}>
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
                <Button onPress={onCreateNext} isDisabled={createNext.saving || !goLive}>
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
