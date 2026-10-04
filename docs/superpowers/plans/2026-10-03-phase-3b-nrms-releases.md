# Phase 3b — NRMS Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** NRMS stores releases in the full legacy-parity model and runs the legacy workflow (create → approve → schedule → publisher go-live → corrections → unpublish/delete) with server-side validation, legacy numbering and slugs, search, text/PDF versions and "email me a copy".

**Architecture:** A new zod-only package `@gcpe/nrms-contract` holds the types, per-type rules, input schemas and status wording shared by the NRMS API and (in 3f) the staff app. NRMS replaces Phase 2's single JSON `releases` table with normalised `news_release*` tables, keeps a local cache of Core's ministries and categories (fed by Core's existing events), and rewrites its publisher to claim due releases, write a frozen copy, and emit `release.published` / `release.updated` / `release.unpublished` through the outbox. Renditions are pure functions over the release view.

**Tech Stack:** Node 24, TypeScript 5.9 strict, Express 5, Drizzle 0.45 / drizzle-kit 0.31, zod 3.25, sanitize-html + htmlparser2 (new), pdfmake (new), Vitest 4.1, supertest.

**Spec:** `docs/superpowers/specs/2026-10-03-nrms-parity-design.md` §3, §4, §5 (renditions, search), §9. Phase overview: `docs/superpowers/plans/2026-10-03-phase-3-overview.md`. Builds on Phase 3a (`docs/superpowers/plans/2026-10-03-phase-3a-staff-identity.md`): `requireAnyRole`, `actorOf`, session cookie.

## Global Constraints

- Worktree `/Users/paul/gcpe-news-platform-p3`, branch `feat/phase-3`. Commit locally after each task. Never add a `Co-Authored-By` trailer or any AI attribution.
- Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`; type-check: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`. Add deps with `npx -y npm@11 install <pkg> -w <workspace>`.
- Migrations are generated with drizzle-kit (`cd apps/nrms && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`), except data-copy migrations, which use `--custom`. Never hand-edit a generated migration's DDL.
- Every worker comparison uses the database clock (`sqlNow` from `@gcpe/db-kit`), never a JS `Date` against a DB timestamp.
- Languages: English `4105`, French `3084`. Release types: `release`, `story`, `factsheet`, `update`, `advisory` (legacy 1–5 in that order). Post kinds in events: `releases`, `stories`, `factsheets`, `updates`, `advisories`.
- Statuses: `draft`, `approved`, `scheduled`, `publishing`, `published`, `unpublishing`, `failed`, `deleted`.
- Key format (Release/Advisory/Update, at approve): `{year}{ABBR}{n:0000}-{m:000000}`, `ABBR` = lead ministry abbreviation or `ADVIS`; `n` per (year, ministry); `m` per year. Reference: `NEWS-{n:00000}`, one global counter. Year = BC local year (`America/Vancouver`, from the tenant config).
- Slug: lowercase; strip diacritics; drop curly quotes; `" - "` → space; drop anything not `[a-z0-9\s-]`; collapse whitespace; cut at 100; spaces → hyphens; collisions get `-1`, `-2`, …; never blank (fallback `release-<8 hex>`).
- Body HTML allow-list: `a[href]` (http/https/mailto only), `p`, `ul`, `ol`, `li`, `strong` (`b` → `strong`), `br`, `div`, `asset`. Disallowed tags dropped with text kept, except `script`/`style`/`textarea`/`option`/`noscript` whose content is dropped too. Empty `<p>`/`<p>&nbsp;</p>`/`<p><strong>&nbsp;</strong></p>` removed.
- Summary auto-fill: until `summary_edited`, saving the first English document sets the English summary to `trimSummary(lede, 500)` (legacy `Utils.TrimSummary` + `TidyAndTruncateDocumentBodyText`).
- Publish "now" rounds to the current minute (DB clock); a publish time more than 5 minutes in the past is refused.
- Optimistic concurrency: every section save sends `version`; mismatch → HTTP 409 `{ error: "Someone else changed this release — reload to see their changes" }`.
- Reads need any of `NRMS.Viewer`, `NRMS.Editor`, `NRMS.SiteEditor`; writes need `NRMS.Editor`.
- Corrections emit `release.updated` with `notify: true`; first go-live emits `release.published`; only the importer's replay (3e) uses `notify: false`.
- No secrets in logs or output.
- **Ruling (spec §4 Unpublish "…and NoD"):** NoD only reacts to `release.published` today; withdrawing a release from NoD (digest/RSS) belongs to Phase 4 (NoD parity), where NoD will consume `release.unpublished`. Phase 3b emits the event; nothing more. Cost if wrong: an unpublished release could still appear in a NoD digest until Phase 4.
- **Scope note:** the Top/Feature switches (spec §5 editor categories, §6.5) are built in Phase 3d together with the `categoryFeatures` site event; this plan creates the `category_features` table only.

## Review Focus

1. A headline made entirely of non-Latin characters (e.g. `"中文"` or `"!!!"`) → slug falls back to `release-xxxxxxxx`, never blank or colliding. (Task 2 tests.)
2. Two editors approving different releases at the same instant → distinct `NEWS-` numbers and Keys, no 500. (Task 5 test with 20 concurrent approvals.)
3. A release scheduled in the past by more than 5 minutes, or with an empty French body → refused with a readable message, never silently stuck. (Task 6 tests.)
4. A correction saved while the publisher is mid-run on the same release → the save waits for the row lock, then lands as another correction; nothing lost. (Task 6 test: save during `publishing` keeps status `publishing`.)
5. Body HTML with `javascript:` links, `onclick`, `<script>`, `<img onerror>` → stripped on save and never reaches the News API. (Task 2 + Task 4 tests.)

---

## File structure

| File | Responsibility |
|---|---|
| `packages/nrms-contract/src/types.ts` | Release types, statuses, languages, view and list-item types |
| `packages/nrms-contract/src/rules.ts` | Per-type rules, asset-URL rule, status text, approve/publish problem lists |
| `packages/nrms-contract/src/schemas.ts` | zod input schemas for every API write |
| `apps/nrms/src/text/slug.ts` | `generateSlug` |
| `apps/nrms/src/text/sanitize.ts` | `sanitizeBodyHtml` |
| `apps/nrms/src/text/html-to-text.ts` | `htmlToText` (port of legacy `Convert.HtmlToText`) |
| `apps/nrms/src/text/plain.ts` | `asciiPunctuation`, `collapseBlankLines`, `trimSummary`, `ledeFromBody` |
| `apps/nrms/src/db/schema.ts` | All NRMS tables |
| `apps/nrms/src/taxonomy.ts` | Core event handlers → local `organizations` / `category_terms` cache; reads |
| `apps/nrms/src/releases/store.ts` | Load a full `ReleaseView`; write sections inside a version-checked transaction |
| `apps/nrms/src/releases/service.ts` | Create, section saves, documents, delete |
| `apps/nrms/src/releases/numbering.ts` | Counters, BC year, unique keys |
| `apps/nrms/src/releases/workflow.ts` | Approve, schedule, cancel, unpublish |
| `apps/nrms/src/releases/record.ts` | `toReleaseRecord` (view → event payload) |
| `apps/nrms/src/publisher.ts` | Rewritten go-live / correction / unpublish worker |
| `apps/nrms/src/releases/queries.ts` | Folder lists, search, go-to resolver |
| `apps/nrms/src/renditions/text.ts`, `pdf.ts` | Text and PDF versions |
| `apps/nrms/src/clients.ts` | NoD count and Distribution send clients |
| `apps/nrms/src/http/routes.ts` | All NRMS API routes |
| `apps/nod/src/http/routes.ts` | + subscriber count endpoint |
| `apps/distribution/src/messages.ts`, `sender.ts` | + optional attachments |
| `packages/auth/src/service-token.ts` | Shared service-to-service token provider |

---

### Task 1: `@gcpe/nrms-contract` — types, rules, schemas

**Files:**
- Create: `packages/nrms-contract/package.json`, `packages/nrms-contract/src/index.ts`, `packages/nrms-contract/src/testing.ts`, `packages/nrms-contract/src/types.ts`, `packages/nrms-contract/src/rules.ts`, `packages/nrms-contract/src/schemas.ts`, `packages/nrms-contract/src/rules.test.ts`, `packages/nrms-contract/src/schemas.test.ts`

**Interfaces:**
- Produces (all exported from `@gcpe/nrms-contract`):
  - `RELEASE_TYPES`, `CREATABLE_TYPES`, `type ReleaseType`; `RELEASE_STATUSES`, `type ReleaseStatus`; `LANG_EN = 4105`, `LANG_FR = 3084`, `type LanguageId`; `LAYOUTS`, `type Layout`; `CATEGORY_KINDS = ["ministries","sectors","themes","tags"]`, `type CategoryKind`
  - `POST_KIND: Record<ReleaseType, "releases"|"stories"|"factsheets"|"updates"|"advisories">`, `TYPE_LABEL: Record<ReleaseType, string>`
  - `interface ReleaseView`, `interface DocumentView`, `interface DocumentLanguageView`, `interface ReleaseLanguageView`, `interface ReleaseListItem`, `interface ReleasePage<T>`
  - `typeRules(type): TypeRules`, `assetUrlProblem(url: string): string | null`, `statusText(v: Pick<ReleaseView,"status"|"type"|"reference"|"publishAt">, nowMs: number): string`, `approveProblems(v: ReleaseView): string[]`, `publishProblems(v: ReleaseView): string[]`
  - Schemas: `createReleaseSchema`, `settingsSchema`, `categoriesSchema`, `assetSchema`, `metaSchema`, `documentLanguageSchema`, `addDocumentSchema`, `addTranslationSchema`, `reorderDocumentsSchema`, `scheduleSchema`, `versionOnlySchema`, `listQuerySchema`, `searchQuerySchema`

- [ ] **Step 1: Create the package**

`packages/nrms-contract/package.json`:

```json
{
  "name": "@gcpe/nrms-contract",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./testing": "./src/testing.ts" },
  "dependencies": { "zod": "^3.25.76" }
}
```

Run: `npx -y npm@11 install` (links the new workspace).

- [ ] **Step 2: Write the failing tests**

`packages/nrms-contract/src/rules.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { approveProblems, assetUrlProblem, publishProblems, statusText, typeRules } from "./rules";
import { view } from "./testing";

describe("typeRules", () => {
  it("matches legacy per-type behaviour", () => {
    expect(typeRules("advisory")).toMatchObject({ mediaListsAllowed: true, mediaListRequired: true, categoriesBeyondMinistries: false, assetsAllowed: false, keyEditable: false, unpublishable: false, generatesKey: true, pageImageAllowed: false });
    expect(typeRules("story")).toMatchObject({ mediaListsAllowed: false, keyEditable: true, generatesKey: false, nodAllowed: true });
    expect(typeRules("update")).toMatchObject({ mediaListsAllowed: false, generatesKey: true, nodAllowed: false, creatable: false });
    expect(typeRules("release").defaultPublishOptions(false)).toEqual({ toWeb: true, toSubscribers: true, toMediaLists: false });
    expect(typeRules("factsheet").defaultPublishOptions(true)).toEqual({ toWeb: true, toSubscribers: false, toMediaLists: true });
    expect(typeRules("advisory").defaultPublishOptions(true)).toEqual({ toWeb: false, toSubscribers: false, toMediaLists: true });
  });
});

describe("assetUrlProblem", () => {
  it("accepts Flickr, YouTube and the live page; refuses Facebook and others", () => {
    for (const ok of ["https://www.flickr.com/photos/bcgovphotos/123/", "https://flic.kr/p/2abc", "https://www.youtube.com/watch?v=x", "https://youtu.be/x", "https://news.gov.bc.ca/live"]) expect(assetUrlProblem(ok)).toBeNull();
    expect(assetUrlProblem("https://www.facebook.com/x")).toMatch(/Facebook is no longer supported/);
    expect(assetUrlProblem("ftp://flickr.com/x")).toMatch(/http/);
    expect(assetUrlProblem("not a url")).toMatch(/absolute/);
    expect(assetUrlProblem("https://example.com/x")).toMatch(/YouTube or Flickr/);
  });
});

describe("statusText", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  it("uses legacy wording", () => {
    expect(statusText({ status: "draft", type: "release", reference: null, publishAt: null }, now)).toBe("Draft");
    expect(statusText({ status: "approved", type: "release", reference: "NEWS-00001", publishAt: null }, now)).toBe("Approved");
    expect(statusText({ status: "approved", type: "release", reference: "NEWS-00001", publishAt: "2026-10-04T12:00:00Z" }, now)).toBe("Planned");
    expect(statusText({ status: "scheduled", type: "release", reference: "NEWS-00001", publishAt: "2026-10-04T12:00:00Z" }, now)).toBe("Scheduled");
    expect(statusText({ status: "scheduled", type: "release", reference: "NEWS-00001", publishAt: "2026-10-03T11:59:00Z" }, now)).toBe("Publishing...");
    expect(statusText({ status: "publishing", type: "release", reference: "NEWS-00001", publishAt: null }, now)).toBe("Republishing...");
    expect(statusText({ status: "published", type: "advisory", reference: "NEWS-00001", publishAt: null }, now)).toBe("Sent");
    expect(statusText({ status: "unpublishing", type: "advisory", reference: "NEWS-00001", publishAt: null }, now)).toBe("Unscheduling...");
    expect(statusText({ status: "unpublishing", type: "release", reference: "NEWS-00001", publishAt: null }, now)).toBe("Unpublishing...");
  });
});

describe("approveProblems / publishProblems", () => {
  it("non-advisories need a lead ministry to approve", () => {
    expect(approveProblems(view())).toEqual([]);
    expect(approveProblems(view({ leadMinistryKey: null, ministries: [] }))).toEqual(["Choose at least one ministry."]);
    expect(approveProblems(view({ leadMinistryKey: null, ministries: ["health", "finance"] }))).toEqual(["Choose the lead ministry."]);
    expect(approveProblems(view({ type: "advisory", leadMinistryKey: null, ministries: [] }))).toEqual([]);
  });
  it("lists everything that blocks publishing", () => {
    expect(publishProblems(view({ publishAt: "2026-10-04T12:00:00Z" }))).toEqual([]);
    const bad = view({
      sectors: [],
      documents: [{ id: "d1", sortIndex: 0, layout: "formal", languages: [
        { languageId: 4105, pageTitle: "", headline: " ", subheadline: null, organizations: null, byline: null, bodyHtml: "<p></p>", pageImageId: null, contacts: [] },
        { languageId: 3084, pageTitle: "Communiqué", headline: "Titre", subheadline: null, organizations: "Ministère", byline: null, bodyHtml: "", pageImageId: null, contacts: [] },
      ] }],
    });
    expect(publishProblems(bad)).toEqual([
      "Choose at least one sector.",
      "Document 1 (English) needs a headline.",
      "Document 1 (English) needs body text.",
      "Document 1 (English) needs organizations (formal layout).",
      "Document 1 (French) needs body text.",
    ]);
    expect(publishProblems(view({ type: "advisory", sectors: [], mediaListKeys: [] }))).toContain("Choose at least one media distribution list.");
  });
});
```

`packages/nrms-contract/src/testing.ts` (a shared fixture, not a test file — test files must never be imported by other tests):

```ts
import type { ReleaseView } from "./types";

export function view(over: Partial<ReleaseView> = {}): ReleaseView {
  return {
    id: "00000000-0000-4000-8000-000000000001", type: "release", key: null, reference: null, status: "draft", onHold: false, version: 1,
    leadMinistryKey: "health", activityId: null, publishAt: null, releasedAt: null,
    publishOptions: { toWeb: true, toSubscribers: true, toMediaLists: false },
    assetUrl: null, assetAltText: null, hasMediaAssets: false, hasTranslations: false, redirectUrl: null, keywords: null, atomId: null,
    nodSubscribers: null, mediaSubscribers: null, lastError: null,
    languages: [{ languageId: 4105, location: "VICTORIA", summary: "Clinics open.", summaryEdited: false, socialMediaSummary: null }],
    documents: [{ id: "d1", sortIndex: 0, layout: "formal", languages: [{ languageId: 4105, pageTitle: "News Release", headline: "Clinics open", subheadline: null, organizations: "Ministry of Health", byline: null, bodyHtml: "<p>Body</p>", pageImageId: null, contacts: ["Media Relations\n250-555-0100"] }] }],
    ministries: ["health"], sectors: ["health"], themes: [], tags: [], mediaListKeys: [],
    createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z",
    ...over,
  };
}
```

`packages/nrms-contract/src/schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { categoriesSchema, createReleaseSchema, documentLanguageSchema, listQuerySchema, metaSchema, scheduleSchema, settingsSchema } from "./schemas";

describe("schemas", () => {
  it("create: only creatable types, required headline and page title", () => {
    const ok = createReleaseSchema.parse({ type: "release", pageTitle: "News Release", layout: "formal", headline: "Clinics open", ministries: ["health"], sectors: ["health"] });
    expect(ok).toMatchObject({ themes: [], tags: [], mediaListKeys: [], organizations: null, byline: null, bodyHtml: "", location: "", contacts: [], activityId: null });
    expect(createReleaseSchema.safeParse({ ...ok, type: "update" }).success).toBe(false);
    expect(createReleaseSchema.safeParse({ ...ok, headline: "" }).success).toBe(false);
    expect(createReleaseSchema.safeParse({ ...ok, pageTitle: "x".repeat(51) }).success).toBe(false);
  });
  it("field length limits follow the legacy schema", () => {
    const base = { version: 1, pageTitle: "T", layout: "formal", headline: "H", subheadline: null, organizations: null, byline: null, bodyHtml: "", pageImageId: null, contacts: [] };
    expect(documentLanguageSchema.safeParse(base).success).toBe(true);
    expect(documentLanguageSchema.safeParse({ ...base, headline: "x".repeat(256) }).success).toBe(false);
    expect(documentLanguageSchema.safeParse({ ...base, subheadline: "x".repeat(101) }).success).toBe(false);
    expect(documentLanguageSchema.safeParse({ ...base, contacts: ["x".repeat(251)] }).success).toBe(false);
    expect(metaSchema.safeParse({ version: 1, key: null, redirectUrl: "ftp://x", location: "", summary: "", socialMediaSummary: null, keywords: null }).success).toBe(false);
    expect(metaSchema.safeParse({ version: 1, key: null, redirectUrl: null, location: "x".repeat(51), summary: "", socialMediaSummary: null, keywords: null }).success).toBe(false);
  });
  it("activity id is numeric, categories are lowercased and de-duplicated", () => {
    expect(settingsSchema.safeParse({ version: 1, activityId: "12a", toSubscribers: true, toMediaLists: false, mediaListKeys: [] }).success).toBe(false);
    expect(categoriesSchema.parse({ version: 1, leadMinistryKey: "Health", ministries: ["Health", "health"], sectors: [], themes: [], tags: [] })).toMatchObject({ leadMinistryKey: "health", ministries: ["health"] });
  });
  it("schedule takes 'now' or an offset datetime; list query has defaults", () => {
    expect(scheduleSchema.parse({ version: 3, publishAt: "now" }).publishAt).toBe("now");
    expect(scheduleSchema.safeParse({ version: 3, publishAt: "2026-10-04T09:00:00" }).success).toBe(false);
    expect(listQuerySchema.parse({ folder: "drafts" })).toEqual({ folder: "drafts", type: "all", page: 1, pageSize: 25 });
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/nrms-contract`
Expected: FAIL — modules missing.

- [ ] **Step 4: Implement**

`packages/nrms-contract/src/types.ts`:

```ts
export const RELEASE_TYPES = ["release", "story", "factsheet", "update", "advisory"] as const;
export type ReleaseType = (typeof RELEASE_TYPES)[number];
/** Update can't be created (legacy New.aspx has it commented out); imported Updates stay editable. */
export const CREATABLE_TYPES = ["release", "story", "factsheet", "advisory"] as const;
export const RELEASE_STATUSES = ["draft", "approved", "scheduled", "publishing", "published", "unpublishing", "failed", "deleted"] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];
export const LANG_EN = 4105;
export const LANG_FR = 3084;
export type LanguageId = typeof LANG_EN | typeof LANG_FR;
export const LANGUAGE_NAME: Record<LanguageId, string> = { 4105: "English", 3084: "French" };
export const LAYOUTS = ["formal", "informal"] as const;
export type Layout = (typeof LAYOUTS)[number];
export const CATEGORY_KINDS = ["ministries", "sectors", "themes", "tags"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const POST_KIND = { release: "releases", story: "stories", factsheet: "factsheets", update: "updates", advisory: "advisories" } as const satisfies Record<ReleaseType, string>;
export const TYPE_LABEL: Record<ReleaseType, string> = { release: "Release", story: "Story", factsheet: "Factsheet", update: "Update", advisory: "Advisory" };

export interface PublishOptions {
  toWeb: boolean;
  toSubscribers: boolean;
  toMediaLists: boolean;
}

export interface ReleaseLanguageView {
  languageId: LanguageId;
  location: string;
  summary: string;
  summaryEdited: boolean;
  socialMediaSummary: string | null;
}

export interface DocumentLanguageView {
  languageId: LanguageId;
  pageTitle: string;
  headline: string;
  subheadline: string | null;
  organizations: string | null;
  byline: string | null;
  bodyHtml: string;
  pageImageId: string | null;
  /** Ordered contact blocks; first line is the title (as the News API splits them). */
  contacts: string[];
}

export interface DocumentView {
  id: string;
  sortIndex: number;
  layout: Layout;
  languages: DocumentLanguageView[];
}

export interface ReleaseView {
  id: string;
  type: ReleaseType;
  key: string | null;
  reference: string | null;
  status: ReleaseStatus;
  onHold: boolean;
  version: number;
  leadMinistryKey: string | null;
  activityId: number | null;
  /** ISO 8601; planned (draft/approved) or committed (scheduled+) publish time. */
  publishAt: string | null;
  releasedAt: string | null;
  publishOptions: PublishOptions;
  assetUrl: string | null;
  assetAltText: string | null;
  hasMediaAssets: boolean;
  hasTranslations: boolean;
  redirectUrl: string | null;
  keywords: string | null;
  atomId: string | null;
  nodSubscribers: number | null;
  mediaSubscribers: number | null;
  lastError: string | null;
  languages: ReleaseLanguageView[];
  documents: DocumentView[];
  ministries: string[];
  sectors: string[];
  themes: string[];
  tags: string[];
  mediaListKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseListItem {
  id: string;
  type: ReleaseType;
  key: string | null;
  reference: string | null;
  status: ReleaseStatus;
  statusText: string;
  leadOrganization: string;
  pageTitle: string;
  headline: string;
  location: string;
  summary: string;
  publishAt: string | null;
  releasedAt: string | null;
  activityId: number | null;
  approved: boolean;
}

export interface ReleasePage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
```

`packages/nrms-contract/src/rules.ts`:

```ts
import { LANG_EN, LANGUAGE_NAME, type PublishOptions, type ReleaseType, type ReleaseView } from "./types";

export interface TypeRules {
  creatable: boolean;
  mediaListsAllowed: boolean;
  mediaListRequired: boolean;
  /** Sectors, themes, tags, summary, keywords, release date, assets, translations. */
  categoriesBeyondMinistries: boolean;
  assetsAllowed: boolean;
  pageImageAllowed: boolean;
  /** Story/Factsheet keys come from the headline and stay editable until scheduled. */
  keyEditable: boolean;
  /** Release/Advisory/Update get the legacy `{year}{ABBR}{n}-{m}` key at approve. */
  generatesKey: boolean;
  unpublishable: boolean;
  /** Legacy AllowPublishToNewsOnDemand. */
  nodAllowed: boolean;
  /** Media lists lock once a Release or Factsheet has gone live. */
  mediaListsLockAfterRelease: boolean;
  defaultPublishOptions(hasMediaLists: boolean): PublishOptions;
}

export function typeRules(type: ReleaseType): TypeRules {
  const advisory = type === "advisory";
  return {
    creatable: type !== "update",
    mediaListsAllowed: type === "release" || type === "factsheet" || advisory,
    mediaListRequired: advisory,
    categoriesBeyondMinistries: !advisory,
    assetsAllowed: !advisory,
    pageImageAllowed: !advisory,
    keyEditable: type === "story" || type === "factsheet",
    generatesKey: type === "release" || type === "advisory" || type === "update",
    unpublishable: !advisory,
    nodAllowed: type === "release" || type === "story" || type === "factsheet",
    mediaListsLockAfterRelease: type === "release" || type === "factsheet",
    defaultPublishOptions: (hasMediaLists) => ({
      // Legacy NewModel.cs: Advisories are never published to the website.
      toWeb: !advisory,
      toSubscribers: type === "release" || type === "update",
      toMediaLists: hasMediaLists,
    }),
  };
}

const ASSET_HOSTS = [/(^|\.)flickr\.com$/, /^flic\.kr$/, /(^|\.)youtube\.com$/, /^youtu\.be$/];

/** Legacy Release.aspx.cs asset rules. Returns a message, or null when acceptable. */
export function assetUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "The asset URL must be an absolute URL.";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "The asset URL must start with http:// or https://.";
  const host = u.hostname.toLowerCase();
  if (/(^|\.)facebook\.com$/.test(host) || host === "fb.watch") return "Facebook is no longer supported due to privacy concerns. Use YouTube or Flickr URLs instead.";
  if (ASSET_HOSTS.some((re) => re.test(host))) return null;
  if (host === "news.gov.bc.ca" && u.pathname.replace(/\/$/, "") === "/live") return null;
  return "Use a YouTube or Flickr URL, or https://news.gov.bc.ca/live.";
}

export function statusText(v: Pick<ReleaseView, "status" | "type" | "reference" | "publishAt">, nowMs: number): string {
  const advisory = v.type === "advisory";
  switch (v.status) {
    case "draft":
    case "approved":
      return v.publishAt ? "Planned" : v.reference ? "Approved" : "Draft";
    case "scheduled":
      return v.publishAt && Date.parse(v.publishAt) > nowMs ? "Scheduled" : "Publishing...";
    case "publishing":
      return "Republishing...";
    case "published":
      return advisory ? "Sent" : "Published";
    case "unpublishing":
      return advisory ? "Unscheduling..." : "Unpublishing...";
    case "failed":
      return "Failed";
    case "deleted":
      return "Deleted";
  }
}

const isBlankHtml = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&nbsp;| /g, " ").trim() === "";

export function approveProblems(v: ReleaseView): string[] {
  if (v.type === "advisory") return [];
  if (v.ministries.length === 0) return ["Choose at least one ministry."];
  if (!v.leadMinistryKey && v.ministries.length > 1) return ["Choose the lead ministry."];
  return [];
}

export function publishProblems(v: ReleaseView): string[] {
  const rules = typeRules(v.type);
  const out: string[] = [];
  if (rules.categoriesBeyondMinistries) {
    if (v.ministries.length === 0) out.push("Choose at least one ministry.");
    if (v.sectors.length === 0) out.push("Choose at least one sector.");
  }
  if (rules.mediaListRequired && v.mediaListKeys.length === 0) out.push("Choose at least one media distribution list.");
  if (v.documents.length === 0) out.push("Add at least one document.");
  for (const d of [...v.documents].sort((a, b) => a.sortIndex - b.sortIndex)) {
    for (const l of [...d.languages].sort((a, b) => (a.languageId === LANG_EN ? -1 : b.languageId === LANG_EN ? 1 : 0))) {
      const label = `Document ${d.sortIndex + 1} (${LANGUAGE_NAME[l.languageId]})`;
      if (!l.headline.trim()) out.push(`${label} needs a headline.`);
      if (isBlankHtml(l.bodyHtml)) out.push(`${label} needs body text.`);
      if (d.layout === "formal" && rules.categoriesBeyondMinistries && !l.organizations?.trim()) out.push(`${label} needs organizations (formal layout).`);
    }
  }
  return out;
}
```

`packages/nrms-contract/src/schemas.ts`:

```ts
import { z } from "zod";
import { CREATABLE_TYPES, LAYOUTS, RELEASE_TYPES } from "./types";

const key = z.string().trim().toLowerCase().min(1).max(100);
const keys = z.array(key).max(200).transform((a) => [...new Set(a)]);
const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((s) => /^https?:\/\/\S+$/i.test(s), "must be an absolute http:// or https:// URL");
const languageId = z.union([z.literal(4105), z.literal(3084)]);
const version = z.number().int().positive();
const contact = z.string().max(250);
const activityId = z
  .union([z.number().int().positive(), z.string().regex(/^\d+$/, "Activity ID must be numeric").transform(Number), z.null()])
  .default(null);

export const versionOnlySchema = z.object({ version });

export const createReleaseSchema = z.object({
  type: z.enum(CREATABLE_TYPES),
  pageTitle: z.string().trim().min(1).max(50),
  layout: z.enum(LAYOUTS),
  pageImageId: z.string().uuid().nullable().default(null),
  headline: z.string().trim().min(1).max(255),
  subheadline: z.string().max(100).nullable().default(null),
  organizations: z.string().max(500).nullable().default(null),
  byline: z.string().max(250).nullable().default(null),
  bodyHtml: z.string().max(500_000).default(""),
  location: z.string().max(50).default(""),
  contacts: z.array(contact).max(20).default([]),
  ministries: keys.default([]),
  leadMinistryKey: key.nullable().default(null),
  sectors: keys.default([]),
  themes: keys.default([]),
  tags: keys.default([]),
  mediaListKeys: keys.default([]),
  activityId,
  publishAt: z.string().datetime({ offset: true }).nullable().default(null),
});
export type CreateReleaseInput = z.infer<typeof createReleaseSchema>;

export const settingsSchema = z.object({
  version,
  activityId,
  /** Planned publish time (drafts); committing a time is POST /schedule. */
  plannedPublishAt: z.string().datetime({ offset: true }).nullable().default(null),
  toSubscribers: z.boolean(),
  toMediaLists: z.boolean(),
  mediaListKeys: keys,
});
export type SettingsInput = z.infer<typeof settingsSchema>;

export const categoriesSchema = z.object({ version, leadMinistryKey: key.nullable(), ministries: keys, sectors: keys, themes: keys, tags: keys });
export type CategoriesInput = z.infer<typeof categoriesSchema>;

export const assetSchema = z.object({
  version,
  assetUrl: httpUrl.nullable(),
  assetAltText: z.string().max(149, "Alt text must be under 150 characters").nullable(),
  hasMediaAssets: z.boolean(),
});
export type AssetInput = z.infer<typeof assetSchema>;

export const metaSchema = z.object({
  version,
  key: z.string().trim().max(100).nullable(),
  redirectUrl: httpUrl.nullable(),
  location: z.string().max(50),
  summary: z.string().max(5000),
  socialMediaSummary: z.string().max(5000).nullable(),
  keywords: z.string().max(2000).nullable(),
});
export type MetaInput = z.infer<typeof metaSchema>;

export const documentLanguageSchema = z.object({
  version,
  pageTitle: z.string().trim().min(1).max(50),
  layout: z.enum(LAYOUTS),
  headline: z.string().trim().max(255),
  subheadline: z.string().max(100).nullable(),
  organizations: z.string().max(500).nullable(),
  byline: z.string().max(250).nullable(),
  bodyHtml: z.string().max(500_000),
  pageImageId: z.string().uuid().nullable(),
  contacts: z.array(contact).max(20),
});
export type DocumentLanguageInput = z.infer<typeof documentLanguageSchema>;

export const addDocumentSchema = z.object({ version, pageTitle: z.string().trim().min(1).max(50), layout: z.enum(LAYOUTS) });
export const addTranslationSchema = z.object({ version, languageId });
export const reorderDocumentsSchema = z.object({ version, documentIds: z.array(z.string().uuid()).min(1).max(50) });
export const scheduleSchema = z.object({ version, publishAt: z.union([z.literal("now"), z.string().datetime({ offset: true })]) });
export type ScheduleInput = z.infer<typeof scheduleSchema>;

export const listQuerySchema = z.object({
  folder: z.enum(["drafts", "scheduled", "published"]),
  type: z.enum(["all", ...RELEASE_TYPES]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListQuery = z.infer<typeof listQuerySchema>;
export const searchQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  ministry: z.string().trim().toLowerCase().max(100).optional(),
  sector: z.string().trim().toLowerCase().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type AddDocumentInput = z.infer<typeof addDocumentSchema>;
export type AddTranslationInput = z.infer<typeof addTranslationSchema>;
export type ReorderDocumentsInput = z.infer<typeof reorderDocumentsSchema>;
```

`packages/nrms-contract/src/index.ts`:

```ts
export * from "./types";
export * from "./rules";
export * from "./schemas";
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/nrms-contract && npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/nrms-contract package.json package-lock.json
git commit -m "feat(nrms-contract): release types, per-type rules, status wording and input schemas"
```

---

### Task 2: Text toolkit — slug, sanitiser, HTML-to-text, summary

**Files:**
- Create: `apps/nrms/src/text/slug.ts`, `apps/nrms/src/text/sanitize.ts`, `apps/nrms/src/text/html-to-text.ts`, `apps/nrms/src/text/plain.ts`, `apps/nrms/src/text/text.test.ts`

**Interfaces:**
- Produces: `generateSlug(phrase: string): string` (may return `""`; callers apply the fallback in Task 5); `sanitizeBodyHtml(html: string): string`; `htmlToText(html: string): string` (CRLF line endings, as legacy); `asciiPunctuation(s: string): string`; `collapseBlankLines(s: string): string`; `trimSummary(text: string, length?: number): string`; `ledeFromBody(html: string): string`; `summaryFromBody(html: string): string`.

- [ ] **Step 1: Add dependencies**

Run: `npx -y npm@11 install sanitize-html@^2 htmlparser2@^10 domhandler@^5 -w @gcpe/nrms && npx -y npm@11 install -D @types/sanitize-html@^2 -w @gcpe/nrms`

- [ ] **Step 2: Write the failing tests**

`apps/nrms/src/text/text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { htmlToText } from "./html-to-text";
import { asciiPunctuation, collapseBlankLines, ledeFromBody, summaryFromBody, trimSummary } from "./plain";
import { sanitizeBodyHtml } from "./sanitize";
import { generateSlug } from "./slug";

describe("generateSlug — legacy SlugUnitTests cases, verbatim", () => {
  it.each([
    ["Province celebrates First Nation, Métis, Inuit employees", "province-celebrates-first-nation-metis-inuit-employees"],
    ["B.C.'s Skills for Jobs Blueprint eNewsletter", "bcs-skills-for-jobs-blueprint-enewsletter"],
    ["OPINION-EDITORIAL: As K'ómoks signs AIP, treaty process is going strong", "opinion-editorial-as-komoks-signs-aip-treaty-process-is-going-strong"],
    ["BC Liquor Stores collect over $208,000 for Nepal Relief", "bc-liquor-stores-collect-over-208000-for-nepal-relief"],
    ["Canada and British Columbia sign Agreement-in-Principle", "canada-and-british-columbia-sign-agreement-in-principle"],
    ["FACTSHEET: BC Stats Report - Profile of the British Columbia High Tech Sector 2014 Edition", "factsheet-bc-stats-report-profile-of-the-british-columbia-high-tech-sector-2014-edition"],
    ["Tsilhqot’in title land access", "tsilhqotin-title-land-access"],
    ["Et si l’absentéisme révélait un mal être au travail ?", "et-si-labsenteisme-revelait-un-mal-etre-au-travail"],
  ])("%s", (phrase, slug) => expect(generateSlug(phrase)).toBe(slug));

  it("cuts at 100 characters without a trailing hyphen, and can come out empty", () => {
    const s = generateSlug(`${"word ".repeat(30)}end`);
    expect(s.length).toBeLessThanOrEqual(100);
    expect(s.endsWith("-")).toBe(false);
    expect(generateSlug("中文 !!!")).toBe("");
  });
});

describe("sanitizeBodyHtml", () => {
  it("keeps the allow-list, normalises b, strips attributes except a[href]", () => {
    expect(sanitizeBodyHtml('<p class="x" style="color:red">Hi <b>there</b></p>')).toBe("<p>Hi <strong>there</strong></p>");
    expect(sanitizeBodyHtml('<a href="https://gov.bc.ca" target="_blank" onclick="x()">link</a>')).toBe('<a href="https://gov.bc.ca">link</a>');
    expect(sanitizeBodyHtml("<ul><li>one</li></ul><ol><li>two</li></ol><div>d<br>e</div>")).toBe("<ul><li>one</li></ul><ol><li>two</li></ol><div>d<br />e</div>");
    expect(sanitizeBodyHtml("<asset>https://youtu.be/abc</asset>")).toBe("<asset>https://youtu.be/abc</asset>");
  });
  it("drops disallowed tags but keeps their text; drops script/style content", () => {
    expect(sanitizeBodyHtml("<h1>Title</h1><p><span>keep</span></p>")).toBe("Title<p>keep</p>");
    expect(sanitizeBodyHtml("<p>a</p><script>alert(1)</script><style>p{}</style>")).toBe("<p>a</p>");
    expect(sanitizeBodyHtml('<p><img src="x" onerror="alert(1)">b</p>')).toBe("<p>b</p>");
  });
  it("removes dangerous link schemes and empty paragraphs", () => {
    expect(sanitizeBodyHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeBodyHtml("<p>&nbsp;</p><p> <strong>&nbsp;</strong> </p><p></p><p>real</p>")).toBe("<p>real</p>");
  });
});

describe("htmlToText — legacy Convert.HtmlToText", () => {
  it("paragraphs, lists, breaks, links", () => {
    expect(htmlToText("<p>One</p><p>Two<br>three</p>")).toBe("One\r\n\r\nTwo\r\nthree\r\n\r\n");
    expect(htmlToText("<ul><li>a</li><li>b</li></ul>")).toBe("* a\r\n* b\r\n\r\n");
    expect(htmlToText("<ol><li>a</li><li>b</li></ol>")).toBe("1. a\r\n2. b\r\n\r\n");
    expect(htmlToText('<p><a href="https://gov.bc.ca">BC</a> and <a href="http://x.ca/">x.ca</a> and <a href="#top">top</a></p>')).toBe("BC (https://gov.bc.ca) and x.ca and top\r\n\r\n");
    expect(htmlToText("<p>Fish &amp; chips<asset>https://youtu.be/x</asset></p><p>&nbsp;</p>")).toBe("Fish & chips\r\n\r\n");
    expect(htmlToText("")).toBe("");
  });
});

describe("plain-text helpers", () => {
  it("asciiPunctuation follows the legacy replacement table", () => {
    expect(asciiPunctuation("‘a’ “b” c… d–e—f ‹g› h i ˆ")).toBe("'a' \"b\" c... d-e-f <g> h i ^");
  });
  it("collapseBlankLines collapses runs of blank lines", () => {
    expect(collapseBlankLines("a\r\n\r\n\r\n\r\nb\r\n  \r\nc")).toBe("a\r\n\r\nb\r\n\r\nc");
  });
  it("trimSummary matches legacy Utils.TrimSummary", () => {
    expect(trimSummary("Short.", 500)).toBe("Short.");
    expect(trimSummary("one two three four", 12)).toBe("one two...");
    expect(trimSummary("Hello world. More words here", 16)).toBe("Hello world.");
  });
  it("lede is the first line of the body text; summary trims it to 500", () => {
    expect(ledeFromBody("<p>First para.</p><p>Second.</p>")).toBe("First para.");
    expect(summaryFromBody(`<p>${"word ".repeat(200)}</p>`).length).toBeLessThanOrEqual(500);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms/src/text`
Expected: FAIL — modules missing.

- [ ] **Step 4: Implement**

`apps/nrms/src/text/slug.ts`:

```ts
const MAX_SLUG = 100;

/**
 * Legacy ReleaseManagementModel.GenerateSlug, test-for-test (Gcpe.Hub.Legacy.Website.Tests/
 * SlugUnitTests.cs): accents transliterated, curly quotes dropped, " - " → space, anything else
 * outside [a-z0-9 -] dropped, cut at 100, spaces → hyphens. May return "" (callers fall back).
 */
export function generateSlug(phrase: string): string {
  let s = phrase.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  s = s.replace(/[‘’“”]/g, "");
  s = s.replace(/ - /g, " ");
  s = s.replace(/[^a-z0-9\s-]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  s = s.slice(0, MAX_SLUG).trim();
  return s.replace(/\s/g, "-");
}
```

`apps/nrms/src/text/sanitize.ts`:

```ts
import sanitizeHtml from "sanitize-html";

/** Spec addendum §4 body allow-list (legacy HtmlTagCleaner + the <asset> embed tag). */
export const BODY_TAGS = ["a", "p", "ul", "ol", "li", "strong", "br", "div", "asset"];

const EMPTY_PARAGRAPH = /<p>\s*(?:<strong>)?\s*(?:&nbsp;| )?\s*(?:<\/strong>)?\s*<\/p>/g;

export function sanitizeBodyHtml(html: string): string {
  const cleaned = sanitizeHtml(html, {
    allowedTags: BODY_TAGS,
    allowedAttributes: { a: ["href"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href"],
    allowProtocolRelative: false,
    transformTags: { b: "strong" },
    nonTextTags: ["script", "style", "textarea", "option", "noscript"],
    selfClosing: ["br"],
  });
  return cleaned.replace(EMPTY_PARAGRAPH, "");
}
```

`apps/nrms/src/text/html-to-text.ts`:

```ts
import { parseDocument } from "htmlparser2";
import { isTag, isText, type ChildNode } from "domhandler";

const NL = "\r\n";
const ASSET = /<asset>[^<]+<\/asset>/g;

/** Port of legacy Gcpe.News.ReleaseManagement.Templates/Convert.cs HtmlToText. */
export function htmlToText(html: string): string {
  if (html === "") return "";
  const cleaned = html.replace(ASSET, "").replaceAll("<p>&nbsp;</p>", "").replaceAll("<p></p>", "");
  return parseDocument(cleaned).children.map(node).join("");
}

function children(n: ChildNode): string {
  return isTag(n) ? n.children.map(node).join("") : "";
}

function node(n: ChildNode): string {
  if (isText(n)) return n.data.replace(/^[\r\n]+|[\r\n]+$/g, "");
  if (!isTag(n)) return "";
  switch (n.name.toLowerCase()) {
    case "a": {
      const raw = n.attribs.href;
      const href = raw && !raw.startsWith("#") ? raw : null;
      const text = children(n);
      const norm = (s: string) => s.replace("http://", "").replace(/\/+$/, "");
      return href && href.trim() && norm(text) !== norm(href) ? `${text} (${href})` : text;
    }
    case "p":
    case "div":
      return children(n) + NL + NL;
    case "br":
      return NL;
    case "ol":
    case "ul": {
      let i = 1;
      let out = "";
      for (const c of n.children) {
        if (isTag(c) && c.name.toLowerCase() === "li") out += n.name.toLowerCase() === "ol" ? `${i++}. ` : "* ";
        out += isTag(c) ? c.children.map(node).join("") : "";
        out += NL;
      }
      return out + NL;
    }
    default:
      return children(n);
  }
}
```

Note: htmlparser2 decodes entities in text nodes by default, matching legacy `HtmlDecode`.

`apps/nrms/src/text/plain.ts`:

```ts
import { htmlToText } from "./html-to-text";

/** Legacy Release.ToTextDocumentAsString punctuation table. */
const REPLACEMENTS: [RegExp, string][] = [
  [/[‘’‚]/g, "'"],
  [/[“”„]/g, '"'],
  [/…/g, "..."],
  [/[‒–—―]/g, "-"],
  [/⁓/g, "~"],
  [/[_ˍ]/g, "_"],
  [/[-­¯ˉ˗‐‑‾⁃⁻₋−⎯⏤─➖⸺⸻မ]/g, "-"],
  [/[~˜∼]/g, "~"],
  [/ˆ/g, "^"],
  [/‹/g, "<"],
  [/›/g, ">"],
  [/[˜ ]/g, " "],
];

export function asciiPunctuation(s: string): string {
  return REPLACEMENTS.reduce((acc, [re, to]) => acc.replace(re, to), s);
}

export function collapseBlankLines(s: string): string {
  let out = s;
  while (out.includes("\r\n\r\n\r\n") || out.includes("\r\n  \r\n")) out = out.replaceAll("\r\n\r\n\r\n", "\r\n\r\n").replaceAll("\r\n  \r\n", "\r\n\r\n");
  return out;
}

/** Legacy Utils.TrimSummary. */
export function trimSummary(text: string, length = 500): string {
  if (text.length <= length) return text;
  let s = text.slice(0, length - 3);
  while (s.length > 0 && !/[ .!?]$/.test(s)) s = s.slice(0, -1);
  s = s.trim();
  if (!/[.!?]$/.test(s)) {
    if (/\p{P}$/u.test(s)) s = s.slice(0, -1);
    s = s.trim() + "...";
  }
  return s;
}

/** Legacy NewModel.TidyAndTruncateDocumentBodyText over Convert.HtmlToText: the first line. */
export function ledeFromBody(html: string): string {
  const text = htmlToText(html).replaceAll("\r", "");
  const nl = text.indexOf("\n");
  return nl >= 0 ? text.slice(0, nl) : text;
}

export function summaryFromBody(html: string): string {
  return trimSummary(ledeFromBody(html), 500);
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms/src/text`
Expected: PASS. If a sanitizer expectation differs only in how `sanitize-html` serialises `<br>` (e.g. `<br />` vs `<br>`), keep the library's output and update that single expected string — the test's purpose is the allow-list, not the serialisation.

- [ ] **Step 6: Commit**

```bash
git add apps/nrms package-lock.json
git commit -m "feat(nrms): slug, body sanitiser, HTML-to-text and summary helpers ported from legacy"
```

---
### Task 3: Local copy of Core's ministries and categories

NRMS needs ministry abbreviations (for Keys) and the category lists (for validation and the staff app). Core already emits `org.*`, `sector.*`, `theme.*`, `tag.*` events; NRMS subscribes to them and keeps a local copy.

**Files:**
- Modify: `apps/nrms/src/db/schema.ts`, `apps/nrms/src/app.ts`, `apps/nrms/src/start.ts`, `apps/nrms/src/http/routes.ts`, `apps/stack/src/env.ts`, `apps/stack/src/env.test.ts`, `apps/stack/src/stack.test.ts`
- Create: `apps/nrms/migrations/0002_taxonomy_cache.sql` (generated), `apps/nrms/src/taxonomy.ts`, `apps/nrms/src/taxonomy.test.ts`

**Interfaces:**
- Consumes: `createEventReceiver`, `type EventEnvelope`, `type EventHandler`, `type OrgRecord`, `type TermRecord` (`@gcpe/events`); `eventSecretsSchema` (`@gcpe/config`); `requireAnyRole` (`@gcpe/auth`, Phase 3a).
- Produces:
  - Tables `organizations (key pk, display_name, abbreviation, sort_order, is_active)` and `category_terms (kind, key, display_name, sort_order, is_active; pk(kind,key))`
  - `taxonomyHandler(event: EventEnvelope): EventHandler | undefined`
  - `interface Categories { ministries: { key: string; name: string; abbreviation: string | null }[]; sectors: { key: string; name: string }[]; themes: …; tags: … }`; `listCategories(db: DbOrTx): Promise<Categories>`; `ministryAbbreviation(db: DbOrTx, key: string): Promise<string | null>`; `ministryName(db: DbOrTx, key: string): Promise<string | null>`
  - `GET /api/categories` (any NRMS read role)
  - Stack route `CORE → NRMS` (`self:/nrms/events`) for those eight event types

- [ ] **Step 1: Add the tables and generate the migration**

Append to `apps/nrms/src/db/schema.ts` (add `boolean`, `integer`, `primaryKey` to the pg-core import):

```ts
/** Local copy of Core's ministries (org.* events). Keys stored lowercased. */
export const organizations = pgTable("organizations", {
  key: text("key").primaryKey(),
  displayName: text("display_name").notNull(),
  abbreviation: text("abbreviation"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
});

/** Local copy of Core's sectors, themes and tags (sector.*, theme.*, tag.* events). */
export const categoryTerms = pgTable(
  "category_terms",
  {
    kind: text("kind").$type<"sectors" | "themes" | "tags">().notNull(),
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.kind, t.key] })],
);
```

Run: `cd apps/nrms && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name taxonomy_cache && cd ../..`
Expected: `apps/nrms/migrations/0002_taxonomy_cache.sql` with two `CREATE TABLE` statements.

- [ ] **Step 2: Write the failing tests**

`apps/nrms/src/taxonomy.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { EventEnvelope } from "@gcpe/events";
import { createNrmsTestDb } from "../test/helpers";
import { listCategories, ministryAbbreviation, ministryName, taxonomyHandler } from "./taxonomy";

const ev = (type: string, data: unknown, source = "core") => ({ id: crypto.randomUUID(), type, source, aggregateId: "x", sequence: 1, occurredAt: new Date().toISOString(), data }) as unknown as EventEnvelope;

describe("taxonomy cache", () => {
  let tdb: TestDatabase;
  const apply = async (e: EventEnvelope) => tdb.db.transaction(async (tx) => taxonomyHandler(e)!(tx, e));
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("ignores other sources and unrelated types", () => {
    expect(taxonomyHandler(ev("org.upserted", {}, "nrms"))).toBeUndefined();
    expect(taxonomyHandler(ev("release.published", {}))).toBeUndefined();
    expect(taxonomyHandler(ev("service.upserted", {}))).toBeUndefined();
  });

  it("upserts and deactivates ministries and categories", async () => {
    await apply(ev("org.upserted", { key: "Health", displayName: "Health", abbreviation: "HLTH", sortOrder: 2, isActive: true }));
    await apply(ev("org.upserted", { key: "finance", displayName: "Finance", abbreviation: "FIN", sortOrder: 1, isActive: true }));
    await apply(ev("sector.upserted", { kind: "sector", key: "health", displayName: "Health", sortOrder: 0, isActive: true }));
    await apply(ev("tag.upserted", { kind: "tag", key: "covid-19", displayName: null, sortOrder: 0, isActive: true }));
    expect(await ministryAbbreviation(tdb.db, "health")).toBe("HLTH");
    expect(await ministryName(tdb.db, "HEALTH")).toBe("Health");
    expect(await listCategories(tdb.db)).toEqual({
      ministries: [{ key: "finance", name: "Finance", abbreviation: "FIN" }, { key: "health", name: "Health", abbreviation: "HLTH" }],
      sectors: [{ key: "health", name: "Health" }],
      themes: [],
      tags: [{ key: "covid-19", name: "covid-19" }],
    });
    await apply(ev("org.deactivated", { key: "finance" }));
    await apply(ev("tag.deactivated", { kind: "tag", key: "covid-19" }));
    const after = await listCategories(tdb.db);
    expect(after.ministries.map((m) => m.key)).toEqual(["health"]);
    expect(after.tags).toEqual([]);
    expect(await ministryAbbreviation(tdb.db, "finance")).toBe("FIN"); // still resolvable for old releases
  });
});
```

Append to `apps/stack/src/env.test.ts`:

```ts
describe("Core → NRMS taxonomy route", () => {
  it("sends Core's org and category events to NRMS, signed with their own pair secret", () => {
    const wiring = internalEventEnv("e".repeat(40));
    const coreSubs = JSON.parse(wiring.CORE.EVENT_SUBSCRIBERS!) as { name: string; url: string; types: string[] }[];
    const toNrms = coreSubs.find((s) => s.name === "nrms")!;
    expect(toNrms.url).toBe("self:/nrms/events");
    expect(toNrms.types).toEqual(["org.upserted", "org.deactivated", "sector.upserted", "sector.deactivated", "theme.upserted", "theme.deactivated", "tag.upserted", "tag.deactivated"]);
    expect(Object.keys(JSON.parse(wiring.NRMS.EVENT_SECRETS!))).toEqual(["core"]);
  });
});
```

Append to `apps/stack/src/stack.test.ts`, inside the describe that already has an `adminToken` (read the file and pick the main shared-instance describe; mirror its helpers for authorised requests and `/stack/tick`):

```ts
  it("a ministry saved in Core shows up in NRMS's categories after a tick", async () => {
    // Use the file's existing helper for an authorised Core PUT of healthOrg (or reuse the
    // existing test that already PUTs it), then POST /stack/tick, then:
    const res = await fetch(`${inst.stackUrl}/nrms/api/categories`, { headers: { authorization: `Bearer ${inst.adminToken}` } });
    expect(res.status).toBe(200);
    expect((await res.json()).ministries).toContainEqual({ key: "health", name: "Health", abbreviation: "HLTH" });
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms/src/taxonomy.test.ts apps/stack/src/env.test.ts`
Expected: FAIL — `./taxonomy` missing; no `nrms` subscriber on Core.

- [ ] **Step 4: Implement**

`apps/nrms/src/taxonomy.ts`:

```ts
import { and, asc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { EventEnvelope, EventHandler, OrgRecord, TermRecord } from "@gcpe/events";
import { categoryTerms, organizations } from "./db/schema";

const TERM_KIND = { sector: "sectors", theme: "themes", tag: "tags" } as const;
type TermKindSingular = keyof typeof TERM_KIND;

const upsertOrg: EventHandler = async (tx, e) => {
  const o = e.data as OrgRecord;
  const row = { key: o.key.toLowerCase(), displayName: o.displayName, abbreviation: o.abbreviation, sortOrder: o.sortOrder, isActive: o.isActive };
  await tx.insert(organizations).values(row).onConflictDoUpdate({ target: organizations.key, set: row });
};
const deactivateOrg: EventHandler = async (tx, e) => {
  await tx.update(organizations).set({ isActive: false }).where(eq(organizations.key, (e.data as { key: string }).key.toLowerCase()));
};
const upsertTerm: EventHandler = async (tx, e) => {
  const t = e.data as TermRecord;
  const kind = TERM_KIND[t.kind as TermKindSingular];
  const row = { kind, key: t.key.toLowerCase(), displayName: t.displayName ?? t.key, sortOrder: t.sortOrder, isActive: t.isActive };
  await tx.insert(categoryTerms).values(row).onConflictDoUpdate({ target: [categoryTerms.kind, categoryTerms.key], set: row });
};
const deactivateTerm: EventHandler = async (tx, e) => {
  const d = e.data as { kind: TermKindSingular; key: string };
  await tx.update(categoryTerms).set({ isActive: false }).where(and(eq(categoryTerms.kind, TERM_KIND[d.kind]), eq(categoryTerms.key, d.key.toLowerCase())));
};

/** Core's org/sector/theme/tag events → the local cache. Anything else is left to the receiver ("ignored"). */
export function taxonomyHandler(event: EventEnvelope): EventHandler | undefined {
  if (event.source !== "core") return undefined;
  switch (event.type) {
    case "org.upserted":
      return upsertOrg;
    case "org.deactivated":
      return deactivateOrg;
    case "sector.upserted":
    case "theme.upserted":
    case "tag.upserted":
      return upsertTerm;
    case "sector.deactivated":
    case "theme.deactivated":
    case "tag.deactivated":
      return deactivateTerm;
    default:
      return undefined;
  }
}

export interface Categories {
  ministries: { key: string; name: string; abbreviation: string | null }[];
  sectors: { key: string; name: string }[];
  themes: { key: string; name: string }[];
  tags: { key: string; name: string }[];
}

export async function listCategories(db: DbOrTx): Promise<Categories> {
  const orgs = await db.select().from(organizations).where(eq(organizations.isActive, true)).orderBy(asc(organizations.sortOrder), asc(organizations.displayName));
  const terms = await db.select().from(categoryTerms).where(eq(categoryTerms.isActive, true)).orderBy(asc(categoryTerms.sortOrder), asc(categoryTerms.displayName));
  const of = (kind: "sectors" | "themes" | "tags") => terms.filter((t) => t.kind === kind).map((t) => ({ key: t.key, name: t.displayName }));
  return { ministries: orgs.map((o) => ({ key: o.key, name: o.displayName, abbreviation: o.abbreviation })), sectors: of("sectors"), themes: of("themes"), tags: of("tags") };
}

/** Includes inactive ministries, so an old release can still be numbered/rendered. */
export async function ministryAbbreviation(db: DbOrTx, key: string): Promise<string | null> {
  const [row] = await db.select({ a: organizations.abbreviation }).from(organizations).where(sql`${organizations.key} = ${key.toLowerCase()}`);
  return row?.a ?? null;
}

export async function ministryName(db: DbOrTx, key: string): Promise<string | null> {
  const [row] = await db.select({ n: organizations.displayName }).from(organizations).where(sql`${organizations.key} = ${key.toLowerCase()}`);
  return row?.n ?? null;
}
```

In `apps/nrms/src/app.ts`: add `eventSecrets: Record<string, string>` to the deps; import `createEventReceiver` from `@gcpe/events` and `taxonomyHandler` from `./taxonomy`; mount, **before** `loginRouter` and before any body parser, with the same comment NoD's app.ts uses:

```ts
  app.use(createEventReceiver({ db: deps.db, secrets: deps.eventSecrets, handlers: taxonomyHandler }));
```

In `apps/nrms/src/start.ts`: add `EVENT_SECRETS: eventSecretsSchema,` to `nrmsEnvSchema` (import from `@gcpe/config`) and pass `eventSecrets: parsed.EVENT_SECRETS` to `createApp`. Update every other `createApp(...)` call in NRMS tests to pass `eventSecrets: {}`.

In `apps/nrms/src/http/routes.ts`: add `import { requireAnyRole } from "@gcpe/auth";` and `import { listCategories } from "../taxonomy";`, define `const read = requireAnyRole("NRMS.Viewer", "NRMS.Editor", "NRMS.SiteEditor");` inside `apiRoutes`, and add:

```ts
  r.get("/categories", read, run(async (_req, res) => void res.json(await listCategories(db))));
```

In `apps/stack/src/env.ts`, add to `INTERNAL_EVENT_ROUTES` (after the CORE→NEWSAPI entry):

```ts
  {
    from: "CORE", source: "core", to: "NRMS", name: "nrms", url: "self:/nrms/events",
    types: ["org.upserted", "org.deactivated", "sector.upserted", "sector.deactivated", "theme.upserted", "theme.deactivated", "tag.upserted", "tag.deactivated"],
  },
```

and update the doc comment above `INTERNAL_EVENT_ROUTES` to mention that NRMS receives Core's taxonomy events.

- [ ] **Step 5: Run to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms apps/stack && npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/nrms apps/stack
git commit -m "feat(nrms): keep a local copy of Core's ministries and categories from Core events"
```

---

### Task 4: Release data model and the Phase 2 data copy

The new tables sit alongside Phase 2's `releases` table; Task 7 drops that table once nothing uses it.

**Files:**
- Modify: `apps/nrms/src/db/schema.ts`
- Create: `apps/nrms/migrations/0003_release_model.sql` (generated), `apps/nrms/migrations/0004_copy_phase2_releases.sql` (custom), `apps/nrms/src/db/migrations.test.ts`

**Interfaces:**
- Produces (Drizzle tables exported from `apps/nrms/src/db/schema.ts`): `newsReleases`, `releaseLanguages`, `releaseDocuments`, `documentLanguages`, `documentContacts`, `releaseCategories`, `releaseMediaLists`, `categoryFeatures`, `mediaLists`, `pageTypes`, `pageImages`, `pageImageLanguages`, `governmentTerms`, `numberCounters`, `releaseLog`, `releasePublications`; types `NewsReleaseRow` etc. via `$inferSelect`. Column names are exactly as below — later tasks use them.

- [ ] **Step 1: Add the tables**

In `apps/nrms/src/db/schema.ts`, extend the pg-core import to `bigserial, boolean, check, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid`, import `type { ReleaseRecord }` (already imported) and `type { Layout, ReleaseStatus, ReleaseType } from "@gcpe/nrms-contract"`, add `"@gcpe/nrms-contract": "0.0.0"` to `apps/nrms/package.json` dependencies (then `npx -y npm@11 install`), and append:

```ts
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
const tz = (name: string) => timestamp(name, { withTimezone: true });

export const governmentTerms = pgTable("government_terms", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  isCurrent: boolean("is_current").notNull().default(false),
  legacyId: uuid("legacy_id"),
}, (t) => [uniqueIndex("government_terms_one_current_idx").on(t.isCurrent).where(sql`${t.isCurrent}`)]);

export const newsReleases = pgTable(
  "news_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    legacyId: uuid("legacy_id").unique(),
    type: text("type").$type<ReleaseType>().notNull(),
    key: text("key"),
    reference: text("reference"),
    year: integer("year"),
    yearRelease: integer("year_release"),
    ministryRelease: integer("ministry_release"),
    termId: uuid("term_id").references(() => governmentTerms.id),
    leadMinistryKey: text("lead_ministry_key"),
    activityId: integer("activity_id"),
    status: text("status").$type<ReleaseStatus>().notNull().default("draft"),
    publishAt: tz("publish_at"),
    releasedAt: tz("released_at"),
    onHold: boolean("on_hold").notNull().default(false),
    toWeb: boolean("to_web").notNull().default(true),
    toSubscribers: boolean("to_subscribers").notNull().default(false),
    toMediaLists: boolean("to_media_lists").notNull().default(false),
    assetUrl: text("asset_url"),
    assetAltText: text("asset_alt_text"),
    hasMediaAssets: boolean("has_media_assets").notNull().default(false),
    hasTranslations: boolean("has_translations").notNull().default(false),
    redirectUrl: text("redirect_url"),
    keywords: text("keywords"),
    atomId: text("atom_id"),
    nodSubscribers: integer("nod_subscribers"),
    mediaSubscribers: integer("media_subscribers"),
    lastError: text("last_error"),
    version: integer("version").notNull().default(1),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("news_releases_type_key_idx").on(t.type, sql`lower(${t.key})`).where(sql`${t.key} IS NOT NULL`),
    uniqueIndex("news_releases_reference_idx").on(t.reference).where(sql`${t.reference} IS NOT NULL`),
    index("news_releases_due_idx").on(t.publishAt).where(sql`${t.status} IN ('scheduled','publishing','unpublishing')`),
    index("news_releases_status_idx").on(t.status),
    check("news_releases_type_check", sql`${t.type} IN ('release','story','factsheet','update','advisory')`),
    check("news_releases_status_check", sql`${t.status} IN ('draft','approved','scheduled','publishing','published','unpublishing','failed','deleted')`),
    check("news_releases_committed_has_time", sql`${t.status} NOT IN ('scheduled','publishing','published','unpublishing') OR ${t.publishAt} IS NOT NULL`),
  ],
);
export type NewsReleaseRow = typeof newsReleases.$inferSelect;

const releaseFk = () => uuid("release_id").notNull().references(() => newsReleases.id, { onDelete: "cascade" });

export const releaseLanguages = pgTable(
  "release_languages",
  {
    releaseId: releaseFk(),
    languageId: integer("language_id").notNull(),
    location: text("location").notNull().default(""),
    summary: text("summary").notNull().default(""),
    summaryEdited: boolean("summary_edited").notNull().default(false),
    socialMediaSummary: text("social_media_summary"),
  },
  (t) => [primaryKey({ columns: [t.releaseId, t.languageId] })],
);

export const releaseDocuments = pgTable(
  "release_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: releaseFk(),
    sortIndex: integer("sort_index").notNull(),
    layout: text("layout").$type<Layout>().notNull().default("formal"),
  },
  (t) => [index("release_documents_release_idx").on(t.releaseId, t.sortIndex)],
);

const documentFk = () => uuid("document_id").notNull().references(() => releaseDocuments.id, { onDelete: "cascade" });

export const documentLanguages = pgTable(
  "document_languages",
  {
    documentId: documentFk(),
    languageId: integer("language_id").notNull(),
    pageTitle: text("page_title").notNull(),
    headline: text("headline").notNull().default(""),
    subheadline: text("subheadline"),
    organizations: text("organizations"),
    byline: text("byline"),
    bodyHtml: text("body_html").notNull().default(""),
    pageImageId: uuid("page_image_id"),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.languageId] })],
);

export const documentContacts = pgTable(
  "document_contacts",
  {
    documentId: documentFk(),
    languageId: integer("language_id").notNull(),
    sortIndex: integer("sort_index").notNull(),
    information: text("information").notNull(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.languageId, t.sortIndex] })],
);

export const releaseCategories = pgTable(
  "release_categories",
  {
    releaseId: releaseFk(),
    kind: text("kind").$type<"ministries" | "sectors" | "themes" | "tags">().notNull(),
    key: text("key").notNull(),
  },
  (t) => [primaryKey({ columns: [t.releaseId, t.kind, t.key] }), index("release_categories_key_idx").on(t.kind, t.key)],
);

export const mediaLists = pgTable("media_lists", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  displayName: text("display_name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  legacyId: uuid("legacy_id"),
});

export const releaseMediaLists = pgTable(
  "release_media_lists",
  {
    releaseId: releaseFk(),
    mediaListId: uuid("media_list_id").notNull().references(() => mediaLists.id),
  },
  (t) => [primaryKey({ columns: [t.releaseId, t.mediaListId] })],
);

/** Top/Feature slots: kind 'home' (key 'default'), 'ministries', 'sectors', 'themes'. */
export const categoryFeatures = pgTable(
  "category_features",
  {
    kind: text("kind").$type<"home" | "ministries" | "sectors" | "themes">().notNull(),
    key: text("key").notNull(),
    topReleaseId: uuid("top_release_id").references(() => newsReleases.id, { onDelete: "set null" }),
    featureReleaseId: uuid("feature_release_id").references(() => newsReleases.id, { onDelete: "set null" }),
  },
  (t) => [primaryKey({ columns: [t.kind, t.key] })],
);

export const pageImages = pgTable("page_images", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  sortOrder: integer("sort_order").notNull().default(0),
  mimeType: text("mime_type").notNull(),
  bytes: bytea("bytes").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  legacyId: uuid("legacy_id"),
});

export const pageImageLanguages = pgTable(
  "page_image_languages",
  {
    imageId: uuid("image_id").notNull().references(() => pageImages.id, { onDelete: "cascade" }),
    languageId: integer("language_id").notNull(),
    altText: text("alt_text").notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.imageId, t.languageId] })],
);

/** Per-type, per-language page titles (legacy dbo.NewsReleaseType). */
export const pageTypes = pgTable(
  "page_types",
  {
    pageTitle: text("page_title").notNull(),
    languageId: integer("language_id").notNull(),
    releaseType: text("release_type").$type<ReleaseType>().notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    layout: text("layout").$type<Layout>().notNull().default("formal"),
    pageImageId: uuid("page_image_id").references(() => pageImages.id, { onDelete: "set null" }),
  },
  (t) => [primaryKey({ columns: [t.pageTitle, t.languageId] })],
);

/** Approve-time counters (scope 'news' | 'year' | 'ministry'); ministry '' when not per-ministry. */
export const numberCounters = pgTable(
  "number_counters",
  {
    scope: text("scope").notNull(),
    year: integer("year").notNull(),
    ministry: text("ministry").notNull().default(""),
    lastValue: integer("last_value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.year, t.ministry] })],
);

export const releaseLog = pgTable(
  "release_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    releaseId: releaseFk(),
    at: tz("at").notNull().defaultNow(),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    text: text("text").notNull(),
  },
  (t) => [index("release_log_release_idx").on(t.releaseId, t.at)],
);

export const releasePublications = pgTable(
  "release_publications",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    releaseId: releaseFk(),
    publishedAt: tz("published_at").notNull(),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    record: jsonb("record").$type<ReleaseRecord>().notNull(),
  },
  (t) => [index("release_publications_release_idx").on(t.releaseId, t.publishedAt)],
);
```

If drizzle-kit 0.31 rejects `.where()` on a `uniqueIndex` with an expression column, keep the expression and partial predicate by generating without the `.where()` and appending the partial predicate in a follow-up `--custom` migration — record that as a deviation in the report. Do not drop the partial predicate.

- [ ] **Step 2: Generate the DDL migration**

Run: `cd apps/nrms && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name release_model && cd ../..`
Expected: `0003_release_model.sql` with only `CREATE TABLE`/index/constraint statements for the new tables (the Phase 2 `releases` table untouched). Inspect it before continuing.

- [ ] **Step 3: Write the data-copy migration**

Run: `cd apps/nrms && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --custom --name copy_phase2_releases && cd ../..`, then put this in the generated `0004_copy_phase2_releases.sql`:

```sql
-- Copies Phase 2 releases (single JSON row each) into the normalised model. Phase 2 only
-- ever held English documents, so each JSON document becomes one English document here.
INSERT INTO news_releases (type, key, reference, lead_ministry_key, status, publish_at, released_at,
  to_web, to_subscribers, to_media_lists, asset_url, has_media_assets, has_translations, redirect_url,
  keywords, last_error, created_at, updated_at)
SELECT
  CASE r.kind WHEN 'releases' THEN 'release' WHEN 'stories' THEN 'story' WHEN 'factsheets' THEN 'factsheet'
              WHEN 'updates' THEN 'update' ELSE 'advisory' END,
  r.key,
  NULLIF(r.content->>'reference', ''),
  r.content->>'leadMinistryKey',
  CASE WHEN r.status = 'draft' AND NULLIF(r.content->>'reference', '') IS NOT NULL THEN 'approved' ELSE r.status END,
  COALESCE(r.publish_at, r.published_at),
  r.published_at,
  COALESCE((r.content->'publishFlags'->>'toWeb')::boolean, true),
  COALESCE((r.content->'publishFlags'->>'toSubscribers')::boolean, false),
  COALESCE((r.content->'publishFlags'->>'toMediaLists')::boolean, false),
  r.content->>'assetUrl',
  COALESCE((r.content->>'hasMediaAssets')::boolean, false),
  COALESCE((r.content->>'hasTranslations')::boolean, false),
  r.content->>'redirectUri',
  r.content->>'keywords',
  r.last_error,
  r.created_at,
  r.updated_at
FROM releases r;
--> statement-breakpoint
INSERT INTO release_languages (release_id, language_id, location, summary, summary_edited, social_media_summary)
SELECT n.id, 4105, COALESCE(r.content->>'location', ''), COALESCE(r.content->>'summary', ''), true, r.content->>'socialMediaSummary'
FROM releases r JOIN news_releases n ON n.key = r.key;
--> statement-breakpoint
INSERT INTO release_documents (id, release_id, sort_index, layout)
SELECT gen_random_uuid(), n.id, (d.ord - 1)::int, 'formal'
FROM releases r JOIN news_releases n ON n.key = r.key
CROSS JOIN LATERAL jsonb_array_elements(r.content->'documents') WITH ORDINALITY AS d(doc, ord);
--> statement-breakpoint
INSERT INTO document_languages (document_id, language_id, page_title, headline, subheadline, byline, body_html)
SELECT rd.id, 4105, COALESCE(d.doc->>'pageTitle', ''), COALESCE(d.doc->>'headline', ''), d.doc->>'subheadline', d.doc->>'byline', COALESCE(d.doc->>'detailsHtml', '')
FROM releases r JOIN news_releases n ON n.key = r.key
CROSS JOIN LATERAL jsonb_array_elements(r.content->'documents') WITH ORDINALITY AS d(doc, ord)
JOIN release_documents rd ON rd.release_id = n.id AND rd.sort_index = (d.ord - 1)::int;
--> statement-breakpoint
INSERT INTO document_contacts (document_id, language_id, sort_index, information)
SELECT rd.id, 4105, (c.ord - 1)::int, concat_ws(E'\n', NULLIF(c.contact->>'title', ''), NULLIF(c.contact->>'details', ''))
FROM releases r JOIN news_releases n ON n.key = r.key
CROSS JOIN LATERAL jsonb_array_elements(r.content->'documents') WITH ORDINALITY AS d(doc, ord)
JOIN release_documents rd ON rd.release_id = n.id AND rd.sort_index = (d.ord - 1)::int
CROSS JOIN LATERAL jsonb_array_elements(d.doc->'contacts') WITH ORDINALITY AS c(contact, ord);
--> statement-breakpoint
INSERT INTO release_categories (release_id, kind, key)
SELECT DISTINCT n.id, k.kind, lower(k.key)
FROM releases r JOIN news_releases n ON n.key = r.key
CROSS JOIN LATERAL (
  SELECT 'ministries' AS kind, jsonb_array_elements_text(r.content->'ministryKeys') AS key
  UNION ALL SELECT 'sectors', jsonb_array_elements_text(r.content->'sectorKeys')
  UNION ALL SELECT 'themes', jsonb_array_elements_text(r.content->'themeKeys')
  UNION ALL SELECT 'tags', jsonb_array_elements_text(r.content->'tagKeys')
) k;
```

- [ ] **Step 4: Write the migration test**

`apps/nrms/src/db/migrations.test.ts`:

```ts
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, type TestDatabase } from "@gcpe/db-kit";
import { createTestDatabase } from "@gcpe/db-kit";
import { nrmsMigrations } from "../../test/helpers";

/** A copy of the migrations folder whose journal stops after `lastTag`. */
async function partialMigrations(lastTag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nrms-mig-"));
  await cp(nrmsMigrations, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === lastTag) + 1);
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
}

describe("Phase 2 → release model data copy", () => {
  let tdb: TestDatabase;
  let partial: string;
  beforeAll(async () => {
    partial = await partialMigrations("0002_taxonomy_cache");
    tdb = await createTestDatabase({ migrationsFolder: partial });
  });
  afterAll(async () => {
    await tdb.drop();
    await rm(partial, { recursive: true, force: true });
  });

  it("copies a Phase 2 release, its document, contacts and categories", async () => {
    const content = {
      reference: "NEWS-00001", leadMinistryKey: "health", summary: "Clinics open.", socialMediaSummary: null, socialMediaHeadline: null,
      keywords: null, location: "VICTORIA", hasMediaAssets: false, hasTranslations: false, isNewsOnDemand: true, assetUrl: null, redirectUri: null,
      documents: [{ pageTitle: "Weekend clinics", languageId: 4105, headline: "Weekend clinics open", subheadline: null, detailsHtml: "<p>Body</p>", byline: null,
        contacts: [{ title: "Media Relations", details: "Alex Example\n250-555-0100" }] }],
      ministryKeys: ["health"], sectorKeys: ["Health"], tagKeys: [], themeKeys: [], assets: null, translations: null,
      publishFlags: { toWeb: true, toSubscribers: true, toMediaLists: false }, mediaListKeys: [],
    };
    await tdb.pool.query(
      `INSERT INTO releases (key, kind, status, publish_at, published_at, content) VALUES ($1, 'releases', 'published', now(), now(), $2)`,
      ["2026HLTH0001-000001", JSON.stringify(content)],
    );
    await runMigrations(tdb.db, nrmsMigrations);
    const q = async (text: string) => (await tdb.pool.query(text)).rows;
    expect(await q(`SELECT type, key, reference, status, to_subscribers FROM news_releases`)).toEqual([
      { type: "release", key: "2026HLTH0001-000001", reference: "NEWS-00001", status: "published", to_subscribers: true },
    ]);
    expect(await q(`SELECT location, summary, summary_edited FROM release_languages`)).toEqual([{ location: "VICTORIA", summary: "Clinics open.", summary_edited: true }]);
    expect(await q(`SELECT headline, body_html FROM document_languages`)).toEqual([{ headline: "Weekend clinics open", body_html: "<p>Body</p>" }]);
    expect(await q(`SELECT information FROM document_contacts`)).toEqual([{ information: "Media Relations\nAlex Example\n250-555-0100" }]);
    expect(await q(`SELECT kind, key FROM release_categories ORDER BY kind`)).toEqual([{ kind: "ministries", key: "health" }, { kind: "sectors", key: "health" }]);
  });
});
```

(Drop the unused `pg`/`createDb` imports if your editor flags them.)

- [ ] **Step 5: Run to verify it passes**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms && npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: PASS (the existing Phase 2 NRMS tests still pass — the old table and code are untouched).

- [ ] **Step 6: Commit**

```bash
git add apps/nrms package-lock.json
git commit -m "feat(nrms): normalised release model alongside Phase 2's table, with a data copy migration"
```

---
### Task 5: Release store and editing service

**Files:**
- Create: `apps/nrms/src/releases/errors.ts`, `apps/nrms/src/releases/store.ts`, `apps/nrms/src/releases/keys.ts`, `apps/nrms/src/releases/service.ts`, `apps/nrms/src/releases/service.test.ts`
- Modify: `apps/nrms/test/helpers.ts` (add taxonomy/media-list seeding)

**Interfaces:**
- Consumes: Task 1 contract (types, `typeRules`, `assetUrlProblem`, schemas' input types), Task 2 (`sanitizeBodyHtml`, `generateSlug`, `summaryFromBody`), Task 3 (`organizations`, `categoryTerms`), Task 4 tables.
- Produces:
  - `errors.ts`: `ReleaseNotFoundError`, `VersionConflictError`, `ReleaseStateError(message)`, `ReleaseRuleError(problems: string[])` (`.problems`), `ReleaseTooLargeError`
  - `store.ts`: `interface Actor { id: string; name: string }`, `SYSTEM_ACTOR = { id: "system", name: "System" }`, `loadView(db: DbOrTx, id: string): Promise<ReleaseView | null>`, `mutateRelease(db: Db, id: string, expectedVersion: number, actor: Actor, change: (tx: Tx, row: NewsReleaseRow) => Promise<string | null>, opts?: { correction?: boolean }): Promise<ReleaseView>`, `writeLog(tx: DbOrTx, releaseId: string, actor: Actor, text: string): Promise<void>`
  - `keys.ts`: `uniqueKey(tx: DbOrTx, type: ReleaseType, base: string, excludeId: string | null): Promise<string>`
  - `service.ts`: `createRelease(db, input: CreateReleaseInput, actor): Promise<ReleaseView>`, `saveSettings(db, id, input: SettingsInput, actor)`, `saveCategories(db, id, input: CategoriesInput, actor)`, `saveAsset(db, id, input: AssetInput, actor)`, `saveMeta(db, id, input: MetaInput, actor)`, `saveDocumentLanguage(db, id, documentId, languageId: LanguageId, input: DocumentLanguageInput, actor)`, `addDocument(db, id, input, actor)`, `addTranslation(db, id, documentId, input, actor)`, `removeDocument(db, id, documentId, version, actor)`, `removeTranslation(db, id, documentId, languageId, version, actor)`, `reorderDocuments(db, id, input, actor)`, `deleteRelease(db, id, version, actor): Promise<"deleted" | "hidden">` — every save returns the updated `ReleaseView`
  - `test/helpers.ts`: `seedTaxonomy(db)` (ministries `health`/HLTH and `finance`/FIN, sectors `health` and `education`, theme `families`, tag `covid-19`, media lists `regional`, `national`), `sampleCreate: CreateReleaseInput`, `editor: Actor`

**Rules this task enforces** (spec §4; each has a test):
- Every save locks the row (`SELECT … FOR UPDATE`), checks `version` (else `VersionConflictError`), bumps `version`, and writes one log line. Saving a `published` release moves it to `publishing` and logs "Edited after publishing — will republish" (a correction). Saving while `publishing` keeps `publishing`. A `deleted` release is "not found".
- Category, ministry and media-list keys must exist in the local cache (inactive allowed); unknown → `ReleaseRuleError(["Unknown sector: x"])`. Lead ministry must be one of the ministries; with exactly one ministry and no lead, that ministry becomes lead.
- Advisories: no sectors/themes/tags, no page image, no asset, no summary/keywords/social summary. Story/Update: no media lists. Media lists of a Release/Factsheet can't change once `releasedAt` is set (`ReleaseStateError`). `toMediaLists` = media lists non-empty. `toSubscribers` may be true only when `typeRules(type).nodAllowed` (an imported Update keeps whatever it had).
- Body HTML is sanitised on every save. On the first document's English language, unless `summaryEdited`, the English summary becomes `summaryFromBody(body)`; and for key-editable types still in `draft`/`approved`, a changed headline regenerates the key via `uniqueKey(generateSlug(headline))`.
- Meta: a changed `key` is accepted only for key-editable types in `draft`/`approved` (slugified then made unique; else `ReleaseStateError`). A summary different from the stored one sets `summaryEdited = true`.
- Layout can change only on a document that has no translation. Formal keeps `organizations` and clears `byline`; informal the reverse.
- Planned publish time (`settings.plannedPublishAt`) is only accepted in `draft`/`approved`/`failed`.
- Delete: only `draft`/`approved`/`failed`. No reference → row deleted (`"deleted"`); reference → status `deleted` + log "Deleted Release" (`"hidden"`).
- Removing the English language of a document removes the document; at least one document must remain. Removing the last French translation also removes the French release-language row.

- [ ] **Step 1: Test helpers**

Append to `apps/nrms/test/helpers.ts`:

```ts
import type { Db } from "@gcpe/db-kit";
import type { CreateReleaseInput } from "@gcpe/nrms-contract";
import { categoryTerms, mediaLists, organizations } from "../src/db/schema";
import type { Actor } from "../src/releases/store";

export const editor: Actor = { id: "00000000-0000-4000-8000-0000000000e1", name: "Test Editor" };

export async function seedTaxonomy(db: Db): Promise<void> {
  await db.insert(organizations).values([
    { key: "health", displayName: "Health", abbreviation: "HLTH", sortOrder: 1 },
    { key: "finance", displayName: "Finance", abbreviation: "FIN", sortOrder: 2 },
  ]).onConflictDoNothing();
  await db.insert(categoryTerms).values([
    { kind: "sectors", key: "health", displayName: "Health" },
    { kind: "sectors", key: "education", displayName: "Education" },
    { kind: "themes", key: "families", displayName: "Families" },
    { kind: "tags", key: "covid-19", displayName: "COVID-19" },
  ]).onConflictDoNothing();
  await db.insert(mediaLists).values([
    { key: "regional", displayName: "Regional media", sortOrder: 1 },
    { key: "national", displayName: "National media", sortOrder: 2 },
  ]).onConflictDoNothing();
}

export const sampleCreate: CreateReleaseInput = {
  type: "release", pageTitle: "News Release", layout: "formal", pageImageId: null,
  headline: "Weekend clinics open across B.C.", subheadline: null, organizations: "Ministry of Health", byline: null,
  bodyHtml: "<p>Clinics will open on weekends starting in November.</p><p>More detail.</p>", location: "Victoria",
  contacts: ["Media Relations\nMinistry of Health\n250-555-0100"],
  ministries: ["health"], leadMinistryKey: "health", sectors: ["health"], themes: [], tags: [], mediaListKeys: [], activityId: null, publishAt: null,
};
```

(Keep the file's existing exports; Phase 2's `sampleDraft` stays until Task 7.)

- [ ] **Step 2: Write the failing tests**

`apps/nrms/src/releases/service.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNrmsTestDb, editor, sampleCreate, seedTaxonomy } from "../../test/helpers";
import { ReleaseNotFoundError, ReleaseRuleError, ReleaseStateError, VersionConflictError } from "./errors";
import {
  addDocument, addTranslation, createRelease, deleteRelease, removeDocument, removeTranslation, reorderDocuments,
  saveAsset, saveCategories, saveDocumentLanguage, saveMeta, saveSettings,
} from "./service";
import { loadView } from "./store";

describe("release editing service", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
  });
  afterAll(async () => {
    await tdb.drop();
  });
  const db = () => tdb.db;
  const doc0 = (v: Awaited<ReturnType<typeof createRelease>>) => v.documents[0]!;
  const setStatus = (id: string, status: string, extra = sql``) => tdb.db.execute(sql`UPDATE news_releases SET status = ${status}, publish_at = coalesce(publish_at, now()) ${extra} WHERE id = ${id}`);

  it("creates a release with legacy defaults, a sanitised body and an auto summary", async () => {
    const v = await createRelease(db(), { ...sampleCreate, bodyHtml: '<p onclick="x">Clinics <b>open</b>.</p><script>bad()</script>' }, editor);
    expect(v).toMatchObject({ type: "release", key: null, reference: null, status: "draft", version: 1, leadMinistryKey: "health", publishOptions: { toWeb: true, toSubscribers: true, toMediaLists: false } });
    expect(doc0(v).languages[0]).toMatchObject({ languageId: 4105, headline: "Weekend clinics open across B.C.", bodyHtml: "<p>Clinics <strong>open</strong>.</p>", contacts: ["Media Relations\nMinistry of Health\n250-555-0100"] });
    expect(v.languages[0]).toMatchObject({ languageId: 4105, location: "Victoria", summary: "Clinics open.", summaryEdited: false });
  });

  it("stories get a unique slug key from the headline", async () => {
    const a = await createRelease(db(), { ...sampleCreate, type: "story", headline: "Métis artists honoured" }, editor);
    const b = await createRelease(db(), { ...sampleCreate, type: "story", headline: "Métis artists honoured" }, editor);
    const c = await createRelease(db(), { ...sampleCreate, type: "story", headline: "中文" }, editor);
    expect([a.key, b.key]).toEqual(["metis-artists-honoured", "metis-artists-honoured-1"]);
    expect(c.key).toMatch(/^release-[0-9a-f]{8}$/);
    expect(a.publishOptions.toSubscribers).toBe(false);
  });

  it("rejects unknown categories and per-type violations", async () => {
    await expect(createRelease(db(), { ...sampleCreate, sectors: ["nope"] }, editor)).rejects.toEqual(new ReleaseRuleError(["Unknown sector: nope"]));
    await expect(createRelease(db(), { ...sampleCreate, type: "advisory", sectors: ["health"], mediaListKeys: ["regional"] }, editor)).rejects.toBeInstanceOf(ReleaseRuleError);
    await expect(createRelease(db(), { ...sampleCreate, type: "story", mediaListKeys: ["regional"] }, editor)).rejects.toBeInstanceOf(ReleaseRuleError);
    await expect(createRelease(db(), { ...sampleCreate, leadMinistryKey: "finance" }, editor)).rejects.toEqual(new ReleaseRuleError(["The lead ministry must be one of the selected ministries."]));
    const adv = await createRelease(db(), { ...sampleCreate, type: "advisory", sectors: [], mediaListKeys: ["regional"] }, editor);
    expect(adv.publishOptions).toEqual({ toWeb: false, toSubscribers: false, toMediaLists: true });
    expect(adv.mediaListKeys).toEqual(["regional"]);
  });

  it("checks the version and bumps it on every save", async () => {
    const v = await createRelease(db(), sampleCreate, editor);
    await expect(saveCategories(db(), v.id, { version: 99, leadMinistryKey: "health", ministries: ["health"], sectors: ["health"], themes: [], tags: [] }, editor)).rejects.toBeInstanceOf(VersionConflictError);
    const v2 = await saveCategories(db(), v.id, { version: 1, leadMinistryKey: null, ministries: ["health"], sectors: ["health", "education"], themes: ["families"], tags: ["covid-19"] }, editor);
    expect(v2).toMatchObject({ version: 2, leadMinistryKey: "health", sectors: ["education", "health"], themes: ["families"], tags: ["covid-19"] });
    await expect(saveCategories(db(), "00000000-0000-4000-8000-000000000000", { version: 1, leadMinistryKey: null, ministries: [], sectors: [], themes: [], tags: [] }, editor)).rejects.toBeInstanceOf(ReleaseNotFoundError);
  });

  it("document saves: sanitise, regenerate summary until hand-edited, layout clears the other field", async () => {
    const v = await createRelease(db(), sampleCreate, editor);
    const d = doc0(v);
    const base = { pageTitle: "News Release", layout: "formal" as const, headline: "New headline", subheadline: null, organizations: "Ministry of Health", byline: "ignored", bodyHtml: "<p>Fresh lede.</p>", pageImageId: null, contacts: ["Media Relations"] };
    const v2 = await saveDocumentLanguage(db(), v.id, d.id, 4105, { ...base, version: 1 }, editor);
    expect(v2.languages[0]!.summary).toBe("Fresh lede.");
    expect(doc0(v2).languages[0]).toMatchObject({ byline: null, organizations: "Ministry of Health" });
    const v3 = await saveMeta(db(), v.id, { version: 2, key: null, redirectUrl: null, location: "Victoria", summary: "My own summary.", socialMediaSummary: null, keywords: null }, editor);
    expect(v3.languages[0]).toMatchObject({ summary: "My own summary.", summaryEdited: true });
    const v4 = await saveDocumentLanguage(db(), v.id, d.id, 4105, { ...base, version: 3, bodyHtml: "<p>Another lede.</p>" }, editor);
    expect(v4.languages[0]!.summary).toBe("My own summary.");
  });

  it("translations, documents, ordering and layout locking", async () => {
    let v = await createRelease(db(), sampleCreate, editor);
    v = await addTranslation(db(), v.id, doc0(v).id, { version: v.version, languageId: 3084 }, editor);
    expect(doc0(v).languages.map((l) => l.languageId)).toEqual([4105, 3084]);
    expect(v.languages.map((l) => l.languageId)).toEqual([4105, 3084]);
    await expect(saveDocumentLanguage(db(), v.id, doc0(v).id, 4105, { version: v.version, pageTitle: "News Release", layout: "informal", headline: "H", subheadline: null, organizations: null, byline: "B", bodyHtml: "<p>x</p>", pageImageId: null, contacts: [] }, editor)).rejects.toBeInstanceOf(ReleaseStateError);
    v = await addDocument(db(), v.id, { version: v.version, pageTitle: "Backgrounder", layout: "formal" }, editor);
    expect(v.documents.map((d) => d.sortIndex)).toEqual([0, 1]);
    const [first, second] = v.documents;
    v = await reorderDocuments(db(), v.id, { version: v.version, documentIds: [second!.id, first!.id] }, editor);
    expect(v.documents[0]!.id).toBe(second!.id);
    v = await removeTranslation(db(), v.id, first!.id, 3084, v.version, editor);
    expect(v.languages.map((l) => l.languageId)).toEqual([4105]);
    v = await removeDocument(db(), v.id, second!.id, v.version, editor);
    expect(v.documents).toHaveLength(1);
    await expect(removeDocument(db(), v.id, v.documents[0]!.id, v.version, editor)).rejects.toBeInstanceOf(ReleaseStateError);
  });

  it("asset, settings and media-list rules", async () => {
    let v = await createRelease(db(), { ...sampleCreate, mediaListKeys: ["regional"] }, editor);
    await expect(saveAsset(db(), v.id, { version: v.version, assetUrl: "https://facebook.com/x", assetAltText: null, hasMediaAssets: false }, editor)).rejects.toEqual(new ReleaseRuleError(["Facebook is no longer supported due to privacy concerns. Use YouTube or Flickr URLs instead."]));
    v = await saveAsset(db(), v.id, { version: v.version, assetUrl: "https://youtu.be/abc", assetAltText: "Video", hasMediaAssets: true }, editor);
    expect(v.assetUrl).toBe("https://youtu.be/abc");
    v = await saveSettings(db(), v.id, { version: v.version, activityId: 4521, plannedPublishAt: "2026-11-02T17:00:00Z", toSubscribers: false, toMediaLists: true, mediaListKeys: [] }, editor);
    expect(v).toMatchObject({ activityId: 4521, publishAt: "2026-11-02T17:00:00.000Z", publishOptions: { toSubscribers: false, toMediaLists: false }, mediaListKeys: [] });
    await setStatus(v.id, "published", sql`, released_at = now()`);
    const live = (await loadView(db(), v.id))!;
    await expect(saveSettings(db(), v.id, { version: live.version, activityId: null, plannedPublishAt: null, toSubscribers: false, toMediaLists: true, mediaListKeys: ["national"] }, editor)).rejects.toBeInstanceOf(ReleaseStateError);
  });

  it("an edit to a published release becomes a correction; edits while publishing stay publishing", async () => {
    const v = await createRelease(db(), sampleCreate, editor);
    await setStatus(v.id, "published", sql`, released_at = now()`);
    const live = (await loadView(db(), v.id))!;
    const c1 = await saveCategories(db(), v.id, { version: live.version, leadMinistryKey: "health", ministries: ["health"], sectors: ["education"], themes: [], tags: [] }, editor);
    expect(c1.status).toBe("publishing");
    const c2 = await saveCategories(db(), v.id, { version: c1.version, leadMinistryKey: "health", ministries: ["health"], sectors: ["health"], themes: [], tags: [] }, editor);
    expect(c2.status).toBe("publishing");
    const log = await tdb.db.execute<{ text: string }>(sql`SELECT text FROM release_log WHERE release_id = ${v.id} ORDER BY id`);
    expect(log.rows.map((r) => r.text)).toContain("Edited after publishing — will republish");
  });

  it("delete: permanent without a reference, hidden with one, refused once scheduled", async () => {
    const a = await createRelease(db(), sampleCreate, editor);
    expect(await deleteRelease(db(), a.id, a.version, editor)).toBe("deleted");
    expect(await loadView(db(), a.id)).toBeNull();
    const b = await createRelease(db(), sampleCreate, editor);
    await tdb.db.execute(sql`UPDATE news_releases SET reference = 'NEWS-99999', status = 'approved' WHERE id = ${b.id}`);
    expect(await deleteRelease(db(), b.id, b.version, editor)).toBe("hidden");
    await expect(saveCategories(db(), b.id, { version: b.version + 1, leadMinistryKey: null, ministries: [], sectors: [], themes: [], tags: [] }, editor)).rejects.toBeInstanceOf(ReleaseNotFoundError);
    const c = await createRelease(db(), sampleCreate, editor);
    await setStatus(c.id, "scheduled");
    await expect(deleteRelease(db(), c.id, c.version, editor)).rejects.toBeInstanceOf(ReleaseStateError);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms/src/releases`
Expected: FAIL — modules missing.

- [ ] **Step 4: Implement errors, store and keys**

`apps/nrms/src/releases/errors.ts`:

```ts
export class ReleaseNotFoundError extends Error {}
export class VersionConflictError extends Error {
  constructor() {
    super("Someone else changed this release — reload to see their changes");
  }
}
/** The action isn't allowed in the release's current state (HTTP 409). */
export class ReleaseStateError extends Error {}
/** Business-rule problems the editor can fix (HTTP 422). */
export class ReleaseRuleError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(" "));
  }
}
export class ReleaseTooLargeError extends Error {}
```

`apps/nrms/src/releases/store.ts`:

```ts
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import { LANG_EN, type CategoryKind, type LanguageId, type ReleaseView } from "@gcpe/nrms-contract";
import {
  documentContacts, documentLanguages, mediaLists, newsReleases, releaseCategories, releaseDocuments, releaseLanguages, releaseLog, releaseMediaLists,
  type NewsReleaseRow,
} from "../db/schema";
import { ReleaseNotFoundError, VersionConflictError } from "./errors";

export interface Actor {
  id: string;
  name: string;
}
export const SYSTEM_ACTOR: Actor = { id: "system", name: "System" };

const isUuid = (id: string) => z.string().uuid().safeParse(id).success;
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const langOrder = (a: number, b: number) => (a === LANG_EN ? -1 : b === LANG_EN ? 1 : a - b);

/** The whole release as the API and renditions see it. Deleted releases still load (callers decide). */
export async function loadView(db: DbOrTx, id: string): Promise<ReleaseView | null> {
  if (!isUuid(id)) return null;
  const [r] = await db.select().from(newsReleases).where(eq(newsReleases.id, id));
  if (!r) return null;
  const langs = await db.select().from(releaseLanguages).where(eq(releaseLanguages.releaseId, id));
  const docs = await db.select().from(releaseDocuments).where(eq(releaseDocuments.releaseId, id)).orderBy(asc(releaseDocuments.sortIndex));
  const docIds = docs.map((d) => d.id);
  const dls = docIds.length ? await db.select().from(documentLanguages).where(inArray(documentLanguages.documentId, docIds)) : [];
  const contacts = docIds.length
    ? await db.select().from(documentContacts).where(inArray(documentContacts.documentId, docIds)).orderBy(asc(documentContacts.sortIndex))
    : [];
  const cats = await db.select().from(releaseCategories).where(eq(releaseCategories.releaseId, id)).orderBy(asc(releaseCategories.key));
  const lists = await db
    .select({ key: mediaLists.key })
    .from(releaseMediaLists)
    .innerJoin(mediaLists, eq(mediaLists.id, releaseMediaLists.mediaListId))
    .where(eq(releaseMediaLists.releaseId, id))
    .orderBy(asc(mediaLists.sortOrder), asc(mediaLists.key));
  const cat = (kind: CategoryKind) => cats.filter((c) => c.kind === kind).map((c) => c.key);
  return {
    id: r.id, type: r.type, key: r.key, reference: r.reference, status: r.status, onHold: r.onHold, version: r.version,
    leadMinistryKey: r.leadMinistryKey, activityId: r.activityId, publishAt: iso(r.publishAt), releasedAt: iso(r.releasedAt),
    publishOptions: { toWeb: r.toWeb, toSubscribers: r.toSubscribers, toMediaLists: r.toMediaLists },
    assetUrl: r.assetUrl, assetAltText: r.assetAltText, hasMediaAssets: r.hasMediaAssets, hasTranslations: r.hasTranslations,
    redirectUrl: r.redirectUrl, keywords: r.keywords, atomId: r.atomId, nodSubscribers: r.nodSubscribers, mediaSubscribers: r.mediaSubscribers, lastError: r.lastError,
    languages: langs
      .sort((a, b) => langOrder(a.languageId, b.languageId))
      .map((l) => ({ languageId: l.languageId as LanguageId, location: l.location, summary: l.summary, summaryEdited: l.summaryEdited, socialMediaSummary: l.socialMediaSummary })),
    documents: docs.map((d) => ({
      id: d.id,
      sortIndex: d.sortIndex,
      layout: d.layout,
      languages: dls
        .filter((l) => l.documentId === d.id)
        .sort((a, b) => langOrder(a.languageId, b.languageId))
        .map((l) => ({
          languageId: l.languageId as LanguageId, pageTitle: l.pageTitle, headline: l.headline, subheadline: l.subheadline,
          organizations: l.organizations, byline: l.byline, bodyHtml: l.bodyHtml, pageImageId: l.pageImageId,
          contacts: contacts.filter((c) => c.documentId === d.id && c.languageId === l.languageId).map((c) => c.information),
        })),
    })),
    ministries: cat("ministries"), sectors: cat("sectors"), themes: cat("themes"), tags: cat("tags"), mediaListKeys: lists.map((l) => l.key),
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

export async function writeLog(tx: DbOrTx, releaseId: string, actor: Actor, text: string): Promise<void> {
  await tx.insert(releaseLog).values({ releaseId, actorId: actor.id, actorName: actor.name, text: text.slice(0, 500) });
}

/**
 * Every edit goes through here: row lock, version check, the change, version bump, one log
 * line, and — when the release is live — the correction transition (published → publishing).
 */
export async function mutateRelease(
  db: Db,
  id: string,
  expectedVersion: number,
  actor: Actor,
  change: (tx: Tx, row: NewsReleaseRow) => Promise<string | null>,
  opts: { correction?: boolean } = {},
): Promise<ReleaseView> {
  if (!isUuid(id)) throw new ReleaseNotFoundError(id);
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(newsReleases).where(eq(newsReleases.id, id)).for("update");
    if (!row || row.status === "deleted") throw new ReleaseNotFoundError(id);
    if (row.version !== expectedVersion) throw new VersionConflictError();
    const text = await change(tx, row);
    const correction = (opts.correction ?? true) && row.status === "published";
    await tx
      .update(newsReleases)
      .set({ version: row.version + 1, updatedAt: sql`now()`, ...(correction ? { status: "publishing" as const } : {}) })
      .where(and(eq(newsReleases.id, id)));
    if (text) await writeLog(tx, id, actor, text);
    if (correction) await writeLog(tx, id, actor, "Edited after publishing — will republish");
    return (await loadView(tx, id))!;
  });
}
```

Note: if the `change` callback itself sets `status` (e.g. delete → `deleted`), the trailing update above must not overwrite it — it only sets `status` for corrections, and corrections are disabled (`correction: false`) for every workflow action.

`apps/nrms/src/releases/keys.ts`:

```ts
import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { ReleaseType } from "@gcpe/nrms-contract";
import { newsReleases } from "../db/schema";

/** `base`, else `base-1`, `base-2`, … — unique per type, case-insensitively. Blank → `release-<8 hex>`. */
export async function uniqueKey(tx: DbOrTx, type: ReleaseType, base: string, excludeId: string | null): Promise<string> {
  const stem = base || `release-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? stem : `${stem}-${n}`;
    const [hit] = await tx
      .select({ id: newsReleases.id })
      .from(newsReleases)
      .where(and(eq(newsReleases.type, type), sql`lower(${newsReleases.key}) = lower(${candidate})`, excludeId ? ne(newsReleases.id, excludeId) : undefined));
    if (!hit) return candidate;
  }
}
```

- [ ] **Step 5: Implement the service**

`apps/nrms/src/releases/service.ts` — implement every function in the Interfaces list, following "Rules this task enforces" above. Required building blocks (write them as private helpers in this file):

```ts
import { and, eq, inArray, max, sql } from "drizzle-orm";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import {
  assetUrlProblem, LANG_EN, LANG_FR, TYPE_LABEL, typeRules,
  type AssetInput, type CategoriesInput, type CreateReleaseInput, type DocumentLanguageInput, type LanguageId, type MetaInput, type ReleaseType, type ReleaseView, type SettingsInput,
} from "@gcpe/nrms-contract";
import {
  categoryTerms, documentContacts, documentLanguages, mediaLists, newsReleases, organizations, releaseCategories, releaseDocuments, releaseLanguages, releaseMediaLists,
} from "../db/schema";
import { sanitizeBodyHtml } from "../text/sanitize";
import { generateSlug } from "../text/slug";
import { summaryFromBody } from "../text/plain";
import { ReleaseRuleError, ReleaseStateError } from "./errors";
import { uniqueKey } from "./keys";
import { loadView, mutateRelease, writeLog, type Actor } from "./store";

const EDITABLE_KEY_STATUSES = new Set(["draft", "approved"]);
const SINGULAR = { ministries: "ministry", sectors: "sector", themes: "theme", tags: "tag" } as const;

/** Unknown keys (not in the local cache at all) → ReleaseRuleError. Inactive keys are allowed. */
async function assertKnownCategories(tx: DbOrTx, c: { ministries: string[]; sectors: string[]; themes: string[]; tags: string[] }): Promise<void> {
  const problems: string[] = [];
  if (c.ministries.length) {
    const found = new Set((await tx.select({ k: organizations.key }).from(organizations).where(inArray(organizations.key, c.ministries))).map((r) => r.k));
    for (const k of c.ministries) if (!found.has(k)) problems.push(`Unknown ministry: ${k}`);
  }
  for (const kind of ["sectors", "themes", "tags"] as const) {
    if (!c[kind].length) continue;
    const found = new Set((await tx.select({ k: categoryTerms.key }).from(categoryTerms).where(and(eq(categoryTerms.kind, kind), inArray(categoryTerms.key, c[kind])))).map((r) => r.k));
    for (const k of c[kind]) if (!found.has(k)) problems.push(`Unknown ${SINGULAR[kind]}: ${k}`);
  }
  if (problems.length) throw new ReleaseRuleError(problems);
}

async function mediaListIds(tx: DbOrTx, keys: string[]): Promise<string[]> {
  if (!keys.length) return [];
  const rows = await tx.select({ id: mediaLists.id, key: mediaLists.key }).from(mediaLists).where(inArray(mediaLists.key, keys));
  const missing = keys.filter((k) => !rows.some((r) => r.key === k));
  if (missing.length) throw new ReleaseRuleError(missing.map((k) => `Unknown media distribution list: ${k}`));
  return rows.map((r) => r.id);
}

async function replaceCategories(tx: Tx, releaseId: string, c: { ministries: string[]; sectors: string[]; themes: string[]; tags: string[] }): Promise<void> {
  await tx.delete(releaseCategories).where(eq(releaseCategories.releaseId, releaseId));
  const rows = (["ministries", "sectors", "themes", "tags"] as const).flatMap((kind) => c[kind].map((key) => ({ releaseId, kind, key })));
  if (rows.length) await tx.insert(releaseCategories).values(rows);
}

async function replaceMediaLists(tx: Tx, releaseId: string, ids: string[]): Promise<void> {
  await tx.delete(releaseMediaLists).where(eq(releaseMediaLists.releaseId, releaseId));
  if (ids.length) await tx.insert(releaseMediaLists).values(ids.map((mediaListId) => ({ releaseId, mediaListId })));
}

async function replaceContacts(tx: Tx, documentId: string, languageId: number, contacts: string[]): Promise<void> {
  await tx.delete(documentContacts).where(and(eq(documentContacts.documentId, documentId), eq(documentContacts.languageId, languageId)));
  const rows = contacts.map((information, sortIndex) => ({ documentId, languageId, sortIndex, information })).filter((r) => r.information.trim() !== "");
  if (rows.length) await tx.insert(documentContacts).values(rows.map((r, i) => ({ ...r, sortIndex: i })));
}

function leadOf(lead: string | null, ministries: string[]): string | null {
  if (lead && !ministries.includes(lead)) throw new ReleaseRuleError(["The lead ministry must be one of the selected ministries."]);
  return lead ?? (ministries.length === 1 ? ministries[0]! : null);
}

function assertTypeAllows(type: ReleaseType, x: { sectors?: string[]; themes?: string[]; tags?: string[]; mediaListKeys?: string[]; pageImageId?: string | null }): void {
  const r = typeRules(type);
  const p: string[] = [];
  if (!r.categoriesBeyondMinistries && ((x.sectors?.length ?? 0) || (x.themes?.length ?? 0) || (x.tags?.length ?? 0))) p.push(`A ${TYPE_LABEL[type]} has no sectors, themes or tags.`);
  if (!r.mediaListsAllowed && (x.mediaListKeys?.length ?? 0)) p.push(`A ${TYPE_LABEL[type]} has no media distribution lists.`);
  if (!r.pageImageAllowed && x.pageImageId) p.push(`A ${TYPE_LABEL[type]} has no page image.`);
  if (p.length) throw new ReleaseRuleError(p);
}
```

`createRelease` (one transaction): `assertTypeAllows`; `assertKnownCategories`; `lead = leadOf(...)`; media list ids; `key = typeRules(type).keyEditable ? await uniqueKey(tx, type, generateSlug(headline), null) : null`; insert `news_releases` with `typeRules(type).defaultPublishOptions(mediaListKeys.length > 0)`, `activityId`, `publishAt: input.publishAt ? new Date(input.publishAt) : null`; insert the English `release_languages` row (`location`, `summary: summaryFromBody(body)`, `summaryEdited: false`); insert document `sortIndex 0`, `layout`, and its English `document_languages` row (`pageTitle`, `headline`, `subheadline`, `organizations` only if formal else null, `byline` only if informal else null, `bodyHtml: sanitizeBodyHtml(input.bodyHtml)`, `pageImageId`); `replaceContacts`; `replaceCategories`; `replaceMediaLists`; `writeLog(tx, id, actor, \`Created ${TYPE_LABEL[type]}\`)`. A unique-key violation (`cause.code === "23505"`) becomes `ReleaseStateError("That URL key is already in use — try again.")`. Return `loadView`.

Each section save is `mutateRelease(db, id, input.version, actor, async (tx, row) => { …; return "<log text>"; })` with these log texts: settings → `"Updated publish settings"`, categories → `"Updated categories"`, asset → `"Updated media asset"`, meta → `"Updated page details"`, document language → `` `Edited document ${sortIndex + 1} (${lang === LANG_EN ? "English" : "French"})` ``, add document → `"Added a document"`, add translation → `"Added a French translation"`, remove document → `"Removed a document"`, remove translation → `"Removed a translation"`, reorder → `"Reordered documents"`. `deleteRelease` uses `mutateRelease(..., { correction: false })` and returns which path it took (for the hard delete, delete the row inside the same transaction after the checks and skip the log — the row is gone).

- [ ] **Step 6: Run to verify it passes**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms && npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/nrms
git commit -m "feat(nrms): release store and editing service with legacy rules and optimistic concurrency"
```

---
### Task 6: Approve, schedule, cancel and unpublish

**Files:**
- Create: `apps/nrms/src/releases/numbering.ts`, `apps/nrms/src/releases/workflow.ts`, `apps/nrms/src/releases/record.ts`, `apps/nrms/src/releases/workflow.test.ts`, `apps/nrms/src/releases/record.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5 (`approveProblems`, `publishProblems`, `typeRules`, `POST_KIND`, `TYPE_LABEL`, `mutateRelease`, `loadView`, errors, `ministryAbbreviation`, `governmentTerms`, `numberCounters`).
- Produces:
  - `numbering.ts`: `bcYear(at: Date, timeZone: string): number`; `nextCounter(tx: DbOrTx, scope: "news" | "year" | "ministry", year: number, ministry: string): Promise<number>`; `pad(n: number, width: number): string`
  - `record.ts`: `splitContact(information: string): { title: string; details: string }`; `toReleaseRecord(v: ReleaseView, at: { publishDate: string; timestamp: string }): ReleaseRecord`; `assertPublishable(record: ReleaseRecord): void` (throws `ReleaseTooLargeError` when the `release.published` envelope would exceed `MAX_EVENT_BYTES`)
  - `workflow.ts`: `interface WorkflowDeps { timeZone: string; countSubscribers?: (listKeys: string[]) => Promise<number> }`; `approve(db, id, version, actor, deps): Promise<ReleaseView>`; `schedule(db, id, input: ScheduleInput, actor, deps): Promise<ReleaseView>`; `cancel(db, id, version, actor): Promise<ReleaseView>`; `unpublish(db, id, version, actor): Promise<ReleaseView>`; `formatBcDateTime(at: Date, timeZone: string): string`

**Behaviour** (spec §4; each line has a test):
- **Approve** — allowed only from `draft` (a reference already set → `ReleaseStateError("This has already been approved.")`). With exactly one ministry and no lead, that ministry becomes lead. `approveProblems` → `ReleaseRuleError`. In the same transaction: `reference = "NEWS-" + pad(nextCounter("news", 0, ""), 5)`; if `typeRules(type).generatesKey`: `year = bcYear(now)`, `abbr = lead ? ministryAbbreviation(lead) : null` (a lead with no abbreviation → `ReleaseRuleError(["The lead ministry has no abbreviation in Core; add one before approving."])`), `n = nextCounter("ministry", year, lead ?? "")`, `m = nextCounter("year", year, "")`, `key = \`${year}${(abbr ?? "ADVIS").toUpperCase()}${pad(n,4)}-${pad(m,6)}\``, and `year`/`year_release`/`ministry_release` columns set. `term_id` = the current government term (null if none). Status → `approved`. Log `"Approved {TYPE_LABEL}"`.
- `nextCounter` is one statement: `INSERT … ON CONFLICT (scope, year, ministry) DO UPDATE SET last_value = number_counters.last_value + 1 RETURNING last_value` — atomic under concurrency.
- **Schedule** — allowed from `approved` or `failed`. `publishProblems(view)` → `ReleaseRuleError`. `assertPublishable(toReleaseRecord(...))`. `"now"` → `publish_at = date_trunc('minute', now())`, log `"Scheduled for Immediate Release"`. A time: if more than 5 minutes before the DB's `now()` → `ReleaseRuleError(["The publish time is more than 5 minutes in the past."])`; if at/before `now()` → treated as immediate (rounded to the minute, same log); else stored as given, log `` `Scheduled for Release on ${formatBcDateTime(t)}` ``. Status → `scheduled`, `last_error` cleared. If `releasedAt` is null, `toSubscribers` is on and `deps.countSubscribers` is given, call it **before** the transaction with `indexKeysFor` of the view's categories and store the result in `nod_subscribers` (a failure leaves it null and logs `[nrms] subscriber count unavailable` to stderr — never blocks scheduling).
- **Cancel** — only from `scheduled`: back to `approved` (or `draft` without a reference), log `"Cancelled Release"`.
- **Unpublish** — only from `published` or `publishing`; advisories → `ReleaseStateError("A sent Advisory can't be unpublished.")`. Status → `unpublishing`, log `"Unpublished Release"`. (The publisher, Task 7, completes it.)
- All four use `mutateRelease(..., { correction: false })`.
- **Record** — `kind = POST_KIND[type]`; `atomId = atomId ?? "uuid:" + id`; English summary/location (empty → null); `socialMediaHeadline: null`; documents ordered English first then French, each language's documents by `sortIndex`, `detailsHtml = bodyHtml`, `byline` only for informal layout (else null), contacts via `splitContact`; `isNewsOnDemand = toSubscribers`; `publishFlags = publishOptions`; `assets`, `translations`, `renditions` null; `redirectUri = redirectUrl`.

- [ ] **Step 1: Write the failing tests**

`apps/nrms/src/releases/record.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { releaseRecordSchema } from "@gcpe/events";
import { view } from "@gcpe/nrms-contract/testing";
import { assertPublishable, splitContact, toReleaseRecord } from "./record";
import { ReleaseTooLargeError } from "./errors";

const at = { publishDate: "2026-10-04T16:00:00.000Z", timestamp: "2026-10-04T16:00:05.000Z" };

describe("toReleaseRecord", () => {
  it("maps a view to a valid release record", () => {
    const v = view({ key: "2026HLTH0001-000001", reference: "NEWS-00001", publishAt: at.publishDate });
    const r = toReleaseRecord(v, at);
    expect(releaseRecordSchema.parse(r)).toEqual(r);
    expect(r).toMatchObject({ key: "2026HLTH0001-000001", kind: "releases", reference: "NEWS-00001", atomId: `uuid:${v.id}`, location: "VICTORIA", summary: "Clinics open.", isNewsOnDemand: true, renditions: null });
    expect(r.documents[0]).toEqual({ pageTitle: "News Release", languageId: 4105, headline: "Clinics open", subheadline: null, detailsHtml: "<p>Body</p>", byline: null, contacts: [{ title: "Media Relations", details: "250-555-0100" }] });
  });
  it("orders English documents before French and keeps bylines only for informal layout", () => {
    const v = view({
      key: "k",
      documents: [
        { id: "d1", sortIndex: 0, layout: "informal", languages: [
          { languageId: 3084, pageTitle: "FR", headline: "Fr", subheadline: null, organizations: null, byline: "Par X", bodyHtml: "<p>f</p>", pageImageId: null, contacts: [] },
          { languageId: 4105, pageTitle: "EN", headline: "En", subheadline: null, organizations: null, byline: "By X", bodyHtml: "<p>e</p>", pageImageId: null, contacts: [] },
        ] },
        { id: "d2", sortIndex: 1, layout: "formal", languages: [{ languageId: 4105, pageTitle: "BG", headline: "Bg", subheadline: null, organizations: "Org", byline: "x", bodyHtml: "<p>b</p>", pageImageId: null, contacts: [] }] },
      ],
    });
    expect(toReleaseRecord(v, at).documents.map((d) => [d.languageId, d.headline, d.byline])).toEqual([[4105, "En", "By X"], [4105, "Bg", null], [3084, "Fr", "Par X"]]);
  });
  it("splitContact and the size guard", () => {
    expect(splitContact("Title\r\nLine 1\nLine 2")).toEqual({ title: "Title", details: "Line 1\nLine 2" });
    const huge = view({ key: "k", documents: [{ id: "d", sortIndex: 0, layout: "formal", languages: [{ languageId: 4105, pageTitle: "T", headline: "H", subheadline: null, organizations: "O", byline: null, bodyHtml: "x".repeat(2_000_000), pageImageId: null, contacts: [] }] }] });
    expect(() => assertPublishable(toReleaseRecord(huge, at))).toThrow(ReleaseTooLargeError);
  });
});
```


`apps/nrms/src/releases/workflow.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNrmsTestDb, editor, sampleCreate, seedTaxonomy } from "../../test/helpers";
import { governmentTerms } from "../db/schema";
import { ReleaseRuleError, ReleaseStateError } from "./errors";
import { bcYear, nextCounter } from "./numbering";
import { createRelease, saveCategories } from "./service";
import { loadView } from "./store";
import { approve, cancel, schedule, unpublish } from "./workflow";

const TZ = "America/Vancouver";
const deps = { timeZone: TZ };

describe("workflow", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    await tdb.db.insert(governmentTerms).values({ name: "2024-2028", isCurrent: true });
  });
  afterAll(async () => {
    await tdb.drop();
  });
  const db = () => tdb.db;
  const year = bcYear(new Date(), TZ);

  it("bcYear uses BC local time at the new-year boundary", () => {
    expect(bcYear(new Date("2027-01-01T06:30:00Z"), TZ)).toBe(2026);
    expect(bcYear(new Date("2027-01-01T08:30:00Z"), TZ)).toBe(2027);
  });

  it("approve assigns the legacy key and a NEWS- reference, once", async () => {
    const v = await createRelease(db(), sampleCreate, editor);
    const a = await approve(db(), v.id, v.version, editor, deps);
    expect(a.status).toBe("approved");
    expect(a.reference).toMatch(/^NEWS-\d{5}$/);
    expect(a.key).toMatch(new RegExp(`^${year}HLTH\\d{4}-\\d{6}$`));
    await expect(approve(db(), v.id, a.version, editor, deps)).rejects.toEqual(new ReleaseStateError("This has already been approved."));
    const term = await tdb.db.execute<{ term_id: string | null }>(sql`SELECT term_id FROM news_releases WHERE id = ${v.id}`);
    expect(term.rows[0]!.term_id).not.toBeNull();
  });

  it("stories keep their slug key; advisories without a ministry use ADVIS", async () => {
    const s = await createRelease(db(), { ...sampleCreate, type: "story", headline: "Story time" }, editor);
    expect((await approve(db(), s.id, s.version, editor, deps)).key).toBe("story-time");
    const adv = await createRelease(db(), { ...sampleCreate, type: "advisory", ministries: [], leadMinistryKey: null, sectors: [], mediaListKeys: ["regional"] }, editor);
    expect((await approve(db(), adv.id, adv.version, editor, deps)).key).toMatch(new RegExp(`^${year}ADVIS\\d{4}-\\d{6}$`));
  });

  it("approve needs a lead ministry for non-advisories", async () => {
    const v = await createRelease(db(), { ...sampleCreate, ministries: ["health", "finance"], leadMinistryKey: null }, editor);
    await expect(approve(db(), v.id, v.version, editor, deps)).rejects.toEqual(new ReleaseRuleError(["Choose the lead ministry."]));
  });

  it("20 concurrent approvals get 20 distinct numbers", async () => {
    const created = await Promise.all(Array.from({ length: 20 }, () => createRelease(db(), sampleCreate, editor)));
    const approved = await Promise.all(created.map((v) => approve(db(), v.id, v.version, editor, deps)));
    expect(new Set(approved.map((a) => a.reference)).size).toBe(20);
    expect(new Set(approved.map((a) => a.key)).size).toBe(20);
  });

  it("nextCounter counts per scope", async () => {
    expect(await nextCounter(tdb.db, "year", 1999, "")).toBe(1);
    expect(await nextCounter(tdb.db, "year", 1999, "")).toBe(2);
    expect(await nextCounter(tdb.db, "ministry", 1999, "health")).toBe(1);
  });

  it("schedule: now rounds to the minute; >5 min in the past is refused; future logs the BC time", async () => {
    const v = await createRelease(db(), sampleCreate, editor);
    let a = await approve(db(), v.id, v.version, editor, deps);
    await expect(schedule(db(), v.id, { version: a.version, publishAt: new Date(Date.now() - 10 * 60_000).toISOString() }, editor, deps)).rejects.toEqual(new ReleaseRuleError(["The publish time is more than 5 minutes in the past."]));
    const s = await schedule(db(), v.id, { version: a.version, publishAt: "now" }, editor, deps);
    expect(s.status).toBe("scheduled");
    expect(new Date(s.publishAt!).getUTCSeconds()).toBe(0);
    const c = await cancel(db(), v.id, s.version, editor);
    expect(c.status).toBe("approved");
    const future = await schedule(db(), v.id, { version: c.version, publishAt: "2030-01-15T17:30:00Z" }, editor, deps);
    expect(future.publishAt).toBe("2030-01-15T17:30:00.000Z");
    const log = await tdb.db.execute<{ text: string }>(sql`SELECT text FROM release_log WHERE release_id = ${v.id} ORDER BY id`);
    expect(log.rows.map((r) => r.text)).toEqual(expect.arrayContaining(["Scheduled for Immediate Release", "Cancelled Release", "Scheduled for Release on January 15, 2030 at 10:30 a.m."]));
  });

  it("schedule refuses incomplete releases and caches the subscriber count", async () => {
    const v = await createRelease(db(), { ...sampleCreate, sectors: [] }, editor);
    const a = await approve(db(), v.id, v.version, editor, deps);
    await expect(schedule(db(), v.id, { version: a.version, publishAt: "now" }, editor, deps)).rejects.toEqual(new ReleaseRuleError(["Choose at least one sector."]));
    const fixed = await saveCategories(db(), v.id, { version: a.version, leadMinistryKey: "health", ministries: ["health"], sectors: ["health"], themes: [], tags: [] }, editor);
    let seen: string[] = [];
    const s = await schedule(db(), v.id, { version: fixed.version, publishAt: "now" }, editor, { timeZone: TZ, countSubscribers: async (k) => ((seen = k), 42) });
    expect(seen).toEqual(["ministries:health", "sectors:health"]);
    expect(s.nodSubscribers).toBe(42);
  });

  it("unpublish: only live releases, never advisories", async () => {
    const v = await createRelease(db(), sampleCreate, editor);
    const a = await approve(db(), v.id, v.version, editor, deps);
    await expect(unpublish(db(), v.id, a.version, editor)).rejects.toBeInstanceOf(ReleaseStateError);
    await tdb.db.execute(sql`UPDATE news_releases SET status = 'published', publish_at = now(), released_at = now() WHERE id = ${v.id}`);
    const live = (await loadView(db(), v.id))!;
    expect((await unpublish(db(), v.id, live.version, editor)).status).toBe("unpublishing");
    const adv = await createRelease(db(), { ...sampleCreate, type: "advisory", sectors: [], mediaListKeys: ["regional"] }, editor);
    await tdb.db.execute(sql`UPDATE news_releases SET status = 'published', publish_at = now(), released_at = now() WHERE id = ${adv.id}`);
    await expect(unpublish(db(), adv.id, (await loadView(db(), adv.id))!.version, editor)).rejects.toEqual(new ReleaseStateError("A sent Advisory can't be unpublished."));
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms/src/releases`
Expected: FAIL — `numbering`, `workflow`, `record` missing.

- [ ] **Step 3: Implement**

`apps/nrms/src/releases/numbering.ts`:

```ts
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";

export function bcYear(at: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric" }).format(at));
}

export const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** Atomic increment-and-read; the upsert takes the row lock, so concurrent approvals serialise here. */
export async function nextCounter(tx: DbOrTx, scope: "news" | "year" | "ministry", year: number, ministry: string): Promise<number> {
  const r = await tx.execute<{ last_value: number }>(sql`
    INSERT INTO number_counters (scope, year, ministry, last_value) VALUES (${scope}, ${year}, ${ministry}, 1)
    ON CONFLICT (scope, year, ministry) DO UPDATE SET last_value = number_counters.last_value + 1
    RETURNING last_value`);
  return Number(r.rows[0]!.last_value);
}
```

`apps/nrms/src/releases/record.ts`:

```ts
import { envelopeByteLength, MAX_EVENT_BYTES, releaseRecordSchema, sizingEnvelope, type ReleaseRecord } from "@gcpe/events";
import { LANG_EN, LANG_FR, POST_KIND, type ReleaseView } from "@gcpe/nrms-contract";
import { ReleaseTooLargeError } from "./errors";

export function splitContact(information: string): { title: string; details: string } {
  const [title = "", ...rest] = information.split(/\r?\n/);
  return { title, details: rest.join("\n") };
}

export function toReleaseRecord(v: ReleaseView, at: { publishDate: string; timestamp: string }): ReleaseRecord {
  const en = v.languages.find((l) => l.languageId === LANG_EN);
  const docs = [...v.documents].sort((a, b) => a.sortIndex - b.sortIndex);
  const documents = [LANG_EN, LANG_FR].flatMap((lang) =>
    docs.flatMap((d) => {
      const l = d.languages.find((x) => x.languageId === lang);
      if (!l) return [];
      return [{
        pageTitle: l.pageTitle, languageId: lang, headline: l.headline, subheadline: l.subheadline, detailsHtml: l.bodyHtml,
        byline: d.layout === "informal" ? l.byline : null, contacts: l.contacts.map(splitContact),
      }];
    }),
  );
  return {
    key: v.key!, kind: POST_KIND[v.type], reference: v.reference, atomId: v.atomId ?? `uuid:${v.id}`, publishDate: at.publishDate,
    leadMinistryKey: v.leadMinistryKey, summary: en?.summary || null, socialMediaSummary: en?.socialMediaSummary ?? null, socialMediaHeadline: null,
    keywords: v.keywords, location: en?.location || null, hasMediaAssets: v.hasMediaAssets, hasTranslations: v.hasTranslations,
    isNewsOnDemand: v.publishOptions.toSubscribers, assetUrl: v.assetUrl, redirectUri: v.redirectUrl, documents,
    ministryKeys: v.ministries, sectorKeys: v.sectors, tagKeys: v.tags, themeKeys: v.themes, assets: null, translations: null,
    publishFlags: { ...v.publishOptions }, mediaListKeys: v.mediaListKeys, renditions: null, timestamp: at.timestamp,
  };
}

export function assertPublishable(record: ReleaseRecord): void {
  releaseRecordSchema.parse(record);
  const bytes = envelopeByteLength(sizingEnvelope({ type: "release.published", source: "nrms", aggregateId: record.key, data: record }));
  if (bytes > MAX_EVENT_BYTES) throw new ReleaseTooLargeError(`This release would publish as ${bytes} bytes; the limit is ${MAX_EVENT_BYTES}.`);
}
```

`apps/nrms/src/releases/workflow.ts` — implement per "Behaviour" above. Use these pieces:

```ts
import { eq, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { indexKeysFor } from "@gcpe/events";
import { approveProblems, publishProblems, TYPE_LABEL, typeRules, type ReleaseView, type ScheduleInput } from "@gcpe/nrms-contract";
import { governmentTerms, newsReleases } from "../db/schema";
import { ministryAbbreviation } from "../taxonomy";
import { ReleaseRuleError, ReleaseStateError } from "./errors";
import { bcYear, nextCounter, pad } from "./numbering";
import { assertPublishable, toReleaseRecord } from "./record";
import { loadView, mutateRelease, type Actor } from "./store";

export interface WorkflowDeps {
  timeZone: string;
  countSubscribers?: (listKeys: string[]) => Promise<number>;
}

/** "January 15, 2030 at 10:30 a.m." in BC time. */
export function formatBcDateTime(at: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, month: "long", day: "numeric", year: "numeric" }).format(at);
  const time = new Intl.DateTimeFormat("en-CA", { timeZone, hour: "numeric", minute: "2-digit", hour12: true })
    .format(at)
    .replace(/\s?AM$/i, " a.m.")
    .replace(/\s?PM$/i, " p.m.");
  return `${date} at ${time}`;
}
```

Check `formatBcDateTime`'s output against the test's expected string in your Node 24 runtime; ICU's `en-CA` may already emit "a.m." — normalise so the result is exactly `January 15, 2030 at 10:30 a.m.` either way. (BC is permanently UTC−7 from 2026-11-01, so 17:30Z in January 2030 is 10:30 a.m.; this needs Node 24's tzdata ≥ 2026b.)

For schedule's time checks, ask the database inside the transaction: `SELECT now() AS now, date_trunc('minute', now()) AS minute` and compare the requested instant to those values (as JS Dates from that row) — never to `new Date()`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms && npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/nrms
git commit -m "feat(nrms): approve with legacy numbering, schedule, cancel and unpublish"
```

---
### Task 7: New publisher and the API cutover

Replaces Phase 2's publisher and routes with the new model, moves every caller (unit, stack, e2e, clock-skew tests and the smoke script) to the new API, and drops Phase 2's `releases` table.

**Files:**
- Rewrite: `apps/nrms/src/publisher.ts`, `apps/nrms/src/publisher.test.ts`, `apps/nrms/src/http/routes.ts`, `apps/nrms/src/http/routes.test.ts`
- Delete: `apps/nrms/src/releases.ts`, `apps/nrms/src/releases.test.ts`
- Modify: `apps/nrms/src/db/schema.ts` (remove the Phase 2 `releases` table and the `ReleaseContent`/`ReleaseStatus` exports), `apps/nrms/src/start.ts`, `apps/nrms/test/helpers.ts` (remove `sampleDraft`; add `createScheduledRelease`), `apps/stack/src/stack.ts` (tick step result shape if it inspects it), `apps/stack/src/stack.test.ts`, `tests/e2e/thin-slice.test.ts`, `tests/clock-skew.test.ts`, `scripts/siteground-smoke.sh`, `docs/deploy/siteground.md`
- Create: `apps/nrms/migrations/0005_drop_phase2_releases.sql` (generated)

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces:
  - `publishDue(opts: PublisherOptions): Promise<{ published: string[]; updated: string[]; unpublished: string[]; failed: string[] }>` (release keys), `startPublisher(opts & { intervalMs? })`, `interface PublisherOptions { db: Db; subscribers: SubscriberConfig[]; now?: TestClock; limit?: number; prepareMedia?: (tx: Tx, view: ReleaseView) => Promise<{ assetUrl: string | null }> }` — `prepareMedia` is the seam Phase 3c's Flickr job plugs into; the default returns the view's own `assetUrl`.
  - Routes (all under `/api`, JSON): `GET /categories`; `POST /releases` (create → 201 view); `GET /releases/:id` (view + `statusText`); `POST /releases/:id/approve|schedule|cancel|unpublish|delete` (bodies `{ version }` or `scheduleSchema`). Errors: zod → 400 `{ error: "invalid request", issues }`; `ReleaseRuleError` → 422 `{ error: problems.join(" "), problems }`; `VersionConflictError` and `ReleaseStateError` → 409 `{ error: message }`; `ReleaseNotFoundError` → 404; `ReleaseTooLargeError` → 413.
  - `test/helpers.ts`: `createScheduledRelease(db, over?: Partial<CreateReleaseInput>, publishAt?: Date): Promise<ReleaseView>` (seeds taxonomy, creates, approves, schedules — the go-to fixture for publisher/stack/e2e tests).

**Publisher behaviour:**
- One transaction per release. Claim with `FOR UPDATE SKIP LOCKED`:
  `WHERE (status = 'scheduled' AND publish_at <= <now> AND NOT on_hold) OR status IN ('publishing','unpublishing') ORDER BY publish_at, id LIMIT 1` (`<now>` = `sqlNow(opts.now)`).
- `unpublishing` → enqueue `release.unpublished` `{ key }`; status → `approved` (reference) or `draft`; version+1; log (actor `system`) `"Unpublished from BC Gov News"`.
- `scheduled` / `publishing` → load the view; `publishProblems` non-empty → throw a `ReleaseRuleError` (handled below). `{ assetUrl } = await prepareMedia(tx, view)`. First go-live (`released_at` null): `released_at = publish_at`, event `release.published`, logs `"Released for Publishing"` then `"Published to <destinations>"`. Otherwise event `release.updated` with `notify: true`, log `"Republished to <destinations>"`. `<destinations>` = the joined (" and ") subset of `"BC Gov News"` (toWeb), `"News On Demand"` (toSubscribers), `"Media Distribution Lists"` (toMediaLists). `atom_id` set to `uuid:<id>` if null. Insert a `release_publications` row (`published_at` = now, actor `system`, the record). Status → `published`, version+1, `last_error` null.
- The record is `toReleaseRecord(viewWithAsset, { publishDate: released_at ISO, timestamp: now ISO })`; `released_at`/`timestamp` are the DB's `date_trunc('milliseconds', now())` values, read back from the update.
- Any failure after the claim rolls that transaction back; then, in a separate short statement guarded by `status IN ('scheduled','publishing')`, the release becomes `failed` with `last_error` (≤ 500 chars; for a `ReleaseRuleError`, its problems joined) and a `system` log line `"Publishing failed: <message>"`. The loop continues with the next release (no wedging). A claim-query failure propagates.

- [ ] **Step 1: Test helper**

Replace `sampleDraft` in `apps/nrms/test/helpers.ts` with:

```ts
import type { CreateReleaseInput, ReleaseView } from "@gcpe/nrms-contract";
import { createRelease } from "../src/releases/service";
import { approve, schedule } from "../src/releases/workflow";

/** Created, approved and scheduled (default: due one minute ago via a direct publish_at update). */
export async function createScheduledRelease(db: Db, over: Partial<CreateReleaseInput> = {}, publishAt?: Date): Promise<ReleaseView> {
  await seedTaxonomy(db);
  const v = await createRelease(db, { ...sampleCreate, ...over }, editor);
  const a = await approve(db, v.id, v.version, editor, { timeZone: "America/Vancouver" });
  const s = await schedule(db, v.id, { version: a.version, publishAt: "now" }, editor, { timeZone: "America/Vancouver" });
  const at = publishAt ?? new Date(Date.now() - 60_000);
  await db.execute(sql`UPDATE news_releases SET publish_at = ${at.toISOString()}::timestamptz WHERE id = ${s.id}`);
  return { ...s, publishAt: at.toISOString() };
}
```

(import `sql` from `drizzle-orm`).

- [ ] **Step 2: Write the failing publisher tests**

Rewrite `apps/nrms/src/publisher.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { dbClock, type TestDatabase } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { createNrmsTestDb, createScheduledRelease, editor } from "../test/helpers";
import { saveCategories } from "./releases/service";
import { loadView } from "./releases/store";
import { unpublish } from "./releases/workflow";
import { publishDue } from "./publisher";

const subs: SubscriberConfig[] = [{ name: "news-api", url: "http://news.invalid/events", secret: "s".repeat(40), types: ["*"] }];

describe("publisher", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE news_releases, outbox_events, outbox_deliveries, aggregate_sequences, release_log, release_publications CASCADE");
  });
  const events = async () => (await tdb.pool.query("SELECT type, envelope FROM outbox_events ORDER BY created_at, sequence")).rows as { type: string; envelope: { data: Record<string, unknown> } }[];
  const logs = async (id: string) => (await tdb.pool.query("SELECT text, actor_id FROM release_log WHERE release_id = $1 ORDER BY id", [id])).rows as { text: string; actor_id: string }[];

  it("publishes due releases only, writes release.published, a frozen copy and the legacy log lines", async () => {
    const due = await createScheduledRelease(tdb.db);
    await createScheduledRelease(tdb.db, {}, new Date(Date.now() + 10 * 60_000));
    const r = await publishDue({ db: tdb.db, subscribers: subs });
    expect(r).toEqual({ published: [due.key], updated: [], unpublished: [], failed: [] });
    const v = (await loadView(tdb.db, due.id))!;
    expect(v.status).toBe("published");
    expect(v.releasedAt).toBe(due.publishAt);
    expect(v.atomId).toBe(`uuid:${due.id}`);
    const [ev] = await events();
    expect(ev!.type).toBe("release.published");
    expect(ev!.envelope.data).toMatchObject({ key: due.key, kind: "releases", publishDate: due.publishAt, isNewsOnDemand: true });
    expect((await logs(due.id)).slice(-2)).toEqual([
      { text: "Released for Publishing", actor_id: "system" },
      { text: "Published to BC Gov News and News On Demand", actor_id: "system" },
    ]);
    expect((await tdb.pool.query("SELECT count(*)::int AS n FROM release_publications WHERE release_id = $1", [due.id])).rows[0].n).toBe(1);
  });

  it("a correction re-publishes as release.updated (notify) keeping the original publish date", async () => {
    const due = await createScheduledRelease(tdb.db);
    await publishDue({ db: tdb.db, subscribers: subs });
    const live = (await loadView(tdb.db, due.id))!;
    await saveCategories(tdb.db, due.id, { version: live.version, leadMinistryKey: "health", ministries: ["health"], sectors: ["education"], themes: [], tags: [] }, editor);
    expect(await publishDue({ db: tdb.db, subscribers: subs })).toEqual({ published: [], updated: [due.key], unpublished: [], failed: [] });
    const evs = await events();
    expect(evs.map((e) => e.type)).toEqual(["release.published", "release.updated"]);
    expect(evs[1]!.envelope.data).toMatchObject({ notify: true, publishDate: due.publishAt, sectorKeys: ["education"] });
    expect((await logs(due.id)).at(-1)!.text).toBe("Republished to BC Gov News and News On Demand");
  });

  it("unpublish completes as release.unpublished and returns the release to approved", async () => {
    const due = await createScheduledRelease(tdb.db);
    await publishDue({ db: tdb.db, subscribers: subs });
    await unpublish(tdb.db, due.id, (await loadView(tdb.db, due.id))!.version, editor);
    expect(await publishDue({ db: tdb.db, subscribers: subs })).toEqual({ published: [], updated: [], unpublished: [due.key], failed: [] });
    expect((await events()).at(-1)).toMatchObject({ type: "release.unpublished", envelope: { data: { key: due.key } } });
    expect((await loadView(tdb.db, due.id))!.status).toBe("approved");
  });

  it("an incomplete release fails visibly instead of sticking, and doesn't block the next one", async () => {
    const bad = await createScheduledRelease(tdb.db, {}, new Date(Date.now() - 120_000));
    await tdb.db.execute(sql`UPDATE document_languages SET body_html = '' WHERE document_id IN (SELECT id FROM release_documents WHERE release_id = ${bad.id})`);
    const good = await createScheduledRelease(tdb.db);
    const r = await publishDue({ db: tdb.db, subscribers: subs });
    expect(r).toEqual({ published: [good.key], updated: [], unpublished: [], failed: [bad.key] });
    const v = (await loadView(tdb.db, bad.id))!;
    expect(v).toMatchObject({ status: "failed", lastError: "Document 1 (English) needs body text." });
    expect((await logs(bad.id)).at(-1)!.text).toBe("Publishing failed: Document 1 (English) needs body text.");
  });

  it("skips releases on hold and honours the DB clock", async () => {
    const held = await createScheduledRelease(tdb.db);
    await tdb.db.execute(sql`UPDATE news_releases SET on_hold = true WHERE id = ${held.id}`);
    expect((await publishDue({ db: tdb.db, subscribers: subs })).published).toEqual([]);
    const later = await createScheduledRelease(tdb.db, {}, new Date(Date.now() + 60 * 60_000));
    const future = new Date((await dbClock(tdb.db)).getTime() + 2 * 60 * 60_000);
    expect((await publishDue({ db: tdb.db, subscribers: subs, now: () => future })).published).toEqual([later.key]);
  });

  it("prepareMedia can replace the asset URL in what's published", async () => {
    const due = await createScheduledRelease(tdb.db);
    await publishDue({ db: tdb.db, subscribers: subs, prepareMedia: async () => ({ assetUrl: "https://live.staticflickr.com/1/2_abc_b.jpg" }) });
    expect((await events())[0]!.envelope.data.assetUrl).toBe("https://live.staticflickr.com/1/2_abc_b.jpg");
    expect(due.key).toBeTruthy();
  });
});
```

Rewrite `apps/nrms/src/http/routes.test.ts` to cover, through `createApp` with a session cookie (mint with `mintSession` from `@gcpe/auth`, `auth: { session: { secret } }`, `eventSecrets: {}`), using `seedTaxonomy` first:

```ts
// 1. viewer (NRMS.Viewer) can GET /api/categories and /api/releases/:id, but POST /api/releases → 403
// 2. editor POST /api/releases with sampleCreate → 201, body.status "draft", body.statusText "Draft"
// 3. POST /api/releases/:id/approve { version: 1 } → 200 with reference; again → 409 { error: "This has already been approved." }
// 4. POST /api/releases/:id/schedule { version, publishAt: "now" } → 200 status "scheduled"
// 5. POST …/schedule with a stale version → 409 { error: "Someone else changed this release — reload to see their changes" }
// 6. POST /api/releases with sectors ["nope"] → 422 { error: "Unknown sector: nope", problems: ["Unknown sector: nope"] }
// 7. POST /api/releases with headline "" → 400 { error: "invalid request", issues: [...] }
// 8. GET /api/releases/not-a-uuid → 404; POST …/delete on a scheduled release → 409
// 9. a cookie-authenticated POST without x-gcpe-request → 403 (from requireBearer)
```

Write each as its own `it` with concrete assertions as listed.

- [ ] **Step 3: Run to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms/src/publisher.test.ts apps/nrms/src/http`
Expected: FAIL.

- [ ] **Step 4: Implement the publisher**

Rewrite `apps/nrms/src/publisher.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import { sqlNow, type Db, type TestClock, type Tx } from "@gcpe/db-kit";
import { enqueueEvent, type SubscriberConfig } from "@gcpe/events";
import { publishProblems, type ReleaseView } from "@gcpe/nrms-contract";
import { newsReleases, releasePublications } from "./db/schema";
import { ReleaseRuleError } from "./releases/errors";
import { toReleaseRecord } from "./releases/record";
import { loadView, SYSTEM_ACTOR, writeLog } from "./releases/store";

export interface PublisherOptions {
  db: Db;
  subscribers: SubscriberConfig[];
  now?: TestClock;
  limit?: number;
  /** Phase 3c seam: make the photo public etc. Returns the asset URL to publish. */
  prepareMedia?: (tx: Tx, view: ReleaseView) => Promise<{ assetUrl: string | null }>;
}

export interface PublishResult {
  published: string[];
  updated: string[];
  unpublished: string[];
  failed: string[];
}

const MAX_LAST_ERROR = 500;

function destinations(v: ReleaseView): string {
  return [v.publishOptions.toWeb && "BC Gov News", v.publishOptions.toSubscribers && "News On Demand", v.publishOptions.toMediaLists && "Media Distribution Lists"]
    .filter(Boolean)
    .join(" and ");
}

type Outcome = { kind: keyof PublishResult; key: string } | null;

async function processOne(tx: Tx, opts: PublisherOptions, id: string, status: string): Promise<Outcome> {
  const now = sqlNow(opts.now);
  const view = (await loadView(tx, id))!;
  const key = view.key ?? id;
  if (status === "unpublishing") {
    await enqueueEvent(tx, { type: "release.unpublished", source: "nrms", aggregateId: key, data: { key } }, opts.subscribers);
    await tx.update(newsReleases).set({ status: view.reference ? "approved" : "draft", version: view.version + 1, updatedAt: now }).where(eq(newsReleases.id, id));
    await writeLog(tx, id, SYSTEM_ACTOR, "Unpublished from BC Gov News");
    return { kind: "unpublished", key };
  }
  const problems = publishProblems(view);
  if (problems.length) throw new ReleaseRuleError(problems);
  const { assetUrl } = opts.prepareMedia ? await opts.prepareMedia(tx, view) : { assetUrl: view.assetUrl };
  const first = view.releasedAt === null;
  const stamp = sql`date_trunc('milliseconds', ${now})`;
  const [row] = await tx
    .update(newsReleases)
    .set({
      status: "published",
      releasedAt: first ? sql`${newsReleases.publishAt}` : sql`${newsReleases.releasedAt}`,
      atomId: sql`coalesce(${newsReleases.atomId}, ${`uuid:${id}`})`,
      lastError: null,
      version: view.version + 1,
      updatedAt: stamp,
    })
    .where(eq(newsReleases.id, id))
    .returning({ releasedAt: newsReleases.releasedAt, atomId: newsReleases.atomId, updatedAt: newsReleases.updatedAt });
  const record = toReleaseRecord({ ...view, assetUrl, atomId: row!.atomId }, { publishDate: row!.releasedAt!.toISOString(), timestamp: row!.updatedAt.toISOString() });
  if (first) {
    await enqueueEvent(tx, { type: "release.published", source: "nrms", aggregateId: record.key, data: record }, opts.subscribers);
    await writeLog(tx, id, SYSTEM_ACTOR, "Released for Publishing");
    await writeLog(tx, id, SYSTEM_ACTOR, `Published to ${destinations(view)}`);
  } else {
    await enqueueEvent(tx, { type: "release.updated", source: "nrms", aggregateId: record.key, data: { ...record, notify: true } }, opts.subscribers);
    await writeLog(tx, id, SYSTEM_ACTOR, `Republished to ${destinations(view)}`);
  }
  await tx.insert(releasePublications).values({ releaseId: id, publishedAt: row!.updatedAt, actorId: SYSTEM_ACTOR.id, actorName: SYSTEM_ACTOR.name, record });
  return { kind: first ? "published" : "updated", key: record.key };
}

/**
 * One transaction per release, claimed FOR UPDATE SKIP LOCKED so replicas never double-publish.
 * A failure after the claim marks only that release failed (never wedges the queue); a failure
 * of the claim itself propagates. Every due/now comparison uses the database clock.
 */
export async function publishDue(opts: PublisherOptions): Promise<PublishResult> {
  const limit = opts.limit ?? 50;
  const out: PublishResult = { published: [], updated: [], unpublished: [], failed: [] };
  for (let i = 0; i < limit; i++) {
    let claimed: { id: string; key: string | null; status: string } | null = null;
    let outcome: Outcome;
    try {
      outcome = await opts.db.transaction(async (tx) => {
        const now = sqlNow(opts.now);
        const r = await tx.execute<{ id: string; key: string | null; status: string }>(sql`
          SELECT id, key, status FROM ${newsReleases}
          WHERE (status = 'scheduled' AND publish_at <= ${now} AND NOT on_hold) OR status IN ('publishing', 'unpublishing')
          ORDER BY publish_at, id
          FOR UPDATE SKIP LOCKED LIMIT 1`);
        claimed = r.rows[0] ?? null;
        if (!claimed) return null;
        return processOne(tx, opts, claimed.id, claimed.status);
      });
    } catch (e) {
      const c = claimed as { id: string; key: string | null } | null;
      if (!c) throw e;
      const message = (e instanceof ReleaseRuleError ? e.problems.join(" ") : e instanceof Error ? e.message : String(e)).slice(0, MAX_LAST_ERROR);
      await opts.db.transaction(async (tx) => {
        const updated = await tx
          .update(newsReleases)
          .set({ status: "failed", lastError: message, updatedAt: sqlNow(opts.now), version: sql`${newsReleases.version} + 1` })
          .where(sql`${newsReleases.id} = ${c.id} AND ${newsReleases.status} IN ('scheduled', 'publishing')`)
          .returning({ id: newsReleases.id });
        if (updated.length) await writeLog(tx, c.id, SYSTEM_ACTOR, `Publishing failed: ${message}`);
      });
      console.error(`[nrms] publish failed for ${c.key ?? c.id}: ${message}`);
      out.failed.push(c.key ?? c.id);
      continue;
    }
    if (!outcome) break;
    out[outcome.kind].push(outcome.key);
  }
  return out;
}

export function startPublisher(opts: PublisherOptions & { intervalMs?: number }): () => Promise<void> {
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (running) return;
    running = publishDue(opts)
      .then((r) => {
        for (const [kind, keys] of Object.entries(r)) if ((keys as string[]).length) console.log(`[nrms] ${kind}: ${(keys as string[]).join(", ")}`);
      })
      .catch((e) => console.error("[nrms] publish failed", e))
      .finally(() => {
        running = null;
      });
  }, opts.intervalMs ?? 60_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
```

Note: an `unpublishing` release that fails (e.g. outbox error) is not moved to `failed` (the guard excludes it); it is retried next run. That is intended.

- [ ] **Step 5: Implement the routes and wiring**

Rewrite `apps/nrms/src/http/routes.ts` with the error mapping in Interfaces and these handlers (actor from `actorOf(req)`; `deps.timeZone` from start.ts):

```ts
export interface RouteDeps {
  db: Db;
  workflow: WorkflowDeps;
}

export function apiRoutes(deps: RouteDeps): Router {
  const r = Router();
  const read = requireAnyRole("NRMS.Viewer", "NRMS.Editor", "NRMS.SiteEditor");
  const edit = requireRole("NRMS.Editor");
  const now = () => Date.now();
  const withStatus = (v: ReleaseView) => ({ ...v, statusText: statusText(v, now()) });
  // r.get("/categories", read, …)                       → listCategories
  // r.post("/releases", edit, …)                         → 201 withStatus(createRelease(db, createReleaseSchema.parse(body), actorOf(req)))
  // r.get("/releases/:id", read, …)                      → loadView; null or status 'deleted' → 404
  // r.post("/releases/:id/approve", edit, …)             → approve(db, id, versionOnlySchema.parse(body).version, actor, deps.workflow)
  // r.post("/releases/:id/schedule", edit, …)            → schedule(db, id, scheduleSchema.parse(body), actor, deps.workflow)
  // r.post("/releases/:id/cancel", edit, …)              → cancel
  // r.post("/releases/:id/unpublish", edit, …)           → unpublish
  // r.post("/releases/:id/delete", edit, …)              → deleteRelease → 200 { result: "deleted" | "hidden" }
  return r;
}
```

Write each handler in full (no comments-as-code); every one returns `withStatus(view)` except delete and categories.

In `apps/nrms/src/app.ts`, pass `{ db, workflow }` to `apiRoutes`. In `apps/nrms/src/start.ts`: add `TENANT_CONFIG` (same default as the stack's: `fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url))`), load it with `loadTenantConfig` from `@gcpe/config`, and pass `workflow: { timeZone: tenant.timeZone }`; `workers.publish` and `startPublisher` use the new `publishDue`.

- [ ] **Step 6: Drop Phase 2's table**

Delete `apps/nrms/src/releases.ts` and `apps/nrms/src/releases.test.ts`; remove the Phase 2 `releases` table, `ReleaseContent` and `ReleaseStatus` from `apps/nrms/src/db/schema.ts`.

Run: `cd apps/nrms && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name drop_phase2_releases && cd ../..`
Expected: `0005_drop_phase2_releases.sql` containing only `DROP TABLE "releases"` (plus its index drop if emitted). If drizzle-kit prompts interactively, stop and report — do not hand-write it.

- [ ] **Step 7: Move every other caller to the new API**

- `tests/clock-skew.test.ts` (NRMS case): create releases with `createScheduledRelease(nrmsDb.db, {}, <date>)` (one due a minute ago, one due in 5 minutes, both from the DB clock), `TRUNCATE news_releases, …` instead of `releases`, expect `{ published: [dueKey], updated: [], unpublished: [], failed: [] }`, and read `released_at`/`updated_at` from `news_releases` for the "stamped with the DB's now()" assertion (the publisher stamps `updated_at` with the DB clock; `released_at` equals `publish_at`).
- `tests/e2e/thin-slice.test.ts`: the NRMS step becomes create (`POST /api/releases` with `sampleCreate` plus the escaping-sensitive headline) → `POST …/approve` → `POST …/schedule { publishAt: "now" }` → set `publish_at` a minute back via SQL (as before, the test simulates a due release) → `publishDue`. Seed NRMS's taxonomy with `seedTaxonomy(nrmsDb.db)`. Everywhere the test used `releaseDraft.key`, use the key the approve response returned. Expect `publishDue` → `{ published: [key], updated: [], unpublished: [], failed: [] }`.
- `apps/stack/src/stack.test.ts` (the release round-trip test near line 388): before creating, PUT Core's `health` org (already done by the file's setup, or add it) **and** a `sector` term `health` (`PUT /core/api/terms/sector/health` with `{ kind: "sector", key: "health", displayName: "Health", sortOrder: 0, isActive: true, social: { … } }` following `termInputSchema`), tick once so NRMS receives them, then create/approve/schedule through `/nrms/api/...` as above.
- `scripts/siteground-smoke.sh`: replace the create/schedule section with create (`sampleCreate`-shaped JSON: `type`, `pageTitle`, `layout`, `headline`, `bodyHtml`, `location`, `contacts`, `ministries: ["health"]`, `leadMinistryKey: "health"`, `sectors: ["health"]`), approve (`{"version":1}`), schedule (`{"version":2,"publishAt":"now"}`), reading `id`, `key` and `version` from each response with `json_get`; status at the end via `GET /nrms/api/releases/$ID`. Keep the waiting loop keyed on the returned `key`.
- `docs/deploy/siteground.md`: in the smoke-test section, note that NRMS needs Core's ministries and sectors first — after deploying Phase 3 run `POST /core/api/admin/republish` once (admin token) so NRMS receives them, and that the smoke test needs a `health` ministry with abbreviation `HLTH` and a `health` sector in Core.

- [ ] **Step 8: Run everything**

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json && npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run && bash -n scripts/siteground-smoke.sh`
Expected: PASS (full suite).

- [ ] **Step 9: Commit**

```bash
git add -A apps/nrms apps/stack tests scripts docs/deploy
git commit -m "feat(nrms): publisher and API on the release model; drop Phase 2's releases table"
```

---
### Task 8: Editing, list and search API

**Files:**
- Create: `apps/nrms/src/releases/queries.ts`, `apps/nrms/src/releases/queries.test.ts`
- Modify: `apps/nrms/src/http/routes.ts`, `apps/nrms/src/http/routes.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces:
  - `queries.ts`: `listFolder(db, q: ListQuery, opts: { timeZone: string; nowMs: number }): Promise<ReleasePage<ReleaseListItem>>`; `searchReleases(db, q: SearchQuery, opts): Promise<ReleasePage<ReleaseListItem>>` (page size 20); `goTo(db, q: string): Promise<string | null>` (release id); `releaseLog(db, id, all: boolean): Promise<{ at: string; actorName: string; text: string }[]>`; `publications(db, id): Promise<{ id: number; publishedAt: string; actorName: string }[]>`; `publication(db, id, pubId): Promise<ReleaseRecord | null>`; `listMediaLists(db)`, `listPageTypes(db)`, `listPageImages(db)` (id, name, alt texts; no bytes; active only)
  - Routes (reads: any read role; writes: `NRMS.Editor`):
    - `GET /releases?folder=&type=&page=&pageSize=` → `ReleasePage<ReleaseListItem>`
    - `GET /search?q=&ministry=&sector=&page=` → `ReleasePage<ReleaseListItem>`
    - `GET /goto?q=` → `{ id }` or 404
    - `GET /releases/:id/log?all=true|false` (default false); `GET /releases/:id/publications`; `GET /releases/:id/publications/:pubId` (the frozen record)
    - `GET /media-lists`, `GET /page-types`, `GET /page-images`
    - `PUT /releases/:id/settings|categories|asset|meta` (bodies: `settingsSchema`, `categoriesSchema`, `assetSchema`, `metaSchema`)
    - `POST /releases/:id/documents` (`addDocumentSchema`); `PUT /releases/:id/documents/order` (`reorderDocumentsSchema`); `PUT /releases/:id/documents/:docId/:lang` (`documentLanguageSchema`; `lang` 4105|3084); `POST /releases/:id/documents/:docId/translations` (`addTranslationSchema`); `POST /releases/:id/documents/:docId/remove` (`{ version }`); `POST /releases/:id/documents/:docId/translations/:lang/remove` (`{ version }`)

**Behaviour:**
- **Folders** (deleted releases never appear):
  - `drafts` = `draft`, `approved`, `failed`; sorted in three groups — publish time before the start of tomorrow in BC time, then no publish time, then later — each group by publish time ascending then `updated_at` descending.
  - `scheduled` = `scheduled`; publish time ascending.
  - `published` = `published`, `publishing`, `unpublishing`; `released_at` descending.
  - `type` filter `all` or one type. Every folder pages (`page`, `pageSize`, `total`).
- **List item** — `leadOrganization` follows legacy `GetFirstOrganization`: lead ministry's display name (local cache) → else the first English document's organizations, first line, with a leading "Ministry of " removed → else a byline line beginning "Minister of " with that prefix removed → else the only ministry's name → else `""`. `pageTitle`/`headline` from the first English document; `location` uppercased; `summary` English summary; `approved = reference !== null`; `statusText` from the contract.
- **Search** — `q` matching `^[A-Za-z]+-(\d+)$` (and not `NEWS-…`) searches `activity_id = <digits>`; otherwise case-insensitive substring match on any document language's headline (empty `q` matches all). Optional `ministry` / `sector` filters (AND). Includes drafts (C14); excludes deleted. Sorted by `coalesce(released_at, publish_at)` descending (nulls last), then headline. Page size 20.
- **Go-to** (legacy `GetSearchUrl`): `/releases/<key>`, `/stories/<key>`, `/factsheets/<key>`, `/updates/<key>`, `/advisories/<key>` (path or full URL) → that type and key; a 5-digit number → `NEWS-<number>`; `NEWS-#####` → reference; otherwise an exact key (any type, case-insensitive) or exact reference. Deleted releases don't resolve.
- **Log** — newest first; with `all=false`, entries whose text starts with `Edited ` or `Updated ` are hidden (the legacy "show all" toggle).

- [ ] **Step 1: Write the failing tests**

`apps/nrms/src/releases/queries.test.ts` — with `createNrmsTestDb` + `seedTaxonomy`, build fixtures through the service (`createRelease`, `approve`, `schedule`, direct SQL for `published`/`released_at` where needed) and assert:

```ts
// listFolder
//  - a draft dated yesterday, an undated draft, a draft dated next week → drafts order [yesterday, undated, nextWeek]
//  - scheduled folder sorted by publish time ascending; published folder by released_at descending
//  - type: "story" returns only stories; pageSize 2 → total 3, page 2 has 1 item
//  - a deleted release never appears in any folder
//  - list item for sampleCreate: { leadOrganization: "Health", pageTitle: "News Release", headline: "Weekend clinics open across B.C.", location: "VICTORIA", approved: false, statusText: "Draft" }
//  - lead organization fallback: no lead ministry + organizations "Ministry of Finance\nTreasury Board" → "Finance"
// searchReleases
//  - "clinics" (any case) finds the drafts too; "ABC-4521" finds the release whose activity_id is 4521; ministry/sector filters AND together
// goTo
//  - "/releases/<key>" and "https://news.gov.bc.ca/stories/<storyKey>" resolve; "01234" and "NEWS-01234" resolve the release with reference NEWS-01234; an unknown value → null
// releaseLog
//  - after create + categories save + approve: all=true → ["Approved Release", "Updated categories", "Created Release"]; all=false → ["Approved Release", "Created Release"]
```

Write each bullet as an `it` with concrete `expect`s (the expected values are in the bullets).

Extend `apps/nrms/src/http/routes.test.ts` with one `it` per route group: folder list (200, `items` array, viewer allowed), search, go-to (200/404), section PUTs with editor (200, `version` incremented) and viewer (403), document add/translate/reorder/remove happy paths, log and publications (after running `publishDue` once: one publication, and `GET …/publications/:pubId` returns a record whose `key` matches).

- [ ] **Step 2: Run to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms/src/releases/queries.test.ts apps/nrms/src/http`
Expected: FAIL.

- [ ] **Step 3: Implement**

`queries.ts`: build list items with one query per page — select the page's `news_releases` rows (filters and ordering in SQL; the "start of tomorrow in BC" boundary computed in JS with `Intl` for `opts.timeZone` from `opts.nowMs` and bound as a `timestamptz` parameter), then load their English release-language rows, first-document English language rows, ministry categories and the needed organization names in batched `IN (…)` queries, and assemble. Total via `count(*)` with the same filters. Don't call `loadView` per row.

Routes: follow Task 7's handler and error-mapping pattern. Path params: validate `:id`/`:docId` as UUIDs (malformed → 404) and `:lang` as `4105|3084` (else 404).

- [ ] **Step 4: Run to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms && npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/nrms
git commit -m "feat(nrms): section editing, folder lists, search, go-to and history endpoints"
```

---
### Task 9: NoD subscriber count, service tokens and stack defaults

**Files:**
- Create: `packages/auth/src/service-token.ts`, `packages/auth/src/service-token.test.ts`, `apps/nrms/src/clients.ts`, `apps/nrms/src/clients.test.ts`
- Modify: `packages/auth/src/index.ts`, `apps/nod/src/http/routes.ts`, `apps/nod/src/http/routes.test.ts`, `apps/nod/src/subscribers.ts`, `apps/nrms/src/start.ts`, `apps/nrms/src/app.ts`, `apps/stack/src/env.ts`, `apps/stack/src/env.test.ts`

**Interfaces:**
- Produces:
  - `serviceTokenProvider(opts: { tokenUrl?: string; clientId?: string; clientSecret?: string; scope?: string; local: LocalAuthConfig | null; subject: string; roles: string[]; envPrefix: string; fetchImpl?: typeof fetch; now?: () => number }): () => Promise<string>` — same behaviour as NoD's `distributionTokenProvider` (Entra client credentials when all four given; partial → throws naming `${envPrefix}_TOKEN_URL` etc.; else local token with `subject`, `azp = subject`, `roles`, 1 h TTL, re-minted 5 min before expiry; neither → throws). NoD keeps its own provider unchanged.
  - NoD: `countSubscribers(db, listKeys: string[]): Promise<number>` — distinct **verified** subscribers having a subscription to `'*'` or any of `listKeys` (lowercased); route `GET /api/subscribers/count?lists=a,b` (roles `NoD.Admin` or `NRMS.Editor`; each key must match `listKeySchema`; empty `lists` → count of `'*'` subscribers only) → `{ count }`.
  - NRMS `clients.ts`: `nodClient(opts: { baseUrl: string; getToken: () => Promise<string>; fetchImpl?: typeof fetch }): { countSubscribers(listKeys: string[]): Promise<number> }` (non-200 → throws `Error("NoD count failed: HTTP <status>")`; 5 s timeout via `AbortSignal.timeout(5000)`).
  - NRMS env: `NOD_URL` (optional) and `NOD_TOKEN_URL`, `NOD_CLIENT_ID`, `NOD_CLIENT_SECRET`, `NOD_SCOPE` (optional, together). When `NOD_URL` is set, `start.ts` builds `nodClient` with `serviceTokenProvider({ …, local: auth.local, subject: "nrms", roles: ["NRMS.Editor"], envPrefix: "NOD" })` and passes `countSubscribers` into `WorkflowDeps`.
  - Stack: `STACK_APP_DEFAULTS: Partial<Record<AppPrefix, Record<string, string>>> = { NRMS: { NOD_URL: "self:/nod", DISTRIBUTION_URL: "self:/distribution" } }`, applied in `envFor` after shared keys and derived event wiring but before the app's own prefixed vars (an explicit `NRMS_NOD_URL` still wins). `self:` values resolve as usual.

- [ ] **Step 1: Write the failing tests**

`packages/auth/src/service-token.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { decodeJwt } from "jose";
import { serviceTokenProvider } from "./service-token";

const local = { username: "admin", passwordHash: "x", secret: "s".repeat(40) };

describe("serviceTokenProvider", () => {
  it("mints a local token with the given subject, azp and roles, cached until near expiry", async () => {
    let now = 1_000_000;
    const get = serviceTokenProvider({ local, subject: "nrms", roles: ["NRMS.Editor"], envPrefix: "NOD", now: () => now });
    const t1 = await get();
    expect(decodeJwt(t1)).toMatchObject({ sub: "nrms", azp: "nrms", roles: ["NRMS.Editor"] });
    expect(await get()).toBe(t1);
    now += 56 * 60_000;
    expect(await get()).not.toBe(t1);
  });
  it("uses Entra client credentials when all four are set; refuses a partial set or nothing", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: "entra-token", expires_in: 3600 }), { status: 200 }));
    const get = serviceTokenProvider({ tokenUrl: "https://login.invalid/token", clientId: "c", clientSecret: "s", scope: "api://nod/.default", local: null, subject: "nrms", roles: [], envPrefix: "NOD", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await get()).toBe("entra-token");
    expect(() => serviceTokenProvider({ tokenUrl: "https://x", local, subject: "nrms", roles: [], envPrefix: "NOD" })).toThrow(/NOD_TOKEN_URL, NOD_CLIENT_ID, NOD_CLIENT_SECRET and NOD_SCOPE/);
    expect(() => serviceTokenProvider({ local: null, subject: "nrms", roles: [], envPrefix: "NOD" })).toThrow(/LOCAL_ADMIN_ENABLED/);
  });
});
```

(Read `packages/auth/src/client-credentials.ts` for the exact token-endpoint response shape it expects and adjust the mocked JSON to match.)

Add to `apps/nod/src/http/routes.test.ts` (following its existing setup): three verified subscribers — one on `all`, one on `ministries:health`, one on `sectors:education` — and one unverified on `ministries:health`; then `GET /api/subscribers/count?lists=ministries:health,sectors:health` with an `NRMS.Editor` token → `{ count: 2 }`; `lists=` empty → `{ count: 1 }`; a bad key (`lists=bogus`) → 400; a token with no roles → 403.

`apps/nrms/src/clients.test.ts`: `nodClient` with a mocked `fetchImpl` — sends `GET <base>/api/subscribers/count?lists=ministries%3Ahealth%2Csectors%3Ahealth` with `authorization: Bearer <token>`, returns the `count`; a 500 → rejects `/NoD count failed: HTTP 500/`.

Add to `apps/stack/src/env.test.ts`: `envFor({}, "NRMS")` has `NOD_URL: "self:/nod"` and `DISTRIBUTION_URL: "self:/distribution"`; `envFor({ NRMS_NOD_URL: "https://nod.example" }, "NRMS").NOD_URL` is `"https://nod.example"`; `envFor({}, "CORE").NOD_URL` is undefined.

- [ ] **Step 2: Run to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/auth/src/service-token.test.ts apps/nod apps/nrms/src/clients.test.ts apps/stack/src/env.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/auth/src/service-token.ts`: generalise the body of `apps/nod/src/distribution-token.ts` (same caching constants: 3600 s TTL, 5 min refresh margin; Entra via `createClientCredentialsProvider`), parameterised by `subject`, `roles` and `envPrefix` for the error messages. Export it from `packages/auth/src/index.ts`.

NoD: add `countSubscribers` to `apps/nod/src/subscribers.ts`:

```ts
export async function countSubscribers(db: Db, listKeys: string[]): Promise<number> {
  const keys = ["*", ...listKeys.map((k) => k.toLowerCase())];
  const r = await db.execute<{ n: number }>(sql`
    SELECT count(DISTINCT s.id)::int AS n
    FROM ${subscribers} s JOIN ${subscriptions} sub ON sub.subscriber_id = s.id
    WHERE s.verified_at IS NOT NULL AND sub.list_key = ANY(${keys})`);
  return r.rows[0]!.n;
}
```

and the route in `apps/nod/src/http/routes.ts` (import `requireAnyRole`):

```ts
  r.get(
    "/subscribers/count",
    requireAnyRole("NoD.Admin", "NRMS.Editor"),
    run(async (req, res) => {
      const raw = typeof req.query.lists === "string" ? req.query.lists : "";
      const lists = z.array(listKeySchema).parse(raw ? raw.split(",") : []);
      res.json({ count: await countSubscribers(db, lists) });
    }),
  );
```

NRMS `clients.ts` per Interfaces. `start.ts`: new optional env vars, `nodClient` + `serviceTokenProvider` when `NOD_URL` set, `countSubscribers` passed into the routes' `workflow` deps. Stack `envFor` per Interfaces, with a doc comment explaining why these defaults exist (no extra SiteGround settings).

- [ ] **Step 4: Run to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/auth apps/nod apps/nrms apps/stack && npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/auth apps/nod apps/nrms apps/stack
git commit -m "feat(nrms): cache NoD's subscriber count at scheduling via a service token"
```

---

### Task 10: Text and PDF versions

**Files:**
- Create: `apps/nrms/src/renditions/model.ts`, `apps/nrms/src/renditions/text.ts`, `apps/nrms/src/renditions/pdf.ts`, `apps/nrms/src/renditions/renditions.test.ts`
- Modify: `apps/nrms/src/http/routes.ts`, `apps/nrms/src/http/routes.test.ts`

**Interfaces:**
- Consumes: `htmlToText`, `asciiPunctuation`, `collapseBlankLines` (Task 2); `ReleaseView`; `pageImages`.
- Produces:
  - `model.ts`: `interface RenditionDoc { languageId; pageTitle; headline; subheadlineLines: string[]; bylineHtml: string | null; bodyHtml: string /* location merged, asset tags stripped, empty paragraphs removed */; organizations: string | null; contacts: string[]; referenceNumber: string | null }`, `buildRenditionModel(v: ReleaseView, opts: { timeZone: string; nowMs: number }): { isReleased: boolean; releaseDate: string /* CP style */; docs: RenditionDoc[] }`, `cpDate(at: Date, timeZone: string): string`, `mergeLocation(location: string, bodyHtml: string): string`
  - `text.ts`: `renderText(v: ReleaseView, opts): string` (CRLF; with the "Connect with the Province of B.C. at: http://news.gov.bc.ca/connect" footer — Q14)
  - `pdf.ts`: `renderPdf(v: ReleaseView, opts & { pageImage?: { bytes: Buffer; mimeType: string } | null }): Promise<Buffer>`
  - Routes (read roles): `GET /releases/:id/text` (`text/plain; charset=utf-8`, `content-disposition: inline; filename="<key or id>.txt"`), `GET /releases/:id/pdf` (`application/pdf`, `inline; filename="<key or id>.pdf"`)

**Legacy rules to reproduce** (`Gcpe.News.ReleaseManagement.Templates/Release.cs`):
- Documents ordered English first, then French; each language's documents by `sortIndex`.
- `referenceNumber`: Advisory → null; no reference or no lead ministry → `"Not Approved"`; type `release` → the Key; others → the reference.
- `isReleased` = reference set.
- Release date: `releasedAt ?? publishAt ?? now`, formatted `cpDate` = `"MMM. d, yyyy"` in BC time with "Mar."→"March", "Apr."→"April", "May."→"May", "Jun."→"June", "Jul."→"July", "Sep."→"Sept." (e.g. `Oct. 3, 2026`, `May 5, 2026`, `Sept. 9, 2026`).
- English subheadline gets an extra line `(disponible en français en bas de page)` when that document also has French.
- Location merge (first document only): `LOCATION – ` (upper-cased location, en dash) is inserted before the first child of the first `<p>` (skipping an `<asset>` child); if a non-empty `<ul>`/`<ol>` comes before any `<p>`, the body is left as is. Location for a French document falls back to the English location when its own is empty.
- Informal layout: body is prefixed with `&nbsp;<br />` + `<b>byline</b>` (newlines → `<br />`) + `<br /><br /><br /><br />`.
- Text layout: line 1 `For Immediate Release` (only when released) then the reference number; blank line; the date; blank line; first document's organizations; then for each document: `PAGE TITLE` upper-cased (`"Media Advisory"` stays as the title only, upper-cased, with no headline line), else `PAGE TITLE\r\nHeadline`; subheadline lines; body via `htmlToText`; contacts block headed `Contact:` / `Contacts:` (English, by count) or `Renseignements additionnels:` (French), each contact separated by a blank line. Then `collapseBlankLines`, then `asciiPunctuation`, then the footer after three CRLFs.
- PDF: same content and order; Helvetica (bold for page title and headline), 11 pt body, wrapped to the page with margins of 54 pt, new pages as needed, the first document's page image (PNG/JPEG) at the top when present; characters the standard font can't encode replaced with `?`. Library: `pdf-lib` (pure JavaScript, standard fonts embedded in the code — no font files read from disk, so it survives the SiteGround esbuild bundle). Document title metadata = first English headline.

- [ ] **Step 1: Add the dependency**

Run: `npx -y npm@11 install pdf-lib@^1.17.1 -w @gcpe/nrms`

- [ ] **Step 2: Write the failing tests**

`apps/nrms/src/renditions/renditions.test.ts` (use `view()` from `@gcpe/nrms-contract/testing`):

```ts
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { view } from "@gcpe/nrms-contract/testing";
import { buildRenditionModel, cpDate, mergeLocation } from "./model";
import { renderPdf } from "./pdf";
import { renderText } from "./text";

const TZ = "America/Vancouver";
const opts = { timeZone: TZ, nowMs: Date.parse("2026-10-03T19:00:00Z") };

describe("renditions", () => {
  it("cpDate uses Canadian Press month style in BC time", () => {
    expect(cpDate(new Date("2026-10-03T19:00:00Z"), TZ)).toBe("Oct. 3, 2026");
    expect(cpDate(new Date("2026-05-05T19:00:00Z"), TZ)).toBe("May 5, 2026");
    expect(cpDate(new Date("2026-09-09T19:00:00Z"), TZ)).toBe("Sept. 9, 2026");
    expect(cpDate(new Date("2026-03-01T07:30:00Z"), TZ)).toBe("Feb. 28, 2026");
  });

  it("mergeLocation puts LOCATION – before the first paragraph's text", () => {
    expect(mergeLocation("Victoria", "<p>Clinics open.</p><p>More.</p>")).toBe("<p>VICTORIA – Clinics open.</p><p>More.</p>");
    expect(mergeLocation("Victoria", "<ul><li>a</li></ul><p>b</p>")).toBe("<ul><li>a</li></ul><p>b</p>");
    expect(mergeLocation("", "<p>x</p>")).toBe("<p>x</p>");
  });

  it("reference number rules", () => {
    expect(buildRenditionModel(view(), opts).docs[0]!.referenceNumber).toBe("Not Approved");
    expect(buildRenditionModel(view({ key: "2026HLTH0001-000001", reference: "NEWS-00001" }), opts).docs[0]!.referenceNumber).toBe("2026HLTH0001-000001");
    expect(buildRenditionModel(view({ type: "story", key: "story", reference: "NEWS-00002" }), opts).docs[0]!.referenceNumber).toBe("NEWS-00002");
    expect(buildRenditionModel(view({ type: "advisory", reference: "NEWS-00003" }), opts).docs[0]!.referenceNumber).toBeNull();
  });

  it("text version follows the legacy layout", () => {
    const v = view({ key: "2026HLTH0001-000001", reference: "NEWS-00001", releasedAt: "2026-10-03T19:00:00Z" });
    expect(renderText(v, opts)).toBe(
      [
        "For Immediate Release", "2026HLTH0001-000001", "Oct. 3, 2026", "", "Ministry of Health", "",
        "NEWS RELEASE", "Clinics open", "", "VICTORIA - Body", "", "Contact:", "", "Media Relations", "250-555-0100",
        "", "", "Connect with the Province of B.C. at: http://news.gov.bc.ca/connect",
      ].join("\r\n"),
    );
  });

  it("bilingual text adds the French note and French contact heading", () => {
    const v = view({
      documents: [{ id: "d1", sortIndex: 0, layout: "formal", languages: [
        { languageId: 4105, pageTitle: "News Release", headline: "Clinics open", subheadline: null, organizations: "Ministry of Health", byline: null, bodyHtml: "<p>Body</p>", pageImageId: null, contacts: ["Media"] },
        { languageId: 3084, pageTitle: "Communiqué", headline: "Cliniques", subheadline: null, organizations: "Ministère", byline: null, bodyHtml: "<p>Corps</p>", pageImageId: null, contacts: ["Médias"] },
      ] }],
    });
    const t = renderText(v, opts);
    expect(t).toContain("(disponible en français en bas de page)");
    expect(t).toContain("Renseignements additionnels:");
    expect(t.indexOf("CLINICS")).toBeLessThan(0); // page titles are upper-cased, headlines are not
    expect(t.indexOf("NEWS RELEASE")).toBeLessThan(t.indexOf("COMMUNIQUÉ"));
  });

  it("PDF is a valid document titled with the headline, and tolerates unencodable characters", async () => {
    const pdf = await renderPdf(view({ documents: [{ id: "d1", sortIndex: 0, layout: "formal", languages: [
      { languageId: 4105, pageTitle: "News Release", headline: "Clinics open 中文", subheadline: null, organizations: "Ministry of Health", byline: null, bodyHtml: `<p>${"Long paragraph. ".repeat(400)}</p>`, pageImageId: null, contacts: ["Media"] },
    ] }] }), opts);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(doc.getTitle()).toBe("Clinics open 中文");
  });
});
```

Add to `routes.test.ts`: `GET /api/releases/:id/text` → 200 `text/plain` containing the headline; `GET …/pdf` → 200 `application/pdf`, body starts with `%PDF-`; viewer allowed; malformed id → 404.

- [ ] **Step 3: Run to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms/src/renditions`
Expected: FAIL.

- [ ] **Step 4: Implement**

Implement `model.ts`, `text.ts`, `pdf.ts` per the rules above. `mergeLocation` uses `htmlparser2`'s `parseDocument` + `domutils`' `getOuterHTML`-style serialisation (`dom-serializer`, a dependency of htmlparser2 — add it explicitly with `npx -y npm@11 install dom-serializer@^2 -w @gcpe/nrms` if it isn't already a direct dependency). In `pdf.ts`, convert each document's body to paragraphs with `htmlToText`, split on blank lines, wrap each with `font.widthOfTextAtSize`, and map characters missing from `font.getCharacterSet()` to `?` before drawing. Set the title with `pdf.setTitle(<first English headline>)` (metadata may hold any Unicode).

If an expected string in the text test is off only by blank-line placement produced by the legacy collapse rules, check the legacy behaviour in `/Users/paul/HUB/gcpe-hub-develop/Hub.Legacy/Gcpe.News.ReleaseManagement.Templates/Release.cs` (`ToTextDocumentAsString`, `ToTextDocument`) and `Resources/ReleaseText.txt` / `DocumentText.txt`; match legacy and update the expectation, noting it in the report.

- [ ] **Step 5: Run to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms && npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/nrms package-lock.json
git commit -m "feat(nrms): text and PDF versions of a release following the legacy templates"
```

---

### Task 11: "Email me a copy"

**Files:**
- Modify: `apps/distribution/src/messages.ts`, `apps/distribution/src/db/schema.ts`, `apps/distribution/src/sender.ts`, `apps/distribution/src/http/routes.test.ts`, `apps/distribution/src/sender.test.ts`, `apps/nrms/src/clients.ts`, `apps/nrms/src/clients.test.ts`, `apps/nrms/src/start.ts`, `apps/nrms/src/http/routes.ts`, `apps/nrms/src/http/routes.test.ts`
- Create: `apps/distribution/migrations/<next>_attachments.sql` (generated)

**Interfaces:**
- Distribution `messageRequestSchema` gains `attachments: z.array(z.object({ filename: z.string().min(1).max(200).regex(/^[^\\/\r\n"]+$/), contentType: z.enum(["application/pdf", "text/plain"]), contentBase64: z.string().max(10_000_000) })).max(3).default([])`, refined so the decoded total is ≤ 7 MiB ("attachments exceed 7 MiB"). Stored on the batch (`attachments jsonb not null default '[]'`) and passed to nodemailer as `{ filename, content: Buffer.from(b64, "base64"), contentType }` on every message of the batch.
- NRMS `clients.ts`: `distributionClient(opts: { baseUrl: string; getToken: () => Promise<string>; fetchImpl?: typeof fetch }): { send(msg: MessageRequestLike): Promise<{ batchId: string }> }` (non-2xx → throws with the status).
- NRMS env: `DISTRIBUTION_URL` (optional; stack default from Task 9) and `DISTRIBUTION_TOKEN_URL|CLIENT_ID|CLIENT_SECRET|SCOPE`; token via `serviceTokenProvider({ subject: "nrms", roles: ["Distribution.Send"], envPrefix: "DISTRIBUTION", local: auth.local })`.
- Route `POST /api/releases/:id/email-copy` (`{}` body; any read role): recipient = the caller's session email (`req.auth.claims.email`); none → 422 `{ error: "Your account has no email address to send to." }`; Distribution not configured → 503 `{ error: "Email isn't configured." }`. Sends priority `system`, subject `` `${v.reference ? "FINAL" : "DRAFT"} - ${headline}` ``, an HTML summary table (Reference, Key, Type, Status, Date, Media lists, Lead organization, Headline — all HTML-escaped with `escapeHtml` from `@gcpe/http-kit`) followed by the text version in `<pre>`, `text` = the text version, and two attachments: `<DRAFT|FINAL>-<key or id>.pdf` and `.txt`. Logs `"Emailed a copy to <email>"` (no version bump — read-only action; use `writeLog` directly). Returns `202 { sentTo: email }`.

- [ ] **Step 1: Write the failing tests**

- Distribution routes test: a message with one PDF attachment is accepted (202/201 per the existing route) and stored; 4 attachments → 400; a filename with `/` → 400; decoded size over 7 MiB → 400.
- Distribution sender test: the SMTP sink receives the attachment with the right filename and content type (follow the file's existing sink pattern).
- NRMS clients test: `distributionClient.send` posts JSON with bearer auth; non-2xx rejects.
- NRMS routes test: with a fake `distribution` injected into the routes' deps, `POST /api/releases/:id/email-copy` as an editor whose session email is `editor@example.test` → 202 `{ sentTo: "editor@example.test" }`, the captured message has subject `DRAFT - Weekend clinics open across B.C.`, two attachments named `DRAFT-<id>.pdf`/`.txt`, and the release log gains `Emailed a copy to editor@example.test`; a session without email → 422; no distribution configured → 503.

- [ ] **Step 2: Run to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/distribution apps/nrms`
Expected: FAIL.

- [ ] **Step 3: Implement**

Distribution: schema + generated migration (`cd apps/distribution && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name attachments`), store on batch insert, pass to nodemailer in `sender.ts` (read how the sender builds each mail and add `attachments` there). NRMS: client, start.ts wiring (`distribution?: ReturnType<typeof distributionClient>` in the routes' deps), route.

- [ ] **Step 4: Run to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json && npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`
Expected: PASS (full suite).

- [ ] **Step 5: Commit**

```bash
git add apps/distribution apps/nrms package-lock.json
git commit -m "feat(nrms): email me a copy (PDF and text) through Distribution, which now supports attachments"
```
