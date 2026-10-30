# New government: operator notes

For the person who runs the servers. The staff steps (start a term, prepare a cabinet change) are in the Core administrator manual's topic "When a new government takes office" (`docs/manuals/topics/new-government.md`). These notes moved here from the old `docs/manuals/new-government.md`.

## One-time actions at cutover

- **Owner sign-off** that the Hub's archive by term replaces archive.news.gov.bc.ca for 2012 onward (decision record C1, question Q-NG1). The old archive stays online as the pre-2012 and pre-cutover archive.
- **Corporate Search ticket**, once: add the entry point `https://news.gov.bc.ca/archive/terms/` and the sitemap `https://news.gov.bc.ca/sitemap.xml`, with PDFs excluded. Keep the `archive.news.gov.bc.ca` domain for older content. Nothing changes per election after that.
- **Hub edit:** change the "News Archive" resource link to `/archive/terms/` (Website > resource links).
- **Coverage check** (below), clean, before the sign-off.

## Coverage check

Proves every release listed in the old archive is in the platform:

```
npx tsx scripts/archive-coverage-check.ts --news-api https://<news-api-host> \
  https://archive.news.gov.bc.ca/releases/index_2020-2024.htm [more index pages or saved files...]
```

It prints `checked N, missing M` and the missing keys, and exits 1 if any are missing. Exit 2 means a page or the API could not be read, which is not a pass. It makes at most one request a second (about 65 requests for the 6,304 keys of `index_2020-2024.htm`). Run it for every term's index page before cutover. Keys match without regard to capital letters.

## Checks for operators

1. **Undated terms.** After the NRMS migration, run:
   ```sql
   SELECT name, start_date FROM government_terms ORDER BY start_date NULLS FIRST;
   ```
   Any row with an empty `start_date` is an undated term: it never counts as current and is left out of the public archive. In the Hub (Government terms > **Edit**), give each one a start date.
2. **Time zone data.** Confirm the database and the app agree on Pacific time. Run in Postgres:
   ```sql
   SELECT (timestamptz '2028-11-20 06:59:00+00' AT TIME ZONE 'America/Vancouver');
   ```
   and in Node:
   ```js
   new Date('2028-11-20T06:59:00Z').toLocaleString('en-CA', { timeZone: 'America/Vancouver' })
   ```
   Compare the values, not the layout (the two print differently): both must be the same Pacific date and clock time. The date should be 2028-11-19. The clock time depends on the time-zone rules the host knows: 22:59 under ordinary winter time (UTC-8), 23:59 if the host's tzdata has British Columbia on permanent daylight time (UTC-7); on 2026-10-27 the developer's machine and its Postgres both gave 23:59. Why it matters: the database decides each release's term from its Pacific publish day and the app decides what the archive shows, so if the two disagree about Pacific time, a release published near midnight on a term's start date could be listed under the wrong term. If they differ, update the time-zone data (tzdata) on the older host before the election.
3. **Stuck moves.** If a hand-over's subscribers, Calendar activities or drafts have not moved after a few minutes, look for dead-lettered `org.succeeded` events (the Calendar dead-letters screen shows them). The moves are safe to run again.

Decisions behind all of this are recorded in `docs/parity/changes-from-legacy.md` (C11 and the "new government" rows) and `docs/parity/open-questions.md` (Q-NG1 to Q-NG7).
