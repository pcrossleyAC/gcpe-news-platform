import { createHash, timingSafeEqual } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { verifyPassword } from "@gcpe/auth";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { subscribers, subscriptions } from "../db/schema";
import { lookupEmailSchema, normaliseEmail } from "../subscribe/info";
import { safeErrorLabel } from "../subscribe/journeys";

/** Legacy `Gcpe.NewsOnDemand.Library.SubscriberInfo` shape (C55): PascalCase keys, unlike
 * every other NoD response. Media Hub's Membership tab reads `SubscribedCategories` and
 * `EmailAddress` directly off this. */
export interface LegacySubscriberInfo {
  EmailAddress: string;
  SubscribedCategories: Record<string, string[]>;
  IsAllNews: boolean;
  IsAsItHappens: boolean;
  IsDailyDigest: boolean;
  IsAdminRegistration: boolean;
  NotifyIfNewCategories: boolean;
  ExpiredLinkOrUnverifiedEmail: boolean;
}

/** Credentials this route checks every request against — `MEMBERSHIP_API_USERNAME` and
 * `MEMBERSHIP_API_PASSWORD_HASH` (a `scrypt$...` string from `npm run nod:membership-hash`).
 * `null` (either env var unset) means the route answers 503 instead of ever comparing
 * credentials. */
export interface MembershipAuth {
  username: string;
  passwordHash: string;
}

const emptyInfo = (emailAddress: string): LegacySubscriberInfo => ({
  EmailAddress: emailAddress,
  SubscribedCategories: {},
  IsAllNews: false,
  IsAsItHappens: false,
  IsDailyDigest: false,
  IsAdminRegistration: false,
  NotifyIfNewCategories: false,
  ExpiredLinkOrUnverifiedEmail: false,
});

/** Unlike the public `infoFor` (subscribe/info.ts), this is a staff-facing service endpoint
 * (global constraints: "Membership endpoint") — every category the subscriber has is
 * reported, media lists included. Only `active`/`disabled` subscribers count; anyone else
 * (not found, `pending`, `deleted`) reads exactly like an unknown email. */
async function membershipInfoFor(db: DbOrTx, emailAddress: string): Promise<LegacySubscriberInfo> {
  const email = normaliseEmail(emailAddress);
  const [s] = await db.select().from(subscribers).where(sql`lower(${subscribers.email}) = ${email}`);
  if (!s || (s.status !== "active" && s.status !== "disabled")) return emptyInfo(emailAddress);

  const subs = await db.select({ listKey: subscriptions.listKey }).from(subscriptions).where(eq(subscriptions.subscriberId, s.id)).orderBy(asc(subscriptions.listKey));
  const subscribedCategories: Record<string, string[]> = {};
  for (const { listKey } of subs) {
    if (listKey === "*") continue;
    const i = listKey.indexOf(":");
    (subscribedCategories[listKey.slice(0, i)] ??= []).push(listKey.slice(i + 1));
  }
  return {
    EmailAddress: s.email,
    SubscribedCategories: subscribedCategories,
    IsAllNews: subs.some((r) => r.listKey === "*"),
    IsAsItHappens: s.asItHappens,
    IsDailyDigest: s.digest,
    IsAdminRegistration: s.source !== "self",
    NotifyIfNewCategories: false,
    ExpiredLinkOrUnverifiedEmail: false,
  };
}

/** Hashes both sides to a fixed-length digest before `timingSafeEqual`, so comparing usernames
 * of different lengths never short-circuits early (brief: "hash both or pad to equal
 * length") -- same reasoning as the scrypt password compare below. */
function constantTimeStringEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

function parseBasicAuth(header: string | undefined): { username: string; password: string } | null {
  const match = header ? /^Basic\s+(.+)$/i.exec(header) : null;
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep === -1) return null;
  return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

/** Always runs the scrypt comparison, even when the username is already known to be wrong, so
 * a wrong username costs the same as a wrong password (same anti-timing-tell reasoning as
 * `localLoginRouter`, packages/auth/src/local.ts). */
async function credentialsMatch(creds: { username: string; password: string }, auth: MembershipAuth): Promise<boolean> {
  const usernameOk = constantTimeStringEqual(creds.username, auth.username);
  const passwordOk = await verifyPassword(creds.password, auth.passwordHash);
  return usernameOk && passwordOk;
}

function unauthorized(res: Response): void {
  res.set("WWW-Authenticate", 'Basic realm="NoD"');
  res.status(401).json({ error: "unauthorized" });
}

async function handle(db: Db, auth: MembershipAuth | null, req: Request, res: Response): Promise<void> {
  if (!auth) {
    res.status(503).json({ error: "membership endpoint not configured" });
    return;
  }

  const creds = parseBasicAuth(req.get("authorization"));
  if (!creds || !(await credentialsMatch(creds, auth))) return void unauthorized(res);

  const raw = req.query.emailAddress;
  // Trimmed but not lowercased: legacy echoes an unknown address back as the caller sent it,
  // and Media Hub may compare it case-sensitively. The lookup itself is case-insensitive.
  const parsed = typeof raw === "string" ? lookupEmailSchema.safeParse(raw) : undefined;
  if (!parsed || !parsed.success) {
    res.status(400).json({ error: "invalid emailAddress" });
    return;
  }

  res.json(await membershipInfoFor(db, parsed.data));
}

/** Legacy `Subscribe/SubscriberInformation` (C55): Media Hub's Membership tab, Basic Auth
 * against `MEMBERSHIP_API_USERNAME`/`MEMBERSHIP_API_PASSWORD_HASH`. Mounted at NoD's app root
 * (app.ts) -- stack path `/nod/Subscribe/SubscriberInformation` -- never under `/api`, so
 * `requireBearer` never runs on it. `auth: null` (either env var unset) answers 503 to every
 * request, without ever looking at credentials.
 *
 * Rate-limited per IP at 10/minute via `skipSuccessfulRequests`: a successful lookup never
 * counts against the bucket, so only a failed auth attempt (or another non-2xx response) can
 * ever trip the 429. */
export function membershipRoutes(db: Db, auth: MembershipAuth | null): Router {
  const r = Router();
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
  });

  r.get("/Subscribe/SubscriberInformation", limiter, (req, res) => {
    void handle(db, auth, req, res).catch((e: unknown) => {
      // Never e.message/e.cause.message here: membershipInfoFor's query binds the email
      // address, and a DrizzleQueryError's message embeds its bound params (same reasoning as
      // subscribe/journeys.ts's safeErrorLabel, which this reuses).
      console.error("[nod] membership route failed", safeErrorLabel(e));
      res.status(500).json({ error: "internal error" });
    });
  });
  return r;
}
