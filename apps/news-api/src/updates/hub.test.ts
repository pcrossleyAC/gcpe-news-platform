import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HubConnectionBuilder, HubConnectionState, LogLevel, type HubConnection } from "@microsoft/signalr";
import { createUpdatesHub, type UpdatesHub } from "./hub";

const RS = "\u001e";

async function start(hubOpts: Parameters<typeof createUpdatesHub>[0] = {}, port = 0) {
  const hub = createUpdatesHub(hubOpts);
  const app = express();
  app.use(hub.router);
  const server = createServer(app);
  hub.attach(server);
  await new Promise<void>((r) => server.listen(port, r));
  return { hub, server, port: (server.address() as AddressInfo).port };
}

function client(port: number, serverTimeoutMs = 30_000): HubConnection {
  const c = new HubConnectionBuilder().withUrl(`http://127.0.0.1:${port}/updates`).configureLogging(LogLevel.None).build();
  c.serverTimeoutInMilliseconds = serverTimeoutMs;
  return c;
}

/** Negotiates directly over HTTP and returns the token to open a raw WebSocket with. */
async function negotiateToken(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/updates/negotiate?negotiateVersion=1`, { method: "POST" });
  const body = (await res.json()) as { connectionToken: string };
  return body.connectionToken;
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => (ws.onopen = () => resolve()));
}

function waitClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => (ws.onclose = (e) => resolve(e.code)));
}

describe("SignalR updates hub", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });
  const track = (hub: UpdatesHub, server: Server, conn?: HubConnection) =>
    cleanups.push(async () => {
      await conn?.stop();
      hub.close();
      await new Promise((r) => server.close(r));
    });

  it("delivers PostUpdate invocations with the key array", async () => {
    const { hub, server, port } = await start();
    const conn = client(port);
    track(hub, server, conn);
    const got = new Promise<string[]>((resolve) => conn.on("PostUpdate", (keys: string[]) => resolve(keys)));
    await conn.start();
    expect(hub.connectionCount()).toBe(1);
    hub.broadcast("PostUpdate", ["2026TT0103-001121"]);
    expect(await got).toEqual(["2026TT0103-001121"]);
  });

  it("keeps the connection alive with pings", async () => {
    const { hub, server, port } = await start({ pingMs: 50 });
    const conn = client(port, 300);
    track(hub, server, conn);
    await conn.start();
    await new Promise((r) => setTimeout(r, 800));
    expect(conn.state).toBe(HubConnectionState.Connected);
  });

  it("rejects a WebSocket upgrade without a negotiated token", async () => {
    const { hub, server, port } = await start();
    track(hub, server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/updates?id=bogus`);
    const outcome = await new Promise((r) => {
      ws.onopen = () => r("open");
      ws.onerror = () => r("error");
    });
    expect(outcome).toBe("error");
  });

  it("client reconnects after hub restart", async () => {
    const first = await start();
    const conn = client(first.port);
    await conn.start();
    await conn.stop();
    first.hub.close();
    await new Promise((r) => first.server.close(r));

    const second = await start({}, first.port);
    const conn2 = client(second.port);
    track(second.hub, second.server, conn2);
    await conn2.start();
    expect(second.hub.connectionCount()).toBe(1);
  });

  // Controller ruling P1-R9: disconnectAll() forces every connected client to reconnect
  // (close code 1000) without stopping the hub — negotiate/connect must keep working, and a
  // client using the official automatic-reconnect feature must come back and keep receiving
  // broadcasts. Task 12 wires listenForUpdates' onReconnect to this so clients never miss a
  // notification window silently.
  it("disconnectAll forces an automatically-reconnecting client to reconnect and keep receiving broadcasts", async () => {
    const { hub, server, port } = await start();
    const conn = new HubConnectionBuilder()
      .withUrl(`http://127.0.0.1:${port}/updates`)
      .withAutomaticReconnect([0, 10, 50])
      .configureLogging(LogLevel.None)
      .build();
    track(hub, server, conn);

    const reconnected = new Promise<void>((resolve) => conn.onreconnected(() => resolve()));
    await conn.start();
    expect(hub.connectionCount()).toBe(1);

    hub.disconnectAll();
    await reconnected;
    expect(conn.state).toBe(HubConnectionState.Connected);
    expect(hub.connectionCount()).toBe(1);

    const got = new Promise<string[]>((resolve) => conn.on("PostUpdate", (keys: string[]) => resolve(keys)));
    hub.broadcast("PostUpdate", ["after-reconnect"]);
    expect(await got).toEqual(["after-reconnect"]);
  });

  it("disconnectAll does not stop the hub: negotiate and new connections still work", async () => {
    const { hub, server, port } = await start();
    track(hub, server);

    hub.disconnectAll();

    const conn = client(port);
    track(hub, server, conn);
    await conn.start();
    expect(conn.state).toBe(HubConnectionState.Connected);
    expect(hub.connectionCount()).toBe(1);
  });

  // Review fix round 1, point 1 (CRITICAL): a non-object JSON message (e.g. `null`) used to
  // throw inside the 'message' listener — uncaught, since it's an event-emitter callback —
  // crashing the whole process. Must be treated as a protocol error instead, for both an
  // unhandshaken and an already-handshaken socket, and must never take the hub down with it.
  it("does not crash the process on non-object JSON, before or after the handshake", async () => {
    const { hub, server, port } = await start();
    track(hub, server);

    const id1 = await negotiateToken(port);
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/updates?id=${id1}`);
    await waitOpen(ws1);
    const closed1 = waitClose(ws1);
    ws1.send("null" + RS);
    expect(await closed1).toBe(1003);

    const id2 = await negotiateToken(port);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/updates?id=${id2}`);
    await waitOpen(ws2);
    const handshakeAck = new Promise<void>((resolve) => {
      ws2.onmessage = () => resolve();
    });
    ws2.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
    await handshakeAck;
    const closed2 = waitClose(ws2);
    ws2.send("null" + RS);
    expect(await closed2).toBe(1003);

    // The process survived and the hub still serves new clients.
    const conn = client(port);
    track(hub, server, conn);
    await conn.start();
    expect(conn.state).toBe(HubConnectionState.Connected);
  });

  // Final review D6: a JSON array is not a SignalR frame either — the object check's comment
  // already said so, but `typeof [] === "object"` let arrays through.
  it("closes with 1003 on a JSON array, before or after the handshake", async () => {
    const { hub, server, port } = await start();
    track(hub, server);

    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/updates?id=${await negotiateToken(port)}`);
    await waitOpen(ws1);
    const closed1 = waitClose(ws1);
    ws1.send("[]" + RS);
    expect(await closed1).toBe(1003);

    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/updates?id=${await negotiateToken(port)}`);
    await waitOpen(ws2);
    const handshakeAck = new Promise<void>((resolve) => (ws2.onmessage = () => resolve()));
    ws2.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
    await handshakeAck;
    const closed2 = waitClose(ws2);
    ws2.send(JSON.stringify([{ type: 7 }]) + RS);
    expect(await closed2).toBe(1003);
  });

  // Point 2: a socket that never completes the JSON handshake is closed after
  // handshakeTimeoutMs, and close() reaches sockets that never handshook too.
  it("closes a socket that never completes the handshake", async () => {
    const { hub, server, port } = await start({ handshakeTimeoutMs: 50 });
    track(hub, server);
    const id = await negotiateToken(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/updates?id=${id}`);
    await waitOpen(ws);
    await waitClose(ws);

    const conn = client(port);
    track(hub, server, conn);
    await conn.start();
    expect(conn.state).toBe(HubConnectionState.Connected);
  });

  it("close() terminates sockets that never completed the handshake", async () => {
    const { hub, server, port } = await start({ handshakeTimeoutMs: 60_000 });
    track(hub, server);
    const id = await negotiateToken(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/updates?id=${id}`);
    await waitOpen(ws);
    const closed = waitClose(ws);
    hub.close();
    await closed;
  });

  // Point 3: an oversized message (beyond the 64 KiB maxPayload passed to WebSocketServer)
  // closes the socket instead of being buffered or delivered.
  it("closes the socket on an oversized message", async () => {
    const { hub, server, port } = await start();
    track(hub, server);
    const id = await negotiateToken(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/updates?id=${id}`);
    await waitOpen(ws);
    const handshakeAck = new Promise<void>((resolve) => {
      ws.onmessage = () => resolve();
    });
    ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
    await handshakeAck;
    const closed = new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
      ws.onerror = () => resolve();
    });
    ws.send("x".repeat(70_000));
    await closed;
  });

  // Final review I1: a full pending pool must not lock real clients out. Once maxPending
  // tokens are outstanding, negotiate evicts the oldest pending token (Map insertion order)
  // instead of answering 503 — so an anonymous flood only ever invalidates other flood tokens.
  it("evicts the oldest pending token instead of returning 503 once maxPending is reached", async () => {
    const { hub, server, port } = await start({ maxPending: 2 });
    track(hub, server);
    const t1 = await negotiateToken(port);
    await negotiateToken(port);
    const res = await fetch(`http://127.0.0.1:${port}/updates/negotiate?negotiateVersion=1`, { method: "POST" });
    expect(res.status).toBe(200);
    const { connectionToken: t3 } = (await res.json()) as { connectionToken: string };

    const evicted = new WebSocket(`ws://127.0.0.1:${port}/updates?id=${t1}`);
    const outcome = await new Promise((r) => {
      evicted.onopen = () => r("open");
      evicted.onerror = () => r("error");
    });
    expect(outcome).toBe("error");

    const fresh = new WebSocket(`ws://127.0.0.1:${port}/updates?id=${t3}`);
    cleanups.push(() => fresh.close());
    await waitOpen(fresh);
  });

  it("a real SignalR client still connects after negotiate is flooded past maxPending", async () => {
    const { hub, server, port } = await start({ maxPending: 5 });
    const conn = client(port);
    track(hub, server, conn);
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/updates/negotiate?negotiateVersion=1`, { method: "POST" });
      expect(res.status).toBe(200);
    }
    await conn.start();
    expect(conn.state).toBe(HubConnectionState.Connected);
    expect(hub.connectionCount()).toBe(1);
  });

  it("rate limits negotiate per IP (negotiateRateLimitPerMinute)", async () => {
    const { hub, server, port } = await start({ negotiateRateLimitPerMinute: 3 });
    track(hub, server);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await fetch(`http://127.0.0.1:${port}/updates/negotiate`, { method: "POST" })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("returns 503 from negotiate once maxConnections sockets are open", async () => {
    const { hub, server, port } = await start({ maxConnections: 1 });
    const conn = client(port);
    track(hub, server, conn);
    await conn.start();
    const full = await fetch(`http://127.0.0.1:${port}/updates/negotiate`, { method: "POST" });
    expect(full.status).toBe(503);
    await conn.stop();
    await vi.waitFor(() => expect(hub.connectionCount()).toBe(0));
    const ok = await fetch(`http://127.0.0.1:${port}/updates/negotiate`, { method: "POST" });
    expect(ok.status).toBe(200);
  });

  // Point 5: a connected client that goes silent (sends nothing, including no pings) for
  // longer than clientTimeoutMs is terminated on the next ping tick.
  it("terminates a connected client that stops sending messages", async () => {
    const { hub, server, port } = await start({ pingMs: 20, clientTimeoutMs: 60 });
    track(hub, server);
    const id = await negotiateToken(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/updates?id=${id}`);
    await waitOpen(ws);
    const closed = waitClose(ws);
    ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
    await closed;
  });

  // Point 8: invalid JSON during the handshake is a protocol error.
  it("closes the socket on invalid JSON during the handshake", async () => {
    const { hub, server, port } = await start();
    track(hub, server);
    const id = await negotiateToken(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/updates?id=${id}`);
    await waitOpen(ws);
    const closed = waitClose(ws);
    ws.send("{not json" + RS);
    expect(await closed).toBe(1003);
  });

  // Point 8: an unsupported protocol gets a SignalR-shaped error frame, then the socket closes.
  it("sends an error frame and closes for an unsupported protocol", async () => {
    const { hub, server, port } = await start();
    track(hub, server);
    const id = await negotiateToken(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/updates?id=${id}`);
    await waitOpen(ws);
    const errorFrame = new Promise<string>((resolve) => {
      ws.onmessage = (e) => resolve(e.data as string);
    });
    const closed = waitClose(ws);
    ws.send(JSON.stringify({ protocol: "messagepack", version: 1 }) + RS);
    expect(await errorFrame).toContain("'messagepack'");
    await closed;
  });

  // Point 8: a client-sent close message (type 7) makes the server close the connection.
  it("closes when the client sends a close message", async () => {
    const { hub, server, port } = await start();
    track(hub, server);
    const id = await negotiateToken(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/updates?id=${id}`);
    await waitOpen(ws);
    const handshakeAck = new Promise<void>((resolve) => {
      ws.onmessage = () => resolve();
    });
    ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
    await handshakeAck;
    const closed = waitClose(ws);
    ws.send(JSON.stringify({ type: 7 }) + RS);
    await closed;
  });

  // Point 6: when the hub is the only 'upgrade' listener, an unrelated path is 404'd.
  it("404s an unrelated path when the hub is the sole upgrade listener", async () => {
    const { hub, server, port } = await start();
    track(hub, server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
    const outcome = await new Promise((r) => {
      ws.onopen = () => r("open");
      ws.onerror = () => r("error");
    });
    expect(outcome).toBe("error");
  });

  // Point 6: an unrelated path is left alone for another 'upgrade' listener on the same
  // server to handle, instead of the hub destroying the socket first.
  it("leaves an unrelated path for another upgrade listener when one is attached", async () => {
    const { hub, server, port } = await start();
    track(hub, server);
    let otherSawIt = false;
    server.on("upgrade", (req, socket) => {
      if (new URL(req.url ?? "", "http://localhost").pathname === "/other") {
        otherSawIt = true;
        socket.destroy();
      }
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
    await new Promise<void>((r) => {
      ws.onclose = () => r();
      ws.onerror = () => r();
    });
    expect(otherSawIt).toBe(true);
  });

  // Point 7: a SignalR frame split across multiple WebSocket messages is reassembled before
  // being parsed, instead of each partial chunk being treated as its own frame.
  it("reassembles a SignalR frame split across multiple WebSocket messages", async () => {
    const { hub, server, port } = await start();
    track(hub, server);
    const id = await negotiateToken(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/updates?id=${id}`);
    await waitOpen(ws);
    const handshakeAck = new Promise<string>((resolve) => {
      ws.onmessage = (e) => resolve(e.data as string);
    });
    const full = JSON.stringify({ protocol: "json", version: 1 }) + RS;
    const splitAt = Math.floor(full.length / 2);
    ws.send(full.slice(0, splitAt));
    ws.send(full.slice(splitAt));
    expect(await handshakeAck).toBe("{}" + RS);
    expect(hub.connectionCount()).toBe(1);
  });
});
