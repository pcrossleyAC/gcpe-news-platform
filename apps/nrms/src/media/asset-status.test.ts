import { describe, expect, it, vi } from "vitest";
import { assetStatus, flickrAssetProblem } from "./asset-status";
import { FlickrError, type FlickrClient } from "./flickr-client";

const PAGE = "https://www.flickr.com/photos/bcgovphotos/53000000001/";

function stub(getVisibility: FlickrClient["getVisibility"]): FlickrClient {
  const never = () => Promise.reject(new Error("not used"));
  return { getVisibility: vi.fn(getVisibility), makePublic: never, confirmPublic: never, staticImageUrl: never };
}

describe("assetStatus", () => {
  it("no asset, YouTube and the live page need no Flickr call", async () => {
    const flickr = stub(() => Promise.reject(new Error("must not be called")));
    expect(await assetStatus(null, flickr)).toEqual({ kind: "none" });
    expect(await assetStatus("", flickr)).toEqual({ kind: "none" });
    expect(await assetStatus("https://www.youtube.com/watch?v=x", flickr)).toEqual({ kind: "youtube" });
    expect(await assetStatus("https://youtu.be/x", flickr)).toEqual({ kind: "youtube" });
    expect(await assetStatus("https://news.gov.bc.ca/live/", flickr)).toEqual({ kind: "live" });
    expect(flickr.getVisibility).not.toHaveBeenCalled();
  });

  it("reports a Flickr photo's state with its message", async () => {
    expect(await assetStatus(PAGE, stub(async () => "public"))).toEqual({
      kind: "flickr", photoId: "53000000001", state: "public", message: "Public on Flickr.",
    });
    expect(await assetStatus("https://flic.kr/p/2abc", stub(async () => "private"))).toMatchObject({
      kind: "flickr", state: "private", message: "Private — will be made public when the release publishes.",
    });
    expect(await assetStatus(PAGE, stub(() => Promise.reject(new FlickrError("not-found", "Flickr flickr.photos.getInfo: Photo not found (code 1)"))))).toEqual({
      kind: "flickr", photoId: "53000000001", state: "missing", message: "This photo no longer exists on Flickr.",
    });
  });

  it("outages, refused auth, odd answers and no configuration all read as unavailable", async () => {
    const unavailable = { kind: "flickr", photoId: "53000000001", state: "unavailable", message: "Flickr can't be reached right now." };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const kind of ["unavailable", "auth", "unexpected"] as const) {
        expect(await assetStatus(PAGE, stub(() => Promise.reject(new FlickrError(kind, `Flickr x: ${kind}`))))).toEqual(unavailable);
      }
      expect(await assetStatus(PAGE, stub(() => Promise.reject(new Error("boom"))))).toEqual(unavailable);
    } finally {
      spy.mockRestore();
    }
    expect(await assetStatus(PAGE, null)).toEqual(unavailable);
  });
});

describe("flickrAssetProblem", () => {
  it("refuses a Flickr link with no photo id, and lets photo links and non-Flickr links through", () => {
    const bad = "That Flickr link doesn't point to a photo.";
    expect(flickrAssetProblem("https://www.flickr.com/photos/bcgovphotos/")).toBe(bad);
    expect(flickrAssetProblem("https://www.flickr.com/photos/bcgovphotos/albums/72177720300000000")).toBe(bad);
    expect(flickrAssetProblem("https://flic.kr/s/aHsk")).toBe(bad);
    expect(flickrAssetProblem("https://api.flickr.com/services/rest")).toBe(bad);
    expect(flickrAssetProblem(PAGE)).toBeNull();
    expect(flickrAssetProblem("https://flic.kr/p/2abc")).toBeNull();
    expect(flickrAssetProblem("https://www.youtube.com/watch?v=x")).toBeNull();
    expect(flickrAssetProblem("https://news.gov.bc.ca/live")).toBeNull();
  });
});
