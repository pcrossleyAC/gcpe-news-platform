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

/** Splits `keys` into chunks that each keep the serialised notification under the payload limit. */
function chunkKeys(target: UpdateTarget, keys: string[]): string[][] {
  if (keys.length === 0) return [[]];
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
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function listenForUpdates(
  pool: pg.Pool,
  onUpdate: (target: UpdateTarget, keys: string[]) => void,
  opts: ListenForUpdatesOptions = {},
): Promise<() => Promise<void>> {
  let client: pg.PoolClient | null = null;
  let stopped = false;
  let reconnecting = false;

  function onNotification(msg: pg.Notification): void {
    if (msg.channel !== UPDATES_CHANNEL || !msg.payload) return;
    const { target, keys } = JSON.parse(msg.payload) as { target: UpdateTarget; keys: string[] };
    onUpdate(target, keys);
  }

  // Releases a client we're done with (whether because we're stopping, or because we
  // reconnected while a stop() was already in flight). UNLISTEN best-effort: if the
  // connection is already broken, release(err) tells the pool to discard rather than
  // recycle the client, same as the error path below.
  async function cleanup(c: pg.PoolClient): Promise<void> {
    c.removeAllListeners();
    try {
      await c.query(`UNLISTEN ${UPDATES_CHANNEL}`);
      c.release();
    } catch (e) {
      c.release(e as Error);
    }
  }

  async function connect(): Promise<pg.PoolClient> {
    const c = await pool.connect();
    c.on("notification", onNotification);
    c.on("error", (e) => onBroken(c, e));
    c.on("end", () => onBroken(c, new Error("LISTEN connection ended")));
    await c.query(`LISTEN ${UPDATES_CHANNEL}`);
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
    void reconnectLoop();
  }

  client = await connect();

  return async () => {
    stopped = true;
    const c = client;
    client = null;
    if (c) await cleanup(c);
  };
}
