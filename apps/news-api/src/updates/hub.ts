import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { UpdateTarget } from "./notify";

const RS = "\u001e";

export interface UpdatesHub {
  router: express.Router;
  attach(server: Server): void;
  broadcast(target: UpdateTarget, keys: string[]): void;
  connectionCount(): number;
  /**
   * Closes every connected socket cleanly (close code 1000) without stopping the hub —
   * negotiate and new connections keep working afterwards. Ruling P1-R9: used to force every
   * client to reconnect (and the gcpe-news-webapp client to clear its caches on reconnect)
   * after the Postgres LISTEN connection drops and is re-established, covering notifications
   * that were missed during the gap.
   */
  disconnectAll(): void;
  close(): void;
}

export function createUpdatesHub(opts: { path?: string; pingMs?: number; tokenTtlMs?: number } = {}): UpdatesHub {
  const path = opts.path ?? "/updates";
  const pending = new Map<string, NodeJS.Timeout>();
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });

  const router = express.Router();
  router.post(`${path}/negotiate`, (req, res) => {
    // Each negotiate is a one-shot request immediately followed by a WebSocket upgrade, so
    // there's nothing to gain from keeping this HTTP/1.1 connection alive — and doing so is
    // actively harmful: a client-side fetch keep-alive pool can hand out this exact socket
    // for a *later* negotiate after this server has been torn down (e.g. a test or deploy
    // restart reusing the same port), racing the socket's close against the pool's reuse and
    // failing with a generic "fetch failed". Telling the client not to pool it avoids that.
    res.setHeader("Connection", "close");
    const token = randomUUID();
    pending.set(token, setTimeout(() => pending.delete(token), opts.tokenTtlMs ?? 60_000).unref());
    const transports = [{ transport: "WebSockets", transferFormats: ["Text", "Binary"] }];
    if (req.query.negotiateVersion === "1") {
      res.json({ negotiateVersion: 1, connectionId: randomUUID(), connectionToken: token, availableTransports: transports });
    } else {
      res.json({ connectionId: token, availableTransports: transports });
    }
  });

  function onConnection(ws: WebSocket) {
    let handshaken = false;
    ws.on("message", (data) => {
      const frames = data.toString().split(RS).filter(Boolean);
      for (const frame of frames) {
        let msg: { protocol?: string; type?: number };
        try {
          msg = JSON.parse(frame);
        } catch {
          ws.close(1003);
          return;
        }
        if (!handshaken) {
          if (msg.protocol !== "json") {
            ws.send(JSON.stringify({ error: `Requested protocol '${msg.protocol}' is not available.` }) + RS);
            ws.close();
            return;
          }
          handshaken = true;
          sockets.add(ws);
          ws.send("{}" + RS);
        } else if (msg.type === 7) {
          ws.close();
        }
      }
    });
    ws.on("close", () => sockets.delete(ws));
    ws.on("error", () => sockets.delete(ws));
  }

  const pingTimer = setInterval(() => {
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(JSON.stringify({ type: 6 }) + RS);
  }, opts.pingMs ?? 15_000);
  pingTimer.unref();

  return {
    router,
    attach(server: Server) {
      server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(req.url ?? "", "http://localhost");
        const id = url.searchParams.get("id");
        if (url.pathname !== path || !id || !pending.has(id)) {
          socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        clearTimeout(pending.get(id));
        pending.delete(id);
        wss.handleUpgrade(req, socket, head, onConnection);
      });
    },
    broadcast(target, keys) {
      const frame = JSON.stringify({ type: 1, target, arguments: [keys] }) + RS;
      for (const s of sockets) if (s.readyState === s.OPEN) s.send(frame);
    },
    connectionCount: () => sockets.size,
    disconnectAll() {
      for (const s of sockets) if (s.readyState === s.OPEN) s.close(1000);
    },
    close() {
      clearInterval(pingTimer);
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      for (const s of sockets) s.terminate();
      sockets.clear();
      wss.close();
    },
  };
}
