import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { AlertDialog, Button, DialogTrigger, Form, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { formatWhen } from "../../format/dates";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { canAdminSubscribers } from "./access";
import type { OperationsStatus } from "./types";

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
          <PauseControl
            title="News On Demand sending"
            paused={ops.nod.paused}
            path="/nod/api/settings"
            pauseBody="News On Demand keeps recording releases and building emails but holds them until you resume. Nothing is dropped. The operations inbox is emailed."
            resumeBody="Held emails start going out straight away. The operations inbox is emailed."
            onDone={done}
          >
            <p>{`Last daily digest: ${ops.nod.lastDigestCutoff ? formatWhen(ops.nod.lastDigestCutoff, new Date(), timeZone) : "none yet"}.`}</p>
          </PauseControl>
          {ops.distribution ? (
            <PauseControl
              title="Distribution"
              paused={ops.distribution.paused}
              path="/nod/api/distribution"
              pauseBody="No email goes out from any app, except system notices, until you resume. Queued email is kept. The operations inbox is emailed."
              resumeBody="Queued email starts going out straight away. The operations inbox is emailed."
              onDone={done}
            />
          ) : (
            <section aria-labelledby="ops-distribution">
              <h2 id="ops-distribution">Distribution</h2>
              <InlineAlert variant="warning" description="Distribution isn’t responding, so its state is unknown. Reload the page shortly." />
            </section>
          )}
          <BounceSummaryForm value={ops.bounceSummary} onDone={done} />
          {ops.bounceSource === "fake" && <BounceUpload onDone={done} />}
        </>
      )}
    </div>
  );
}

function PauseControl(props: {
  title: string;
  paused: boolean;
  path: string;
  pauseBody: string;
  resumeBody: string;
  onDone(text: string): void;
  children?: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `ops-${props.path.replace(/\W+/g, "-")}`;
  const verb = props.paused ? "resume" : "pause";
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`${props.path}/${verb}`, { method: "POST" });
      setOpen(false);
      props.onDone(`${props.title} ${props.paused ? "resumed" : "paused"}.`);
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
                <Button onPress={() => setOpen(false)} isDisabled={busy}>
                  Cancel
                </Button>
                <Button danger={!props.paused} onPress={() => void run()} isDisabled={busy}>
                  {`Confirm ${verb}`}
                </Button>
              </>
            }
          >
            <p>{props.paused ? props.resumeBody : props.pauseBody}</p>
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
    e.preventDefault();
    void put(address.trim() || null, "Bounce summary address saved.");
  };
  return (
    <section aria-labelledby="ops-bounce-summary">
      <h2 id="ops-bounce-summary">Bounce summary</h2>
      <p>A daily email at 8:00 listing bounced subscribers, sent only when there were bounces.</p>
      {value.from === "server" && <p>{value.address ? `Using the server default: ${value.address}` : "Using the server default."}</p>}
      {value.from === null && <p>No address is set, so no summary is sent.</p>}
      <Form onSubmit={onSubmit} aria-label="Bounce summary address">
        <TextField label="Bounce summary email" name="address" value={address} onChange={setAddress} />
        <Button type="submit" isDisabled={busy}>
          Save address
        </Button>
        {value.from === "setting" && (
          <Button variant="secondary" isDisabled={busy} onPress={() => void put(null, "Using the server default again.")}>
            Use the server default
          </Button>
        )}
      </Form>
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
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
      <Button onPress={() => void upload()} isDisabled={busy}>
        Upload bounce
      </Button>
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
    </section>
  );
}
