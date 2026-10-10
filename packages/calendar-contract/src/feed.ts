import { z } from "zod";
import type { ChangeAction } from "./enums";
import { bcDateSchema, safeString } from "./input";

/**
 * The history actions the updates feed shows: legacy's NewsFeed kinds add, change, review, delete
 * and clone (Activity.aspx.cs:1051-1567). Legacy wrote no feed entry for Transfer or Clear LA Status.
 */
export const FEED_ACTIONS = ["created", "updated", "reviewed", "deleted", "cloned"] as const satisfies readonly ChangeAction[];
export type FeedAction = (typeof FEED_ACTIONS)[number];

/** History.aspx's views; legacy had no "since last visit" (spec addendum §17). */
export const FEED_MODES = ["latest", "today", "range", "activity"] as const;
export type FeedMode = (typeof FEED_MODES)[number];

/** "Latest 5 updates" (GetCorpCalendarUpdates: TOP 5). */
export const FEED_LATEST_COUNT = 5;
/** Every view answers at most this many entries (spec addendum §9.1; legacy capped the date range at 1,000). */
export const FEED_MAX_ITEMS = 1000;
export const FEED_KEYWORD_MAX = 200;

const activityParam = z
  .string()
  .regex(/^\d{1,9}$/, "a whole number")
  .transform(Number)
  .pipe(z.number().int().positive());

/** `GET /calendar/api/updates`'s query string. Each view takes only its own parameters. */
export const feedQuerySchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("latest") }).strict(),
    z.object({ mode: z.literal("today") }).strict(),
    z
      .object({
        mode: z.literal("range"),
        from: bcDateSchema.optional(),
        to: bcDateSchema.optional(),
        type: z.enum(FEED_ACTIONS).optional(),
        keyword: safeString()
          .max(FEED_KEYWORD_MAX)
          .transform((s) => s.trim())
          .optional(),
      })
      .strict(),
    z.object({ mode: z.literal("activity"), activity: activityParam }).strict(),
  ])
  .superRefine((q, ctx) => {
    if (q.mode === "range" && q.from && q.to && q.to < q.from) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "From must be on or before To", path: ["to"] });
    }
  });
export type FeedQuery = z.infer<typeof feedQuerySchema>;

/**
 * One entry (spec addendum §9.1). The activity's facts are its current values; the actor's name is
 * the one stored when the change was made. No field values and no email, ever (C135).
 */
export interface FeedItem {
  /** The history entry's id. */
  id: number;
  at: string;
  action: FeedAction;
  actorName: string;
  activityId: number;
  ministryAbbreviation: string | null;
  title: string;
  details: string;
  startAt: string | null;
  endAt: string | null;
  isAllDay: boolean;
  isConfirmed: boolean;
  potentialDates: string | null;
  isDeleted: boolean;
}

export interface FeedPage {
  /** "activity" also when a date range's keyword named an activity (CorporateCalendarUpdateWebService.asmx.cs:191-199). */
  mode: FeedMode;
  activityId: number | null;
  items: FeedItem[];
  /** More entries matched than FEED_MAX_ITEMS. */
  truncated: boolean;
}
