# Legacy database survey

Read-only SQL scripts. They tell the rebuild what the legacy databases really contain, without
taking a copy: the live schema and code, row counts, reference data, and data profiles that
answer the open questions in `docs/parity/open-questions.md`.

| Script | Run in | Covers |
|---|---|---|
| `01-catalog.sql` | **each** database (`Gcpe.Hub`, `Gcpe.NewsOnDemand`, `Gcpe.NewsDistribution`, and `BCNewsOnDemandAdminTool` or any other GCPE database on the server) | Database settings, every table/column/key/index, row counts and sizes, views/procedures/functions/triggers source, cross-database references, roles; part B (once per server): SQL Agent jobs, linked servers |
| `02-hub-reference.sql` | `Gcpe.Hub` | Ministries, sectors, themes, tags, languages, release types/page titles, media lists, page images, application settings, Website section content |
| `03-hub-nrms.sql` | `Gcpe.Hub` | Releases: volumes, types, statuses, keys, time zones, documents, languages, body HTML features, history, logs, files (Q6, Q10–Q13, Q19, Q20, C35) |
| `04-hub-calendar.sql` | `Gcpe.Hub` | Corporate Calendar: activities, statuses, flags, lookups, users/roles (counts), log, field lengths (Phase 5) |
| `05-hub-contacts.sql` | `Gcpe.Hub` | Contacts/media schema volumes and its link to NoD (counts only) |
| `06-nod.sql` | `Gcpe.NewsOnDemand` | Subscribers, lists, sends, bounces, templates, links, purge (Q21, Q24, Q25) |
| `07-distribution.sql` | `Gcpe.NewsDistribution` | Queue, volumes, peaks, senders (Q21, Q22) |

## Safe on production

- `SELECT` only: no writes, temp tables or procedures. Each script sets `READ UNCOMMITTED`, so
  it takes no shared locks (counts may be off by in-flight rows; fine for this).
- **No personal data comes back.** No email addresses, no names of members of the public,
  journalists or staff, no phone numbers. People-tables are counted, never listed. Two
  exceptions, both public: ministers' names on the Ministry rows, and email domains shared by
  25 or more subscribers.
- Settings values whose name looks secret (`pass`, `pwd`, `secret`, `key`, `token`,
  `connection`, `credential`) come back as `***`. Still, glance over every settings result and
  SQL Agent job step before sending.
- The heaviest queries (marked `-- HEAVY`) scan release bodies or blob sizes; run them off-hours
  on a busy server.

## How to run

1. Check the database names in each script's `USE` line; change them if yours differ.
2. Run each script in SSMS or Azure Data Studio, **one result set per CSV** (SSMS: Results to
   Grid, right-click → Save Results As), named after the query number, e.g. `03-2.4.csv`.
3. If a query errors, keep going and send the error message with its number. Don't edit the
   query; it's probably a column the source code got wrong, which is itself useful to know.
4. Put the results in `docs/parity/legacy-survey/results/<database>/`. Since they contain no
   personal data, they can be committed.

Save the email templates (`06` query 1.10b) and release types (`02` query 2.6) exactly as
returned; they become the new system's templates and page titles.
