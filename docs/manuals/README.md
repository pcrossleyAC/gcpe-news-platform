# Staff manuals: how to write a page

The manuals are Markdown pages in folders under `docs/manuals/`, one folder per manual (`core-admin/`, `nrms-site-editor/` and so on). The Hub shows them to staff, and they export to Word. Operations and developer material does not belong here; it goes in `docs/deploy/`.

After you add or edit a page, run `npm run manuals:build` and commit the updated `apps/staff-web/src/manuals/manuals.generated.json`. A test fails when the pages and that file disagree. Files directly in `docs/manuals/` (this README, loose notes) are not pages; only files inside a folder are.

## The page header

Every page starts with a header between `---` lines. All seven fields are required, and no others are allowed.

```
---
id: government-terms
title: Government terms
manual: core-admin
order: 20
routes: [/government-terms]
screens: [admin/government-terms]
topics: []
---
```

- `id`: lower-case words joined by hyphens. Unique across all pages.
- `title`: the page title shown to readers.
- `manual`: which manual it belongs to: `core-admin`, `nrms-site-editor`, `nrms-editor`, `nrms-viewer`, `nod-admin`, `nod-editor`, `nod-viewer`, `calendar-admin`, `calendar-advanced`, `calendar-editor` or `calendar-readonly`. Use `topic` for a page that serves several manuals.
- `order`: a number; pages show in this order within their manual.
- `routes`: the Hub paths the page explains, such as `/government-terms`. May be `[]`.
- `screens`: the folders under `apps/staff-web/src/screens/` the page describes. May be `[]`.
- `topics`: the ids of topic pages this page links to. May be `[]`.

Lists go in square brackets, separated by commas.

## Writing rules

The readers are staff, not developers. Write for someone looking at the screen.

- Plain words. No API paths, no database words, no internal jargon. A test rejects `/api/` and the words database, endpoint, JSON, SQL, payload, boolean and null.
- Role ids (such as `NRMS.Editor`) appear only on the line that begins `**Who this is for:**`, next to the plain name of the role. Everywhere else, say "site editors" or "release editors".
- Name screens and buttons exactly as they appear on screen.
- No filler introductions, and do not restate a heading as the first sentence under it. A test rejects a first sentence that begins with its own heading.
- Describe only what the reader can see and do.
- Raw HTML in a page is shown as text, not rendered. Use Markdown only. Links may go to http, https, mailto, a relative address, or a `manual:` or `topic:` target; any other link is shown as plain text. Write `[text](manual:<page id>)` to link to a page of any manual, `[text](manual:<manual id>)` to link to a manual's list of pages, and `[text](topic:<topic page id>)` to link to a topic page. The build turns them into Hub addresses and stops with an error if the target does not exist.

## The up-to-date test

`apps/staff-web/src/manuals/freshness.test.ts` recompiles every page and compares it with the committed JSON (id, hash, text). It uses a placeholder date, not the real one: a page whose hash has not changed keeps its own "changed" date, so the placeholder only matters for pages that are out of date, and those already fail the test. Line endings (Windows or Unix) do not affect the hash.
