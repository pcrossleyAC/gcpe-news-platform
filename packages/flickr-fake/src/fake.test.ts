import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createFakeFlickr } from "./index";

const creds = { apiKey: "k", apiSecret: "s", accessToken: "t", accessSecret: "ts" };
const BASE = "https://boxs.ca/fake-flickr";

function setup() {
  const fake = createFakeFlickr({ ...creds, publicBaseUrl: BASE });
  const app = express();
  app.use("/fake-flickr", fake.router);
  return { app, ...fake };
}

// Independent signer (does not import the NRMS client) so the fake is checked against RFC 5849 directly.
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
function sign(method: string, url: string, params: Record<string, string>, tokenSecret: string): string {
  const norm = Object.entries(params)
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0]! === b[0]! ? (a[1]! < b[1]! ? -1 : 1) : a[0]! < b[0]! ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return createHmac("sha1", `${enc(creds.apiSecret)}&${enc(tokenSecret)}`).update(`${method}&${enc(url)}&${enc(norm)}`).digest("base64");
}
function signed(method: string, url: string, extra: Record<string, string>, token?: { token: string; secret: string }) {
  const p: Record<string, string> = {
    ...extra, oauth_consumer_key: creds.apiKey, oauth_nonce: "n1", oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: "1700000000", oauth_version: "1.0",
  };
  if (token) p.oauth_token = token.token;
  p.oauth_signature = sign(method, url, p, token?.secret ?? "");
  return new URLSearchParams(p).toString();
}
const restParams = (method: string, extra: Record<string, string> = {}) => ({ method, format: "json", nojsoncallback: "1", api_key: creds.apiKey, ...extra });

describe("fake Flickr", () => {
  it("rejects an unsigned REST call with code 98", async () => {
    const { app } = setup();
    const res = await request(app).get("/fake-flickr/services/rest").query(restParams("flickr.photos.getInfo", { photo_id: "53000000001" }));
    expect(res.body).toMatchObject({ stat: "fail", code: 98 });
  });

  it("accepts a call signed for the public URL and for its own URL", async () => {
    const { app } = setup();
    const q1 = signed("GET", `${BASE}/services/rest`, restParams("flickr.photos.getInfo", { photo_id: "53000000001" }), { token: "t", secret: "ts" });
    const r1 = await request(app).get(`/fake-flickr/services/rest?${q1}`);
    expect(r1.body).toMatchObject({ stat: "ok", photo: { id: "53000000001", visibility: { ispublic: 0 } } });
    const q2 = signed("GET", "http://stack.internal/fake-flickr/services/rest", restParams("flickr.photos.getPerms", { photo_id: "53000000011" }), { token: "t", secret: "ts" });
    const r2 = await request(app).get(`/fake-flickr/services/rest?${q2}`).set("host", "stack.internal");
    expect(r2.body).toMatchObject({ stat: "ok", perms: { id: "53000000011", ispublic: 1 } });
  });

  it("setPerms requires POST and updates the photo", async () => {
    const { app, photos } = setup();
    const p = restParams("flickr.photos.setPerms", { photo_id: "53000000002", is_public: "1", is_friend: "0", is_family: "0" });
    const viaGet = await request(app).get(`/fake-flickr/services/rest?${signed("GET", `${BASE}/services/rest`, p, { token: "t", secret: "ts" })}`);
    expect(viaGet.body.stat).toBe("fail");
    expect(photos.get("53000000002")?.isPublic).toBe(false);
    const res = await request(app)
      .post("/fake-flickr/services/rest")
      .type("form")
      .send(signed("POST", `${BASE}/services/rest`, p, { token: "t", secret: "ts" }));
    expect(res.body).toEqual({ stat: "ok" });
    expect(photos.get("53000000002")?.isPublic).toBe(true);
  });

  it("a tampered parameter fails the signature", async () => {
    const { app } = setup();
    const q = signed("GET", `${BASE}/services/rest`, restParams("flickr.photos.getInfo", { photo_id: "53000000001" }), { token: "t", secret: "ts" });
    const res = await request(app).get(`/fake-flickr/services/rest?${q.replace("53000000001", "53000000002")}`);
    expect(res.body).toMatchObject({ stat: "fail", code: 98 });
  });

  it("oEmbed: private → 404, public → JSON with the static URL", async () => {
    const { app, photos } = setup();
    const priv = await request(app).get("/fake-flickr/services/oembed").query({ url: `${BASE}/photos/bcgovphotos/53000000001/`, format: "json" });
    expect(priv.status).toBe(404);
    const pub = photos.get("53000000012")!;
    const res = await request(app).get("/fake-flickr/services/oembed").query({ url: `https://www.flickr.com/photos/bcgovphotos/${pub.id}/`, format: "json" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "photo", version: "1.0", url: `${BASE}/static/${pub.id}_${pub.secret}_b.jpg`, author_name: "bcgovphotos" });
  });

  it("serves a JPEG for public photos only", async () => {
    const { app, photos } = setup();
    const pub = photos.get("53000000011")!;
    const res = await request(app).get(`/fake-flickr/static/${pub.id}_${pub.secret}_b.jpg`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^image\/jpeg/);
    expect([...(res.body as Buffer).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const priv = photos.get("53000000001")!;
    expect((await request(app).get(`/fake-flickr/static/${priv.id}_${priv.secret}_b.jpg`)).status).toBe(404);
    expect((await request(app).get(`/fake-flickr/static/${pub.id}_wrongsecret_b.jpg`)).status).toBe(404);
  });

  it("serves a photo page", async () => {
    const { app } = setup();
    const res = await request(app).get("/fake-flickr/photos/bcgovphotos/53000000001/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("53000000001");
  });

  it("__fake/state merges; __fake/photos adds", async () => {
    const { app, state, photos } = setup();
    const res = await request(app).post("/fake-flickr/__fake/state").send({ outageCalls: 2 });
    expect(res.body).toEqual({ refuseAuth: false, outageCalls: 2, deleted: [] });
    await request(app).post("/fake-flickr/__fake/state").send({ refuseAuth: true });
    expect(state).toEqual({ refuseAuth: true, outageCalls: 2, deleted: [] });
    expect((await request(app).post("/fake-flickr/__fake/state").send({ outageCalls: "lots" })).status).toBe(400);
    await request(app).post("/fake-flickr/__fake/photos").send({ id: "999", secret: "abc", server: "1", isPublic: true }).expect(200);
    expect(photos.get("999")).toEqual({ id: "999", secret: "abc", server: "1", isPublic: true });
  });

  it("outage returns 503 then recovers; refuseAuth fails signed calls", async () => {
    const { app, state } = setup();
    state.outageCalls = 1;
    const q = () => signed("GET", `${BASE}/services/rest`, restParams("flickr.photos.getInfo", { photo_id: "53000000001" }), { token: "t", secret: "ts" });
    expect((await request(app).get(`/fake-flickr/services/rest?${q()}`)).status).toBe(503);
    expect((await request(app).get(`/fake-flickr/services/rest?${q()}`)).body.stat).toBe("ok");
    state.refuseAuth = true;
    expect((await request(app).get(`/fake-flickr/services/rest?${q()}`)).body).toMatchObject({ stat: "fail", code: 98 });
  });

  it("runs the OAuth 1.0a three-legged flow", async () => {
    const { app } = setup();
    const rt = await request(app).get(`/fake-flickr/services/oauth/request_token?${signed("GET", `${BASE}/services/oauth/request_token`, { oauth_callback: "oob" })}`);
    expect(rt.status).toBe(200);
    const rtp = new URLSearchParams(rt.text);
    expect(rtp.get("oauth_callback_confirmed")).toBe("true");
    const token = rtp.get("oauth_token")!;
    const secret = rtp.get("oauth_token_secret")!;
    const auth = await request(app).get("/fake-flickr/services/oauth/authorize").query({ oauth_token: token, perms: "write" });
    expect(auth.text).toContain("123-456-789");
    const bad = await request(app).get(`/fake-flickr/services/oauth/access_token?${signed("GET", `${BASE}/services/oauth/access_token`, { oauth_verifier: "123-456-789" }, { token, secret: "wrong" })}`);
    expect(bad.status).toBe(401);
    const at = await request(app).get(`/fake-flickr/services/oauth/access_token?${signed("GET", `${BASE}/services/oauth/access_token`, { oauth_verifier: "123-456-789" }, { token, secret })}`);
    expect(at.status).toBe(200);
    expect(at.text).toBe("fullname=Fake%20Flickr&oauth_token=t&oauth_token_secret=ts&user_nsid=12345%40N00&username=bcgovphotos");
  });
});
