# Organization Edit Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff (not developers) change ministry names and minister details shown on `/site/ministries/` after an election, and add or deactivate ministries, from Hub → Organizations.

**Architecture:** Core gains a partial-update route (`PATCH /organizations/:key/profile`) that merges onto the stored record server-side, so a form can never wipe fields it doesn't show, and a create route (`POST /organizations`) that derives the key from the name. Both stamp a DB-only `staff_edited_at` column, which the public-API seed and the legacy importer respect so they no longer overwrite staff edits. The existing `org.upserted` event already carries the change to news-api, nod, NRMS and Calendar, and the public site already rebuilds the ministry page, `/ministries/`, search and the sitemap on it (`apps/public-site/src/change-feed.ts:80-87`), so no downstream change is needed.

**Tech Stack:** TypeScript, Express + zod (core), drizzle-orm + drizzle-kit migrations (Postgres), React + `@bcgov/design-system-react-components` (staff-web), vitest + supertest + Testing Library.

**Spec:** This plan's own "Decisions" section below (agreed in conversation, 2026-10-27). No separate spec doc.

## Decisions (the spec)

1. **Rename in place *and* create-new-plus-deactivate are both supported.** Rename keeps the key/URL, subscribers and release links. Moving subscribers from a deactivated ministry to its successor is **out of scope (v2)**; the Deactivate confirmation must say subscribers to it stop receiving news.
2. **Changes go live one save at a time.** No draft/publish-together mode in v1.
3. **Who edits:** `NRMS.SiteEditor` and `Core.Admin` may edit the public-facing profile (ministry name, sort order, minister name/summary/email/photo URL). Only `Core.Admin` may create, deactivate, reactivate, change parent, or set the HQ/public flags.

## Global Constraints

- Key rule (verified against all 27 live keys on boxs.ca, 2026-10-27): lowercase, delete `'` and `’`, fold accents (NFKD, drop combining marks), replace each run of non-`[a-z0-9]` with `-`, trim leading/trailing `-`. Keys are immutable after creation. (Accent folding and `’` added by ruling during Task 2.)
- All text fields are trimmed server-side; `displayName` must be non-empty after trimming.
- Minister name is stored with its title as one string ("Honourable Lana Popham", "Premier David Eby"); the form does not split it.
- v1 does not edit: `minister.detailsHtml`, `minister.address`, contacts, social, topic/service links, sectors, `url`, `displayAdditionalName`, `abbreviation`. They must survive every save unchanged.
- Success copy: `Saved. The public Ministries page updates when the site next rebuilds.` (Rebuild latency is unmeasured; do not promise a time.)
- No `window.confirm`/`alert` anywhere — confirmations are in-page.

## Review Focus

1. A SiteEditor saves a ministry → `contact`, `social`, `topicLinks`, `minister.detailsHtml` etc. are byte-identical afterwards. (Task 1 test `preserves fields the form doesn't send`.)
2. The seed or importer is re-run after staff edited a ministry → the staff edit survives and the run reports it as skipped, not failed. (Task 3 tests.)
3. A SiteEditor sends `isActive`, `parentKey`, `isHq` or `isPublic` in a profile PATCH → 403, nothing written. (Task 1 test.)
4. Staff add "Citizens' Services" again → 409 with a message naming the existing key, not a silent overwrite of the existing ministry. (Task 2 test.)
5. The Entra session for a SiteEditor actually carries `NRMS.SiteEditor` to Core's `requireAnyRole` (assumed from `packages/auth`; unverified against a real Entra token). Task 6 includes a manual check on a deployed stack.

---

### Task 1: Core — profile PATCH with field merge and role split

**Files:**
- Modify: `apps/core/src/db/schema.ts` (add `staffEditedAt: timestamp("staff_edited_at", { withTimezone: true })` to `organizations`, nullable, not part of `OrgRecord`)
- Create: `apps/core/migrations/0005_org_staff_edited_at.sql` (via `npm --workspace @gcpe/core run db:generate`)
- Modify: `apps/core/src/services/organizations.ts`
- Modify: `apps/core/src/http/routes.ts`
- Test: `apps/core/src/http/routes.test.ts`

**Interfaces:**
- Produces: `orgProfilePatchSchema` (zod) with optional fields `displayName: string`, `sortOrder: int`, `minister: { name?, summary?, email?, photoUrl? }` (each `string | null`), `parentKey: string | null`, `isActive: boolean`. Strings trimmed; empty string → `null` except `displayName` (min 1 after trim). `email` must be an email or null; `photoUrl` must be an `https:` URL or null.
- Produces: `ADMIN_ONLY_PROFILE_FIELDS = ["parentKey", "isActive"] as const`.
- Produces: `patchOrganizationProfile(db: Db, key: string, patch: OrgProfilePatch, subscribers: SubscriberConfig[]): Promise<OrgRecord | null>` — `null` when the key doesn't exist. Merges `minister` field-by-field onto the stored minister, calls the same upsert path so `org.upserted` is emitted only on a real change, and sets `staffEditedAt = now()` when it writes.
- Produces route: `PATCH /organizations/:key/profile`, `requireAnyRole("Core.Admin", "NRMS.SiteEditor")`; 403 if the caller lacks `Core.Admin` and the body contains any `ADMIN_ONLY_PROFILE_FIELDS` key or `isHq`/`isPublic`; `.strict()` schema so unknown keys → 400.

- [ ] **Step 1: Write the failing tests** in a new `describe("PATCH /api/organizations/:key/profile")` block. Add `siteEditor = await sign(["NRMS.SiteEditor"])` in `beforeAll`. Tests:
  - `renames and updates the minister for a SiteEditor`: seed `healthOrg`; PATCH `{ displayName: "Health and Wellness", minister: { name: "Honourable Pat Doe" } }` as siteEditor → 200; body `displayName === "Health and Wellness"`, `minister.name === "Honourable Pat Doe"`.
  - `preserves fields the form doesn't send`: seed `healthOrg`; GET before; PATCH `{ minister: { name: "X" } }`; GET after; `expect({ ...after, minister: { ...after.minister, name: before.minister.name }, updatedAt: before.updatedAt }).toEqual(before)`.
  - `trims text and rejects a blank name`: PATCH `{ displayName: "  Health  " }` → `displayName === "Health"`; PATCH `{ displayName: "   " }` → 400.
  - `forbids admin-only fields for a SiteEditor`: for each of `{ isActive: false }`, `{ parentKey: null }`, `{ isHq: true }`, `{ isPublic: false }` as siteEditor → 403, and GET shows the record unchanged. Same `{ isActive: false }` as admin → 200.
  - `403 for NRMS.Editor, 404 for an unknown key, 400 for an unknown field`: editorOnly → 403; `/nope/profile` as admin → 404; `{ colour: "red" }` → 400.
  - `rejects a non-https photo URL and a bad email`: `{ minister: { photoUrl: "http://x/y.jpg" } }` → 400; `{ minister: { email: "nope" } }` → 400.

- [ ] **Step 2: Run** `npx vitest run apps/core/src/http/routes.test.ts -t "profile"` — Expected: FAIL (404 from Express for the unregistered route).

- [ ] **Step 3: Add the column and generate the migration.** Run `npm --workspace @gcpe/core run db:generate`; expected: a new `apps/core/migrations/0005_*.sql` containing `ALTER TABLE "organizations" ADD COLUMN "staff_edited_at" timestamp with time zone;`. Rename it to `0005_org_staff_edited_at.sql` only if the journal in `migrations/meta` is updated to match (otherwise keep drizzle's name).

- [ ] **Step 4: Implement** `orgProfilePatchSchema`, `ADMIN_ONLY_PROFILE_FIELDS` and `patchOrganizationProfile` in `organizations.ts`, and the route in `routes.ts` next to `/organizations/:key/public`. Extend `upsertOrganization`'s `opts` with `staffEdit?: boolean` that sets `staffEditedAt` in `values`; `patchOrganizationProfile` reads the current row inside the same transaction lock (`lockAggregate`) so two concurrent saves can't interleave.

- [ ] **Step 5: Run** the same command — Expected: PASS. Then `npx vitest run apps/core` — Expected: PASS (existing tests unaffected).

- [ ] **Step 6: Commit**
```bash
git add apps/core
git commit -m "feat(core): PATCH organization profile for SiteEditor and Core.Admin; staff_edited_at"
```

### Task 2: Core — create a ministry from its name

**Files:**
- Create: `packages/events/src/org-key.ts` (exported from the package index)
- Test: `packages/events/src/org-key.test.ts`
- Modify: `apps/core/src/services/organizations.ts`, `apps/core/src/http/routes.ts`
- Test: `apps/core/src/http/routes.test.ts`

**Interfaces:**
- Produces: `orgKeyFromName(name: string): string` in `@gcpe/events` (shared so staff-web can preview the key).
- Produces: `createOrganization(db: Db, input: { displayName: string; sortOrder?: number; parentKey?: string | null; minister?: Partial<OrgRecord["minister"]> }, subscribers: SubscriberConfig[]): Promise<{ record: OrgRecord } | { conflict: string }>` — key from `orgKeyFromName`; new orgs get `isActive: true`, `isPublic: true`, `isHq: false`, empty arrays/nulls for everything else, `sortOrder` default = current max + 10, `staffEditedAt = now()`.
- Produces route: `POST /organizations`, `Core.Admin` only; 201 with the record; 409 `{ error: "exists", key }` when the key exists (active or not); 400 when the derived key is empty.

- [ ] **Step 1: Write the failing tests.** `org-key.test.ts`, `it.each` over exact pairs: `["Citizens' Services", "citizens-services"]`, `["Tourism, Arts, Culture and Sport", "tourism-arts-culture-and-sport"]`, `["Post-Secondary Education and Future Skills", "post-secondary-education-and-future-skills"]`, `["  Office of the Premier ", "office-of-the-premier"]`, `["!!!", ""]`. Routes: `creates a ministry and derives its key` (POST `{ displayName: "Mining and Critical Minerals", minister: { name: "Honourable A B" } }` as admin → 201, `key === "mining-and-critical-minerals"`, GET returns it with `isPublic: true`); `409s a duplicate name` (POST "Health" twice → second 409 with `key: "health"`); `Core.Admin only` (siteEditor → 403); `400s a name with no letters or digits` (`"!!!"`).

- [ ] **Step 2: Run** `npx vitest run packages/events/src/org-key.test.ts apps/core/src/http/routes.test.ts -t "ministry|key"` — Expected: FAIL.

- [ ] **Step 3: Implement** `orgKeyFromName`, `createOrganization` (insert with `onConflictDoNothing`, detect conflict from an empty `returning()`, then enqueue `org.upserted`), and the route.

- [ ] **Step 4: Run** the same command — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(core): create an organization from its name (POST /organizations)"`

### Task 3: Stop the seed and the importer overwriting staff edits

**Files:**
- Modify: `apps/core/src/services/organizations.ts` (`upsertOrganization` opts), `apps/core/src/http/routes.ts` (existing `PUT /organizations/:key`)
- Modify: `apps/core/src/import/run.ts`, `scripts/seed-core-from-public-api.ts`
- Test: `apps/core/src/http/routes.test.ts`, `apps/core/src/import/run.test.ts`, `tests/seed-core-from-public-api.test.ts`

**Interfaces:**
- Consumes: `staffEditedAt` (Task 1).
- Produces: `upsertOrganization` opts gain `respectStaffEdits?: boolean`; when true and the stored row has `staffEditedAt`, it returns `{ record, changed: false, skippedStaffEdit: true }` without writing.
- Produces: `PUT /organizations/:key` passes `respectStaffEdits: req.query.overwriteStaffEdits !== "true"` and responds **409 `{ error: "staff-edited" }`** when skipped.
- Produces: importer result `organizations.skippedStaffEdited: number`; seed `KindSummary.skipped: string[]` (keys), printed in the summary and not counted in `failed`.

- [ ] **Step 1: Write the failing tests.**
  - routes: `PUT 409s a staff-edited organization unless overwriteStaffEdits=true` — seed `healthOrg`, PATCH profile name, PUT `healthOrg` → 409 and name unchanged; PUT `?overwriteStaffEdits=true` → 200 and name reverts.
  - `run.test.ts`: `the importer skips a staff-edited organization` — import once, PATCH via `patchOrganizationProfile`, import again → `skippedStaffEdited === 1`, name is the staff edit.
  - seed test: `a 409 staff-edited response is reported as skipped, not failed` — stub fetch to return 409 `{ error: "staff-edited" }` for one org → `summary.skipped` contains its key, `summary.failed === 0`, exit code 0.
- [ ] **Step 2: Run** `npx vitest run apps/core tests/seed-core-from-public-api.test.ts -t "staff"` — Expected: FAIL.
- [ ] **Step 3: Implement.** Importer calls `upsertOrganization(..., { ..., respectStaffEdits: true })`. Seed's `putAndTrack` treats `409` with `error === "staff-edited"` as skipped.
- [ ] **Step 4: Run** the same command, then `npx vitest run apps/core tests` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(core): seed and importer skip staff-edited organizations"`

### Task 4: Staff-web — Organizations visible to SiteEditors, role-aware table

**Files:**
- Modify: `apps/staff-web/src/shell/AppShell.tsx:39` (and its doc comment at 28-29)
- Modify: `apps/staff-web/src/screens/admin/organizations/OrganizationsScreen.tsx` (and its header comment at 9-13, which says organizations are only edited by the seed/importer)
- Test: `apps/staff-web/src/screens/admin/organizations/OrganizationsScreen.test.tsx`, `apps/staff-web/src/shell/AppShell.test.tsx`

**Interfaces:**
- Produces: `canEditOrgProfile(session): boolean` = `has("Core.Admin") || has("NRMS.SiteEditor")`; `isCoreAdmin` as today. Exported from `apps/staff-web/src/screens/admin/organizations/access.ts`.
- Produces: table gains a "Minister" column (`o.minister.name ?? ""`) and an "Edit" button per row (`aria-label={\`Edit ${o.displayName}\`}`) that opens Task 5's form. The fetched type becomes `OrgRecord` (import from `@gcpe/events`) instead of `OrgOption`.

- [ ] **Step 1: Write the failing tests:** `shows Organizations in the nav for NRMS.SiteEditor`; `a SiteEditor sees names, ministers and Edit buttons but no HQ/Public checkboxes` (`queryByRole("checkbox")` is null); `NRMS.Editor still gets the no-permission message`; existing Core.Admin tests keep passing. Extend `ORGS` fixtures with a `minister` object.
- [ ] **Step 2: Run** `npx vitest run apps/staff-web/src/screens/admin/organizations apps/staff-web/src/shell` — Expected: FAIL.
- [ ] **Step 3: Implement.** Hide (don't disable) the HQ and Public columns for non-admins. Update intro copy: `Ministry and minister names here appear on the public Ministries page.`
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(staff-web): Organizations visible to SiteEditors with minister column"`

### Task 5: Staff-web — the edit form

**Files:**
- Create: `apps/staff-web/src/screens/admin/organizations/OrganizationEditForm.tsx`
- Test: `apps/staff-web/src/screens/admin/organizations/OrganizationEditForm.test.tsx`
- Modify: `OrganizationsScreen.tsx` (render the form for the selected row; reload after save)

**Interfaces:**
- Consumes: `PATCH /core/api/organizations/:key/profile` (Task 1), `canEditOrgProfile`/`isCoreAdmin` (Task 4).
- Produces: `OrganizationEditForm({ org, orgs, isAdmin, onSaved, onCancel }: { org: OrgRecord; orgs: OrgRecord[]; isAdmin: boolean; onSaved: (o: OrgRecord) => void; onCancel: () => void })`.
- Fields (label-above, matching `29200b9`'s convention): Ministry name*, Sort order, Minister name (hint: `Include the title, e.g. "Honourable Jane Doe" or "Premier Jane Doe".`), Minister summary (textarea), Minister email, Minister photo URL (hint: `Upload the photo under Website → Files, then paste its address here.`). Admin only: Parent ministry (select of other active orgs + "None"), Active (checkbox).
- Sends only changed fields (diff against `org`).

- [ ] **Step 1: Write the failing tests:** `sends only the changed fields` (change minister name → PATCH body is exactly `{ minister: { name: "Honourable New Person" } }`); `shows the saved message and calls onSaved` (status text equals the Global Constraints success copy); `warns but allows an empty minister name` (warning text `This ministry will show no minister on the public site.`, Save still enabled); `blocks an empty ministry name` (Save disabled, field error `Enter a ministry name.`); `a SiteEditor doesn't see Parent ministry or Active`; `shows server validation messages` (400 from PATCH → `role="alert"` via `messagesOf`).
- [ ] **Step 2: Run** `npx vitest run apps/staff-web/src/screens/admin/organizations` — Expected: FAIL.
- [ ] **Step 3: Implement** the form; reuse `messagesOf` and the `InlineAlert` pattern from `OrganizationsScreen`. Focus moves to the form heading on open and back to the row's Edit button on cancel/save.
- [ ] **Step 4: Run** the same command plus `apps/staff-web/src/screens/admin/a11y.test.tsx` — Expected: PASS (add the form to the a11y test's rendered screens).
- [ ] **Step 5: Commit** `git commit -m "feat(staff-web): edit ministry and minister details"`

### Task 6: Staff-web — Add ministry and Deactivate (Core.Admin), then end-to-end check

**Files:**
- Create: `apps/staff-web/src/screens/admin/organizations/AddOrganizationForm.tsx` (+ `.test.tsx`)
- Modify: `OrganizationsScreen.tsx` (Add button above the table; Deactivate button per active row, admin only)
- Test: `OrganizationsScreen.test.tsx`

**Interfaces:**
- Consumes: `POST /core/api/organizations` (Task 2), existing `POST /core/api/organizations/:key/deactivate`, `orgKeyFromName` (Task 2) for a live key preview, `PATCH .../profile { isActive: true }` (Task 1) for Reactivate.

- [ ] **Step 1: Write the failing tests:** `previews the key as you type` (`"Citizens' Services"` → shows `Web address: /site/ministries/citizens-services/`); `creates and opens the new ministry for editing`; `409 shows "A ministry with this name already exists (citizens-services)."`; `Deactivate asks in-page first` — clicking Deactivate shows text `Deactivate {name}? It disappears from the public site, and its subscribers stop receiving news. This can be undone with Reactivate, but subscribers are not moved to another ministry.` with Confirm/Cancel; Confirm POSTs deactivate; `inactive rows show Reactivate`; `SiteEditor sees neither Add nor Deactivate`.
- [ ] **Step 2: Run** `npx vitest run apps/staff-web/src/screens/admin/organizations` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` (whole repo) and `npm run check` — Expected: all PASS, no type errors.
- [ ] **Step 5: End-to-end check on a test stack** (not production). As a user with only `NRMS.SiteEditor`: open Hub → Organizations, edit Health's minister name, save. Expected: 200 in the network log (confirms Review Focus #5), and `/site/ministries/` shows the new name after the rebuild — record how long the rebuild took in the PR description. Then re-run `npm run core:seed-from-public-api -- <stack-url>` and confirm Health appears under `skipped` and the edit survives.
- [ ] **Step 6: Commit** `git commit -m "feat(staff-web): add and deactivate ministries"`

## Out of scope (v2)

- Moving subscribers from a deactivated ministry to its successor (nod).
- Draft changes and publishing a whole new cabinet at once.
- Rich-text minister bio (`detailsHtml`) using the release `BodyEditor`; photo upload inside the form.
- Editing contacts, social and topic/service links.
