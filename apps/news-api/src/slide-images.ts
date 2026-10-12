import { createHash } from "node:crypto";
import { SLIDE_IMAGE_KEY } from "@gcpe/events";

export const SLIDE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** A named error carrying only a safe-to-log reason — never the fetched bytes or a full URL
 * (it may carry a token). `safeErrorLabel` (`@gcpe/http-kit`) logs `.code` if present, else
 * `.name`; this has no `.code`, so giving it its own `.name` is what makes a stuck slide event
 * show as `SlideImageError` in `/stack/errors`, rather than the bare word "Error". */
export class SlideImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlideImageError";
  }
}

export interface SlideImageFetcher {
  fetch(s: { imageUrl: string | null; imageKey: string | null; imageSha256: string | null }): Promise<Buffer>;
}

/**
 * Reads `res.body`, counting bytes as they arrive, and throws as soon as the running total
 * passes `maxBytes` — never buffers more than one over-limit chunk, so a server that lies
 * about (or omits) `content-length` can't be used to force an unbounded read into memory.
 */
async function readBounded(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) throw new SlideImageError("slide image too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * spec §6.4 with v1 kept: the bytes behind a slide event's URL, checked against its SHA-256.
 * The fetch target is always `fetchBase` plus the event's own `imageKey` — validated against
 * `SLIDE_IMAGE_KEY` before it ever reaches a URL — never the event's `imageUrl`: an NRMS event
 * is signed, but that only authenticates its *content*, not its *destination*, so nothing here
 * ever makes a request to a host the event itself names. `fetchBase` is required (the News API
 * refuses to start without it — env.ts), so there is no fallback path that would fetch an
 * arbitrary host. `redirect: "error"` keeps a redirect from `fetchBase` from being silently
 * followed to a different host.
 */
export function slideImageFetcher(opts: { fetchBase: string; fetchImpl?: typeof fetch; timeoutMs?: number }): SlideImageFetcher {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.fetchBase.replace(/\/+$/, "");
  return {
    async fetch(s) {
      if (!s.imageSha256 || !s.imageKey || !SLIDE_IMAGE_KEY.test(s.imageKey)) throw new SlideImageError("slide image reference is incomplete");
      const url = `${base}/${s.imageKey}`;
      let res: Response;
      try {
        res = await doFetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000), redirect: "error" });
      } catch (e) {
        if (e instanceof SlideImageError) throw e;
        throw new SlideImageError(`slide image fetch failed: ${e instanceof Error ? e.name : "error"}`);
      }
      if (!res.ok) throw new SlideImageError(`slide image fetch failed: HTTP ${res.status}`);
      // An early, cheap rejection for an honest server's declared length; readBounded below is
      // what actually enforces the bound against a dishonest or absent one, while streaming.
      if (Number(res.headers.get("content-length") ?? 0) > SLIDE_IMAGE_MAX_BYTES) throw new SlideImageError("slide image too large");
      const bytes = await readBounded(res, SLIDE_IMAGE_MAX_BYTES);
      if (createHash("sha256").update(bytes).digest("hex") !== s.imageSha256) throw new SlideImageError("slide image does not match its hash");
      return bytes;
    },
  };
}
