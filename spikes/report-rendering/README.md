# Report-rendering spike

Throwaway research code. Never merged. It renders the Calendar's report layouts from synthetic content in two
PDF approaches (Chromium print, pdfmake) and two Word approaches (HTML→DOCX, and HTML→DOCX plus
post-processing). Then it measures each output and checks it against spec addendum §10.1. The write-up is
`docs/superpowers/plans/2026-10-08-phase-5b-report-rendering-spike.md` on `feat/phase-5b`.

| File | What it does |
|---|---|
| `fixture.mjs` | 1,106 deterministic fictional activities; the 60-day Look Ahead's per-day rows |
| `templates.mjs` | One HTML template per layout (cover, Events day, Planning, 60-day Look Ahead), styled with a `<style>` sheet and CSS paged-media margin boxes |
| `render-chromium.mjs` | HTML → PDF in headless Chromium over a pipe |
| `render-pdfmake.mjs` | HTML → pdfmake document via html-to-pdfmake and jsdom |
| `render-docx.mjs` | HTML → DOCX via @turbodocx/html-to-docx |
| `patch-docx.mjs` | Real PAGE/NUMPAGES fields, a different first-page header, and CT_SectPr element order |
| `measure.mjs`, `run-all.mjs` | Times every sample × size × approach (first run plus a median of 5) and writes `out/<host>/` |
| `variant-inline.mjs` | The same samples with the stylesheet-only requirements inlined, for the two converters that don't read `<style>` |
| `check.mjs` | The fidelity checker; exits non-zero on any failed requirement (needs poppler's `pdftotext`) |

```bash
npx -y -p node@24 -- npm install
npx -y @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/report-spike
export CHROMIUM_PATH=…/chrome-headless-shell   # the path the install prints
npx -y -p node@24 -- node --expose-gc run-all.mjs local
npx -y -p node@24 -- node --expose-gc variant-inline.mjs local-inline
npx -y -p node@24 -- node check.mjs out/local
npx -y -p node@24 -- node check.mjs out/local-inline
```

`apps/stack/src/spike-route.ts` (mounted in `stack.ts` on this branch only) runs `run-all.mjs` from
`<DATA_DIR>/spike` inside the SiteGround app runtime, behind a Core.Admin bearer. It needs the spike copied
there over SSH first.
