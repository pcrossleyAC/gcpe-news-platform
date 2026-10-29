import { z } from "zod";
import { parseEnv } from "./env";

/** TRUST_PROXY_HOPS: how many reverse proxies sit in front of the app and append to
 * X-Forwarded-For (Express's "trust proxy" hop count). 0 is refused: it would make every visitor behind IIS one address. 1 is today's behaviour everywhere
 * (OpenShift router, SiteGround nginx, local IIS); 2 is a DMZ proxy in front of IIS. */
export const trustProxyHopsSchema = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z
    .string()
    .regex(/^[1-5]$/, "TRUST_PROXY_HOPS must be a whole number from 1 to 5")
    .default("1")
    .transform(Number),
);

/** Reads TRUST_PROXY_HOPS from an env view; unset or empty means 1. Throws a clear error otherwise. */
export function trustProxyHopsFrom(env: NodeJS.ProcessEnv): number {
  return parseEnv(z.object({ TRUST_PROXY_HOPS: trustProxyHopsSchema }), { TRUST_PROXY_HOPS: env.TRUST_PROXY_HOPS }).TRUST_PROXY_HOPS;
}
