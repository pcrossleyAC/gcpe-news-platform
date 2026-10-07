import { createFakeSource, type LegacySource } from "@gcpe/legacy-import";
import type { Db } from "@gcpe/db-kit";
import { lists } from "../src/db/schema";

/** Legacy DATETIME columns come back with their UTC fields holding BC wall-clock time. */
const wall = (s: string) => new Date(`${s}Z`);

export const FIXTURE_GUIDS = {
  listAllNews: "A0000000-0000-4000-8000-000000000001",
  listHealth: "A0000000-0000-4000-8000-000000000002",
  listFinanceDeleted: "A0000000-0000-4000-8000-000000000003",
  listVictoria: "A0000000-0000-4000-8000-000000000004",
  listByName: "A0000000-0000-4000-8000-000000000005",
  listServices: "A0000000-0000-4000-8000-000000000006",
  listAlerts: "A0000000-0000-4000-8000-000000000007",
  listUnknown: "A0000000-0000-4000-8000-000000000008",
  subActive: "B0000000-0000-4000-8000-000000000001",
  subDigest: "B0000000-0000-4000-8000-000000000002",
  subDeleted: "B0000000-0000-4000-8000-000000000003",
  subDisabled: "B0000000-0000-4000-8000-000000000004",
  subMedia: "B0000000-0000-4000-8000-000000000005",
  subDuplicate: "B0000000-0000-4000-8000-000000000006",
  subInvalid: "B0000000-0000-4000-8000-000000000007",
  subNoTiming: "B0000000-0000-4000-8000-000000000008",
  subLeftMedia: "B0000000-0000-4000-8000-000000000009",
  artRelease: "C0000000-0000-4000-8000-000000000001",
  artEmergency: "C0000000-0000-4000-8000-000000000002",
  artNewsletter: "C0000000-0000-4000-8000-000000000003",
  artUnresolved: "C0000000-0000-4000-8000-000000000004",
  /** NewsRelease.Id of the release NRMS imported (news_releases.legacy_id). */
  nrmsRelease: "D0000000-0000-4000-8000-000000000001",
} as const;
const G = FIXTURE_GUIDS;

const list = (ListGuid: string, CategoryKey: string, ListKey: string, ListName: string, deleted = false) => ({ ListGuid, CategoryKey, ListKey, ListName, ListDeleted: deleted, CategoryDeleted: false });
const subscriber = (SubscriberGuid: string, EmailAddress: string, o: { self?: boolean; enabled?: boolean; deleted?: boolean; imm?: boolean; dig?: boolean; registered?: string } = {}) => ({
  SubscriberGuid,
  RegisteredDateTime: wall(o.registered ?? "2017-03-01T09:00:00"),
  EmailAddress,
  IsSelfSubscription: o.self ?? true,
  IsEnabled: o.enabled ?? true,
  IsDeleted: o.deleted ?? false,
  ImmediateDelivery: o.imm ?? true,
  DigestDelivery: o.dig ?? false,
});
const sa = (SubscriberGuid: string, imm: boolean, dig: boolean, hard = false) => ({ SubscriberGuid, ImmediateAttempted: imm, DigestAttempted: dig, HardBounced: hard });

export function legacyNodTables(): Record<string, Record<string, unknown>[]> {
  return {
    lists: [
      list(G.listAllNews, "all-news", "all-news", "All News"),
      list(G.listHealth, "ministries", "health", "Health"),
      list(G.listFinanceDeleted, "ministries", "finance", "Finance", true),
      list(G.listVictoria, "media-distribution-lists", "000-0-victoria", "000.0 - Victoria"),
      list(G.listByName, "media-distribution-lists", "old-key", "001.0 - Sample Town"),
      list(G.listServices, "services", "bc-jobs", "Sample programs"),
      { ...list(G.listAlerts, "emergency", "alerts", "Emergency Info BC Alerts", true), CategoryDeleted: true },
      list(G.listUnknown, "ministries", "nowhere", "Nowhere"),
    ],
    subscribers: [
      subscriber(G.subActive, "active@example.test"),
      subscriber(G.subDigest, "digest@example.test", { imm: false, dig: true }),
      subscriber(G.subDeleted, "deleted@example.test", { deleted: true, enabled: false }),
      subscriber(G.subDisabled, "disabled@example.test", { enabled: false }),
      subscriber(G.subMedia, "Journo@Example.test", { self: false }),
      subscriber(G.subDuplicate, " ACTIVE@example.test ", { deleted: true, registered: "2024-01-01T09:00:00" }),
      subscriber(G.subInvalid, "not-an-address"),
      subscriber(G.subNoTiming, "notiming@example.test", { imm: false, dig: false }),
      subscriber(G.subLeftMedia, "left@example.test"),
    ],
    subscriberLists: [
      { SubscriberGuid: G.subActive, ListGuid: G.listAllNews },
      { SubscriberGuid: G.subActive, ListGuid: G.listHealth },
      { SubscriberGuid: G.subActive, ListGuid: G.listFinanceDeleted },
      { SubscriberGuid: G.subActive, ListGuid: G.listServices },
      { SubscriberGuid: G.subDigest, ListGuid: G.listHealth },
      { SubscriberGuid: G.subDeleted, ListGuid: G.listHealth },
      { SubscriberGuid: G.subDisabled, ListGuid: G.listHealth },
      { SubscriberGuid: G.subMedia, ListGuid: G.listVictoria },
      { SubscriberGuid: G.subMedia, ListGuid: G.listByName },
      { SubscriberGuid: G.subDuplicate, ListGuid: G.listHealth },
      { SubscriberGuid: G.subInvalid, ListGuid: G.listHealth },
      { SubscriberGuid: G.subNoTiming, ListGuid: G.listHealth },
      { SubscriberGuid: G.subLeftMedia, ListGuid: G.listHealth },
    ],
    ended: [{ SubscriberGuid: G.subDeleted, EndedAt: wall("2026-05-01T10:00:00") }],
    unsubscribed: [],
    mediaListLeaves: [
      { SubscriberGuid: G.subLeftMedia, ListGuid: G.listVictoria, LeftAt: wall("2026-04-01T09:00:00") },
      { SubscriberGuid: G.subMedia, ListGuid: G.listVictoria, LeftAt: wall("2025-01-01T09:00:00") },
    ],
    unconfirmedSignups: [{ Signups: 26 }],
    digestEnd: [{ ConfigValue: "2026-10-06T00:02:41.8472105+00:00" }],
    articles: [
      { ArticleGuid: G.artRelease, ArticleSourceID: `uuid:${G.nrmsRelease.toLowerCase()}`, RelativeUri: "news.example.test/1", PublishDateTimeUtc: new Date("2026-10-01T17:00:00Z"), IsDeleted: false, Title: "Sample release" },
      { ArticleGuid: G.artEmergency, ArticleSourceID: "https://emergency.example.test/?p=77", RelativeUri: "https://emergency.example.test/alerts/77", PublishDateTimeUtc: new Date("2026-10-02T17:00:00Z"), IsDeleted: false, Title: "Sample alert" },
      { ArticleGuid: G.artNewsletter, ArticleSourceID: "newsletter-1", RelativeUri: null, PublishDateTimeUtc: new Date("2026-10-03T17:00:00Z"), IsDeleted: false, Title: "Sample newsletter" },
      { ArticleGuid: G.artUnresolved, ArticleSourceID: "uuid:ffffffff-ffff-4fff-8fff-ffffffffffff", RelativeUri: null, PublishDateTimeUtc: new Date("2026-10-04T17:00:00Z"), IsDeleted: false, Title: "Unknown release" },
    ],
    articleLists: [
      { ArticleGuid: G.artRelease, ListGuid: G.listHealth },
      { ArticleGuid: G.artRelease, ListGuid: G.listVictoria },
      { ArticleGuid: G.artEmergency, ListGuid: G.listAlerts },
      { ArticleGuid: G.artNewsletter, ListGuid: G.listServices },
      { ArticleGuid: G.artUnresolved, ListGuid: G.listHealth },
    ],
    [`subscriberArticles:${G.artRelease.toLowerCase()}`]: [
      sa(G.subActive, true, false),
      sa(G.subDigest, true, true),
      sa(G.subMedia, true, false),
      sa(G.subDuplicate, true, false),
      sa(G.subNoTiming, true, true),
      sa(G.subLeftMedia, true, false, true),
    ],
    [`subscriberArticles:${G.artEmergency.toLowerCase()}`]: [sa(G.subDigest, true, true)],
  };
}

export function legacyNodSource(tables: Record<string, Record<string, unknown>[]> = legacyNodTables()): LegacySource {
  return createFakeSource(tables);
}

/** The NoD lists Core and NRMS would already have sent by the time the importer runs. */
export async function seedNodListsForImport(db: Db): Promise<void> {
  await db
    .insert(lists)
    .values([
      { listKey: "ministries:health", category: "ministries", key: "health", name: "Health" },
      { listKey: "media-distribution-lists:000-0-victoria", category: "media-distribution-lists", key: "000-0-victoria", name: "000.0 - Victoria" },
      { listKey: "media-distribution-lists:sample-town", category: "media-distribution-lists", key: "sample-town", name: "001.0 - Sample Town" },
    ])
    .onConflictDoNothing();
}
