import express from "express";
import { rateLimit } from "express-rate-limit";
import { NEWS_API_SIMILAR_ROLE, requireAnyRole, requireBearer, type BearerOptions } from "@gcpe/auth";
import type { Db } from "@gcpe/db-kit";
import { clientIpKey } from "../client-ip";
import { changesRoutes, type ChangesRouteOptions } from "./changes";
import { parseSearchQuery } from "../../search/query";
import { getGovernmentTerms, getSiteSettings, listMinistryProfiles, listSlidesV2 } from "../../read";
import { RELATED_MAX_KEY_CHARS, type RelatedService } from "../../search/related";
import { similarRequestSchema, type SimilarService } from "../../search/similar";
import type { SearchService } from "../../search/service";

/**
 * `/api/v2` (spec §5.4). Mounted before v1's `/api` router, so v1's api-version rule and its
 * problem-JSON 404 never apply here. Every response is `no-store`. Errors go to the app's
 * jsonErrorHandler, which logs the method, the path (never the query string) and a safe label.
 */
export function v2Routes(deps: {
  search?: SearchService;
  /** Per client IP on /search (Q74). Absent: no limit (tests). */
  searchRateLimit?: { perMinute: number; clientIpHeader?: string };
  changes?: ChangesRouteOptions;
  related?: RelatedService;
  /** POST /internal/similar (addendum §7): NRMS's service token only; bearer null → 503. */
  similar?: { service: SimilarService; bearer: BearerOptions | null };
  /** GET /api/v2/slides (addendum §6.4; public, no bearer needed). Absent (some tests): that
   * path answers v2's 404. */
  db?: Db;
}): express.Router {
  const r = express.Router();
  r.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  const { search, db } = deps;
  if (db) {
    r.get("/slides", async (_req, res) => void res.json({ slides: await listSlidesV2(db) }));
    r.get("/ministries", async (_req, res) => void res.json({ ministries: await listMinistryProfiles(db) }));
    // The live site settings (public; 404 until NRMS has published a revision).
    r.get("/site-settings", async (_req, res) => {
      const stored = await getSiteSettings(db);
      if (!stored) return void res.status(404).json({ error: "not found" });
      res.json(stored);
    });
    // The government-terms snapshot (public; 404 until NRMS has published one).
    r.get("/government-terms", async (_req, res) => {
      const stored = await getGovernmentTerms(db);
      if (!stored) return void res.status(404).json({ error: "not found" });
      res.json(stored);
    });
  }
  if (search) {
    const limiter = deps.searchRateLimit
      ? [
          rateLimit({
            windowMs: 60_000,
            limit: deps.searchRateLimit.perMinute,
            standardHeaders: "draft-8",
            legacyHeaders: false,
            keyGenerator: clientIpKey(deps.searchRateLimit.clientIpHeader),
            handler: (_req, res) => void res.status(429).json({ error: "too many requests" }),
          }),
        ]
      : [];
    r.get("/search", ...limiter, async (req, res) => {
      const parsed = parseSearchQuery(req.query as Record<string, unknown>, search.timeZone);
      if (!parsed.ok) {
        return void res.status(400).json({ error: { code: "InvalidParameter", parameter: parsed.parameter, message: parsed.message } });
      }
      // The seam for 6b's semantic branch: an aborted request's signal reaches the guarded
      // embedder, which treats a caller abort as neutral to its circuit breaker.
      const controller = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.on("close", onClose);
      try {
        res.json(await search.search(parsed.query, controller.signal));
      } finally {
        req.off("close", onClose);
      }
    });
  }
  if (deps.changes) r.use(changesRoutes(deps.changes));
  const { related } = deps;
  if (related) {
    r.get("/posts/:key/related", async (req, res) => {
      const key = req.params.key;
      // No stored key is this long or holds a NUL, and Postgres refuses NUL in text: answer
      // without a query.
      if (key.length > RELATED_MAX_KEY_CHARS || key.includes("\u0000")) return void res.status(404).json({ error: "not found" });
      const result = await related.related(key);
      if (!result) return void res.status(404).json({ error: "not found" });
      res.json(result);
    });
  }
  if (deps.similar) {
    const { service, bearer } = deps.similar;
    if (!bearer) {
      r.post("/internal/similar", (_req, res) => void res.status(503).json({ error: "similar not configured" }));
    } else {
      // Authenticated before the body is parsed. The body is draft text: a validation error names
      // the parameter only, and the app's error handler logs the path and a safe label, never it.
      r.post("/internal/similar", requireBearer(bearer), requireAnyRole(NEWS_API_SIMILAR_ROLE), express.json({ limit: "64kb" }), async (req, res) => {
        const parsed = similarRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          return void res.status(400).json({ error: { code: "InvalidParameter", parameter: String(parsed.error.issues[0]?.path[0] ?? "body") } });
        }
        const controller = new AbortController();
        const onClose = () => {
          if (!res.writableEnded) controller.abort();
        };
        req.on("close", onClose);
        try {
          res.json(await service.similar(parsed.data, controller.signal));
        } finally {
          req.off("close", onClose);
        }
      });
    }
  }
  r.use((_req, res) => void res.status(404).json({ error: "not found" }));
  // A path segment that isn't valid percent-encoding: Express raises a URIError with status 400
  // before any v2 handler runs. Answered here, without the app's error log, so a scanner can't
  // fill /stack/errors with it.
  const decodeErrors: express.ErrorRequestHandler = (err, _req, res, next) =>
    err instanceof URIError ? void res.status(400).json({ error: "bad request" }) : next(err);
  r.use(decodeErrors);
  return r;
}
