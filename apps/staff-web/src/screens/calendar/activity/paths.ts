import { safeReturnTo } from "../../../session/safeReturnTo";

const withReturn = (path: string, returnTo?: string) => (returnTo ? `${path}?return=${encodeURIComponent(returnTo)}` : path);

/** The editor's address inside the router (basename /hub). `returnTo` is where Save, Review, Delete and Cancel go back to (C149). */
export const activityPath = (id: number | "new", returnTo?: string): string => withReturn(`/calendar/activities/${id}`, returnTo);
export const changesPath = (id: number, returnTo?: string): string => withReturn(`/calendar/activities/${id}/changes`, returnTo);

/** Only a Calendar page of this app comes back; anything else is the list. */
export function safeCalendarReturn(value: string | null): string {
  const v = safeReturnTo(value);
  return v === "/calendar" || v.startsWith("/calendar?") || v.startsWith("/calendar/") ? v : "/calendar";
}
