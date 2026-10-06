// Type-level test: compiled by `npm run check`. Apps that build their own drizzle instance
// with a schema (for relational queries) must be able to hand it to the events APIs.
import { describe, expect, it } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import { createDb, type Db, type DbOrTx, type Tx } from "@gcpe/db-kit";
import { createEventReceiver, dispatchOnce, enqueueEvent } from "./index";

const widgets = pgTable("widgets", { id: text("id").primaryKey() });
const schema = { widgets };

function acceptsAllEventApis(db: Db, tx: Tx) {
  void enqueueEvent(db, { type: "org.deactivated", source: "core", aggregateId: "org:x", data: { key: "x" } }, []);
  void enqueueEvent(tx, { type: "org.deactivated", source: "core", aggregateId: "org:x", data: { key: "x" } }, []);
  void dispatchOnce({ db, subscribers: [] });
  createEventReceiver({ db, secrets: {}, handlers: {} });
}

describe("Db typing", () => {
  it("accepts schema-typed and schemaless drizzle instances", async () => {
    const pool = new pg.Pool({ connectionString: "postgres://unused.invalid/none" });
    try {
      const typed = drizzle(pool, { schema });
      const created = createDb("postgres://unused.invalid/none");
      const plain = created.db;
      const all: Db[] = [typed, plain];
      const anyTx: DbOrTx = typed;
      // Never executed: the point is that these calls type-check.
      if (all.length < 0) {
        await typed.transaction(async (tx) => acceptsAllEventApis(typed, tx));
        await plain.transaction(async (tx) => acceptsAllEventApis(plain, tx));
        void enqueueEvent(anyTx, { type: "org.deactivated", source: "core", aggregateId: "org:x", data: { key: "x" } }, []);
        createEventReceiver({ db: typed, secrets: {}, handlers: { "org.deactivated": async (tx) => void (await tx.select().from(widgets)) } });
      }
      expect(all).toHaveLength(2);
      await created.pool.end();
    } finally {
      await pool.end();
    }
  });
});
