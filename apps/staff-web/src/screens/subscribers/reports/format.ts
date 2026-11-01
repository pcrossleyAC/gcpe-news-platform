/** Report dates and times as the CSVs show them: "YYYY-MM-DD" and "YYYY-MM-DD HH:mm", BC time. */
import { zonedDate, zonedDateTime } from "../../../format/bcTime";

export function bcDate(iso: string, timeZone: string): string {
  return zonedDate(iso, timeZone);
}
export function bcDateTime(iso: string, timeZone: string): string {
  const { date, time } = zonedDateTime(iso, timeZone);
  return `${date} ${time}`;
}
