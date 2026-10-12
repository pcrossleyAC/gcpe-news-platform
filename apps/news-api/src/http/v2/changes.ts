import express from "express";
import { NEWS_API_CHANGES_ROLE, requireAnyRole, requireBearer, type BearerOptions } from "@gcpe/auth";
import type { Db } from "@gcpe/db-kit";
import { CHANGES_DEFAULT_LIMIT, CHANGES_MAX_LIMIT, readChanges } from "../../changes";
import { formatOffsetDateTime } from "../../time";

export interface ChangesRouteOptions {
  db: Db;
  timeZone: string;
  /** null: no token can be verified here, so the feed answers 503. */
  bearer: BearerOptions | null;
}

export type ParsedChangesQuery = { ok: true; after: number; limit: number } | { ok: false; parameter: string; message: string };

export function parseChangesQuery(raw: Record<string, unknown>): ParsedChangesQuery {
  for (const name of ["after", "limit"]) {
    if (raw[name] !== undefined && typeof raw[name] !== "string") return { ok: false, parameter: name, message: `${name} must be given once` };
  }
  const after = raw.after as string | undefined;
  const limit = raw.limit as string | undefined;
  if (after !== undefined && !/^\d{1,15}$/.test(after)) return { ok: false, parameter: "after", message: "after must be a change id (a whole number)" };
  if (limit !== undefined && !(/^\d{1,3}$/.test(limit) && Number(limit) >= 1 && Number(limit) <= CHANGES_MAX_LIMIT)) {
    return { ok: false, parameter: "limit", message: `limit must be a whole number from 1 to ${CHANGES_MAX_LIMIT}` };
  }
  return { ok: true, after: after === undefined ? 0 : Number(after), limit: limit === undefined ? CHANGES_DEFAULT_LIMIT : Number(limit) };
}

/** `GET /changes` (spec §5.4): for the site builder's service token, or an operator's Core.Admin token. */
export function changesRoutes(o: ChangesRouteOptions): express.Router {
  const r = express.Router();
  if (!o.bearer) {
    r.get("/changes", (_req, res) => void res.status(503).json({ error: "changes feed not configured" }));
    return r;
  }
  r.get("/changes", requireBearer(o.bearer), requireAnyRole(NEWS_API_CHANGES_ROLE, "Core.Admin"), async (req, res) => {
    const parsed = parseChangesQuery(req.query as Record<string, unknown>);
    if (!parsed.ok) {
      return void res.status(400).json({ error: { code: "InvalidParameter", parameter: parsed.parameter, message: parsed.message } });
    }
    const page = await readChanges(o.db, parsed.after, parsed.limit);
    if (page.resync) return void res.status(410).json({ resync: true, next: page.next });
    res.json({
      changes: page.changes.map((c) => ({ id: c.id, kind: c.kind, key: c.key, at: formatOffsetDateTime(c.at, o.timeZone) })),
      next: page.next,
    });
  });
  return r;
}
