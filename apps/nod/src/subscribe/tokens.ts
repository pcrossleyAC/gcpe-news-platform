import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const newLinkToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mac = (secret: string, id: string, version: number) =>
  createHmac("sha256", secret).update(`nod-unsubscribe:${id}:${version}`).digest("base64url");

/** Stable per-subscriber unsubscribe token for `List-Unsubscribe` (C48): `<id>.<version>.<mac>`.
 * Derived, never stored. A change of address bumps `subscribers.unsubscribe_version`, so mail sent
 * from then on carries a new token; `unsubscribe()` still honours the earlier ones, and nothing
 * else accepts any of them. */
export function unsubscribeToken(secret: string, subscriberId: string, version: number): string {
  return `${subscriberId}.${version}.${mac(secret, subscriberId, version)}`;
}

export function parseUnsubscribeToken(secret: string, token: string): { subscriberId: string; version: number } | null {
  const [id, v, sig, ...rest] = token.split(".");
  if (rest.length || !id || !v || !sig || !UUID.test(id) || !/^\d{1,9}$/.test(v)) return null;
  const version = Number(v);
  const expected = Buffer.from(mac(secret, id, version));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { subscriberId: id, version };
}
