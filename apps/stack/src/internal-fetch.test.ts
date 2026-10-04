import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INTERNAL_ORIGIN, installInternalFetch } from "./internal-fetch";

function demoApp() {
  const app = express();
  app.post("/echo", express.text({ type: "*/*" }), (req, res) => {
    res.set("x-seen-content-type", String(req.headers["content-type"]));
    res.status(201).json({ body: req.body, query: req.query, ip: req.ip, host: req.headers.host });
  });
  app.get("/empty", (_req, res) => void res.status(204).end());
  app.get("/slow", (_req, res) => void setTimeout(() => res.send("late"), 200));
  return app;
}

describe("installInternalFetch", () => {
  let uninstall: (() => void) | undefined;
  const realFetch = globalThis.fetch;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    globalThis.fetch = realFetch;
  });

  it("routes http://stack.internal requests into the app in-process (method, path, query, body, headers, status)", async () => {
    const app = demoApp();
    uninstall = installInternalFetch(() => app);
    const res = await fetch(`${INTERNAL_ORIGIN}/echo?x=1`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-seen-content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ body: '{"a":1}', query: { x: "1" }, ip: "127.0.0.1", host: "stack.internal" });
  });

  it("returns a null body for 204", async () => {
    const app = demoApp();
    uninstall = installInternalFetch(() => app);
    const res = await fetch(`${INTERNAL_ORIGIN}/empty`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("passes every other URL to the original fetch untouched", async () => {
    const original = vi.fn(async () => new Response("from network"));
    globalThis.fetch = original as unknown as typeof fetch;
    uninstall = installInternalFetch(() => demoApp());
    const res = await fetch("https://example.test/x", { method: "GET" });
    expect(await res.text()).toBe("from network");
    expect(original).toHaveBeenCalledTimes(1);
    // A look-alike host must not be treated as internal.
    await fetch("http://stack.internal.example.test/x");
    expect(original).toHaveBeenCalledTimes(2);
  });

  it("honours an abort signal", async () => {
    const app = demoApp();
    uninstall = installInternalFetch(() => app);
    await expect(fetch(`${INTERNAL_ORIGIN}/slow`, { signal: AbortSignal.timeout(20) })).rejects.toThrow();
  });

  it("fails clearly before the app exists, and uninstall restores the original fetch", async () => {
    const before = globalThis.fetch;
    uninstall = installInternalFetch(() => undefined);
    await expect(fetch(`${INTERNAL_ORIGIN}/echo`)).rejects.toThrow(/not ready/);
    uninstall();
    uninstall = undefined;
    expect(globalThis.fetch).toBe(before);
  });
});
