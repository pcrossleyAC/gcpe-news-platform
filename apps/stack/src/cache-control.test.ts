import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { noStoreByDefault } from "./cache-control";

describe("noStoreByDefault", () => {
  it("sets Cache-Control: no-store on a route that sets no header at all", async () => {
    const app = express();
    app.use(noStoreByDefault);
    app.get("/x", (_req, res) => void res.json({ ok: true }));
    const res = await request(app).get("/x");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("overrides a weaker Cache-Control the route set itself (e.g. no-cache)", async () => {
    const app = express();
    app.use(noStoreByDefault);
    app.get("/x", (_req, res) => {
      res.set("Cache-Control", "no-cache");
      res.json({ ok: true });
    });
    const res = await request(app).get("/x");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("leaves an already-set no-store header alone", async () => {
    const app = express();
    app.use(noStoreByDefault);
    app.get("/x", (_req, res) => {
      res.set("Cache-Control", "no-store, must-revalidate");
      res.json({ ok: true });
    });
    const res = await request(app).get("/x");
    expect(res.headers["cache-control"]).toBe("no-store, must-revalidate");
  });

  it("does not run on a route mounted before it (e.g. static files kept out of its reach)", async () => {
    const app = express();
    app.get("/early", (_req, res) => {
      res.set("Cache-Control", "public, max-age=60");
      res.end("file");
    });
    app.use(noStoreByDefault);
    const res = await request(app).get("/early");
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
  });
});
