/** JSON shapes of NoD's /reports routes (apps/nod/src/reports/*). */
export type TimingFilter = "any" | "as-it-happens" | "digest";
export interface TimingCounts {
  subscribers: number;
  asItHappens: number;
  digest: number;
}
export interface ByListList extends TimingCounts {
  listKey: string;
  name: string;
  active: boolean;
}
export interface SubscribersByListReport {
  all: TimingCounts;
  allNews: TimingCounts;
  categories: { key: string; name: string; lists: ByListList[] }[];
}
export interface ReportMember {
  id: string;
  email: string;
  asItHappens: boolean;
  digest: boolean;
  source: string;
  createdAt: string;
}
export interface MembersPage {
  list: string;
  listName: string;
  timing: TimingFilter;
  total: number;
  page: number;
  pageSize: number;
  items: ReportMember[];
}
export interface UnsubscribeRow {
  subscriberId: string;
  email: string;
  how: "subscriber" | "staff";
  at: string;
  status: "pending" | "active" | "disabled" | "deleted";
  registeredAt: string;
}
export interface UnsubscribesPage {
  since: string;
  summary: { subscribed: number; resubscribed: number; unsubscribed: number; staffDeleted: number };
  total: number;
  page: number;
  pageSize: number;
  items: UnsubscribeRow[];
}
