import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useBlocker, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { AlertDialog, Button, InlineAlert, Modal } from "@bcgov/design-system-react-components";
import { checkActivity, friendlySpan, inferLookAhead, type ActivityFields, type ActivityView, type EditorOptions, type FieldError, type HqSection } from "@gcpe/calendar-contract";
import { ApiError, onUnauthorized } from "../../../api/client";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import type { CalendarMe } from "../access";
import { useCalendarContext } from "../CalendarSection";
import { listApi } from "../list/api";
import { todayIn } from "../list/dates";
import type { CalendarConfigView } from "../list/types";
import { useSession } from "../../../session/SessionContext";
import { ActivityActions } from "./ActivityActions";
import { ActivityForm, type Change } from "./ActivityForm";
import { activityApi } from "./api";
import { clearActivityDraft, loadActivityDraft, saveActivityDraft } from "./draft";
import { bodyOf, errorsByField, fieldId, initialOverride, lookAheadInputOf, minIdOf, newActivityFields, withInferredSection } from "./form";
import { LockBanner } from "./LockBanner";
import { ReleasesList } from "./ReleasesList";
import { activityPath, safeCalendarReturn } from "./paths";
import { useEditLock } from "./useEditLock";

const ID = /^\d{1,9}$/;
const STATUS = { new: "New", changed: "Changed", reviewed: "Reviewed" } as const;
interface Loaded {
  config: CalendarConfigView;
  options: EditorOptions;
  view: ActivityView | null;
}

/** The route element, keyed by id, so moving to a clone or to a just-created activity starts afresh. */
export function ActivityRoute(): React.JSX.Element {
  const { id } = useParams();
  return <ActivityScreen key={id ?? "new"} idParam={id ?? null} />;
}

/** `/hub/calendar/activities/:id` and `/new` (spec addendum §8.2): loads, then hands over to the editor. Not visible is "not found" (§6). */
export function ActivityScreen({ idParam }: { idParam: string | null }): React.JSX.Element {
  const me = useCalendarContext();
  const [params] = useSearchParams();
  const location = useLocation();
  const returnTo = safeCalendarReturn(params.get("return"));
  const id = idParam !== null && ID.test(idParam) ? Number(idParam) : null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<"not_found" | "error" | null>(idParam !== null && id === null ? "not_found" : null);
  useDocumentTitle(failure === "not_found" ? "Activity not found" : failure ? "Activity" : null);

  useEffect(() => {
    if (idParam !== null && id === null) return;
    let live = true;
    Promise.all([listApi.config(), activityApi.options(), id === null ? Promise.resolve(null) : activityApi.get(id)]).then(
      ([config, options, view]) => {
        if (live) setLoaded({ config, options, view });
      },
      (e: unknown) => {
        if (live) setFailure(e instanceof ApiError && e.status === 404 ? "not_found" : "error");
      },
    );
    return () => {
      live = false;
    };
  }, [id, idParam]);

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
        <InlineAlert variant="danger" role="alert" description="Couldn't load this activity." />
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

function ActivityEditor({ me, config, options, view: initial, returnTo, notice }: EditorProps): React.JSX.Element {
  const navigate = useNavigate();
  const session = useSession();
  const isNew = initial === null;
  const draftId = initial?.id ?? "new";
  // Changes kept when a 401 sent the user to sign in, restored on the same activity with the
  // version they were based on. Only where they could still be saved.
  const [restored] = useState(() => {
    const editable = isNew ? config.editor.create : initial.can.edit && !initial.isDeleted;
    return editable ? loadActivityDraft(me.userId, draftId) : null;
  });
  const [view, setView] = useState(() => (initial && restored?.version != null ? { ...initial, version: restored.version } : initial));
  const start = useMemo(
    () => initial?.fields ?? withInferredSection(newActivityFields(me, config.lookAheadFieldset), false, options, config.rules, null),
    [initial, me, config, options],
  );
  const [fields, setFields] = useState<ActivityFields>(() => restored?.fields ?? start);
  const original = useRef(start);
  const [overridden, setOverriddenState] = useState(() => {
    // Restored changes are judged as the server judges stored ones: a section their own values don't infer is an override.
    const la = restored?.fields.lookAhead;
    if (la) return initialOverride(la.hqSection, inferLookAhead(lookAheadInputOf(restored.fields, options, initial?.fields.lookAhead?.hqSection ?? null), config.rules));
    return initial?.lookAhead ? initialOverride(initial.lookAhead.hqSection, initial.lookAhead.inferred) : false;
  });
  const overriddenRef = useRef(overridden);
  const setOverridden = (v: boolean) => {
    overriddenRef.current = v;
    setOverriddenState(v);
  };
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState<{ text: string; conflict: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
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

  const reload = useCallback(async (): Promise<ActivityView | null> => {
    if (!initial) return null;
    try {
      const v = await activityApi.get(initial.id);
      // Unsaved changes keep the version and values they were based on, so their save meets a
      // newer change as a 409 instead of overwriting it; only the lock and what the user may do
      // follow the server.
      setView((prev) => (dirtyRef.current && prev ? { ...prev, lock: v.lock, can: v.can, isDeleted: v.isDeleted } : v));
      if (!dirtyRef.current) {
        setFields(v.fields);
        original.current = v.fields;
      }
      return v;
    } catch {
      return null;
    }
  }, [initial]);
  const lock = useEditLock({ activityId: initial?.id ?? null, initial: initial?.lock ?? null, enabled: canEdit && !initial?.isDeleted, reload });
  const frozen = config.freeze.appliesToYou;
  const lockedOut = lock.state.kind === "other" || lock.state.kind === "elsewhere" || lock.state.kind === "gone";
  const readOnly = !canEdit || frozen || lockedOut || !!view?.isDeleted || deletedMeanwhile;
  const inferred = inferLookAhead(lookAheadInputOf(fields, options, storedSection), config.rules);

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

  // In-app navigation with unsaved changes asks first; closing or reloading the tab gets the browser's own prompt.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current && !leaving.current && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const leave = (to: string, calendarNotice: string, replace = false) => {
    leaving.current = true;
    navigate(to, { state: { calendarNotice }, replace });
  };
  const showErrors = (es: FieldError[]) => {
    setErrors(es);
    setTimeout(() => summary.current?.focus(), 0);
  };
  const writeFailed = (e: unknown) => {
    if (e instanceof ApiError && e.status === 422) return showErrors((e.body as { errors?: FieldError[] } | undefined)?.errors ?? [{ field: "", message: e.message }]);
    if (e instanceof ApiError && e.status === 400 && e.issues?.length) return showErrors(issueErrors(e));
    if (e instanceof ApiError && e.status === 409 && e.code === "version_conflict") return setFailure({ text: e.message, conflict: true });
    if (e instanceof ApiError && e.status === 409 && e.code === "deleted") {
      setDeletedMeanwhile(true);
      return setFailure({ text: e.message, conflict: false });
    }
    // The freeze, or who holds the lock: the lock's banner says it, once.
    if (e instanceof ApiError && e.status === 423) return lock.refused(e);
    // Gone (deleted, or no longer visible): the lock's banner says so and the form goes read-only, the changes still on screen.
    if (e instanceof ApiError && e.status === 404) return lock.refused(e);
    setFailure({ text: e instanceof ApiError && e.status < 500 ? e.message : "Couldn't save. Your changes are still here; try again.", conflict: false });
  };
  const extra = (warnings: string[]) => (warnings.length ? ` ${warnings.join(" ")}` : "");

  const save = async () => {
    setFailure(null);
    const problems = checkActivity(fields, {
      rules: config.rules,
      relaxRequired: config.editor.relaxRequired,
      lookAheadFieldset: fieldset,
      previous: view?.fields ?? null,
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
        const r = await activityApi.create(body);
        forgetDraft();
        if (r.activity) leave(activityPath(r.id, returnTo), `Created ${minIdOf(r.activity)}.${extra(r.warnings)}`, true);
        else leave(returnTo, r.warnings.join(" "));
      } else {
        const r = await activityApi.update(view!.id, { ...body, version: view!.version, tabId: lock.tabId });
        forgetDraft();
        // Replaces the editor's entry: Back doesn't reopen it, and a reload doesn't repeat the notice.
        leave(returnTo, r.activity ? `Saved ${minIdOf(r.activity)}.${extra(r.warnings)}` : r.warnings.join(" "), true);
      }
    } catch (e) {
      writeFailed(e);
    } finally {
      setSaving(false);
    }
  };

  const discardAndReload = async () => {
    forgetDraft();
    setDirty(false);
    setFailure(null);
    setErrors([]);
    const v = await reload();
    if (v) setOverridden(v.lookAhead ? initialOverride(v.lookAhead.hqSection, v.lookAhead.inferred) : false);
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
              <Button variant="secondary" onPress={() => void discardAndReload()}>
                Reload
              </Button>
            ) : undefined
          }
        />
      )}
      {errors.length > 0 && <ErrorSummary ref={summary} errors={errors} />}
      <form
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
            stored={view?.fields ?? null}
            change={change}
            options={options}
            config={config}
            me={me}
            errors={errorsByField(errors)}
            needsReview={view?.needsReview ?? []}
            lookAhead={lookAhead}
            today={todayIn(config.timeZone)}
            release={<ReleasesList releases={view?.releases ?? []} timeZone={config.timeZone} canOpen={session.roles.some((r) => r.startsWith("NRMS."))} />}
            records={null}
          />
        </fieldset>
        <div className="gcpe-actions">
          {!readOnly && (
            <Button type="submit" isDisabled={saving}>
              Save
            </Button>
          )}
          <Button variant="secondary" onPress={() => navigate(returnTo)}>
            {readOnly ? "Back" : "Cancel"}
          </Button>
        </div>
      </form>
      {view && (
        <ActivityActions
          view={view}
          myName={me.displayName}
          dirty={dirty}
          returnTo={returnTo}
          // An action that leaves (Delete discards unsaved changes) leaves no kept draft behind.
          leave={(to, calendarNotice, replace) => {
            forgetDraft();
            leave(to, calendarNotice, replace);
          }}
          onWatch={(watch) => setView((v) => (v ? { ...v, watch } : v))}
        />
      )}
      <Modal isOpen={blocker.state === "blocked"} onOpenChange={(open) => { if (!open) blocker.reset?.(); }} isDismissable>
        <AlertDialog
          role="alertdialog"
          aria-label="Unsaved changes"
          variant="warning"
          title="Unsaved changes"
          buttons={
            <>
              <Button onPress={() => blocker.reset?.()}>Stay</Button>
              <Button
                danger
                onPress={() => {
                  forgetDraft();
                  blocker.proceed?.();
                }}
              >
                Leave
              </Button>
            </>
          }
        >
          <p>You have unsaved changes to this activity. Leave anyway and discard them?</p>
        </AlertDialog>
      </Modal>
    </div>
  );
}
