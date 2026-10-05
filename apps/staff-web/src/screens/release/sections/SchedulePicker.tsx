import { useState } from "react";
import { TextField } from "@bcgov/design-system-react-components";
import { bcLocalToInstant } from "../timezone";

export interface SchedulePickerProps {
  /** The tenant time zone (`GET /nrms/api/config`'s `timeZone`) — every date/time typed here is
   * read as BC local time, never the browser's own zone. */
  timeZone: string;
  legend: string;
  idPrefix: string;
  initialDate?: string;
  initialTime?: string;
  /** Called with the converted UTC instant (ISO 8601, with offset) whenever both fields hold a
   * valid date and time, or `null` while incomplete/invalid — never called with a locally
   * "guessed" instant the server didn't actually ask for. */
  onChange(iso: string | null): void;
}

/**
 * A BC-local date + time picker that converts to a UTC instant DST-correctly (task-3-brief.md
 * design note), for Schedule (ActionsSection) and the planned publish time (SettingsSection).
 * Plain `<input type="date">`/`<input type="time">` rather than the design system's
 * DatePicker/TimeField (which take `CalendarDate`/`Time` objects) — simpler to wire to one BC
 * instant and to drive from tests.
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
      onChange(bcLocalToInstant(nextDate, nextTime, timeZone));
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
