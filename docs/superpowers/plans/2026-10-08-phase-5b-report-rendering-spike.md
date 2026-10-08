# Phase 5b report-rendering spike (spec addendum §10.1)

**Spike branch:** `spike/5b-report-rendering` at `29b60bab451f8034946fd865162a25b312389808` (never merged; pushed to origin at `29b60ba`). **Run on:** 2026-10-08, 08:05–08:20 PDT.

## Answer

**PDF:** use Chromium print (puppeteer-core with a headless Chromium). It is the only approach that met every §10.1 requirement from the shared HTML template unchanged. It is also the fastest on the 60-day Look Ahead: a median of 160 ms, against 497 ms for pdfmake without page breaks and 12,544 ms for pdfmake with them.

**Word:** use HTML→DOCX (@turbodocx/html-to-docx) plus our own post-processing. That combination passes every structural check only under three conditions:
- The template carries its colours, row shading and page breaks as inline styles. The converter ignores a style sheet.
- Legal is given to the converter as portrait-ordered twips. It swaps width and height for landscape.
- The post-processing uses the corrected patcher on the spike branch. The plan's version wrote a footer that wasn't well-formed XML.

**Hosts:** all of this was measured on the local macOS host only. The boxs.ca SSH leg and the boxs.ca runtime leg were blocked: SSH publickey refused, and no Core.Admin credential is available without SSH. The container leg wasn't measured: no Docker. So "Chromium runs on SiteGround's Node hosting" is still unverified.

**For Paul before 5g:** nothing has failed on any host, but two hosts are unmeasured. Paul needs to authorise the gcpe-siteground key in Site Tools → SSH Keys so both boxs.ca legs can run. Until they run, 5g should build the rendering seam with pdfmake (inline styles) as the measured no-browser fallback for PDF.

## Candidates

Licences re-checked with `npm view` on 2026-10-08.

| Approach | Packages (version, licence, checked 2026-10-08) | Needs a browser |
|---|---|---|
| PDF: Chromium print | puppeteer-core 25.13.0 (Apache-2.0), @sparticuz/chromium 153.0.0 (MIT; Linux x64, 67 MB brotli bundle) / local chrome-headless-shell 155.0.8059.39 (Chrome for Testing) | yes |
| PDF: pdfmake from the same HTML | pdfmake 0.2.23 (MIT; latest is 0.3.11), html-to-pdfmake 2.5.35 (MIT), jsdom 30.1.2 (MIT) | no |
| Word: HTML→DOCX | @turbodocx/html-to-docx 1.23.1 (MIT) | no |
| Word: HTML→DOCX + post-processing | @turbodocx/html-to-docx 1.23.1 (MIT) + jszip 3.10.1 ("(MIT OR GPL-3.0-or-later)", used under MIT; latest is 3.10.2) | no |

pdf-lib 1.17.1 (MIT) is used only by the measurement and the checker.

## Hosts

| Host | OS / glibc | CPUs | Memory | Node | Chromium | Notes (sandbox, /tmp, /dev/shm, limits) |
|---|---|---|---|---|---|---|
| local (macOS) | macOS 26.6.2 (25G83), no glibc | 14 (Apple M4 Pro) | 24 GiB | v24.21.0 | HeadlessChrome/155.0.8059.39, launched with `--no-sandbox` over a pipe | No /proc, so Chromium's peak was sampled with `ps -o rss` (below) |
| container (node:24-bookworm-slim) | not measured | not measured | not measured | not measured | not measured | Container: not measured (no Docker on this machine's PATH) |
| boxs.ca SSH | not measured | not measured | not measured | not measured | not measured | Blocked. `ssh siteground true` at 08:05 PDT returned `u3460-k2qgingub87y@giowm1240.siteground.biz: Permission denied (publickey).` and `ssh boxs.ca true` returned `ssh: connect to host boxs.ca port 22: Operation timed out`. Paul: authorise the gcpe-siteground key in Site Tools → SSH Keys. |
| boxs.ca runtime | not measured | not measured | not measured | not measured | not measured | Blocked, and nothing was deployed. The route runs the spike from `~/gcpe-data/spike`, which only SSH can reach. Its Core.Admin token is minted from `LOCAL_AUTH_SECRET`, which lives only in the server's env, or comes from the break-glass admin password, which is Paul's. Neither exists locally. To run it, Paul either authorises the SSH key or chooses a second Node.js project in Site Tools (the `deploy/siteground-probe` precedent). |

## Measurements

Local host, `node --expose-gc run-all.mjs local`. Columns:
- "First" is the first run, including warm-up.
- "Median" is the median of the next 5 runs.
- "Node peak" is `process.resourceUsage().maxRSS`, the process's lifetime maximum when the first run ended. It never goes down, so it is cumulative across samples.

Chromium's peak isn't per row (see below).

**Chromium launch:** 245 ms in the final run; 96 ms in an earlier identical run.

| Sample | Size | Approach | First ms | Median ms | Node peak MB | Bytes | Pages | Error |
|---|---|---|---|---|---|---|---|---|
| cover | letter | pdf-chromium | 83 | 33 | 228 | 55435 | 1 | none |
| cover | letter | pdf-pdfmake | 55 | 9 | 235 | 2638 | 1 | none |
| cover | letter | docx-turbodocx | 20 | 8 | 237 | 27516 | n/a | none |
| cover | letter | docx-patched | 10 | 9 | 238 | 28603 | n/a | none |
| events-day | letter | pdf-chromium | 38 | 35 | 243 | 96443 | 2 | none |
| events-day | letter | pdf-pdfmake | 30 | 27 | 249 | 10636 | 2 | none |
| events-day | letter | docx-turbodocx | 19 | 20 | 251 | 67874 | n/a | none |
| events-day | letter | docx-patched | 23 | 22 | 252 | 68961 | n/a | none |
| events-day | legal | pdf-chromium | 35 | 36 | 252 | 96358 | 2 | none |
| events-day | legal | pdf-pdfmake | 25 | 25 | 252 | 10102 | 1 | none |
| events-day | legal | docx-turbodocx | 20 | 20 | 252 | 67875 | n/a | none |
| events-day | legal | docx-patched | 22 | 22 | 252 | 68962 | n/a | none |
| planning | legal | pdf-chromium | 41 | 41 | 253 | 147871 | 6 | none |
| planning | legal | pdf-pdfmake | 51 | 47 | 283 | 24360 | 5 | none |
| planning | legal | docx-turbodocx | 41 | 43 | 314 | 163611 | n/a | none |
| planning | legal | docx-patched | 45 | 44 | 315 | 164698 | n/a | none |

**Chromium peak memory (local).** A separate `look-ahead-60` run was sampled every ~50 ms with `ps -axo rss,comm`. The largest sum of RSS across the chrome-headless-shell processes was 417,664 KB over 5 processes. That sum counts shared pages more than once, so it is an upper bound.

### The 60-day Look Ahead

The 1,106-activity fixture has 679 rows across 60 days. Two runs are shown:
- **Shared template:** the template carries its styles in a style sheet.
- **Inline styles:** `variant-inline.mjs`, which inlines the header colours, the row shading and a page break before each day. It's used for the two converters that don't read a style sheet.

| Template | Approach | First ms | Median ms | Node peak MB | Bytes | Pages |
|---|---|---|---|---|---|---|
| shared | pdf-chromium | 180 | 160 | 338 | 1722657 | 67 |
| shared | pdf-pdfmake | 517 | 497 | 383 | 307552 | 38 |
| shared | docx-turbodocx | 297 | 306 | 402 | 1628699 | n/a |
| shared | docx-patched | 308 | 319 | 413 | 1629786 | n/a |
| inline | pdf-pdfmake | 12656 | 12544 | 495 | 341777 | 62 |
| inline | docx-patched | 350 | 340 | 520 | 1785126 | n/a |

With page breaks on, pdfmake is 25 times slower (12,544 ms against 497 ms). pdfmake calls its `pageBreakBefore` callback for every node and re-lays out the document.

The inline-style run's other samples, first and median ms:
- events-day letter: pdfmake 91 / 36; docx-patched 35 / 25.
- events-day legal: pdfmake 35 / 34; docx-patched 23 / 23.
- planning legal: pdfmake 55 / 48; docx-patched 52 / 46.

## Fidelity

`check.mjs` was run on both output folders. Final results:
- `out/local` (shared template): 184 passes, 33 failures, exit 1.
- `out/local-inline`: 112 passes, 0 failures, exit 0.

PDF colours were read as exact pixel values from `pdftoppm -r 60` renders, not with a colour picker:
- Chromium: Events page 1 has `558abd` (9,719 px) and `f2f2f2` (79,436 px). Planning page 1 has `384c70` (10,814 px) and `f2f2f2` (112,354 px).
- pdfmake, shared template: Events has no `558abd` pixels at all, and Planning's 707 `384c70` pixels are the heading text.
- pdfmake, inline styles: Events has `558abd` (6,926 px) and `f2f2f2` (76,122 px). Planning has `384c70` (7,791 px) and `f2f2f2` (120,065 px).

| Requirement (§10.1) | PDF Chromium | PDF pdfmake | DOCX | DOCX patched |
|---|---|---|---|---|
| Letter portrait | ✓ "page size 612×792" on all 3 Letter samples | ✓ "page size 612×792" on all 3 | ✓ "page size 12240×15840 twips" on all 3 | ✓ "page size 12240×15840 twips" on all 3 |
| Legal landscape (35.56 × 21.59 cm) | ✓ "page size 1008×612" on events-day and planning | ✓ "page size 1008×612" on both | ✗ "page size 20160×12240 twips" fails on both: the converter writes w:w 12240, w:h 20160 with orient landscape | ✗ as DOCX with the plan's page options; ✓ in the inline run, given portrait-ordered twips |
| Page-1 header differs from later pages | ✓ "page-1 header" and "later-page header differs" on all 4 multi-page PDFs | ✓ on all 3 multi-page PDFs | ✗ "a different first-page header" fails on all 5 | ✓ "a different first-page header" on all 5 |
| "Page X of Y" | ✓ 78 of 78 pages | ✓ 47 of 47 pages | ✗ "Page X of Y fields in the footer" fails on all 5: the footer holds the literal text | ✓ on all 5 (fldSimple PAGE and NUMPAGES), and every XML part is well-formed |
| Coloured header cells (#558abd, #384c70) | ✓ exact pixels (above) | ✗ with the shared template (no fill pixels); ✓ inline | ✗ no th fill in events-day or planning (the 2 regex passes are the cover legend's swatch, not a header cell) | ✗ with the shared template; ✓ in all 4 inline samples |
| Alternating row shading | ✓ exact pixels (above) | ✗ with the shared template; ✓ inline | ✗ "alternating row shading" fails on all 5 | ✗ with the shared template; ✓ in all 4 inline samples |
| Forced page breaks | ✓ "a forced break before each day (60 of 60 day headings start a page)" | ✗ "(1 of 60 day headings start a page)" with the shared template; ✓ 60 of 60 inline | ✗ "forced page breaks" fails | ✗ with the shared template; ✓ inline (60 pageBreakBefore) |

All results are from the local host only. No other host produced outputs.

**The three §10.1 assumptions:**
- **"Chromium runs on SiteGround's Node hosting": not verified.** Neither boxs.ca leg could run: SSH was refused, and the runtime route needs files in `DATA_DIR` plus a server-side credential. This assumption is still open.
- **"Chromium honours @page :first margins and a different first-page header": verified (local).** Every multi-page Chromium PDF has the first-page running text on page 1 and the later-page text on page 2. "Page X of Y" comes from `counter(pages)` on all 78 pages checked. Each of the 60 days starts a page. A day longer than one page continues under its repeated table header (page 3 of the Look Ahead).
- **"The DOCX converter supports running headers and footers with Page X of Y": refuted for the converter alone, verified with post-processing (structurally).**
  - On its own, @turbodocx/html-to-docx writes one header and one footer. "Page X of Y" stays as literal text, and there is no first-page variant.
  - The patcher adds real PAGE/NUMPAGES fields and a first-page header (`w:titlePg` plus a "first" header part). It also moves the converter's header and footer references to the front of `w:sectPr`, as CT_SectPr requires; the converter writes them after `w:pgSz`/`w:pgMar`.
  - Verified by `check.mjs`, xmllint and jsdom XML parsing. Not verified in Word, LibreOffice or Pages.
  - The `r:` namespace was already declared on the root of `document.xml`, so no extra declaration was needed.

**Corrections made to the spike during the run** (each is in the spike commit):
- **The plan's `patch-docx.mjs` produced a corrupt footer in every patched DOCX** (9 of 9). The converter writes its footer in the default namespace (`ftr`/`p`/`r`/`t`), and the plan's field splice closed it with `w:t`/`w:r` end tags. xmllint and jsdom both reject `word/footer1.xml`, so Word would refuse or "repair" the file. The plan's checker passed it because it only searched for the text "PAGE". The patcher now splices in the part's own prefix and declares `w:` on the field. The checker now requires real `w:fldSimple` fields and well-formed XML in every part. It failed 4 of 4 patched files before the fix and passes 4 of 4 after.
- **The plan's Look Ahead page-break check read the blank line under the running header**, so it failed Chromium's correct output. It now requires all 60 day headings to be the first line under their page's running header.

## Recommendation for 5g

1. **One rendering module behind one interface**, for example `renderReport(html, format, size)` returning bytes plus a content type. It holds a Chromium PDF backend, a pdfmake PDF backend and a DOCX backend (turbodocx plus the patcher), picked per host by configuration. A host without Chromium then uses pdfmake without any template changes.
2. **Templates emit inline styles for everything the PDF fallback and DOCX need**: header fill and text colour, row shading, and page breaks, as `page-break-before: always` plus a class for pdfmake. Alternatively, run one style-inlining step before the two converters. Keep the CSS margin boxes for Chromium's running text. Give pdfmake and DOCX the running text through their own header and footer options, as the spike does. Skip the page break before the first day of a single-day report: pdfmake otherwise leaves a blank page 1, as the inline events-day sample did.
3. **DOCX:**
   - Give the converter Legal as width 12240 and height 20160 with orientation landscape. It swaps them.
   - Always run the corrected post-processing step.
   - Add an XML well-formedness test over every part of every generated DOCX to 5g's test suite.
4. **Limits measured locally:**
   - The 60-day Look Ahead takes 160 ms to render in Chromium after launch, 340 ms as patched DOCX, and 12.5 s in pdfmake with page breaks.
   - Node's peak RSS reached 520 MB by the end of the inline run, and Chromium's process tree summed to at most 418 MB.
   - The boxs.ca limits are unknown until its legs run. On this evidence, budget for a 1 GB process (assumed) and render in the background rather than inside one HTTP request on SiteGround. Its proxy timeout and idle kill are unmeasured.
5. **Paul decides:**
   - Authorise the gcpe-siteground SSH key, so the SSH leg and the runtime leg can run before 5g relies on Chromium at boxs.ca.
   - Or accept pdfmake as boxs.ca's PDF backend. boxs.ca is test-only.
   - Whether Chromium (67 MB compressed for Linux) may ship in, or beside, the SiteGround artifact.

## Risks and what wasn't checked

- **Word itself never opened any DOCX.** There is no Word or LibreOffice on this machine. An attempt to export through Pages via AppleScript timed out (AppleEvent timeout -1712), so no word processor confirmed the headers, the fields, the shading or the page breaks. The DOCX ✓ marks are structural, from `check.mjs` plus well-formedness. The patched files still contain the converter's own namespace style (default-namespace header and footer parts with `ns1:`-prefixed attributes); whether Word accepts that is untested.
- **No host but macOS was measured.** The container leg had no Docker. Both boxs.ca legs were blocked. Chromium on SiteGround (shared libraries, sandbox, an executable /tmp, process limits) is entirely unverified, as is the runtime's proxy timeout.
- **`startedAt` on `/stack/health` changes without any deploy.** It moved from 2026-10-08T15:05:01.919Z (pid 72809) to 15:19:41.382Z (pid 9093) during this run, with nothing deployed: SiteGround's idle kill restarts the process. When the runtime leg runs, a changed `startedAt` alone can't show a memory kill. Keep the process busy between calls, or compare against an idle baseline.
- **Memory figures are approximate.** "Node peak MB" is cumulative within one process. The Chromium figure is a sum of RSS across processes, which over-counts shared memory.
- **pdfmake 0.2.23 is a major version behind** (0.3.11 is current). The `pageBreakBefore` slowdown wasn't measured on 0.3.
- **SVG images:** the converter warned about SVG support, and pdfmake drops the SVG cover by design here. The cover image path for DOCX and pdfmake was not checked visually.
- **The spike branch is pushed to origin** at `29b60ba` (`origin/spike/5b-report-rendering`), so this report's SHA resolves from any clone.

## Reproduce

Spike branch, `spikes/report-rendering`:

```bash
npx -y -p node@24 -- npm install
npx -y @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/report-spike
export CHROMIUM_PATH=~/.cache/report-spike/chrome-headless-shell/mac_arm-155.0.8059.39/chrome-headless-shell-mac-arm64/chrome-headless-shell
npx -y -p node@24 -- node --expose-gc run-all.mjs local
npx -y -p node@24 -- node --expose-gc variant-inline.mjs local-inline
npx -y -p node@24 -- node check.mjs out/local          # exit 1: 33 findings
npx -y -p node@24 -- node check.mjs out/local-inline   # exit 0
```

Once SSH works, the boxs.ca legs are Steps 7 and 8 of Task 5 in `2026-10-08-phase-5b2-calendar-users-and-report-spike.md`. Those steps rsync the spike to `~/gcpe-data/spike`, run it with `/usr/local/bin/node-24`, deploy the spike branch with its Core.Admin-gated `POST /stack/spike/report?only=…`, and then redeploy the live artifact.
