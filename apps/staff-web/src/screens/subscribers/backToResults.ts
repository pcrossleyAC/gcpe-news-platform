/** The Find subscribers history entry's state: the search term, kept out of the URL. */
export interface SubscribersSearchState {
  subscribersQ: string;
}

/** The results a subscriber was opened from, for its "Back to results" link. */
export interface BackToResults {
  path: string;
  state: SubscribersSearchState;
}

/** A subscriber link's history state. */
export interface SubscriberLinkState {
  backTo: BackToResults;
}

/** Only a path inside Subscribers is followed back (history state is the app's own, but a guard costs nothing). */
export function backToFrom(state: unknown): BackToResults | null {
  const backTo = (state as Partial<SubscriberLinkState> | null)?.backTo;
  return backTo && typeof backTo.path === "string" && backTo.path.startsWith("/subscribers") && !backTo.path.startsWith("//") ? backTo : null;
}
