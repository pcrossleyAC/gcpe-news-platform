import type { AssetStatus } from "@gcpe/nrms-contract";
import { FlickrError, isFlickrUrl, photoIdFromUrl, type FlickrClient } from "./flickr-client";

type FlickrState = Extract<AssetStatus, { kind: "flickr" }>["state"];

export const FLICKR_STATE_MESSAGES: Record<FlickrState, string> = {
  public: "Public on Flickr.",
  private: "Private — will be made public when the release publishes.",
  missing: "This photo no longer exists on Flickr.",
  unavailable: "Flickr can't be reached right now.",
};

export const NOT_A_FLICKR_PHOTO = "That Flickr link doesn't point to a photo.";

function hostOf(url: string): { host: string; path: string } | null {
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase(), path: u.pathname };
  } catch {
    return null;
  }
}

/** Any URL on a Flickr host — the contract's accepted asset hosts (flickr.com and its
 * subdomains, flic.kr) plus Flickr's static image hosts — whether or not it names a photo. */
function onFlickrHost(url: string): boolean {
  const h = hostOf(url)?.host;
  return h !== undefined && (/(^|\.)flickr\.com$/.test(h) || h === "flic.kr" || isFlickrUrl(url));
}

/**
 * The save-time check for an asset URL that `assetUrlProblem` already accepted: a Flickr link
 * must name a photo (a profile, album or API URL can't be made public or embedded). Offline —
 * whether the photo exists is the status endpoint's job.
 */
export function flickrAssetProblem(url: string): string | null {
  return onFlickrHost(url) && photoIdFromUrl(url) === null ? NOT_A_FLICKR_PHOTO : null;
}

/**
 * What the release's asset is, and for a Flickr photo its current visibility. `flickr` null
 * (no FLICKR_API_KEY) reads as unavailable, the same as an outage. Anything other than
 * "photo not found" — outage, refused auth, an odd answer — is unavailable: the editor can't act
 * on the difference, and the publisher (not this check) is what alerts on it.
 */
export async function assetStatus(assetUrl: string | null, flickr: FlickrClient | null | undefined): Promise<AssetStatus> {
  const parsed = assetUrl ? hostOf(assetUrl) : null;
  if (!assetUrl || !parsed) return { kind: "none" };
  if (/(^|\.)youtube\.com$/.test(parsed.host) || parsed.host === "youtu.be") return { kind: "youtube" };
  if (parsed.host === "news.gov.bc.ca" && parsed.path.replace(/\/$/, "") === "/live") return { kind: "live" };
  if (!onFlickrHost(assetUrl)) return { kind: "none" };

  const photoId = photoIdFromUrl(assetUrl);
  // Only reachable for a link saved before the save-time check existed (e.g. imported data).
  if (photoId === null) return { kind: "flickr", photoId: "", state: "missing", message: NOT_A_FLICKR_PHOTO };
  const flickrState = (state: FlickrState): AssetStatus => ({ kind: "flickr", photoId, state, message: FLICKR_STATE_MESSAGES[state] });
  if (!flickr) return flickrState("unavailable");
  try {
    return flickrState(await flickr.getVisibility(photoId));
  } catch (e) {
    if (e instanceof FlickrError && e.kind === "not-found") return flickrState("missing");
    // FlickrError messages never carry the request URL, signature or keys (see flickr-client.ts).
    const why = e instanceof FlickrError ? `${e.kind}: ${e.message}` : e instanceof Error ? e.name : "error";
    console.error(`[nrms] Flickr status check for photo ${photoId} failed (${why})`);
    return flickrState("unavailable");
  }
}
