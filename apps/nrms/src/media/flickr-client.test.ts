import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeFlickr } from "@gcpe/flickr-fake";
import {
  decodeBase58,
  type FlickrConfig,
  FlickrError,
  flickrClient,
  isFlickrUrl,
  oauthSignature,
  percentEncode,
  photoIdFromUrl,
} from "./flickr-client";

describe("OAuth 1.0a signature", () => {
  it("matches the RFC 5849 §1.2 example", () => {
    const sig = oauthSignature("GET", "http://photos.example.net/photos", {
      file: "vacation.jpg", size: "original", oauth_consumer_key: "dpf43f3p2l4k3l03", oauth_token: "nnch734d00sl2jdk",
      oauth_signature_method: "HMAC-SHA1", oauth_timestamp: "1191242096", oauth_nonce: "kllo9940pd9333jh", oauth_version: "1.0",
    }, "kd94hf93k423kf44", "pfkkdhi9sl3r4s00");
    expect(sig).toBe("tR3+Ty81lMeYAr/Fid0kMTYa/WM=");
  });
  it("percent-encodes per RFC 3986", () => {
    expect(percentEncode("a b!*'()~")).toBe("a%20b%21%2A%27%28%29~");
  });
});

describe("photo ids", () => {
  it("parses page, short and static URLs", () => {
    expect(photoIdFromUrl("https://www.flickr.com/photos/bcgovphotos/53212345678/")).toBe("53212345678");
    expect(photoIdFromUrl("https://flickr.com/photos/bcgovphotos/53212345678/in/album-721/")).toBe("53212345678");
    expect(photoIdFromUrl("https://live.staticflickr.com/65535/53212345678_abcdef1234_b.jpg")).toBe("53212345678");
    expect(photoIdFromUrl(`https://flic.kr/p/${"21"}`)).toBe("58");
    expect(decodeBase58("a")).toBe("9");
    expect(photoIdFromUrl("https://www.flickr.com/photos/bcgovphotos/")).toBeNull();
    expect(photoIdFromUrl("https://example.com/photos/x/1")).toBeNull();
  });
  it("rejects look-alike hosts, bad schemes and invalid short codes", () => {
    expect(photoIdFromUrl("https://flickr.com.evil.example/photos/x/123/")).toBeNull();
    expect(photoIdFromUrl("javascript:alert(1)//flickr.com/photos/x/123")).toBeNull();
    expect(photoIdFromUrl("https://flic.kr/p/0OIl")).toBeNull();
    expect(photoIdFromUrl("not a url")).toBeNull();
    expect(isFlickrUrl("https://farm1.staticflickr.com/1/2_a.jpg")).toBe(true);
    expect(isFlickrUrl("https://notflickr.com/photos/x/1")).toBe(false);
    expect(isFlickrUrl("ftp://www.flickr.com/photos/x/1")).toBe(false);
  });
});

describe("client against the fake", () => {
  const creds = { apiKey: "fake-key", apiSecret: "fake-secret", accessToken: "fake-token", accessSecret: "fake-token-secret" };
  let server: Server;
  let base: string;
  let fake: ReturnType<typeof createFakeFlickr>;
  const cfg = (over: Partial<FlickrConfig> = {}): FlickrConfig => ({
    ...creds, restUrl: `${base}/services/rest`, oembedUrl: `${base}/services/oembed`, ...over,
  });
  const PRIVATE = "53000000001";

  beforeAll(async () => {
    const app = express();
    // Bind first so the fake's public base can be the very URL the client signs.
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fake-flickr`;
    fake = createFakeFlickr({ ...creds, publicBaseUrl: base });
    app.use("/fake-flickr", fake.router);
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    Object.assign(fake.state, { refuseAuth: false, outageCalls: 0, deleted: [] });
  });

  const kindOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(FlickrError);
      return (e as FlickrError).kind;
    }
    throw new Error("expected a FlickrError");
  };

  it("reports a private photo, makes it public, and confirms", async () => {
    const c = flickrClient(cfg());
    expect(await c.getVisibility(PRIVATE)).toBe("private");
    expect(await c.confirmPublic(PRIVATE)).toBe(false);
    await c.makePublic(PRIVATE);
    expect(fake.photos.get(PRIVATE)?.isPublic).toBe(true);
    expect(await c.confirmPublic(PRIVATE)).toBe(true);
    expect(await c.getVisibility(PRIVATE)).toBe("public");
  });

  it("resolves a public page to its static image URL via oEmbed", async () => {
    const c = flickrClient(cfg());
    const photo = fake.photos.get("53000000011")!;
    expect(await c.staticImageUrl(`${base}/photos/bcgovphotos/${photo.id}/`)).toBe(`${base}/static/${photo.id}_${photo.secret}_b.jpg`);
  });

  it("oEmbed of a private photo is not-found", async () => {
    const c = flickrClient(cfg());
    expect(await kindOf(c.staticImageUrl(`${base}/photos/bcgovphotos/53000000002/`))).toBe("not-found");
  });

  it("refused auth rejects every REST call with kind auth", async () => {
    fake.state.refuseAuth = true;
    const c = flickrClient(cfg());
    expect(await kindOf(c.getVisibility(PRIVATE))).toBe("auth");
    expect(await kindOf(c.makePublic("53000000003"))).toBe("auth");
    expect(await kindOf(c.confirmPublic(PRIVATE))).toBe("auth");
    expect(fake.photos.get("53000000003")?.isPublic).toBe(false);
  });

  it("an outage is unavailable, then recovers", async () => {
    fake.state.outageCalls = 1;
    const c = flickrClient(cfg());
    expect(await kindOf(c.getVisibility("53000000004"))).toBe("unavailable");
    expect(await c.getVisibility("53000000004")).toBe("private");
  });

  it("a deleted photo is not-found", async () => {
    fake.state.deleted = ["53000000005"];
    const c = flickrClient(cfg());
    expect(await kindOf(c.getVisibility("53000000005"))).toBe("not-found");
    expect(await kindOf(c.makePublic("53000000005"))).toBe("not-found");
  });

  it("a wrong api secret or token secret is auth", async () => {
    expect(await kindOf(flickrClient(cfg({ apiSecret: "wrong" })).getVisibility(PRIVATE))).toBe("auth");
    expect(await kindOf(flickrClient(cfg({ accessSecret: "wrong" })).makePublic("53000000004"))).toBe("auth");
    expect(fake.photos.get("53000000004")?.isPublic).toBe(false);
  });

  it("parameters needing percent-encoding still verify", async () => {
    // A nonce containing reserved characters exercises the encode-then-sort path on both sides.
    const c = flickrClient(cfg({ nonce: () => "a b+c/d=e&f*~", timestamp: () => 1_700_000_000 }));
    expect(await c.getVisibility("53000000002")).toBe("private");
  });

  it("network errors are unavailable", async () => {
    const c = flickrClient(cfg({ restUrl: "http://127.0.0.1:1/services/rest" }));
    expect(await kindOf(c.getVisibility(PRIVATE))).toBe("unavailable");
  });

  it("never puts secrets in error messages", async () => {
    try {
      await flickrClient(cfg({ restUrl: "http://127.0.0.1:1/services/rest" })).getVisibility(PRIVATE);
    } catch (e) {
      const msg = String((e as Error).message) + String((e as Error).cause ?? "");
      for (const s of [creds.apiSecret, creds.accessSecret, creds.accessToken, "oauth_signature"]) expect(msg).not.toContain(s);
    }
  });

  it("refuses a non-https static URL from a foreign origin", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ type: "photo", url: "http://evil.example/x.jpg" }), { headers: { "content-type": "application/json" } });
    const c = flickrClient(cfg({ fetchImpl }));
    expect(await kindOf(c.staticImageUrl("https://www.flickr.com/photos/x/1/"))).toBe("unexpected");
  });

  it("an unknown Flickr failure code is unexpected", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ stat: "fail", code: 2, message: "Not your photo" }), { headers: { "content-type": "application/json" } });
    expect(await kindOf(flickrClient(cfg({ fetchImpl })).getVisibility(PRIVATE))).toBe("unexpected");
  });
});
