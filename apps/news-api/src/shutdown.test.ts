import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdatesHub, type UpdatesHub } from "./updates/hub";
import { createNewsApiShutdown } from "./shutdown";

const RS = "\u001e";

async function start(): Promise<{ hub: UpdatesHub; server: Server; port: number }> {
  const hub = createUpdatesHub();
  const app = express();
  app.use(hub.router);
  const server = createServer(app);
  hub.attach(server);
  await new Promise<void>((r) => server.listen(0, r));
  return { hub, server, port: (server.address() as AddressInfo).port };
}

/** Negotiates and completes the SignalR JSON handshake over a raw WebSocket, leaving it
 * open and registered in the hub's connected-sockets set — the state `server.close()` has
 * to deal with. */
async function connectHandshakenClient(port: number): Promise<WebSocket> {
  const res = await fetch(`http://127.0.0.1:${port}/updates/negotiate?negotiateVersion=1`, { method: "POST" });
  const { connectionToken } = (await res.json()) as { connectionToken: string };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/updates?id=${connectionToken}`);
  await new Promise<void>((resolve) => (ws.onopen = () => resolve()));
  const handshakeAck = new Promise<void>((resolve) => (ws.onmessage = () => resolve()));
  ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
  await handshakeAck;
  return ws;
}

/** Races `promise` against a timeout, resolving to `"done"` or `"timed-out"` instead of
 * leaving a hung promise (and therefore a hung test runner) on failure. */
async function withTimeout(promise: Promise<unknown>, ms: number): Promise<"done" | "timed-out"> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), ms);
  });
  const result = await Promise.race([promise.then(() => "done" as const), timeout]);
  clearTimeout(timer!);
  return result;
}

describe("createNewsApiShutdown", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  // Review fix round 1, point 1 (CRITICAL, reviewer-confirmed): with a /updates WebSocket
  // client still connected, http.Server.close() does not call back until that connection
  // ends — Node keeps tracking upgraded sockets as open connections. hub.close() must run
  // first (it terminates every upgraded socket), or shutdown hangs for as long as the client
  // stays connected.
  it("completes within ~2s even with a connected /updates client", async () => {
    const { hub, server, port } = await start();
    const ws = await connectHandshakenClient(port);
    cleanups.push(() => ws.close());
    expect(hub.connectionCount()).toBe(1);

    const pool = { end: vi.fn(async () => {}) };
    const stopListening = vi.fn(async () => {});
    const exit = vi.fn();
    const shutdown = createNewsApiShutdown({ hub, server, stopListening, pool, exit });

    const outcome = await withTimeout(shutdown(), 2000);
    expect(outcome).toBe("done");
    expect(stopListening).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent: a second call while the first is in flight does nothing extra", async () => {
    const { hub, server } = await start();
    const pool = { end: vi.fn(async () => {}) };
    const stopListening = vi.fn(async () => {});
    const exit = vi.fn();
    const shutdown = createNewsApiShutdown({ hub, server, stopListening, pool, exit });

    await Promise.all([shutdown(), shutdown()]);
    expect(stopListening).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });
});
