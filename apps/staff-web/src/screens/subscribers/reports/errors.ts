import { ApiError } from "../../../api/client";

export function reportErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    const code = (e.body as { error?: string } | undefined)?.error;
    if (e.status === 400 && code === "range-too-long") return "Choose a range of 92 days or fewer.";
    if (e.status === 400 && code === "range-reversed") return "The start date must be on or before the end date.";
    if (e.status === 400 && code === "invalid-date") return "Enter real dates.";
    if (e.status === 403) return "You don't have permission to view this report.";
    if (e.status === 404) return "That list doesn't exist any more.";
    if (e.status === 502) return "Distribution is unavailable right now. Try again in a few minutes.";
  }
  return "Couldn't load the report. Try again.";
}
