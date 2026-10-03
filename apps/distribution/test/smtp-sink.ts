import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { simpleParser, type ParsedMail } from "mailparser";

/**
 * A throwaway SMTP server for tests (and for Task 11's E2E test): accepts any mail and parses
 * it into `messages`. Pass `rejectRcpt` to make every RCPT TO fail with that SMTP reply code —
 * used to exercise the permanent-5xx-failure path without a second sink implementation.
 */
export async function startSmtpSink(opts: { rejectRcpt?: number } = {}): Promise<{ port: number; messages: ParsedMail[]; close(): Promise<void> }> {
  const messages: ParsedMail[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
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
          messages.push(m);
          cb();
        },
        cb,
      );
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.server.address() as AddressInfo).port;
  return { port, messages, close: () => new Promise<void>((r) => server.close(() => r())) };
}
