import { useState } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../../api/client";

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
      <Button onPress={() => void send()} isDisabled={sending}>
        Email me a copy
      </Button>
      {sentTo && <InlineAlert variant="success" role="status" description={`Sent to ${sentTo}`} />}
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
    </div>
  );
}
