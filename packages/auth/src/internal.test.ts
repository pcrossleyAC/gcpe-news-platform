// The stack's own app-to-app token (owner decision 2026-10-31, production configuration T2): keyed
// from STACK_EVENT_SECRET, not the break-glass admin's LOCAL_AUTH_SECRET, and accepted only on the
// stack's in-memory connections.
import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { decodeJwt, SignJWT } from "jose";
import { requireBearer, requireRole } from "./bearer";
import { INTERNAL_AUDIENCE, INTERNAL_ISSUER, INTERNAL_ORIGIN, isInternalRequest, isInternalUrl, markInternalSocket, mintInternalToken } from "./internal";
import { mintLocalToken } from "./local";

const INTERNAL_SECRET = "i".repeat(64);
const LOCAL_SECRET = "l".repeat(40);

/** An app whose routes see every request as arriving on the stack's in-memory connection, as
 * installInternalFetch makes them (apps/stack/src/internal-fetch.ts), or not. */
function app(opts: { marked: boolean; local?: boolean }) {
  const a = express();
  if (opts.marked) a.use((req, _res, next) => (markInternalSocket(req.socket), next()));
  const bearer = requireBearer({ internal: { secret: INTERNAL_SECRET }, ...(opts.local ? { local: { secret: LOCAL_SECRET } } : {}) });
  a.get("/read", bearer, (req, res) => res.json({ ...req.auth, internal: isInternalRequest(req) }));
  a.get("/count", bearer, requireRole("NoD.SubscriberCount"), (_req, res) => res.json({ ok: true }));
  return a;
}

const internalToken = (roles: string[] = ["NoD.SubscriberCount"], secret = INTERNAL_SECRET) => mintInternalToken({ secret, subject: "nrms", roles });

describe("the stack's internal service token", () => {
  it("carries the caller's own subject, azp and roles under the gcpe-internal issuer and audience", async () => {
    const claims = decodeJwt(await internalToken());
    expect(claims).toMatchObject({ iss: INTERNAL_ISSUER, aud: INTERNAL_AUDIENCE, sub: "nrms", azp: "nrms", roles: ["NoD.SubscriberCount"] });
    expect(claims.exp! - claims.iat!).toBe(3600);
  });

  it("is accepted on the stack's in-memory connection, with the role still enforced", async () => {
    const res = await request(app({ marked: true })).get("/read").set("authorization", `Bearer ${await internalToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ subject: "nrms", roles: ["NoD.SubscriberCount"], internal: true, claims: { via: "bearer", azp: "nrms" } });
    expect((await request(app({ marked: true })).get("/count").set("authorization", `Bearer ${await internalToken(["NewsApi.Similar"])}`)).status).toBe(403);
  });

  it("is refused over any real connection (IIS, the DMZ, the network), even though it is validly signed", async () => {
    const res = await request(app({ marked: false })).get("/read").set("authorization", `Bearer ${await internalToken()}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid token" });
  });

  it("is refused when signed with any other key, including the break-glass secret", async () => {
    expect((await request(app({ marked: true })).get("/read").set("authorization", `Bearer ${await internalToken(undefined, "x".repeat(64))}`)).status).toBe(401);
    expect((await request(app({ marked: true, local: true })).get("/read").set("authorization", `Bearer ${await internalToken(undefined, LOCAL_SECRET)}`)).status).toBe(401);
  });

  it("a break-glass (gcpe-local) token signed with the internal key is refused: the issuer picks the key, the key must match", async () => {
    const forged = await mintLocalToken({ secret: INTERNAL_SECRET, subject: "admin", roles: ["Core.Admin"] });
    expect((await request(app({ marked: true, local: true })).get("/read").set("authorization", `Bearer ${forged}`)).status).toBe(401);
    expect((await request(app({ marked: true })).get("/read").set("authorization", `Bearer ${forged}`)).status).toBe(401);
  });

  it("with local admin off, a break-glass token is refused while the internal token still works", async () => {
    const breakGlass = await mintLocalToken({ secret: LOCAL_SECRET, subject: "admin", roles: ["Core.Admin"] });
    expect((await request(app({ marked: true })).get("/read").set("authorization", `Bearer ${breakGlass}`)).status).toBe(401);
    expect((await request(app({ marked: true, local: true })).get("/read").set("authorization", `Bearer ${breakGlass}`)).status).toBe(200);
  });

  it("refuses a token with no expiry, or one older than its own lifetime allows", async () => {
    const key = new TextEncoder().encode(INTERNAL_SECRET);
    const noExp = await new SignJWT({ roles: [] }).setProtectedHeader({ alg: "HS256" }).setIssuer(INTERNAL_ISSUER).setAudience(INTERNAL_AUDIENCE).setSubject("nrms").setIssuedAt().sign(key);
    expect((await request(app({ marked: true })).get("/read").set("authorization", `Bearer ${noExp}`)).status).toBe(401);
    const old = Math.floor(Date.now() / 1000) - 3 * 3600;
    const stale = await new SignJWT({ roles: [] }).setProtectedHeader({ alg: "HS256" }).setIssuer(INTERNAL_ISSUER).setAudience(INTERNAL_AUDIENCE).setSubject("nrms").setIssuedAt(old).setExpirationTime(old + 365 * 86400).sign(key);
    expect((await request(app({ marked: true })).get("/read").set("authorization", `Bearer ${stale}`)).status).toBe(401);
  });

  it("refuses a weak internal secret at construction", () => {
    expect(() => requireBearer({ internal: { secret: "short" } })).toThrow(/at least 32 characters/);
  });

  it("knows the stack's in-process origin, and nothing else, as internal", () => {
    expect(INTERNAL_ORIGIN).toBe("http://stack.internal");
    expect(isInternalUrl("http://stack.internal/nod")).toBe(true);
    expect(isInternalUrl("http://stack.internal")).toBe(true);
    expect(isInternalUrl("http://stack.internal.example.com/nod")).toBe(false);
    expect(isInternalUrl("https://media-hub.example.gov.bc.ca")).toBe(false);
    expect(isInternalUrl(undefined)).toBe(false);
  });
});
