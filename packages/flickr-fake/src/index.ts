import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";

/**
 * A fake Flickr that checks OAuth 1.0a signatures the way the real one does, so a wrong secret or
 * an unsigned call fails here too. Mounted by the stack at /fake-flickr; never used in production.
 */

export interface FakePhoto {
  id: string;
  secret: string;
  server: string;
  isPublic: boolean;
}

export interface FakeFlickrOptions {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
  /** Absolute public base the oEmbed "url" points at, e.g. https://boxs.ca/fake-flickr */
  publicBaseUrl: string;
  photos?: FakePhoto[];
}

export interface FakeFlickrState {
  refuseAuth: boolean;
  outageCalls: number;
  deleted: string[];
}

const USER = "bcgovphotos";
const VERIFIER = "123-456-789";

/** A 2×2 grey baseline JPEG. */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAAAgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAgACAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAGxsbGxsbLxsbL0IvLy9CWUJCQkJZcFlZWVlZcIhwcHBwcHCIiIiIiIiIiKOjo6Ojo76+vr6+1dXV1dXV1dXV1f/bAEMBISMjNjI2XTIyXd+XfJff39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f3//dAAQAAf/aAAwDAQACEQMRAD8AdRRRQB//2Q==",
  "base64",
);

function defaultPhotos(): FakePhoto[] {
  const mk = (id: string, isPublic: boolean): FakePhoto => ({ id, secret: `f1a2${id.slice(-4)}`, server: "65535", isPublic });
  return [
    ...["53000000001", "53000000002", "53000000003", "53000000004", "53000000005"].map((id) => mk(id, false)),
    ...["53000000011", "53000000012"].map((id) => mk(id, true)),
  ];
}

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function signature(method: string, url: string, params: [string, string][], consumerSecret: string, tokenSecret: string): string {
  const norm = params
    .filter(([k]) => k !== "oauth_signature")
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = `${method.toUpperCase()}&${enc(url)}&${enc(norm)}`;
  return createHmac("sha1", `${enc(consumerSecret)}&${enc(tokenSecret)}`).update(base).digest("base64");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Every request parameter as raw pairs: the query string plus, for a form POST, the body. */
function requestParams(req: express.Request): [string, string][] {
  const q = req.originalUrl.indexOf("?");
  const pairs = q >= 0 ? [...new URLSearchParams(req.originalUrl.slice(q + 1))] : [];
  if (typeof req.body === "string") pairs.push(...new URLSearchParams(req.body));
  return pairs;
}

export function createFakeFlickr(opts: FakeFlickrOptions): { router: express.Router; photos: Map<string, FakePhoto>; state: FakeFlickrState } {
  const base = opts.publicBaseUrl.replace(/\/+$/, "");
  const photos = new Map((opts.photos ?? defaultPhotos()).map((p) => [p.id, { ...p }]));
  const state: FakeFlickrState = { refuseAuth: false, outageCalls: 0, deleted: [] };
  /** Request-token secrets issued by request_token, keyed by token. */
  const requestTokens = new Map<string, string>();
  const router = express.Router();

  const livePhoto = (id: string | undefined) => (id && !state.deleted.includes(id) ? photos.get(id) : undefined);

  /**
   * Verifies the OAuth 1.0a signature against the URL the client signed: the public one
   * (publicBaseUrl + path) or the one this request actually arrived on. Returns the params, or null.
   */
  function verify(req: express.Request, tokenSecretFor: (token: string | undefined) => string | undefined): Map<string, string> | null {
    const pairs = requestParams(req);
    const params = new Map<string, string>();
    for (const [k, v] of pairs) {
      if (params.has(k)) return null; // duplicate parameters are never sent by our client
      params.set(k, v);
    }
    const sig = params.get("oauth_signature");
    if (!sig || params.get("oauth_consumer_key") !== opts.apiKey || params.get("oauth_signature_method") !== "HMAC-SHA1") return null;
    const tokenSecret = tokenSecretFor(params.get("oauth_token"));
    if (tokenSecret === undefined) return null;
    const own = `${req.protocol}://${req.get("host") ?? ""}${req.originalUrl.split("?")[0]}`;
    for (const url of new Set([base + req.path, own])) {
      if (safeEqual(signature(req.method, url, pairs, opts.apiSecret, tokenSecret), sig)) return params;
    }
    return null;
  }

  const form = express.text({ type: "application/x-www-form-urlencoded" });
  const accessSecretFor = (t: string | undefined) => (t === opts.accessToken ? opts.accessSecret : undefined);

  router.all("/services/rest", form, (req, res) => {
    if (req.method !== "GET" && req.method !== "POST") return void res.status(405).end();
    if (state.outageCalls > 0) {
      state.outageCalls -= 1;
      return void res.status(503).type("text/plain").send("Service Unavailable");
    }
    const params = verify(req, accessSecretFor);
    if (state.refuseAuth || !params || params.get("api_key") !== opts.apiKey) {
      return void res.json({ stat: "fail", code: 98, message: "Invalid auth token" });
    }
    const method = params.get("method");
    const notFound = () => res.json({ stat: "fail", code: 1, message: "Photo not found" });
    if (method === "flickr.photos.getInfo") {
      const p = livePhoto(params.get("photo_id"));
      if (!p) return void notFound();
      return void res.json({ stat: "ok", photo: { id: p.id, secret: p.secret, server: p.server, visibility: { ispublic: p.isPublic ? 1 : 0, isfriend: 0, isfamily: 0 } } });
    }
    if (method === "flickr.photos.getPerms") {
      const p = livePhoto(params.get("photo_id"));
      if (!p) return void notFound();
      return void res.json({ stat: "ok", perms: { id: p.id, ispublic: p.isPublic ? 1 : 0, isfriend: 0, isfamily: 0 } });
    }
    if (method === "flickr.photos.setPerms") {
      if (req.method !== "POST") return void res.json({ stat: "fail", code: 3, message: "Method requires POST" });
      const p = livePhoto(params.get("photo_id"));
      if (!p) return void notFound();
      p.isPublic = params.get("is_public") === "1";
      return void res.json({ stat: "ok" });
    }
    res.json({ stat: "fail", code: 112, message: "Method not found" });
  });

  const photoIdOf = (url: string) => /\/photos\/[^/?#]+\/(\d+)/.exec(url)?.[1];

  router.get("/services/oembed", (req, res) => {
    const url = typeof req.query.url === "string" ? req.query.url : "";
    const p = livePhoto(photoIdOf(url));
    if (!p || !p.isPublic) return void res.status(404).type("text/plain").send("Not found");
    res.json({
      type: "photo", version: "1.0", url: `${base}/static/${p.id}_${p.secret}_b.jpg`, width: 1024, height: 768,
      title: `Fake photo ${p.id}`, author_name: USER,
    });
  });

  router.get("/static/:file", (req, res) => {
    const m = /^(\d+)_([^_]+)_b\.jpg$/.exec(req.params.file);
    const p = m ? livePhoto(m[1]) : undefined;
    if (!m || !p || !p.isPublic || p.secret !== m[2]) return void res.status(404).type("text/plain").send("Not found");
    res.type("image/jpeg").send(TINY_JPEG);
  });

  router.get("/photos/:user/:id", (req, res) => {
    const id = escapeHtml(req.params.id);
    res.type("html").send(`<!doctype html><html><head><title>Fake photo ${id}</title></head><body><h1>Fake photo ${id}</h1><p>by ${escapeHtml(req.params.user)}</p></body></html>`);
  });

  const oauthFail = (res: express.Response) => res.status(401).type("text/plain").send("oauth_problem=signature_invalid");

  router.get("/services/oauth/request_token", (req, res) => {
    const params = verify(req, (t) => (t === undefined ? "" : undefined));
    if (state.refuseAuth || !params || !params.get("oauth_callback")) return void oauthFail(res);
    const token = randomBytes(8).toString("hex");
    const secret = randomBytes(8).toString("hex");
    requestTokens.set(token, secret);
    res.type("text/plain").send(`oauth_callback_confirmed=true&oauth_token=${token}&oauth_token_secret=${secret}`);
  });

  router.get("/services/oauth/authorize", (req, res) => {
    const token = typeof req.query.oauth_token === "string" ? req.query.oauth_token : "";
    if (!requestTokens.has(token)) return void res.status(400).type("text/plain").send("Unknown request token");
    res.type("html").send(`<!doctype html><html><head><title>Fake Flickr authorization</title></head><body><h1>Fake Flickr</h1><p>Authorized. Your verifier code is:</p><p id="verifier">${VERIFIER}</p></body></html>`);
  });

  router.get("/services/oauth/access_token", (req, res) => {
    const params = verify(req, (t) => (t ? requestTokens.get(t) : undefined));
    if (state.refuseAuth || !params || params.get("oauth_verifier") !== VERIFIER) return void oauthFail(res);
    requestTokens.delete(params.get("oauth_token")!);
    res
      .type("text/plain")
      .send(`fullname=Fake%20Flickr&oauth_token=${enc(opts.accessToken)}&oauth_token_secret=${enc(opts.accessSecret)}&user_nsid=12345%40N00&username=${USER}`);
  });

  const json = express.json();

  router.post("/__fake/state", json, (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ok =
      typeof b === "object" &&
      (b.refuseAuth === undefined || typeof b.refuseAuth === "boolean") &&
      (b.outageCalls === undefined || (Number.isInteger(b.outageCalls) && (b.outageCalls as number) >= 0)) &&
      (b.deleted === undefined || (Array.isArray(b.deleted) && b.deleted.every((d) => typeof d === "string")));
    if (!ok) return void res.status(400).json({ error: "invalid state" });
    if (b.refuseAuth !== undefined) state.refuseAuth = b.refuseAuth as boolean;
    if (b.outageCalls !== undefined) state.outageCalls = b.outageCalls as number;
    if (b.deleted !== undefined) state.deleted = [...(b.deleted as string[])];
    res.json(state);
  });

  router.post("/__fake/photos", json, (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ok = ["id", "secret", "server"].every((k) => typeof b[k] === "string" && /^[A-Za-z0-9]+$/.test(b[k] as string)) && typeof b.isPublic === "boolean";
    if (!ok) return void res.status(400).json({ error: "invalid photo" });
    const p: FakePhoto = { id: b.id as string, secret: b.secret as string, server: b.server as string, isPublic: b.isPublic as boolean };
    photos.set(p.id, p);
    res.json(p);
  });

  return { router, photos, state };
}
