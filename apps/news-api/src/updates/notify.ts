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

export async function notifyUpdate(tx: DbOrTx, target: UpdateTarget, keys: string[]): Promise<void> {
  await tx.execute(sql`SELECT pg_notify(${UPDATES_CHANNEL}, ${JSON.stringify({ target, keys })})`);
}

export async function listenForUpdates(
  pool: pg.Pool,
  onUpdate: (target: UpdateTarget, keys: string[]) => void,
): Promise<() => Promise<void>> {
  const client = await pool.connect();
  client.on("notification", (msg) => {
    if (msg.channel !== UPDATES_CHANNEL || !msg.payload) return;
    const { target, keys } = JSON.parse(msg.payload) as { target: UpdateTarget; keys: string[] };
    onUpdate(target, keys);
  });
  client.on("error", (e) => console.error("[news-api] LISTEN connection error", e));
  await client.query(`LISTEN ${UPDATES_CHANNEL}`);
  return async () => {
    await client.query(`UNLISTEN ${UPDATES_CHANNEL}`);
    client.release();
  };
}
