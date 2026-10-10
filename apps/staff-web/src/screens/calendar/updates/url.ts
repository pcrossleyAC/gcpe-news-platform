import { FEED_ACTIONS, FEED_KEYWORD_MAX, type FeedAction, type FeedQuery } from "@gcpe/calendar-contract";
import { isValidBcDate } from "../list/dates";

/** What the address asks for, or why it can't be read. No `mode` is Today's updates, the page's opening view (History.aspx). */
export function feedQueryOf(params: URLSearchParams): { query: FeedQuery } | { problem: string } {
  const mode = params.get("mode") ?? "today";
  if (mode === "latest" || mode === "today") return { query: { mode } };
  if (mode === "activity") {
    const a = params.get("activity") ?? "";
    return /^\d{1,9}$/.test(a) && Number(a) > 0 ? { query: { mode, activity: Number(a) } } : { problem: "That address doesn't name an activity." };
  }
  if (mode !== "range") return { problem: "That address isn't one of the updates views." };
  const from = params.get("from") || undefined;
  const to = params.get("to") || undefined;
  const type = params.get("type") || undefined;
  const keyword = (params.get("keyword") ?? "").trim() || undefined;
  if ((from && !isValidBcDate(from)) || (to && !isValidBcDate(to))) return { problem: "Enter dates as YYYY-MM-DD." };
  if (from && to && to < from) return { problem: "From must be on or before To." };
  if (type && !(FEED_ACTIONS as readonly string[]).includes(type)) return { problem: "Choose an update type from the list." };
  if (keyword && keyword.length > FEED_KEYWORD_MAX) return { problem: `Search for at most ${FEED_KEYWORD_MAX} characters.` };
  return { query: { mode, from, to, type: type as FeedAction | undefined, keyword } };
}

/** The address of a view: only what it sets. */
export function paramsOf(q: FeedQuery): URLSearchParams {
  const p = new URLSearchParams({ mode: q.mode });
  if (q.mode === "activity") p.set("activity", String(q.activity));
  if (q.mode === "range") {
    if (q.from) p.set("from", q.from);
    if (q.to) p.set("to", q.to);
    if (q.type) p.set("type", q.type);
    if (q.keyword) p.set("keyword", q.keyword);
  }
  return p;
}
