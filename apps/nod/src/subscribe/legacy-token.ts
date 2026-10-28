import { hashToken } from "./tokens";

const URL_TOKEN = /^[A-Za-z0-9_-]{22}2$/;
const BARE_GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The legacy SubscriberLink.LinkGuid a manage token stands for, as a lowercase hyphenated GUID,
 * or null. Accepts .NET's `HttpServerUtility.UrlTokenEncode(guid.ToByteArray())` (22 base64url
 * chars + the pad-count digit, always "2" for 16 bytes) or the bare GUID of `subscribe.aspx?guid=`.
 * Never throws: the shape is checked by regex before any decoding.
 */
export function legacyLinkGuid(token: string): string | null {
  if (typeof token !== "string") return null;
  if (BARE_GUID.test(token)) return token.toLowerCase();
  if (!URL_TOKEN.test(token)) return null;
  const b64 = token.slice(0, 22).replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Buffer.from(`${b64}==`, "base64");
  // Reject non-canonical encodings (stray trailing bits) so one GUID has one token.
  if (bytes.length !== 16 || bytes.toString("base64") !== `${b64}==`) return null;
  const h = bytes.toString("hex");
  const le = (s: string) => s.match(/../g)!.reverse().join("");
  return `${le(h.slice(0, 8))}-${le(h.slice(8, 12))}-${le(h.slice(12, 16))}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** token_hash of an imported legacy link; the prefix keeps it apart from any issued token's hash. */
export const legacyTokenHash = (linkGuid: string): string => hashToken(`legacy:${linkGuid}`);
