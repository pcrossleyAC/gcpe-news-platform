import { isSafeUrl } from "@gcpe/http-kit";
import { e } from "../render";

/**
 * A post's lead media (`assetUrl`) or a body `<asset>` embed, as legacy `AssetHelper` recognises
 * them — but rendered with no third-party load at page view (C209, plan 2 ledger P2-R1):
 * - a Flickr static photo is the one third-party image we hotlink (Flickr is where BC publishes
 *   its photos), linked to its bcgovphotos page;
 * - a YouTube video is a link to youtube.com with our vendored placeholder image, in place of
 *   legacy's proxied thumbnail and consent player;
 * - the news.gov.bc.ca live page is a plain "Watch the live webcast" link.
 */
export type LeadMedia = { kind: "image"; src: string; href: string } | { kind: "youtube"; id: string; href: string } | { kind: "live"; href: string };

const FLICKR = /^https?:\/\/(farm\d+|live)\.staticflickr\.com\/\d+\/(\d+)_[0-9a-f]+(_[a-z])?\.jpg$/;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const LIVE = /^https:\/\/news\.gov\.bc\.ca\/live\/?$/;

/** The vendored image a YouTube link shows instead of YouTube's own thumbnail: legacy's 1920×1080
 * card image (`default-og-image-new.jpg`), large enough for the story column at phone pixel
 * densities (the 300px square it replaced was upscaled; Lighthouse image-size-responsive). */
export const YOUTUBE_PLACEHOLDER = "/assets/legacy/Content/Images/Gov/default-og-image-new.jpg";

function youtubeId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const id = YOUTUBE_HOSTS.has(host) && u.pathname === "/watch" ? u.searchParams.get("v") : host === "youtu.be" ? u.pathname.slice(1) : null;
  return id !== null && YOUTUBE_ID.test(id) ? id : null;
}

/** The lead media a URL names, or null for anything else (including an unsafe or empty value). */
export function leadMedia(url: string | null | undefined): LeadMedia | null {
  const u = (url ?? "").trim();
  if (!u) return null;
  const flickr = FLICKR.exec(u);
  if (flickr) return { kind: "image", src: u.replace(/^http:/, "https:"), href: `https://www.flickr.com/photos/bcgovphotos/${flickr[2]}/` };
  const id = youtubeId(u);
  if (id) return { kind: "youtube", id, href: `https://www.youtube.com/watch?v=${id}` };
  if (LIVE.test(u)) return { kind: "live", href: u };
  return null;
}

/** What names a Flickr photo link whose image has no alt text, when the caller gives nothing better. */
export const FLICKR_LINK_NAME = "Photo on Flickr";

/** One lead media block. `lazy` defers its image's load (body embeds; a lead stays eager, as it
 * is likely the page's largest paint). `base` is the site's base path ("" or "/site"); `alt` is the image's alt
 * text (the headline for a lead), escaped here. With an empty `alt` a YouTube link carries no
 * visually-hidden suffix, and a Flickr photo link — whose only content is the image — is named by
 * visually hidden `name` instead, so it is never a nameless link (WCAG 2.4.4, 4.1.2). */
export function renderMedia(m: LeadMedia, base: string, alt: string, name = FLICKR_LINK_NAME, lazy = false): string {
  switch (m.kind) {
    case "image": {
      const label = alt ? "" : `<span class="visually-hidden">${e(name.trim() || FLICKR_LINK_NAME)}</span>`;
      // A 3:2 size hint (Flickr's usual landscape; CSS keeps height:auto, so a portrait photo still
      // shows at its own ratio) reserves the box before the photo loads.
      return `<div class="asset flickr"><a href="${e(m.href)}"><img src="${e(m.src)}" alt="${e(alt)}" width="1024" height="683"${lazy ? ' loading="lazy"' : ""}>${label}</a></div>`;
    }
    case "youtube": {
      const suffix = alt ? `<span class="visually-hidden">: ${e(alt)}</span>` : "";
      return `<div class="asset youtube"><a href="${e(m.href)}"><img src="${e(base)}${YOUTUBE_PLACEHOLDER}" alt="" width="1920" height="1080"${lazy ? ' loading="lazy"' : ""}><span>Watch on YouTube</span>${suffix}</a></div>`;
    }
    case "live":
      return `<p><a href="${e(m.href)}">Watch the live webcast</a></p>`;
  }
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decodes the character references an editor leaves in an `<asset>` URL (`&amp;` above all). An
 * unknown named reference is left as written, so it cannot turn into anything. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/**
 * Replaces each `<asset>URL</asset>` in a release body (legacy `AssetHelper`'s body embeds) with
 * what {@link renderMedia} renders for it (alt "", the photo link named by `photoName`, lazy), a plain link for any other absolute http(s) URL
 * (SoundCloud included — no player), or nothing for an unparseable or unsafe one. The URL is
 * entity-decoded first and checked with `isSafeUrl` after decoding. Runs before
 * `sanitizeBodyHtml`, which keeps the classes these blocks carry.
 */
export function renderBodyAssets(html: string, base: string, photoName = FLICKR_LINK_NAME): string {
  return html.replace(/<asset>([\s\S]*?)<\/asset>/gi, (_whole, raw: string) => {
    const url = decodeEntities(raw).trim();
    const media = leadMedia(url);
    if (media) return renderMedia(media, base, "", photoName, true);
    if (isSafeUrl(url, { relative: false, schemes: ["http:", "https:"] })) return `<p><a href="${e(url)}">${e(url)}</a></p>`;
    return "";
  });
}
