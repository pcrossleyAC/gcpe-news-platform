import express from "express";
import { rateLimit } from "express-rate-limit";
import { NEWS_API_SIMILAR_ROLE, requireAnyRole, requireBearer, type BearerOptions } from "@gcpe/auth";
import type { Db } from "@gcpe/db-kit";
import { categoryKindSchema } from "@gcpe/events";
import { toPostDto } from "../../dto";
import { latestPerCategory, MAX_LATEST_PER_CATEGORY } from "../../posts";
import { clientIpKey } from "../client-ip";
import { changesRoutes, type ChangesRouteOptions } from "./changes";
import { parseSearchQuery } from "../../search/query";
import { getGovernmentTerms, getSiteSettings, listMinistryProfiles, listSlidesV2, ministrySuccessors } from "../../read";
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
  /** Formats v1-shaped post DTOs (GET /api/v2/categories/{kind}/latest). Default: UTC. */
  timeZone?: string;
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
    // Each inactive ministry's final active successor (public; new-government spec §4): what the
    // public site writes to legacy/ministry-successors.json for the stack's 301s.
    r.get("/ministry-successors", async (_req, res) => void res.json({ successors: await ministrySuccessors(db) }));
    // A category index page's data in one call (P4-R11): every active category of a kind, in v1's
    // order, with its top and feature posts and its newest `count` (1–3) posts, the posts exactly
    // as v1's /api/Posts and /api/Posts/Latest answer them. Public, like those.
    r.get("/categories/:kind/latest", async (req, res) => {
      const kind = categoryKindSchema.safeParse(req.params.kind.toLowerCase());
      if (!kind.success) return void res.status(404).json({ error: "not found" });
      const raw = typeof req.query.count === "string" ? req.query.count : "";
      const count = /^\d$/.test(raw) ? Number(raw) : 0;
      if (count < 1 || count > MAX_LATEST_PER_CATEGORY) {
        return void res.status(400).json({ error: { code: "InvalidParameter", parameter: "count", message: `count must be an integer from 1 to ${MAX_LATEST_PER_CATEGORY}` } });
      }
      const tz = deps.timeZone ?? "UTC";
      const groups = await latestPerCategory(db, kind.data, count);
      res.json({
        categories: groups.map((g) => ({
          key: g.category.key,
          name: g.category.name,
          topPost: g.topPost && toPostDto(g.topPost, tz),
          featurePost: g.featurePost && toPostDto(g.featurePost, tz),
          latest: g.latest.map((p) => toPostDto(p, tz)),
        })),
      });
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
