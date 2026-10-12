import { isIP } from "node:net";
import type { Request } from "express";
import { ipKeyGenerator } from "express-rate-limit";

/**
 * A rate-limit key for the client: `header`'s first address when it's a valid IP, else req.ip.
 * ipKeyGenerator groups IPv6 by subnet, so one host can't rotate through its /64 for fresh buckets.
 */
export function clientIpKey(header: string | undefined): (req: Request) => string {
  return (req) => {
    const forwarded = header ? req.get(header)?.split(",")[0]?.trim() : undefined;
    const ip = forwarded && isIP(forwarded) ? forwarded : (req.ip ?? "");
    return ipKeyGenerator(ip);
  };
}
