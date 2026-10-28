import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import type { OrgRecord } from "@gcpe/events/catalogue";
import { ApiError, apiFetch } from "../../../api/client";
import { useTenantTimeZoneStatus } from "../../../format/tenantTimeZone";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { SchedulePicker, type ScheduleValue } from "../../release/sections/SchedulePicker";
import { messagesOf } from "../messages";
import { ALL_MOVES, HandOverMoveBoxes, useHandOverCounts, type HandOverMoves } from "./HandOverPanel";
import { deactivateWarning } from "./OrganizationEditForm";
import { normalizeAbbreviation } from "./abbreviation";
import { isCoreAdmin } from "./access";

/*
 * Core's cabinet change (apps/core/src/services/cabinet-changes.ts), as the Hub sends and reads it.
 */
type Successor = { key: string } | { ref: string };
interface SucceedMoves {
  moveSubscribers: boolean;
  moveStaff: boolean;
  moveCalendar: boolean;
  moveDrafts: boolean;
  takeAbbreviation: boolean;
}
interface UpdateOp {
  op: "update";
  key: string;
  expectedUpdatedAt: string;
  patch: { displayName?: string; abbreviation?: string; minister?: { name: string | null } };
}
interface CreateOp {
  op: "create";
  ref: string;
  displayName: string;
  abbreviation?: string;
  minister?: { name: string };
}
interface SucceedOp {
  op: "succeed";
  key: string;
  expectedUpdatedAt: string;
  successors: Successor[];
  moves: SucceedMoves;
  noSuccessor?: boolean;
}
type Operation = UpdateOp | CreateOp | SucceedOp;

interface CabinetChange {
  id: string;
  status: "draft" | "scheduled" | "published" | "cancelled";
  scheduledFor: string | null;
  operations: Operation[];
  error: string | null;
  updatedAt: string;
}
interface Problem {
  op: number;
  message: string;
}
interface DiffRow {
  key: string;
  displayName: string;
  kind: "created" | "changed";
  field: string;
  from: unknown;
  to: unknown;
}
interface Preview {
  diff: DiffRow[];
  resulting: OrgRecord[];
  problems: Problem[];
}

const API = "/core/api/cabinet-change";

/** Core's stale refusal, with the Hub's instruction (task-15 brief copy). */
export const staleCopy = (ministry: string) =>
  `${ministry} was changed by someone else since this draft was started. Review it and publish again.`;

/** "Publishes on {Month D, YYYY} at {h:mm a.m./p.m.} Pacific." in the tenant's time zone. */
export function scheduledCopy(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const period = get("dayPeriod").toUpperCase().startsWith("A") ? "a.m." : "p.m.";
  return `Publishes on ${get("month")} ${get("day")}, ${get("year")} at ${get("hour")}:${get("minute")} ${period} Pacific.`;
}

const NOT_OPEN = "This cabinet change is no longer open. Someone else may have published or discarded it.";

/** The body of a refused publish or schedule (409/422/404 carry `{result, …}`). */
function resultOf(caught: unknown): { result?: string; key?: string; problems?: Problem[]; error?: string } | null {
  if (!(caught instanceof ApiError)) return null;
  const body = caught.body as { result?: string } | undefined;
  return body && typeof body === "object" ? (body as ReturnType<typeof resultOf>) : null;
}

const FIELD_LABELS: Record<string, string> = {
  displayName: "Name",
  abbreviation: "Abbreviation",
  sortOrder: "Position in list",
  isActive: "Active",
  minister: "Minister",
  successorKeys: "Pages send visitors to",
  parentKey: "Part of",
  isPublic: "Listed publicly",
  isHq: "HQ organization",
  url: "Web address",
};

/**
 * `/hub/organizations/cabinet-change` (Core.Admin; new-government spec §5). One cabinet change is
 * open at a time. Staff add renames, new ministries and hand-overs (a merge is two hand-overs to one
 * new ministry; a split is one hand-over to two), each saved to Core's draft as it is added. Preview
 * runs the whole change in Core without writing it and shows what would change and any problems.
 * After a clean preview it can be published now (in one step: all of it or none) or scheduled for
 * the swearing-in time, entered in BC time.
 */
export function CabinetChangeScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle("Cabinet change");
  const admin = isCoreAdmin(session);
  const { timeZone, resolved } = useTenantTimeZoneStatus();
  const uid = useId();

  const [orgs, setOrgs] = useState<OrgRecord[] | null>(null);
  // undefined: still loading; null: no open change.
  const [change, setChange] = useState<CabinetChange | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [adding, setAdding] = useState<"update" | "create" | "succeed" | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState<"publish" | "discard" | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [when, setWhen] = useState<ScheduleValue | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const addButtons = useRef(new Map<string, HTMLButtonElement>());
  const changesHeading = useRef<HTMLHeadingElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const confirmGroup = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const publishButton = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<(() => HTMLElement | null) | null>(null);

  const loadOrgs = useCallback(() => {
    apiFetch<OrgRecord[]>("/core/api/organizations").then(setOrgs, () => setLoadError("Couldn't load the ministries. Reload the page to try again."));
  }, []);
  const loadChange = useCallback(() => {
    apiFetch<CabinetChange>(API).then(
      (c) => setChange(c),
      (caught) => {
        if (caught instanceof ApiError && caught.status === 404) setChange(null);
        else setLoadError("Couldn't load the cabinet change. Reload the page to try again.");
      },
    );
  }, []);

  useEffect(() => {
    if (!admin) return;
    loadOrgs();
    loadChange();
  }, [admin, loadOrgs, loadChange]);

  useEffect(() => {
    const target = focusNext.current?.();
    if (target) {
      target.focus();
      focusNext.current = null;
    }
  });

  if (!admin) {
    return (
      <div className="gcpe-cabinet-change">
        <h1>Cabinet change</h1>
        <p>You don&rsquo;t have permission to view this page.</p>
      </div>
    );
  }

  const byKey = new Map((orgs ?? []).map((o) => [o.key, o]));
  const ops = change?.operations ?? [];
  const nameOf = (key: string) => byKey.get(key)?.displayName ?? key;

  /** Runs one write at a time; a second click while one is in flight is ignored. */
  const run = async (work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessages([]);
    setStatus(null);
    try {
      await work();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  /** Saves the draft's operations. Any edit clears the preview, and takes a scheduled change off its schedule. */
  const save = async (next: Operation[]): Promise<boolean> => {
    const wasScheduled = change?.status === "scheduled";
    try {
      const saved = await apiFetch<CabinetChange>(API, { method: "PUT", body: { operations: next } });
      setChange(saved);
      setPreview(null);
      setConfirm(null);
      setScheduling(false);
      if (wasScheduled) setMessages(["Editing the change took it off its schedule. Preview it, then schedule it again."]);
      return true;
    } catch (caught) {
      setMessages(messagesOf(caught));
      return false;
    }
  };

  const add = (op: Operation, summary: string, opener: string) =>
    run(async () => {
      if (await save([...ops, op])) {
        setAdding(null);
        setStatus(`Added: ${summary}.`);
        focusNext.current = () => addButtons.current.get(opener) ?? null;
      }
    });

  const remove = (index: number) =>
    run(async () => {
      if (await save(ops.filter((_, i) => i !== index))) {
        setStatus(`Removed change ${index + 1}.`);
        focusNext.current = () => changesHeading.current;
      }
    });

  /** After a stale refusal: keep this change as it is, against the ministry as it is now. */
  const keep = (index: number) =>
    run(async () => {
      const op = ops[index];
      if (!op || op.op === "create") return;
      const current = byKey.get(op.key);
      if (!current) return;
      if (await save(ops.map((o, i) => (i === index ? { ...op, expectedUpdatedAt: current.updatedAt } : o)))) {
        setStatus(`Change ${index + 1} is kept. Preview again before publishing.`);
        focusNext.current = () => changesHeading.current;
      }
    });

  const runPreview = () =>
    run(async () => {
      try {
        setPreview(await apiFetch<Preview>(`${API}/preview`, { method: "POST" }));
        setConfirm(null);
        focusNext.current = () => previewHeading.current;
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 404) return gone();
        setMessages(messagesOf(caught));
      }
    });

  /** The change was published or discarded elsewhere. */
  const gone = () => {
    setMessages([NOT_OPEN]);
    setPreview(null);
    setConfirm(null);
    setScheduling(false);
    loadChange();
    loadOrgs();
  };

  /** A refusal with problems: they're listed under Preview. */
  const showProblems = (problems: Problem[]) => {
    setPreview((p) => ({ diff: p?.diff ?? [], resulting: p?.resulting ?? [], problems }));
    setMessages(["Nothing was published. Fix the problems listed under Preview, then try again."]);
  };

  const publish = () =>
    run(async () => {
      try {
        await apiFetch(`${API}/publish`, { method: "POST" });
        setChange(null);
        setPreview(null);
        setConfirm(null);
        setStatus(
          "The cabinet change is published. The public Ministries page updates within a few minutes. Subscribers, staff, Calendar activities and draft releases move to their new ministries shortly after.",
        );
        focusNext.current = () => statusRef.current;
        loadOrgs();
      } catch (caught) {
        setConfirm(null);
        const r = resultOf(caught);
        if (r?.result === "stale" && r.key) {
          setMessages([staleCopy(nameOf(r.key))]);
          setPreview(null);
          loadOrgs();
        } else if (r?.result === "invalid" && r.problems) showProblems(r.problems);
        else if (r?.result === "not-open" || (caught instanceof ApiError && caught.status === 404)) gone();
        else setMessages(messagesOf(caught));
        focusNext.current = () => messagesRef.current;
      }
    });

  const schedule = () =>
    run(async () => {
      if (!when) {
        setMessages(["Enter the date and time to publish."]);
        return;
      }
      if (!resolved) {
        setMessages(["Still loading the time zone. Try again in a moment."]);
        return;
      }
      try {
        const saved = await apiFetch<CabinetChange>(`${API}/schedule`, { method: "POST", body: { at: when.instant } });
        setChange(saved);
        setScheduling(false);
        setStatus("Scheduled. It publishes by itself at the time shown; you can leave this page.");
        focusNext.current = () => statusRef.current;
      } catch (caught) {
        const r = resultOf(caught);
        if (r?.result === "invalid" && r.problems) showProblems(r.problems);
        else if (r?.result === "past") setMessages([r.error ?? "Choose a time in the future."]);
        else if (r?.result === "not-open" || (caught instanceof ApiError && caught.status === 404)) gone();
        else setMessages(messagesOf(caught));
        focusNext.current = () => messagesRef.current;
      }
    });

  const unschedule = () =>
    run(async () => {
      if (await save(ops)) {
        setMessages([]);
        setStatus("The change is a draft again and won't publish on its own. Preview it, then publish or schedule it.");
        focusNext.current = () => statusRef.current;
      }
    });

  const discard = () =>
    run(async () => {
      try {
        await apiFetch(`${API}/cancel`, { method: "POST" });
      } catch (caught) {
        if (!(caught instanceof ApiError && caught.status === 404)) {
          setMessages(messagesOf(caught));
          return;
        }
      }
      setChange(null);
      setPreview(null);
      setConfirm(null);
      setScheduling(false);
      setStatus("The cabinet change is discarded. Nothing was published.");
      focusNext.current = () => statusRef.current;
    });

  const createdNames = ops.flatMap((o) => (o.op === "create" ? [o.displayName] : []));
  const handedOver = new Set(ops.flatMap((o) => (o.op === "succeed" ? [o.key] : [])));
  const isStale = (op: Operation) => op.op !== "create" && orgs !== null && byKey.has(op.key) && byKey.get(op.key)!.updatedAt !== op.expectedUpdatedAt;
  const cleanPreview = preview !== null && preview.problems.length === 0;
  const scheduled = change?.status === "scheduled" && change.scheduledFor;
  const loading = !loadError && (orgs === null || change === undefined);

  const opener = (kind: "update" | "create" | "succeed", label: string) => (
    <button
      type="button"
      ref={(el) => {
        if (el) addButtons.current.set(kind, el);
        else addButtons.current.delete(kind);
      }}
      aria-expanded={adding === kind}
      disabled={busy}
      onClick={() => {
        setStatus(null);
        setMessages([]);
        setAdding(kind);
      }}
    >
      {label}
    </button>
  );
  const cancelAdd = () => {
    const kind = adding;
    setAdding(null);
    focusNext.current = () => (kind ? (addButtons.current.get(kind) ?? null) : null);
  };

  return (
    <div className="gcpe-cabinet-change gcpe-stack">
      <p>
        <Link to="/organizations">Back to Organizations</Link>
      </p>
      <h1>Cabinet change</h1>
      <p>
        Prepare every ministry change for a new cabinet here: new names, new ministries, and ministries handed over to
        others. Then publish them all together, right away or at the swearing-in time. Nothing changes on the public site
        or for staff until the change is published.
      </p>
      <ol>
        <li>Add each change below. It is saved as you go, so you can come back to it later.</li>
        <li>Preview to see exactly what will change, and fix any problems it finds.</li>
        <li>Publish now, or schedule it for the swearing-in time.</li>
      </ol>

      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {change?.error && (
        <InlineAlert
          variant="danger"
          title="This change wasn't published"
          description={`${change.error} Fix the problem, preview it again, then publish or schedule it.`}
        />
      )}
      <div ref={messagesRef} tabIndex={-1}>
        {messages.map((m) => (
          <p role="alert" key={m}>
            {m}
          </p>
        ))}
      </div>
      <p role="status" ref={statusRef} tabIndex={-1}>
        {status}
      </p>
      {loading && <p>Loading…</p>}

      {!loading && !loadError && orgs && (
        <>
          {scheduled && (
            <>
              <InlineAlert variant="info" title="Scheduled" description={scheduledCopy(change.scheduledFor!, timeZone)} />
              <p>It publishes by itself at that time; nobody needs to be here. Until then you can still edit it, publish it now, or discard it.</p>
            </>
          )}

          <section aria-labelledby={`${uid}-changes`}>
            <h2 id={`${uid}-changes`} ref={changesHeading} tabIndex={-1}>
              Changes in this cabinet change
            </h2>
            {ops.length === 0 ? (
              <p>No changes yet. Add the first one below.</p>
            ) : (
              <ol aria-labelledby={`${uid}-changes`}>
                {ops.map((op, i) => (
                  <li key={i}>
                    <OperationSummary op={op} byKey={byKey} />
                    {isStale(op) && (
                      <p>
                        <strong>Changed by someone else since you added this.</strong> Check{" "}
                        {nameOf((op as UpdateOp | SucceedOp).key)} on the Organizations page, then keep this change or remove
                        it.{" "}
                        <button type="button" disabled={busy} aria-label={`Keep change ${i + 1}`} onClick={() => void keep(i)}>
                          Keep this change
                        </button>
                      </p>
                    )}
                    <button type="button" disabled={busy} aria-label={`Remove change ${i + 1}`} onClick={() => void remove(i)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ol>
            )}

            <h3>Add a change</h3>
            <p>
              To merge ministries, add the new ministry first, then hand each old ministry over to it. To split one, hand it
              over to more than one successor. To abolish one, hand it over with no successor.
            </p>
            <p className="gcpe-button-row">
              {opener("update", "Rename or change a ministry")} {opener("create", "Add a new ministry")}{" "}
              {opener("succeed", "Hand over a ministry")}
            </p>
            {adding === "update" && (
              <UpdateForm orgs={orgs} busy={busy} onCancel={cancelAdd} onAdd={(op, summary) => void add(op, summary, "update")} onError={setMessages} />
            )}
            {adding === "create" && (
              <CreateForm
                existing={[...orgs.map((o) => o.displayName), ...createdNames]}
                busy={busy}
                onCancel={cancelAdd}
                onAdd={(op, summary) => void add(op, summary, "create")}
                onError={setMessages}
              />
            )}
            {adding === "succeed" && (
              <SucceedForm
                orgs={orgs}
                created={ops.filter((o): o is CreateOp => o.op === "create")}
                handedOver={handedOver}
                busy={busy}
                onCancel={cancelAdd}
                onAdd={(op, summary) => void add(op, summary, "succeed")}
                onError={setMessages}
              />
            )}
          </section>

          {ops.length > 0 && (
            <section aria-labelledby={`${uid}-preview`}>
              <h2 id={`${uid}-preview`}>Preview</h2>
              <p>Preview runs the whole change without saving it, so you can see the result before anyone else does.</p>
              <p>
                <button type="button" disabled={busy} onClick={() => void runPreview()}>
                  {preview ? "Preview again" : "Preview"}
                </button>
              </p>
              {preview && <PreviewResult preview={preview} ops={ops} byKey={byKey} headingRef={previewHeading} uid={uid} />}
            </section>
          )}

          {ops.length > 0 && (
            <section aria-labelledby={`${uid}-publish`}>
              <h2 id={`${uid}-publish`}>Publish</h2>
              {scheduled && (
                <p>
                  <button type="button" disabled={busy} onClick={() => void unschedule()}>
                    Don&rsquo;t publish at that time (keep it as a draft)
                  </button>
                </p>
              )}
              {!cleanPreview ? (
                <p>Preview the change and fix any problems first. Then you can publish it or schedule it.</p>
              ) : (
                <>
                  <p>
                    Publishing makes every change above at once: all of it or none of it. Afterwards the public Ministries
                    page updates within a few minutes, old ministry pages send visitors to their successors, and subscribers,
                    staff, Calendar activities and draft releases move to their new ministries.
                  </p>
                  {confirm === "publish" ? (
                    <div role="group" aria-labelledby={`${uid}-confirm-publish`} ref={confirmGroup} tabIndex={-1}>
                      <p id={`${uid}-confirm-publish`}>
                        Publish {ops.length === 1 ? "this change" : `these ${ops.length} changes`} now? This can&rsquo;t be
                        undone in one step.
                      </p>
                      <button type="button" disabled={busy} onClick={() => void publish()}>
                        Yes, publish now
                      </button>{" "}
                      <button
                        type="button"
                        onClick={() => {
                          setConfirm(null);
                          focusNext.current = () => publishButton.current;
                        }}
                      >
                        Not yet
                      </button>
                    </div>
                  ) : (
                    <p className="gcpe-button-row">
                      <button
                        type="button"
                        ref={publishButton}
                        disabled={busy}
                        onClick={() => {
                          setScheduling(false);
                          setConfirm("publish");
                          focusNext.current = () => confirmGroup.current;
                        }}
                      >
                        Publish now…
                      </button>{" "}
                      {!scheduling && (
                        <button type="button" disabled={busy} onClick={() => setScheduling(true)}>
                          Schedule…
                        </button>
                      )}
                    </p>
                  )}
                  {scheduling && (
                    <form
                      aria-label="Schedule the cabinet change"
                      className="gcpe-stack"
                      noValidate
                      onSubmit={(e) => {
                        e.preventDefault();
                        void schedule();
                      }}
                    >
                      <SchedulePicker timeZone={timeZone} legend="Publish at (BC time)" idPrefix={`${uid}-when`} onChange={setWhen} />
                      <p>Usually the swearing-in time. It publishes by itself then; nobody needs to be here.</p>
                      <button type="submit" disabled={busy}>
                        Schedule
                      </button>{" "}
                      <button type="button" onClick={() => setScheduling(false)}>
                        Cancel
                      </button>
                    </form>
                  )}
                </>
              )}
            </section>
          )}

          {change && (
            <section aria-labelledby={`${uid}-discard`}>
              <h2 id={`${uid}-discard`}>Start over</h2>
              {confirm === "discard" ? (
                <div role="group" aria-labelledby={`${uid}-confirm-discard`} ref={confirmGroup} tabIndex={-1}>
                  <p id={`${uid}-confirm-discard`}>Discard every change in this cabinet change? Nothing has been published.</p>
                  <button type="button" disabled={busy} onClick={() => void discard()}>
                    Yes, discard it
                  </button>{" "}
                  <button type="button" onClick={() => setConfirm(null)}>
                    Keep it
                  </button>
                </div>
              ) : (
                <p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setConfirm("discard");
                      focusNext.current = () => confirmGroup.current;
                    }}
                  >
                    Discard this cabinet change…
                  </button>
                </p>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** A successor as staff read it: an existing ministry's name, or a new one's with "(new)". */
function successorName(s: Successor, byKey: Map<string, OrgRecord>): string {
  return "key" in s ? (byKey.get(s.key)?.displayName ?? s.key) : `${s.ref} (new)`;
}

function moveWords(m: SucceedMoves): string[] {
  return [
    m.moveSubscribers && "subscribers",
    m.moveStaff && "staff",
    m.moveCalendar && "upcoming Calendar activities",
    m.moveDrafts && "draft releases",
    m.takeAbbreviation && "the abbreviation",
  ].filter((w): w is string => typeof w === "string");
}

/** One staged change, in plain words. */
function OperationSummary({ op, byKey }: { op: Operation; byKey: Map<string, OrgRecord> }): React.JSX.Element {
  if (op.op === "create") {
    const extra = [op.abbreviation && `abbreviation ${op.abbreviation}`, op.minister?.name && `minister ${op.minister.name}`].filter(Boolean);
    return <p>{`Add a new ministry: ${op.displayName}${extra.length ? ` (${extra.join(", ")})` : ""}`}</p>;
  }
  const org = byKey.get(op.key);
  const name = org?.displayName ?? op.key;
  if (op.op === "update") return <p>{updateSummary(op, org)}</p>;
  if (op.noSuccessor || op.successors.length === 0) return <p>{`Abolish ${name} (no successor)`}</p>;
  const moves = moveWords(op.moves);
  return (
    <>
      <p>{`Hand ${name} over to ${op.successors.map((s) => successorName(s, byKey)).join(" and ")}`}</p>
      <p>{moves.length ? `Moves ${moves.join(", ")}.` : "Moves only its web pages."}</p>
    </>
  );
}

function updateSummary(op: UpdateOp, org: OrgRecord | undefined): string {
  const name = org?.displayName ?? op.key;
  const parts: string[] = [];
  if (op.patch.abbreviation !== undefined) parts.push(`abbreviation ${org?.abbreviation ?? "none"} → ${op.patch.abbreviation}`);
  if (op.patch.minister !== undefined) parts.push(`minister ${org?.minister.name ?? "none"} → ${op.patch.minister.name ?? "none"}`);
  const head = op.patch.displayName !== undefined ? `Rename ${name} to ${op.patch.displayName}` : `Change ${name}`;
  return parts.length ? `${head}: ${parts.join("; ")}` : head;
}

function formatValue(field: string, value: unknown, names: Map<string, string>): string {
  if (value === null || value === undefined || value === "") return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (field === "minister" && typeof value === "object") return (value as { name?: string | null }).name ?? "None";
  if (field === "successorKeys" && Array.isArray(value)) return value.length ? value.map((k) => names.get(String(k)) ?? String(k)).join(", ") : "None";
  if (field === "parentKey") return names.get(String(value)) ?? String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function PreviewResult({
  preview,
  ops,
  byKey,
  headingRef,
  uid,
}: {
  preview: Preview;
  ops: Operation[];
  byKey: Map<string, OrgRecord>;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  uid: string;
}): React.JSX.Element {
  const names = new Map<string, string>([...byKey].map(([k, o]) => [k, o.displayName]));
  for (const o of preview.resulting) names.set(o.key, o.displayName);
  const active = preview.resulting.filter((o) => o.isActive);
  return (
    <div className="gcpe-stack">
      {preview.problems.length > 0 ? (
        <div role="alert">
          <p>
            <strong>Fix these before publishing:</strong>
          </p>
          <ul>
            {preview.problems.map((p, i) => (
              <li key={i}>{`Change ${p.op + 1}: ${p.message}`}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p>No problems found. You can publish it or schedule it below.</p>
      )}
      <h3 id={`${uid}-diff`} ref={headingRef} tabIndex={-1}>
        What will change
      </h3>
      {preview.diff.length === 0 ? (
        <p>Nothing would change.</p>
      ) : (
        <table className="gcpe-table" aria-labelledby={`${uid}-diff`}>
          <thead>
            <tr>
              <th scope="col">Ministry</th>
              <th scope="col">What</th>
              <th scope="col">Now</th>
              <th scope="col">After publishing</th>
            </tr>
          </thead>
          <tbody>
            {preview.diff.map((row, i) => (
              <tr key={i}>
                <td>{row.displayName}</td>
                <td>{FIELD_LABELS[row.field] ?? row.field}</td>
                <td>{row.kind === "created" ? "New ministry" : formatValue(row.field, row.from, names)}</td>
                <td>{formatValue(row.field, row.to, names)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {ops.some((o) => o.op === "succeed" && !o.noSuccessor && o.successors.length > 0) && (
        <>
          <h3>What each hand-over moves</h3>
          <ul>
            {ops.map((o, i) =>
              o.op === "succeed" && !o.noSuccessor && o.successors.length > 0 ? (
                <li key={i}>
                  <HandOverCountsLine op={o} name={byKey.get(o.key)?.displayName ?? o.key} />
                </li>
              ) : null,
            )}
          </ul>
        </>
      )}
      <h3 id={`${uid}-resulting`}>Ministries after this change</h3>
      <ol aria-labelledby={`${uid}-resulting`}>
        {active.map((o) => (
          <li key={o.key}>
            {o.displayName}
            {o.abbreviation ? ` (${o.abbreviation})` : ""}
          </li>
        ))}
      </ol>
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One hand-over's counts, as the hand-over panel counts them; a count that fails says so. */
function HandOverCountsLine({ op, name }: { op: SucceedOp; name: string }): React.JSX.Element {
  const c = useHandOverCounts(op.key);
  const of = <T,>(count: { state: string; value?: T }, text: (v: T) => string, what: string) =>
    count.state === "ok" ? text(count.value as T) : `${what} (${count.state === "failed" ? "count unavailable" : "counting…"})`;
  const parts = [
    op.moves.moveSubscribers && of(c.subscribers, (n: number) => plural(n, "subscriber", "subscribers"), "subscribers"),
    op.moves.moveStaff && of(c.core, (v: { staff: number }) => `${v.staff} staff`, "staff"),
    op.moves.moveCalendar &&
      of(c.calendar, (v: { activities: number }) => plural(v.activities, "upcoming Calendar activity", "upcoming Calendar activities"), "Calendar activities"),
    op.moves.moveDrafts && of(c.releases, (v: { drafts: unknown[] }) => plural(v.drafts.length, "draft release", "draft releases"), "draft releases"),
  ].filter((p): p is string => typeof p === "string");
  return <>{parts.length ? `${name}: moves ${parts.join(", ")}.` : `${name}: moves only its web pages.`}</>;
}

interface FormProps<T extends Operation> {
  busy: boolean;
  onCancel: () => void;
  onAdd: (op: T, summary: string) => void;
  onError: (messages: string[]) => void;
}

/** The shell every add-a-change form shares: a named form whose heading takes focus when it opens. */
function AddForm({ title, busy, onCancel, onSubmit, children }: { title: string; busy: boolean; onCancel: () => void; onSubmit: () => void; children: React.ReactNode }): React.JSX.Element {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <form
      aria-label={title}
      className="gcpe-stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <h4 ref={heading} tabIndex={-1}>
        {title}
      </h4>
      {children}
      <div>
        <button type="submit" disabled={busy}>
          Add this change
        </button>{" "}
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({ id, label, hint, value, onChange }: { id: string; label: string; hint?: string; value: string; onChange: (v: string) => void }): React.JSX.Element {
  return (
    <div className="gcpe-field">
      <label htmlFor={id}>{label}</label>
      {hint && <p id={`${id}-hint`}>{hint}</p>}
      <input id={id} type="text" value={value} aria-describedby={hint ? `${id}-hint` : undefined} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function UpdateForm({ orgs, ...props }: FormProps<UpdateOp> & { orgs: OrgRecord[] }): React.JSX.Element {
  const uid = useId();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [abbr, setAbbr] = useState("");
  const [minister, setMinister] = useState("");
  const org = orgs.find((o) => o.key === key);

  const choose = (k: string) => {
    const o = orgs.find((x) => x.key === k);
    setKey(k);
    setName(o?.displayName ?? "");
    setAbbr(o?.abbreviation ?? "");
    setMinister(o?.minister.name ?? "");
  };

  const submit = () => {
    if (!org) return props.onError(["Choose the ministry to change."]);
    const patch: UpdateOp["patch"] = {};
    if (name.trim() && name.trim() !== org.displayName) patch.displayName = name.trim();
    if (!name.trim()) return props.onError(["A ministry needs a name."]);
    const a = normalizeAbbreviation(abbr);
    if (a !== normalizeAbbreviation(org.abbreviation ?? "")) {
      if (!a) return props.onError(["An abbreviation can't be removed here. Enter a new one, or leave it as it was."]);
      patch.abbreviation = a;
    }
    if (minister.trim() !== (org.minister.name ?? "")) patch.minister = { name: minister.trim() || null };
    if (!Object.keys(patch).length) return props.onError(["Change the name, abbreviation or minister first."]);
    const op: UpdateOp = { op: "update", key: org.key, expectedUpdatedAt: org.updatedAt, patch };
    props.onAdd(op, updateSummary(op, org));
  };

  return (
    <AddForm title="Rename or change a ministry" busy={props.busy} onCancel={props.onCancel} onSubmit={submit}>
      <p>Renaming keeps the ministry&rsquo;s web address, subscribers and staff.</p>
      <div className="gcpe-field">
        <label htmlFor={`${uid}-org`}>Ministry</label>
        <select id={`${uid}-org`} value={key} onChange={(e) => choose(e.target.value)}>
          <option value="">Choose a ministry</option>
          {orgs
            .filter((o) => o.isActive)
            .map((o) => (
              <option key={o.key} value={o.key}>
                {o.displayName}
              </option>
            ))}
        </select>
      </div>
      {org && (
        <>
          <Field id={`${uid}-name`} label="Name" value={name} onChange={setName} />
          <Field
            id={`${uid}-abbr`}
            label="Abbreviation"
            hint="Used in release numbers, e.g. 2026HLTH0001. 2 to 10 capital letters or digits."
            value={abbr}
            onChange={setAbbr}
          />
          <Field id={`${uid}-minister`} label="Minister" hint="Leave empty if there is no minister yet." value={minister} onChange={setMinister} />
        </>
      )}
    </AddForm>
  );
}

function CreateForm({ existing, ...props }: FormProps<CreateOp> & { existing: string[] }): React.JSX.Element {
  const uid = useId();
  const [name, setName] = useState("");
  const [abbr, setAbbr] = useState("");
  const [minister, setMinister] = useState("");

  const submit = () => {
    const displayName = name.trim();
    if (!displayName) return props.onError(["Enter the new ministry's name."]);
    if (existing.some((n) => n.trim().toLowerCase() === displayName.toLowerCase())) return props.onError([`${displayName} already exists.`]);
    const op: CreateOp = { op: "create", ref: displayName.slice(0, 60), displayName };
    const a = normalizeAbbreviation(abbr);
    if (a) op.abbreviation = a;
    if (minister.trim()) op.minister = { name: minister.trim() };
    props.onAdd(op, `Add a new ministry: ${displayName}`);
  };

  return (
    <AddForm title="Add a new ministry" busy={props.busy} onCancel={props.onCancel} onSubmit={submit}>
      <Field id={`${uid}-name`} label="Name" value={name} onChange={setName} />
      <Field
        id={`${uid}-abbr`}
        label="Abbreviation (optional)"
        hint="Used in release numbers, e.g. 2026HLTH0001. 2 to 10 capital letters or digits."
        value={abbr}
        onChange={setAbbr}
      />
      <Field id={`${uid}-minister`} label="Minister (optional)" value={minister} onChange={setMinister} />
    </AddForm>
  );
}

type SuccessorOption = { value: string; label: string; name: string; abbreviation: string | null };

/**
 * A hand-over in the change: the hand-over panel's successors, move checkboxes and counts, saved
 * as a `succeed` operation instead of posted. No successor abolishes the ministry ("No successor").
 */
function SucceedForm({
  orgs,
  created,
  handedOver,
  ...props
}: FormProps<SucceedOp> & { orgs: OrgRecord[]; created: CreateOp[]; handedOver: Set<string> }): React.JSX.Element {
  const uid = useId();
  const [key, setKey] = useState("");
  // Ordered successor choices, "key:<key>" or "ref:<ref>"; "" is an unchosen picker.
  const [successors, setSuccessors] = useState<string[]>([""]);
  const [moves, setMoves] = useState<HandOverMoves>(ALL_MOVES);
  const [replaceAbbr, setReplaceAbbr] = useState(false);
  const [takeAbbr, setTakeAbbr] = useState(true);
  const org = orgs.find((o) => o.key === key);
  const sources = orgs.filter((o) => o.isActive && !handedOver.has(o.key));
  const options: SuccessorOption[] = [
    ...created.map((c) => ({ value: `ref:${c.ref}`, label: `${c.displayName} (new in this change)`, name: c.displayName, abbreviation: c.abbreviation ?? null })),
    // A ministry this change already hands over can't also take one over.
    ...orgs
      .filter((o) => o.isActive && o.key !== key && !handedOver.has(o.key))
      .map((o) => ({ value: `key:${o.key}`, label: o.displayName, name: o.displayName, abbreviation: o.abbreviation })),
  ];
  const byValue = new Map(options.map((o) => [o.value, o]));
  const chosen = [...new Set(successors.filter((s) => s !== ""))];
  const first = chosen.length ? byValue.get(chosen[0]!) : undefined;
  const aAbbr = normalizeAbbreviation(org?.abbreviation ?? "") || null;
  const bAbbr = normalizeAbbreviation(first?.abbreviation ?? "") || null;
  // As on the hand-over panel: nothing to hand over when A has none, or B already has the same one.
  const abbrRelevant = first !== undefined && aAbbr !== null && bAbbr !== aAbbr;
  const showAbbrLine = abbrRelevant && (bAbbr === null || replaceAbbr);

  const choose = (k: string) => {
    setKey(k);
    setSuccessors([""]);
    setMoves(ALL_MOVES);
    setReplaceAbbr(false);
    setTakeAbbr(true);
  };
  const setSuccessor = (index: number, value: string) => {
    const firstChanged = index === 0 && value !== successors[0];
    setSuccessors(firstChanged ? [value] : successors.map((s, i) => (i === index ? value : s)));
    if (firstChanged) {
      setReplaceAbbr(false);
      setTakeAbbr(true);
    }
  };

  const submit = () => {
    if (!org) return props.onError(["Choose the ministry to hand over."]);
    const list: Successor[] = chosen.map((v) => (v.startsWith("ref:") ? { ref: v.slice(4) } : { key: v.slice(4) }));
    const op: SucceedOp = {
      op: "succeed",
      key: org.key,
      expectedUpdatedAt: org.updatedAt,
      successors: list,
      moves: {
        moveSubscribers: moves.subscribers,
        moveStaff: moves.staff,
        moveCalendar: moves.calendar,
        moveDrafts: moves.drafts,
        takeAbbreviation: showAbbrLine && takeAbbr,
      },
    };
    if (!list.length) op.noSuccessor = true;
    const names = chosen.map((v) => (v.startsWith("ref:") ? `${byValue.get(v)?.name ?? v.slice(4)} (new)` : (byValue.get(v)?.name ?? v)));
    props.onAdd(op, list.length ? `Hand ${org.displayName} over to ${names.join(" and ")}` : `Abolish ${org.displayName} (no successor)`);
  };

  return (
    <AddForm title="Hand over a ministry" busy={props.busy} onCancel={props.onCancel} onSubmit={submit}>
      <div className="gcpe-field">
        <label htmlFor={`${uid}-org`}>Ministry to hand over</label>
        <p id={`${uid}-org-hint`}>It becomes inactive when the change is published.</p>
        <select id={`${uid}-org`} value={key} aria-describedby={`${uid}-org-hint`} onChange={(e) => choose(e.target.value)}>
          <option value="">Choose a ministry</option>
          {sources.map((o) => (
            <option key={o.key} value={o.key}>
              {o.displayName}
            </option>
          ))}
        </select>
      </div>
      {org &&
        successors.map((value, index) => {
          const taken = new Set(successors.filter((_, i) => i !== index));
          return (
            <div key={index} className="gcpe-field">
              <label htmlFor={`${uid}-successor-${index}`}>{index === 0 ? "Successor" : `Successor ${index + 1}`}</label>
              {index === 0 && (
                <p id={`${uid}-successor-hint`}>
                  The ministry that takes over its work. Its web pages, staff, upcoming Calendar activities and draft releases
                  go to the first successor.
                </p>
              )}
              {index === 1 && <p id={`${uid}-extra-hint`}>Subscribers are added to every successor.</p>}
              <select
                id={`${uid}-successor-${index}`}
                value={value}
                aria-describedby={index === 0 ? `${uid}-successor-hint` : index === 1 ? `${uid}-extra-hint` : undefined}
                onChange={(e) => setSuccessor(index, e.target.value)}
              >
                <option value="">{index === 0 ? "No successor (abolish it)" : "Choose a ministry"}</option>
                {options
                  .filter((o) => !taken.has(o.value))
                  .map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
              </select>
              {index > 0 && (
                <>
                  {" "}
                  <button type="button" aria-label={`Remove successor ${index + 1}`} onClick={() => setSuccessors((s) => s.filter((_, i) => i !== index))}>
                    Remove
                  </button>
                </>
              )}
            </div>
          );
        })}
      {org && chosen.length > 0 && successors.every((s) => s !== "") && successors.length < options.length && (
        <p>
          <button type="button" onClick={() => setSuccessors((s) => [...s, ""])}>
            Add another successor
          </button>
        </p>
      )}
      {org && !first && <p>{deactivateWarning(org.displayName)}</p>}
      {org && first && (
        <fieldset>
          <legend>What moves to {first.name}</legend>
          <SucceedMoveBoxes
            key={org.key}
            uid={uid}
            org={org}
            firstName={first.name}
            allNames={chosen.map((v) => byValue.get(v)?.name ?? v).join(", ")}
            moves={moves}
            onChange={setMoves}
          />
          {abbrRelevant && bAbbr !== null && (
            <div>
              <input
                id={`${uid}-replace-abbr`}
                type="checkbox"
                checked={replaceAbbr}
                onChange={(e) => {
                  setReplaceAbbr(e.target.checked);
                  setTakeAbbr(true);
                }}
              />{" "}
              <label htmlFor={`${uid}-replace-abbr`}>{`Replace ${first.name}'s abbreviation ${bAbbr} with ${aAbbr}`}</label>
            </div>
          )}
          {showAbbrLine && (
            <div>
              <input id={`${uid}-abbr`} type="checkbox" checked={takeAbbr} onChange={(e) => setTakeAbbr(e.target.checked)} />{" "}
              <label htmlFor={`${uid}-abbr`}>{`Let ${first.name} use the abbreviation ${aAbbr}.`}</label>
            </div>
          )}
        </fieldset>
      )}
    </AddForm>
  );
}

/** The hand-over panel's move checkboxes, with the counts for the ministry handed over. Keyed by that ministry. */
function SucceedMoveBoxes({
  uid,
  org,
  firstName,
  allNames,
  moves,
  onChange,
}: {
  uid: string;
  org: OrgRecord;
  firstName: string;
  allNames: string;
  moves: HandOverMoves;
  onChange: (moves: HandOverMoves) => void;
}): React.JSX.Element {
  const counts = useHandOverCounts(org.key);
  return <HandOverMoveBoxes idPrefix={uid} orgName={org.displayName} firstName={firstName} allNames={allNames} counts={counts} moves={moves} onChange={onChange} />;
}
