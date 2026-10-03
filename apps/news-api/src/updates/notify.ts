import { sql } from "drizzle-orm";
import type pg from "pg";
import type { DbOrTx } from "@gcpe/db-kit";

export type UpdateTarget =
  | "PostUpdate"
  | "MinisterUpdate"
  | "HomeUpdate"
  | "SlideUpdate"
  | "ResourceLinkUpdate"
  | "ThemeUpdate"
  | "TagUpdate"
  | "SectorUpdate"
  | "MinistryUpdate";

export const UPDATES_CHANNEL = "news_api_updates";

/**
 * Postgres rejects a NOTIFY payload over 8000 bytes. Keep comfortably under that so the
 * JSON envelope (target + quoting/escaping overhead) never trips the server-side limit.
 */
const MAX_PAYLOAD_BYTES = 7500;

function payloadBytes(target: UpdateTarget, keys: string[]): number {
  return Buffer.byteLength(JSON.stringify({ target, keys }), "utf8");
}

/**
 * Splits `keys` into chunks that each keep the serialised notification under the payload
 * limit. Checks every key up front, before sending anything, and throws if a single key's
 * own payload can never fit — chunking can't help there, and sending it anyway would mean
 * an oversized NOTIFY that Postgres rejects, after any earlier chunks already went out.
 */
function chunkKeys(target: UpdateTarget, keys: string[]): string[][] {
  if (keys.length === 0) return [[]];
  for (const key of keys) {
    if (payloadBytes(target, [key]) > MAX_PAYLOAD_BYTES) {
      throw new Error(`notify payload for one key exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }
  }
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const key of keys) {
    const candidate = [...current, key];
    if (current.length > 0 && payloadBytes(target, candidate) > MAX_PAYLOAD_BYTES) {
      chunks.push(current);
      current = [key];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function notifyUpdate(tx: DbOrTx, target: UpdateTarget, keys: string[]): Promise<void> {
  for (const chunk of chunkKeys(target, keys)) {
    await tx.execute(sql`SELECT pg_notify(${UPDATES_CHANNEL}, ${JSON.stringify({ target, keys: chunk })})`);
  }
}

export interface ListenForUpdatesOptions {
  /** Called after a dropped LISTEN connection has been re-established and is listening again. */
  onReconnect?: () => void;
}

const INITIAL_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 5000;

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A pending backoff timer would otherwise keep the event loop alive, delaying process
    // exit for up to MAX_BACKOFF_MS after everything else is done.
    timer.unref();
  });
}

export async function listenForUpdates(
  pool: pg.Pool,
  onUpdate: (target: UpdateTarget, keys: string[]) => void,
  opts: ListenForUpdatesOptions = {},
): Promise<() => Promise<void>> {
  let client: pg.PoolClient | null = null;
  let stopped = false;
  let reconnecting = false;
  // Tracks the currently in-flight reconnect attempt (if any), so stop() can wait for it to
  // fully settle — and release whatever client it ends up with — before resolving.
  let reconnectPromise: Promise<void> | null = null;

  function onNotification(msg: pg.Notification): void {
    if (msg.channel !== UPDATES_CHANNEL || !msg.payload) return;
    const { target, keys } = JSON.parse(msg.payload) as { target: UpdateTarget; keys: string[] };
    onUpdate(target, keys);
  }

  // Releases a client we're done with (whether because we're stopping, or because we
  // reconnected while a stop() was already in flight). This dedicated LISTEN connection
  // isn't meant to be recycled for ad-hoc queries elsewhere, so it's always discarded
  // outright rather than returned to the pool as idle: release(true) forces removal on the
  // happy path, the same as release(err) does when UNLISTEN itself fails on an
  // already-broken connection.
  async function cleanup(c: pg.PoolClient): Promise<void> {
    c.removeAllListeners();
    try {
      await c.query(`UNLISTEN ${UPDATES_CHANNEL}`);
      c.release(true);
    } catch (e) {
      c.release(e as Error);
    }
  }

  async function connect(): Promise<pg.PoolClient> {
    const c = await pool.connect();
    c.on("notification", onNotification);
    c.on("error", (e) => onBroken(c, e));
    c.on("end", () => onBroken(c, new Error("LISTEN connection ended")));
    try {
      await c.query(`LISTEN ${UPDATES_CHANNEL}`);
    } catch (e) {
      // LISTEN itself failed on an otherwise freshly-checked-out client. Nobody else has a
      // reference to it, so if we don't release it here it's checked out forever as far as
      // the pool is concerned — a leak on every failed (re)connect attempt.
      c.removeAllListeners();
      c.release(e as Error);
      throw e;
    }
    return c;
  }

  async function reconnectLoop(): Promise<void> {
    let delay = INITIAL_BACKOFF_MS;
    while (!stopped) {
      try {
        const c = await connect();
        if (stopped) {
          await cleanup(c);
          return;
        }
        client = c;
        reconnecting = false;
        opts.onReconnect?.();
        return;
      } catch (e) {
        if (stopped) return;
        console.error("[news-api] LISTEN reconnect failed, retrying", e);
        await sleep(delay);
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      }
    }
  }

  function onBroken(broken: pg.PoolClient, err: Error): void {
    if (stopped || reconnecting || broken !== client) return;
    reconnecting = true;
    client = null;
    broken.removeAllListeners();
    broken.release(err);
    reconnectPromise = reconnectLoop();
  }

  client = await connect();

  return async () => {
    stopped = true;
    // Wait for any reconnect already in flight to settle — it may be about to acquire (or
    // may have just acquired) a client that nothing else knows about yet, and we need that
    // client released before we can truthfully say we're done.
    if (reconnectPromise) await reconnectPromise;
    const c = client;
    client = null;
    if (c) await cleanup(c);
  };
}
