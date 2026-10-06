import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { simpleParser, type ParsedMail } from "mailparser";

/**
 * A throwaway SMTP server for tests (and for Task 11's E2E test): accepts any mail and parses
 * it into `messages`.
 *
 * - `rejectRcpt`: every RCPT TO fails with that SMTP reply code — exercises the permanent
 *   recipient-rejection path without a second sink implementation.
 * - `requireAuth`: refuses MAIL/RCPT/DATA without authentication (530) and rejects every AUTH
 *   attempt (535) — exercises the SMTP-configuration-error retry path (bad/missing creds),
 *   which must stay distinct from a permanent recipient rejection.
 * - `delayMs`: waits this long before acknowledging DATA — a deliberately slow server, for
 *   exercising claim-lock expiry during an in-flight send.
 */
export async function startSmtpSink(opts: { rejectRcpt?: number; requireAuth?: boolean; delayMs?: number } = {}): Promise<{
  port: number;
  messages: ParsedMail[];
  close(): Promise<void>;
}> {
  const messages: ParsedMail[] = [];
  const server = new SMTPServer({
    authOptional: !opts.requireAuth,
    disabledCommands: ["STARTTLS"],
    ...(opts.requireAuth
      ? {
          onAuth(_auth, _session, cb: (err: Error | null) => void) {
            cb(new Error("bad credentials"));
          },
        }
      : {}),
    ...(opts.rejectRcpt !== undefined
      ? {
          onRcptTo(_address, _session, cb) {
            const err = new Error(`mailbox rejected (${opts.rejectRcpt})`) as Error & { responseCode: number };
            err.responseCode = opts.rejectRcpt!;
            cb(err);
          },
        }
      : {}),
    onData(stream, _session, cb) {
      simpleParser(stream).then(
        (m) => {
          const finish = () => {
            messages.push(m);
            cb();
          };
          if (opts.delayMs) setTimeout(finish, opts.delayMs);
          else finish();
        },
        cb,
      );
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.server.address() as AddressInfo).port;
  return { port, messages, close: () => new Promise<void>((r) => server.close(() => r())) };
}
