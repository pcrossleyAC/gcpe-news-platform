import type { Server } from "node:http";

/**
 * How long one request may take to arrive in full. Node's default (5 minutes) would cut off a Hub
 * site-file upload (any type, up to 512 MiB; owner decision 2026-10-29) on a link slower than
 * about 1.7 MB/s; 20 minutes matches the ARR proxy timeout Install-Gcpe.ps1 sets (about 3.5 Mbit/s
 * for the largest file). The headers timeout stays Node's 60 s, so a client trickling headers is
 * still cut off quickly; public requests also pass the DMZ proxy's 1 MB body limit first.
 */
export const UPLOAD_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

export function applyServerTimeouts(server: Server): void {
  server.requestTimeout = UPLOAD_REQUEST_TIMEOUT_MS;
}
