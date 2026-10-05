# Phase 3f — Staff Web App and Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff sign in at `/hub/` and use one web app to create, edit, approve, schedule, publish, correct, unpublish, delete and search releases, manage the Website section, and (admins) manage users and read the error log. Phase 3 exits when the spec's 16-item acceptance list passes automatically (Playwright against the full stack running locally) with axe finding no serious or critical violations on any screen.

**Architecture:** A new workspace `apps/staff-web`: a React single-page app (React Router, `@bcgov/design-system-react-components`, `@bcgov/design-tokens`, TipTap for the body editor), bundled by esbuild (`platform: "browser"`) into static files. The stack serves them at `/hub/` (hashed assets cacheable, `index.html` no-store, unknown `/hub/*` paths fall back to `index.html`). The app has no server: it calls `/core/auth/*`, `/core/api/*`, `/nrms/api/*` and `/stack/errors` with the session cookie and `X-GCPE-Request: 1`. Shared rules and types come from `@gcpe/nrms-contract` (browser-safe, zod only). The HTML allow-list moves into `@gcpe/nrms-contract` so the server sanitiser and the editor read the same list.

**Tech Stack:** Node 24, TypeScript 5.9 strict, React 19, React Router 7, esbuild, TipTap (current major), Vitest 4 with jsdom + Testing Library + axe-core, Playwright + `@axe-core/playwright`. Pin exact versions in `package.json`; prefer the newest stable releases at install time and record them in the task report.

**Spec:** `docs/superpowers/specs/2026-10-03-nrms-parity-design.md` §5 (staff web app), §9 (testing and the acceptance list). Code map: session scratchpad `plan3f-codemap.md` (copied into the plan workspace as `codemap.md`). Phase overview: `docs/superpowers/plans/2026-10-03-phase-3-overview.md` (3f also includes an admin error-log page).

## Global Constraints

- Worktree `/Users/paul/gcpe-news-platform-p3`, branch `feat/phase-3`. Commit after each task, committing only the task's files (`git commit -- <paths>`). Never add a `Co-Authored-By` trailer or any AI attribution. Never commit `CLAUDE.md`.
- Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`; type-check: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`; deps: `npx -y npm@11 install <pkg> -w <workspace>` (exact versions, `--save-exact`).
- **Browser code never imports Node-only modules** (no `node:*`, no `pg`, no `sanitize-html`). `@gcpe/nrms-contract` stays zod-only.
- **Every state-changing request** sends `X-GCPE-Request: 1` and `credentials: "same-origin"`. A 401 sends the user to sign-in (keeping where they were); a 409 shows "Someone else changed this — reload to see their changes" with a Reload button and never silently retries; 422 `problems` are shown next to the form; nothing logs request bodies.
- **Roles decide what's shown**, but the server is the authority: hide actions the user's roles can't perform (`NRMS.Editor` for release writes; `NRMS.SiteEditor` for the Website section; `Core.Admin` for Users, Blue Bridge and the error log; `NRMS.Viewer` read-only).
- **Dates:** stored UTC; shown in the tenant time zone (`America/Vancouver`, from `GET /nrms/api/config`, Task 1) with legacy wording: `Yesterday`, `Today`, `Tomorrow`, else the weekday name within ±6 days, else `MMM d, yyyy`; times as `h:mm a` (e.g. `Today 2:30 PM`).
- **Release type colours** (legacy `ReleaseModel.cs:1260-1275`): Release `rgb(72, 88, 113)`, Story `rgb(113, 72, 73)`, Update `rgb(226, 222, 69)`, Advisory `rgb(226, 109, 90)`, Factsheet `rgb(92, 92, 92)` — as CSS custom properties alongside the BC design tokens; text on them must meet WCAG AA contrast (the bar carries no text, so the colour is decorative — also show the type label as text).
- **Accessibility:** every screen has one `h1`, labelled form controls, visible focus, keyboard-operable drag-reorder alternatives (Move up / Move down buttons), and no serious/critical axe violations (component tests in every task; Playwright axe in Task 6).
- **Out of scope:** Forecast tab and Calendar look-ahead masking (Phase 5); NoD/Distribution admin screens (Phase 4); Entra sign-in.

## Review Focus

1. A session expiring mid-edit → the next save gets 401 → the user signs in again and returns to the same release with their unsaved text still in the form. (Task 1 + Task 4 tests.)
2. Two editors on the same release → the second save gets 409 and the UI says so; nothing is overwritten. (Task 3 test.)
3. Pasting rich HTML (Word, web pages) into the body editor → only allow-listed tags survive, identical to what the server keeps. (Task 4 test against the shared allow-list.)
4. A viewer or site editor never sees release write actions; a site editor sees the Website section; only Core.Admin sees Blue Bridge's switch, Users and the error log. (Task 1/3/5 tests; Task 6 acceptance item 1.)
5. Deep links (`/hub/releases/<id>`) and browser refresh work on boxs.ca, and the shell's `index.html` is never cached. (Task 1 stack test.)

---

## File structure

| File | Responsibility |
|---|---|
| `apps/staff-web/package.json`, `tsconfig.json`, `vitest.config.ts` (jsdom project) | New workspace |
| `apps/staff-web/src/main.tsx`, `App.tsx`, `routes.tsx` | Entry, router, role-aware shell and nav |
| `apps/staff-web/src/api/*` | `apiFetch` (CSRF, 401/409/422 handling), typed clients per API area |
| `apps/staff-web/src/session/*` | Session context, sign-in, renewal |
| `apps/staff-web/src/format/*` | BC-time relative dates, type colours/labels |
| `apps/staff-web/src/screens/**` | One folder per screen |
| `apps/staff-web/src/editor/*` | TipTap body editor bound to the shared allow-list |
| `scripts/build-staff-web.mjs` | esbuild browser bundle → `apps/staff-web/dist/` (hashed assets + `index.html`) |
| `apps/stack/src/stack.ts` | `/hub` mount + SPA fallback |
| `scripts/build-siteground.mjs` | Builds staff-web and copies it to `dist/siteground/hub/` |
| `packages/nrms-contract/src/html.ts` | Shared body allow-list (used by server sanitiser and editor) |
| `apps/nrms/src/http/routes.ts` | `GET /config` |
| `tests/e2e/*` | Playwright acceptance suite + in-process stack harness |

---

### Task 1: App scaffold, build, hosting, session and sign-in

**Files:** create `apps/staff-web/**` (scaffold), `scripts/build-staff-web.mjs` (+ test), `packages/nrms-contract/src/html.ts`; modify `apps/nrms/src/text/sanitize.ts` (import the shared list), `apps/nrms/src/http/routes.ts` (`GET /config`), `apps/stack/src/stack.ts` (+ test), `scripts/build-siteground.mjs` (+ its test), root `vitest.config.ts` (projects: node default + jsdom for `apps/staff-web`), root `package.json` (`staff-web:build`, `staff-web:dev`).

**Interfaces:**
- `packages/nrms-contract/src/html.ts`: `export const BODY_TAGS = ["a","p","ul","ol","li","strong","br","div","asset"] as const; export const BODY_ATTRIBUTES = { a: ["href"] } as const; export const BODY_SCHEMES = ["http","https","mailto"] as const;` — `apps/nrms/src/text/sanitize.ts` builds its `sanitize-html` options from these (behaviour unchanged; its tests stay green).
- `GET /nrms/api/config` (any signed-in role, including Core.Admin) → `{ timeZone, siteUrl, publicSiteUrl, filesBase, isTestSite }` (no secrets). `isTestSite` uses the same rule as the public site.
- `apiFetch<T>(path, init?)`: same-origin, JSON, adds `X-GCPE-Request: 1` on non-GET; returns `T` or throws `ApiError { status, message, problems?, issues? }`; 401 → session context `signedOut()` with return path.
- Session: `SessionProvider` loads `GET /core/auth/session` at start and every 10 minutes while the tab is visible (renewal happens server-side); `useSession(): { user, roles, signIn(u,p), signOut(), has(role) }`.
- Screens: `/hub/sign-in` (BC design-system form; generic error on 401; "Too many attempts, wait a minute" on 429); app shell with the BC header, a nav showing only the sections the roles allow (Releases, Search, Website, Users, Error log), the user's name and Sign out.
- Build: `scripts/build-staff-web.mjs` → `apps/staff-web/dist/index.html` + `assets/app-<hash>.js|css` (+ the design system's fonts/images copied), base path `/hub/`, no source maps in the shipped bundle, no absolute local paths (the siteground leak scan must stay green).
- Stack: mount before `noStoreByDefault`: `app.use("/hub/assets", express.static(<dir>/assets, { immutable: true, maxAge: "1y", fallthrough: false }))`, then `/hub` → `index.html` for any GET whose path has no file extension (Cache-Control `no-store`), 404 for other unmatched files. The directory comes from a stack setting `STAFF_WEB_DIR` (default: the built `apps/staff-web/dist` in dev; `./hub` next to `stack.js` in the SiteGround bundle). If the directory is missing, `/hub/` returns 503 "Staff app not built" and the stack still starts.
- `build-siteground.mjs`: runs the staff-web build and copies it to `dist/siteground/hub/`; the smoke check confirms `hub/index.html` exists.

- [ ] **Step 1: Failing tests:**

```ts
// nrms sanitize: still strips <script>, keeps the same tags, now driven by BODY_TAGS (existing tests unchanged + one asserting it reads the shared list)
// GET /config: returns timeZone "America/Vancouver" and isTestSite; 401 without a session
// stack: GET /hub/ and /hub/releases/abc → index.html with no-store; /hub/assets/app-x.js → immutable cache; /hub/missing.js → 404; no build dir → 503 and the stack still serves /stack/health
// build-staff-web: produces index.html referencing hashed assets under /hub/assets/; no "/Users/" in output
// staff-web (jsdom): apiFetch adds the CSRF header on POST, not on GET; 401 → signedOut with return path; 409 → ApiError status 409
// sign-in: submitting calls POST /core/auth/login; 401 shows "Sign-in failed. Check your user name and password."; success navigates to the return path
// shell nav: a viewer sees Releases + Search only; a site editor also Website; Core.Admin also Users + Error log
// axe: sign-in and shell have no serious/critical violations
```

- [ ] **Steps 2–5:** verify failure → implement → run `apps/staff-web apps/stack apps/nrms packages/nrms-contract tests` + tsc + full suite + `node scripts/build-siteground.mjs` → commit `feat(staff-web): scaffold, /hub hosting, session and sign-in`.

---

### Task 2: Release lists and search

**Files:** `apps/staff-web/src/screens/releases/*`, `apps/staff-web/src/screens/search/*`, `apps/staff-web/src/format/*` (+ tests).

**Interfaces:**
- `/hub/` redirects to `/hub/releases/drafts`. Tabs Drafts / Scheduled / Published (`GET /nrms/api/releases?folder=…&type=…&page=…&pageSize=25`), type filter All / Releases / Stories / Factsheets / Advisories (Updates appear under All only), paging on every tab with "Showing 26–50 of 112".
- Row (spec §5): colour bar by type + the type label as text; lead organisation; page title; headline (link to `/hub/releases/<id>`); `LOCATION – summary` (location upper-cased; omit the dash when either is empty); status text and date (relative BC wording; Scheduled shows `publishAt`, Published `releasedAt`, Drafts `publishAt` if set); Calendar activity id when set; "Approved" badge on drafts with a reference; Flickr alert badge (with the alert text as its accessible description).
- "New release" button (Editors only) → `/hub/releases/new`.
- Search `/hub/search?q=&ministry=&sector=&page=`: one box; on submit first try `GET /nrms/api/goto?q=` — a hit navigates straight to the release; otherwise show `GET /nrms/api/search` results (same row component), 20 per page, ministry and sector filters (from `GET /nrms/api/categories`) combined with AND, drafts included.
- `format/dates.ts`: `relativeDay(iso, now, timeZone)` and `formatWhen(iso, now, timeZone)` per the Global Constraints wording — DST-safe, tested across both transitions and the year boundary.

- [ ] **Step 1: Failing tests:** relative wording (Yesterday/Today/Tomorrow/weekday/date, BC midnight boundaries, DST days); row renders every field and the badges; empty fields don't leave stray dashes; paging text; type filter changes the query; search: goto hit navigates, miss shows results, filters combine; `NEWS-01234` and a pasted `https://news.gov.bc.ca/releases/<key>` both use goto; viewer sees no "New release"; axe clean on each list and search.
- [ ] **Steps 2–5:** verify → implement → run `apps/staff-web` + tsc + full suite → commit `feat(staff-web): release lists and search`.

---

### Task 3: New release and the release editor (header, actions, settings, categories, asset, page details)

**Files:** `apps/staff-web/src/screens/release/*` (+ tests).

**Interfaces:**
- `/hub/releases/new`: type (creatable types only), page title (from `GET /page-types` for the type), layout, page image (`GET /page-images`, thumbnails via `/nrms/api/page-images/:id/image`), categories, headline. Per-type rules from `typeRules()`; validates with `createReleaseSchema` before sending; on 201 → `/hub/releases/<id>`.
- `/hub/releases/:id` — one page, sections in spec order. Each section saves independently with the current `version`; after a save the whole view is replaced by the response (so `version` stays current). Unsaved-changes guard on navigation.
  - **Header and errors:** headline, type, status text, key/reference, `lastError`, Flickr alert, and `approveProblems` / `publishProblems` shown as a checklist before the user clicks Approve/Publish.
  - **Actions** (Editors only, shown per status/type): Approve; Publish now; Schedule (date/time picker in BC time → ISO); Cancel schedule; Unpublish (hidden when `typeRules(type).unpublishable` is false); Delete (confirm dialog; text explains "permanent" vs "hidden" depending on whether a reference exists).
  - **Publish settings** (`PUT …/settings`), **Categories** (`PUT …/categories`) with Top/Feature switches for Home and each chosen ministry/sector/theme (`POST …/features`; only enabled on a published release, with the reason shown when disabled), **Media asset** (`PUT …/asset`; validates with `assetUrlProblem`; shows `GET …/asset-status` state and message), **Page details** (`PUT …/meta`: slug, redirect, location, summaries, keywords).
- 409 handling per Global Constraints; 422 problems shown in the section that caused them.

- [ ] **Step 1: Failing tests:** each creatable type shows exactly its required fields and the API's 422 problems map to fields (acceptance 2); Approve disabled with the checklist until approveProblems is empty; Advisory has no Unpublish (acceptance 8); delete text differs with/without reference; a 409 on save shows the reload message and keeps the user's input; Top/Feature switch posts the right kind/key/slot and is disabled on drafts; asset URL validation messages; schedule converts BC local time to the correct UTC instant; viewer sees the page read-only; axe clean.
- [ ] **Steps 2–5:** verify → implement → run `apps/staff-web` + tsc + full suite → commit `feat(staff-web): new release and release editor (header, actions, settings, categories, asset, page details)`.

---

### Task 4: Documents, body editor, translations, history and the side bar

**Files:** `apps/staff-web/src/editor/*`, `apps/staff-web/src/screens/release/documents/*`, `…/sidebar/*` (+ tests).

**Interfaces:**
- **Documents:** English/French tabs per document; add document (`POST …/documents`), add/remove a translation, remove a document; reorder by drag **and** by Move up / Move down buttons (`PUT …/documents/order`). Fields per `documentLanguageSchema` (page title, organizations, headline, subheadline, byline, body, contacts list). Summary auto-fill is server-side — show the returned summary and mark it "auto" until edited.
- **Body editor (TipTap):** only nodes/marks for `BODY_TAGS` (paragraph, bulleted/numbered list, list item, bold → `strong`, hard break, link with `href` limited to `BODY_SCHEMES`, `div` as a plain block, and an `<asset>` node rendered as a non-editable embed chip showing its URL). Paste is reduced to the same set. The HTML it emits is accepted unchanged by the server sanitiser (round-trip test against the shared list).
- **Translations** (PDF uploads, `POST …/files?kind=translation`) and **media files** (`kind=asset`): file input + list with remove; shows server 422/413 messages.
- **History:** `GET …/log` with a "Show all" toggle (`all=true`); frozen copies list (`GET …/publications`).
- **Side bar:** reference block (key, reference, `NEWS-` number, activity id), "View on site" (public URL from config + `POST_KIND`), "View PDF" (`/nrms/api/releases/:id/pdf` in a new tab), "Email me a copy" (`POST …/email-copy`; shows "Sent to <email>" or the 422/503 message).
- **Session-expiry recovery (Review Focus 1):** unsaved document text is kept in `sessionStorage` (per release id + document + language) while editing and restored after re-sign-in; cleared on successful save.

- [ ] **Step 1: Failing tests:** two documents EN+FR with contacts, add/remove translation, reorder by buttons sends the new order (acceptance 3); pasting `<h1>`, `<script>`, `<span style>`, `<img>`, `<a href="javascript:…">` keeps only allowed output; editor output round-trips through the server sanitiser unchanged (import the nrms sanitiser in a node-environment test); `<asset>` survives load→save; PDF upload success and 422 message; history toggle; Email me a copy success/503; unsaved text restored after a simulated 401 + sign-in; axe clean.
- [ ] **Steps 2–5:** verify → implement → run `apps/staff-web apps/nrms` + tsc + full suite → commit `feat(staff-web): documents, body editor, translations, history and side bar`.

---

### Task 5: Website section, Users and roles, error log

**Files:** `apps/staff-web/src/screens/website/*`, `…/admin/users/*`, `…/admin/errors/*` (+ tests).

**Interfaces:**
- **Website** (`NRMS.SiteEditor` writes; readers see read-only): Carousel (live / next / past; create next with go-live time; edit slides with drag + Move buttons; image upload ≤ 2 MB with the server's size/type messages; Make live now; delete next); Emergency pins (primary/secondary edit + pin/unpin); Live Feed (switch + two URLs); Resource links (ordered list editor); Files (upload with replace prompt on 409, search, delete with confirm); What's featured where (read-only table); Website log (area filter).
- **Project Blue Bridge** (inside Website; only `Core.Admin` sees the switch): shows the current state and legacy's warning text verbatim ("Do not click OK unless you have approval from IGRS"); turning on or off opens a dialog requiring the typed phrase `KING CHARLES III` and an "IGRS has approved this change" checkbox before the confirm button enables; shows "TEST site" notice when `config.isTestSite`.
- **Users and roles** (`Core.Admin`): list; create (email, display name, roles, optional password ≥ 12); edit name; activate/deactivate; set roles (checkboxes from STAFF_ROLES with plain-language descriptions); set password. Shows the server's self-lockout 409 message.
- **Error log** (`Core.Admin`): `GET /stack/errors?limit=200` newest first, with time (BC), pid, message (pre-wrapped, monospaced), a Refresh button and a note that entries survive restarts.

- [ ] **Step 1: Failing tests:** carousel create-next → edit → make live calls the right endpoints; pin/unpin; Live Feed validation (M3U required when enabling); Blue Bridge confirm disabled until phrase + checkbox, wrong case keeps it disabled, non-admin sees no switch; links reorder; file replace flow on 409; users: create/set roles/deactivate, self-lockout 409 message shown; error log renders entries and refreshes; site editor sees Website writes but no release write actions; axe clean on every screen.
- [ ] **Steps 2–5:** verify → implement → run `apps/staff-web` + tsc + full suite → commit `feat(staff-web): Website section, users and roles, error log`.

---

### Task 6: Playwright acceptance suite, boxs.ca deploy and parity notes

**Files:** `tests/e2e/harness.ts`, `tests/e2e/*.spec.ts`, `playwright.config.ts`, root `package.json` (`test:e2e`), `docs/deploy/siteground.md`, `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`.

**Interfaces:**
- **Harness:** starts the whole stack in-process (as `apps/stack/src/stack.test.ts` does) on a random port with fresh test databases, the fake Flickr, an in-process SMTP sink (reuse the existing test helper) standing in for Mailpit, the built staff-web, and seeded users (editor, site editor, viewer, admin) and Core reference data; exposes `tick()` (POST `/stack/tick`) for tests. Playwright runs Chromium headless (`npx playwright install chromium` once).
- **One spec per acceptance item 1–14 and 16** (item 15 is the importer — covered by its own tests; note that in the suite). Item 5 asserts the email arrives in the SMTP sink; item 6 uses the publisher's test clock or a short schedule + `tick()`; item 9 drives the fake Flickr's refuse-auth switch; item 12 asserts "TEST —" via the public site; item 16 runs `@axe-core/playwright` on every screen (sign-in, lists ×3, search, new, editor, each Website screen, users, error log) and fails on serious/critical.
- Run with `npm run test:e2e`; not part of the default `vitest run`.
- **Deploy:** build-siteground includes `hub/`; after deploy, `https://boxs.ca/hub/` loads the sign-in page and deep links work. Add a "Staff app" section to `docs/deploy/siteground.md` (URL, who can see what, how to report problems via the error log).
- **Parity:** add C-rows: flat `/hub/releases/<id>` URLs instead of folder-prefixed legacy URLs; keyboard Move up/down alongside drag reorder; the error-log page (new). Note any acceptance item that can only be checked by hand on boxs.ca (items marked * in the spec) in the deploy doc as a checklist.

- [ ] **Step 1:** write the harness and the specs; run them — they fail where the app or harness is incomplete; fix what's needed (app fixes go in their own commits).
- [ ] **Steps 2–4:** all specs green locally (`npm run test:e2e`) + full suite + tsc + `node scripts/build-siteground.mjs` → commit `test(e2e): Playwright acceptance suite for Phase 3; staff app deploy notes`.
