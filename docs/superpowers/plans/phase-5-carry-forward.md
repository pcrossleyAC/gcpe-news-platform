# Phase 5 carry-forward

Items one sub-plan leaves for a later one. Delete an item when the plan that takes it is written.

## 5i parity check

Run on the June 2026 legacy snapshot on 2026-10-15; results in `docs/parity/calendar-report-parity.md`.
Every difference is explained, fixed or listed here. The plain Look Ahead was compared on 2026-10-19 (Q100); every differing row is extraction noise or C148.

- **Settled by the run:**
  - Awareness Dates rows in the Exec Look Ahead carry no "Last updated" line, in legacy as in ours
    (0 of 52 rows each). Legacy's code was right; discrepancy 6 doesn't hold for Awareness.
  - A day with no In the News rows shows no In the News section, in legacy as in ours.
  - Query 8.20 (linked releases): the v2 export holds it, 342 rows.
- **Still open from the original list:**
  - Where legacy broke pages around "Outside Government" and the Long Term Outlook. The section order
    matches; break positions may differ (Q48) and are compared by eye. Legacy repeats the day and
    section headings at the top of a continued page and we don't (Q101). Repeating them means
    carrying a heading into pdfmake's repeated header rows, which is more than a builder tweak.
  - Q63: an explicit To date leaves the Long Term Outlook out of both sides, so this run says nothing
    about it.
- **Re-exports:** all received by 2026-10-19. The SSMS export of 8.30–8.46 confirmed the spreadsheet
  had rewritten 126 of 336 keyword names into month-and-year shapes.
- **The compare tool (`scripts/calendar-report-compare.ts`), before the next run:**
  - Treat as page furniture only the lines in a page's header and footer bands. Today a short line
    that repeats inside rows on half the pages (a wrapped "N months ago") is dropped from the rows.
  - Drop the tables' repeated column headers, which now join the row above a page break.
  - Legacy draws some characters and words in a fallback font whose text doesn't extract. Flag those
    runs, by font, so they can be reported apart from real differences.
  - Optionally, join two link rectangles for the same activity on consecutive lines: a guard in case
    a CC ID# ever wraps again.
- The import report's `cutoff` is the earliest `--from` the check may use.
- Survey 08 (2026-10-10): `UNK` in `contactMinistryExcludedAbbreviations` matches no legacy ministry
  (the tenant setting stays as it is).

## Platform hardening (no phase yet)

- Updates feed at volume: with 2M history rows, Latest 5 for a ministry with no recent entries, or an open-ended range, takes 2–3.4 s (EXPLAIN ANALYZE, 2026-10-10). The bounded paths are under 60 ms. The feed starts empty at cutover. Once history grows, add a default date floor, or an index (pg_trgm on title/details for keyword search, and a covering index for the latest-N scan).
- **If service tokens with Calendar roles ever exist, Core's `actorIsHq` should apply only to session callers.** `actorIsHq` (`apps/core/src/services/calendar-access.ts`) today only ever sees a session actor; before a service token could carry a Calendar role, re-check that it still reads HQ membership only for a session caller, not for a bearer/service subject. (NRMS's own Calendar viewer, `apps/nrms/src/calendar/viewer.ts`, is session-only already.)
- **Re-check NRMS "email me a copy" if service tokens ever carry NRMS roles.** `POST /nrms/api/releases/:id/email-copy` (`apps/nrms/src/http/routes.ts`) sends to the bearer's `email` claim. A service token with an NRMS role could then send a release to whatever address its claims name.

## Entra sign-in (later phase)

- **Entra/OIDC matching must never match on a null email.** When Entra/OIDC sign-in is built, matching an incoming identity to a Core user by email must treat `email IS NULL` as "no match", never as a wildcard — a user imported without an email (spec addendum §4, "Users without email") must stay unmatched until an admin links a real address.
