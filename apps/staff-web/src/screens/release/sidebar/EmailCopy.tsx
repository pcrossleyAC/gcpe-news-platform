import { useState } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";

export interface EmailCopyProps {
  view: ReleaseView;
}

interface EmailCopyResponse {
  sentTo: string;
}

/** "Email me a copy" (task-4-brief.md): `POST .../email-copy`, read-only (any signed-in staff
 * role, not just Editor) — shows "Sent to <email>" on success, or the server's 422 ("no email
 * address") / 503 ("isn't configured") message. */
export function EmailCopy({ view }: EmailCopyProps): React.JSX.Element {
  // The break-glass administrator (LOCAL_ADMIN_*) has no email address, so there's nowhere to
  // send it — say why up front instead of failing on press (hand-check feedback on boxs.ca).
  const { user } = useSession();
  const noAddress = !!user && (user.email ?? "").trim() === "";
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setSending(true);
    setError(null);
    setSentTo(null);
    try {
      const { sentTo: to } = await apiFetch<EmailCopyResponse>(`/nrms/api/releases/${view.id}/email-copy`, { method: "POST" });
      setSentTo(to);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The email couldn't be sent.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="gcpe-sidebar__email-copy">
      <Button onPress={() => void send()} isDisabled={sending || noAddress} aria-describedby={noAddress ? "email-copy-why" : undefined}>
        Email me a copy
      </Button>
      {noAddress && (
        <p id="email-copy-why" className="gcpe-sidebar__note">
          You&rsquo;re signed in as the break-glass administrator, which has no email address. Sign in with your own account to email yourself a copy.
        </p>
      )}
      {sentTo && <InlineAlert variant="success" role="status" description={`Sent to ${sentTo}`} />}
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
    </div>
  );
}
