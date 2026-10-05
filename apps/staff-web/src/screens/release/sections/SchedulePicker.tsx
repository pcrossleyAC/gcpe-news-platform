import { useState } from "react";
import { TextField } from "@bcgov/design-system-react-components";
import { bcLocalToInstant } from "../timezone";

export interface ScheduleValue {
  /** "YYYY-MM-DDTHH:mm" — the BC wall-clock date/time exactly as typed, no conversion. Fix
   * round 1, finding 3 (and its follow-up): this is what both the Schedule action
   * (`publishAtLocal`) and Settings' planned date (`plannedPublishAtLocal`) now send — the
   * server, whose tzdata is the one that actually matters for the tenant, converts it. */
  local: string;
  /** The same wall-clock time converted to a UTC instant using the *browser's* own tzdata.
   * Never sent to the server any more (a stale browser could get it wrong by an hour); kept
   * only for local comparisons (e.g. Settings' own unsaved-changes dirty check) and as a
   * hook for an optional preview. */
  instant: string;
}

export interface SchedulePickerProps {
  /** The tenant time zone (`GET /nrms/api/config`'s `timeZone`) — used only to compute
   * {@link ScheduleValue.instant}'s browser-side preview conversion; `local` never depends on it. */
  timeZone: string;
  legend: string;
  idPrefix: string;
  initialDate?: string;
  initialTime?: string;
  /** Called with `{ local, instant }` once both fields hold a valid date and time, or `null`
   * while incomplete/invalid. */
  onChange(value: ScheduleValue | null): void;
}

/**
 * A BC-local date + time picker (task-3-brief.md design note), for Schedule (ActionsSection)
 * and the planned publish time (SettingsSection). Plain `<input type="date">`/`<input
 * type="time">` rather than the design system's DatePicker/TimeField (which take
 * `CalendarDate`/`Time` objects) — simpler to wire to BC local time and to drive from tests.
 */
export function SchedulePicker({ timeZone, legend, idPrefix, initialDate = "", initialTime = "", onChange }: SchedulePickerProps): React.JSX.Element {
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState(initialTime);
  const [error, setError] = useState<string | null>(null);

  const update = (nextDate: string, nextTime: string) => {
    setDate(nextDate);
    setTime(nextTime);
    if (!nextDate || !nextTime) {
      setError(null);
      onChange(null);
      return;
    }
    try {
      const instant = bcLocalToInstant(nextDate, nextTime, timeZone);
      onChange({ local: `${nextDate}T${nextTime}`, instant });
      setError(null);
    } catch {
      onChange(null);
      setError("Enter a valid date and time.");
    }
  };

  return (
    <fieldset className="gcpe-schedule-picker">
      <legend>{legend}</legend>
      <TextField label="Date" type="date" value={date} onChange={(v) => update(v, time)} id={`${idPrefix}-date`} />
      <TextField label="Time (BC time)" type="time" value={time} onChange={(v) => update(date, v)} id={`${idPrefix}-time`} />
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
