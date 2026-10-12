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
 * spec §6.4 with v1 kept: the bytes behind a slide event's URL, checked against its SHA-256.
 * fetchBase (the stack: self:/files) replaces the public origin, which SiteGround can't loop
 * back to. Never fetches an arbitrary host taken from the event: with fetchBase set, only
 * imageKey (validated against SLIDE_IMAGE_KEY) ever reaches the URL — imageUrl is used only
 * when fetchBase is absent (a standalone deployment, Q85).
 */
export function slideImageFetcher(opts: { fetchBase?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): SlideImageFetcher {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async fetch(s) {
      if (!s.imageSha256 || !s.imageKey || !SLIDE_IMAGE_KEY.test(s.imageKey)) throw new SlideImageError("slide image reference is incomplete");
      const url = opts.fetchBase ? `${opts.fetchBase.replace(/\/+$/, "")}/${s.imageKey}` : s.imageUrl;
      if (!url) throw new SlideImageError("slide image has no URL");
      const res = await doFetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000) });
      if (!res.ok) throw new SlideImageError(`slide image fetch failed: HTTP ${res.status}`);
      if (Number(res.headers.get("content-length") ?? 0) > SLIDE_IMAGE_MAX_BYTES) throw new SlideImageError("slide image too large");
      // arrayBuffer() reads the whole body before the size check below; the content-length
      // check above catches an honest server first, and NRMS's file store is the only source
      // this ever points at — streaming is not worth the complexity here.
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > SLIDE_IMAGE_MAX_BYTES) throw new SlideImageError("slide image too large");
      if (createHash("sha256").update(bytes).digest("hex") !== s.imageSha256) throw new SlideImageError("slide image does not match its hash");
      return bytes;
    },
  };
}
