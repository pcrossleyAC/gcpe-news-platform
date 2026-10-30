# Staff Manuals in the Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Role-based staff manuals, written in plain language, readable in Hub Help, downloadable as Word, and kept current by a CI check. Core admins get a review list of changed pages.

**Architecture:** Manual pages are Markdown files under `docs/manuals/`, each with a small front-matter header. `npm run manuals:build` compiles them into a committed JSON module inside staff-web: rendered HTML, a content hash, a last-changed date and the previous version's HTML. A freshness test fails when that JSON is stale. This keeps git and `docs/` out of every build: `.dockerignore` excludes `docs/`, and Windows and Docker builds have no `.git`. The Hub renders the JSON by role. `build-staff-web.mjs` also writes one .docx per manual from the same JSON. A CI step diffs each PR against `main` and fails when a screen folder named by a page changed but no page did. A small Core table records review marks.

**Tech Stack:** TypeScript, React 19 + react-router 7 (apps/staff-web, built by esbuild via scripts/build-staff-web.mjs), Express 5 + drizzle/Postgres (apps/core), vitest, Playwright, GitHub Actions. New dev dependencies, exact versions pinned: `marked` (Markdown → HTML at manuals:build) and `docx` (Word at build-staff-web).

**Spec:** `docs/superpowers/specs/2026-10-30-staff-manuals-design.md`

## Global Constraints

- Audience order: Core admin first, then the top role per app (NRMS.SiteEditor; NoD.Admin; Calendar.SysAdmin + Calendar.Administrator), then the lower roles (NRMS.Editor → NRMS.Viewer; NoD.Editor → NoD.Viewer; Calendar.Advanced → Calendar.Editor → Calendar.ReadOnly).
- Visibility (owner, 2026-10-30): a Core admin sees every manual. A role also sees the manuals of the roles below it in the same app. Each reader's own manual or manuals are listed first. Nobody sees manuals for roles above their own or for apps they have no role in.
- Visibility reuses the existing predicates in `apps/staff-web/src/shell/nav.ts` and the `access.ts` files. Role lists are never re-typed.
- Writing (owner): "not too technical or word-salad like". No API paths, database words or internal jargon. Role ids appear only on the "Who this is for" line, beside the role's plain name. Screens and buttons are named exactly as on screen. No filler intros and no restated headings. Only describe what the reader can see and do.
- Operations and developer material stays out of the manuals; it lives in `docs/deploy/`.
- Manual changes go live with the code. The owner reviews later through the review list.
- Accessibility: axe 0 violations; no horizontal page scroll at 390 px; Hub component vocabulary and styles.
- Commits: plain descriptive sentences. NO Co-Authored-By, NO Claude-Session, no "Generated with Claude". The owner forbids Claude attribution.
- Keep `deploy/openshift/` and `docs/deploy/` in sync for any new migration, env var, runtime file or port, in the same task.

## Rulings (controller, made while planning; spec §8 refined)

- **No git at build.** Spec §8 said dates and the before text come "from git at build". They come from the committed `manuals.generated.json` instead, which `npm run manuals:build` updates. This gives the same result without needing git history in Docker, Windows or SiteGround builds. Cost if wrong: a stale JSON. The freshness test catches that.
- **Word files are static.** They are served as static files under `/hub/manuals/`, like the Hub bundle, which already ships every Help string. The Hub links only the manuals the reader can see, but the files themselves are not access-controlled. Cost if wrong: a non-staff person could fetch staff instructions that contain no secrets.

## Review Focus

1. A signed-in user with no app role (only Core.Read, say) opens Help. Expected: shortcuts and glossary, a "No manuals for your roles" line, no error. Test in Task 2.
2. A user with roles in two apps, e.g. NRMS.Editor and Calendar.ReadOnly. Expected: both apps' manuals, each own manual first; no Site editor or Calendar admin manual. Test in Task 2.
3. A deep link to a manual or page the reader may not see. Expected: "This manual isn't available for your role" and no content in the DOM. Test in Task 2.
4. A page deleted or renamed in `docs/manuals/`. Expected: `manuals:build` drops it, the freshness test passes after the rebuild, and the review list doesn't crash on review marks for pages that no longer exist. Tests in Tasks 1 and 4.
5. A topic page linked from two pages of one manual. Expected: it appears once in that manual's Word file. Test in Task 3.

---

### Task 1: Page format, compiler, freshness test and plain-language test

**Files:**
- Create: `scripts/manuals-lib.mjs` (pure functions), `scripts/manuals-build.mjs` (CLI)
- Create: `apps/staff-web/src/manuals/catalog.ts` (manual ids, titles, plain role names, visibility, rank)
- Create: `apps/staff-web/src/manuals/manuals.generated.json` (written by the CLI, committed)
- Create: `docs/manuals/README.md` (how to write a page: header fields, the writing rules)
- Create: `docs/manuals/core-admin/index.md` (a one-paragraph stub so the pipeline has a real page; Task 5 replaces it)
- Test: `scripts/manuals-lib.test.ts`, `apps/staff-web/src/manuals/freshness.test.ts`, `apps/staff-web/src/manuals/plain-language.test.ts`
- Modify: root `package.json` (`"manuals:build": "node scripts/manuals-build.mjs"`; `marked` devDependency, exact version)

**Interfaces:**
- Produces: the page header (YAML front matter):
  - `id` (kebab, unique);
  - `title`;
  - `manual` (a `ManualId`, or `topic` for a cross-app topic page);
  - `order` (number);
  - `routes` (Hub paths such as `/government-terms`; may be empty);
  - `screens` (folders under `apps/staff-web/src/screens/`, e.g. `admin/government-terms`; may be empty);
  - `topics` (ids of topic pages it links to; may be empty).
- Produces: `type ManualId = "core-admin" | "nrms-site-editor" | "nrms-editor" | "nrms-viewer" | "nod-admin" | "nod-editor" | "nod-viewer" | "calendar-admin" | "calendar-advanced" | "calendar-editor" | "calendar-readonly"`. `calendar-admin` covers Calendar.SysAdmin and Calendar.Administrator.
- Produces: `interface ManualPage { id; title; manual: ManualId | "topic"; order; routes: string[]; screens: string[]; topics: string[]; markdown: string /* source body, for Word */; html: string; hash: string; changed: string /* YYYY-MM-DD */; previous: { html: string; changed: string } | null }`. Also `interface ManualsData { pages: ManualPage[] }` as the JSON's shape.
- Produces from catalog.ts:
  - `MANUALS: { id: ManualId; title: string; forRoles: string /* plain words */; app: "core" | "nrms" | "nod" | "calendar"; level: number /* 0 = top */ ; heldBy(s: SessionValue): boolean }[]`;
  - `visibleManuals(s: SessionValue): ManualId[]`, in display order. Order: own manuals first, by app (core, nrms, nod, calendar), then lower roles per app; a Core admin gets core-admin first, then all the others in that order.
- Produces from manuals-lib.mjs:
  - `parsePage(path, text) → { header, body }`, which throws with the file path on a missing or unknown field;
  - `compile(pages, previousData, today) → ManualsData`. `hash` is the sha256 of the body plus the header. When the hash changed, set `changed = today` and `previous = { html: old.html, changed: old.changed }`. When it didn't, keep both as they were.

- [ ] **Step 1: Write failing tests**
  - `manuals-lib.test.ts` covers:
    - a header with an unknown `manual` throws, and the message names the file;
    - duplicate ids throw;
    - unchanged input keeps `changed` and `previous`;
    - edited input sets `changed: today` and `previous` to the old html and date;
    - a page missing from the input is dropped (Review Focus 4);
    - raw HTML in Markdown is escaped (`<script>` becomes `&lt;script&gt;`).
  - `freshness.test.ts` recompiles `docs/manuals/**` against the committed JSON with the same `today` as each page's `changed`. It fails when the hashes differ, with the message `Manual pages changed: run npm run manuals:build`.
  - `plain-language.test.ts` fails on any page body that contains:
    - `/api/`;
    - a role id (`Core.Admin`, `NRMS.`, `NoD.`, `Calendar.`) outside the line that begins `**Who this is for:**`;
    - the words `database`, `endpoint`, `JSON`, `SQL`, `payload`, `boolean`, `null`;
    - a heading immediately repeated as the first sentence.
  - It also covers the visibility rules in a `catalog.test.ts`:
    - Core.Admin sees all 11 manuals, core-admin first;
    - NRMS.SiteEditor sees `["nrms-site-editor","nrms-editor","nrms-viewer"]`;
    - NRMS.Editor plus Calendar.ReadOnly sees `["nrms-editor","calendar-readonly","nrms-viewer"]`, which is own manuals first, then lower ones;
    - Calendar.Administrator sees calendar-admin and all three lower Calendar manuals;
    - a user with no role sees `[]`.
- [ ] **Step 2: Run them and see them fail.** Command: `npx vitest run scripts/manuals-lib.test.ts apps/staff-web/src/manuals`.
- [ ] **Step 3: Implement.** Use `marked` with HTML escaping for the compiler, and `JSON.stringify(…, null, 2)` with a trailing newline, so diffs stay readable. `today` is the BC calendar date (America/Vancouver).
- [ ] **Step 4: Run `npm run manuals:build`, then the tests, and confirm they pass.** Also run `npm run check`.
- [ ] **Step 5: Commit.**

### Task 2: Manuals in Hub Help, by role, with context Help

**Files:**
- Create: `apps/staff-web/src/screens/help/ManualScreen.tsx` (one manual's contents and one page), `ManualScreen.test.tsx`
- Modify: `apps/staff-web/src/screens/help/HelpScreen.tsx` (a "Manuals" section listing `visibleManuals`, then the existing How do I…, shortcuts and glossary), `apps/staff-web/src/router.tsx` (`help/manuals/:manualId` and `help/manuals/:manualId/:pageId`), `apps/staff-web/src/shell/AppShell.tsx` (the header Help opens `helpTargetFor(pathname)`), `apps/staff-web/src/styles/global.css`
- Create: `apps/staff-web/src/manuals/help-target.ts` + test

**Interfaces:**
- Consumes: `ManualsData`, `visibleManuals`, `MANUALS` (Task 1).
- Produces: `helpTargetFor(pathname: string, s: SessionValue): string`.
  - It returns `/help/manuals/<manual>/<page>` for the first visible page whose `routes` matches the longest prefix of the path, preferring the reader's own manual.
  - Otherwise it returns the current area's How do I… anchor, as today.
  - Otherwise it returns `/help`.

- [ ] **Step 1: Failing tests:**
  - Review Focus 1, 2 and 3, as stated.
  - A topic page is visible to a reader when any page they can see lists it in `topics`, and it is otherwise "not available".
  - A manual page shows "Who this is for", its contents, and "Last changed <long date>".
  - `helpTargetFor("/government-terms", coreAdmin)` returns the government-terms page. For an NRMS.Editor on `/releases/123`, it returns the editor manual's release page, not the site editor's.
  - Axe finds 0 violations on Help, a manual index and a page (extend `a11y.test.tsx` or the Help test's axe check).
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Render page HTML with `dangerouslySetInnerHTML`; it is build-time content from the repo, already escaped in Task 1. Links between pages are written in Markdown as `manual:<id>` or `topic:<id>`, and the compiler rewrites them to Hub routes. Add that rewrite to Task 1's lib with its own test.
- [ ] **Step 4: Run all staff-web tests and confirm they pass, then run `npm run check`.** Take screenshots at 390 and 1280 on a local review Hub and confirm there is no sideways scroll.
- [ ] **Step 5: Commit.**

### Task 3: Download as Word

**Files:**
- Create: `scripts/manuals-docx.mjs` exporting `buildManualDocx(data: ManualsData, manualId, opts: { logoPath: string; versionDate: string }) → Promise<Buffer>` and `writeAllDocx(outDir)`, + `scripts/manuals-docx.test.ts`
- Modify: `scripts/build-staff-web.mjs`, which calls `writeAllDocx` and writes `dist/manuals/<manualId>.docx` for all 11 manuals; root `package.json` (`docx` devDependency, exact version); `ManualScreen.tsx` (a "Download as Word" link to `/hub/manuals/<id>.docx`, shown only for visible manuals)

**Interfaces:**
- Consumes: `ManualsData` (Task 1).
- Produces: one .docx per manual. The cover holds the manual title, "For: <forRoles>", and "Software version of <long date>", where the date is the newest `changed` among the included pages. The contents follow the manual's page order, and each topic page is inlined once after the pages, under "Topics" (Review Focus 5). The logo is `apps/public-site/assets/legacy/Content/Images/SocialMedia/32x32-bc-logo.png`, or a larger BC logo if the repo has one.

- [ ] **Step 1: Failing tests.**
  - Unzip the buffer, read `word/document.xml`, and confirm it contains the manual title, the For line, every page title, and a topic title exactly once even when two pages link it.
  - A page's headings, lists, tables and links survive as Word headings, lists, tables and plain-text URLs.
  - `writeAllDocx` writes 11 files.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Map the Markdown token stream (`marked.lexer` on each page's `markdown` field from Task 1) to docx paragraphs. Build-time only, so nothing is added to the runtime image.
- [ ] **Step 4: Run `node scripts/build-staff-web.mjs` and confirm the 11 files exist, then open one with a docx reader (python-docx or unzip) and spot-check it.** Also run `npm run deploy:siteground` locally (do not push), to confirm the SiteGround artifact contains `hub/manuals/*.docx`.
- [ ] **Step 5: Commit.**

### Task 4: Up-to-date CI check

**Files:**
- Create: `scripts/check-manuals-current.mjs` exporting `missingManualUpdates(changedFiles: string[], pages: ManualPage[], commitMessages: string[]): string[]` (one message per screen folder at fault) + CLI (`--base origin/main`), `scripts/check-manuals-current.test.ts`
- Modify: `.github/workflows/ci.yml`. Add a step on `pull_request` that runs `node scripts/check-manuals-current.mjs --base origin/${{ github.base_ref }}`; the checkout in that job needs `fetch-depth: 0`.

**Interfaces:**
- Consumes: `screens` in the page headers (Task 1).
- Rule: a changed file under `apps/staff-web/src/screens/<folder>/` counts only if it is not `*.test.*`. For each such file whose folder matches some page's `screens` entry, at least one page naming that folder must also have changed under `docs/manuals/`. A commit message containing a line exactly `Manual: no change` exempts the whole PR. A folder no page names is not checked.

- [ ] **Step 1: Failing tests:**
  - A changed `admin/government-terms/StartTermForm.tsx` with no manual change gives one message naming the folder and the page ids that cover it.
  - The same change plus a change to a page naming that folder gives `[]`.
  - The same change with a test file only gives `[]`.
  - The `Manual: no change` trailer gives `[]`.
  - An unnamed folder gives `[]`.
  - A deleted page (Review Focus 4) is handled.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** The CLI uses `git diff --name-only <base>...HEAD` and `git log --format=%B <base>..HEAD`. Document the rule in `docs/manuals/README.md`.
- [ ] **Step 4: Run the tests and confirm they pass.** Then run the CLI locally against `origin/main` on this branch and confirm the output is empty.
- [ ] **Step 5: Commit.**

### Task 5: "Changed since your last review" (Core admins)

**Files:**
- Create: `apps/core/migrations/0011_manual_reviews.sql` (and drizzle meta, the way 0010 was made); in `apps/core/src/db/schema.ts`, `manualReviews(pageId text, hash text, reviewedBy text, reviewedAt timestamptz, primary key (pageId, hash))`
- Create: `apps/core/src/services/manual-reviews.ts` + test; routes in `apps/core/src/http/routes.ts`: `GET /core/api/manual-reviews` returns `{ pageId, hash, reviewedBy, reviewedAt }[]`, and `POST /core/api/manual-reviews` takes `{ pageId, hash }`, returns 201 and is idempotent. Both are Core.Admin only; bodies are validated with zod `.strict()`.
- Create: `apps/staff-web/src/screens/help/ManualReviewScreen.tsx` + test (route `help/manuals-review`, linked from Help for Core admins only)

**Interfaces:**
- Consumes: `ManualsData` (`hash`, `previous`, `changed`).
- Behaviour:
  - Unreviewed means the page's current `hash` has no review row.
  - The list shows the newest changes first: page title, its manual, the `changed` date, and "Before" and "Now" side by side, stacked below 768 px. A new page shows "New page" instead of "Before".
  - "Mark reviewed" records the reviewer's name and the time, and the entry moves to a "Reviewed" section that shows who reviewed it and when.
  - Review rows for hashes or pages that no longer exist are ignored (Review Focus 4).

- [ ] **Step 1: Failing tests.**
  - Service: POST is idempotent, and a second admin's POST on the same hash keeps the first reviewer.
  - Routes: non-admins get 403; unknown fields get 400.
  - Screen: it lists an unreviewed page; Mark reviewed moves it; a stale row is ignored; NRMS.SiteEditor gets no link and a direct visit says "not available".
  - Axe finds 0 violations.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Check whether the migration runner, OpenShift Job and Windows install need any change; they normally pick up new migrations. If anything is needed, update `deploy/openshift/` and `docs/deploy/*.md`.
- [ ] **Step 4: Run all core + staff-web tests and confirm they pass, then run `npm run check`.**
- [ ] **Step 5: Commit.**

### Task 6: Core admin manual

**Files:**
- Create: `docs/manuals/core-admin/*.md`. The index is the **admin map**: one row per admin screen, giving its name as in the side menu, what it controls, who else it affects, and its Help link. After the map comes a page per admin screen:
  - Users;
  - Calendar access;
  - Organizations, including the ministry form, hand-over and Cabinet change;
  - Government terms;
  - Sectors, themes and tags;
  - Release page titles;
  - Media list names;
  - Error log;
  - the Website administration sections a Core admin can change.
- Create: `docs/manuals/topics/new-government.md`, rewritten from `docs/manuals/new-government.md` for readers. Move its operator-only section to `docs/deploy/new-government-operations.md`, then delete the old file and fix any links to it.
- Modify: `docs/manuals/running-notes.md`, removing each note this task folds in.
- Run `npm run manuals:build`.

- [ ] **Step 1: Gather the truth.**
  - For each screen: read its code, and the server rules behind its buttons where they decide what the reader sees.
  - Use it on a local review Hub as a Core admin. The tooling is in `~/GCPE-Legacy-Hub/ux-review-archive-2026-10-29/.superpowers/ux/review-hub.ts`; copy it in, start it with `REVIEW_HUB_PORT=4640`, and stop it with SIGTERM.
  - Note every label, refusal message and confirmation as shown.
- [ ] **Step 2: Write the pages.** Each page:
  - opens with what the screen is for, in one sentence;
  - then gives tasks as numbered steps;
  - then "What happens next" for any action with effects elsewhere (public site, emails, other apps);
  - then "Can't do this?" for each refusal message.

  Name screens and buttons exactly as shown. Every page's `routes` and `screens` fields must be filled in.
- [ ] **Step 3: Checks.**
  - `npm run manuals:build`;
  - the freshness, plain-language and visibility tests;
  - open every page in the review Hub at 1280 and 390;
  - download the Core admin .docx and read it through.
- [ ] **Step 4: Commit.**

### Task 7: Top role manuals: Site editor (releases and website), Subscribers admin, Calendar admin

Same steps as Task 6. Create `docs/manuals/nrms-site-editor/`, `docs/manuals/nod-admin/` and `docs/manuals/calendar-admin/`. Each index lists what the role can do that the roles below it can't, and links to the lower manuals for the rest. Fold in the notes tagged Site editor, Administrator (NoD) and Calendar's HQ Administrator and System Administrator. Use the review Hub's matching seeded users.

### Task 8: Lower role manuals, and retiring the running notes

Same steps as Task 6, for:
- nrms-editor, nrms-viewer;
- nod-editor, nod-viewer;
- calendar-advanced, calendar-editor, calendar-readonly.

Then handle the leftover running notes:
- move the notes tagged Operations into `docs/deploy/` (the guide each one concerns);
- move the notes tagged Developer into `docs/developer-notes.md`;
- delete `docs/manuals/running-notes.md`;
- add a test that fails if that file reappears.
