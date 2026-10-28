import { tmpdir } from "node:os";
import express, { type Router } from "express";
import { sql } from "drizzle-orm";
import type { Db, TestClock } from "@gcpe/db-kit";
import { requireBearer, type BearerOptions } from "@gcpe/auth";
import { createEventReceiver, MAX_EVENT_BYTES, type SubscriberConfig } from "@gcpe/events";
import { healthRoutes, jsonErrorHandler } from "@gcpe/http-kit";
import type { DistributionClient } from "./clients";
import { localStore, type ObjectStore } from "@gcpe/storage";
import type { SiteSettings } from "@gcpe/site-settings";
import type { FlickrClient } from "./media/flickr-client";
import type { EmbedDeps } from "./media/embeds";
import { mediaRoutes } from "./http/media-routes";
import { apiRoutes } from "./http/routes";
import { governmentTermRoutes } from "./http/government-term-routes";
import { siteRoutes } from "./http/site-routes";
import { calendarHandler } from "./calendar/projection";
import type { WorkflowDeps } from "./releases/workflow";
import type { SimilarDeps } from "./releases/similar";
import type { SlideImageFiles } from "./website/slide-images";
import { taxonomyHandler } from "./taxonomy";

export function createApp(deps: {
  db: Db;
  auth: BearerOptions;
  loginRouter?: Router | null;
  eventSecrets: Record<string, string>;
  workflow: WorkflowDeps;
  distribution?: DistributionClient;
  /** Uploaded release files (STORAGE_DIR); unset → the upload routes answer 503. */
  store?: ObjectStore;
  /** Carousel and emergency pin images (spec addendum §6.4); unset → falls back to `store` (or,
   * lacking that, a lazy local store under the OS temp dir — never touched unless a slide or
   * pin image is actually saved, which no test lacking a real `store` does). */
  slideFiles?: SlideImageFiles;
  /** Flickr (asset status); null/unset when FLICKR_API_KEY isn't configured. */
  flickr?: FlickrClient | null;
  /** Body `<asset>` embed normalisation on save (Task 7); unset → bodies are sanitised but not normalised. */
  embeds?: EmbedDeps;
  /** Outbound event subscribers, for the website section's `site.content.changed` events (Task 2); unset → events are enqueued but delivered to no one. */
  subscribers?: SubscriberConfig[];
  /** Live Feed URLs to show when none is configured (Task 3, env `LIVE_WEBCAST_*_URL_DEFAULT`); unset → no default. */
  liveFeedDefaults?: { manifestUrl: string; m3uUrl: string };
  /** What site settings show before anything is published (`loadSiteSettingsDefaults`); unset → the /site/settings routes answer 503. */
  siteSettingsDefaults?: SiteSettings;
  /** Plan 3d task 4: the public site's base URL, named in Project Blue Bridge's notify subject; unset → "".
   * Task 1 (staff-web): also GET /config's siteUrl and publicSiteUrl (the two names the staff UI uses). */
  siteUrl?: string;
  /** The tenant's `calendar.forecastCategoryPrefix` (Forecast and the activity lookup); unset → no activity can be planned against. */
  forecastCategoryPrefix?: string | null;
  /** GET /config's isTestSite: @gcpe/config's isTestSite(env). Unset → true (fail safe: an
   * unconfigured deployment reads as a test site, never silently as production). */
  isTestSite?: boolean;
  /** Plan 3d task 4: Project Blue Bridge's post-commit notify; unset → logs the subject only (see site-routes.ts). */
  blueBridgeNotify?: (subject: string, text: string) => Promise<void>;
  /** "Similar published releases" (addendum §7): the News API client and NRMS's own staffAi flag; unset → the route answers 503 and the panel hides. */
  similar?: SimilarDeps;
  /** Test seam: the clock the government-term routes read "today" from; production leaves it unset (database clock). */
  clock?: TestClock;
}): express.Express {
  const slideFiles: SlideImageFiles = deps.slideFiles ?? { store: deps.store ?? localStore(tmpdir(), "/files/"), filesBase: deps.workflow.filesBase ?? "" };

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one hop: OpenShift router / SiteGround nginx
  app.use(healthRoutes([() => deps.db.execute(sql`SELECT 1`)]));

  // Mounted before any body parser: signatures cover the raw bytes (see
  // packages/events/src/receiver.ts), so an upstream express.json()/raw() that already
  // consumed the body would make every event fail verification.
  app.use(createEventReceiver({ db: deps.db, secrets: deps.eventSecrets, handlers: (e) => taxonomyHandler(e) ?? calendarHandler(e) }));

  if (deps.loginRouter) app.use(deps.loginRouter);
  // Authenticate before parsing so anonymous callers cannot make us buffer and parse bodies.
  // The media router (uploads) sits between requireBearer and the global express.json: its
  // upload routes read raw bytes with their own express.raw, which the JSON parser must not
  // reach first; everything it doesn't match falls through to express.json + apiRoutes.
  app.use(
    "/api",
    requireBearer(deps.auth),
    mediaRoutes({ db: deps.db, store: deps.store, flickr: deps.flickr }),
    siteRoutes({
      db: deps.db,
      subscribers: deps.subscribers ?? [],
      timeZone: deps.workflow.timeZone,
      liveFeedDefaults: deps.liveFeedDefaults ?? { manifestUrl: "", m3uUrl: "" },
      siteSettingsDefaults: deps.siteSettingsDefaults,
      store: deps.store,
      slideFiles,
      siteUrl: deps.siteUrl ?? "",
      notify: deps.blueBridgeNotify ?? (async (subject) => void console.log(`[nrms] blue bridge: ${subject}`)),
    }),
    governmentTermRoutes({ db: deps.db, subscribers: deps.subscribers ?? [], timeZone: deps.workflow.timeZone, now: deps.clock }),
    express.json({ limit: MAX_EVENT_BYTES }),
    apiRoutes({
      db: deps.db,
      workflow: deps.workflow,
      distribution: deps.distribution,
      store: deps.store,
      embeds: deps.embeds,
      subscribers: deps.subscribers ?? [],
      config: { siteUrl: deps.siteUrl ?? "", publicSiteUrl: deps.siteUrl ?? "", isTestSite: deps.isTestSite ?? true },
      forecastCategoryPrefix: deps.forecastCategoryPrefix ?? null,
      similar: deps.similar,
    }),
  );
  // Body-parser failures (malformed JSON 400, oversized 413) and anything a route lets
  // escape stay JSON instead of finalhandler's default HTML.
  app.use(jsonErrorHandler({ logPrefix: "[nrms]" }));
  return app;
}
