import { useSearchParams } from "react-router";
import type { ReportParam } from "./reportUrl";

const MAX_PAGE = 10_000;

/** A report's filters, kept in the page URL (they're dates, a list key, a timing and a page, never
 * an address). Changing anything but the page goes back to page 1. */
export function useReportParams(): {
  value(key: Exclude<ReportParam, "page">): string;
  page: number;
  update(changes: Partial<Record<ReportParam, string | null>>): void;
} {
  const [params, setParams] = useSearchParams();
  const n = Number(params.get("page"));
  const page = Number.isInteger(n) && n >= 1 && n <= MAX_PAGE ? n : 1;
  return {
    value: (key) => params.get(key) ?? "",
    page,
    update: (changes) =>
      setParams((current) => {
        const next = new URLSearchParams(current);
        if (!("page" in changes)) next.delete("page");
        for (const [key, v] of Object.entries(changes)) {
          if (v === null || v === undefined || v === "") next.delete(key);
          else next.set(key, v);
        }
        return next;
      }),
  };
}
