import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const newLinkToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mac = (secret: string, id: string, version: number) =>
  createHmac("sha256", secret).update(`nod-unsubscribe:${id}:${version}`).digest("base64url");

/** Stable per-subscriber unsubscribe token for `List-Unsubscribe` (C48): `<id>.<version>.<mac>`.
 * Derived, never stored; bumping `subscribers.unsubscribe_version` invalidates every earlier one. */
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
