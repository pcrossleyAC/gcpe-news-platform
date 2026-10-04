import { escapeHtml } from "@gcpe/http-kit";
import { sanitizeBodyHtml } from "../text/sanitize";
import { isFlickrUrl, type FlickrClient } from "./flickr-client";

/**
 * Normalises `<asset>…</asset>` media embeds in a release body on save (Task 7, Phase 3c).
 *
 * The body passed in has already been through {@link sanitizeBodyHtml} once (so `<asset>` has
 * no attributes and its text content has HTML entities encoded — notably `&` as `&amp;`). We
 * parse it with a regex rather than a full HTML parser: the allow-list limits `<asset>` content
 * to plain, already-escaped text (a URL), so a parser buys no safety here and the regex is far
 * simpler to reason about. The result is run back through {@link sanitizeBodyHtml} so nothing
 * this module writes (including a Flickr-supplied URL) can introduce anything outside the
 * allow-list.
 */

export interface EmbedDeps {
  /** null when Flickr isn't configured (FLICKR_API_KEY unset) — Flickr embeds degrade to links. */
  flickr: FlickrClient | null;
  soundcloudOembed: (url: string) => Promise<string | null>;
  /** Caps how many `<asset>` tags get network-backed resolution; the rest become plain links
   * without any network call. Default 10. */
  maxEmbeds?: number;
}

const DEFAULT_MAX_EMBEDS = 10;
const ASSET_RE = /<asset>([\s\S]*?)<\/asset>/g;
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

function decodeEntities(s: string): string {
  return s.replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g, (m) => {
    switch (m) {
      case "&amp;": return "&";
      case "&lt;": return "<";
      case "&gt;": return ">";
      case "&quot;": return '"';
      default: return "'"; // &#39; or &apos;
    }
  });
}

function plainLink(url: string): string {
  const esc = escapeHtml(url);
  return `<a href="${esc}">${esc}</a>`;
}

/** The video id from a YouTube watch/short/share URL, or null if the URL isn't recognised. */
function youtubeId(url: URL, host: string): string | null {
  if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] ?? null;
  if (host !== "youtube.com") return null;
  if (url.pathname === "/watch") return url.searchParams.get("v");
  const segs = url.pathname.split("/").filter(Boolean);
  return segs[0] === "shorts" && segs[1] ? segs[1] : null;
}

async function resolveKnownAsset(url: URL, decoded: string, deps: EmbedDeps): Promise<string> {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");

  if (host === "youtube.com" || host === "youtu.be") {
    const id = youtubeId(url, host);
    if (id && YOUTUBE_ID_RE.test(id)) return `<asset>https://www.youtube.com/watch?v=${id}</asset>`;
    return plainLink(decoded);
  }

  if (isFlickrUrl(decoded)) {
    if (host === "staticflickr.com" || host.endsWith(".staticflickr.com")) {
      const https = new URL(decoded);
      https.protocol = "https:";
      return `<asset>${https.toString()}</asset>`;
    }
    // A Flickr page or flic.kr short link.
    if (!deps.flickr) return plainLink(decoded);
    try {
      const staticUrl = await deps.flickr.staticImageUrl(decoded);
      return `<asset>${staticUrl}</asset>`;
    } catch {
      // Private photo, not found, unavailable, or any other Flickr failure.
      return plainLink(decoded);
    }
  }

  if (host === "soundcloud.com" || host.endsWith(".soundcloud.com")) {
    try {
      const canonical = await deps.soundcloudOembed(decoded);
      return canonical ? `<asset>${canonical}</asset>` : plainLink(decoded);
    } catch {
      return plainLink(decoded);
    }
  }

  return plainLink(decoded);
}

export async function normalizeEmbeds(html: string, deps: EmbedDeps): Promise<string> {
  if (!html.includes("<asset")) return html;
  const max = deps.maxEmbeds ?? DEFAULT_MAX_EMBEDS;
  let resolved = 0;
  let out = "";
  let last = 0;

  for (const m of html.matchAll(ASSET_RE)) {
    const idx = m.index ?? 0;
    out += html.slice(last, idx);
    last = idx + m[0].length;

    const decoded = decodeEntities(m[1] ?? "").trim();
    let url: URL | null;
    try {
      url = new URL(decoded);
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
      continue; // unparsable or an unsafe scheme (e.g. javascript:) — drop the whole tag
    }
    if (resolved >= max) {
      out += plainLink(decoded); // extra beyond the cap — a plain link, no network call
      continue;
    }
    resolved++;
    out += await resolveKnownAsset(url, decoded, deps);
  }
  out += html.slice(last);
  return sanitizeBodyHtml(out);
}

/**
 * The default `soundcloudOembed` for {@link normalizeEmbeds}: SoundCloud's public oEmbed
 * endpoint. HTTP 200 with no recognisable canonical URL in the response falls back to the input
 * URL (SoundCloud's oEmbed response doesn't carry the track's own canonical URL back); anything
 * else (non-200, network error, bad JSON) is a failure — null. A 5 s timeout, same as Flickr's
 * client.
 */
export function defaultSoundcloudOembed(fetchImpl: typeof fetch): (url: string) => Promise<string | null> {
  return async (url: string) => {
    const endpoint = `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`;
    let res: Response;
    try {
      res = await fetchImpl(endpoint, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
    } catch {
      return null;
    }
    if (res.status !== 200) return null;
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return null;
    }
    const canonical = (json as { url?: unknown } | null)?.url;
    return typeof canonical === "string" && canonical ? canonical : url;
  };
}
