# Phase 5 carry-forward

Items one sub-plan leaves for a later one. Delete an item when the plan that takes it is written.

## 5i parity check

- **Report parity:** run `npm run calendar:report-compare` (scripts/calendar-report-compare.ts) on each past-period legacy PDF against ours for the same range and filter, with `--out` outside the repo. Settle there what the samples couldn't:
  - whether legacy's Awareness Dates rows carried "Last updated" in the Exec Look Ahead (discrepancy 6; legacy's code says no);
  - whether legacy showed In the News for a day with no rows (we skip such days);
  - where legacy broke pages around "Outside Government" and the Long Term Outlook;
  - Q63.

  The import report's `cutoff` is the earliest `--from` the check may use.
- Survey 08 (2026-10-10): `UNK` in `contactMinistryExcludedAbbreviations` matches no legacy ministry (the tenant setting stays as it is), and query 8.20 (linked releases) is missing from the export and still needs re-running for this half.

## Platform hardening (no phase yet)

- Updates feed at volume: with 2M history rows, Latest 5 for a ministry with no recent entries, or an open-ended range, takes 2–3.4 s (EXPLAIN ANALYZE, 2026-10-10). The bounded paths are under 60 ms. The feed starts empty at cutover. Once history grows, add a default date floor, or an index (pg_trgm on title/details for keyword search, and a covering index for the latest-N scan).
- **If service tokens with Calendar roles ever exist, Core's `actorIsHq` should apply only to session callers.** `actorIsHq` (`apps/core/src/services/calendar-access.ts`) today only ever sees a session actor; before a service token could carry a Calendar role, re-check that it still reads HQ membership only for a session caller, not for a bearer/service subject. (NRMS's own Calendar viewer, `apps/nrms/src/calendar/viewer.ts`, is session-only already.)
- **Re-check NRMS "email me a copy" if service tokens ever carry NRMS roles.** `POST /nrms/api/releases/:id/email-copy` (`apps/nrms/src/http/routes.ts`) sends to the bearer's `email` claim. A service token with an NRMS role could then send a release to whatever address its claims name.

## Entra sign-in (later phase)

- **Entra/OIDC matching must never match on a null email.** When Entra/OIDC sign-in is built, matching an incoming identity to a Core user by email must treat `email IS NULL` as "no match", never as a wildcard — a user imported without an email (spec addendum §4, "Users without email") must stay unmatched until an admin links a real address.
