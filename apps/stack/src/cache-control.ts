import type { NextFunction, Request, Response } from "express";

function isStrictEnough(value: ReturnType<Response["getHeader"]>): boolean {
  if (value === undefined) return false;
  const text = Array.isArray(value) ? value.join(",") : String(value);
  return text.toLowerCase().includes("no-store");
}

/**
 * Defaults every response to `Cache-Control: no-store` (the SiteGround nginx proxy caches any
 * GET response that lacks a Cache-Control header, ignoring the query string — see
 * siteground-facts.md), overriding anything weaker a route sets itself (e.g. News API's own
 * `no-cache` on /api/*) — nothing is stricter than `no-store`, so the only header this leaves
 * alone is one that already contains `no-store`.
 *
 * Patches `res.writeHead` instead of setting the header up front, so it runs *after* the
 * route has had its own say (res.json/res.send/res.end all funnel through writeHead before
 * the first byte goes out) — a route that explicitly wants a cacheable response (the /site
 * static mount) achieves that by being mounted *before* this middleware in stack.ts, not by
 * fighting this override; see stack.ts's mount order.
 */
export function noStoreByDefault(_req: Request, res: Response, next: NextFunction): void {
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = ((...args: Parameters<typeof originalWriteHead>) => {
    if (!isStrictEnough(res.getHeader("Cache-Control"))) {
      res.setHeader("Cache-Control", "no-store");
    }
    return originalWriteHead(...args);
  }) as typeof res.writeHead;
  next();
}
