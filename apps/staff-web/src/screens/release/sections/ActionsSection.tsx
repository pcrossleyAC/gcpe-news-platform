import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { AlertDialog, DialogTrigger, InlineAlert, Modal } from "@bcgov/design-system-react-components";
import { approveProblems, publishProblems, TYPE_LABEL, typeRules, type ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../../api/client";
import { formatInZone, formatToPartsInZone } from "../../../format/bcTime";
import { Button } from "../../../shared/BusyButton";
import { scrollToAndFocus } from "../../../shared/scrollToSection";
import { RELOAD_MESSAGE, useReleaseSection } from "../useReleaseSection";
import { useRegisterDirty, type DirtySection } from "../useUnsavedChanges";
import { unsavedTarget } from "../unsavedTarget";
import { usePublicSiteUrl } from "../sidebar/usePublicSiteUrl";
import type { Categories } from "../categories";
import { useSaveQueue, withVersion } from "../saveQueue";
import { SaveStatus } from "../SaveStatus";
import { SchedulePicker, type ScheduleValue } from "./SchedulePicker";
import { bcLocalToInstant, instantToBcLocal, wallClockNowMinute } from "../timezone";
import { placeholderHits } from "../placeholders";
import { APPROVE_LIST_ID, readiness } from "../readiness";
import { addDaysTo, bcDateOf, dateTimeText } from "../../calendar/list/dates";

/** Schedule's field error for a time that isn't in the future. */
export const PAST_SCHEDULE = "Choose a time in the future, or use Publish now.";

/** "2031-06-15T14:30" (a BC wall-clock time, exactly as Schedule sends it as `publishAtLocal`) as
 * "Sunday, June 15, 2031 at 2:30 PM Pacific time". Formatted from the wall-clock fields
 * themselves, never via an instant: the server converts the wall-clock string with its own
 * tzdata, so this is the time it will go out as the server reads it, whatever the browser's
 * tzdata says. */
export function scheduleText(local: string): string {
  const [date = "", time = ""] = local.split("T");
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const at = new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!));
  const day = formatInZone(at, "UTC", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const p = Object.fromEntries(formatToPartsInZone(at, "UTC", { hour: "numeric", minute: "2-digit", hour12: true }).map((x) => [x.type, x.value]));
  return `${day} at ${p.hour}:${p.minute} ${p.dayPeriod} Pacific time`;
}

/** `GET /nrms/api/config`'s server-side offset for the tenant zone (see wallClockNowMinute). */
function useServerZoneOffset(enabled: boolean): number | null {
  const [offset, setOffset] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    apiFetch<{ tzCheck?: { offsetMinutes: number } }>("/nrms/api/config").then(
      (c) => {
        if (active && typeof c.tzCheck?.offsetMinutes === "number") setOffset(c.tzCheck.offsetMinutes);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [enabled]);
  return offset;
}

/** Cancel schedule's dialog warns when the publish is due within this many minutes. */
const CANCEL_SOON_MINUTES = 30;

/** apps/nrms/src/releases/service.ts's DELETABLE_STATUSES (and, like the server, never while live). */
const DELETABLE_STATUSES = new Set(["draft", "approved", "failed"]);
/** apps/nrms/src/releases/workflow.ts's RETURNABLE_STATUSES (plus: has a reference, never released). */
const RETURNABLE_STATUSES = new Set(["approved", "scheduled"]);
/** apps/nrms/src/releases/workflow.ts's UNPUBLISHABLE_STATUSES (and, like the server, only while live). */
const UNPUBLISHABLE_STATUSES = new Set(["published", "publishing", "failed", "scheduled"]);

export interface ActionsSectionProps {
  view: ReleaseView;
  setView(v: ReleaseView): void;
  timeZone: string;
  /** Sections with unsaved edits (the page's unsaved-changes guard). While any is listed,
   * Approve, Publish now and Schedule are unavailable: they act on the release as saved, so
   * the edits on screen would be left out (owner decision 2026-10-29). */
  unsaved?: DirtySection[];
}

/** A reason an action is unavailable, and the section/field it links to (if any). */
interface Blocker {
  text: string;
  target: string | null;
}

/** "Save page details" → "page details": the bar's button text as the words a sentence names it by. */
const unsavedName = (label: string) => label.replace(/^save\s+/i, "");

/**
 * Editors-only (the caller gates this whole section on `NRMS.Editor`): Approve, Publish
 * now/Schedule, Return to draft, Cancel schedule, Unpublish (hidden when the type isn't unpublishable — e.g.
 * Advisory), Delete. Button visibility mirrors apps/nrms/src/releases/workflow.ts's status
 * preconditions; the server remains the authority (constraints.md) — these are convenience
 * gates, not the enforcement.
 */
export function ActionsSection({ view, setView, timeZone, unsaved = [] }: ActionsSectionProps): React.JSX.Element {
  const navigate = useNavigate();
  const section = useReleaseSection(view, setView);
  const queue = useSaveQueue();
  const rules = typeRules(view.type);

  const [schedulerOpen, setSchedulerOpen] = useState(false);
  const [scheduleValue, setScheduleValue] = useState<ScheduleValue | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  // The panel's date and time as it opened (prefilled or empty), and as they are now: it holds
  // something to lose only once the editor changes them.
  const [scheduleOpenedWith, setScheduleOpenedWith] = useState("T");
  const [scheduleTyped, setScheduleTyped] = useState("T");
  const serverOffset = useServerZoneOffset(schedulerOpen);
  // The server publishes a time up to 5 minutes in the past at once (no dialog), so a time must
  // be after the current BC minute — checked as it's typed, and again at Confirm.
  const futureProblem = (local: string) => (local <= wallClockNowMinute(Date.now(), timeZone, serverOffset) ? PAST_SCHEDULE : null);
  // Just blocks navigation while a changed date or time is open (no save of its own to offer the
  // sticky bar — Schedule's own "Confirm schedule" below is the only way to act on it). Opening the
  // panel, prefilled or empty, isn't a change.
  useRegisterDirty("actions-scheduler", schedulerOpen && scheduleTyped !== scheduleOpenedWith);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConflict, setDeleteConflict] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [unpublishOpen, setUnpublishOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [scheduleConfirmOpen, setScheduleConfirmOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  // After a successful Publish now, Approve or Return to draft its button leaves the page (the
  // release moved on), so focus goes to the Actions heading rather than falling to <body>.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [focusHeading, setFocusHeading] = useState(false);
  useEffect(() => {
    if (!focusHeading) return;
    // After React Aria's own focus restore (a frame after the dialog unmounts).
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        headingRef.current?.focus();
        setFocusHeading(false);
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [focusHeading]);

  const canApprove = view.status === "draft";
  const canPublish = (view.status === "approved" || view.status === "failed") && view.key !== null;
  const needsKeyFirst = (view.status === "approved" || view.status === "failed") && view.key === null;
  // The server refuses to schedule a live release's correction: it goes out immediately (workflow.ts schedule).
  const canSchedule = canPublish && !view.live;
  const canCancel = view.status === "scheduled";
  const canReturnToDraft = view.reference !== null && view.releasedAt === null && view.atomId === null && RETURNABLE_STATUSES.has(view.status);
  // Both follow the server's `live` check: a failed correction is still on the site, so it can be
  // unpublished but not deleted; a failed republish after an unpublish is the other way round.
  const canUnpublish = rules.unpublishable && view.live && UNPUBLISHABLE_STATUSES.has(view.status);
  const canDelete = DELETABLE_STATUSES.has(view.status) && !view.live;
  // Why Approve/Publish are greyed out, said next to the buttons themselves (the header's
  // checklists are a long scroll away) — hand-check feedback on boxs.ca.
  const unsavedBlockers: Blocker[] = unsaved.map((s) => ({ text: `Save your changes to ${unsavedName(s.label)} first.`, target: unsavedTarget(s.key, view) }));
  const asBlockers = (problems: string[]): Blocker[] => problems.map((p) => ({ text: p, target: blockerTarget(p) }));
  const approveBlockers = canApprove ? [...unsavedBlockers, ...asBlockers(approveProblems(view))] : [];
  const publishBlockers = canPublish ? [...unsavedBlockers, ...asBlockers(publishProblems(view))] : [];
  // forms-b #16: the one list of what publishing needs (the header only links here). Where Publish
  // now isn't offered it's listed on its own: on a draft (leaving out what Approve already lists),
  // approved with no URL key yet, and (fix round 1) scheduled or published, since the publisher
  // re-checks it at the scheduled time and on every republish.
  const ready = readiness(view);
  const publishLater = !canPublish ? asBlockers(ready.publish) : [];

  // Owner decision 2026-10-29: Approve confirms first, and warns (never blocks) about
  // placeholder text left in the release — "TBD", "to come", "[insert" and the like.
  const placeholders = approveOpen ? placeholderHits(view) : [];
  const approve = () =>
    void section.save("/approve", { version: view.version }, "POST").then((next) => {
      if (!next) return;
      setApproveOpen(false);
      setFocusHeading(true);
    });
  const returnToDraft = () =>
    void section.save("/return-to-draft", { version: view.version }, "POST").then((next) => {
      if (!next) return;
      setReturnOpen(false);
      setFocusHeading(true);
    });
  const typeName = TYPE_LABEL[view.type].toLowerCase();
  // Owner decision 2026-10-29: Schedule starts from the planned publish date (Publish
  // settings, for planning only) when there is one still ahead; the editor can change it.
  const openScheduler = () => {
    if (schedulerOpen) {
      setSchedulerOpen(false);
      return;
    }
    const planned = view.status === "approved" && view.publishAt && Date.parse(view.publishAt) > Date.now() ? view.publishAt : null;
    if (planned) {
      const { date, time } = instantToBcLocal(planned, timeZone);
      setScheduleValue({ local: `${date}T${time}`, instant: planned });
      setScheduleOpenedWith(`${date}T${time}`);
      setScheduleTyped(`${date}T${time}`);
    } else {
      setScheduleValue(null);
      setScheduleOpenedWith("T");
      setScheduleTyped("T");
    }
    setScheduleError(null);
    setSchedulerOpen(true);
  };
  const prefilled = scheduleValue !== null && view.publishAt !== null && scheduleValue.instant === view.publishAt;
  // Suite review R5: a planned publish date still ahead (Publish settings) is often an embargo;
  // Publish now's dialog names it. A live release's publishAt is when it went out, never ahead.
  const plannedLater = !view.live && view.publishAt && Date.parse(view.publishAt) > Date.now() ? view.publishAt : null;
  const publishNow = () =>
    void section.save("/schedule", { version: view.version, publishAt: "now" }, "POST").then((next) => {
      if (!next) return;
      setPublishOpen(false);
      setFocusHeading(true);
    });
  const cancelSchedule = () =>
    void section.save("/cancel", { version: view.version }, "POST").then((next) => {
      if (!next) return;
      setCancelOpen(false);
      setFocusHeading(true);
    });
  // Suite review R10: Cancel schedule asks first, naming the time, and says how soon it's due when
  // that's close (a mistaken cancel minutes before means it quietly doesn't go out).
  const minutesToGo = canCancel && cancelOpen && view.publishAt ? Math.floor((Date.parse(view.publishAt) - Date.now()) / 60_000) : null;
  const cancelSoon = minutesToGo !== null && minutesToGo < CANCEL_SOON_MINUTES;
  const unpublish = () =>
    void section.save("/unpublish", { version: view.version }, "POST").then((next) => {
      if (next) setUnpublishOpen(false);
    });

  // Owner decision 2026-10-29: Confirm schedule asks first, like Publish now — it commits a
  // later, unattended send to the same audience. The time is checked when the dialog opens and
  // again when its Schedule is pressed (the dialog may have sat open past it).
  const openScheduleConfirm = (open: boolean) => {
    if (!open) return setScheduleConfirmOpen(false);
    if (!scheduleValue) return;
    const problem = futureProblem(scheduleValue.local);
    if (problem) return setScheduleError(problem);
    section.clear();
    setScheduleConfirmOpen(true);
  };
  const submitSchedule = async () => {
    if (!scheduleValue) return;
    const problem = futureProblem(scheduleValue.local);
    if (problem) {
      setScheduleConfirmOpen(false);
      setScheduleError(problem);
      return;
    }
    // Fix round 1, finding 3: sends the raw BC wall-clock string (`publishAtLocal`), not a
    // client-converted instant — the server (whose tzdata is authoritative) converts it.
    const result = await section.save("/schedule", { version: view.version, publishAtLocal: scheduleValue.local }, "POST");
    if (result) {
      setScheduleConfirmOpen(false);
      setSchedulerOpen(false);
      setScheduleValue(null);
      setFocusHeading(true);
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    setDeleteConflict(false);
    try {
      await queue.run((version) => apiFetch(`/nrms/api/releases/${view.id}/delete`, { method: "POST", body: withVersion({ version: view.version }, version) }));
      navigate("/releases/drafts");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) setDeleteConflict(true);
      else setDeleteError(caught instanceof ApiError ? caught.message : "Delete failed.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="gcpe-release-editor__actions" aria-label="Actions">
      <h2 ref={headingRef} tabIndex={-1}>
        Actions
      </h2>

      {section.conflict && (
        <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} buttons={<Button onPress={() => void section.reload()}>Reload</Button>} />
      )}
      {section.error && <InlineAlert variant="danger" role="alert" description={section.error} />}
      {section.problems && (
        <ul role="alert" className="gcpe-release-editor__problems">
          {section.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <SaveStatus saving={section.saving} waiting={section.waiting} />

      <div className="gcpe-release-editor__action-buttons">
        {canApprove && (
          <DialogTrigger isOpen={approveOpen} onOpenChange={setApproveOpen}>
            <Button isPending={section.saving} isDisabled={approveBlockers.length > 0} aria-describedby={approveBlockers.length > 0 ? "actions-approve-why" : undefined}>
              Approve
            </Button>
            <Modal isDismissable>
              <AlertDialog
                variant={placeholders.length > 0 ? "warning" : undefined}
                title={`Approve this ${typeName}?`}
                buttons={
                  <>
                    <Button variant="secondary" onPress={() => setApproveOpen(false)} isPending={section.saving}>
                      Cancel
                    </Button>
                    <Button onPress={approve} isPending={section.saving} isDisabled={approveBlockers.length > 0} pendingLabel="Approving…">
                      {placeholders.length > 0 ? "Approve anyway" : "Approve"}
                    </Button>
                  </>
                }
              >
                <p>
                  Approving gives it a reference number{rules.generatesKey ? " and a release number" : ""}. After that it can be published or scheduled.
                </p>
                {placeholders.length > 0 && (
                  <>
                    <p>This {typeName} still has placeholder text:</p>
                    <ul>
                      {placeholders.map((h, i) => (
                        <li key={i}>
                          {h.where}: &ldquo;{h.context}&rdquo;
                        </li>
                      ))}
                    </ul>
                    <p>Check these before approving, or approve anyway if they&rsquo;re meant to be there.</p>
                  </>
                )}
                <ActionErrors section={section} />
              </AlertDialog>
            </Modal>
          </DialogTrigger>
        )}

        {canPublish && (
          <>
            {/* Owner decision 2026-10-29: a confirm dialog saying what publishing does, same
             * pattern as Unpublish; only the dialog's own button sends the request. */}
            <DialogTrigger isOpen={publishOpen} onOpenChange={setPublishOpen}>
              <Button isPending={section.saving} isDisabled={publishBlockers.length > 0} aria-describedby={publishBlockers.length > 0 ? "actions-publish-why" : undefined}>
                Publish now
              </Button>
              <Modal isDismissable>
                <AlertDialog
                  variant={plannedLater ? "warning" : undefined}
                  title="Publish this release now?"
                  buttons={
                    <>
                      <Button variant="secondary" onPress={() => setPublishOpen(false)} isPending={section.saving}>
                        Cancel
                      </Button>
                      <Button onPress={publishNow} isPending={section.saving} isDisabled={publishBlockers.length > 0} pendingLabel="Publishing…">
                        Publish now
                      </Button>
                    </>
                  }
                >
                  {plannedLater && (
                    <p>
                      <strong>This release is planned for {dateTimeText(plannedLater, timeZone)}.</strong> Publishing now puts it out early.
                    </p>
                  )}
                  <PublishConsequences view={view} timeZone={timeZone} />
                  <ActionErrors section={section} />
                </AlertDialog>
              </Modal>
            </DialogTrigger>
            {canSchedule && (
              <Button
                variant="secondary"
                onPress={openScheduler}
                aria-expanded={schedulerOpen}
                aria-controls="actions-scheduler"
                isDisabled={publishBlockers.length > 0}
                aria-describedby={publishBlockers.length > 0 ? "actions-publish-why" : undefined}
              >
                Schedule
              </Button>
            )}
          </>
        )}
        {needsKeyFirst && <p>Set a URL key in Page details before this can be published.</p>}

        {canReturnToDraft && (
          <DialogTrigger isOpen={returnOpen} onOpenChange={setReturnOpen}>
            <Button variant="secondary" isPending={section.saving}>
              Return to draft
            </Button>
            <Modal isDismissable>
              <AlertDialog
                title={`Return this ${typeName} to draft?`}
                buttons={
                  <>
                    <Button variant="secondary" onPress={() => setReturnOpen(false)} isPending={section.saving}>
                      Cancel
                    </Button>
                    <Button onPress={returnToDraft} isPending={section.saving} pendingLabel="Returning…">
                      Return to draft
                    </Button>
                  </>
                }
              >
                {view.status === "scheduled" && view.publishAt && <p>It will no longer be published on {dateTimeText(view.publishAt, timeZone)}.</p>}
                <p>
                  {rules.generatesKey && view.key
                    ? `It gives up its reference number (${view.reference}) and release number (${view.key}); it gets new ones when it's approved again.`
                    : `It gives up its reference number (${view.reference}); it gets a new one when it's approved again.`}
                </p>
                <ActionErrors section={section} />
              </AlertDialog>
            </Modal>
          </DialogTrigger>
        )}

        {canCancel && (
          <DialogTrigger isOpen={cancelOpen} onOpenChange={setCancelOpen}>
            <Button variant="secondary" isPending={section.saving}>
              Cancel schedule
            </Button>
            <Modal isDismissable>
              <AlertDialog
                variant={cancelSoon ? "warning" : undefined}
                title={view.publishAt ? `Cancel the publish on ${dateTimeText(view.publishAt, timeZone)}?` : "Cancel the scheduled publish?"}
                buttons={
                  <>
                    <Button variant="secondary" onPress={() => setCancelOpen(false)} isPending={section.saving}>
                      Keep schedule
                    </Button>
                    <Button onPress={cancelSchedule} isPending={section.saving} pendingLabel="Cancelling…">
                      Cancel schedule
                    </Button>
                  </>
                }
              >
                {cancelSoon && (
                  <p>
                    <strong>
                      {minutesToGo! <= 0 ? "It's due to go out now." : `It's due to go out in ${minutesToGo} minute${minutesToGo === 1 ? "" : "s"}.`}
                    </strong>{" "}
                    If you cancel, it won&rsquo;t go out then.
                  </p>
                )}
                <p>It goes back to Drafts as approved. You can schedule it again or publish it from there.</p>
                <ActionErrors section={section} />
              </AlertDialog>
            </Modal>
          </DialogTrigger>
        )}

        {canUnpublish && (
          // Minors: this takes a public release down — a confirm dialog, same pattern as
          // Delete, instead of firing the POST straight from the button press.
          <DialogTrigger isOpen={unpublishOpen} onOpenChange={setUnpublishOpen}>
            <Button variant="secondary" isPending={section.saving}>
              Unpublish
            </Button>
            <Modal isDismissable>
              <AlertDialog
                variant="warning"
                title="Unpublish this release?"
                buttons={
                  <>
                    <Button onPress={() => setUnpublishOpen(false)} isPending={section.saving}>
                      Cancel
                    </Button>
                    <Button danger onPress={unpublish} isPending={section.saving}>
                      Confirm unpublish
                    </Button>
                  </>
                }
              >
                <p>This takes the release down from the public site. It can be republished afterwards.</p>
              </AlertDialog>
            </Modal>
          </DialogTrigger>
        )}

        {canDelete && (
          // Fix round 1, finding 2: a real Modal/AlertDialog (React Aria's ModalOverlay under
          // the hood), wrapped in a DialogTrigger so focus restoration on close is tied to
          // *this* trigger button specifically — instead of a bare `<div role="dialog">`, which
          // left other action buttons clickable, trapped no focus, and restored nothing.
          <DialogTrigger isOpen={deleteOpen} onOpenChange={setDeleteOpen}>
            <Button variant="secondary" danger isPending={section.saving}>
              Delete
            </Button>
            <Modal isDismissable>
              <AlertDialog
                variant="destructive"
                title="Delete this release?"
                buttons={
                  <>
                    <Button onPress={() => setDeleteOpen(false)} isPending={deleting}>
                      Cancel
                    </Button>
                    <Button danger onPress={() => void confirmDelete()} isPending={deleting}>
                      Confirm delete
                    </Button>
                  </>
                }
              >
                <p>
                  {view.reference
                    ? `This release has a reference number (${view.reference}) — deleting it hides it from the lists but keeps the record.`
                    : "This draft has never been approved — deleting it is permanent and can't be undone."}
                </p>
                {deleteConflict && <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} />}
                {deleteError && <InlineAlert variant="danger" role="alert" description={deleteError} />}
              </AlertDialog>
            </Modal>
          </DialogTrigger>
        )}
      </div>

      {approveBlockers.length > 0 && <BlockerList id={APPROVE_LIST_ID} lead="Approve is unavailable until:" items={approveBlockers} />}
      {canApprove && <p className="gcpe-release-editor__why">Publish now and Schedule appear once this is approved.</p>}
      {publishLater.length > 0 && (
        <BlockerList
          id="actions-publish-later"
          lead={
            view.status === "scheduled"
              ? "Before the scheduled time:"
              : view.status === "published"
                ? "Before your next save can republish it:"
                : approveBlockers.length > 0
                  ? "Also needed before it can be published:"
                  : "Before it can be published:"
          }
          items={publishLater}
        />
      )}
      {publishBlockers.length > 0 && <BlockerList id="actions-publish-why" lead={canSchedule ? "Publish now and Schedule are unavailable until:" : "Publish now is unavailable until:"} items={publishBlockers} />}

      {schedulerOpen && canSchedule && (
        // data-unsaved: Esc leaves it open once a date or time is typed (shared/escapeClosesPanels.ts).
        <div id="actions-scheduler" className="gcpe-release-editor__scheduler" data-unsaved={scheduleTyped !== scheduleOpenedWith || undefined}>
          <SchedulePicker
            timeZone={timeZone}
            legend="Schedule for"
            idPrefix="schedule"
            initialDate={prefilled ? instantToBcLocal(view.publishAt!, timeZone).date : undefined}
            initialTime={prefilled ? instantToBcLocal(view.publishAt!, timeZone).time : undefined}
            onChange={(value) => {
              setScheduleError(null);
              setScheduleValue(value);
            }}
            onEdit={(date, time) => setScheduleTyped(`${date}T${time}`)}
            validate={futureProblem}
            error={scheduleError}
          />
          <p className="gcpe-hint gcpe-release-editor__planned-note">
            {prefilled
              ? "Filled in from the planned publish date. "
              : view.publishAt && view.status === "approved"
              ? `Planned publish date: ${dateTimeText(view.publishAt, timeZone)}. `
              : ""}
            The time you confirm here is when it goes out.
          </p>
          <DialogTrigger isOpen={scheduleConfirmOpen} onOpenChange={openScheduleConfirm}>
            <Button isDisabled={!scheduleValue || publishBlockers.length > 0} isPending={section.saving}>
              Confirm schedule
            </Button>
            <Modal isDismissable>
              <AlertDialog
                title={`Schedule this ${typeName} for ${scheduleValue ? scheduleText(scheduleValue.local) : ""}?`}
                buttons={
                  <>
                    <Button variant="secondary" onPress={() => setScheduleConfirmOpen(false)} isPending={section.saving}>
                      Cancel
                    </Button>
                    <Button onPress={() => void submitSchedule()} isPending={section.saving} isDisabled={publishBlockers.length > 0} pendingLabel="Scheduling…">
                      Schedule
                    </Button>
                  </>
                }
              >
                {scheduleValue && <PublishConsequences view={view} at={scheduleText(scheduleValue.local)} atInstant={scheduleValue.instant} timeZone={timeZone} />}
                <ActionErrors section={section} />
              </AlertDialog>
            </Modal>
          </DialogTrigger>
        </div>
      )}
    </section>
  );
}

/** A dialog's own copy of the section's errors (the page's copy is hidden behind the modal). */
function ActionErrors({ section }: { section: ReturnType<typeof useReleaseSection> }): React.JSX.Element {
  return (
    <>
      {section.conflict && (
        <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} buttons={<Button onPress={() => void section.reload()}>Reload</Button>} />
      )}
      {section.error && <InlineAlert variant="danger" role="alert" description={section.error} />}
      {section.problems && (
        <ul role="alert" className="gcpe-release-editor__problems">
          {section.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Which section/field a given {@link approveProblems}/{@link publishProblems} message is
 * about — "where practical" (hand-check feedback on boxs.ca): at minimum the Documents section
 * for a per-document problem and Categories for a ministry/sector one, per the fix's own ask. */
function blockerTarget(problem: string): string | null {
  if (/\bministr(y|ies)\b/i.test(problem) || /\bsector\b/i.test(problem)) return "section-categories";
  if (/media distribution list/i.test(problem)) return "section-settings";
  if (/^add at least one document\.?$/i.test(problem)) return "section-documents";
  const doc = /^Document (\d+)/.exec(problem);
  if (doc) return `document-${doc[1]}-heading`;
  return null;
}

function BlockerList({ id, lead, items }: { id: string; lead: string; items: Blocker[] }): React.JSX.Element {
  return (
    // tabIndex: the header's "See them under Actions" link moves focus here.
    <div id={id} className="gcpe-release-editor__why" tabIndex={-1}>
      <p>{lead}</p>
      <ul>
        {items.map(({ text, target }) => (
          <li key={text}>
            {target ? (
              <a
                href={`#${target}`}
                onClick={(e) => {
                  e.preventDefault();
                  scrollToAndFocus(target);
                }}
              >
                {text}
              </a>
            ) : (
              text
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface MediaListName {
  key: string;
  displayName: string;
}

/** Names joined with semicolons: many category and list names contain "and" or commas
 * themselves ("Transportation and Transit"), so "A, B and C" would be ambiguous. */
const listText = (items: string[]): string => items.join("; ");

/** NoD's daily digest hour (apps/nod/src/digest.ts DIGEST_HOUR), BC time. */
const DIGEST_TIME = "17:00";

/** The daily digest cutoff whose window holds `releasedAt`: 5 pm BC time on its day, or on the
 * next day when it went out after 5 pm. NoD's digest takes items first released in
 * (previous cutoff, cutoff] that are on the site when it runs (apps/nod/src/digest.ts). */
export function digestCutoffFor(releasedAt: string, timeZone: string): string {
  const day = bcDateOf(releasedAt, timeZone);
  const same = bcLocalToInstant(day, DIGEST_TIME, timeZone);
  return Date.parse(releasedAt) <= Date.parse(same) ? same : bcLocalToInstant(addDaysTo(day, 1), DIGEST_TIME, timeZone);
}

/** "Oct 1, 2026" in the tenant's zone. */
const dayText = (iso: string, timeZone: string) => formatInZone(iso, timeZone, { month: "short", day: "numeric", year: "numeric" });

/**
 * What Publish now (or, given `at`, Schedule) will do, from the release as saved (publishing is blocked while anything is
 * unsaved, so saved is what goes out): the public site it goes on, the media distribution lists
 * it's sent to (by name), and whose News on Demand inboxes it reaches: the categories subscribers
 * follow, and on a first publish about how many subscribers and media contacts that is (suite
 * review R6: the counts the publish itself stores, from `GET .../audience`, worked out as the
 * dialog opens). Names come from the same lists the Categories and Publish settings sections read;
 * if a lookup fails, the keys are shown instead; if the counts can't be had, it says so.
 *
 * Who is emailed (apps/nod/src/items.ts, as-it-happens.ts, media-send.ts):
 * - first publish: the media lists and News on Demand subscribers;
 * - a correction of a live release: nobody;
 * - publishing again after an unpublish: nobody already emailed. An unpublish deletes the
 *   sends that hadn't gone out yet, and this publish sends to the people they hadn't reached.
 *   This screen can't tell whether that happened, so it says it conditionally.
 */
function PublishConsequences({
  view,
  at,
  atInstant,
  timeZone,
}: {
  view: ReleaseView;
  /** When a scheduled send goes out ("Sunday, June 15, 2031 at 2:30 PM Pacific time"); omitted for Publish now. */
  at?: string;
  /** The same moment as an instant; omitted for Publish now. */
  atInstant?: string;
  timeZone: string;
}): React.JSX.Element {
  const rules = typeRules(view.type);
  const publicSiteUrl = usePublicSiteUrl();
  const [lists, setLists] = useState<MediaListName[] | null>(null);
  const [categories, setCategories] = useState<Categories | null>(null);

  const correction = view.live;
  const again = !view.live && view.releasedAt !== null;
  const listsOn = rules.mediaListsAllowed && view.publishOptions.toMediaLists && view.mediaListKeys.length > 0;
  const subscribersOn = rules.nodAllowed && view.publishOptions.toSubscribers;
  const toLists = !correction && listsOn;
  const toSubscribers = !correction && subscribersOn;

  // undefined while counting; null when the counts couldn't be fetched.
  const [audience, setAudience] = useState<Audience | null | undefined>(undefined);
  const countable = (toLists || toSubscribers) && !again;
  useEffect(() => {
    if (!countable) return;
    let active = true;
    apiFetch<Audience>(`/nrms/api/releases/${view.id}/audience`).then(
      (a) => active && setAudience(a),
      () => active && setAudience(null),
    );
    return () => {
      active = false;
    };
  }, [countable, view.id]);

  useEffect(() => {
    let active = true;
    if (toLists) apiFetch<MediaListName[]>("/nrms/api/media-lists").then((l) => active && setLists(l), () => {});
    if (toSubscribers && !again) apiFetch<Categories>("/nrms/api/categories").then((c) => active && setCategories(c), () => {});
    return () => {
      active = false;
    };
  }, [toLists, toSubscribers, again]);

  let host = "";
  try {
    host = publicSiteUrl ? new URL(publicSiteUrl).host : "";
  } catch {
    host = "";
  }
  const nameIn = (terms: { key: string; name: string }[] | undefined, key: string) => terms?.find((t) => t.key === key)?.name ?? key;
  const listNames = view.mediaListKeys.map((k) => lists?.find((l) => l.key === k)?.displayName ?? k);
  const followed = [
    ...view.ministries.map((k) => nameIn(categories?.ministries, k)),
    ...view.sectors.map((k) => nameIn(categories?.sectors, k)),
    ...view.themes.map((k) => nameIn(categories?.themes, k)),
    ...view.tags.map((k) => nameIn(categories?.tags, k)),
  ];
  const web = <li>{view.publishOptions.toWeb ? `Publishes to ${host || "the public news site"} ${at ? `on ${at}` : "now"}.` : "Doesn't go on the public news site."}</li>;

  if (correction) {
    return (
      <ul className="gcpe-publish-consequences">
        {web}
        <li>Subscribers and media lists already received this when it was first published; they won&rsquo;t be emailed again.</li>
      </ul>
    );
  }

  if (again && (toLists || toSubscribers)) {
    const reached = [toLists ? `members of ${listText(listNames)}` : null, toSubscribers ? "News on Demand subscribers who chose As it happens" : null].filter(Boolean).join(", and ");
    const cutoff = digestCutoffFor(view.releasedAt!, timeZone);
    const goesUp = atInstant ? Date.parse(atInstant) : Date.now();
    const digestRule = `Daily digest subscribers get it only if it\u2019s on the site again before 5:00 PM on ${dayText(cutoff, timeZone)}.`;
    return (
      <ul className="gcpe-publish-consequences">
        {web}
        <li>Anyone already emailed about it won&rsquo;t be emailed again.</li>
        <li>{`If unpublishing stopped its emails before they all went out, the people they hadn\u2019t reached yet are emailed ${atInstant ? "when it goes out" : "now"}: ${reached}.`}</li>
        {toSubscribers && (
          <li>{goesUp > Date.parse(cutoff) ? `${digestRule} That time has passed, so daily digest subscribers who didn\u2019t get it then won\u2019t.` : digestRule}</li>
        )}
      </ul>
    );
  }

  return (
    <ul className="gcpe-publish-consequences">
      {web}
      <li>{toLists ? `Sends to media distribution lists: ${listText(listNames)}.` : "No media distribution lists."}</li>
      <li>
        {toSubscribers
          ? `Emails News on Demand subscribers who follow ${followed.length > 0 ? `any of: ${listText([...new Set(followed)])}` : "this release's categories"}${view.ministries.length > 0 ? " — and everyone subscribed to all news" : ""}.`
          : "News on Demand subscribers will not be emailed."}
      </li>
      {countable && <li>{audienceText(audience, toSubscribers, toLists, atInstant ? "when it goes out" : "now")}</li>}
    </ul>
  );
}

/** `GET /nrms/api/releases/:id/audience` (apps/nrms/src/releases/workflow.ts audiencePreview,
 * from NoD's own send rules): null for an audience this publish doesn't email; `count` null when
 * NoD couldn't say. */
interface Audience {
  asItHappens: { count: number | null } | null;
  digest: { count: number | null } | null;
  mediaContacts: { count: number | null } | null;
}

/** "Emails about 40,000 News on Demand subscribers and about 312 media contacts now. About 1,200
 * daily digest subscribers get it in the next 5 PM digest." `when` is "now" or "when it goes out". */
function audienceText(audience: Audience | null | undefined, toSubscribers: boolean, toLists: boolean, when: string): string {
  if (audience === undefined) return "Counting how many people it reaches…";
  if (audience === null) return "How many people it reaches isn't available right now.";
  const num = (n: number) => n.toLocaleString("en-CA");
  const about = (a: { count: number | null } | null, what: string) => (a?.count != null ? `about ${num(a.count)} ${what}` : `${what} (count unavailable)`);
  const now = [toSubscribers ? about(audience.asItHappens, "News on Demand subscribers") : null, toLists ? about(audience.mediaContacts, "media contacts") : null].filter(Boolean);
  const sentences = [`Emails ${now.join(" and ")} ${when}.`];
  if (toSubscribers) {
    const d = audience.digest?.count;
    sentences.push(
      d != null
        ? `About ${num(d)} daily digest subscriber${d === 1 ? " gets" : "s get"} it in the next 5 PM digest.`
        : "Daily digest subscribers get it in the next 5 PM digest (count unavailable).",
    );
  }
  return sentences.join(" ");
}
