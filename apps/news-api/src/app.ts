import express from "express";
import { sql } from "drizzle-orm";
import type { BearerOptions } from "@gcpe/auth";
import type { Db } from "@gcpe/db-kit";
import { createEventReceiver, type SubscriberConfig } from "@gcpe/events";
import { healthRoutes, jsonErrorHandler, type ReadinessCheck } from "@gcpe/http-kit";
import { problemNotFound, requireApiVersion } from "./http/errors";
import { categoryRoutes } from "./http/v1/categories";
import { postRoutes } from "./http/v1/posts";
import { siteRoutes } from "./http/v1/site";
import { subscribeRoutes, type SubscribeProxyOptions } from "./http/v1/subscribe";
import type { ChangesRouteOptions } from "./http/v2/changes";
import { v2Routes } from "./http/v2/routes";
import { createSourceRestrictedHandlers } from "./projections";
import type { RelatedService } from "./search/related";
import type { SimilarService } from "./search/similar";
import type { SearchService } from "./search/service";
import type { SlideImageFetcher } from "./slide-images";

export type { SubscribeProxyOptions };

export interface AppDeps {
  /** Reverse proxies in front of the app (TRUST_PROXY_HOPS); defaults to 1. */
  trustProxyHops?: number;
  db: Db;
  timeZone: string;
  eventSecrets: Record<string, string>;
  subscribers?: SubscriberConfig[];
  subscribe?: SubscribeProxyOptions;
  hubRouter?: express.Router;
  /** Extra /health/ready checks on top of the DB ping (e.g. the LISTEN connection being up). */
  readinessChecks?: ReadinessCheck[];
  /** `GET /api/v2/search`. Absent (most tests): that path answers v2's 404. */
  search?: SearchService;
  /** Per client IP on `/api/v2/search` (Q74). */
  searchRateLimit?: { perMinute: number; clientIpHeader?: string };
  /** `GET /api/v2/changes`. Absent (most tests): that path answers v2's 404. */
  changes?: ChangesRouteOptions;
  /** GET /api/v2/posts/{key}/related. Absent: v2's 404. */
  related?: RelatedService;
  /** POST /api/v2/internal/similar (addendum §7). Absent: v2's 404. */
  similar?: { service: SimilarService; bearer: BearerOptions | null };
  /** Fetches a slide's image bytes from its event's URL while projecting site.content.changed
   * (addendum §6.4). Absent: an old base64 envelope still works; a URL slide fails loudly. */
  slideImages?: SlideImageFetcher;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.trustProxyHops ?? 1); // hops: 1 = OpenShift router / SiteGround nginx / local IIS; TRUST_PROXY_HOPS=2 behind a DMZ proxy

  app.use(healthRoutes([() => deps.db.execute(sql`SELECT 1`), ...(deps.readinessChecks ?? [])]));

  app.use(
    createEventReceiver({
      db: deps.db,
      secrets: deps.eventSecrets,
      handlers: createSourceRestrictedHandlers({ subscribers: deps.subscribers, slideImages: deps.slideImages }),
    }),
  );
  if (deps.hubRouter) app.use(deps.hubRouter);

  app.use("/api/v2", v2Routes({ search: deps.search, searchRateLimit: deps.searchRateLimit, changes: deps.changes, related: deps.related, similar: deps.similar, db: deps.db, timeZone: deps.timeZone }));

  const api = express.Router();
  api.use((_req, res, next) => {
    res.set("Cache-Control", "no-cache");
    next();
  });
  api.use(requireApiVersion());
  api.use(subscribeRoutes(deps.subscribe));
  api.use(categoryRoutes(deps.db, deps.timeZone));
  api.use(siteRoutes(deps.db, deps.timeZone));
  api.use(postRoutes(deps.db, deps.timeZone));
  // No route matched (after the api-version check, so an unversioned unknown route still
  // gets the ApiVersionUnspecified 400 the live API gives): same 404 problem JSON as the
  // index-key lookups, never Express's HTML "Cannot GET".
  api.use((_req, res) => problemNotFound(res));
  app.use("/api", api);
  app.use((_req, res) => void res.status(404).json({ error: "not found" }));

  app.use(jsonErrorHandler({ logPrefix: "[news-api]" }));

  return app;
}
