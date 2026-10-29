import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { applyServerTimeouts, SOCKET_IDLE_TIMEOUT_MS, UPLOAD_REQUEST_TIMEOUT_MS } from "./server-timeouts";

describe("applyServerTimeouts", () => {
  it("lets a 512 MiB site-file upload take up to 20 minutes (Node's default requestTimeout is 5), keeping the headers timeout short", () => {
    const server = createServer();
    expect(server.requestTimeout).toBe(300_000); // Node's default, which would cut a slow upload off
    applyServerTimeouts(server);
    expect(UPLOAD_REQUEST_TIMEOUT_MS).toBe(20 * 60 * 1000);
    expect(server.requestTimeout).toBe(UPLOAD_REQUEST_TIMEOUT_MS);
    expect(server.headersTimeout).toBeLessThanOrEqual(60_000);
    // Server-wide: a connection with no bytes either way for 2 minutes is closed (a stalled body
    // anywhere), while a steadily arriving upload may take the full 20 minutes.
    expect(SOCKET_IDLE_TIMEOUT_MS).toBe(120_000);
    expect(server.timeout).toBe(SOCKET_IDLE_TIMEOUT_MS);
  });
});
