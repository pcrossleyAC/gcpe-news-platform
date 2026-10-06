import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import express, { type RequestHandler, type Router } from "express";
import { generateContacts, toPublicContact, type FakeContact, type FakeEmail } from "./contacts";

/**
 * A fake Media Hub contacts service, shaped like `@gcpe/flickr-fake`: an in-memory (optionally
 * file-persisted) set of deterministic, made-up contacts behind the service contract (Global
 * Constraints, "Media Hub contract"), plus `/__fake` test controls. Mounted by the stack at
 * `/fake-media-hub`; never used in production.
 *
 * Unlike the fake Flickr, this package does not itself verify a bearer token — it has no
 * dependency on `@gcpe/auth` (or the stack), so its caller injects whatever check applies:
 * `opts.requireServiceAuth`. The stack supplies the same bearer verifier it uses everywhere else
 * plus a `MediaHub.ContactsRead` role check; a package test can inject a much simpler stand-in.
 * Every `/api/service/*` call 401s when no check was supplied at all, so forgetting to configure
 * one can never silently leave the fake open.
 */

export type { FakeContact, FakeEmail } from "./contacts";

export interface CreateFakeMediaHubOptions {
  /** How many contacts to generate (default 60). */
  contactCount?: number;
  /** Deterministic generation seed -- the same seed always produces the same contact set. */
  seed?: number;
  /**
   * Gates every `/api/service/*` route. The stack passes
   * `[requireBearer(<its bearer verifier>), requireRole("MediaHub.ContactsRead")]`; a package
   * test can pass a single simple header check. Omitting it fails every service call closed
   * (401) rather than leaving the fake unauthenticated by accident.
   */
  requireServiceAuth?: RequestHandler | RequestHandler[];
  /** Where to persist the generated/mutated contact set (JSON), so it survives a process
   * restart the same way fake Flickr's state does -- see that package for why. Omit (every
   * test but the stack's own) for in-memory-only behaviour. A missing/unreadable/corrupt file
   * is treated as "nothing persisted yet", never a startup failure. */
  statePath?: string;
}

export interface FakeMediaHubControls {
  /** Regenerates the contact set fresh from the original seed/contactCount. */
  reset(): void;
  /** Changes one email's address and bumps the contact's `updatedAt`. False if the contact or
   * ref doesn't exist. */
  changeEmail(id: number, ref: string, address: string): boolean;
  /** Removes one email and bumps `updatedAt`. False if the contact or ref doesn't exist. */
  removeEmail(id: number, ref: string): boolean;
  /** Soft-deletes a contact (sets `deletedAt`) and bumps `updatedAt`. False if unknown. */
  deleteContact(id: number): boolean;
  /** A snapshot of every contact, including the internal `updatedAt` the wire contract omits --
   * for test assertions. */
  contacts(): FakeContact[];
}

const DEFAULT_SEED = 42;
const DEFAULT_CONTACT_COUNT = 60;
/** Matches the contract's own page size for `changes` (Global Constraints). */
const CHANGES_PAGE_SIZE = 100;
/** The most a caller may ask `search` for in one page. */
const SEARCH_PAGE_SIZE_CAP = 100;

function denyAllServiceCalls(): RequestHandler {
  return (_req, res) => void res.status(401).json({ error: "media hub fake: no requireServiceAuth configured" });
}

function encodeCursor(c: { updatedAt: string; id: number }): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { updatedAt: string; id: number } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<{ updatedAt: string; id: number }>;
    if (typeof parsed.updatedAt !== "string" || typeof parsed.id !== "number") return null;
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    return null;
  }
}

/** Strictly after `cur` in (updatedAt, id) order. */
function isAfterCursor(c: FakeContact, cur: { updatedAt: string; id: number }): boolean {
  return c.updatedAt > cur.updatedAt || (c.updatedAt === cur.updatedAt && c.id > cur.id);
}

function isFakeEmail(e: unknown): e is FakeEmail {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as FakeEmail).ref === "string" &&
    typeof (e as FakeEmail).address === "string" &&
    ((e as FakeEmail).kind === "personal" || (e as FakeEmail).kind === "workplace") &&
    ((e as FakeEmail).organization === null || typeof (e as FakeEmail).organization === "string") &&
    typeof (e as FakeEmail).preferred === "boolean"
  );
}

function isFakeContact(c: unknown): c is FakeContact {
  const r = c as Partial<FakeContact>;
  return (
    typeof c === "object" &&
    c !== null &&
    typeof r.id === "number" &&
    typeof r.firstName === "string" &&
    typeof r.lastName === "string" &&
    (r.outlet === null || typeof r.outlet === "string") &&
    Array.isArray(r.emails) &&
    r.emails.every(isFakeEmail) &&
    (r.deletedAt === null || typeof r.deletedAt === "string") &&
    typeof r.updatedAt === "string"
  );
}

interface PersistedState {
  contacts: FakeContact[];
}

function loadPersisted(statePath: string): FakeContact[] | null {
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<PersistedState>;
    if (!Array.isArray(raw.contacts) || !raw.contacts.every(isFakeContact)) return null;
    return raw.contacts.map((c) => ({ ...c, emails: c.emails.map((e) => ({ ...e })) }));
  } catch {
    // No file yet, or unreadable/corrupt -- same as "nothing persisted".
    return null;
  }
}

export function createFakeMediaHub(opts: CreateFakeMediaHubOptions = {}): { router: Router; controls: FakeMediaHubControls } {
  const seed = opts.seed ?? DEFAULT_SEED;
  const contactCount = opts.contactCount ?? DEFAULT_CONTACT_COUNT;
  const authHandlers = opts.requireServiceAuth
    ? Array.isArray(opts.requireServiceAuth)
      ? opts.requireServiceAuth
      : [opts.requireServiceAuth]
    : [denyAllServiceCalls()];

  let contacts = new Map<number, FakeContact>();

  function seedFresh(): void {
    const now = new Date().toISOString();
    contacts = new Map(generateContacts({ count: contactCount, seed, now }).map((c) => [c.id, c]));
  }
  seedFresh();

  if (opts.statePath) {
    const persisted = loadPersisted(opts.statePath);
    if (persisted) contacts = new Map(persisted.map((c) => [c.id, c]));
  }

  /** Writes every contact to {@link CreateFakeMediaHubOptions.statePath} (a no-op when it
   * wasn't given); never throws past the caller -- a persistence failure must never break the
   * fake's own response, only leave it no more durable than before this feature existed. */
  function persist(): void {
    if (!opts.statePath) return;
    try {
      mkdirSync(dirname(opts.statePath), { recursive: true });
      writeFileSync(opts.statePath, JSON.stringify({ contacts: [...contacts.values()] }));
    } catch (e) {
      console.error(`[media-hub-fake] failed to persist state to ${opts.statePath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const router = express.Router();
  const json = express.json();

  // Service routes (the Media Hub contract NoD actually calls) -- gated by the injected
  // bearer+role check, never by the control routes' own auth below.
  router.use("/api/service", ...authHandlers);

  router.get("/api/service/contacts", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(SEARCH_PAGE_SIZE_CAP, Math.max(1, Number.parseInt(String(req.query.pageSize ?? "25"), 10) || 25));

    // A deleted contact can no longer be found or added by search -- `get` is the only way to
    // see one, for a sync that already knew its id (contract: "including soft-deleted").
    const matches = [...contacts.values()]
      .filter((c) => !c.deletedAt)
      .filter((c) => {
        if (!q) return true;
        const name = `${c.firstName} ${c.lastName}`.toLowerCase();
        return name.includes(q) || (c.outlet?.toLowerCase().includes(q) ?? false);
      })
      .sort((a, b) => a.id - b.id);

    const total = matches.length;
    const start = (page - 1) * pageSize;
    res.json({ contacts: matches.slice(start, start + pageSize).map(toPublicContact), page, pageSize, total });
  });

  router.get("/api/service/contacts/changes", (req, res) => {
    const since = typeof req.query.since === "string" ? req.query.since : "";
    if (!since) return void res.status(400).json({ error: "since is required" });
    const cursorParam = typeof req.query.cursor === "string" && req.query.cursor !== "" ? req.query.cursor : null;
    const cursor = cursorParam ? decodeCursor(cursorParam) : null;
    if (cursorParam && !cursor) return void res.status(400).json({ error: "invalid cursor" });

    let matches = [...contacts.values()]
      .filter((c) => c.updatedAt > since)
      .sort((a, b) => (a.updatedAt === b.updatedAt ? a.id - b.id : a.updatedAt < b.updatedAt ? -1 : 1));
    if (cursor) matches = matches.filter((c) => isAfterCursor(c, cursor));

    const page = matches.slice(0, CHANGES_PAGE_SIZE);
    const last = page[page.length - 1];
    const nextCursor = matches.length > CHANGES_PAGE_SIZE && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null;
    res.json({ contacts: page.map(toPublicContact), nextCursor });
  });

  router.get("/api/service/contacts/:id", (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const c = Number.isInteger(id) ? contacts.get(id) : undefined;
    if (!c) return void res.status(404).json({ error: "not found" });
    res.json(toPublicContact(c));
  });

  // Control routes, under /__fake -- the stack gates these itself (Core.Admin bearer), the same
  // way it gates fake Flickr's own /__fake routes, rather than this package checking anything.
  router.post("/__fake/contacts/:id/email", json, (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.ref !== "string" || typeof b.address !== "string") return void res.status(400).json({ error: "ref and address are required" });
    const c = Number.isInteger(id) ? contacts.get(id) : undefined;
    if (!c) return void res.status(404).json({ error: "contact not found" });
    const email = c.emails.find((e) => e.ref === b.ref);
    if (!email) return void res.status(404).json({ error: "email not found" });
    email.address = b.address;
    c.updatedAt = new Date().toISOString();
    persist();
    res.json(toPublicContact(c));
  });

  router.post("/__fake/contacts/:id/remove-email", json, (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.ref !== "string") return void res.status(400).json({ error: "ref is required" });
    const c = Number.isInteger(id) ? contacts.get(id) : undefined;
    if (!c) return void res.status(404).json({ error: "contact not found" });
    const before = c.emails.length;
    c.emails = c.emails.filter((e) => e.ref !== b.ref);
    if (c.emails.length === before) return void res.status(404).json({ error: "email not found" });
    c.updatedAt = new Date().toISOString();
    persist();
    res.json(toPublicContact(c));
  });

  router.post("/__fake/contacts/:id/delete", (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const c = Number.isInteger(id) ? contacts.get(id) : undefined;
    if (!c) return void res.status(404).json({ error: "contact not found" });
    const now = new Date().toISOString();
    c.deletedAt = now;
    c.updatedAt = now;
    persist();
    res.json(toPublicContact(c));
  });

  router.post("/__fake/reset", (_req, res) => {
    seedFresh();
    persist();
    res.json({ ok: true });
  });

  const controls: FakeMediaHubControls = {
    reset() {
      seedFresh();
      persist();
    },
    changeEmail(id, ref, address) {
      const c = contacts.get(id);
      const email = c?.emails.find((e) => e.ref === ref);
      if (!c || !email) return false;
      email.address = address;
      c.updatedAt = new Date().toISOString();
      persist();
      return true;
    },
    removeEmail(id, ref) {
      const c = contacts.get(id);
      if (!c) return false;
      const before = c.emails.length;
      c.emails = c.emails.filter((e) => e.ref !== ref);
      if (c.emails.length === before) return false;
      c.updatedAt = new Date().toISOString();
      persist();
      return true;
    },
    deleteContact(id) {
      const c = contacts.get(id);
      if (!c) return false;
      const now = new Date().toISOString();
      c.deletedAt = now;
      c.updatedAt = now;
      persist();
      return true;
    },
    contacts() {
      return [...contacts.values()].map((c) => ({ ...c, emails: c.emails.map((e) => ({ ...e })) }));
    },
  };

  return { router, controls };
}
