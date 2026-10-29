import type { Server } from "node:http";

/**
 * The stack's http server timeouts. What bounds what:
 * - **Size** is bounded elsewhere: a site-file upload by MAX_SITE_FILE_BYTES (512 MiB, NRMS stops
 *   reading past it), every other body by its own route's parser limit, and IIS's
 *   maxAllowedContentLength in front.
 * - **Total time** for one request to arrive in full: `requestTimeout`, 20 minutes, server-wide.
 *   Node's default (5 minutes) would cut off a 512 MiB Hub upload on a link slower than about
 *   1.7 MB/s; 20 minutes matches the ARR proxy timeout Install-Gcpe.ps1 sets (about 3.5 Mbit/s
 *   for the largest file).
 * - **Stalls**: `timeout`, 2 minutes with no bytes either way on a socket closes it, server-wide,
 *   so a stalled body (or a stalled client anywhere) doesn't hold a connection for the 20 minutes.
 *   A steadily arriving upload resets it with every chunk.
 * - Headers: Node's own 60 s `headersTimeout`, unchanged, so a client trickling headers is cut
 *   off quickly. Public requests also pass the DMZ proxy's 1 MB body limit first.
 */
export const UPLOAD_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;
export const SOCKET_IDLE_TIMEOUT_MS = 2 * 60 * 1000;

export function applyServerTimeouts(server: Server): void {
  server.requestTimeout = UPLOAD_REQUEST_TIMEOUT_MS;
  server.timeout = SOCKET_IDLE_TIMEOUT_MS;
}
