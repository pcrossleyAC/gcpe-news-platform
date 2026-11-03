import { CALENDAR_ROLE_INFO, type CalendarRoleName } from "./calendar-roles";

/** "" is every role; NO_ROLE is staff without Calendar access. */
export const NO_ROLE = "none";

export interface UserFilterValues {
  role: string;
  ministry: string;
}
export const NO_USER_FILTERS: UserFilterValues = { role: "", ministry: "" };

export function roleMatches(filter: string, role: CalendarRoleName | null): boolean {
  return !filter || (filter === NO_ROLE ? role === null : role === filter);
}

/**
 * The Calendar role and ministry dropdowns over a long staff list (Calendar access, Calendar users),
 * with how many rows they leave. `ministries` are the choices, already in display order.
 */
export function UserFilters(p: {
  idPrefix: string;
  value: UserFilterValues;
  onChange: (v: UserFilterValues) => void;
  ministries: { key: string; label: string }[];
  shown: number;
  total: number;
  noun: string;
}): React.JSX.Element {
  return (
    <>
      <div className="gcpe-user-filters">
        <label htmlFor={`${p.idPrefix}-role`}>Calendar role</label>
        <select id={`${p.idPrefix}-role`} value={p.value.role} onChange={(e) => p.onChange({ ...p.value, role: e.target.value })}>
          <option value="">All</option>
          {CALENDAR_ROLE_INFO.map((r) => (
            <option key={r.role} value={r.role}>
              {r.label}
            </option>
          ))}
          <option value={NO_ROLE}>No Calendar access</option>
        </select>
        <label htmlFor={`${p.idPrefix}-ministry`}>Ministry</label>
        <select id={`${p.idPrefix}-ministry`} value={p.value.ministry} onChange={(e) => p.onChange({ ...p.value, ministry: e.target.value })}>
          <option value="">All</option>
          {p.ministries.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <p className="gcpe-hint" aria-live="polite">
        Showing {p.shown} of {p.total} {p.noun}
      </p>
    </>
  );
}
