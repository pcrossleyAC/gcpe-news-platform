import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { noStoreByDefault, noStoreOnRedirect } from "./cache-control";

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

// Fix round 1, P2-R30 M4.
describe("noStoreOnRedirect", () => {
  it("forces Cache-Control: no-store on a 301, overriding whatever the route set (or didn't set)", async () => {
    const app = express();
    app.use(noStoreOnRedirect);
    app.get("/x", (_req, res) => res.redirect(301, "/x/"));
    const res = await request(app).get("/x").redirects(0);
    expect(res.status).toBe(301);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("leaves a 200 response's own Cache-Control alone", async () => {
    const app = express();
    app.use(noStoreOnRedirect);
    app.get("/x", (_req, res) => {
      res.set("Cache-Control", "public, max-age=60");
      res.end("file");
    });
    const res = await request(app).get("/x");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("a directory request without a trailing slash through a real express.static mount gets no-store on its 301", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stack-cache-control-test-"));
    try {
      await fs.mkdir(path.join(dir, "sub"));
      await fs.writeFile(path.join(dir, "sub", "index.html"), "<p>hi</p>");
      const app = express();
      app.use("/site", noStoreOnRedirect, express.static(dir, { index: "index.html", maxAge: 60_000 }));
      const res = await request(app).get("/site/sub").redirects(0);
      expect(res.status).toBe(301);
      expect(res.headers["cache-control"]).toBe("no-store");

      const fileRes = await request(app).get("/site/sub/");
      expect(fileRes.status).toBe(200);
      expect(fileRes.headers["cache-control"]).toBe("public, max-age=60");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
