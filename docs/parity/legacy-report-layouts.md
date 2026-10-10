# Legacy Corporate Calendar report outputs — structure survey

Source files: `/Users/paul/gcpe-news-platform-4c/docs/parity/legacy-survey/results/Hub/`
Spec: `/Users/paul/gcpe-news-platform-p5/docs/superpowers/specs/2026-10-07-calendar-parity-design.md`, §10 "Reports" (10.1–10.5), plus §8.1 Excel export / C151.

STRUCTURE ONLY. No real activity titles, descriptions, names, emails or phone numbers are reproduced below; placeholders like `<activity title>`, `<contact name>` are used throughout.

---

## 1. LookAhead 1.pdf — regular Look Ahead (spec §10.2)

**Page setup**
- Letter portrait (612×792 pt), 39 pages. Confirmed via `pdfinfo`.
- Cover page: grayscale illustration of the BC Parliament Buildings under a dark banner reading "BC GOVERNMENT / CORPORATE LOOK AHEAD" with "Government Communications and Public Engagement" above it. Top-right corner text: "DRAFT ONLY - NOT FOR CIRCULATION / Information is confidential and subject to change" — matches spec verbatim.
- Below the image: title line "Saturday, Aug. 1, 2026 to Monday, Aug. 31, 2026" — matches spec pattern `dddd, MMM. d[, yyyy] to dddd, MMM. d, yyyy` exactly (abbreviated month with period).
- "Contents:" legend below the title, five colour swatches (no sixth "Long Term Outlook" swatch in this fixture, since none was included — matches spec's "when included" conditional):
  - Events, Speeches and Releases (Inside Government) — blue swatch
  - Issues and Reports — pale purple/lavender swatch
  - Consultations and Dialogues — pale blue swatch
  - In the News (Outside Government) — pale yellow-green swatch
  - Awareness Dates — pale green swatch
- A grey "Questions or Comments? Please call: <phone> or email us at: <mailbox name>" contact box appears bottom-right of the cover. **Not mentioned anywhere in spec §10.2.**
- Running header (content pages): BC Government logo + "British Columbia" wordmark top-left; "DRAFT AND CONFIDENTIAL" top-right in a brownish/brick-red colour. "Inside Government" section heading (bold, underlined) appears only on the first content page (page 2), not repeated per page.
- Running footer (every content page): bottom-left "Updated <dddd, MMM d, yyyy h:mm tt>" (e.g. full weekday name, abbreviated month, 12-hour time, no seconds) — matches spec pattern exactly; bottom-centre the literal note `"CHANGED" applies to major detail or date changes only (not time switches)`; bottom-right "Page X of Y".

**Structure — sections, in order**
1. **Inside Government → Events, Speeches & Releases** (pages 2–27): one table per calendar day. Day heading centred, bold, blue: `<Dddd, Month D, YYYY>`. Sub-heading "Events, Speeches & Releases". Table header row (blue `#558abd`-ish) literally shows the day's short date as column 1's header (e.g. "Sun Aug 2", "Mon Aug 3") rather than the literal word "Date"; remaining headers "Lead", "Activity/Details", "RLS", "CC ID#" — 5 columns, matching spec's listed column set exactly in count and order.
   - Empty day: "No Activities for <Weekday, Month D, YYYY>" (full date format, different from the per-row short-date header format).
   - Alternating row shading confirmed (white / light grey).
   - Multi-day items repeat on every day of their span and sort first within that day's table (matches spec's "multi-day items go first").
   - RLS cell shows Origin above Material (e.g. "BCGov" above "NR", "Fed" above "NR", "Joint" above "NR", "3rd party" above "NR"); a third line with a clock time appears when the material's release time differs from the activity start time and falls that day. Empty RLS cells show "-". An "OpEd" material code was observed (Lead "LBR", "BCGov OpEd").
   - CC ID# is a hyperlink-styled (blue) code.
2. **Issues and Reports** (pages 28–30 in this fixture): single black header bar (not grouped by day) with columns "Date | CC ID# | Activity/Details | Category | Rls" — matches spec's listed columns. Category column always read "Issue" in this fixture. Rls column showed "-" , "3rd party NR", "BCGov Report", "3rd party Report", "Fed Report" (see discrepancy #3 below). Row shading: pale pink/salmon on the Date column, pale purple/lavender across the Activity/Details and other columns for every row (not alternating — constant for the whole section, matching the legend's purple "Issues and Reports" swatch). **Header bar itself renders near-black with white text**, not the pale pink the spec associates with this section (see discrepancy #2).
3. **No "Consultations and Dialogues" section appeared anywhere in the 39 pages**, despite being in the legend/Contents list. (See discrepancy #4.)
4. **Outside Government → In the News** (pages 31–37): "Outside Government" underlined heading once, then repeated "In the News" black header bars per day, columns "Date | CC ID# | Activity/Details | Category | Rls" (Category always "FYI" in this fixture; no "Issue" or "TV-Radio" example seen here). Pale yellow-green row shading. Multi-day items duplicate across every day of their span, same as Inside Government.
5. A page break, then **Awareness Dates** (pages 38–39): black header bar, only 3 columns — "Date | Name | CC ID#" — pale green row shading. **Each row shows a bold title/name phrase followed by a full explanatory paragraph** (sometimes with an additional bolded note such as a "No ministry statement planned" line, and occasionally a hyperlink) — directly re-verified by reading pages 38–39 in full. This does **not** match spec's "showing the title only"; see discrepancy #16.
6. **No "Long Term Outlook" section** in this fixture (consistent with spec's "when included").

---

## 2. ExecLookAhead.pdf — Exec Look Ahead, HQ/Administrator (spec §10.3)

**Page setup**
- Letter portrait, 53 pages. Same cover page, same legend, same "Questions or Comments" box, same date range (a full calendar month: Aug 1–31) as the regular Look Ahead — consistent with spec's "over one month."
- Same header/footer pattern as LookAhead 1.pdf, generated at a different timestamp (8:11 PM vs 8:06 PM for the regular report — i.e., each report is rendered independently).

**Structure**
- Same section order and same 5-column Inside-Government table shape as the regular Look Ahead.
- Row text ("Detailed" mode) in Inside Government adds, beneath the bold title + category-prefix + details text: a plain significance paragraph, then a bold `<City>: <Venue>` line (sometimes just "<City>: VCO" for virtual events, one row showed a bare, apparently-truncated "Other..." as the venue value), then a trailing small orange/tan line. **That trailing line literally reads "Last updated updated `<N>` `<unit>` ago" — the word "updated" is duplicated** (e.g. "Last updated updated 2 months ago"). This appears consistently throughout the whole document — not just Inside Government but also in the Issues and Reports, Outside Government/In the News, and Awareness Dates sections of this Exec report (none of which carry this line in the non-Exec LookAhead 1.pdf). See discrepancy #5/#6 below.
- Rows corresponding to confidential/Issue items are shaded pale purple across the whole row (confirms spec's "Issues are highlighted").
- Issues and Reports / Outside Government / Awareness Dates sections are structurally identical to the regular Look Ahead's (same header-bar styling, same near-black header issue, same "Report" Rls-code appearing inside Issues and Reports — reproduced here too, confirming it's not a one-off).
- No "Consultations and Dialogues" section here either.
- Never saw a "NEW" or "CHANGED" flag anywhere in either Look Ahead PDF (unverified whether the flag mechanism was simply not triggered by this fixture, or doesn't render).

---

## 3. 30-60-90-example.pdf — 30/60/90 report (spec §10.4)

**Page setup**
- Letter portrait (612×792 pt), 24 pages.
- No cover page. Page 1 opens directly with the title "30 / 60 / 90 REPORT" (large, bold, centred, black) — matches spec exactly, including the blank ministry prefix (none observed).
- Below the title, a centred month heading "August 2026" (teal, bold) — this fixture only ever shows **one** month heading across all 24 pages; the spec's "3 or 4 months" multi-month grouping behaviour could not be verified from this single-month example.
- Running text sits in the **footer**, not the header (different from both Look Ahead reports): bottom-left, on one line, red bold "DRAFT AND CONFIDENTIAL" immediately followed by black bold "Updated `<dddd, MMM d, yyyy h:mm tt>`"; bottom-right "Page X of Y".
- Table header row repeats on every page: teal `#35989d`-ish fill, white bold text, columns "DATE | TOPIC | STRATEGY/COMM MATERIALS | ID/CONT" — verbatim match to spec's listed columns.

**Structure**
- One row per activity; multi-day activities appear **once** (not duplicated per day, unlike both Look Ahead reports).
- DATE column: friendly range/single-date/date-time text, e.g. a 3-line wrapped "Sun Aug 2 / 2:00- / 2:30 PM" for timed single-day items, "Jul 25-Aug 3" for ranges (no weekday prefix on ranges, single dates get a weekday prefix — same convention as seen in PlanningReport.pdf).
- TOPIC column: bold `<City - Title>` (or bare `<Title>` when no city) + category-prefix text + details, then an italicized, visually smaller "*Significance:* …" line — matches spec's "bold 'City - Title: details', then '*Significance:* …' at 9 pt" (exact point size not independently verifiable from text extraction, but a clear size step-down is visible).
- STRATEGY/COMM MATERIALS column: free-text comma list of tactics (e.g. "News Release, Q&As, Quote"); frequently blank for Awareness/FYI-only rows. Content vocabulary not described by the spec (no discrepancy, just documenting the observed shape).
- ID/CONT column: blue hyperlinked `<Ministry>-<ID>` code, then `<contact name>` on its own line, then a trailing grey "updated `<N>` `<unit>` ago" line — only ever "updated", never "created", in this sample (same caveat as elsewhere).
- Row shading: "Issue" rows are shaded pale purple across the row; plain FYI/Awareness rows stay white — confirms spec's "Issue rows are purple."
- A bold red "Not for Look Ahead" prefix line was observed on at least 3 rows in this report. **The spec's §10.4 section does not document this prefix for the 30/60/90 report at all** (it's described only for Look Ahead §10.2 and Planning §10.5). See discrepancy #7.
- One row's bold title rendered literally as `**CONFIDENTIAL** <activity title>` — the double-asterisk markdown bold syntax was **not parsed**, so the literal asterisk characters appear in the output. See discrepancy #8 (a concrete rendering bug).

---

## 4. PlanningReport.pdf — Planning report (spec §10.5)

**Page setup**
- Legal landscape (1008×612 pt = 14 in × 8.5 in), 32 pages. Confirmed via `pdfinfo`.
- No cover page.
- Header (every page): "GCPE Corporate Calendar: Schedule of Activities" top-left (large, blue/teal bold) — matches spec's quoted title exactly; "DRAFT AND CONFIDENTIAL" top-right in orange/red.
- Footer (every page): bottom-left "Updated `<M/D/YYYY h:mm:ss AM/PM>`" (numeric slash-date, **includes seconds**, no weekday/month name — a different pattern from the Look Ahead reports' "Updated `<dddd, MMM d, yyyy h:mm tt>`"); bottom-right "Page X of Y".

**Structure**
- Exactly 4 columns, verbatim header labels: "Schedule | Title & Summary | Significance | CC ID#" — matches spec exactly.
- One row per activity, no day/ministry grouping, ascending chronological order (consistent with "Rows follow the list's order").
- **Schedule column:** date/time text (weekday prefix on single-day items, no weekday prefix on ranges — same convention as the other reports), then scheduling-note text, then an orange/red bold "Premier Requested: `<value>`" line **only when applicable** (values seen: "No", "Confirmed" — never literally "Yes"), then an orange/red "Tags:" line listing comma-separated tags with HQ-prefixed tags sorted first — matches spec's described sort, though the spec's prose "HQ Tags" describes the sort behaviour, not a literal field label (the rendered label is "Tags:", not "HQ Tags:").
- **Title & Summary column:** bold `<City - Title>` (or bare `<Title>`) line, then an all-caps category-prefix + summary text. One row showed "Not for Look Ahead" as its own bold red line directly above the bold title rather than as a true inline prefix immediately before the title text.
- **Significance column:** three distinct value shapes observed — (a) "Issue" (bold) + detail text; (b) "FYI Only" + detail text; (c) a bare parenthetical awareness label alone, e.g. "(Awareness Month)", "(Awareness Week)", "(Awareness Day)", with no "Issue"/"FYI Only" lead-in. Some cells contained only "." and some were completely blank. Only (a) and (b) are documented in the spec.
- **CC ID# column:** blue hyperlink-styled `<Ministry>-<ID>` code, then smaller grey "updated `<N>` `<unit>` ago" text — in every instance sampled it read "updated", never "created" (spec says "created/updated X ago").
- Styling: header row solid dark navy/blue fill, white bold text (exact hex not determinable from text/image extraction). No alternating row shading. No visible purple highlight on "Issue" rows (the spec doesn't claim shading here either — consistent, not a discrepancy, but noted since it contrasts with the Look Ahead Issues section and 30/60/90's purple Issue-row shading).

---

## 5. ExcelExport.xlsx — Excel export (spec §8.1 / C151)

- **Real file type:** genuine Open XML `.xlsx` (verified: a valid ZIP archive containing `[Content_Types].xml`, `xl/workbook.xml`, `xl/worksheets/sheet1.xml`, `xl/sharedStrings.xml`, `xl/styles.xml`, etc.) — **not** an HTML table masquerading as `.xls`. This matches spec's described fix ("A real `.xlsx`…") rather than legacy's described bug ("an HTML table served as `.xls`").
- **Sheet names:** one sheet only, named `BCGovernmentActivities`.
- **Dimensions:** `A1:P162` — 16 columns (A–P), 162 rows total.
- **Header rows:**
  - Row 1 (3 merged ranges: A1:E1, F1:J1, K1:N1; columns O1:P1 unused/blank): "Province of BC. Corporate Calendar DRAFT & CONFIDENTIAL" (bold, red `FFFF0000`) | "Date Range Selected: `<Mon DD, YYYY>` to `<Mon DD, YYYY>`" (bold, black) | "Printed: `<Ddd, Mon D h:mm AM/PM>`" (bold, black — abbreviated weekday, no year, no seconds; a third distinct timestamp format alongside the two already seen in the PDFs).
  - Row 2: 16 bold column headers on a teal fill (`FF31869B`), in exact order: **ID | Ministry | Categories | Date & Time | Title | Summary | Significance and Strategy | Event Planner | Scheduling Notes | Comm. Materials | Lead Org | Comm. Contact | Govt Rep. | City | Tags | Premier Requested**.
- **Data rows:** rows 3–161 (159 activity rows). Date & Time column uses non-breaking spaces (`\xa0`) between date tokens, e.g. `<Ddd> <Mon> <D> <h:mm> -<h:mm> <AM/PM>` for timed items, `<Mon> <D> -<Mon> <D>` for ranges (no weekday prefix on ranges, same convention as the PDFs). Comm. Contact column holds `<contact name>\n<phone>` on two lines; City column holds `<City>, BC\n<Venue>` on two lines; Premier Requested column values seen: "No", "Premier Confirmed" (note: phrased "Premier Confirmed", not just "Confirmed" as seen in PlanningReport.pdf's equivalent field — a minor cross-report wording inconsistency, not itself a spec violation).
- **Footer row:** row 162, merged A162:J162 only (columns K–P of that row are blank/unmerged) — "CONFIDENTIALITY NOTICE: …" full text, bold, red (`FFFF0000`) — matches spec's "the red confidentiality footer."
- **Formula-inertness (C151):** no cell in the 159 data rows happened to start with `=`, `+`, `-`, `@`, tab, or CR in this fixture, so the "formula-like cells made inert" requirement could not be exercised/verified from this sample — this is an **untested** case, not a confirmed pass or fail.
- **Column count:** 16, matching spec's "the same 16 columns" claim.

**Comparison to spec C151 ("same header, columns and footer")**
- Header lines: **match** (title/DRAFT-CONFIDENTIAL text, date-range text, "Printed:" text all present, same cell layout).
- Columns: **match** — 16 columns, and the header row's literal labels are documented above for the first time in this survey (the spec text itself doesn't enumerate the 16 labels, so this file is the source of truth for them).
- Footer: **match** — red confidentiality notice present.
- Real `.xlsx` (not HTML-as-.xls): **confirmed fixed**, matches spec's intended remediation.
- `visible()`-only rows and formula-inertness: **not verifiable from this fixture** (no non-visible/filtered comparison available, and no formula-triggering content present to test inertness against).

---

## Discrepancies to flag precisely (vs. spec §10 and §8.1/C151)

1. **LookAhead reports' cover page has a "Questions or Comments?" contact box** (phone + mailbox name) that is nowhere described in spec §10.2. Appears on both LookAhead 1.pdf and ExecLookAhead.pdf covers identically.
2. **Issues and Reports section header bar renders near-black with white text**, not the pale pink `#f2dbdb` the spec specifies for that header, in both LookAhead 1.pdf and ExecLookAhead.pdf. (Row/Date-column shading is pale pink/salmon and the Activity/Details shading is pale purple, consistent with the "Issue rows purple" idea — it is specifically the *header bar* colour that doesn't match.)
3. **The "Report" Rls code appears inside the Issues and Reports section**, in both LookAhead 1.pdf and ExecLookAhead.pdf (e.g. "BCGov Report", "3rd party Report", "Fed Report"), but spec §10.2 states "Report → Report (**In the News only**)." Concrete, repeated, high-confidence discrepancy.
4. **No "Consultations and Dialogues" section appears anywhere** in either 39-/53-page Look Ahead PDF, despite being item 4 in spec's "Sections, in order" list and appearing in the cover legend. Spec doesn't mark this section as conditional the way it does Long Term Outlook — unclear whether omission-when-empty is intended/undocumented behaviour, or something else. Flag for clarification.
5. **ExecLookAhead's "Last updated" line literally reads "Last updated updated `<N>` `<unit>` ago"** (doubled word) and uses a relative "`<N>` `<unit>` ago" format, not spec §10.3's stated "Last updated today/yesterday at …" pattern. Concrete, repeated, high-confidence discrepancy.
6. **The Detailed/"Last updated" row addendum in ExecLookAhead.pdf is not limited to Inside Government** — it also appears in that report's Issues and Reports, Outside Government/In the News, and Awareness Dates sections, none of which carry it in the regular LookAhead 1.pdf. Spec §10.3 only describes the Inside-Government row-text change; the Exec/"Detailed" effect is broader than documented.
7. **30-60-90-example.pdf shows a red "Not for Look Ahead" prefix line** on several rows, a feature spec documents only for the Look Ahead (§10.2) and Planning (§10.5) reports, not for 30/60/90 (§10.4).
8. **One 30-60-90-example.pdf row's title literally renders `**CONFIDENTIAL** <title>`** — the markdown bold syntax was not parsed, leaving literal asterisks in the output. A concrete rendering bug worth deciding whether to replicate or fix.
9. **PlanningReport.pdf's footer date format** ("`M/D/YYYY h:mm:ss AM/PM`", numeric, with seconds) differs from the Look Ahead reports' footer date format ("`dddd, MMM d, yyyy h:mm tt`", named weekday/month, no seconds), and from ExcelExport.xlsx's "Printed:" format ("`Ddd, Mon D h:mm AM/PM`", abbreviated weekday, no year, no seconds). Three distinct timestamp formats across four documents; spec §10 doesn't pin an exact pattern for any report besides Look Ahead's (§10.2), so this is a documentation gap, not a contradiction — but the formats are **not** consistent with each other in practice.
10. **PlanningReport.pdf's Significance column has a third value shape** (bare parenthetical awareness label, e.g. "(Awareness Month)", with no "Issue"/"FYI Only" lead-in) plus blank and "." placeholder cells, none of which are described in spec §10.5 (which documents only "Issue" and "FYI Only" lead-ins).
11. **CC ID# / ID-CONT "created/updated X ago" sub-line**: in every sample across PlanningReport.pdf, 30-60-90-example.pdf, and both Look Ahead PDFs, the text read only "updated `<N>` `<unit>` ago" — never "created `<N>` `<unit>` ago" as spec's "created/updated X ago" wording implies should sometimes appear. Likely a fixture-coverage gap (no sufficiently-new items in these samples) rather than a confirmed spec violation — flagged as unverified.
12. **"Not for Look Ahead" positioning in PlanningReport.pdf** renders as its own bold red line directly above the bold title, rather than as a true inline prefix immediately before the title text (a minor wording/positioning nuance vs. spec's "prefix" phrasing).
13. **"Premier Requested" value vocabulary differs between ExcelExport.xlsx ("Premier Confirmed") and PlanningReport.pdf ("Confirmed")** for what appears to be the same underlying status — a minor cross-report wording inconsistency, not itself a spec requirement violation, but worth normalizing.
14. **C151's "visible() rows only" and "formula-like cells made inert" clauses are unverified** from ExcelExport.xlsx alone — the fixture contains no filtered-out rows to compare against and no formula-triggering-prefix content (`=`, `+`, `-`, `@`) to test inertness against.
15. **30-60-90-example.pdf's multi-month grouping ("3 or 4 months... one group per month") is unverified** — this fixture's date range only produces one month ("August 2026"), so the cross-month heading/grouping behaviour described in spec §10.4 could not be observed.
16. **Awareness Dates rows are not "title only."** Directly re-verified (pages 38–39 of LookAhead 1.pdf, read in full as part of final QA): every row shows a bold title/name phrase followed by a full explanatory paragraph, and some rows carry an additional bolded note (e.g. a "No ministry statement planned" line) or a hyperlink. Spec §10.2 section 6 states Awareness Dates shows "the title only" — a direct, concrete, high-confidence discrepancy. (Note: an earlier draft of this document briefly and incorrectly stated the opposite — "title only, matching spec" — before this correction; that line has been fixed.)

---

## Appendix: pixel-verified hex colours (independent re-derivation)

Several colours above were marked "not determinable from text/image extraction" or described only qualitatively. These were independently re-derived — not eyeballed — by rendering the relevant pages to PNG with `pdftoppm -r 150` and sampling pixel-colour histograms with Pillow, resolving several of the open uncertainties above:

- LookAhead cover legend swatches (exact match to spec's stated hex in every case): Events/Speeches/Releases `#558abd`; Issues and Reports `#ccc0d9`; Consultations and Dialogues `#daeef3`; In the News `#e8f3a9`; Awareness Dates `#eaf1dd`.
- LookAhead 1.pdf "Events, Speeches & Releases" table: header row fill **and** Date-column fill are both `#558abd` (exact match to spec).
- LookAhead 1.pdf "Issues and Reports" section (resolves discrepancy #2 precisely): the header bar is **solid black** `#000000` with white text — not "near-black," literally black. The Date column (not the header) carries `#f2dbdb` per row. The Activity/Details+Category+Rls group carries `#ccc0d9` (exact match to the legend's purple) on every row in this section. So the spec's "Header #f2dbdb" claim conflates the header colour with the Date-column tint; the header is actually black on every list-style section (Issues and Reports, In the News, Awareness Dates all pixel-confirmed black-header), while only the Events/Releases and 30/60/90 sections genuinely colour their header bars.
- LookAhead 1.pdf "In the News": Date column `#e8f3a9` (exact match), header black.
- LookAhead 1.pdf "Awareness Dates": Date column `#eaf1dd` (exact match), header black.
- 30-60-90-example.pdf: header row fill and Date-column fill are both `#35989d` (exact match to spec); Issue-row/purple shading is `#ccc0d9` (exact match to the LookAhead legend's "Issues and Reports" colour, reused here).
- PlanningReport.pdf: header row fill is `#384c70` (navy) — resolves this file's "exact hex not determinable" note for discrepancy context; spec gives no hex to compare this against, so it's supplementary data, not a discrepancy.
- ExcelExport.xlsx: header fill `#31869B`, banner/footer text colour `#FF0000` — already captured correctly above (openpyxl styles, not pixel-sampled, but equally exact).

This independent colour pass corroborates the existing report on every point where both methods overlap, and resolves discrepancy #2 to a precise, confident finding: the header-bar colour genuinely is black (not an approximation), and the pale colour the spec names is real but mislabelled as the header — it is the per-row Date-column tint.
