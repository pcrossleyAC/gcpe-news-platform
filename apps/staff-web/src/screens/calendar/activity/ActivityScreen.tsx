import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { AlertDialog, InlineAlert, Modal } from "@bcgov/design-system-react-components";
import { checkActivity, friendlySpan, inferLookAhead, type ActivityFields, type ActivityView, type ClonePrefill, type EditorOptions, type FieldError, type HqSection } from "@gcpe/calendar-contract";
import { ApiError, onUnauthorized } from "../../../api/client";
import { Button } from "../../../shared/BusyButton";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { useShortcut } from "../../../shared/shortcuts";
import { LeavePageDialog, useLeaveBlocker } from "../../../shared/LeaveGuard";
import type { CalendarMe } from "../access";
import { useCalendarContext } from "../CalendarSection";
import { listApi } from "../list/api";
import { todayIn } from "../list/dates";
import type { CalendarConfigView } from "../list/types";
import { useSession } from "../../../session/SessionContext";
import { ActivityActions, type ReloadResult } from "./ActivityActions";
import { ActivityForm, type Change } from "./ActivityForm";
import { activityApi } from "./api";
import { clearActivityDraft, loadActivityDraft, saveActivityDraft, type DraftId } from "./draft";
import { bodyOf, errorsByField, fieldId, initialOverride, lookAheadInputOf, minIdOf, newActivityFields, withInferredSection, withMyContact } from "./form";
import { LockBanner } from "./LockBanner";
import { RecordsSection } from "./RecordsSection";
import { plannedReleases, releaseLabel, ReleasesList } from "./ReleasesList";
import { activityPath, safeCalendarReturn } from "./paths";
import { useEditLock } from "./useEditLock";

const ID = /^\d{1,9}$/;
/** The roles NRMS lets read a release (AppShell, apps/nrms/src/http/routes.ts): only they get BC Gov News's links. */
const NRMS_READ_ROLES = ["NRMS.Viewer", "NRMS.Editor", "NRMS.SiteEditor"];
const STATUS = { new: "New", changed: "Changed", reviewed: "Reviewed" } as const;
const COULDNT_RELOAD = "Couldn't reload. Your changes are still here.";
/** The fields whose change can leave a linked release behind (suite review CAL-4). */
const TIMING: readonly (keyof ActivityFields)[] = ["startDate", "startTime", "endDate", "endTime", "isAllDay", "nrDate", "nrTime"];
interface Loaded {
  config: CalendarConfigView;
  options: EditorOptions;
  view: ActivityView | null;
  /** A new activity filled from Clone: unsaved until Save (owner, 2026-10-31). */
  clone: ClonePrefill | null;
}

/** The route element, keyed by id (and the activity a clone copies), so moving to a clone or to a just-created activity starts afresh. */
export function ActivityRoute(): React.JSX.Element {
  const { id } = useParams();
  const [params] = useSearchParams();
  const clone = id === undefined ? params.get("clone") : null;
  return <ActivityScreen key={`${id ?? "new"}:${clone ?? ""}`} idParam={id ?? null} />;
}

/** `/hub/calendar/activities/:id` and `/new` (spec addendum §8.2): loads, then hands over to the editor. Not visible is "not found" (§6). */
export function ActivityScreen({ idParam }: { idParam: string | null }): React.JSX.Element {
  const me = useCalendarContext();
  const [params] = useSearchParams();
  const location = useLocation();
  const returnTo = safeCalendarReturn(params.get("return"));
  const id = idParam !== null && ID.test(idParam) ? Number(idParam) : null;
  const cloneParam = idParam === null ? params.get("clone") : null;
  const cloneOf = cloneParam !== null && ID.test(cloneParam) ? Number(cloneParam) : null;
  const badParam = (idParam !== null && id === null) || (cloneParam !== null && cloneOf === null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<"not_found" | { text: string } | null>(badParam ? "not_found" : null);
  useDocumentTitle(failure === "not_found" ? "Activity not found" : failure ? "Activity" : null);

  useEffect(() => {
    if (badParam) return;
    let live = true;
    Promise.all([
      listApi.config(),
      activityApi.options(),
      id === null ? Promise.resolve(null) : activityApi.get(id),
      cloneOf === null ? Promise.resolve(null) : activityApi.clonePrefill(cloneOf),
    ]).then(
      ([config, options, view, clone]) => {
        if (live) setLoaded({ config, options, view, clone });
      },
      (e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) return setFailure("not_found");
        // A clone refused (deleted, or no longer theirs to copy): the server's reason.
        setFailure({ text: cloneOf !== null && e instanceof ApiError && e.status < 500 && e.status !== 401 ? e.message : "Couldn't load this activity." });
      },
    );
    return () => {
      live = false;
    };
  }, [id, cloneOf, badParam]);

  if (failure === "not_found") {
    return (
      <div>
        <h1>Activity not found</h1>
        <p>It doesn&rsquo;t exist, or you can&rsquo;t see it.</p>
        <p>
          <Link to={returnTo}>Back to the Calendar</Link>
        </p>
      </div>
    );
  }
  if (failure) {
    return (
      <div>
        <h1>Activity</h1>
        <InlineAlert variant="danger" role="alert" description={failure.text} />
        <p>
          <Link to={returnTo}>Back to the Calendar</Link>
        </p>
      </div>
    );
  }
  // No heading until the editor's own: one h1 that appears once, as the other Calendar screens do.
  if (!loaded) return <p>Loading…</p>;
  const notice = (location.state as { calendarNotice?: string } | null)?.calendarNotice ?? null;
  return <ActivityEditor me={me} {...loaded} returnTo={returnTo} notice={notice} />;
}

/** A field the form shows gets a link; one it doesn't (the hidden Release fieldset's, say) is named in plain text. */
const shown = (field: string) => field !== "" && typeof document !== "undefined" && document.getElementById(fieldId(field)) !== null;

/** A 400's schema issues, against the field each names ("lookAhead.hqComments" for the Look Ahead fieldset's). */
function issueErrors(e: ApiError): FieldError[] {
  return (e.issues ?? []).map((raw) => {
    const issue = raw as { path?: (string | number)[]; message?: string };
    const path = issue.path ?? [];
    const field = path[0] === "lookAhead" ? path.slice(0, 2).join(".") : String(path[0] ?? "");
    return { field, message: issue.message ?? e.message };
  });
}

const ErrorSummary = forwardRef<HTMLDivElement, { errors: FieldError[] }>(function ErrorSummary({ errors }, ref) {
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="gcpe-error-summary" aria-labelledby="activity-errors-heading">
      <h2 id="activity-errors-heading">Fix these to save</h2>
      <ul>
        {errors.map((e, i) => (
          <li key={`${e.field}-${i}`}>{shown(e.field) ? <a href={`#${fieldId(e.field)}`}>{e.message}</a> : e.message}</li>
        ))}
      </ul>
    </div>
  );
});

interface EditorProps extends Loaded {
  me: CalendarMe;
  returnTo: string;
  notice: string | null;
}

function ActivityEditor({ me, config, options, view: initial, clone, returnTo, notice }: EditorProps): React.JSX.Element {
  const navigate = useNavigate();
  const session = useSession();
  const isNew = initial === null;
  const draftId: DraftId = initial?.id ?? (clone ? `clone-${clone.sourceId}` : "new");
  // Changes kept when a 401 sent the user to sign in, restored on the same activity with the
  // version they were based on. Only where they could still be saved.
  const [restored] = useState(() => {
    const editable = isNew ? config.editor.create : initial.can.edit && !initial.isDeleted;
    return editable ? loadActivityDraft(me.userId, draftId) : null;
  });
  const [view, setView] = useState(() => (initial && restored?.version != null ? { ...initial, version: restored.version } : initial));
  const start = useMemo(
    () =>
      initial?.fields ??
      clone?.fields ??
      withMyContact(withInferredSection(newActivityFields(me, config.lookAheadFieldset), false, options, config.rules, null), options, me.userId),
    [initial, clone, me, config, options],
  );
  const [fields, setFields] = useState<ActivityFields>(() => restored?.fields ?? start);
  const original = useRef(start);
  // A new activity's legacy prefills (suite review CAL-2): End follows Start, and Comm Contact
  // follows the lead ministry, until the user sets them. A copy running several days keeps its End.
  const [endFollows, setEndFollows] = useState(() => {
    const f = restored?.fields ?? start;
    return isNew && (f.endDate === null || f.endDate === f.startDate);
  });
  const [contactFollows, setContactFollows] = useState(isNew);
  const [overridden, setOverriddenState] = useState(() => {
    // Restored changes are judged as the server judges stored ones: a section their own values don't infer is an override.
    // A clone's section is judged the same way: an override on the source stays one on the copy.
    const la = restored?.fields.lookAhead ?? clone?.fields.lookAhead;
    const f = restored?.fields ?? clone?.fields;
    if (la && f) return initialOverride(la.hqSection, inferLookAhead(lookAheadInputOf(f, options, initial?.fields.lookAhead?.hqSection ?? clone?.fields.lookAhead?.hqSection ?? null), config.rules));
    return initial?.lookAhead ? initialOverride(initial.lookAhead.hqSection, initial.lookAhead.inferred) : false;
  });
  const overriddenRef = useRef(overridden);
  const setOverridden = (v: boolean) => {
    overriddenRef.current = v;
    setOverriddenState(v);
  };
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState<{ text: string; conflict: boolean } | null>(null);
  const [saving, setSavingState] = useState(false);
  /** Read synchronously: a second Save, Save and review or Ctrl+S while one is under way sends nothing. */
  const savingRef = useRef(false);
  const setSaving = (v: boolean) => {
    savingRef.current = v;
    setSavingState(v);
  };
  /** The save under way is a Save and review. */
  const [reviewing, setReviewing] = useState(false);
  const [dirty, setDirtyState] = useState(restored !== null);
  const dirtyRef = useRef(restored !== null);
  const setDirty = (v: boolean) => {
    dirtyRef.current = v;
    setDirtyState(v);
  };
  const leaving = useRef(false);
  const summary = useRef<HTMLDivElement>(null);
  /** A save answered "deleted": nothing more can be saved here, but the changes stay on screen. */
  const [deletedMeanwhile, setDeletedMeanwhile] = useState(false);

  // A 401 is about to send the user to sign in (RequireAuth unmounts this page first, so the
  // leave-page guard can't ask): keep the unsaved changes for when they come back.
  const latest = useRef({ fields, version: view?.version ?? null });
  latest.current = { fields, version: view?.version ?? null };
  useEffect(
    () =>
      onUnauthorized(() => {
        if (dirtyRef.current) saveActivityDraft(me.userId, { activityId: draftId, version: latest.current.version, fields: latest.current.fields });
      }),
    [me.userId, draftId],
  );
  const forgetDraft = () => clearActivityDraft(me.userId, draftId);

  const storedSection: HqSection | null = view?.fields.lookAhead?.hqSection ?? null;
  const fieldset = isNew ? config.lookAheadFieldset : view!.lookAhead !== null;
  const canEdit = isNew ? config.editor.create : view!.can.edit;

  /** Fetches the stored activity again. `discard` takes its values over any unsaved changes. */
  const reload = useCallback(async (discard = false): Promise<ActivityView | null> => {
    if (!initial) return null;
    try {
      const v = await activityApi.get(initial.id);
      const keep = dirtyRef.current && !discard;
      // Unsaved changes keep the version and values they were based on, so their save meets a
      // newer change as a 409 instead of overwriting it; only the lock and what the user may do
      // follow the server.
      // Files don't change the version, so the server's list is taken either way.
      setView((prev) => (keep && prev ? { ...prev, lock: v.lock, can: v.can, isDeleted: v.isDeleted, files: v.files } : v));
      if (!keep) {
        setFields(v.fields);
        original.current = v.fields;
      }
      return v;
    } catch {
      return null;
    }
  }, [initial]);
  const lock = useEditLock({ activityId: initial?.id ?? null, initial: initial?.lock ?? null, enabled: canEdit && !initial?.isDeleted, resumed: restored !== null, reload });
  const frozen = config.freeze.appliesToYou;
  const lockedOut = lock.state.kind === "other" || lock.state.kind === "elsewhere" || lock.state.kind === "gone";
  const readOnly = !canEdit || frozen || lockedOut || !!view?.isDeleted || deletedMeanwhile;
  const inferred = inferLookAhead(lookAheadInputOf(fields, options, storedSection), config.rules);
  // A release still to go out is planned against this activity's timing; changing it here doesn't move the release (suite review CAL-4).
  const planned = view && !readOnly ? plannedReleases(view.releases) : [];
  const releaseWarning =
    view && planned.length > 0 && TIMING.some((k) => fields[k] !== original.current[k])
      ? `A release is planned against ${minIdOf(view)} (${planned.map((r) => releaseLabel(r, config.timeZone)).join("; ")}). Changing the date or time here doesn't move the release. Tell the release editor.`
      : null;

  const title = isNew ? "New activity" : `Activity ${minIdOf(view!)}`;
  useDocumentTitle(title);

  const change: Change = (patch) => {
    if (readOnly) return;
    const first = !dirtyRef.current;
    setFields((f) => withInferredSection(typeof patch === "function" ? patch(f) : { ...f, ...patch }, overriddenRef.current, options, config.rules, storedSection));
    setDirty(true);
    void lock.touch().then((ok) => {
      if (!ok && first) {
        setFields(original.current);
        setDirty(false);
      }
    });
  };
  const lookAhead = {
    visible: fieldset,
    inferred,
    overridden,
    choose: (section: HqSection) => {
      setOverridden(inferred.kind === "section" && section !== inferred.section);
      change((x) => ({ ...x, lookAhead: { ...x.lookAhead!, hqSection: section } }));
    },
    reset: () => {
      setOverridden(false);
      change((x) => x);
    },
  };

  // In-app navigation with unsaved changes asks first; closing or reloading the tab gets the
  // browser's own prompt (the Hub's shared rule, shared/LeaveGuard.tsx).
  const blocker = useLeaveBlocker(dirty, { keepsDraft: true, leaving, isDirty: () => dirtyRef.current });

  // Back on the list, the row for this activity is brought into view and given focus.
  const backOnList = (to: string) => (to === returnTo && view ? { calendarActivityId: view.id } : {});
  const leave = (to: string, calendarNotice: string, replace = false) => {
    leaving.current = true;
    navigate(to, { state: { calendarNotice, ...backOnList(to) }, replace });
  };
  const showErrors = (es: FieldError[]) => {
    setErrors(es);
    setTimeout(() => summary.current?.focus(), 0);
  };
  const writeFailed = (e: unknown) => {
    if (e instanceof ApiError && e.status === 422) return showErrors((e.body as { errors?: FieldError[] } | undefined)?.errors ?? [{ field: "", message: e.message }]);
    if (e instanceof ApiError && e.status === 400 && e.issues?.length) return showErrors(issueErrors(e));
    if (e instanceof ApiError && e.status === 409 && e.code === "version_conflict") return setFailure({ text: e.message, conflict: true });
    if (e instanceof ApiError && e.status === 409 && e.code === "deleted") return deletedUnderneath(e.message);
    // The freeze, or who holds the lock: the lock's banner says it, once.
    if (e instanceof ApiError && e.status === 423) return lock.refused(e);
    // Gone (deleted, or no longer visible): the lock's banner says so and the form goes read-only, the changes still on screen.
    if (e instanceof ApiError && e.status === 404) return lock.refused(e);
    setFailure({ text: e instanceof ApiError && e.status < 500 ? e.message : "Couldn't save. Your changes are still here; try again.", conflict: false });
  };
  /** A file write's refusal: "deleted" as Save's, and the rest by the lock's banner. */
  const fileRefused = (e: unknown) => {
    if (e instanceof ApiError && e.status === 409 && e.code === "deleted") return deletedUnderneath(e.message);
    lock.refused(e);
  };
  /** Deleted under the page: nothing more can be saved, the changes stay on screen, and what is
   * offered follows the stored activity (a deleted one offers HQ Administrators Review, §6). */
  const deletedUnderneath = (text: string) => {
    setDeletedMeanwhile(true);
    setFailure({ text, conflict: false });
    setView((prev) => (prev ? { ...prev, isDeleted: true } : prev));
    void followStored();
  };
  /** Takes the stored activity's version, state and permissions, but not its values. Only once
   * nothing more can be saved here: the version unsaved changes were based on is no longer needed. */
  const followStored = async () => {
    try {
      const v = await activityApi.get(initial!.id);
      setStillVisible(true);
      setView((prev) => (prev ? { ...prev, version: v.version, isDeleted: v.isDeleted, can: v.can, lock: v.lock, files: v.files, status: v.status } : prev));
    } catch (e) {
      // Not visible any more: the lock's banner says it has gone, and nothing is offered.
      if (e instanceof ApiError && e.status === 404) lock.refused(e);
    }
  };
  /** The stored activity could still be fetched after the page found it gone or deleted. */
  const [stillVisible, setStillVisible] = useState(false);
  const gone = lock.state.kind === "gone";
  const followedGone = useRef(false);
  useEffect(() => {
    if (!gone || deletedMeanwhile || followedGone.current) return;
    followedGone.current = true;
    void followStored();
    // Once per page: followStored is a fresh closure each render, but reads nothing that changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gone, deletedMeanwhile]);
  const extra = (warnings: string[]) => (warnings.length ? ` ${warnings.join(" ")}` : "");

  // ⌘/Ctrl+S saves from any field, as Save does; on a new activity ⌘/Ctrl+Enter creates it too.
  // A press while a save is under way is ignored.
  const formRef = useRef<HTMLFormElement>(null);
  const submitForm = () => {
    if (!saving) formRef.current?.requestSubmit();
  };
  useShortcut("save", readOnly ? null : submitForm);
  useShortcut("submit", !readOnly && isNew ? submitForm : null);

  /** Why Review refused, once the save before it had gone through (Save and review). */
  const reviewRefusal = (e: unknown): { text: string; conflict: boolean } | null => {
    const saved = `Saved ${minIdOf(view!)}, but it wasn't marked reviewed:`;
    if (!(e instanceof ApiError)) return { text: `${saved} couldn't reach the server. Choose Review to try again.`, conflict: false };
    if (e.status === 401) return null;
    if (e.status === 409 && e.code === "version_conflict") return { text: `${saved} someone changed it in between. Reload to see their change, then choose Review.`, conflict: true };
    return { text: `${saved} ${e.message}`, conflict: false };
  };
  /** The save went through but Review didn't: the page holds the saved activity, nothing unsaved. */
  const showSaved = (v: ActivityView) => {
    setView(v);
    setFields(v.fields);
    original.current = v.fields;
    setDirty(false);
    setOverridden(v.lookAhead ? initialOverride(v.lookAhead.hqSection, v.lookAhead.inferred) : false);
  };

  /**
   * Save; with `andReview` (Save and review, for those who can review: owner, 2026-10-31), then
   * Review at the version the save returned, exactly as choosing Review after Save would. A failed
   * save reviews nothing; a failed review leaves the activity saved and says so.
   */
  const save = async (andReview = false) => {
    if (savingRef.current) return;
    setFailure(null);
    const problems = checkActivity(fields, {
      rules: config.rules,
      relaxRequired: config.editor.relaxRequired,
      lookAheadFieldset: fieldset,
      // A copy is judged against its source, as the server judges it.
      previous: view?.fields ?? clone?.fields ?? null,
      inferredSection: inferred.kind === "section" ? inferred.section : null,
    });
    if (problems.length) return showErrors(problems);
    setErrors([]);
    setSaving(true);
    try {
      // A save is input: it keeps the lock alive, or takes it again after a lapse. Refused, the
      // lock's banner says why and the changes stay on screen.
      if (!(await lock.touch())) return;
      const body = bodyOf(fields, fieldset);
      if (isNew) {
        const r = await activityApi.create(body, clone?.sourceId);
        forgetDraft();
        const done = (ref: string) => (clone ? `Cloned ${clone.sourceLabel} as ${ref}.` : `Created ${ref}.`);
        if (r.activity) leave(activityPath(r.id, returnTo), `${done(minIdOf(r.activity))}${extra(r.warnings)}`, true);
        else leave(returnTo, r.warnings.join(" "));
      } else {
        const warned = releaseWarning ? [releaseWarning] : [];
        const r = await activityApi.update(view!.id, { ...body, version: view!.version, tabId: lock.tabId });
        forgetDraft();
        if (andReview && r.activity) {
          try {
            await activityApi.review(r.activity.id, r.activity.version);
          } catch (e) {
            showSaved(r.activity);
            const refused = reviewRefusal(e);
            if (refused) setFailure(refused);
            return;
          }
          leave(returnTo, `Saved and reviewed ${minIdOf(r.activity)}.${extra([...r.warnings, ...warned])}`, true);
          return;
        }
        // Replaces the editor's entry: Back doesn't reopen it, and a reload doesn't repeat the notice.
        leave(returnTo, r.activity ? `Saved ${minIdOf(r.activity)}.${extra([...r.warnings, ...warned])}` : r.warnings.join(" "), true);
      }
    } catch (e) {
      writeFailed(e);
    } finally {
      setSaving(false);
    }
  };

  /** The unsaved changes go only once the stored activity is here to replace them. */
  const discardAndReload = async (): Promise<ReloadResult> => {
    const v = await reload(true);
    if (!v) return "failed";
    forgetDraft();
    setDirty(false);
    setFailure(null);
    setErrors([]);
    setOverridden(v.lookAhead ? initialOverride(v.lookAhead.hqSection, v.lookAhead.inferred) : false);
    return "reloaded";
  };
  /** Reload after a version conflict: with unsaved changes, asks first. */
  const [askReload, setAskReload] = useState<((discard: boolean) => void) | null>(null);
  const requestReload = async (): Promise<ReloadResult> => {
    if (dirtyRef.current) {
      const discard = await new Promise<boolean>((answer) => setAskReload(() => answer));
      setAskReload(null);
      if (!discard) return "kept";
    }
    return discardAndReload();
  };
  const reloadFromSave = async () => {
    const r = await requestReload();
    if (r === "failed") setFailure({ text: COULDNT_RELOAD, conflict: true });
  };

  const stamp =
    view &&
    `${view.isDeleted ? "Deleted" : STATUS[view.status]} · updated ${friendlySpan(new Date(view.lastUpdatedAt), new Date(), config.timeZone)} ago${view.lastUpdatedByName ? ` by ${view.lastUpdatedByName}` : ""}`;
  const contact = view?.fields.contactMinistryKey ?? null;
  const shared = !!view && me.ministryKeys.some((k) => view.fields.sharedWithKeys.includes(k)) && contact !== null && !me.ministryKeys.includes(contact);
  const viewOnly = !canEdit && !view?.isDeleted ? (shared && me.level >= 2 ? "Your ministry is shared on this activity: you can view it but not change it." : "You can view this activity but not change it.") : null;

  return (
    <div className="gcpe-activity">
      <h1>{title}</h1>
      {notice && (
        <p role="status" className="gcpe-notice">
          {notice}
        </p>
      )}
      {restored && (
        <p role="status" className="gcpe-notice">
          Your unsaved changes were restored.
        </p>
      )}
      {clone && (
        <InlineAlert
          variant="info"
          description={`This is an unsaved copy of ${clone.sourceLabel}. Nothing is created until you choose Save. Cancel leaves no copy behind.`}
        />
      )}
      {stamp && <p className="gcpe-hint">{stamp}</p>}
      {view?.isDeleted && <InlineAlert variant="info" description="This activity is deleted. HQ Administrators can review the deletion; nothing else can change it." />}
      {canEdit && frozen && !view?.isDeleted && <InlineAlert variant="warning" title="Change freeze" description={config.freeze.message} />}
      {viewOnly && <p>{viewOnly}</p>}
      <LockBanner lock={lock} timeZone={config.timeZone} />
      {failure && (
        <InlineAlert
          variant="danger"
          role="alert"
          description={failure.text}
          buttons={
            failure.conflict ? (
              <Button variant="secondary" onPress={() => void reloadFromSave()}>
                Reload
              </Button>
            ) : undefined
          }
        />
      )}
      {errors.length > 0 && <ErrorSummary ref={summary} errors={errors} />}
      <form
        ref={formRef}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset className="gcpe-activity-form" disabled={readOnly}>
          <legend className="gcpe-visually-hidden">{title}</legend>
          <ActivityForm
            fields={fields}
            stored={view?.fields ?? clone?.fields ?? null}
            change={change}
            prefill={isNew ? { endFollowsStart: endFollows, contactFollowsMinistry: contactFollows, myUserId: me.userId, chose: (what) => (what === "end" ? setEndFollows(false) : setContactFollows(false)) } : undefined}
            options={options}
            config={config}
            me={me}
            errors={errorsByField(errors)}
            needsReview={view?.needsReview ?? []}
            lookAhead={lookAhead}
            today={todayIn(config.timeZone)}
            readOnly={readOnly}
            release={<ReleasesList releases={view?.releases ?? []} timeZone={config.timeZone} canOpen={NRMS_READ_ROLES.some((r) => session.has(r))} />}
            records={
              isNew ? (
                config.showRecordsSection ? (
                  <fieldset className="gcpe-fieldset gcpe-records">
                    <legend>Records</legend>
                    <p>Save the activity first to add files.</p>
                  </fieldset>
                ) : null
              ) : // Hidden whenever the tenant hides it, whatever files exist, as legacy (Q51).
              config.showRecordsSection ? (
                <RecordsSection
                  activityId={view!.id}
                  files={view!.files}
                  canChange={!readOnly}
                  beforeChange={() => lock.touch()}
                  // Only the list: the version and fields stay those the unsaved changes were based on.
                  onFiles={(files) => setView((v) => (v ? { ...v, files } : v))}
                  refused={fileRefused}
                  timeZone={config.timeZone}
                />
              ) : null
            }
          />
        </fieldset>
        {/* Mounted from the start, so a screen reader hears the warning when it appears. */}
        <div aria-live="polite">{releaseWarning && <InlineAlert variant="warning" description={releaseWarning} />}</div>
        <div className="gcpe-actions">
          {!readOnly && (
            <Button type="submit" isPending={saving && !reviewing} pendingLabel="Saving…" shortcut={isNew ? ["save", "submit"] : "save"}>
              Save
            </Button>
          )}
          {/* No shortcut: ⌘/Ctrl+S stays a plain Save, and marking reviewed takes a deliberate choice. */}
          {!readOnly && !isNew && view!.can.review && (
            <Button
              variant="secondary"
              isPending={saving && reviewing}
              pendingLabel="Saving and reviewing…"
              onPress={() => {
                if (savingRef.current) return;
                setReviewing(true);
                void save(true).finally(() => setReviewing(false));
              }}
            >
              Save and review
            </Button>
          )}
          <Button variant="secondary" onPress={() => navigate(returnTo, { state: backOnList(returnTo) })}>
            {readOnly ? "Back" : "Cancel"}
          </Button>
        </div>
      </form>
      {/* Gone, and not even a deleted activity to review: there is nothing left to act on. */}
      {view && !(gone && !stillVisible) && (
        <ActivityActions
          view={view}
          myName={me.displayName}
          saveAndReview={!readOnly && view.can.review}
          // Deleted underneath, the changes can never be saved, so they don't hold back Review.
          dirty={dirty && !deletedMeanwhile}
          frozen={frozen}
          // Delete can't succeed under someone else's lock, or once the activity has gone.
          deletable={lock.state.kind !== "other" && lock.state.kind !== "gone" && !deletedMeanwhile}
          reload={requestReload}
          returnTo={returnTo}
          // An action that leaves (Delete discards unsaved changes) leaves no kept draft behind.
          leave={(to, calendarNotice, replace) => {
            forgetDraft();
            leave(to, calendarNotice, replace);
          }}
          onWatch={(watch) => setView((v) => (v ? { ...v, watch } : v))}
        />
      )}
      <LeavePageDialog blocker={blocker} message="You have unsaved changes to this activity. Leave anyway and discard them?" onLeave={forgetDraft} />
      <Modal isOpen={askReload !== null} onOpenChange={(open) => { if (!open) askReload?.(false); }} isDismissable>
        <AlertDialog
          role="alertdialog"
          aria-label="Unsaved changes"
          variant="warning"
          title="Unsaved changes"
          buttons={
            <>
              <Button onPress={() => askReload?.(false)}>Keep editing</Button>
              <Button danger onPress={() => askReload?.(true)}>
                Reload
              </Button>
            </>
          }
        >
          <p>Reload and lose your changes? The activity as it is now replaces them.</p>
        </AlertDialog>
      </Modal>
    </div>
  );
}
