import { z } from "zod";
import { parseEnv } from "./env";

/** TRUST_PROXY_HOPS: how many reverse proxies sit in front of the app and append to
 * X-Forwarded-For (Express's "trust proxy" hop count). 1 is today's behaviour everywhere
 * (OpenShift router, SiteGround nginx, local IIS); 2 is a DMZ proxy in front of IIS. */
export const trustProxyHopsSchema = z
  .string()
  .regex(/^[0-5]$/, "TRUST_PROXY_HOPS must be a whole number from 0 to 5")
  .transform(Number);

/** Reads TRUST_PROXY_HOPS from an env view; unset or empty means 1. Throws a clear error otherwise. */
export function trustProxyHopsFrom(env: NodeJS.ProcessEnv): number {
  return parseEnv(z.object({ TRUST_PROXY_HOPS: trustProxyHopsSchema.default("1") }), { TRUST_PROXY_HOPS: env.TRUST_PROXY_HOPS || undefined }).TRUST_PROXY_HOPS;
}
