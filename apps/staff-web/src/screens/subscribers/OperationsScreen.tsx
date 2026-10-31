import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { AlertDialog, DialogTrigger, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { formatWhen } from "../../format/dates";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useSession } from "../../session/SessionContext";
import { Button } from "../../shared/BusyButton";
import { Form } from "../../shared/Form";
import { useFormShortcut } from "../../shared/shortcuts";
import { ignoreWhileBusy } from "../../shared/guardSubmit";
import { TableScroll } from "../../shared/TableScroll";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { canAdminSubscribers } from "./access";
import type { EmergencyFeedStatus, OperationsStatus, OutgoingGroup, OutgoingStatus, PurgeStatus } from "./types";

/** Distribution's own fake-inbox limit (apps/distribution/src/http/routes.ts). */
const MAX_BOUNCE_BYTES = 1024 * 1024;

/** `/hub/subscribers/operations` (legacy ManageDistributionService), NoD.Admin only. */
export function OperationsScreen(): React.JSX.Element {
  useDocumentTitle("Operations");
  const canAdmin = canAdminSubscribers(useSession());
  if (!canAdmin) {
    return (
      <div className="gcpe-subscribers__operations">
        <h1>Operations</h1>
        <p>You don&rsquo;t have permission to use Operations.</p>
      </div>
    );
  }
  return <OperationsPanels />;
}

function OperationsPanels(): React.JSX.Element {
  const timeZone = useTenantTimeZone();
  const [ops, setOps] = useState<OperationsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Only the latest load may land: an earlier, slower load landing after a faster later one
  // would put back stale pause/bounce state.
  const latest = useRef(0);
  const reload = useCallback(() => {
    const seq = ++latest.current;
    apiFetch<OperationsStatus>("/nod/api/operations").then(
      (o) => {
        if (seq !== latest.current) return;
        setOps(o);
        setLoadError(null);
      },
      () => {
        if (seq !== latest.current) return;
        setLoadError("Couldn't load operations.");
      },
    );
  }, []);
  useEffect(() => reload(), [reload]);
  const done = (text: string) => {
    setMessage(text);
    reload();
  };

  return (
    <div className="gcpe-subscribers__operations">
      <h1>Operations</h1>
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {message && <p role="status">{message}</p>}
      {ops && (
        <>
          {/* Who hears about a pause or resume: NOD_OPS_EMAIL, when one is set up (settings.ts). */}
          <PauseControl
            title="News On Demand sending"
            paused={ops.nod.paused}
            path="/nod/api/settings"
            pauseBody={`News On Demand keeps recording releases and building emails but holds them until you resume. Nothing is dropped. ${whoIsEmailed(ops)}`}
            resumeBody={`${resumeHeld(ops.outgoing, timeZone)} ${whoIsEmailed(ops)}`}
            // Review M4: counted again when the question opens, and the answer says what went.
            freshResumeBody={() => apiFetch<OperationsStatus>("/nod/api/operations").then((o) => `${resumeHeld(o.outgoing, timeZone)} ${whoIsEmailed(o)}`)}
            resumedText={(r) => {
              const released = (r as { released?: { emails: number; releases: number } | null } | undefined)?.released;
              return released && released.emails > 0
                ? `News On Demand sending resumed. ${plural(released.emails, "held email")} for ${plural(released.releases, "release")} are going out now.`
                : "News On Demand sending resumed.";
            }}
            onDone={done}
          >
            <p>{`Last daily digest: ${ops.nod.lastDigestCutoff ? formatWhen(ops.nod.lastDigestCutoff, new Date(), timeZone) : "none yet"}.`}</p>
          </PauseControl>
          <OutgoingPanel outgoing={ops.outgoing} paused={ops.nod.paused} timeZone={timeZone} onDone={done} />
          {ops.distribution ? (
            <PauseControl
              title="Distribution"
              paused={ops.distribution.paused}
              path="/nod/api/distribution"
              pauseBody={`No email goes out from any app, except system notices, until you resume. Queued email is kept. ${whoIsEmailed(ops)}`}
              resumeBody={`Queued email starts going out straight away. ${whoIsEmailed(ops)}`}
              onDone={done}
            />
          ) : (
            <section aria-labelledby="ops-distribution">
              <h2 id="ops-distribution">Distribution</h2>
              <InlineAlert variant="warning" description="Distribution isn’t responding, so its state is unknown. Reload the page shortly." />
            </section>
          )}
          <BounceSummaryForm value={ops.bounceSummary} onDone={done} />
          <EmergencyFeedPanel feed={ops.emergencyFeed} timeZone={timeZone} />
          <SoftCodesForm value={ops.softCodesCounted} onDone={done} />
          <PurgeControl purge={ops.purge} timeZone={timeZone} onDone={done} />
          {ops.bounceSource === "fake" && <BounceUpload onDone={done} />}
        </>
      )}
    </div>
  );
}

/** What a resume sends at once (N3): the held count, from the last load. */
function resumeHeld(o: OutgoingStatus, timeZone: string): string {
  if (o.held.emails === 0) return "Nothing is held, so nothing goes out straight away.";
  return (
    `${plural(o.held.emails, "held email")} for ${plural(o.held.releases, "release")} start going out straight away. ${oldestText(o, timeZone)} ` +
    "To stop some of them, choose Cancel and cancel them under Outgoing news email first."
  );
}

const oldestText = (o: OutgoingStatus, timeZone: string): string =>
  o.held.oldestAt ? `The oldest has waited ${waitedFor(o.held.oldestAt)}, since ${formatWhen(o.held.oldestAt, new Date(), timeZone, { withDate: true })}.` : "";

function waitedFor(iso: string): string {
  const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (hours < 1) return "under an hour";
  if (hours < 48) return plural(hours, "hour");
  return plural(Math.floor(hours / 24), "day");
}

const KIND_LABELS: Record<OutgoingGroup["kind"], string> = {
  as_it_happens: "As it happens",
  emergency: "Emergency alert",
  media: "Media list",
  digest: "Daily digest",
};

function groupTitle(g: OutgoingGroup, timeZone: string): string {
  if (g.kind !== "digest") return g.title ?? "A release no longer in News On Demand";
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(g.digestCutoff ?? g.createdAt));
  return `Daily digest of ${day}, ${plural(g.releases, "release")}`;
}
const groupLabel = (g: OutgoingGroup, timeZone: string) => `${groupTitle(g, timeZone)} (${KIND_LABELS[g.kind]})`;

/** Held and failed news email, and cancelling held email while paused (N3). */
function OutgoingPanel({ outgoing, paused, timeZone, onDone }: { outgoing: OutgoingStatus; paused: boolean; timeZone: string; onDone(text: string): void }): React.JSX.Element {
  const [cancelling, setCancelling] = useState<OutgoingGroup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { held, failed } = outgoing;
  const close = () => {
    setCancelling(null);
    setError(null);
  };
  const cancel = async (groups: OutgoingGroup[]) => {
    setBusy(true);
    setError(null);
    const jobIds = groups.flatMap((g) => g.jobIds);
    try {
      const r = await apiFetch<{ cancelledJobs: number; cancelledEmails: number }>("/nod/api/operations/held-email/cancel", {
        method: "POST",
        body: { jobIds },
      });
      setCancelling(null);
      // Some may have been claimed by a send that started just before the pause (review M3).
      const partly = r.cancelledJobs < jobIds.length ? " Some had already started going out, so they weren’t cancelled." : "";
      onDone(r.cancelledJobs === 0 ? "Nothing was cancelled: that email had already gone out or been cancelled." : `Cancelled ${plural(r.cancelledEmails, "held email")}.${partly}`);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? "News On Demand sending isn’t paused, so nothing was cancelled. Pause it first."
          : "Couldn’t cancel. Nothing changed.",
      );
    } finally {
      setBusy(false);
    }
  };
  const chosenEmails = cancelling?.reduce((n, g) => n + g.emails, 0) ?? 0;
  const alerts = cancelling?.filter((g) => g.kind === "emergency").length ?? 0;
  const chosenReleases = cancelling ? (cancelling.length === held.groups.length ? held.releases : cancelling.reduce((n, g) => n + g.releases, 0)) : 0;
  return (
    <section aria-labelledby="ops-outgoing">
      <h2 id="ops-outgoing">Outgoing news email</h2>
      {held.groups.length === 0 ? (
        <p>Nothing is waiting to go out.</p>
      ) : (
        <>
          <p>{`${paused ? "Held while paused" : "Waiting to go out"}: ${plural(held.emails, "email")} for ${plural(held.releases, "release")}. ${oldestText(outgoing, timeZone)}`}</p>
          {paused && <p>They go out when you resume. Cancel any that shouldn’t be sent any more, such as old releases.</p>}
          <TableScroll label="Held news email">
            <table className="gcpe-table" aria-label="Held news email">
              <thead>
                <tr>
                  <th scope="col">Release</th>
                  <th scope="col">Type</th>
                  <th scope="col">Emails</th>
                  <th scope="col">Waiting since</th>
                  <th scope="col">Note</th>
                  {paused && <th scope="col">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {held.groups.map((g) => (
                  <tr key={g.jobIds[0]}>
                    <td>{groupTitle(g, timeZone)}</td>
                    <td>{KIND_LABELS[g.kind]}</td>
                    <td>{count(g.emails)}</td>
                    <td>{formatWhen(g.createdAt, new Date(), timeZone, { withDate: true })}</td>
                    <td>{g.attempts > 0 ? `Tried ${plural(g.attempts, "time")}. Last error: ${g.lastError ?? "none recorded"}` : ""}</td>
                    {paused && (
                      <td>
                        <Button variant="secondary" danger aria-label={`Cancel held email: ${groupLabel(g, timeZone)}`} onPress={() => setCancelling([g])}>
                          Cancel
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          {paused && (
            <Button variant="secondary" danger onPress={() => setCancelling(held.groups)}>
              Cancel all held email
            </Button>
          )}
        </>
      )}
      <h3>Failed in the last 30 days</h3>
      {failed.length === 0 ? (
        <p>No news email failed in the last 30 days.</p>
      ) : (
        <>
          <p>Failed email isn’t sent again by itself. Ask technical support to look at the error before anyone republishes the release.</p>
          <TableScroll label="Failed news email">
            <table className="gcpe-table" aria-label="Failed news email">
              <thead>
                <tr>
                  <th scope="col">Release</th>
                  <th scope="col">Type</th>
                  <th scope="col">Emails not sent</th>
                  <th scope="col">Made</th>
                  <th scope="col">What went wrong</th>
                </tr>
              </thead>
              <tbody>
                {failed.map((g) => (
                  <tr key={g.jobIds[0]}>
                    <td>{groupTitle(g, timeZone)}</td>
                    <td>{KIND_LABELS[g.kind]}</td>
                    <td>{count(g.emails)}</td>
                    <td>{formatWhen(g.createdAt, new Date(), timeZone, { withDate: true })}</td>
                    <td>{`Gave up after ${plural(g.attempts, "try", "tries")}. What went wrong: ${g.lastError ?? "not recorded"}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </>
      )}
      {cancelling && (
        <Modal isOpen onOpenChange={(o) => { if (!o) close(); }} isDismissable={!busy} isKeyboardDismissDisabled={busy}>
          <AlertDialog
            role="alertdialog"
            variant="destructive"
            title="Cancel held email?"
            buttons={
              <>
                <Button onPress={close} isPending={busy}>
                  Keep it
                </Button>
                <Button danger onPress={() => void cancel(cancelling)} isPending={busy}>
                  Cancel held email
                </Button>
              </>
            }
          >
            <p>
              {`${plural(chosenEmails, "email")} for ${plural(chosenReleases, "release")} won’t be sent. This can’t be undone.`}
              {alerts > 0 && ` This includes ${plural(alerts, "emergency alert")}.`}
            </p>
            <ul>
              {cancelling.map((g) => (
                <li key={g.jobIds[0]}>{`${groupLabel(g, timeZone)}: ${plural(g.emails, "email")}`}</li>
              ))}
            </ul>
            {error && <InlineAlert variant="danger" role="alert" description={error} />}
          </AlertDialog>
        </Modal>
      )}
    </section>
  );
}

const whoIsEmailed = (ops: OperationsStatus) => (ops.opsEmailSet ? "The operations inbox is emailed." : "No one is emailed about it.");

function PauseControl(props: {
  title: string;
  paused: boolean;
  path: string;
  pauseBody: string;
  resumeBody: string;
  /** Reads the resume question's text again when it opens (the page's copy may be old). */
  freshResumeBody?: () => Promise<string>;
  /** The success message from the resume's own answer. */
  resumedText?: (response: unknown) => string;
  onDone(text: string): void;
  children?: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [freshBody, setFreshBody] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `ops-${props.path.replace(/\W+/g, "-")}`;
  const verb = props.paused ? "resume" : "pause";
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch<unknown>(`${props.path}/${verb}`, { method: "POST" });
      setOpen(false);
      props.onDone(props.paused && props.resumedText ? props.resumedText(response) : `${props.title} ${props.paused ? "resumed" : "paused"}.`);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 502 ? "Distribution isn’t responding. Nothing changed." : "Couldn’t change it. Nothing changed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{props.title}</h2>
      <p>{props.paused ? "Paused" : "Running"}</p>
      {props.children}
      <DialogTrigger
        isOpen={open}
        onOpenChange={(o) => {
          setError(null);
          setOpen(o);
          setFreshBody(null);
          // If it can't be read again, the page's last count stays.
          if (o && props.paused && props.freshResumeBody) props.freshResumeBody().then(setFreshBody, () => {});
        }}
      >
        <Button variant="secondary" danger={!props.paused}>{`${props.paused ? "Resume" : "Pause"} ${props.title}`}</Button>
        <Modal isDismissable>
          <AlertDialog
            role="alertdialog"
            variant="warning"
            title={`${props.paused ? "Resume" : "Pause"} ${props.title}?`}
            buttons={
              <>
                <Button onPress={() => setOpen(false)} isPending={busy}>
                  Cancel
                </Button>
                <Button danger={!props.paused} onPress={() => void run()} isPending={busy}>
                  {`Confirm ${verb}`}
                </Button>
              </>
            }
          >
            <p>{props.paused ? (freshBody ?? props.resumeBody) : props.pauseBody}</p>
            {error && <InlineAlert variant="danger" role="alert" description={error} />}
          </AlertDialog>
        </Modal>
      </DialogTrigger>
    </section>
  );
}

function BounceSummaryForm({ value, onDone }: { value: OperationsStatus["bounceSummary"]; onDone(text: string): void }): React.JSX.Element {
  // The field holds only an address staff set. The server default is shown as text beside it,
  // never put in the field: saving the form unchanged must not store the default as a setting.
  const staffAddress = value.from === "setting" ? (value.address ?? "") : "";
  const [address, setAddress] = useState(staffAddress);
  const [busy, setBusy] = useState(false);
  // ⌘/Ctrl+S saves this form while you're in it (the screen has two).
  const bounceForm = useFormShortcut("save", !busy, true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setAddress(staffAddress), [staffAddress]);
  const put = async (next: string | null, text: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/nod/api/operations/bounce-summary-address", { method: "PUT", body: { address: next } });
      onDone(text);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 400 ? "Enter a valid email address." : "Couldn’t save. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    if (ignoreWhileBusy(busy, e)) return;
    void put(address.trim() || null, "Bounce summary address saved.");
  };
  return (
    <section aria-labelledby="ops-bounce-summary">
      <h2 id="ops-bounce-summary">Bounce summary</h2>
      <p>A daily email at 8:00 listing bounced subscribers, sent only when there were bounces.</p>
      {value.from === "server" && <p>{value.address ? `Using the server default: ${value.address}` : "Using the server default."}</p>}
      {value.from === null && <p>No address is set, so no summary is sent.</p>}
      <Form ref={bounceForm} onSubmit={onSubmit} aria-label="Bounce summary address" className="gcpe-shortcut-scope">
        <TextField label="Bounce summary email" name="address" value={address} onChange={setAddress} />
        <Button type="submit" isPending={busy} shortcut="save">
          Save address
        </Button>
        {value.from === "setting" && (
          <Button variant="secondary" isPending={busy} onPress={() => void put(null, "Using the server default again.")}>
            Use the server default
          </Button>
        )}
      </Form>
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
    </section>
  );
}

function SoftCodesForm({ value, onDone }: { value: string[]; onDone(text: string): void }): React.JSX.Element {
  const saved = value.join(", ");
  const [codes, setCodes] = useState(saved);
  const [busy, setBusy] = useState(false);
  // ⌘/Ctrl+S saves this form while you're in it (the screen has two).
  const codesForm = useFormShortcut("save", !busy, true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setCodes(saved), [saved]);
  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    if (ignoreWhileBusy(busy, e)) return;
    setBusy(true);
    setError(null);
    try {
      const list = codes.split(/[\s,]+/).map((c) => c.trim()).filter(Boolean);
      await apiFetch("/nod/api/operations/bounce-soft-codes", { method: "PUT", body: { codes: list } });
      onDone("Soft bounce codes saved.");
    } catch (err) {
      setError(err instanceof ApiError && err.status === 400 ? "Enter codes like 4.2.2, separated by commas." : "Couldn’t save. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="ops-soft-codes">
      <h2 id="ops-soft-codes">Soft bounces counted as hard</h2>
      <p>
        Soft bounces (codes starting with 4) never count toward disabling a subscriber, except the codes listed here. They then count like a hard
        bounce, from the next bounce on. Leave empty to count none.
      </p>
      <Form ref={codesForm} onSubmit={(e) => void onSubmit(e)} aria-label="Soft bounce codes" className="gcpe-shortcut-scope">
        <TextField label="Soft codes counted as hard" name="codes" value={codes} onChange={setCodes} />
        <Button type="submit" isPending={busy} pendingLabel="Saving…" shortcut="save">
          Save codes
        </Button>
      </Form>
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
    </section>
  );
}

const count = (n: number): string => n.toLocaleString("en-CA");
const plural = (n: number, one: string, many = `${one}s`): string => `${count(n)} ${n === 1 ? one : many}`;

/** Built, off by default. Admins see what it would delete before turning it on. */
function PurgeControl({ purge, timeZone, onDone }: { purge: PurgeStatus; timeZone: string; onDone(text: string): void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = purge.preview;
  const turningOn = !purge.enabled;
  const last = purge.lastRun;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/nod/api/operations/purge", { method: "PUT", body: { enabled: turningOn } });
      setOpen(false);
      onDone(turningOn ? "Retention purge turned on." : "Retention purge turned off.");
    } catch {
      setError("Couldn’t change it. Nothing changed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="ops-purge">
      <h2 id="ops-purge">Retention purge</h2>
      <p>{purge.enabled ? "On" : "Off"}</p>
      <p>
        When on, every night at 3:00 it permanently deletes unconfirmed signups and unused links older than 10 days, and subscribers who unsubscribed
        or were deleted more than 90 days ago, with their history and delivery records. Media-list opt-outs are kept, without the address.
      </p>
      <p>If it ran now, it would delete:</p>
      <ul>
        <li>{plural(p.pendingSubscribers, "unconfirmed subscriber")}</li>
        <li>{plural(p.endedSubscribers, "ended subscriber")}</li>
        <li>{plural(p.unusedLinks, "unused link")}</li>
      </ul>
      <p>{`Expired links in sent emails are cleared every night, on or off (${count(p.expiredSendLinks)} waiting).`}</p>
      <p>{`Next run: ${formatWhen(purge.nextRunAt, new Date(), timeZone)}.`}</p>
      {/* While it's off, an old run would read as if it still runs. */}
      {purge.enabled && last && (
        <p>
          {`Last run (${formatWhen(last.cutoff, new Date(), timeZone)}): ${last.finished ? "finished" : "still going"}; deleted ` +
            `${plural(last.counts.pendingSubscribers + last.counts.endedSubscribers, "subscriber")} and ${plural(last.counts.unusedLinks + last.counts.expiredSendLinks, "link")}.`}
        </p>
      )}
      <DialogTrigger
        isOpen={open}
        onOpenChange={(o) => {
          setError(null);
          setOpen(o);
        }}
      >
        <Button variant="secondary" danger={turningOn}>
          {turningOn ? "Turn on the retention purge" : "Turn off the retention purge"}
        </Button>
        <Modal isDismissable={!busy} isKeyboardDismissDisabled={busy}>
          <AlertDialog
            role="alertdialog"
            variant="warning"
            title={turningOn ? "Turn on the retention purge?" : "Turn off the retention purge?"}
            buttons={
              <>
                <Button onPress={() => setOpen(false)} isPending={busy}>
                  Cancel
                </Button>
                <Button danger={turningOn} onPress={() => void run()} isPending={busy}>
                  {turningOn ? "Turn on purge" : "Turn off purge"}
                </Button>
              </>
            }
          >
            <p>
              {turningOn
                ? `At the next 3:00 run it deletes ${plural(p.pendingSubscribers + p.endedSubscribers, "subscriber")} and ${plural(p.unusedLinks, "unused link")} for good, and keeps doing so every night. This can’t be undone.`
                : "Nothing more is deleted. Expired links in sent emails are still cleared every night."}
            </p>
            {error && <InlineAlert variant="danger" role="alert" description={error} />}
          </AlertDialog>
        </Modal>
      </DialogTrigger>
    </section>
  );
}

/** Read-only: the emergency feed's last check. */
function EmergencyFeedPanel({ feed, timeZone }: { feed: EmergencyFeedStatus; timeZone: string }): React.JSX.Element {
  const r = feed.result;
  return (
    <section aria-labelledby="ops-emergency-feed">
      <h2 id="ops-emergency-feed">Emergency alerts feed</h2>
      {feed.url === null ? (
        <p>No feed is configured (EMERGENCY_FEED_URL), so no emergency alerts are read.</p>
      ) : (
        <>
          <p>{`Read every 5 minutes from ${feed.url}. New alerts go to everyone on the Emergency Info BC list.`}</p>
          {!r ? (
            <p>Not checked yet.</p>
          ) : r.ok ? (
            <p>
              {`Last checked ${formatWhen(r.at, new Date(), timeZone)}: ${plural(r.inFeed, "alert")} in the feed, ${count(r.created)} new, ${count(r.updated)} updated.` +
                (r.seeded ? " This was the first read of this feed, so its alerts were recorded without emailing anyone." : "")}
            </p>
          ) : r.error !== null ? (
            <InlineAlert variant="warning" description={`The last check (${formatWhen(r.at, new Date(), timeZone)}) failed: ${r.error}. It tries again every 5 minutes.`} />
          ) : (
            <InlineAlert variant="warning" description={`${plural(r.failed, "alert couldn’t be recorded", "alerts couldn’t be recorded")}. It tries again every 5 minutes.`} />
          )}
        </>
      )}
    </section>
  );
}

/** Test sites only: shown when Distribution's bounce source is the fake mailbox (spec §7). */
function BounceUpload({ onDone }: { onDone(text: string): void }): React.JSX.Element {
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_BOUNCE_BYTES) return setError("That file is over 1 MB.");
    setError(null);
    setRaw(await file.text());
  };
  const upload = async () => {
    if (!raw.trim()) return setError("Choose a .eml file or paste a message first.");
    if (new Blob([raw]).size > MAX_BOUNCE_BYTES) return setError("That message is over 1 MB.");
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/nod/api/bounces/inbox", { method: "POST", body: { raw } });
      setRaw("");
      onDone("Uploaded. Bounce processing picks it up within 15 minutes.");
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 404
          ? "This site doesn’t use the test mailbox."
          : e instanceof ApiError && e.status === 400
            ? `Not uploaded: ${e.message}`
            : "Couldn’t upload. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="ops-bounce-upload">
      <h2 id="ops-bounce-upload">Test bounce upload</h2>
      <p>Test sites only: every email is redirected, so real bounces never arrive. Upload a bounce message to test bounce handling.</p>
      <label>
        Bounce message (.eml)
        <input type="file" accept=".eml,message/rfc822,text/plain" onChange={(e) => void onFile(e)} disabled={busy} />
      </label>
      <label htmlFor="ops-bounce-raw">Or paste the message</label>
      <textarea id="ops-bounce-raw" rows={8} value={raw} onChange={(e) => setRaw(e.target.value)} disabled={busy} />
      <Button onPress={() => void upload()} isPending={busy} pendingLabel="Uploading…">
        Upload bounce
      </Button>
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
    </section>
  );
}
