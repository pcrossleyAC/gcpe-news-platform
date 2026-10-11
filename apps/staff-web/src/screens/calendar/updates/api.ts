import type { FeedPage, FeedQuery } from "@gcpe/calendar-contract";
import { apiFetch } from "../../../api/client";
import { paramsOf } from "./url";

/** The updates feed's one call (spec addendum §9.1). */
export const feedApi = {
  read: (q: FeedQuery) => apiFetch<FeedPage>(`/calendar/api/updates?${paramsOf(q).toString()}`),
};
