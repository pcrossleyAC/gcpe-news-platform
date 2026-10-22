# Scrubbed Legacy Test Data for boxs.ca — Design

**Status:** design approved by Paul on 2026-10-22; this document awaits written review.

## 1. Goal

Testers on boxs.ca (the SiteGround test site) get legacy-scale data that keeps legacy's real
structure and its messy edge cases, without real people, unannounced government business or
unpublished releases leaving the operator's machine. The scrubbing can be repeated when a newer
legacy backup arrives.

**Source:** a SQL Server backup of legacy `Gcpe.Hub`. The first one is the government TEST
environment's copy, taken 2026-10-22. It is restored into a SQL Server running locally on the
operator's Mac. The real data never leaves that Mac. Only the scrubbed result goes to boxs.ca.

**Out of scope:**
- NoD and Distribution: their database (`Gcpe.NewsOnDemand`) isn't in the backup.
- Media requests.
- Calendar file attachments.
- Any production use. This is test data only.

## 2. Decisions (Paul, 2026-10-22)

| # | Decision |
|---|---|
| D1 | **Calendar text is kept**, with people's names, emails and phone numbers replaced. Text isn't replaced with invented prose or dropped. |
| D2 | **Only calendar activities that have ended and aren't confidential** go to boxs.ca. |
| D3 | **Calendar dates are shifted forward** by a whole number of weeks, so recent activities fall in the coming weeks and future-facing views have content. Published releases keep their real dates. |
| D4 | **Approach A:** scrub a copy of the legacy database, then run the existing importers unchanged against it. |
| D5 | **Replace** boxs.ca's calendar, release and public-site data, after backing it up. Its settings, test accounts and email redirect are kept. |

## 3. What goes to boxs.ca

| Area | Kept | Removed or replaced |
|---|---|---|
| **Calendar** | Activities with `EndDateTime` before the scrub's reference time and `IsConfidential = 0`, with their join rows and lookups. | Future and confidential activities, and their join rows. People's names, emails and phones in every text column (§4). Dates shifted (§5). Attachments left out. |
| **Releases** (NRMS, News API, public site) | Releases that are published, active, and have a `PublishDateTime` in the past, with their documents and images. They are already public on news.gov.bc.ca. | Drafts, scheduled (future-dated) and deleted releases, and everything attached to them. |
| **People** (Core) | — | Every legacy user becomes an invented user at `example.test` with sign-in disabled. boxs.ca's existing test accounts are carried over unchanged. |
| **Reference data** | Ministries, sectors, themes, tags, categories and other lookups. They are public lists. | People-bearing lookups (communication contacts, government representatives, event planners, videographers) are pseudonymised (§4). |
| **Media requests** (`media.*`) | — | Not loaded. |
| **Logs and feeds** (`calendar.Log`, `calendar.NewsFeed`, `dbo.NewsReleaseLog`) | Nothing the importers need. | Truncated in the scrubbed copy. |

## 4. Pseudonymising people

1. **The people list.** Build it at run time from legacy's people tables:
   - users;
   - communication contacts;
   - government representatives;
   - event planners and videographers;
   - any other table found to hold a person's name, email or phone. The plan lists the tables and columns after reading the schema.

   Each person gets a stable invented identity: a name drawn from a fictional name list, `<first>.<last>@example.test`, and a `555-01xx` phone number. Mapping is deterministic per person, and the same person always gets the same identity within a run.
2. **Structured columns.** Name, email and phone columns are overwritten with the invented identity.
3. **Free text.** Every text column of every kept row is searched for:
   - every known person's full name, surname-first form and email, case-insensitively and whole-word, including possessives and across line breaks;
   - any email address;
   - any North American phone number, including `250-555-0100`, `(250) 555-0100`, `250.555.0100`, `+1 250 555 0100`, `1-800-…`, and extensions such as `ext. 123` and `x123`.

   Known names become the person's invented name. Unknown emails become `person<n>@example.test`. Phones become `555-01xx` numbers.
4. **Accepted limit:** names of people who aren't in any people table, such as members of the public or a journalist named in a comment, are not detected (D1).
5. **The mapping table** (real to invented) is written only to `~/gcpe-parity-private`. It is never printed, committed or uploaded.

## 5. Shifting dates

- Every calendar datetime column moves by the same offset: whole weeks, chosen so the latest kept activity lands about two weeks after the run date. The offset is printed. Weekday, time of day and relative order are preserved.
- An activity's news-release date fields move with it. The releases themselves keep their real publish dates (D3).
- "Created" and "last updated" stamps move by the same offset, so "Last updated N days ago" stays plausible.

## 6. Pipeline

The command is `npm run scrub:test-data -- --backup <file> --out <private dir>`. It runs on the operator's Mac and stops at the first failed gate.

1. **Copy.** Restore the backup as `Gcpe.Hub_Scrubbed`. The real `Gcpe.Hub` copy is never written to.
2. **Scrub.** Apply §3, §4 and §5 in one transaction per area.
3. **Gate 1, leak check on SQL Server.** Search every text column of the scrubbed copy for every real name, email and phone in the people list, plus every email and phone found anywhere in the original's text.
   - The pass condition is zero hits.
   - The report lists table, column and count only. The private report adds the row ids.
4. **Import.**
   - Create fresh local Postgres databases.
   - Seed Core with boxs.ca's current test accounts, downloaded over SSH. They are fictional.
   - Run the existing importers unchanged: Core, NRMS, Calendar, News API, in that order.
5. **Gate 2, leak check on Postgres.** Run the same search over every text column of every imported database. The pass condition is zero hits.
6. **Local trial.**
   - Start the stack against those databases.
   - Run a smoke test: sign in as a test account, open the calendar, produce a Look Ahead PDF, open a release, load the public site home page.
   - The pass condition is that all of these succeed.
7. **Operator approval.** Print counts per area, the date offset and both gates' results, then wait for an explicit typed confirmation.
8. **Back up boxs.ca.** Dump its databases to `~/gcpe-data/backups/<timestamp>/` on boxs.ca. Download a copy; it's fictional data.
9. **Load.**
   - Stop the stack.
   - Restore the scrubbed databases.
   - Start the stack.
   - Rebuild the News API search text and the public site.
   - Check `/stack/health`, then run the step 6 smoke test against boxs.ca.
10. **Undo.** `npm run scrub:test-data:restore -- <timestamp>` loads the step 8 backup back.

## 7. Testing

- Unit tests for the scrubbing rules use fictional fixtures only:
  - names inside sentences, possessives, names broken across lines, surname-first forms;
  - every phone format in §4, and emails;
  - the same name always getting the same invented name;
  - a date shift keeping weekday and time;
  - a second run giving the same result.
- An integration test runs the pipeline's scrub and gate steps against a tiny fictional SQL Server fixture, if SQL Server is available. Otherwise it's skipped with a clear message.
- Each gate is tested to fail: plant a known real-looking fictional name in a fixture's text and check that the gate stops the run.

## 8. To verify while planning

These are assumptions, not checked yet:
- **SiteGround's Postgres version** against the local Postgres 14. Use plain-SQL dumps if they differ.
- **Stopping and starting the stack on boxs.ca over SSH** without a redeploy.
- **Disk space on boxs.ca** for the backup plus the new data.
- **Which legacy tables hold people.** The schema read may find more than §4 lists.
- **Whether the importers need any of the truncated log tables.** If so, keep those rows and scrub them like other text.

## 9. Docs

- **Runbook:** a section in `docs/deploy/siteground.md` covering how to run it, the gates, and how to undo.
- **Running notes:** an operator line about refreshing test data.
- **Carolynn's test script:** list any tests that depend on the old fictional sample records and need re-pointing.
