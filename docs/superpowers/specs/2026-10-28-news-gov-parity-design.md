# news.gov.bc.ca parity: design

Date: 2026-10-28. Owner: Paul (GCPE). Status: working design. The owner asked for autonomous delivery, so the calls marked **[call]** below were made by Claude and can be overturned.

## 1. Intent

The platform's static public site **replaces news.gov.bc.ca** at cutover. This reverses decision D1 in `2026-10-11-public-site-ai-design.md`, where BC kept `gcpe-news-webapp`.

The owner's goal, in their words:
- Parity with "the look and feel of news.gov.bc.ca".
- It must "seamlessly not break anything".
- "Admin screens for everything we could need", so staff never depend on a developer to change what the public sees.

**What success looks like:**
- A reader who knows news.gov.bc.ca sees the same site, on desktop and phone.
- Every link to news.gov.bc.ca that works today still works after DNS moves: emails, search engines, social posts, other gov sites, RSS readers, and unsubscribe links in emails already sent.
- Every value staff might change is in the Hub.

**Anti-goals (a failure even if it "works"):**
- Accessibility worse than our current site. We keep WCAG 2.1 AA wins where legacy falls short (look-and-feel §5).
- Any legacy URL that 404s at cutover without a deliberate, recorded reason.
- A value staff change today that becomes developer-only.
- Breaking boxs.ca for testers mid-build. Each piece ships working.

**Non-goals:**
- Reproducing legacy defects, such as missing `<h1>`s, `role="menu"` without menu keyboard behaviour, or the auto-rotating carousel (C205 stands).
- Pixel-identical body content. Posts differ by data; chrome is matched strictly, body layout closely.

## 2. Inputs (evidence; read these for detail)

All are in `docs/parity/inputs/`, gathered 2026-10-27:
- `gap-audit.md`: 30 public gaps (H1–H6, M1–M17, L1–L7) with live URLs checked. H1, M1 and H6 are fixed in PR #46.
- `look-and-feel.md`: legacy markup skeletons, CSS/assets with sizes, theme mapping, 18 accessibility deviations, 10 visual chunks, and screenshots in `.playwright-mcp/lookfeel-*.png` in the owner's workspace.
- `admin-editability.md`: every public value, where it's edited today, and Hub screen tasks T1–T10.
- `url-compat.md`: every legacy URL pattern with handling, and tasks T0–T10.

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| P1 | D1 reversed: the static site replaces news.gov.bc.ca. C202 (no legacy redirects) and C206 (posts only under `/releases/`) are reopened. Legacy URLs resolve or 301. | Owner, 2026-10-27. |
| P2 | Serve the site at the origin root (`/`), keeping `/site/` working (301 to the root equivalent) until cutover. `PUBLIC_SITE_URL` becomes the origin. | news.gov URLs are root-relative (url-compat T0). |
| P3 | **Look:** vendor legacy CSS largely as-is and emit the legacy class skeleton from our renderers, keeping our semantic/accessibility structure. Includes Bootstrap 5.3.3, site, custom, transforms, accessibility, print, granville and a small `overrides.css`. No jQuery; one small vanilla JS file. Font Awesome is replaced by an inline SVG sprite. | The legacy code is Apache-2.0. Its 3.5k-line site.css encodes measured spacing that re-authoring would miss (look-and-feel §6). |
| P4 | **[call] Font:** BC Sans from the `@bcgov/bc-sans` npm package (OFL-1.1), already a Hub dependency, copied into site assets with its licence. | Resolves the font half of Q76 without new licensing. |
| P5 | **Logo: owner decision pending (Q76).** The repo is public and the BC logo is a brand mark, not Apache-2.0. Until answered, the header uses the existing mechanism: the logo shows only when an operator places the file in `config/site/assets/`. The layout reserves its space so nothing shifts when it's added. | Brand/legal call that only GCPE can make. |
| P6 | Every accessibility deviation in look-and-feel §5 is adopted: one real `<h1>` per page, a single `main`, skip-link targets, no `role="menu"`, alt text, keyboard-reachable controls, per-page `<title>`, and long-URL wrapping. | Anti-goal 1. |
| P7 | Theme colours: legacy CSS variables alias our five site-settings colours (look-and-feel §4). Legacy link colour maps to `primary`. Admin colour edits change only `theme.css`. | Keeps admin control. |
| P8 | **[call] Media contacts are free-text fields** (name, title, phone, cell, email) on the ministry form, not Hub-user pickers. | Core users have no phone fields. |
| P9 | **[call] No new role.** Ministry contacts and bios are edited by whoever edits ministry profiles (`Core.Admin`, `NRMS.SiteEditor` as today). Page text and the contacts directory are edited by `NRMS.SiteEditor`. Terms are edited by `Core.Admin`. | Matches existing screens. A narrower media-relations role can be added later. |
| P10 | **[call] Legacy subscription links keep working:** import legacy subscriber tokens so `/subscribe/manage?token=…` from old emails resolves (url-compat T7, option 2). | "Nothing breaks." |
| P11 | **[call] Search shows 10 results per page** on the public page, as legacy does. The API's default page size is unchanged. | Parity. |
| P12 | **[call] 404:** a styled 404 inside the site chrome, with a search box prefilled from the missing path's words. This is legacy's intent (a search for the page) without legacy's behaviour of silently returning search results with a 200. | Parity of usefulness, with a correct status. |
| P13 | **[call] Analytics:** Snowplow (BC's own collector) behind an operator config flag, off on boxs.ca. | Test traffic must not pollute BC stats. Production on/off is GCPE's call. |
| P14 | Text that legacy hardcodes becomes editable site settings with today's text as defaults. This covers the land acknowledgement, Notice of Collection, privacy page, 404 text, live page text, the 24-hour media line and multicultural contacts, the Blue Bridge text and the slide action label. | Owner requirement; admin-editability §1. |
| P15 | Operator-owned (not in the Hub): base URL, time zone, language, test-site noindex/robots, analytics IDs, search-console token, logo/font files, webcast fallback URLs. | admin-editability §2. These are deployment facts, not editorial content. |
| P16 | Checks are against the **live** news.gov.bc.ca, not only the legacy repo. The repo is behind production; e.g. live ministry keys like `transportation-and-transit` are missing from it. | url-compat §0. |

## 4. Workstreams

Each workstream is cut into tasks, each with its own test. A piece is deployed to boxs.ca as soon as it is green. Order is by public visibility, and nothing ships that breaks a page testers use.

**A. Foundation.**
- Root mount and `/site/` 301s (P2).
- Asset pipeline: vendored CSS, BC Sans, SVG sprite, favicon.
- Legacy `<head>`.
- Header: logo slot, "News" ministry menu, Subscribe, search, mobile drawer.
- Footer with land acknowledgement band. The text is editable, adding a `landAcknowledgement` field to site settings.
- Theme aliases.
- Banner and Blue Bridge skeletons.
- Styled 404 (P12).

Source: look-and-feel chunks 1–4 and the 404 part of chunk 9.

**B. Pages, look and content.** Look-and-feel chunks 5–9 merged with gaps:
- **Home**, plus L6.
- **Release page:**
  - all documents/backgrounders (M3);
  - kind label and time (M4);
  - share and OG/Twitter tags (M5);
  - lead media and embeds (M6);
  - side column and related fallback (M7);
  - translations and assets (L3).
- **Ministry page:**
  - minister card complete (M2);
  - biography page (H2);
  - Premier and ministers of state (M15).
- **Ministries index and category pages:**
  - thumbnails and badges (M8);
  - category indexes (M16);
  - per-kind listings Factsheets/Stories/Updates/Releases, including per ministry (H5).
- **Search:**
  - 10 per page (P11);
  - legacy filters (M9).
- **Archive.**
- **Subscribe/manage:** Notice of Collection (M14).
- **Connect:**
  - LinkedIn, RSS list and policy link (M12);
  - icon strip (L6).
- **New pages:**
  - Media Contacts directory `/contacts` (H3), replacing the outbound link;
  - Live webcast `/live` and its nav item (H4);
  - Privacy `/privacy` (L1);
  - HTML sitemap (L2).
- **Feeds:** RSS/Atom coverage (M10).

**C. URL compatibility.** url-compat T1–T6, T8 and T10:
- data-driven redirect middleware before static;
- case-insensitive resolution;
- long keys over 100 characters (M17);
- ministry rename table extracted from source and checked against live;
- NEWS-n references;
- `/tags/` vs `/news-subscribe/` (L4);
- missing feeds;
- legacy subscription tokens (P10, T7);
- the Search Console file and robots rules;
- a cutover rehearsal script that requests the top-N legacy URLs against a host and fails on any non-2xx/3xx.

T9 (pull 90 days of legacy access logs) needs BC's server access, so it is listed for the owner.

**D. Hub admin screens.** admin-editability T1–T10:
- **T1:** minister bio editor, using the release rich-text editor; Premier's team links.
- **T2:** ministry media contacts (P8).
- **T3:** Media Contacts directory settings.
- **T4:** page text (P14).
- **T5:** navigation and home headings.
- **T6:** slide/pin action label.
- **T7:** Connect completion (LinkedIn).
- **T8:** Sectors, themes and tags screen. Previously queued.
- **T9:** release kinds / page titles.
- **T10:** site identity, including the Blue Bridge text.

Each Hub screen ships with, or before, the public page that consumes it.

**E. Verification harness (built first, used by every task).**
- A Playwright script loads paired URLs on news.gov.bc.ca and the target host at 1280×900 and 390×844, and saves PNGs.
- It reports a pixel-diff per region: header, banner and footer are compared strictly, main loosely.
- It runs `@axe-core/playwright` on ours, with 0 serious/critical as the gate.
- It runs the URL rehearsal script from C.

The harness lives in `tools/parity/` and runs locally and on demand against boxs.ca, not in CI. CI stays deterministic.

## 5. Sequencing

1. **E + A** (plan 1): the visible repaint of every page's frame. Plus T4's land-acknowledgement field, so the footer band is editable from day one.
2. **B: home, release, ministry with bio** (plan 2), with **D: T1, T2**.
3. **C: URL compatibility** (plan 3). The root mount itself lands in plan 1, because everything else builds on it.
4. **B: remaining pages and new pages** (plan 4), with **D: T3, T4 (rest), T5–T7**.
5. **D: T8–T10 and leftovers** (plan 5), plus a final full parity rerun of the audit against boxs.ca.

Each plan is written when the previous one is underway, so it can use what was learned.

## 6. Done means

- The parity audit, rerun against boxs.ca, finds no High or Medium gap that isn't a recorded deliberate difference.
- The harness passes:
  - chrome diffs are within threshold at both widths for home, release, ministry, category, search, subscribe, connect and contacts;
  - axe reports 0 serious/critical;
  - the URL rehearsal returns 100% 2xx/3xx on the legacy URL list.
- Every row in admin-editability §1 is "editable" or operator-owned per P15.
- `docs/parity/changes-from-legacy.md` records every remaining deliberate difference. D1, C202 and C206 are updated.

## 7. Open for the owner

- **Q76 logo** (P5): may the public repo carry the BC logo, or should the deploy supply it privately?
- **Analytics in production** (P13).
- **Legacy access logs** for url-compat T9: needs BC server access.
- **Other hosts** pointing at news.gov (url-compat §3), only if their DNS moves too.
