import compression from "compression";
import type { RequestHandler } from "express";

/**
 * HTTP compression for text responses (R13), done by the stack itself so every host gets it:
 * the Windows/IIS package's ARR proxy doesn't compress (Install-Gcpe.ps1 installs no
 * Web-Dyn-Compression) and site-quality.ts's performance gate (C212) assumes compressed text.
 *
 * `compression` (expressjs) negotiates br (quality 4), then gzip, from Accept-Encoding; a
 * request without one gets identity bytes. It compresses only types mime-db marks compressible
 * (HTML, CSS, JS, JSON, SVG, XML, CSV and other text) of 1 KB or more, so woff2, PNG, JPEG and
 * PDF pass through untouched; it adds `Vary: Accept-Encoding`, skips HEAD, honours
 * `Cache-Control: no-transform`, and never re-encodes a response that already carries
 * Content-Encoding. Streamed bodies (NoD's CSV reports) keep their backpressure: the
 * compressor's `drain` is the response's. There are no server-sent events or long polls in the
 * stack; the Hub's WebSocket upgrade never passes through Express middleware.
 *
 * Behind SiteGround's nginx: nginx's gzip/brotli filters skip a response that already has
 * Content-Encoding, so an encoded response passes through once; if nginx strips
 * Accept-Encoding upstream, this sends identity and nginx compresses as before. Either way a
 * body is encoded at most once.
 *
 * A 206 is left alone: its Content-Range counts identity bytes.
 */
export function textCompression(): RequestHandler {
  return compression({
    filter: (req, res) => res.statusCode !== 206 && compression.filter(req, res),
  });
}
