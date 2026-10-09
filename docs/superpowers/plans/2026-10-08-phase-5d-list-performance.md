# The list query on 50,000 activities

Date: 2026-10-08

## Machine

- This Mac, local Postgres (not SiteGround, not production hardware).
- `uname -m`: `arm64`
- CPU: `Apple M4 Pro`
- Postgres: `PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0, compiled by Apple clang version 16.0.0 (clang-1600.0.26.6), 64-bit`

boxs.ca and production hardware weren't measured; 5d-2's hand check times the list there.

## Fixture

`apps/calendar/test/volume.ts`'s `seedVolume`: a list-sized Calendar with 50,000 activities from
2016 on, about 4,500 a year (spec addendum §13), in 30 ministries (health and finance among them),
3% Not for Look Ahead, 12.5% deleted (half awaiting review), a sixth with an LA status, one or two
categories, keywords on half, shared with a fifth, and favourites. Ids start at 100,001; lookups at
1,001. Fictional values only.

## Running it

The 50k fixture build and measurement are opt-in, gated behind `CALENDAR_PERF=1` so a plain
`vitest run` (and CI) skips them:

```
CALENDAR_PERF=1 npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/list/list-perf.test.ts
```

## Results

8 shapes, 10 runs each, p95 and max of those 10 runs, against the actual row total `listPage`
returned for that shape. All under the 500 ms budget (spec addendum §3 row 5d) with no index
changes needed (D12 stands: this plan adds none).

```
   17 ms p95    17 ms max    119 rows  a ministry editor's default list, first page
   12 ms p95    12 ms max    119 rows  a ministry editor's default list, tenth page
   33 ms p95    33 ms max  42424 rows  HQ, every year since 2011, by title descending, offset 1,500
  184 ms p95   184 ms max  46250 rows  HQ Administrator, every year, by categories, offset 900
   51 ms p95    51 ms max      0 rows  HQ, a quick search that matches nothing, every year
    8 ms p95     8 ms max    152 rows  HQ, three HQ Tags and a Lead Ministry, every year
   11 ms p95    11 ms max   2777 rows  HQ Advanced, a corporate query, show all
   14 ms p95    14 ms max     96 rows  a ministry editor's watchlist, every year
```

The slowest shape — HQ Administrator, sorted by categories, offset 900 — ran a consistent 178–186
ms p95 across repeated runs (checked separately, not part of the committed test): `string_agg`
over a join through `activity_categories` and `categories` for every one of the ~46,250 matching
rows, materialized before the sort can apply. Still 63% under budget, so no index was added.

Two shapes needed a fixed query to make sense against the fixture, found by running this test for
real rather than assuming the brief's shapes against `seedVolume`:

- "HQ, a quick search that matches nothing, every year" is supposed to return nothing — the test
  expects `total === 0` for it rather than `> 0`, since that's the shape's whole point (the cost of
  a full predicate scan over 50,000 rows when nothing short-circuits it).
- "HQ, three HQ Tags and a Lead Ministry, every year" originally filtered on `ministryKey: "health"`.
  In `seedVolume`, health activities are always the even `g`'s (`g % 30 === 0`), and keywords are
  only ever assigned to odd `g`'s (`generate_series(1, n, 2)`), so a health + keywordIds filter is
  structurally empty no matter how fast or slow the query is. Swapped to `"finance"` (`g % 30 ===
  1`, always odd), which intersects the keyword-bearing rows and returns 152 rows — the same shape
  of query, now actually exercised.
