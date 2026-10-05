import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SchedulePicker } from "./SchedulePicker";

afterEach(() => cleanup());

const TZ = "America/Vancouver";

// Fix round 1 (3f Task 3), finding 3: the picker now emits the raw BC-local wall-clock string
// (`local`) alongside a browser-side-converted `instant` — the Schedule action sends `local`
// (the server converts it with its own, authoritative tzdata); `instant` remains available only
// for Settings' plannedPublishAt (out of this fix round's scope) and an optional preview.
describe("SchedulePicker", () => {
  it("emits { local, instant } once both fields are filled — local is the typed value, untouched", () => {
    const onChange = vi.fn();
    render(<SchedulePicker timeZone={TZ} legend="Schedule" idPrefix="sched" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-06-15" } });
    expect(onChange).toHaveBeenLastCalledWith(null); // time not filled in yet

    fireEvent.change(screen.getByLabelText("Time (BC time)"), { target: { value: "14:30" } });
    expect(onChange).toHaveBeenLastCalledWith({ local: "2026-06-15T14:30", instant: "2026-06-15T21:30:00.000Z" });
  });

  it("instant converts a BC-local PST date+time to the right UTC instant (browser-side, for the preview/Settings use only)", () => {
    const onChange = vi.fn();
    render(<SchedulePicker timeZone={TZ} legend="Schedule" idPrefix="sched" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Time (BC time)"), { target: { value: "09:00" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-01-15" } });
    expect(onChange).toHaveBeenLastCalledWith({ local: "2026-01-15T09:00", instant: "2026-01-15T17:00:00.000Z" });
  });

  it("calls onChange(null) again if a filled field is cleared", () => {
    const onChange = vi.fn();
    render(<SchedulePicker timeZone={TZ} legend="Schedule" idPrefix="sched" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-06-15" } });
    fireEvent.change(screen.getByLabelText("Time (BC time)"), { target: { value: "14:30" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("pre-fills from initialDate/initialTime", () => {
    render(<SchedulePicker timeZone={TZ} legend="Schedule" idPrefix="sched" initialDate="2026-06-15" initialTime="14:30" onChange={() => {}} />);
    expect(screen.getByLabelText("Date")).toHaveValue("2026-06-15");
    expect(screen.getByLabelText("Time (BC time)")).toHaveValue("14:30");
  });
});
