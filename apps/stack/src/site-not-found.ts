import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NextFunction, Request, Response } from "express";
import { sendPrecompressed } from "./site-precompressed";

/** Served only until the public site has written its own 404.html (a cold start). */
const FALLBACK_404 = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found</title></head>
<body><h1>Page not found</h1><p>The page you are looking for doesn't exist or has moved.</p></body>
</html>
`;

/**
 * The last handler on the static site's own prefix (after `express.static`): any GET/HEAD the
 * static mount didn't serve answers 404 with the site's generated 404.html (site-paths.ts
 * `static` page) instead of falling through to News API's root `{"error":"not found"}`. Other
 * methods still fall through, so nothing but a page fetch changes. no-store, so a page
 * published a moment later is never shadowed by a cached 404.
 */
export function siteNotFound(outputDir: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    res.status(404);
    res.setHeader("Cache-Control", "no-store");
    if (existsSync(join(outputDir, "404.html"))) {
      // The stored 404.html.br / .gz when the client takes one (a crawler hammering missing URLs
      // costs a file read, not a compression each); else the page as is, compressed per request.
      const plain = (): void => {
        // `root` keeps send's dotfile check to "404.html" itself (an OUTPUT_DIR under a dotted
        // folder, e.g. SiteGround's ~/.nodeapp, would otherwise 404 the 404 page).
        res.sendFile("404.html", { root: outputDir, headers: { "Cache-Control": "no-store" } }, (err) => {
          if (err && !res.headersSent) res.type("html").send(FALLBACK_404);
        });
      };
      sendPrecompressed(req, res, outputDir, "404.html", { headers: { "Cache-Control": "no-store" } }).then((sent) => {
        if (!sent) plain();
      }, plain);
      return;
    }
    res.type("html").send(FALLBACK_404);
  };
}
