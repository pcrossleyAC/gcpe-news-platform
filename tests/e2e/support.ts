import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hashPassword } from "@gcpe/auth";

/**
 * Phase 2 exit check (spec §11): every app in this test shares ONE local admin secret and
 * password — the setup the owner will use first, with no Entra config at all. The password
 * is hashed once (hashPassword is deliberately slow — scrypt — so this only happens once per
 * test run, in beforeAll).
 */
export interface LocalAuthEnv {
  secret: string;
  passwordHash: string;
  password: string;
}

export async function localAuthEnv(): Promise<LocalAuthEnv> {
  const secret = "thin-slice-e2e-shared-local-auth-secret-32chars+";
  const password = "correct-horse-battery-staple-99";
  const passwordHash = await hashPassword(password);
  return { secret, passwordHash, password };
}

export interface Listening {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/** Starts `app` on a real, ephemeral port (listen(0)) on the loopback interface. */
export async function listen(app: RequestListener): Promise<Listening> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * News API and the public site each need the OTHER's listening URL to build their own config
 * (News API's `subscribers` points at the public site's /events; the public site's
 * NEWS_API_URL points back at News API) — a construction-time cycle real main.ts processes
 * never hit, since each one there is deployed with the other's URL already known from
 * config, not discovered from an ephemeral listen(0) port at startup.
 *
 * `reserve()` breaks the cycle: it claims a real ephemeral port immediately (so its URL is
 * known) without yet knowing what will handle requests on it, so both peers' URLs can be
 * handed to each other's `createApp()` before either request handler exists. `attach` wires
 * the real app in once it's built; nothing can race it since no request happens before
 * `beforeAll` finishes building both.
 */
export async function reserve(): Promise<Listening & { attach(app: RequestListener): void }> {
  let current: RequestListener | undefined;
  const server = createServer((req, res) => {
    if (!current) {
      res.statusCode = 503;
      res.end();
      return;
    }
    current(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    attach: (app) => {
      current = app;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
