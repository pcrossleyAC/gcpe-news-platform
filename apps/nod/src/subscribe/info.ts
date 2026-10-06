import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "@gcpe/db-kit";
import { subscribers, subscriptions, type SubscriberPrefs } from "../db/schema";
import { activeListKeys, MEDIA_CATEGORY } from "../lists";

/** Legacy SubscriberInfo (docs/contracts/news-api-v1.swagger.json). Unknown fields ignored;
 * `isAdminRegistration` and `notifyIfNewCategories` are accepted but never acted on (C57, C60). */
export const subscriberInfoSchema = z.object({
  emailAddress: z.string().trim().max(150).email(),
  subscribedCategories: z.record(z.array(z.string().max(200)).max(500)).default({}),
  isAllNews: z.boolean().default(false),
  isAsItHappens: z.boolean().default(false),
  isDailyDigest: z.boolean().default(false),
  isAdminRegistration: z.boolean().default(false),
  notifyIfNewCategories: z.boolean().default(false),
  expiredLinkOrUnverifiedEmail: z.boolean().default(false),
});
export type SubscriberInfo = z.infer<typeof subscriberInfoSchema>;

export class PreferencesError extends Error {}

export const normaliseEmail = (raw: string): string => raw.trim().toLowerCase();

export async function toPrefs(db: DbOrTx, info: SubscriberInfo): Promise<{ email: string; prefs: SubscriberPrefs }> {
  if (!info.isAsItHappens && !info.isDailyDigest) throw new PreferencesError("Choose As It Happens, Daily Digest, or both.");
  const requested = info.isAllNews
    ? ["*"]
    : Object.entries(info.subscribedCategories).flatMap(([category, keys]) => keys.map((k) => `${category.toLowerCase()}:${k.toLowerCase()}`));
  const listKeys = await activeListKeys(db, requested);
  if (listKeys.length === 0) throw new PreferencesError("Choose at least one topic, or all news.");
  return { email: normaliseEmail(info.emailAddress), prefs: { allNews: listKeys.includes("*"), listKeys, asItHappens: info.isAsItHappens, digest: info.isDailyDigest } };
}

export async function infoFor(db: DbOrTx, subscriberId: string): Promise<SubscriberInfo> {
  const [s] = await db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
  if (!s) throw new Error(`subscriber ${subscriberId} not found`);
  const subs = await db.select({ listKey: subscriptions.listKey }).from(subscriptions).where(eq(subscriptions.subscriberId, subscriberId)).orderBy(asc(subscriptions.listKey));
  const subscribedCategories: Record<string, string[]> = {};
  for (const { listKey } of subs) {
    // The public manage view never shows media memberships (global constraints: "the real
    // webapp doesn't know the category").
    if (listKey === "*" || listKey.startsWith(`${MEDIA_CATEGORY}:`)) continue;
    const i = listKey.indexOf(":");
    (subscribedCategories[listKey.slice(0, i)] ??= []).push(listKey.slice(i + 1));
  }
  return {
    emailAddress: s.email,
    subscribedCategories,
    isAllNews: subs.some((r) => r.listKey === "*"),
    isAsItHappens: s.asItHappens,
    isDailyDigest: s.digest,
    isAdminRegistration: false,
    notifyIfNewCategories: false,
    expiredLinkOrUnverifiedEmail: false,
  };
}
