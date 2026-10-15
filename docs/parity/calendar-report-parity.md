# Calendar report parity check: June 2026 legacy snapshot

The result of spec addendum §12.3's report parity check (`npm run calendar:report-parity`), run on
2026-10-15 against legacy's own reports. This page holds counts and categories only. The legacy
files, our PDFs, the row-by-row differences and the private analysis stay outside the repository.

## Inputs

- **Snapshot:** survey 08 v2 Part B (sections 8.10–8.46) with its Part C counts. 948 activities, 114 of
  them deleted; cutoff 2026-06-01. Every section's row count matched Part C. 8.20 (linked releases)
  is in the v2 export (342 rows).
- **Legacy PDFs:** exported 2026-10-15 08:11–08:14 PDT as legacy role 5 (GCPEHQ System
  Administrator). Each PDF's creation time is our `now`.
- **Range and filter:** 2026-06-01 to 2026-06-30, and to 2026-08-31 for the 30-60-90. No search text,
  tags, category or More options; Display and the Look Ahead filter "Show All" (plan ruling 16).
- **Import:** 948 of 948 activities imported, balanced. Users are derived from comm contacts (plan
  ruling 7), and the needs-review flags aren't in the export. Five tables are "not provided".

## Which pairs were compared

- **Exec Look Ahead:** compared. Both legacy Look Ahead files turned out to be the **Exec** Look
  Ahead. They have the same 117 pages, and every Look Ahead row in them carries the Exec-only "Last
  updated" line (431 rows; `legacy-report-layouts.md` discrepancy 5). Our Exec render has that line on
  431 rows.
- **Look Ahead:** **inconclusive**: the plain Look Ahead wasn't exported (Q100). Its outline is
  the Exec's, because our two renders share their structure.
- **Planning and 30-60-90:** compared.

## Snapshot consistency (Q50)

- 0 of 948 activities have a `CreatedDateTime` or `LastUpdatedDateTime` after the first PDF's
  creation.
- The latest `LastUpdatedDateTime` in the snapshot is the day before the export.
- The run note puts the Part B queries six minutes after the PDFs; the CSV files were saved a few
  hours later.
- Assumed, not checked: a legacy delete stamps `LastUpdatedDateTime`.

## Results

The same activities are on both sides in every pair: 434 in the Exec Look Ahead (483 rows: multi-day
rows repeat), 439 in Planning and 834 in the 30-60-90. The id sets are identical.

| Report | Run | Outline lines −/+ | Rows same | Rows differ | Only legacy | Only ours |
|---|---|---|---|---|---|---|
| Exec Look Ahead | before the fix | 108 / 11 | 8 | 475 | 0 | 7 |
| Exec Look Ahead | after the fix | 108 / 4 | 8 | 475 | 0 | 0 |
| Look Ahead (inconclusive) | after the fix | 108 / 4 | 8 | 475 | 0 | 0 |
| Planning | before and after | 8 / 8 | 0 | 439 | 0 | 0 |
| 30-60-90 | before the fix | 8 / 64 | 16 | 818 | 0 | 56 |
| 30-60-90 | after the fix | 8 / 8 | 16 | 818 | 0 | 0 |

"Rows differ" counts any change in a row's extracted text. Nearly all of it comes from how the text
is extracted, not from what the reports say (the categories below). After the categories are
applied, **no row has an unexplained difference**. Ten rows were inspected by hand; each was a mix
of categories B′ and reflow.

## Categories

### Outline (sections, days and activity order)

| Category | Exec | Planning | 30-60-90 | Verdict |
|---|---|---|---|---|
| Legacy repeats the day heading and the section heading at the top of a continuation page; ours repeats only the table's column header | 104 heading lines | 0 | 0 | Follow-up: Q101, carry-forward. Break positions themselves may differ (Q48). |
| Rows tied on start date, end date and start time in another order | 4 moved | 8 moved | 8 moved | Intended: C211 |
| A CC ID# broken over two lines, drawing a second link for the row | 7 | 0 | 56 | **Fixed** (0ae8d73); 0 after the fix |

### Row text (rows touched after the fix; a row can be in several)

| Category | Exec | Planning | 30-60-90 | Verdict |
|---|---|---|---|---|
| Reflow: the same words, wrapped or interleaved across columns differently (BC Sans and our column widths) | 429 | 397 | 762 | Intended: C189 (BC Sans). Layout is compared by eye (§12.3). |
| "Last updated updated" in legacy | 430 | 0 | 0 | Intended: C186 |
| "Other..." in legacy for a typed city | 18 | 0 | 0 | Intended: C186 |
| The `**CONFIDENTIAL**` title marker in legacy | 4 | 5 | 8 | Intended: C186 |
| A page-top table header attached to the row above the break | 203 | 0 | 0 | Pagination; follows Q101 |
| A "N months ago" line dropped as page furniture by the compare tool | 427 | 421 | 818 | Compare-tool artefact (carry-forward) |
| A character legacy draws in a fallback font extracts as another code point (B) | 121 | 128 | 196 | Extraction artefact of the legacy PDF |
| The same, a whole word in the fallback font (B′) | 24 | 22 | 56 | Extraction artefact of the legacy PDF |
| A character outside Windows-1252 lost in the CSV export (read as "?") | 25 | 24 | 56 | Input artefact: the export, not the product (carry-forward) |
| Keyword names shaped like a month and year rewritten in the 8.37 export | 0 | 437 | 0 | Input artefact: the export, not the product (carry-forward) |

Wherever both sides carry the whole "updated N unit ago" phrase, the values agree: 438 Planning
rows, 424 Exec rows and 3 30-60-90 rows. No category touches contact names, RLS codes, NEW/CHANGED
flags, dates or titles.

### What the run settled

- **Awareness Dates in the Exec carry no "Last updated" line.** That is true on 0 of 52 rows in
  legacy and on 0 of 52 in ours. Legacy's code was right; discrepancy 6 doesn't hold for Awareness.
- **A day with no In the News rows shows no In the News section**, in legacy as in ours (30 days;
  neither side prints an empty one).
- **Q63 is moot here:** an explicit To date leaves the Long Term Outlook out of both sides. Q63 stays
  open.

## Not compared

- Layout by eye: §12.3, Q48 and Q101.
- The Excel export: plan ruling 19.
- The plain Look Ahead, until it is re-exported (Q100).
