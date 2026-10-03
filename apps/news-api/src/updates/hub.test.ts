import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HubConnectionBuilder, HubConnectionState, LogLevel, type HubConnection } from "@microsoft/signalr";
import { createUpdatesHub, type UpdatesHub } from "./hub";

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
});
