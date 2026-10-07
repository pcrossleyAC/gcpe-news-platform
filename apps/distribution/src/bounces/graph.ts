import { createClientCredentialsProvider } from "@gcpe/auth";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { BounceSource } from "./source";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const PROCESSED_FOLDER_NAME = "Processed";

/**
 * Thrown by every Graph call below. Carries only the operation's own label and the HTTP
 * status -- never the response body (which could carry diagnostic text echoing a recipient
 * address) and never the bearer token (Global Constraints "Bounce source": "never include the
 * token or response bodies in thrown messages or logs").
 */
export class GraphBounceSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphBounceSourceError";
  }
}

export interface GraphBounceSourceOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The mailbox Graph reads/writes against (`BOUNCE_MAILBOX`) -- an address, but Distribution's
   * own configured one, not a subscriber's; still never logged (see GraphBounceSourceError). */
  mailbox: string;
  fetchImpl?: typeof fetch;
}

/**
 * BOUNCE_SOURCE=graph: reads a shared mailbox's Inbox over Microsoft Graph using the same
 * client-credentials provider every other OAuth2-client-credentials caller in this repo uses
 * (packages/auth/client-credentials.ts), with the Graph-specific scope and token URL. Built
 * and unit-tested only against recorded responses (Q23) -- never run live until that's
 * answered.
 *
 * `fetchNew` lists unread messages (selecting only `id`, so nothing of their content is ever
 * pulled over the wire until this source decides to download it) and downloads each one's raw
 * MIME. `markProcessed` marks each read and moves it into a `Processed` folder (created once,
 * lazily, and cached here for the lifetime of this source) -- legacy deleted processed
 * messages; moving instead is strictly safer (nothing is ever lost) and is what the brief asks
 * for.
 */
export function graphBounceSource(opts: GraphBounceSourceOptions): BounceSource {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const getToken = createClientCredentialsProvider({
    tokenUrl: `https://login.microsoftonline.com/${opts.tenantId}/oauth2/v2.0/token`,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    scope: "https://graph.microsoft.com/.default",
    fetchImpl,
  });

  const mailboxPath = `/users/${encodeURIComponent(opts.mailbox)}`;
  // Resolved once per source instance and kept -- a 15-minute-cadence run has no reason to
  // re-look this up every time once it's known.
  let processedFolderId: string | undefined;

  async function call(op: string, path: string, init?: RequestInit): Promise<Response> {
    const token = await getToken();
    const res = await fetchImpl(`${GRAPH_BASE}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new GraphBounceSourceError(`Graph ${op} failed: HTTP ${res.status}`);
    return res;
  }

  async function ensureProcessedFolderId(): Promise<string> {
    if (processedFolderId) return processedFolderId;
    const filter = encodeURIComponent(`displayName eq '${PROCESSED_FOLDER_NAME}'`);
    const found = await call("list Processed folder", `${mailboxPath}/mailFolders?$filter=${filter}`);
    const { value } = (await found.json()) as { value: { id: string }[] };
    if (value[0]) {
      processedFolderId = value[0].id;
      return processedFolderId;
    }
    const created = await call("create Processed folder", `${mailboxPath}/mailFolders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: PROCESSED_FOLDER_NAME }),
    });
    const createdJson = (await created.json()) as { id: string };
    processedFolderId = createdJson.id;
    return processedFolderId;
  }

  return {
    async fetchNew(limit) {
      // Deliberately one page: $top=limit and no @odata.nextLink following, so a mailbox with
      // more than `limit` unread messages only has its first page read this run -- the rest is
      // still unread and gets picked up on a later (15-minute) run instead. $orderby makes that
      // page the oldest `limit` unread messages, not Graph's own default (newest first) -- a
      // mailbox with a backlog works through it in arrival order instead of starving the oldest
      // messages every run.
      //
      // Graph's List messages requires every $orderby property to also appear in $filter,
      // first and in the same order -- an $orderby with no matching leading $filter clause
      // answers 400 InefficientFilter, failing every run. `receivedDateTime ge
      // 1900-01-01T00:00:00Z` is otherwise a no-op (every real message is newer) that exists
      // purely to satisfy that requirement.
      const filter = encodeURIComponent("receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false");
      const orderBy = encodeURIComponent("receivedDateTime asc");
      const filterAndOrder = `$filter=${filter}&$orderby=${orderBy}`;
      const listed = await call(
        "list unread messages",
        `${mailboxPath}/mailFolders/inbox/messages?${filterAndOrder}&$top=${limit}&$select=id`,
      );
      const { value } = (await listed.json()) as { value: { id: string }[] };

      const fetched: { id: string; raw: string }[] = [];
      for (const { id } of value) {
        // A poison message (one id's $value download failing -- a transient Graph error, or
        // content Graph itself can't serve) must not abort the rest of this run's page: skipped,
        // logged with a safe label and the Graph message id only (never a response body), and
        // left unread -- markProcessed is never called for it, so it's retried on a later run.
        try {
          const mime = await call("download message", `${mailboxPath}/messages/${id}/$value`);
          fetched.push({ id, raw: await mime.text() });
        } catch (e) {
          console.error(`[distribution] Graph message ${id} failed to download:`, safeErrorLabel(e));
        }
      }
      return fetched;
    },
    async markProcessed(ids) {
      if (ids.length === 0) return;
      const folderId = await ensureProcessedFolderId();
      // Each id's mark-read + move is isolated -- one id's failure (e.g. its move failing
      // after mark-read already succeeded) must not stop the rest from being marked and
      // moved, which would otherwise leave them unread and re-fetched (and re-recorded as a
      // harmless but noisy duplicate) next run. Every id is still attempted; a summary (count
      // only, never which ids) is thrown once all of them have been.
      let failures = 0;
      for (const id of ids) {
        try {
          await call("mark message read", `${mailboxPath}/messages/${id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ isRead: true }),
          });
          await call("move message to Processed", `${mailboxPath}/messages/${id}/move`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ destinationId: folderId }),
          });
        } catch {
          failures++;
        }
      }
      if (failures > 0) throw new GraphBounceSourceError(`markProcessed failed for ${failures}/${ids.length} message(s)`);
    },
  };
}
