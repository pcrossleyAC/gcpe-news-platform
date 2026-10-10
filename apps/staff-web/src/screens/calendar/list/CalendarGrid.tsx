import { useEffect, useRef, useState } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import type { CalendarItem, CalendarRangeView, ListQuery } from "@gcpe/calendar-contract";
import { listApi } from "./api";
import { minId } from "./cells";
import { addDaysTo, bcDateOf, monthRange, shiftMonth, todayIn, weekRange } from "./dates";
import type { ListView } from "./types";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = [["Sun", "Sunday"], ["Mon", "Monday"], ["Tue", "Tuesday"], ["Wed", "Wednesday"], ["Thu", "Thursday"], ["Fri", "Friday"], ["Sat", "Saturday"]] as const;
const VIEW_LABELS: Record<ListView, string> = { list: "List", month: "Month", week: "Week" };
const shortMonth = (d: string) => MONTHS[Number(d.slice(5, 7)) - 1]!.slice(0, 3);
const fullDate = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8))}`;

/** List, Month or Week (replacing legacy's FullCalendar toggle, Default.aspx:191-262). */
export function ViewSwitch({ view, onChange }: { view: ListView; onChange: (v: ListView) => void }): React.JSX.Element {
  return (
    <div role="group" aria-label="View" className="gcpe-actions">
      {(Object.keys(VIEW_LABELS) as ListView[]).map((v) => (
        <button key={v} type="button" className="gcpe-view-button" aria-pressed={view === v} onClick={() => onChange(v)}>
          {VIEW_LABELS[v]}
        </button>
      ))}
    </div>
  );
}

/** "9:00 AM" with a plain space: Intl's own output puts a narrow no-break space before AM/PM. */
function timeText(iso: string, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/** A month or week of the current query's activities; a multi-day activity shows on each of its days. */
export function CalendarGrid({ query, view, anchor, timeZone, onAnchor }: { query: ListQuery; view: "month" | "week"; anchor: string; timeZone: string; onAnchor: (date: string) => void }): React.JSX.Element {
  const range = view === "month" ? monthRange(anchor) : weekRange(anchor);
  const [data, setData] = useState<CalendarRangeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const key = JSON.stringify([query, range.start, range.end]);
  useEffect(() => {
    const call = ++latest.current;
    setData(null);
    setError(null);
    listApi.calendar(query, range.start, range.end).then(
      (d) => call === latest.current && setData(d),
      () => call === latest.current && setError("Couldn't load the calendar."),
    );
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const days: string[] = [];
  for (let d = range.start; d <= range.end; d = addDaysTo(d, 1)) days.push(d);
  const byDay = new Map<string, CalendarItem[]>();
  for (const item of data?.items ?? []) {
    if (!item.startAt) continue;
    const first = bcDateOf(item.startAt, timeZone);
    const last = item.endAt ? bcDateOf(item.endAt, timeZone) : first;
    for (let d = first < range.start ? range.start : first; d <= last && d <= range.end; d = addDaysTo(d, 1)) byDay.set(d, [...(byDay.get(d) ?? []), item]);
  }
  const weeks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const title = view === "month" ? `${MONTHS[Number(anchor.slice(5, 7)) - 1]} ${anchor.slice(0, 4)}` : `Week of ${shortMonth(range.start)} ${Number(range.start.slice(8))}, ${range.start.slice(0, 4)}`;
  const unit = view === "month" ? "month" : "week";
  const step = (delta: -1 | 1) => (view === "month" ? shiftMonth(anchor, delta) : addDaysTo(anchor, 7 * delta));
  const itemText = (i: CalendarItem, day: string) =>
    `${minId(i)} ${!i.isAllDay && i.startAt && bcDateOf(i.startAt, timeZone) === day ? `${timeText(i.startAt, timeZone)} ` : ""}${i.title}`;

  return (
    <section aria-labelledby="calendar-grid-heading" className="gcpe-calendar-grid">
      <h2 id="calendar-grid-heading">{title}</h2>
      <div className="gcpe-actions">
        <Button variant="secondary" onPress={() => onAnchor(step(-1))}>{`Previous ${unit}`}</Button>
        <Button variant="secondary" onPress={() => onAnchor(todayIn(timeZone))}>
          Today
        </Button>
        <Button variant="secondary" onPress={() => onAnchor(step(1))}>{`Next ${unit}`}</Button>
      </div>
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
      {!error && data === null && <p>Loading…</p>}
      {data?.truncated && <p>Only the first 1,000 activities are shown. Narrow the filter to see the rest.</p>}
      <table aria-labelledby="calendar-grid-heading">
        <thead>
          <tr>
            {DAYS.map(([short, full]) => (
              <th key={short} scope="col">
                <abbr title={full}>{short}</abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((d) => {
                const otherMonth = view === "month" && d.slice(0, 7) !== anchor.slice(0, 7);
                return (
                  <td key={d} data-date={d} className={otherMonth ? "gcpe-other-month" : undefined} aria-label={otherMonth ? fullDate(d) : undefined}>
                    <span className="gcpe-day">{view === "month" ? Number(d.slice(8)) : `${shortMonth(d)} ${Number(d.slice(8))}`}</span>
                    <ul>
                      {(byDay.get(d) ?? []).map((i) => (
                        <li key={i.id}>{itemText(i, d)}</li>
                      ))}
                    </ul>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
