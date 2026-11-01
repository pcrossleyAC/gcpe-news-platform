import { mkdtemp, readFile, rm, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { groupErrors, installErrorCapture, type ErrorEntry } from "./errors";

describe("installErrorCapture", () => {
  let capture: ReturnType<typeof installErrorCapture> | undefined;

  afterEach(() => {
    capture?.close();
    capture = undefined;
  });

  it("records every console.error call as a timestamped entry", () => {
    capture = installErrorCapture();
    console.error("boom", 1);
    const entries = capture.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe("boom 1");
    expect(() => new Date(entries[0]!.timestamp).toISOString()).not.toThrow();
  });

  it("redacts query parameter values from database errors (they can hold password hashes and emails)", () => {
    capture = installErrorCapture();
    const dbError = new Error('Failed query: insert into "users" ("email", "password_hash") values ($1, $2)\nparams: pat@example.com,$argon2id$v=19$secret');
    console.error("[core] request failed", dbError);
    const message = capture.entries()[0]!.message;
    expect(message).toContain('Failed query: insert into "users"');
    expect(message).toContain("params: [redacted]");
    expect(message).not.toContain("pat@example.com");
    expect(message).not.toContain("argon2id");
  });

  // M8: a pg unique-violation (etc.) error carries the offending value in its own `detail`
  // property, which node:util's default Error inspection prints as its own line -- not covered
  // by the `params:` pattern above, since it's a different driver-generated field, and it shows
  // up whether or not the error is wrapped as a drizzle query error's `.cause`.
  it("redacts a pg error's detail field (it can hold the offending row's value, e.g. an email)", () => {
    capture = installErrorCapture();
    const pgError = new Error('duplicate key value violates unique constraint "users_email_idx"') as Error & { code: string; detail: string };
    pgError.code = "23505";
    pgError.detail = "Key (email)=(pat@example.com) already exists.";
    console.error("[core] request failed", pgError);
    const message = capture.entries()[0]!.message;
    expect(message).toContain('duplicate key value violates unique constraint "users_email_idx"');
    expect(message).toContain("detail: [redacted]");
    expect(message).not.toContain("pat@example.com");
  });

  it("redacts a pg error's detail field when it's nested inside a wrapping error's cause", () => {
    capture = installErrorCapture();
    const pgError = new Error('duplicate key value violates unique constraint "users_email_idx"') as Error & { code: string; detail: string };
    pgError.code = "23505";
    pgError.detail = "Key (email)=(pat@example.com) already exists.";
    const wrapper = new Error("Failed query: insert into users (...)", { cause: pgError });
    console.error("[core] request failed", wrapper);
    const message = capture.entries()[0]!.message;
    expect(message).toContain("detail: [redacted]");
    expect(message).not.toContain("pat@example.com");
  });

  it("still writes through to the original console.error (doesn't silence it)", () => {
    const original = console.error;
    let sawCall = false;
    capture = installErrorCapture();
    // Replace *after* installing, so our capture's `original` reference is this spy — proves
    // the capture forwards rather than swallowing.
    const spy = (...args: unknown[]) => {
      sawCall = true;
      original.apply(console, args);
    };
    capture.close();
    console.error = spy;
    capture = installErrorCapture();
    console.error("x");
    expect(sawCall).toBe(true);
    console.error = original;
  });

  it("keeps only the last `limit` entries", () => {
    capture = installErrorCapture(3);
    for (let i = 0; i < 5; i++) console.error(`e${i}`);
    expect(capture.entries().map((e) => e.message)).toEqual(["e2", "e3", "e4"]);
  });

  // Suite review fix round 1, M2: folded as they are captured, so one error repeating every minute
  // can't push every other one out of the kept log.
  it("folds a repeat of a message already kept into that entry: count, first and last time", () => {
    capture = installErrorCapture(1000);
    console.error("other");
    for (let i = 0; i < 1500; i++) console.error("feed down");
    const entries = capture.entries();
    expect(entries.map((e) => [e.message, e.count ?? 1])).toEqual([
      ["other", 1],
      ["feed down", 1500],
    ]);
    const feed = entries[1]!;
    expect(feed.firstAt! <= feed.timestamp).toBe(true);
  });

  it("a folded repeat moves to the newest end, so the ring trims the oldest distinct errors first", () => {
    capture = installErrorCapture(2);
    console.error("a");
    console.error("b");
    console.error("a");
    console.error("c");
    expect(capture.entries().map((e) => e.message)).toEqual(["a", "c"]);
    expect(capture.entries()[0]!.count).toBe(2);
  });

  it("close() restores the original console.error", () => {
    const original = console.error;
    capture = installErrorCapture();
    expect(console.error).not.toBe(original);
    capture.close();
    expect(console.error).toBe(original);
    capture = undefined;
  });

  describe("filePath (durable across a process restart)", () => {
    const made: string[] = [];
    afterEach(async () => {
      for (const d of made) await rm(d, { recursive: true, force: true });
      made.length = 0;
    });

    it("persists entries to the file, including pid and startedAt", async () => {
      const dir = await mkdtemp(join(tmpdir(), "gcpe-errlog-"));
      made.push(dir);
      const filePath = join(dir, "logs", "errors.jsonl");
      capture = installErrorCapture({ filePath, startedAt: "2026-01-01T00:00:00.000Z" });
      console.error("persisted boom");
      const raw = await readFile(filePath, "utf8");
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]!) as { message: string; pid: number; startedAt: string };
      expect(entry.message).toBe("persisted boom");
      expect(entry.pid).toBe(process.pid);
      expect(entry.startedAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("entries survive a simulated restart: a second install against the same file loads the first's entries", () => {
      const dirPromise = mkdtemp(join(tmpdir(), "gcpe-errlog-"));
      return dirPromise.then(async (dir) => {
        made.push(dir);
        const filePath = join(dir, "errors.jsonl");

        const first = installErrorCapture({ filePath, startedAt: "process-a" });
        console.error("before restart");
        first.close();

        // Simulated restart: a fresh install (as a new process would do) against the same file.
        capture = installErrorCapture({ filePath, startedAt: "process-b" });
        const afterRestart = capture.entries();
        expect(afterRestart.map((e) => e.message)).toEqual(["before restart"]);
        expect(afterRestart[0]!.startedAt).toBe("process-a");

        console.error("after restart");
        const combined = capture.entries();
        expect(combined.map((e) => e.message)).toEqual(["before restart", "after restart"]);
        expect(combined[1]!.startedAt).toBe("process-b");

        // And the file itself reflects both, across the simulated restart.
        const raw = await readFile(filePath, "utf8");
        const lines = raw.trim().split("\n");
        expect(lines).toHaveLength(2);
      });
    });

    it("a folded repeat survives a restart with its count, and an older file's repeated lines are folded on load", async () => {
      const dir = await mkdtemp(join(tmpdir(), "gcpe-errlog-"));
      made.push(dir);
      const filePath = join(dir, "errors.jsonl");
      // An older build's file: the same message on three plain lines.
      const old = (m: string, t: string) => JSON.stringify({ timestamp: t, message: m, pid: 1, startedAt: "s" });
      await writeFile(filePath, [old("x", "2026-10-01T00:00:00.000Z"), old("y", "2026-10-01T00:01:00.000Z"), old("x", "2026-10-01T00:02:00.000Z"), old("x", "2026-10-01T00:03:00.000Z")].join("\n") + "\n");
      const first = installErrorCapture({ filePath });
      expect(first.entries().map((e) => [e.message, e.count ?? 1, e.firstAt ?? e.timestamp])).toEqual([
        ["y", 1, "2026-10-01T00:01:00.000Z"],
        ["x", 3, "2026-10-01T00:00:00.000Z"],
      ]);
      console.error("x");
      first.close();
      capture = installErrorCapture({ filePath });
      expect(capture.entries().map((e) => [e.message, e.count ?? 1, e.firstAt])).toEqual([
        ["y", 1, undefined],
        ["x", 4, "2026-10-01T00:00:00.000Z"],
      ]);
    });

    it("the in-memory ring, and the persisted file, trim to the cap", () => {
      const dirPromise = mkdtemp(join(tmpdir(), "gcpe-errlog-"));
      return dirPromise.then(async (dir) => {
        made.push(dir);
        const filePath = join(dir, "errors.jsonl");
        capture = installErrorCapture({ filePath, limit: 5 });
        for (let i = 0; i < 20; i++) console.error(`e${i}`);
        expect(capture.entries().map((e) => e.message)).toEqual(["e15", "e16", "e17", "e18", "e19"]);

        const raw = await readFile(filePath, "utf8");
        const lines = raw.trim().split("\n").filter((l) => l.length > 0);
        // Bounded: never allowed to grow past ~1.5x the cap before being rewritten back down.
        expect(lines.length).toBeLessThanOrEqual(Math.ceil(5 * 1.5));
        const messages = lines.map((l) => (JSON.parse(l) as { message: string }).message);
        expect(messages[messages.length - 1]).toBe("e19");
      });
    });

    it("a startup load trims a file that already holds more than the cap", async () => {
      const dir = await mkdtemp(join(tmpdir(), "gcpe-errlog-"));
      made.push(dir);
      const filePath = join(dir, "errors.jsonl");
      const seed = installErrorCapture({ filePath, limit: 100 });
      for (let i = 0; i < 10; i++) console.error(`seed${i}`);
      seed.close();

      capture = installErrorCapture({ filePath, limit: 3 });
      expect(capture.entries().map((e) => e.message)).toEqual(["seed7", "seed8", "seed9"]);
      const raw = await readFile(filePath, "utf8");
      expect(raw.trim().split("\n")).toHaveLength(3);
    });

    it("a write failure (unwritable directory) doesn't throw, doesn't loop, and keeps capturing in memory", async () => {
      const dir = await mkdtemp(join(tmpdir(), "gcpe-errlog-"));
      made.push(dir);
      const lockedDir = join(dir, "locked");
      const filePath = join(lockedDir, "errors.jsonl");
      await (await import("node:fs/promises")).mkdir(lockedDir);
      await chmod(lockedDir, 0o500); // read+execute only: can't create the file inside it
      try {
        capture = installErrorCapture({ filePath });
        expect(() => console.error("should not throw")).not.toThrow();
        expect(capture.entries().map((e) => e.message)).toEqual(["should not throw"]);
      } finally {
        await chmod(lockedDir, 0o700);
      }
    });

    it("a missing or corrupt file falls back to no persisted entries, not a startup failure", async () => {
      const dir = await mkdtemp(join(tmpdir(), "gcpe-errlog-"));
      made.push(dir);
      const missing = installErrorCapture({ filePath: join(dir, "does-not-exist.jsonl") });
      expect(missing.entries()).toEqual([]);
      missing.close();

      const corruptPath = join(dir, "corrupt.jsonl");
      await (await import("node:fs/promises")).writeFile(corruptPath, "not json\n{also not json\n");
      const corrupt = installErrorCapture({ filePath: corruptPath });
      expect(corrupt.entries()).toEqual([]);
      corrupt.close();
    });
  });
});

// Suite review O2.3 (owner 2026-10-31): one outage repeating the same message must not push every
// other error out of the Error log's view.
describe("groupErrors", () => {
  const at = (minute: number, message: string, pid = 1): ErrorEntry => ({ timestamp: new Date(Date.UTC(2026, 9, 31, 10, minute)).toISOString(), message, pid, startedAt: "2026-10-31T00:00:00.000Z" });

  it("folds identical messages into one group with a count, first and last time, newest group first", () => {
    const entries = [at(0, "feed down"), at(1, "other"), at(5, "feed down", 2), at(10, "feed down", 3)];
    expect(groupErrors(entries)).toEqual([
      { message: "feed down", count: 3, firstAt: at(0, "").timestamp, lastAt: at(10, "").timestamp, pid: 3, startedAt: "2026-10-31T00:00:00.000Z" },
      { message: "other", count: 1, firstAt: at(1, "").timestamp, lastAt: at(1, "").timestamp, pid: 1, startedAt: "2026-10-31T00:00:00.000Z" },
    ]);
  });

  it("keeps messages that differ at all apart, and caps the number of groups", () => {
    const entries = [at(0, "a"), at(1, "a "), at(2, "b"), at(3, "c")];
    expect(groupErrors(entries).map((g) => g.message)).toEqual(["c", "b", "a ", "a"]);
    expect(groupErrors(entries, 2).map((g) => g.message)).toEqual(["c", "b"]);
  });

  it("is empty for no entries", () => {
    expect(groupErrors([])).toEqual([]);
  });
});
