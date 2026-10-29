import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { AlertDialog, DialogTrigger, InlineAlert, Modal } from "@bcgov/design-system-react-components";
import { approveProblems, publishProblems, TYPE_LABEL, typeRules, type ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../../api/client";
import { Button } from "../../../shared/BusyButton";
import { scrollToAndFocus } from "../../../shared/scrollToSection";
import { RELOAD_MESSAGE, useReleaseSection } from "../useReleaseSection";
import { useRegisterDirty, type DirtySection } from "../useUnsavedChanges";
import { documentsInOrder } from "../documents/documentHelpers";
import { usePublicSiteUrl } from "../sidebar/usePublicSiteUrl";
import type { Categories } from "../categories";
import { useSaveQueue, withVersion } from "../saveQueue";
import { SaveStatus } from "../SaveStatus";
import { SchedulePicker, type ScheduleValue } from "./SchedulePicker";
import { instantToBcLocal, wallClockNowMinute } from "../timezone";
import { placeholderHits } from "../placeholders";
import { dateTimeText } from "../../calendar/list/dates";

/** Schedule's field error for a time that isn't in the future. */
export const PAST_SCHEDULE = "Choose a time in the future, or use Publish now.";

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

/** apps/nrms/src/releases/service.ts's DELETABLE_STATUSES. */
const DELETABLE_STATUSES = new Set(["draft", "approved", "failed"]);
/** apps/nrms/src/releases/workflow.ts's RETURNABLE_STATUSES (plus: has a reference, never released). */
const RETURNABLE_STATUSES = new Set(["approved", "scheduled"]);
/** apps/nrms/src/releases/workflow.ts's UNPUBLISHABLE_STATUSES. */
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

/** Where a dirty section lives on the page, by its {@link useRegisterDirty} key. */
function unsavedTarget(key: string, view: ReleaseView): string | null {
  const fixed: Record<string, string> = { settings: "section-settings", "page-details": "section-page-details", categories: "section-categories", asset: "section-asset" };
  if (fixed[key]) return fixed[key];
  // A document language: its own tab panel (DocumentTabs shows that tab when the link is
  // followed — the edited language may not be the one showing).
  const doc = /^document-(.+)-(\d+)$/.exec(key);
  if (doc) return documentsInOrder(view).some((d) => d.id === doc[1]) ? `doc-${doc[1]}-panel-${doc[2]}` : "section-documents";
  return null;
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
  const serverOffset = useServerZoneOffset(schedulerOpen);
  // The server publishes a time up to 5 minutes in the past at once (no dialog), so a time must
  // be after the current BC minute — checked as it's typed, and again at Confirm.
  const futureProblem = (local: string) => (local <= wallClockNowMinute(Date.now(), timeZone, serverOffset) ? PAST_SCHEDULE : null);
  // Just blocks navigation while open (no save of its own to offer the sticky bar — Schedule's
  // own "Confirm schedule" below is the only way to act on it).
  useRegisterDirty("actions-scheduler", schedulerOpen);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConflict, setDeleteConflict] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [unpublishOpen, setUnpublishOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
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
  const canCancel = view.status === "scheduled";
  const canReturnToDraft = view.reference !== null && view.releasedAt === null && RETURNABLE_STATUSES.has(view.status);
  const canUnpublish = rules.unpublishable && view.releasedAt !== null && UNPUBLISHABLE_STATUSES.has(view.status);
  const canDelete = DELETABLE_STATUSES.has(view.status);
  // Why Approve/Publish are greyed out, said next to the buttons themselves (the header's
  // checklists are a long scroll away) — hand-check feedback on boxs.ca.
  const unsavedBlockers: Blocker[] = unsaved.map((s) => ({ text: `Save your changes to ${unsavedName(s.label)} first.`, target: unsavedTarget(s.key, view) }));
  const asBlockers = (problems: string[]): Blocker[] => problems.map((p) => ({ text: p, target: blockerTarget(p) }));
  const approveBlockers = canApprove ? [...unsavedBlockers, ...asBlockers(approveProblems(view))] : [];
  const publishBlockers = canPublish ? [...unsavedBlockers, ...asBlockers(publishProblems(view))] : [];

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
  // settings) when there is one still ahead; the editor can change it.
  const openScheduler = () => {
    if (schedulerOpen) {
      setSchedulerOpen(false);
      return;
    }
    const planned = view.status === "approved" && view.publishAt && Date.parse(view.publishAt) > Date.now() ? view.publishAt : null;
    if (planned) {
      const { date, time } = instantToBcLocal(planned, timeZone);
      setScheduleValue({ local: `${date}T${time}`, instant: planned });
    } else {
      setScheduleValue(null);
    }
    setScheduleError(null);
    setSchedulerOpen(true);
  };
  const prefilled = scheduleValue !== null && view.publishAt !== null && scheduleValue.instant === view.publishAt;
  const publishNow = () =>
    void section.save("/schedule", { version: view.version, publishAt: "now" }, "POST").then((next) => {
      if (!next) return;
      setPublishOpen(false);
      setFocusHeading(true);
    });
  const cancelSchedule = () => void section.save("/cancel", { version: view.version }, "POST");
  const unpublish = () =>
    void section.save("/unpublish", { version: view.version }, "POST").then((next) => {
      if (next) setUnpublishOpen(false);
    });

  const submitSchedule = async () => {
    if (!scheduleValue) return;
    const problem = futureProblem(scheduleValue.local);
    if (problem) {
      setScheduleError(problem);
      return;
    }
    // Fix round 1, finding 3: sends the raw BC wall-clock string (`publishAtLocal`), not a
    // client-converted instant — the server (whose tzdata is authoritative) converts it.
    const result = await section.save("/schedule", { version: view.version, publishAtLocal: scheduleValue.local }, "POST");
    if (result) {
      setSchedulerOpen(false);
      setScheduleValue(null);
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
                  <PublishConsequences view={view} />
                  <ActionErrors section={section} />
                </AlertDialog>
              </Modal>
            </DialogTrigger>
            <Button
              variant="secondary"
              onPress={openScheduler}
              isDisabled={publishBlockers.length > 0}
              aria-describedby={publishBlockers.length > 0 ? "actions-publish-why" : undefined}
            >
              Schedule
            </Button>
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
          <Button variant="secondary" onPress={cancelSchedule} isPending={section.saving}>
            Cancel schedule
          </Button>
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
                <p>This takes the release down from the public site and the News API. It can be republished afterwards.</p>
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

      {approveBlockers.length > 0 && <BlockerList id="actions-approve-why" lead="Approve is unavailable until:" items={approveBlockers} />}
      {canApprove && <p className="gcpe-release-editor__why">Publish now and Schedule appear once this is approved.</p>}
      {publishBlockers.length > 0 && <BlockerList id="actions-publish-why" lead="Publish now and Schedule are unavailable until:" items={publishBlockers} />}

      {schedulerOpen && canPublish && (
        <div className="gcpe-release-editor__scheduler">
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
            validate={futureProblem}
            error={scheduleError}
          />
          <p className="gcpe-hint gcpe-release-editor__planned-note">
            {prefilled
              ? "Filled in from the planned publish date in Publish settings — change it if you need to. The time you confirm here is the one that's committed."
              : view.publishAt && view.status === "approved"
              ? `Planned in Publish settings: ${dateTimeText(view.publishAt, timeZone)}. That's only a plan; the time you confirm here is the one that's committed.`
              : "The time you confirm here is the one that's committed. (A planned publish date in Publish settings is only a plan.)"}
          </p>
          <Button onPress={() => void submitSchedule()} isDisabled={!scheduleValue || unsavedBlockers.length > 0} isPending={section.saving}>
            Confirm schedule
          </Button>
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
    <div id={id} className="gcpe-release-editor__why">
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

/**
 * What Publish now will do, from the release as saved (publishing is blocked while anything is
 * unsaved, so saved is what goes out): the public site it goes on, the media distribution lists
 * it's sent to (by name), and whose News on Demand inboxes it reaches. NoD has no "how many
 * subscribers would get this" endpoint, so it names the categories subscribers follow instead
 * of a count. Names come from the same lists the Categories and Publish settings sections read;
 * if a lookup fails, the keys are shown instead.
 */
function PublishConsequences({ view }: { view: ReleaseView }): React.JSX.Element {
  const rules = typeRules(view.type);
  const publicSiteUrl = usePublicSiteUrl();
  const [lists, setLists] = useState<MediaListName[] | null>(null);
  const [categories, setCategories] = useState<Categories | null>(null);

  // NoD and media sends go out once per release (apps/nrms/src/releases/workflow.ts: the send
  // keys are insert-or-ignore), so a release published before (a correction, or one unpublished
  // and published again) emails nobody this time.
  const alreadySent = view.releasedAt !== null;
  const toLists = !alreadySent && rules.mediaListsAllowed && view.publishOptions.toMediaLists && view.mediaListKeys.length > 0;
  const toSubscribers = !alreadySent && rules.nodAllowed && view.publishOptions.toSubscribers;

  useEffect(() => {
    let active = true;
    if (toLists) apiFetch<MediaListName[]>("/nrms/api/media-lists").then((l) => active && setLists(l), () => {});
    if (toSubscribers) apiFetch<Categories>("/nrms/api/categories").then((c) => active && setCategories(c), () => {});
    return () => {
      active = false;
    };
  }, [toLists, toSubscribers]);

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

  return (
    <ul className="gcpe-publish-consequences">
      <li>{view.publishOptions.toWeb ? `Publishes to ${host || "the public news site"} now.` : "Doesn't go on the public news site."}</li>
      {alreadySent ? (
        <li>Subscribers and media lists already received this when it was first published; they won&rsquo;t be emailed again.</li>
      ) : (
        <>
          <li>{toLists ? `Sends to media distribution lists: ${listText(listNames)}.` : "No media distribution lists."}</li>
          <li>
            {toSubscribers
              ? `Emails News on Demand subscribers who follow ${followed.length > 0 ? `any of: ${listText([...new Set(followed)])}` : "this release's categories"}${view.ministries.length > 0 ? " — and everyone subscribed to all news" : ""}.`
              : "News on Demand subscribers will not be emailed."}
          </li>
        </>
      )}
    </ul>
  );
}
