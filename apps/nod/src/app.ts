import express, { type Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { requireBearer, type BearerOptions } from "@gcpe/auth";
import { createEventReceiver } from "@gcpe/events";
import { healthRoutes, jsonErrorHandler } from "@gcpe/http-kit";
import { createItemSending } from "./as-it-happens";
import { bounceHandler } from "./bounces";
import type { DistributionClient } from "./distribution-client";
import { apiRoutes, bouncesInboxRoutes } from "./http/routes";
import { membershipRoutes, type MembershipAuth } from "./http/membership";
import { subscribeApiRoutes } from "./http/subscribe-routes";
import { itemHandlers } from "./items";
import { listsHandler } from "./lists";
import type { MediaHubClient } from "./media-hub/client";
import { createMediaSend } from "./media-send";
import type { RenderOptions } from "./render";
import type { JourneyDeps } from "./subscribe/journeys";

export interface AppDeps {
  db: Db;
  auth: BearerOptions;
  loginRouter?: Router | null;
  eventSecrets: Record<string, string>;
  /** Site URL (also used as `items`' own publicSiteUrl) and optional banner for every
   * As-It-Happens/emergency email this sends (Task 5). */
  render: RenderOptions;
  /** Phase 4a: the legacy public Subscribe API, mounted at /api/Subscribe when set. */
  subscribe?: JourneyDeps;
  /** The settings and distribution/* routes' own Distribution client, resolved NOD_OPS_EMAIL
   * and tenant time zone -- `getSettings`/`setPaused` back the distribution/* routes, `send`
   * the ops email both that and NoD's own pause/resume send. Defaults to a client that
   * rejects every call (`noDistribution`) when omitted; start.ts always passes the one real
   * Distribution client here. `opsEmail` defaults to null (no ops email sent) and `timeZone`
   * to "UTC" -- both only matter when an actual pause/resume fires an email, which a null
   * `opsEmail` already rules out. */
  distribution?: Pick<DistributionClient, "send" | "getSettings" | "setPaused" | "uploadBounce" | "bounceSource" | "dailyReport">;
  opsEmail?: string | null;
  timeZone?: string;
  /** NOD_BOUNCE_SUMMARY_EMAIL; null = none. */
  bounceSummaryFallback?: string | null;
  /** The Media Hub contacts client, when `MEDIA_HUB_URL` is configured -- null (the default)
   * means search and add-from-hub answer 503 while manual entry still works. */
  mediaHub?: MediaHubClient | null;
  /** Legacy `Subscribe/SubscriberInformation` (C55) Basic Auth credentials -- null (the
   * default) means the route always answers 503 instead of ever comparing credentials. */
  membership?: MembershipAuth | null;
  /** NoD's own appId, as Distribution records it for a message NoD sent (bounces.ts) --
   * defaults to "nod", the subject/azp every local (non-Entra) Distribution token carries
   * (distribution-token.ts). start.ts always passes the real configured value. */
  distributionAppId?: string;
  /** EMERGENCY_FEED_URL, for Operations. */
  emergencyFeedUrl?: string | null;
}

const noDistribution: Pick<DistributionClient, "send" | "getSettings" | "setPaused" | "uploadBounce" | "bounceSource" | "dailyReport"> = {
  send: () => Promise.reject(new Error("createApp: no Distribution client configured for the settings routes")),
  getSettings: () => Promise.reject(new Error("createApp: no Distribution client configured for the distribution routes")),
  setPaused: () => Promise.reject(new Error("createApp: no Distribution client configured for the distribution routes")),
  uploadBounce: () => Promise.reject(new Error("createApp: no Distribution client configured for the bounces/inbox route")),
  bounceSource: () => Promise.reject(new Error("createApp: no Distribution client configured for the operations route")),
  dailyReport: () => Promise.reject(new Error("createApp: no Distribution client configured for the reports")),
};

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one hop: OpenShift router / SiteGround nginx
  app.use(healthRoutes([() => deps.db.execute(sql`SELECT 1`)]));

  // Mounted at the app root, ahead of everything else -- Basic Auth (C55), never
  // `requireBearer` (that's only ever applied under "/api" below), and ahead of any future
  // catch-all this app might grow.
  app.use(membershipRoutes(deps.db, deps.membership ?? null));

  // Mounted before any body parser: signatures cover the raw bytes (see
  // packages/events/src/receiver.ts), so an upstream express.json()/raw() that already
  // consumed the body would make every event fail verification.
  const { createItemSend, recordEmergencyItem } = createItemSending({ render: deps.render });
  const resolveItemHandler = itemHandlers({
    publicSiteUrl: deps.render.siteUrl,
    // Media sends are created before As-It-Happens, in the same transaction, so a media-list
    // member who also matches the release publicly is already excluded from the As-It-Happens
    // insert's NOT EXISTS check by the time it runs (global constraints: "one copy per person
    // per release").
    onPublished: async (tx, r) => {
      await createMediaSend(tx, r.key, deps.render);
      await createItemSend(tx, r.key, "as_it_happens");
    },
  });
  const resolveBounceHandler = bounceHandler({ appId: deps.distributionAppId ?? "nod" });
  app.use(
    createEventReceiver({
      db: deps.db,
      secrets: deps.eventSecrets,
      handlers: (ev) => resolveItemHandler(ev) ?? listsHandler(ev) ?? resolveBounceHandler(ev),
    }),
  );

  if (deps.loginRouter) app.use(deps.loginRouter);
  if (deps.subscribe) app.use("/api/Subscribe", requireBearer(deps.auth), express.json({ limit: "100kb" }), subscribeApiRoutes(deps.subscribe));
  // Its own mount, ahead of the shared "/api" one below: a raw bounce report can be close to
  // Distribution's own 1 MB limit (Global Constraints "Bounce source"), well over every other
  // /api route's shared 100kb express.json limit.
  app.use(
    "/api/bounces/inbox",
    requireBearer(deps.auth),
    express.json({ limit: "2mb" }),
    bouncesInboxRoutes(deps.distribution ?? noDistribution),
  );
  // Authenticate before parsing so anonymous callers cannot make us buffer and parse bodies.
  app.use(
    "/api",
    requireBearer(deps.auth),
    express.json({ limit: "100kb" }),
    apiRoutes(
      deps.db,
      { recordEmergencyItem },
      {
        // The distribution/* routes need getSettings/setPaused too, which `subscribe`'s own
        // (send-only) client never carries -- unlike before, this no longer falls back to
        // it, only to `noDistribution`.
        distribution: deps.distribution ?? noDistribution,
        opsEmail: deps.opsEmail ?? null,
        timeZone: deps.timeZone ?? "UTC",
        bounceSummaryFallback: deps.bounceSummaryFallback ?? null,
        nodAppId: deps.distributionAppId ?? "nod",
        emergencyFeedUrl: deps.emergencyFeedUrl ?? null,
      },
      deps.mediaHub ?? null,
    ),
  );
  // Body-parser failures (malformed JSON 400, oversized 413) and anything a route lets
  // escape stay JSON instead of finalhandler's default HTML.
  app.use(jsonErrorHandler({ logPrefix: "[nod]" }));
  return app;
}
