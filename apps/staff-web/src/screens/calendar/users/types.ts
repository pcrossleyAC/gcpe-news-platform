import type { CalendarRoleName } from "../../admin/calendar-access/calendar-roles";

export interface CalendarUserRow {
  userId: string;
  displayName: string;
  email: string | null;
  isActive: boolean;
  role: CalendarRoleName | null;
  ministryKey: string | null;
  ministryAbbreviation: string | null;
  rank: number | null;
}
export interface Profile {
  phone: string | null;
  mobile: string | null;
  jobTitle: string | null;
  description: string | null;
}
export interface CalendarUserDetail {
  user: { id: string; displayName: string; email: string | null; isActive: boolean; role: CalendarRoleName | null; ministryKeys: string[] };
  profile: Profile;
  commContacts: { ministryKey: string; rank: number | null; isActive: boolean }[];
}

/** apps/calendar/src/users.ts's OpenActivity. */
export interface OpenActivity {
  id: number;
  reference: string;
  title: string;
  startAt: string | null;
  endAt: string | null;
  startDate: string | null;
  endDate: string | null;
}
export interface OpenActivities {
  activities: OpenActivity[];
  truncated: boolean;
}

/** Legacy's CommContactTypeSortOrder (Admin/User.aspx.cs:16-25). */
export const RANK_OPTIONS = [
  { value: "", label: "Not a comm contact" },
  { value: "1", label: "Comm Director" },
  { value: "2", label: "Comm Manager" },
  { value: "3", label: "Sr. PAO" },
  { value: "4", label: "PAO" },
  { value: "5", label: "Jr. PAO" },
  { value: "6", label: "Other" },
] as const;

/** Legacy's list label: "Full name (Abbreviation) (rank)". */
export function rowLabel(r: CalendarUserRow): string {
  return `${r.displayName}${r.ministryAbbreviation ? ` (${r.ministryAbbreviation})` : r.ministryKey ? ` (${r.ministryKey})` : ""}${r.rank ? ` (${r.rank})` : ""}${r.isActive ? "" : " — inactive"}`;
}
