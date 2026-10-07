import { createHash } from "node:crypto";
import { wallClockToInstant } from "@gcpe/config";
import type { DeliveryMode, SubscriberSource, SubscriberStatus } from "../db/schema";
import { emailAddressSchema, normaliseEmail } from "../subscribe/info";

export const ALL_NEWS_KEY = "*";
export const MEDIA_CATEGORY_KEY = "media-distribution-lists";
export const EMERGENCY_CATEGORY_KEY = "emergency";
const CARRIED_CATEGORIES = new Set(["ministries", "sectors", "themes", "tags", EMERGENCY_CATEGORY_KEY, MEDIA_CATEGORY_KEY]);

/** SQL Server hands GUIDs back upper-case; NoD's uuids and every map here are lower-case. */
export const guidKey = (g: string): string => g.trim().toLowerCase();

export interface LegacyListRow {
  ListGuid: string;
  ListKey: string;
  ListName: string;
  ListDeleted: boolean;
  CategoryKey: string;
  CategoryDeleted: boolean;
}
export interface NodListRow {
  listKey: string;
  category: string;
  name: string;
}
export interface MappedList {
  listKey: string;
  media: boolean;
}
export interface ListMapping {
  /** Legacy ListGuid → the NoD list it is carried to. */
  byGuid: Map<string, MappedList>;
  /** Legacy ListGuid → why it isn't. */
  skipped: Map<string, string>;
  /** Legacy ListGuid → its legacy category, carried or not (articles are classified by it). */
  categoryOf: Map<string, string>;
}

/**
 * Legacy lists → NoD's own `lists` rows (which Core and NRMS already filled). `<category>:<key>`
 * matches case-insensitively; a media list whose key differs (legacy keys were matched to Hub's by
 * hand) matches by its exact name. Deleted lists, categories that never became part of this
 * platform, and anything with no NoD match are skipped by reason.
 */
export function mapLists(legacy: LegacyListRow[], nod: NodListRow[]): ListMapping {
  const byKey = new Map(nod.map((l) => [l.listKey.toLowerCase(), l]));
  const mediaByName = new Map(nod.filter((l) => l.category === MEDIA_CATEGORY_KEY).map((l) => [l.name.trim().toLowerCase(), l]));
  const out: ListMapping = { byGuid: new Map(), skipped: new Map(), categoryOf: new Map() };
  for (const l of legacy) {
    const guid = guidKey(l.ListGuid);
    const category = l.CategoryKey.trim().toLowerCase();
    out.categoryOf.set(guid, category);
    if (l.ListDeleted || l.CategoryDeleted) out.skipped.set(guid, "list or its category is deleted in legacy");
    else if (category === "all-news") out.byGuid.set(guid, { listKey: ALL_NEWS_KEY, media: false });
    else if (!CARRIED_CATEGORIES.has(category)) out.skipped.set(guid, `category "${category}" is not carried over`);
    else {
      const found = byKey.get(`${category}:${l.ListKey.trim().toLowerCase()}`) ?? (category === MEDIA_CATEGORY_KEY ? mediaByName.get(l.ListName.trim().toLowerCase()) : undefined);
      if (found) out.byGuid.set(guid, { listKey: found.listKey, media: category === MEDIA_CATEGORY_KEY });
      else out.skipped.set(guid, "no matching NoD list");
    }
  }
  return out;
}

export interface LegacySubscriberRow {
  SubscriberGuid: string;
  /** Legacy DATETIME: BC wall clock, handed back with its UTC fields holding it. */
  RegisteredDateTime: Date;
  EmailAddress: string;
  IsSelfSubscription: boolean;
  IsEnabled: boolean;
  IsDeleted: boolean;
  ImmediateDelivery: boolean;
  DigestDelivery: boolean;
}

export function legacyStatus(s: Pick<LegacySubscriberRow, "IsEnabled" | "IsDeleted">): SubscriberStatus {
  return s.IsDeleted ? "deleted" : s.IsEnabled ? "active" : "disabled";
}

const RANK: Record<SubscriberStatus, number> = { active: 0, disabled: 1, pending: 2, deleted: 3 };

/** One record per address (legacy's column isn't unique): active over disabled over deleted,
 * then the newest registration. Ids come back lower-case. */
export function pickWinners(rows: LegacySubscriberRow[]): { winners: LegacySubscriberRow[]; duplicates: string[]; invalid: string[] } {
  const invalid: string[] = [];
  const groups = new Map<string, LegacySubscriberRow[]>();
  for (const r of rows) {
    const email = normaliseEmail(r.EmailAddress ?? "");
    if (!emailAddressSchema.safeParse(email).success) {
      invalid.push(guidKey(r.SubscriberGuid));
      continue;
    }
    groups.set(email, [...(groups.get(email) ?? []), r]);
  }
  const winners: LegacySubscriberRow[] = [];
  const duplicates: string[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort(
      (a, b) =>
        RANK[legacyStatus(a)] - RANK[legacyStatus(b)] ||
        b.RegisteredDateTime.getTime() - a.RegisteredDateTime.getTime() ||
        guidKey(a.SubscriberGuid).localeCompare(guidKey(b.SubscriberGuid)),
    );
    winners.push(sorted[0]!);
    for (const d of sorted.slice(1)) duplicates.push(guidKey(d.SubscriberGuid));
  }
  return { winners, duplicates, invalid };
}

export interface SubscriberState {
  email: string;
  status: SubscriberStatus;
  asItHappens: boolean;
  digest: boolean;
  source: SubscriberSource;
  listKeys: string[];
}

/** What the importer wrote, as one hash: a re-run compares it with NoD's current state to tell
 * "untouched since import" from "changed in NoD". */
export function fingerprintOf(s: SubscriberState): string {
  return createHash("sha256")
    .update(JSON.stringify([s.email, s.status, s.asItHappens, s.digest, s.source, [...new Set(s.listKeys)].sort()]))
    .digest("hex");
}

export interface MappedSubscriber {
  id: string;
  state: SubscriberState;
  createdAt: Date;
  endedAt: Date | null;
  fingerprint: string;
}

export function mapSubscriber(s: LegacySubscriberRow, memberships: MappedList[], endedAt: Date | null, ctx: { timeZone: string; runAt: Date }): MappedSubscriber {
  const status = legacyStatus(s);
  const source: SubscriberSource = s.IsSelfSubscription ? "self" : memberships.some((m) => m.media) ? "manual-media" : "admin";
  const state: SubscriberState = {
    email: normaliseEmail(s.EmailAddress),
    status,
    asItHappens: s.ImmediateDelivery,
    digest: s.DigestDelivery,
    source,
    // An unsubscribed or deleted subscriber keeps no lists here, as after any unsubscribe in NoD.
    listKeys: status === "deleted" ? [] : [...new Set(memberships.map((m) => m.listKey))].sort(),
  };
  return {
    id: guidKey(s.SubscriberGuid),
    state,
    createdAt: wallClockToInstant(s.RegisteredDateTime, ctx.timeZone),
    // No SysLog date: the import time, so the purge waits a full 90 days after cutover.
    endedAt: status === "deleted" ? (endedAt ?? ctx.runAt) : null,
    fingerprint: fingerprintOf(state),
  };
}

/**
 * Which NoD deliveries one legacy SubscriberArticle row stands for. Legacy marks a mode the
 * subscriber doesn't take as attempted, to stop it being sent (DistributionProvider.cs:313-320),
 * so a release's modes are checked against the subscriber's own timing. A media-list member got
 * the release as a media send; an emergency alert went to everyone on its list.
 */
export function deliveryModes(
  row: { ImmediateAttempted: boolean; DigestAttempted: boolean },
  sub: { asItHappens: boolean; digest: boolean; mediaKeys: Set<string> },
  item: { kind: "release" | "emergency"; mediaListKeys: string[] },
): DeliveryMode[] {
  if (item.kind === "emergency") return row.ImmediateAttempted || row.DigestAttempted ? ["as_it_happens"] : [];
  if (row.ImmediateAttempted && item.mediaListKeys.some((k) => sub.mediaKeys.has(k))) return ["media"];
  const modes: DeliveryMode[] = [];
  if (row.ImmediateAttempted && sub.asItHappens) modes.push("as_it_happens");
  if (row.DigestAttempted && sub.digest) modes.push("digest");
  return modes;
}
