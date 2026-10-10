import type { TenantConfig } from "@gcpe/config";
import type { CalendarRules } from "@gcpe/calendar-contract";

/** The activity rules' settings: the tenant's calendar section and its time zone (spec addendum §5.1). */
export function rulesFromTenant(t: TenantConfig): CalendarRules {
  if (!t.calendar) throw new Error(`tenant "${t.tenantId}" has no "calendar" section; the Corporate Calendar needs one (spec addendum §5.1)`);
  return { timeZone: t.timeZone, ...t.calendar };
}
