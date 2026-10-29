import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NextFunction, Request, Response } from "express";

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
  // Written by hand rather than res.sendFile/res.send: those add Accept-Ranges, ETag and
  // Last-Modified (Express wires its app-wide etag setting into sendFile), so a Range or
  // conditional request could turn the 404 into a 206 slice or a 304. A 404 is always the whole
  // page with status 404 and no validators — every miss, including a gated /files key, is
  // byte-identical.
  const answer = (res: Response, body: Buffer): void => {
    res.status(404);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Length", String(body.length));
    res.end(body);
  };
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    readFile(join(outputDir, "404.html")).then(
      (body) => answer(res, body),
      () => answer(res, Buffer.from(FALLBACK_404)),
    );
  };
}
