const secondsOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 3600 + m * 60;
};

/** Whether a BC wall-clock second of the day is in [start, end). Equal start and end turn the
 * freeze off; a start after the end wraps past midnight. Every day alike: legacy had no weekday
 * or holiday rules (spec addendum §7.4). */
export function inFreezeWindow(secondsOfDay: number, start: string, end: string): boolean {
  const s = secondsOf(start);
  const e = secondsOf(end);
  if (s === e) return false;
  return s < e ? secondsOfDay >= s && secondsOfDay < e : secondsOfDay >= s || secondsOfDay < e;
}

/** "16:00" → "4pm", "16:30" → "4:30pm", as legacy's message wrote its fixed times. */
export function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m === 0 ? "" : `:${String(m).padStart(2, "0")}`}${h < 12 ? "am" : "pm"}`;
}

/** Legacy's message (UCFlexiGrid.ascx:124), with the configured window. */
export function freezeMessage(start: string, end: string): string {
  return `You cannot make content changes between ${clockLabel(start)}-${clockLabel(end)}. Contact the Corp Cal Manager to have emerging or urgent updates made for you during this time.`;
}
