/** The filters a report URL may carry: dates, a list key, a timing and a page. Never an address or
 * a search term; any other key is dropped here, so none can slip into a URL by accident. */
const URL_PARAMS = ["list", "timing", "from", "to", "page"] as const;
export type ReportParam = (typeof URL_PARAMS)[number];
export type ReportParams = Partial<Record<ReportParam, string | number | undefined>>;

export function reportUrl(path: string, params: ReportParams = {}): string {
  const q = new URLSearchParams();
  for (const key of URL_PARAMS) {
    const v = params[key];
    if (v !== undefined && v !== "") q.set(key, String(v));
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}
