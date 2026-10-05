import { createServer, request, type IncomingMessage, type RequestListener } from "node:http";
import { duplexPair } from "node:stream";

/**
 * The origin every `self:/…` URL resolves to (see env.ts). Requests to it never touch the
 * network: {@link installInternalFetch} hands them to the stack's own Express app through an
 * in-memory connection.
 *
 * Why not http://127.0.0.1:<PORT>: on SiteGround the Node runtime is sandboxed and cannot
 * connect back to its own listening port (verified 2026-10-04: every self-delivery failed
 * with "fetch failed" while the same endpoints answered from outside). An in-process call is
 * also cheaper and doesn't depend on the host's networking at all.
 *
 * `.internal` is reserved for private use (ICANN, 2024), so if the dispatcher below were ever
 * missing, these URLs would fail to resolve rather than reach some other host.
 */
export const INTERNAL_ORIGIN = "http://stack.internal";

type Fetch = typeof fetch;

function bodyToBuffer(body: RequestInit["body"]): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError("internal fetch: unsupported request body type (use a string or bytes)");
}

function readAll(res: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => resolve(Buffer.concat(chunks)));
    res.on("error", reject);
  });
}

/**
 * Wraps `globalThis.fetch` so requests to {@link INTERNAL_ORIGIN} are served by `getApp()`
 * in-process; every other URL goes to the original fetch untouched.
 *
 * Each internal request gets its own in-memory socket pair: one end is handed to a real
 * `http.Server` (never listening on any port) as a new connection, the other is used by a
 * real `http.request` — so the request goes through Node's own HTTP parser and works with any
 * framework, exactly as over the network, but without one.
 *
 * `getApp` is a getter because the wrapper must be installed before the apps start (their
 * HTTP clients capture `fetch` when they're created) while the app is built afterwards.
 * Returns a function that restores the original fetch.
 */
export function installInternalFetch(getApp: () => RequestListener | undefined): () => void {
  const original: Fetch = globalThis.fetch;
  let server: ReturnType<typeof createServer> | undefined;
  let serverApp: RequestListener | undefined;

  const internalFetch: Fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${INTERNAL_ORIGIN}/`) && url !== INTERNAL_ORIGIN) return original(input, init);
    if (input instanceof Request && init === undefined) {
      throw new TypeError("internal fetch: pass (url, init) rather than a Request object");
    }
    const app = getApp();
    if (!app) throw new Error("internal fetch: the stack app is not ready yet");
    if (!server || serverApp !== app) {
      server = createServer(app);
      serverApp = app;
    }
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();

    const target = new URL(url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = bodyToBuffer(init?.body);
    if (body) headers["content-length"] = String(body.length);
    const method = (init?.method ?? "GET").toUpperCase();

    const [clientSide, serverSide] = duplexPair();
    // What Express/req.ip sees for these requests; internal calls are loopback by nature.
    Object.defineProperty(serverSide, "remoteAddress", { value: "127.0.0.1" });
    server.emit("connection", serverSide);

    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request({
        method,
        host: target.hostname,
        path: `${target.pathname}${target.search}`,
        headers: { ...headers, host: target.host, connection: "close" },
        createConnection: () => clientSide,
        signal,
      });
      req.on("response", resolve);
      req.on("error", reject);
      req.end(body);
    });
    const payload = await readAll(res);
    clientSide.destroy();
    serverSide.destroy();

    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(res.headers)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(key, v);
    }
    const status = res.statusCode ?? 500;
    const nullBody = status === 204 || status === 304 || method === "HEAD";
    // An explicit Uint8Array view of the bytes satisfies BodyInit under both Node's and the DOM's
    // typings (a plain Buffer<ArrayBufferLike> doesn't under the DOM's); same bytes at runtime.
    return new Response(nullBody ? null : new Uint8Array(payload), { status, headers: responseHeaders });
  };

  globalThis.fetch = internalFetch;
  return () => {
    if (globalThis.fetch === internalFetch) globalThis.fetch = original;
  };
}
