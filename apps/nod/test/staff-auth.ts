import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { BearerOptions } from "@gcpe/auth";

const issuer = "https://login.microsoftonline.com/t/v2.0";
const audience = "api://nod";

/** An Entra-shaped bearer setup for route tests: `auth` goes to createApp, `token(roles)` signs
 * a five-minute token carrying those roles and a display name (what actorOf() records). */
export async function staffAuth(): Promise<{ auth: BearerOptions; token(roles: string[], name?: string): Promise<string> }> {
  const pair = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
  return {
    auth: { issuer, audience, keys },
    token: (roles, name = "Jamie Staff") =>
      new SignJWT({ roles, name })
        .setProtectedHeader({ alg: "RS256", kid: "k" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject("staff-1")
        .setExpirationTime("5m")
        .sign(pair.privateKey),
  };
}
