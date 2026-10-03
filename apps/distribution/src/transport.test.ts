import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import nodemailer from "nodemailer";
import { afterEach, describe, expect, it } from "vitest";
import { smtpTransportOptions } from "./transport";

const env = {
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: 0,
  SMTP_SECURE: false,
  SMTP_USER: undefined,
  SMTP_PASS: undefined,
  SMTP_TLS_REJECT_UNAUTHORIZED: true,
  SMTP_CONNECTION_TIMEOUT_MS: 2_000,
  SMTP_GREETING_TIMEOUT_MS: 2_000,
  SMTP_SOCKET_TIMEOUT_MS: 2_000,
  SMTP_MAX_CONNECTIONS: 1,
};

describe("smtpTransportOptions", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  // P2-R25 item 4: nodemailer's pool re-queues a message whose connection closes while it's
  // assigned (in 10.0.14: a close before the server's greeting), up to `maxRequeues` (default
  // 5) more times inside the same sendMail() call — each a fresh connection attempt with its
  // own timeouts, so one sendMail could take ~6x the perMessageMs the claim lock is sized for.
  // maxRequeues: 0 makes sendMail fail on the first close and leaves retrying to sender.ts.
  it("makes one connection attempt per sendMail when the server drops the connection before greeting (no pool re-queue)", async () => {
    let connections = 0;
    server = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const transport = nodemailer.createTransport(smtpTransportOptions({ ...env, SMTP_PORT: (server.address() as AddressInfo).port }));
    try {
      await expect(transport.sendMail({ from: "news@example.com", to: "x@example.com", subject: "s", text: "t" })).rejects.toMatchObject({ code: "ECONNECTION" });
      expect(connections).toBe(1);
    } finally {
      transport.close();
    }
  });

  it("pools connections and applies the configured timeouts", () => {
    expect(smtpTransportOptions(env)).toMatchObject({ pool: true, maxConnections: 1, maxRequeues: 0, connectionTimeout: 2_000, greetingTimeout: 2_000, socketTimeout: 2_000 });
  });
});
