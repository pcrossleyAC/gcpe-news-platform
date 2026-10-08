import { useEffect, useState } from "react";
import { AlertDialog, Button, InlineAlert, Modal } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { attentionLabel, mediaErrorText } from "./labels";
import type { MediaHubContact, MediaMember } from "./types";

/**
 * Clears a member's needs-attention flag (C59). "Bouncing", or a member with no Media Hub
 * contact, just clears. Clearing "bouncing" restarts the member's bounce count (the server does
 * so whichever way it's resolved), so do it once the mailbox works, and the outcome says so. A
 * Media Hub flag offers the contact's current emails to switch to, or clearing the flag as it
 * stands.
 */
function resolveErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 409 && e.message === "email-taken") return "That address belongs to another subscriber. Choose another email, or remove this member.";
  if (e instanceof ApiError && e.status === 409 && e.message === "opted-out-address")
    return "That address opted out of a media list this member is on. Choose another email, or clear the flag to keep the current one.";
  if (e instanceof ApiError && e.status === 409) return "This member changed while you were looking. Close this, and try again.";
  return mediaErrorText(e);
}

export function ResolveDialog({ member, onClose, onResolved }: { member: MediaMember; onClose(): void; onResolved(message: string): void }): React.JSX.Element {
  const bouncing = member.needsAttention === "bouncing";
  const chooseEmail = !bouncing && member.mediaHubContactId !== null;
  const [contact, setContact] = useState<MediaHubContact | null>(null);
  const [ref, setRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!chooseEmail) return;
    let live = true;
    apiFetch<MediaHubContact>(`/nod/api/media-hub/contacts/${member.mediaHubContactId}`).then(
      (c) => {
        if (live) setContact(c);
      },
      (e: unknown) => {
        if (live) setError(mediaErrorText(e));
      },
    );
    return () => {
      live = false;
    };
  }, [chooseEmail, member.mediaHubContactId]);

  const resolve = async (emailRef?: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/nod/api/media-members/${member.subscriberId}/resolve`, { method: "POST", body: emailRef ? { emailRef } : {} });
      onResolved(bouncing ? "Resolved. Their bounce count starts again." : emailRef ? "Email updated and flag cleared." : "Flag cleared.");
    } catch (e) {
      setError(resolveErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onOpenChange={(open) => { if (!open) onClose(); }} isDismissable>
      <AlertDialog
        role="alertdialog"
        variant="warning"
        title={bouncing ? "Clear the bouncing flag?" : "Resolve this member"}
        buttons={
          <>
            <Button onPress={onClose} isDisabled={busy}>
              Cancel
            </Button>
            {chooseEmail && (
              <Button variant="secondary" onPress={() => void resolve()} isDisabled={busy}>
                Clear the flag only
              </Button>
            )}
            <Button onPress={() => void resolve(chooseEmail ? (ref ?? undefined) : undefined)} isDisabled={busy || (chooseEmail && !ref)}>
              {chooseEmail ? "Use this email" : "Clear flag"}
            </Button>
          </>
        }
      >
        <p>
          {bouncing
            ? "Do this once their mailbox works again. Their bounce count starts again from now."
            : `${member.email}: ${attentionLabel(member.needsAttention ?? "")}.`}
        </p>
        {chooseEmail && contact && (
          <fieldset>
            <legend>Choose the email to use</legend>
            {contact.emails.map((e) => (
              <label key={e.ref}>
                <input type="radio" name="emailRef" value={e.ref} checked={ref === e.ref} onChange={() => setRef(e.ref)} />{" "}
                {e.address}
                {e.organization ? ` (${e.organization})` : ""}
              </label>
            ))}
          </fieldset>
        )}
        {error && <InlineAlert variant="danger" role="alert" description={error} />}
      </AlertDialog>
    </Modal>
  );
}
