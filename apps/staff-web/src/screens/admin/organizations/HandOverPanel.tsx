import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../shared/Button";
import { Link } from "react-router";
import type { OrgRecord } from "@gcpe/events/catalogue";
import { apiFetch } from "../../../api/client";
import { useAnnouncer } from "../../../shared/Announcer";
import { messagesOf } from "../messages";
import { abbreviationTakenMessage, normalizeAbbreviation } from "./abbreviation";
import { useReportDirty, type ReportDirty } from "../../../shared/LeaveGuard";
import { deactivateWarning } from "./OrganizationEditForm";

/** One service's count: still loading, loaded, or failed (shown as "count unavailable", never 0). */
export type Count<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "failed" };

interface CorePreview {
  staff: number;
  abbreviation: string | null;
}
interface CalendarPreview {
  activities: number;
  contacts: number;
}
interface OpenRelease {
  id: string;
  headline: string;
}
interface OpenReleases {
  drafts: OpenRelease[];
  notMoved: (OpenRelease & { status: string; key: string | null })[];
}

/** Core's 422 copy for a missing successor, reused so the Hub and Core say the same thing. */
const CHOOSE_SUCCESSOR = "Choose an active ministry as successor.";
const UNAVAILABLE = "count unavailable";

const STATUS_LABELS: Record<string, string> = {
  approved: "approved",
  scheduled: "scheduled",
  publishing: "publishing now",
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Loads one count; a failure of any kind (HTTP error, network, bad shape) is "failed", never thrown. */
function useCount<T>(url: string, read: (body: unknown) => T): Count<T> {
  const [count, setCount] = useState<Count<T>>({ state: "loading" });
  const readRef = useRef(read);
  useEffect(() => {
    let live = true;
    apiFetch(url).then(
      (body) => {
        let next: Count<T>;
        try {
          next = { state: "ok", value: readRef.current(body) };
        } catch {
          next = { state: "failed" };
        }
        if (live) setCount(next);
      },
      () => {
        if (live) setCount({ state: "failed" });
      },
    );
    return () => {
      live = false;
    };
  }, [url]);
  return count;
}

function num(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("not a count");
  return value;
}

/** What a hand-over moves besides the web pages (Core's `/succeed` flags, the abbreviation aside). */
export interface HandOverMoves {
  subscribers: boolean;
  staff: boolean;
  calendar: boolean;
  drafts: boolean;
}
/** Every move on: the hand-over's default. */
export const ALL_MOVES: HandOverMoves = { subscribers: true, staff: true, calendar: true, drafts: true };

/** What Core, NoD, the Calendar and NRMS would move if a ministry were handed over, each loaded separately. */
export interface HandOverCounts {
  core: Count<CorePreview>;
  subscribers: Count<number>;
  calendar: Count<CalendarPreview>;
  releases: Count<OpenReleases>;
}

/** Loads the four services' counts for handing ministry `orgKey` over. Used by the panel and by a cabinet change's hand-over. */
export function useHandOverCounts(orgKey: string): HandOverCounts {
  const key = encodeURIComponent(orgKey);
  const core = useCount<CorePreview>(`/core/api/organizations/${key}/succession-preview`, (b) => {
    const body = b as CorePreview;
    return { staff: num(body.staff), abbreviation: body.abbreviation ?? null };
  });
  const subscribers = useCount<number>(`/nod/api/subscribers/count?lists=ministries:${key}&exact=true`, (b) => num((b as { count: unknown }).count));
  const calendar = useCount<CalendarPreview>(`/calendar/api/succession/${key}/preview`, (b) => {
    const body = b as CalendarPreview;
    return { activities: num(body.activities), contacts: num(body.contacts) };
  });
  const releases = useCount<OpenReleases>(`/nrms/api/ministries/${key}/open-releases`, (b) => {
    const body = b as OpenReleases;
    if (!Array.isArray(body.drafts) || !Array.isArray(body.notMoved)) throw new Error("bad shape");
    return body;
  });
  return { core, subscribers, calendar, releases };
}

const countText = <T,>(count: Count<T>, ok: (value: T) => string, otherwise: string) =>
  count.state === "ok" ? ok(count.value) : `${otherwise} (${count.state === "failed" ? UNAVAILABLE : "counting…"}).`;

/**
 * The hand-over's checkboxes: the always-on web pages line, then one box per service, each
 * labelled with its count (or "count unavailable"), and the releases that stay behind. The
 * abbreviation lines stay with the caller, which knows the successor's abbreviation.
 */
export function HandOverMoveBoxes({
  idPrefix,
  orgName,
  firstName,
  allNames,
  counts,
  moves,
  onChange,
}: {
  idPrefix: string;
  /** The ministry handed over (A). */
  orgName: string;
  /** The first successor (B): the pages, staff, Calendar and drafts go there. */
  firstName: string;
  /** Every successor, comma-separated: subscribers go to all of them. */
  allNames: string;
  counts: HandOverCounts;
  moves: HandOverMoves;
  onChange: (moves: HandOverMoves) => void;
}): React.JSX.Element {
  const id = (part: string) => `${idPrefix}-${part}`;
  const { core, subscribers, calendar, releases } = counts;
  const moveBox = (name: keyof HandOverMoves, label: string) => (
    <div>
      <input id={id(name)} type="checkbox" checked={moves[name]} onChange={(e) => onChange({ ...moves, [name]: e.target.checked })} />{" "}
      <label htmlFor={id(name)}>{label}</label>
    </div>
  );
  return (
    <>
      <div>
        <input id={id("pages")} type="checkbox" checked disabled aria-describedby={id("pages-hint")} />{" "}
        <label htmlFor={id("pages")}>{`Send ${orgName}'s web pages to ${firstName}`}</label>
        <p id={id("pages-hint")}>Always on: this is what setting a successor does.</p>
      </div>
      {moveBox(
        "subscribers",
        countText(subscribers, (n) => `Move ${plural(n, "subscriber", "subscribers")} to ${allNames}.`, `Move subscribers to ${allNames}`),
      )}
      {moveBox("staff", countText(core, (c) => `Move ${c.staff} staff from ${orgName} to ${firstName}.`, `Move staff from ${orgName} to ${firstName}`))}
      {moveBox(
        "calendar",
        countText(
          calendar,
          (c) =>
            `Move ${plural(c.activities, "upcoming Calendar activity", "upcoming Calendar activities")} and ${plural(c.contacts, "comm contact", "comm contacts")} to ${firstName}.`,
          `Move upcoming Calendar activities and comm contacts to ${firstName}`,
        ),
      )}
      {moveBox(
        "drafts",
        countText(releases, (r) => `Move ${plural(r.drafts.length, "draft release", "draft releases")} to ${firstName}.`, `Move draft releases to ${firstName}`),
      )}
      {releases.state === "ok" && releases.value.notMoved.length > 0 && (
        <div>
          <p id={id("not-moved")}>
            These releases are already approved or scheduled, so they stay with {orgName}. Open one to change its lead ministry:
          </p>
          <ul aria-labelledby={id("not-moved")}>
            {releases.value.notMoved.map((r) => (
              <li key={r.id}>
                <Link to={`/releases/${r.id}`}>{r.headline || r.key || "(untitled)"}</Link> ({STATUS_LABELS[r.status] ?? r.status})
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

export interface HandOverPanelProps {
  /** The ministry being handed over (A). Active: the panel deactivates it; inactive: it only sets successors. */
  org: OrgRecord;
  orgs: OrgRecord[];
  /** Called after a successful save with the first successor's name, or null for a plain deactivation. */
  onDone: (successorName: string | null) => void;
  onCancel: () => void;
  /** Told when a save starts and ends, so the screen can hold its other row actions meanwhile. */
  onBusyChange?: (busy: boolean) => void;
  /** Suite review H2: tells the screen's leave-page guard whether a successor has been chosen. */
  reportDirty?: ReportDirty;
}

/**
 * The guided hand-over on Organizations (new-government spec §4). An active ministry's
 * Deactivate opens it as "Deactivate {A}"; an inactive one's "Set successor…" opens it as
 * "Set successor for {A}". Choosing a successor shows what each service would move, each as a
 * checkbox that is on by default, and posts Core's `/succeed`. With no successor (an active
 * ministry only) it is today's deactivation. The counts come from Core, NoD, the Calendar and
 * NRMS separately; one that fails says "count unavailable" and never blocks the hand-over.
 */
export function HandOverPanel({ org, orgs, onDone, onCancel, onBusyChange, reportDirty }: HandOverPanelProps): React.JSX.Element {
  const uid = useId();
  const id = (part: string) => `${uid}-${part}`;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const deactivating = org.isActive;
  const title = deactivating ? `Deactivate ${org.displayName}` : `Set successor for ${org.displayName}`;
  const key = encodeURIComponent(org.key);
  const counts = useHandOverCounts(org.key);

  // Ordered successors; "" is an unchosen picker. The first gets staff, Calendar, drafts and the
  // abbreviation; every one gets the subscribers.
  const [successors, setSuccessors] = useState<string[]>([""]);
  useReportDirty(reportDirty, "hand-over", successors.some((s) => s !== ""));
  const [moves, setMoves] = useState<HandOverMoves>(ALL_MOVES);
  const [replaceAbbr, setReplaceAbbr] = useState(false);
  const [takeAbbr, setTakeAbbr] = useState(true);
  const [busy, setBusy] = useState(false);
  // The double-submit guard: a ref, so a second click before React re-renders is still refused.
  const inFlight = useRef(false);
  const [messages, setMessages] = useState<string[]>([]);
  const { announce } = useAnnouncer();
  const pickers = useRef(new Map<number, HTMLSelectElement>());
  // The picker to focus after Add another successor (the new one) or Remove (the one before it).
  const focusPicker = useRef<number | null>(null);

  useEffect(() => {
    if (focusPicker.current === null) return;
    pickers.current.get(focusPicker.current)?.focus();
    focusPicker.current = null;
  }, [successors]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const candidates = orgs.filter((o) => o.isActive && o.key !== org.key);
  const byKey = new Map(orgs.map((o) => [o.key, o]));
  const chosen = successors.filter((k) => k !== "");
  const b = chosen.length ? byKey.get(chosen[0]!) : undefined;
  const bName = b?.displayName ?? "";
  const allNames = chosen.map((k) => byKey.get(k)?.displayName ?? k).join(", ");

  const aAbbr = normalizeAbbreviation(org.abbreviation ?? "") || null;
  const bAbbr = normalizeAbbreviation(b?.abbreviation ?? "") || null;
  // Nothing to hand over when A has none, or B already has the same one.
  const abbrRelevant = b !== undefined && aAbbr !== null && bAbbr !== aAbbr;
  const showAbbrLine = abbrRelevant && (bAbbr === null || replaceAbbr);

  const setSuccessor = (index: number, value: string) => {
    const firstChanged = index === 0 && value !== successors[0];
    // A new first successor (or none) starts the list again: the extra pickers are cleared.
    const next = firstChanged ? [value] : successors.map((k, i) => (i === index ? value : k));
    setSuccessors(next);
    setMessages([]);
    if (firstChanged) {
      setReplaceAbbr(false);
      setTakeAbbr(true);
      if (successors.length > 1) announce("The other successors were cleared. Add them again if you need them.");
    }
  };

  const submit = async () => {
    if (inFlight.current) return;
    if (!deactivating && !chosen.length) {
      setMessages([CHOOSE_SUCCESSOR]);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setMessages([]);
    try {
      if (!chosen.length) {
        await apiFetch(`/core/api/organizations/${key}/deactivate`, { method: "POST" });
        onDone(null);
      } else {
        await apiFetch(`/core/api/organizations/${key}/succeed`, {
          method: "POST",
          body: {
            successorKeys: [...new Set(chosen)],
            moveSubscribers: moves.subscribers,
            moveStaff: moves.staff,
            moveCalendar: moves.calendar,
            moveDrafts: moves.drafts,
            takeAbbreviation: showAbbrLine && takeAbbr,
          },
        });
        onDone(bName);
      }
    } catch (caught) {
      setMessages(
        abbreviationTakenMessage(caught) !== null
          ? [takenCopy((caught as { body?: { takenBy?: string } }).body?.takenBy)]
          : messagesOf(caught),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  // Core's 409 on /succeed: a third, active ministry holds A's abbreviation.
  const takenCopy = (takenBy = "another ministry") =>
    `${takenBy} already uses the abbreviation ${aAbbr ?? ""}. Untick "Let ${bName} use the abbreviation ${aAbbr ?? ""}." or change ${takenBy}'s abbreviation first.`;

  return (
    <form
      aria-label={title}
      className="gcpe-stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 ref={headingRef} tabIndex={-1}>
        {title}
      </h2>

      {successors.map((value, index) => {
        const label = index === 0 ? (deactivating ? "Has a successor?" : "Successor") : `Successor ${index + 1}`;
        const taken = new Set(successors.filter((_, i) => i !== index));
        return (
          <div key={index}>
            <label htmlFor={id(`successor-${index}`)}>{label}</label>
            {index === 0 && (
              <p id={id("successor-hint")}>
                The ministry that takes over its work. Its web pages, staff, upcoming Calendar activities and draft releases go
                to the first successor you choose.
              </p>
            )}
            {index === 1 && <p id={id("extra-hint")}>Subscribers are added to every successor.</p>}
            <select
              id={id(`successor-${index}`)}
              ref={(el) => {
                if (el) pickers.current.set(index, el);
                else pickers.current.delete(index);
              }}
              value={value}
              aria-describedby={index === 0 ? id("successor-hint") : index === 1 ? id("extra-hint") : undefined}
              onChange={(e) => setSuccessor(index, e.target.value)}
            >
              {index === 0 ? (
                <option value="">{deactivating ? "No successor" : "Choose a ministry"}</option>
              ) : (
                <option value="">Choose a ministry</option>
              )}
              {candidates
                .filter((o) => !taken.has(o.key))
                .map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.displayName}
                  </option>
                ))}
            </select>
            {index > 0 && (
              <>
                {" "}
                <Button
                  size="small"
                  variant="secondary"
                  aria-label={`Remove successor ${index + 1}`}
                  onPress={() => {
                    focusPicker.current = index - 1;
                    setSuccessors((s) => s.filter((_, i) => i !== index));
                  }}
                >
                  Remove
                </Button>
              </>
            )}
          </div>
        );
      })}
      {chosen.length > 0 && successors.length < candidates.length && successors.every((k) => k !== "") && (
        <p>
          <Button
            size="small"
            variant="secondary"
            onPress={() => {
              focusPicker.current = successors.length;
              setSuccessors((s) => [...s, ""]);
            }}
          >
            Add another successor
          </Button>
        </p>
      )}

      {deactivating && !chosen.length && <p>{deactivateWarning(org.displayName)}</p>}

      {b && (
        <fieldset>
          <legend>What moves to {bName}</legend>
          <HandOverMoveBoxes idPrefix={uid} orgName={org.displayName} firstName={bName} allNames={allNames} counts={counts} moves={moves} onChange={setMoves} />
          {abbrRelevant && bAbbr !== null && (
            <div>
              <input
                id={id("replace-abbr")}
                type="checkbox"
                checked={replaceAbbr}
                onChange={(e) => {
                  setReplaceAbbr(e.target.checked);
                  setTakeAbbr(true);
                }}
              />{" "}
              <label htmlFor={id("replace-abbr")}>{`Replace ${bName}'s abbreviation ${bAbbr} with ${aAbbr}`}</label>
            </div>
          )}
          {showAbbrLine && (
            <div>
              <input id={id("abbr")} type="checkbox" checked={takeAbbr} onChange={(e) => setTakeAbbr(e.target.checked)} />{" "}
              <label htmlFor={id("abbr")}>{`Let ${bName} use the abbreviation ${aAbbr}.`}</label>
            </div>
          )}
        </fieldset>
      )}

      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      <div className="gcpe-button-row">
        {/* aria-disabled, not disabled, while saving: focus stays on the button, so an error leaves it there.
         * A native button styled as the design system's primary one (its Button drops aria-busy); the
         * danger fill when it deactivates, like every other Delete or Leave confirm. */}
        <button type="submit" className={`gcpe-native-button ${deactivating ? "gcpe-native-button--danger" : "gcpe-native-button--primary"}`} aria-disabled={busy || undefined} aria-busy={busy || undefined}>
          {!deactivating ? "Set successor" : chosen.length ? "Deactivate and hand over" : "Deactivate"}
        </button>
        <Button variant="secondary" isPending={busy} onPress={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
