import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { WebSocketServer, type WebSocket } from "ws";
import type { UpdateTarget } from "./notify";

const RS = "\u001e";
const MAX_PAYLOAD_BYTES = 64 * 1024;

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

export function createUpdatesHub(
  opts: {
    path?: string;
    pingMs?: number;
    tokenTtlMs?: number;
    /** How long an upgraded socket has to complete the SignalR JSON handshake before it's closed. */
    handshakeTimeoutMs?: number;
    /**
     * Cap on outstanding negotiated-but-not-yet-connected tokens. Past the cap, negotiate
     * evicts the *oldest* pending token rather than refusing — an anonymous flood can only
     * invalidate other stale tokens, never lock real clients out (final review I1).
     */
    maxPending?: number;
    /** Per-IP limit on POST {path}/negotiate per minute (429 past it). Default 120. */
    negotiateRateLimitPerMinute?: number;
    /** Cap on total open WebSocket sockets (handshaken or not); negotiate returns 503 at the cap. Default 5000. */
    maxConnections?: number;
    /** A connected client silent for longer than this (tracked across received messages, checked on the ping tick) is terminated. */
    clientTimeoutMs?: number;
  } = {},
): UpdatesHub {
  const path = opts.path ?? "/updates";
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 15_000;
  const maxPending = opts.maxPending ?? 10_000;
  const clientTimeoutMs = opts.clientTimeoutMs ?? 30_000;
  const maxConnections = opts.maxConnections ?? 5000;
  const pending = new Map<string, NodeJS.Timeout>();
  const sockets = new Set<WebSocket>();
  const lastSeen = new Map<WebSocket, number>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  const router = express.Router();
  const negotiateLimiter = rateLimit({
    windowMs: 60_000,
    limit: opts.negotiateRateLimitPerMinute ?? 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  router.post(`${path}/negotiate`, negotiateLimiter, (req, res) => {
    // Each negotiate is a one-shot request immediately followed by a WebSocket upgrade, so
    // there's nothing to gain from keeping this HTTP/1.1 connection alive — and doing so is
    // actively harmful: a client-side fetch keep-alive pool can hand out this exact socket
    // for a *later* negotiate after this server has been torn down (e.g. a test or deploy
    // restart reusing the same port), racing the socket's close against the pool's reuse and
    // failing with a generic "fetch failed". Telling the client not to pool it avoids that.
    res.setHeader("Connection", "close");
    if (wss.clients.size >= maxConnections) {
      res.status(503).json({ error: "too many connections" });
      return;
    }
    // Map iteration is insertion order, so the first key is the oldest outstanding token.
    while (pending.size >= maxPending) {
      const oldest = pending.keys().next().value as string;
      clearTimeout(pending.get(oldest));
      pending.delete(oldest);
    }
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
    // SignalR frames are record-separator (\x1e) delimited, but nothing guarantees a frame
    // arrives whole in a single WebSocket message (or that a message holds only one frame) —
    // buffer across messages and split on \x1e, keeping any trailing partial frame for next
    // time. Bounded by MAX_PAYLOAD_BYTES so a client that never sends a separator can't grow
    // this without limit.
    let buffer = "";

    const handshakeTimer = setTimeout(() => {
      if (!handshaken) ws.close(1002, "handshake timeout");
    }, handshakeTimeoutMs);
    handshakeTimer.unref();

    ws.on("message", (data) => {
      lastSeen.set(ws, Date.now());
      try {
        buffer += data.toString();
        if (Buffer.byteLength(buffer, "utf8") > MAX_PAYLOAD_BYTES) {
          buffer = "";
          ws.close(1009);
          return;
        }
        const parts = buffer.split(RS);
        buffer = parts.pop() ?? "";
        for (const frame of parts) {
          if (!frame) continue;
          let msg: unknown;
          try {
            msg = JSON.parse(frame);
          } catch {
            ws.close(1003);
            return;
          }
          // A well-formed SignalR frame is always a JSON object. Anything else (null, an
          // array, a number, a bare string) is a protocol error — and, left unchecked, a
          // property access below would throw and crash the process for every other client
          // too, since this listener runs uncaught on the event loop.
          if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
            ws.close(1003);
            return;
          }
          const m = msg as { protocol?: string; type?: number };
          if (!handshaken) {
            if (m.protocol !== "json") {
              ws.send(JSON.stringify({ error: `Requested protocol '${m.protocol}' is not available.` }) + RS);
              ws.close();
              return;
            }
            handshaken = true;
            clearTimeout(handshakeTimer);
            sockets.add(ws);
            lastSeen.set(ws, Date.now());
            ws.send("{}" + RS);
          } else if (m.type === 7) {
            ws.close();
          }
        }
      } catch {
        // Belt-and-suspenders: nothing above should throw once the object/null check is in
        // place, but an unauthenticated client must never be able to crash the hub, whatever
        // the cause. Treat it the same as any other malformed frame.
        ws.close(1003);
      }
    });
    ws.on("close", () => {
      clearTimeout(handshakeTimer);
      sockets.delete(ws);
      lastSeen.delete(ws);
    });
    ws.on("error", () => {
      clearTimeout(handshakeTimer);
      sockets.delete(ws);
      lastSeen.delete(ws);
    });
  }

  const pingTimer = setInterval(() => {
    const now = Date.now();
    for (const s of sockets) {
      const last = lastSeen.get(s) ?? now;
      if (now - last > clientTimeoutMs) {
        // Silent longer than clientTimeoutMs even counting our own pings' replies (the
        // official client pings back every 15s by default) — treat it as dead rather than
        // leaking the socket indefinitely.
        s.terminate();
        continue;
      }
      if (s.readyState === s.OPEN) s.send(JSON.stringify({ type: 6 }) + RS);
    }
  }, opts.pingMs ?? 15_000);
  pingTimer.unref();

  return {
    router,
    attach(server: Server) {
      server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(req.url ?? "", "http://localhost");
        if (url.pathname !== path) {
          // Not ours. Another listener (a different hub on the same server, a dev proxy,
          // etc.) may also be attached to this server's 'upgrade' event and want a crack at
          // it — only answer with a 404 (and only destroy the socket) when we're certain
          // nobody else will, i.e. we're the sole 'upgrade' listener.
          if (server.listenerCount("upgrade") === 1) {
            socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
            socket.destroy();
          }
          return;
        }
        const id = url.searchParams.get("id");
        if (!id || !pending.has(id)) {
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
      // wss.clients includes every upgraded socket, handshaken or not — terminating only
      // `sockets` (handshaken clients) would leave pre-handshake sockets dangling forever.
      for (const s of wss.clients) s.terminate();
      sockets.clear();
      lastSeen.clear();
      wss.close();
    },
  };
}
