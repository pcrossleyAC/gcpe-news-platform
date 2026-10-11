# Phase 6a: Search Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tenant flags, search language and site theme (with its contrast check); the `@gcpe/embeddings` package (provider interface, Azure OpenAI and stand-in providers, circuit breaker); full-text search columns on the News API's `posts`, written on every post write and backfilled by `news-api:search-backfill`; and `GET /api/v2/search` in text mode. News API v1 must not change.

**Architecture:**
- **Config first.** `@gcpe/config` gains `features`, `search.language` and `site.theme`. The loader refuses a theme that fails WCAG AA contrast on the spec's three pairs.
- **The embeddings package stands alone.** It holds:
  - the `EmbeddingProvider` interface;
  - `standInProvider` (SHA-256 feature hashing, so texts that share words are close);
  - `azureOpenAiProvider` (plain `fetch`, `dimensions: 1536` pinned, a clamped timeout);
  - env settings that refuse the stand-in on a real production deployment;
  - `CircuitBreaker`, and `createGuardedEmbedder`, the one place a provider failure is logged.
  
  It also holds the HTML-to-text helper, which the News API's search text uses now and 6b's embedding source text will use later. Nothing in the News API calls a provider in 6a.
- **Search text is written by the projection.** `applyRelease` is the one write path for both NRMS events and the legacy importer. It computes `search_text`, capped at 100,000 characters. Postgres generates `search_vector` from it (`to_tsvector('english'::regconfig, …)`, GIN-indexed). The News API refuses to start when the tenant's `search.language` differs from the column's configuration.
- **v2 is a separate router with a mode seam.** It is mounted at `/api/v2` before v1's `/api` router, so v1's `api-version` rule and its problem-JSON 404 never apply to v2. `createSearchService` takes an optional `semantic` branch (6b), which returns a page or `null`. With no branch, or `null`, or a throw, the service runs `textSearch` and answers `mode: "text"`. `textSearch` and `searchFilters` are exported so 6b's text branch can reuse them with `excludeKeys`.

**Tech Stack:** Node 24, TypeScript 5.9, Express 5, Drizzle 0.45 / drizzle-kit 0.31 on Postgres, zod 3.25, htmlparser2 10, Vitest 4.1, supertest.

**Spec:** `docs/superpowers/specs/2026-10-11-public-site-ai-design.md` (the Phase 6 addendum), §10's 6a row:
- §3 (tenant config);
- §4 (`packages/embeddings`);
- §5.1 (full-text columns and the backfill);
- §5.4: `GET /api/v2/search`'s inputs, text mode, fallback shape, response, logging and caching only;
- §8's "v2 route errors" and runbook lines that apply to 6a;
- §9's unit lines for the provider contract, the stand-in's fixed output, breaker state changes, HTML stripping and the contrast check; its integration line "full-text ranking and filters";
- §11 C201–C204 and §12 Q70–Q73, added to the parity lists as written.

Parent spec sections read: §3.3 (packages), §3.5 (tenant config), §6.1–6.3 (the v1 contract, v2, store and caching) and §10.1 (staff AI behind a flag).

**Not in 6a** (6b onward): the embedding worker, `post_embeddings`, pgvector, semantic mode, related posts, the change feed, `/stack/health`'s `newsApiSearch`, the public site pages and staff help.

---

## Decisions made in planning

Each of these is a ruling made against the code at `35953d5`. Spec conflicts are marked.

1. **`/stack/health`'s `newsApiSearch` waits for 6b.** It describes a three-way condition (flag, provider, pgvector), and 6a can't detect pgvector. A field that always says `text` would be churn in the stack's cached health code, and each search response already reports its `mode`.
2. **v2 has no `api-version` rule.** v1's `requireApiVersion` and its problem-JSON 404 live on the `/api` router. v2 is mounted at `/api/v2` *before* that router, with its own `Cache-Control: no-store` and its own JSON 404 (`{ "error": "not found" }`).
   - The only visible difference is for paths under `/api/v2/`, which used to answer v1's 400 `ApiVersionUnspecified`. No v1 endpoint lives there, and no compat fixture probes it.
3. **Spec conflict, §4:** "the deploy check refuses `stand-in` when `NODE_ENV=production`." boxs.ca runs `NODE_ENV=production` (`scripts/siteground-env.ts`), and D2 puts the stand-in there.
   - Ruling: refuse it on a *real* production deployment, using the platform's existing test-site rule (`isTestSite`, `apps/public-site/src/site-env.ts`, ruling C39). That means `NODE_ENV=production` and neither `LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true` nor `SITE_ENVIRONMENT=test`.
   - The refusal lives in `newsApiEnvSchema`, so both `startNewsApi` and `node stack.js --check` (the deploy check) apply it.
4. **Spec conflict, §3:** the spec lists `siteName` inside `site.theme`. The tenant already has a top-level `siteName`, which the public site uses as `SITE_NAME`'s default.
   - Ruling: keep the one top-level `siteName`, and don't add a second.
   - The unused `branding` block (`primaryColor`, `logoUrl`; no reader outside tests) is removed. `site.theme` supersedes it, so there is one source of colours.
5. **`search_text` is capped at 100,000 characters.** Postgres refuses a `tsvector` over 1 MB (`string is too long for tsvector`). This was verified on local Postgres 14.17: about 2 MB of distinct words fails.
   - Without the cap, one very long release would fail `applyRelease`, and so the NRMS event and the import, because the column is generated.
   - 100,000 characters of distinct hex words make a tsvector of about 120 KB.
6. **What `search_text` contains:** every document's headline, then summary, keywords and location, then every document's subheadline and body, with HTML stripped and whitespace collapsed.
   - Subheadlines are added to the spec's list because they are part of the visible release.
   - The response's `headline` is the tenant's default-language document's headline, else the first document's. This is the public site's `english()` rule (`apps/public-site/src/render.ts:27`).
7. **The embedding env is the News API's own.** On the stack it is `NEWSAPI_EMBEDDINGS_PROVIDER`, `NEWSAPI_AZURE_OPENAI_*` and `NEWSAPI_EMBEDDINGS_TIMEOUT_MS`, through `resolvedEnvFor`'s prefix stripping. No other app embeds: 6d's NRMS calls the News API.
   - `siteground:env` doesn't change in 6a; nothing calls a provider yet. 6b adds `NEWSAPI_EMBEDDINGS_PROVIDER=stand-in` with the worker.
8. **The Azure provider uses `fetch`, not the `openai` SDK:** one POST, so no new dependency.
   - The model is fixed at `text-embedding-3-small` (D2), whatever the deployment is called.
   - The default `AZURE_OPENAI_API_VERSION` is `2024-10-21`. *Assumed:* this is the GA version that accepts `dimensions` for v3 models; Q70's deployment settles it, and the env var overrides it.
9. **Result `url`:** the News API's `PUBLIC_SITE_URL` + `/releases/<key>`. This is the path both BC's webapp and `apps/public-site` serve.
   - `PUBLIC_SITE_URL` is new and optional, defaulting to the tenant's `publicSiteBaseUrl`.
   - The stack defaults it to the public site's own `SITE_PUBLIC_SITE_URL`, as it already does for NRMS's `PUBLIC_FILES_BASE`. On boxs.ca a result therefore links to `https://boxs.ca/site/releases/<key>`, not to news.gov.bc.ca.
10. **Omitted `type` searches every published kind.** v1's `postKind` default (releases and stories) is a v1 compatibility rule and doesn't carry over.
11. **Bounded inputs:**
    - `q` is 1–200 Unicode code points after trimming;
    - `ministry` and `sector` are 1–100 characters;
    - `type` is one of the five post kinds;
    - dates are `YYYY-MM-DD` real calendar dates in years 1900–2199 (the platform's existing year bound), with `from` ≤ `to`;
    - `page` is a whole number from 1 to 50.
    
    A repeated parameter is a 400. The 400 body is `{ "error": { "code": "InvalidParameter", "parameter": "<name>", "message": "<rule>" } }`, and it never echoes the value.
12. **The backfill doesn't run migrations.** The running News API does that at startup. The CLI checks that `posts.search_text` exists and otherwise tells the operator to start the News API first.
    - Each batch is one transaction that locks its rows (`FOR UPDATE`). So a post that NRMS rewrites mid-backfill keeps the search text its own write computed.
    - The default mode only fills `NULL` rows; `--all` recomputes every row.
13. **The breaker counts every failure, including timeouts.** Whether a caller's own cancellation (a visitor closing the page) should count is left to 6b, the first caller.

---

## Global Constraints

- **Worktree and commits:**
  - Work on `feat/phase-6` in `/Users/paul/gcpe-news-platform-p6`. Commit locally after each task, with a plain message. Don't push until the branch is reviewed.
  - **Never add `Co-Authored-By` or any AI attribution** to a commit. Never commit `CLAUDE.md`.
  - **No task, decision or round labels in code comments** ("Task 3", "ruling 5", "fix round 1"). Spec row ids (C201, Q70) and spec section numbers are fine.
- **Node 24 for everything:**
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`.
  - Packages: `npx -y -p node@24 -- npm install --ignore-scripts`. The worktree has no `node_modules` yet, so run `npx -y -p node@24 -- npm ci --ignore-scripts` first.
  - Tests need the local Postgres (`TEST_DATABASE_ADMIN_URL`, default `postgres://localhost:5432/postgres`).
- **Every behaviour change starts with a real RED run:** run the new test, see it fail for the stated reason, then implement.
- **No debug logging.** Logs carry `safeErrorLabel` plus the route, command or provider id only. Never a search term, a query string, a headline or an embedding input.
- **Migrations only through drizzle-kit,** from the app folder: `cd apps/news-api && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`. Never hand-edit generated DDL. The generated column is drizzle-kit's own output (verified while planning).
- **News API v1 behaviour and responses must not change.** These suites stay green, unedited:
  - `apps/news-api/test/compat.test.ts` ("News API v1 compatibility with recorded live responses");
  - `apps/news-api/test/e2e-core.test.ts`;
  - `apps/news-api/src/http/v1/*.test.ts`;
  - `apps/news-api/src/app.test.ts`.
- **Privacy:** `example.test` addresses and fictional names only. No legacy data enters the repo.
- **Parity lists:**
  - `docs/parity/changes-from-legacy.md` gets C201–C204 exactly as spec §11 (the highest today is C200).
  - `docs/parity/open-questions.md` gets Q70–Q73 exactly as spec §12 (the highest today is Q69).
  - Check that no number is duplicated: `grep -oE "^\| C2[0-9]{2}" docs/parity/changes-from-legacy.md | sort | uniq -d` and `grep -oE "^\| Q[0-9]+" docs/parity/open-questions.md | sort | uniq -d` both print nothing.
- **Running notes:** each task adds role-tagged lines to `docs/manuals/running-notes.md` under `## Phase 6a — Search foundations`. The tags are the legend's: Editor, Site editor, Viewer, Administrator, Operations, Developer.
- **Runbook:** `docs/deploy/siteground.md` gets a `## Search and embeddings (Phase 6a)` section, inserted just before `## Troubleshooting`. Tasks 2, 4 and 5 each add their own subsection.

## Review Focus

These are the five inputs most likely to bite a person, which the spec implies but doesn't spell out. Each one has a test in the task named.

1. **A release whose body is longer than a tsvector can hold** (about 2 MB of distinct words). It must still publish and import, with `search_text` capped, not fail the NRMS event. Task 4: "still applies a release whose body would overflow a tsvector".
2. **A query of only stop words or punctuation** (`the`, `!!!`) passes the 1–200 rule, but `websearch_to_tsquery` turns it into an empty query. It must answer 200 with `total: 0`, never a 500. Task 5: "a stop-word-only or punctuation-only query matches nothing and does not fail".
3. **A post written by NRMS while the backfill runs** must keep its fresh search text, not the backfill's stale copy. The default mode only touches `NULL` rows, and every batch locks its rows. Task 4: "default mode leaves rows that already have search text alone; --all recomputes them".
4. **Malformed or repeated parameters:**
   - `q` given twice; `page=1.5`, `0` or `51`;
   - `from=2026-02-30`, `from=0099-01-01`, `to` before `from`;
   - an unknown `type`.
   
   Each must be a 400 that names the parameter and never echoes the value; never a 500, and never a silent default. Task 5: the `it.each` table in `http/v2/search.test.ts`.
5. **BC calendar-day boundaries:** `from=2026-10-01` must include a post at 00:30 BC time that day, `to=2026-10-01` must include one at 23:59 BC time, and neither may include midnight of the 2nd. Task 5: "from and to are whole BC calendar days".

---

## File structure

**Created:**
- `packages/config/src/theme.ts`: `contrastRatio`, `WCAG_AA_TEXT_CONTRAST`, `siteThemeSchema`, `SiteTheme`.
- `packages/config/src/theme.test.ts`.
- `packages/embeddings/package.json`.
- `packages/embeddings/src/index.ts`: the package's exports.
- `packages/embeddings/src/provider.ts`: `EmbeddingProvider` and `EmbeddingError`.
- `packages/embeddings/src/text.ts`: `htmlToPlainText`, `collapseWhitespace` and `normaliseForEmbedding`.
- `packages/embeddings/src/stand-in.ts`: `standInProvider`.
- `packages/embeddings/src/azure-openai.ts`: `azureOpenAiProvider`.
- `packages/embeddings/src/timeout.ts`: `clampTimeoutMs`.
- `packages/embeddings/src/settings.ts`: the env shape, its refinement and `createEmbeddingProvider`.
- `packages/embeddings/src/breaker.ts`: `CircuitBreaker` and `BreakerOpenError`.
- `packages/embeddings/src/guarded.ts`: `createGuardedEmbedder`.
- `packages/embeddings/src/*.test.ts`: one per source file.
- `apps/news-api/migrations/0003_post_search.sql`, plus `meta/0003_snapshot.json` and the journal entry (all generated).
- `apps/news-api/src/search/search-text.ts`: `searchTextFor` and `SEARCH_TEXT_MAX_CHARS`.
- `apps/news-api/src/search/language.ts`: `searchVectorLanguage` and `assertSearchLanguage`.
- `apps/news-api/src/search/query.ts`: `parseSearchQuery`, `SearchQuery` and the limits.
- `apps/news-api/src/search/text-search.ts`: `searchFilters`, `textSearch`, `SearchRow` and `SearchPage`.
- `apps/news-api/src/search/service.ts`: `createSearchService`, `SearchService`, `SemanticSearch` and `SearchResponse`.
- `apps/news-api/src/search/*.test.ts`.
- `apps/news-api/src/http/v2/routes.ts`: `v2Routes`.
- `apps/news-api/src/http/v2/search.test.ts`.
- `apps/news-api/src/cli/search-backfill.ts`, with `search-backfill.test.ts`.

**Modified:**
- `packages/config/src/tenant.ts`, `index.ts` and `tenant.test.ts`.
- `config/tenants/bc.json` and `nb.json`.
- `apps/public-site/src/env.test.ts`: its `TenantConfig` literal.
- `apps/news-api/package.json`: the `@gcpe/embeddings` dependency and the `search-backfill` script.
- The root `package.json`: the `news-api:search-backfill` script.
- `package-lock.json` (by `npm install`).
- `apps/news-api/src/env.ts`, `env.test.ts`, `start.ts`, `start.test.ts`, `app.ts`, `db/schema.ts`, `projections.ts`, `projections.test.ts` and `posts.ts`.
- `apps/stack/src/stack.ts` (the default `PUBLIC_SITE_URL`) and `stack-check.test.ts`.
- Docs: `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/manuals/running-notes.md` and `docs/deploy/siteground.md`.

---

### Task 1: Tenant flags, search language and the site theme with its contrast check

**Risk:** low. **Review:** shared review A, with Task 2.

**Files:**
- Create: `packages/config/src/theme.ts`, `packages/config/src/theme.test.ts`
- Modify: `packages/config/src/tenant.ts`, `packages/config/src/index.ts`, `packages/config/src/tenant.test.ts`, `config/tenants/bc.json`, `config/tenants/nb.json`, `apps/public-site/src/env.test.ts`, `docs/manuals/running-notes.md`

**Interfaces:**
- Consumes: nothing new.
- Produces, from `@gcpe/config`:
  - `contrastRatio(a: string, b: string): number`;
  - `WCAG_AA_TEXT_CONTRAST = 4.5`;
  - `siteThemeSchema`;
  - `type SiteTheme`;
  - `searchLanguageSchema` (`z.enum(["english", "french", "simple"])`);
  - `type SearchLanguage`.
  
  `TenantConfig` gains these fields (with `branding` removed):
  - `features: { semanticSearch: boolean; staffAi: boolean }`, both defaulting to false;
  - `search: { language: SearchLanguage }`, defaulting to `english`;
  - `site: { theme: SiteTheme }`, required.

- [ ] **Step 1: Write the failing theme tests**

`packages/config/src/theme.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { contrastRatio, siteThemeSchema, WCAG_AA_TEXT_CONTRAST } from "./theme";

const theme = {
  colors: {
    primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D",
    mutedText: "#474543", surface: "#F2F2F2", background: "#FFFFFF", border: "#D8D8D8",
  },
  font: { family: "Example Sans", fallback: "Verdana, Arial, sans-serif" },
  logo: { path: "assets/logo.svg", alt: "Example Government" },
  footerLinks: [{ label: "Privacy", url: "https://example.test/privacy" }],
};

describe("contrastRatio", () => {
  it("is 21:1 for black on white and 1:1 for a colour on itself, in either order", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#013366", "#013366")).toBeCloseTo(1, 10);
  });

  it("puts #767676 on white just above AA and #777777 just below", () => {
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(WCAG_AA_TEXT_CONTRAST);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(WCAG_AA_TEXT_CONTRAST);
  });
});

describe("siteThemeSchema", () => {
  it("accepts a theme whose three checked pairs pass AA", () => {
    expect(siteThemeSchema.safeParse(theme).success).toBe(true);
  });

  it.each([
    ["text", "background", { text: "#777777", background: "#FFFFFF" }],
    ["text", "surface", { text: "#777777", surface: "#FFFFFF" }],
    ["primaryText", "primary", { primaryText: "#FFFFFF", primary: "#FCBA19" }],
  ])("refuses %s on %s below 4.5:1, naming the pair", (fg, bg, colors) => {
    const result = siteThemeSchema.safeParse({ ...theme, colors: { ...theme.colors, ...colors } });
    expect(result.success).toBe(false);
    const issue = result.error!.issues[0]!;
    expect(issue.path).toEqual(["colors", fg]);
    expect(issue.message).toContain(`${fg} `);
    expect(issue.message).toContain(` on ${bg} `);
    expect(issue.message).toContain("4.5:1");
  });

  it("refuses a colour that isn't #RRGGBB", () => {
    const result = siteThemeSchema.safeParse({ ...theme, colors: { ...theme.colors, accent: "gold" } });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.path).toEqual(["colors", "accent"]);
  });

  it.each(["/etc/logo.svg", "../logo.svg", "assets/../../logo.svg", "https://example.test/logo.svg", ""])(
    "refuses logo path %j: it must be a relative path under the site's assets",
    (path) => {
      expect(siteThemeSchema.safeParse({ ...theme, logo: { path, alt: "x" } }).success).toBe(false);
    },
  );

  it("accepts an optional font stylesheet URL and refuses a non-URL", () => {
    expect(siteThemeSchema.safeParse({ ...theme, font: { ...theme.font, stylesheetUrl: "https://example.test/font.css" } }).success).toBe(true);
    expect(siteThemeSchema.safeParse({ ...theme, font: { ...theme.font, stylesheetUrl: "font.css" } }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/config/src/theme.test.ts`
Expected: FAIL, "Failed to resolve import "./theme"".

- [ ] **Step 3: Implement `theme.ts`**

`packages/config/src/theme.ts`:

```ts
import { z } from "zod";

/** WCAG 2.2 AA minimum contrast for normal-size text (success criterion 1.4.3). */
export const WCAG_AA_TEXT_CONTRAST = 4.5;

function channel(hex: string, offset: number): number {
  const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** WCAG contrast ratio of two #RRGGBB colours, from 1 to 21. The order doesn't matter. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const hex = (name: string) => z.string().regex(/^#[0-9a-fA-F]{6}$/, `${name} must be #RRGGBB`);

const colorsSchema = z.object({
  primary: hex("primary"),
  primaryText: hex("primaryText"),
  accent: hex("accent"),
  text: hex("text"),
  mutedText: hex("mutedText"),
  surface: hex("surface"),
  background: hex("background"),
  border: hex("border"),
});

/** The pairs spec §3 checks: foreground first. */
const CHECKED_PAIRS = [
  ["text", "background"],
  ["text", "surface"],
  ["primaryText", "primary"],
] as const;

// Relative, no leading slash, no "..", no URL scheme: the file lives in the site's own assets.
const ASSET_PATH = /^(?![A-Za-z][A-Za-z0-9+.-]*:)(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

export const siteThemeSchema = z
  .object({
    colors: colorsSchema,
    font: z.object({
      family: z.string().min(1),
      fallback: z.string().min(1),
      stylesheetUrl: z.string().url().optional(),
    }),
    logo: z.object({
      path: z.string().regex(ASSET_PATH, "logo.path must be a relative path under the site's assets"),
      alt: z.string().min(1),
    }),
    footerLinks: z.array(z.object({ label: z.string().min(1), url: z.string().url() })),
  })
  .superRefine((theme, ctx) => {
    for (const [fg, bg] of CHECKED_PAIRS) {
      const ratio = contrastRatio(theme.colors[fg], theme.colors[bg]);
      if (ratio < WCAG_AA_TEXT_CONTRAST) {
        // Floored, so a failing 4.499 never prints as a passing-looking "4.50".
        const shown = (Math.floor(ratio * 100) / 100).toFixed(2);
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["colors", fg],
          message: `${fg} ${theme.colors[fg]} on ${bg} ${theme.colors[bg]} has contrast ${shown}:1, below WCAG AA ${WCAG_AA_TEXT_CONTRAST}:1`,
        });
      }
    }
  });

export type SiteTheme = z.infer<typeof siteThemeSchema>;
```

- [ ] **Step 4: Run the theme tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/config/src/theme.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Write the failing tenant tests**

In `packages/config/src/tenant.test.ts`:

1. Add the imports and a theme next to `valid`.
2. Replace `valid`'s `branding` line with `site: { theme }`.
3. Change the existing "rejects a malformed brand colour" test so it targets `site.theme.colors.primary`.

```ts
import { contrastRatio, WCAG_AA_TEXT_CONTRAST } from "./theme";

const theme = {
  colors: {
    primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D",
    mutedText: "#474543", surface: "#F2F2F2", background: "#FFFFFF", border: "#D8D8D8",
  },
  font: { family: "Example Sans", fallback: "Verdana, Arial, sans-serif" },
  logo: { path: "assets/logo.svg", alt: "Example Government" },
  footerLinks: [],
};

const valid = {
  tenantId: "bc",
  siteName: "BC Gov News",
  timeZone: "America/Vancouver",
  defaultLanguageId: 4105,
  organizationLabel: { singular: "Ministry", plural: "Ministries" },
  publicSiteBaseUrl: "https://news.gov.bc.ca",
  site: { theme },
};
```

Replace the "rejects a malformed brand colour" test with:

```ts
  it("rejects a malformed theme colour", () => {
    expect(() =>
      loadTenantConfig(writeTemp({ ...valid, site: { theme: { ...theme, colors: { ...theme.colors, primary: "blue" } } } })),
    ).toThrow(/site\.theme\.colors\.primary/);
  });
```

Add inside `describe("loadTenantConfig", …)`:

```ts
  it("defaults features off and the search language to english when absent", () => {
    const cfg = loadTenantConfig(writeTemp(valid));
    expect(cfg.features).toEqual({ semanticSearch: false, staffAi: false });
    expect(cfg.search).toEqual({ language: "english" });
  });

  it("rejects a search language Postgres configuration outside english, french and simple", () => {
    expect(() => loadTenantConfig(writeTemp({ ...valid, search: { language: "german" } }))).toThrow(/search\.language/);
  });

  it("refuses a theme below WCAG AA and names the failing pair", () => {
    const failing = { ...theme, colors: { ...theme.colors, text: "#777777" } };
    expect(() => loadTenantConfig(writeTemp({ ...valid, site: { theme: failing } }))).toThrow(
      /site\.theme\.colors\.text: text #777777 on background #FFFFFF has contrast 4\.4\d:1, below WCAG AA 4\.5:1/,
    );
  });

  it("requires a site theme", () => {
    const { site: _site, ...noSite } = valid;
    expect(() => loadTenantConfig(writeTemp(noSite))).toThrow(/site/);
  });

  it.each(["bc", "nb"])("loads the committed %s config with flags off, english search and a theme that passes", (id) => {
    const cfg = loadTenantConfig(fileURLToPath(new URL(`../../../config/tenants/${id}.json`, import.meta.url)));
    expect(cfg.features).toEqual({ semanticSearch: false, staffAi: false });
    expect(cfg.search.language).toBe("english");
    const c = cfg.site.theme.colors;
    // The spec checks three pairs. The committed themes also keep muted text readable.
    for (const [fg, bg] of [[c.mutedText, c.background], [c.mutedText, c.surface]] as const) {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(WCAG_AA_TEXT_CONTRAST);
    }
  });

  it("gives BC BC Sans, BC blue, BC gold and BC's logo", () => {
    const cfg = loadTenantConfig(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url)));
    expect(cfg.site.theme.font.family).toBe("BC Sans");
    expect(cfg.site.theme.colors.primary).toBe("#013366");
    expect(cfg.site.theme.colors.accent).toBe("#FCBA19");
    expect(cfg.site.theme.logo.path).toBe("assets/bc-logo.svg");
  });
```

- [ ] **Step 6: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/config/src/tenant.test.ts`
Expected: FAIL. `features`, `search` and `site` are undefined, and the committed configs have no theme.

- [ ] **Step 7: Extend the schema and the exports**

In `packages/config/src/tenant.ts`:
- add `import { siteThemeSchema } from "./theme";`;
- add the language schema above `tenantConfigSchema`;
- replace the `branding` field with the three new fields.

```ts
/** A Postgres text-search configuration. It must match the News API's posts.search_vector column. */
export const searchLanguageSchema = z.enum(["english", "french", "simple"]);
export type SearchLanguage = z.infer<typeof searchLanguageSchema>;
```

```ts
  /** Spec §3. Semantic search and staff AI each also need a provider and pgvector; both default off. */
  features: z
    .object({ semanticSearch: z.boolean().default(false), staffAi: z.boolean().default(false) })
    .default({}),
  search: z.object({ language: searchLanguageSchema.default("english") }).default({}),
  /** The public site's theme. The loader refuses one that fails WCAG AA contrast (siteThemeSchema). */
  site: z.object({ theme: siteThemeSchema }),
```

In `packages/config/src/index.ts`, change the first line and add the theme exports:

```ts
export { assertTimeZoneRules, loadTenantConfig, searchLanguageSchema, tenantConfigSchema, type SearchLanguage, type TenantConfig } from "./tenant";
export { contrastRatio, siteThemeSchema, WCAG_AA_TEXT_CONTRAST, type SiteTheme } from "./theme";
```

- [ ] **Step 8: Give BC and NB their themes**

In `config/tenants/bc.json`, replace the `"branding"` line with:

```json
  "features": { "semanticSearch": false, "staffAi": false },
  "search": { "language": "english" },
  "site": {
    "theme": {
      "colors": {
        "primary": "#013366", "primaryText": "#FFFFFF", "accent": "#FCBA19", "text": "#2D2D2D",
        "mutedText": "#474543", "surface": "#F2F2F2", "background": "#FFFFFF", "border": "#D8D8D8"
      },
      "font": { "family": "BC Sans", "fallback": "\"Noto Sans\", Verdana, Arial, sans-serif" },
      "logo": { "path": "assets/bc-logo.svg", "alt": "Government of British Columbia" },
      "footerLinks": [
        { "label": "Disclaimer", "url": "https://www2.gov.bc.ca/gov/content/home/disclaimer" },
        { "label": "Privacy", "url": "https://www2.gov.bc.ca/gov/content/home/privacy" },
        { "label": "Accessibility", "url": "https://www2.gov.bc.ca/gov/content/home/accessible-government" },
        { "label": "Copyright", "url": "https://www2.gov.bc.ca/gov/content/home/copyright" }
      ]
    }
  },
```

In `config/tenants/nb.json`, replace the `"branding"` line with:

```json
  "features": { "semanticSearch": false, "staffAi": false },
  "search": { "language": "english" },
  "site": {
    "theme": {
      "colors": {
        "primary": "#1B365D", "primaryText": "#FFFFFF", "accent": "#C8102E", "text": "#1A1A1A",
        "mutedText": "#4D4D4D", "surface": "#F4F4F4", "background": "#FFFFFF", "border": "#CCCCCC"
      },
      "font": { "family": "Open Sans", "fallback": "Arial, sans-serif" },
      "logo": { "path": "assets/nb-logo.svg", "alt": "Government of New Brunswick" },
      "footerLinks": [{ "label": "Government of New Brunswick", "url": "https://www2.gnb.ca/" }]
    }
  }
```

The `nb.json` block is the file's last field, so keep its closing brace valid.

Contrast, computed while planning:
- **BC:** text/background 13.77, text/surface 12.30, primaryText/primary 12.60, mutedText/background 9.54.
- **NB:** 17.40, 15.82, 12.12 and 8.45.

The logo files and BC Sans themselves arrive with the site templates in 6c. The paths here are where they will live. *Assumed:* the footer URLs are BC's current footer targets; 6c's link check confirms them.

- [ ] **Step 9: Update the public site's `TenantConfig` literal**

In `apps/public-site/src/env.test.ts`, replace the literal's `branding` line with:

```ts
  features: { semanticSearch: false, staffAi: false },
  search: { language: "english" },
  site: {
    theme: {
      colors: {
        primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D",
        mutedText: "#474543", surface: "#F2F2F2", background: "#FFFFFF", border: "#D8D8D8",
      },
      font: { family: "BC Sans", fallback: "Verdana, Arial, sans-serif" },
      logo: { path: "assets/bc-logo.svg", alt: "Government of British Columbia" },
      footerLinks: [],
    },
  },
```

- [ ] **Step 10: Run the config and public-site tests, then type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/config apps/public-site/src/env.test.ts`
Expected: PASS.

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors. A `branding` left anywhere would show here.

- [ ] **Step 11: Running notes**

Append to `docs/manuals/running-notes.md`:

```markdown

## Phase 6a — Search foundations

- **Operations** — Each tenant config (`config/tenants/*.json`) now has `features` (`semanticSearch`, `staffAi`, both off), `search.language` (`english`, `french` or `simple`) and `site.theme` (colours, font, logo, footer links). A service refuses to start when the theme's text on background, text on surface, or primary text on primary is below 4.5:1 contrast; the error names the pair and the ratio. `branding` is gone: the theme replaces it.
```

- [ ] **Step 12: Commit**

```bash
git add packages/config config/tenants apps/public-site/src/env.test.ts docs/manuals/running-notes.md
git commit -m "feat(config): tenant feature flags, search language and an accessible site theme"
```

---

### Task 2: `@gcpe/embeddings`: providers, text helpers and the env settings

**Risk:** medium (an external call and a production guard). **Review:** shared review A, with Task 1.

**Files:**
- Create: `packages/embeddings/package.json`; `packages/embeddings/src/` `index.ts`, `provider.ts`, `text.ts`, `stand-in.ts`, `timeout.ts`, `azure-openai.ts` and `settings.ts`; and `text.test.ts`, `stand-in.test.ts`, `azure-openai.test.ts` and `settings.test.ts`.
- Modify:
  - `apps/news-api/package.json`, `apps/news-api/src/env.ts` and `apps/news-api/src/env.test.ts`;
  - `apps/stack/src/stack-check.test.ts`;
  - `package-lock.json`;
  - `docs/deploy/siteground.md` and `docs/manuals/running-notes.md`.

**Interfaces:**
- Consumes: `safeErrorLabel` isn't used here (Task 3 uses it).
- Produces, from `@gcpe/embeddings`:

```ts
export interface EmbeddingProvider {
  readonly id: string;           // "stand-in" | "azure-openai"
  readonly model: string;        // "stand-in-sha256-v1" | "text-embedding-3-small"
  readonly dimensions: number;   // 1536 for both
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}
export class EmbeddingError extends Error { readonly code: string }   // e.g. "embedding_http_429", "embedding_bad_response"
export function htmlToPlainText(html: string | null | undefined): string;
export function collapseWhitespace(s: string): string;
export function normaliseForEmbedding(text: string): string;
export function standInProvider(opts?: { dimensions?: number }): EmbeddingProvider;
export interface AzureOpenAiSettings { endpoint: string; apiKey: string; deployment: string; apiVersion: string; timeoutMs: number }
export function azureOpenAiProvider(s: AzureOpenAiSettings, fetchImpl?: typeof fetch): EmbeddingProvider;
export const embeddingsEnvShape: { … };              // zod fields, merged into an app's env schema
export type EmbeddingsEnv;                            // z.output of z.object(embeddingsEnvShape)
export function refineEmbeddingsEnv(env: EmbeddingsEnv, ctx: z.RefinementCtx): void;
export const embeddingsEnvSchema;                     // z.object(embeddingsEnvShape).superRefine(refineEmbeddingsEnv)
export function clampTimeoutMs(raw: string | number | undefined): number;  // default 1000, clamped 200–5000
export function createEmbeddingProvider(env: EmbeddingsEnv, fetchImpl?: typeof fetch): EmbeddingProvider | null;
```

- [ ] **Step 1: Scaffold the package and install**

`packages/embeddings/package.json`:

```json
{
  "name": "@gcpe/embeddings",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@gcpe/http-kit": "0.0.0",
    "domhandler": "^5.0.3",
    "htmlparser2": "^10.1.0",
    "zod": "^3.25.76"
  }
}
```

Add `"@gcpe/embeddings": "0.0.0",` to `apps/news-api/package.json`'s `dependencies`, after `"@gcpe/db-kit"`.

`packages/embeddings/src/index.ts`:

```ts
export { EmbeddingError, type EmbeddingProvider } from "./provider";
export { collapseWhitespace, htmlToPlainText, normaliseForEmbedding } from "./text";
export { standInProvider, STAND_IN_MODEL } from "./stand-in";
export { AZURE_EMBEDDING_DIMENSIONS, AZURE_EMBEDDING_MODEL, azureOpenAiProvider, type AzureOpenAiSettings } from "./azure-openai";
export { clampTimeoutMs } from "./timeout";
export {
  createEmbeddingProvider,
  DEFAULT_AZURE_API_VERSION,
  embeddingsEnvSchema,
  embeddingsEnvShape,
  refineEmbeddingsEnv,
  type EmbeddingsEnv,
} from "./settings";
```

Run: `npx -y -p node@24 -- npm install --ignore-scripts`
Expected: `node_modules/@gcpe/embeddings` links to `packages/embeddings`, and `package-lock.json` gains the workspace entry.

- [ ] **Step 2: Write the failing text and stand-in tests**

`packages/embeddings/src/text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { collapseWhitespace, htmlToPlainText, normaliseForEmbedding } from "./text";

describe("htmlToPlainText", () => {
  it("decodes entities, keeps inline words joined and separates blocks", () => {
    expect(htmlToPlainText("<p>Crews&nbsp;are <b>on</b>-site.</p><p>Call&#160;250&amp;more</p>end<br>line &lt;tag&gt;")).toBe(
      "Crews are on-site. Call 250&more end line <tag>",
    );
  });

  it("drops script and style content", () => {
    expect(htmlToPlainText("<p>Shown</p><script>alert(1)</script><style>p{color:red}</style>")).toBe("Shown");
  });

  it("copes with unclosed tags, plain text, null and empty", () => {
    expect(htmlToPlainText("<p>unclosed <b>bold")).toBe("unclosed bold");
    expect(htmlToPlainText("Drivers can expect…")).toBe("Drivers can expect…");
    expect(htmlToPlainText(null)).toBe("");
    expect(htmlToPlainText("")).toBe("");
  });

  it("puts table cells and list items apart", () => {
    expect(htmlToPlainText("<table><tr><td>Region</td><td>Count</td></tr></table><ul><li>One</li><li>Two</li></ul>")).toBe(
      "Region Count One Two",
    );
  });
});

describe("collapseWhitespace", () => {
  it("collapses runs of any whitespace (including no-break spaces) and trims", () => {
    expect(collapseWhitespace("  a \n\t b  c  ")).toBe("a b c");
  });
});

describe("normaliseForEmbedding", () => {
  it("lower-cases, folds compatibility forms and turns punctuation into single spaces", () => {
    expect(normaliseForEmbedding("WILDFIRE, Crews!  Ｆｉｒｅ")).toBe("wildfire crews fire");
  });
});
```

`packages/embeddings/src/stand-in.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { standInProvider } from "./stand-in";

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

describe("standInProvider", () => {
  const p = standInProvider();

  it("meets the provider contract: id, model, 1536 unit-length vectors, one per text, in order", async () => {
    expect(p.id).toBe("stand-in");
    expect(p.model).toBe("stand-in-sha256-v1");
    expect(p.dimensions).toBe(1536);
    const out = await p.embed(["one", "two words", ""]);
    expect(out).toHaveLength(3);
    for (const v of out) {
      expect(v).toHaveLength(1536);
      expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 10);
      expect(v.some(Number.isNaN)).toBe(false);
    }
    expect(await p.embed([])).toEqual([]);
  });

  it("gives fixed output: the same text always gets the same vector", async () => {
    const [v] = await p.embed(["Wildfire crews contain blaze near Kamloops"]);
    // Pinned while planning, from this exact algorithm.
    expect(createHash("sha256").update(JSON.stringify(v)).digest("hex")).toBe(
      "3b07e18bfffaad3afc2fb44d6417bd6f9eca86bddc15cef65ede3d0c06804438",
    );
  });

  it("puts texts that share words closer than texts that share none", async () => {
    const [a, b, c] = await p.embed([
      "Wildfire crews contain blaze near Kamloops",
      "Wildfire crews contain blaze near Kelowna",
      "School district budget announced",
    ]);
    expect(cosine(a!, b!)).toBeGreaterThan(0.8);
    expect(cosine(a!, c!)).toBeLessThan(0.2);
  });

  it("ignores case and punctuation", async () => {
    const [a, b] = await p.embed(["WILDFIRE, crews!", "wildfire crews"]);
    expect(cosine(a!, b!)).toBeCloseTo(1, 10);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/embeddings/src/text.test.ts packages/embeddings/src/stand-in.test.ts`
Expected: FAIL, "Failed to resolve import "./text"" and "./stand-in".

- [ ] **Step 4: Implement `provider.ts`, `text.ts` and `stand-in.ts`**

`packages/embeddings/src/provider.ts`:

```ts
/**
 * Turns texts into vectors (spec §4). Implementations never log: the input is release text,
 * and failures are logged once by createGuardedEmbedder with the provider id and a safe label.
 */
export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  /** One vector per text, in order. Rejects on any failure; never returns a partial result. */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/** A provider failure whose `code` is safe to log (safeErrorLabel reads it). */
export class EmbeddingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EmbeddingError";
  }
}
```

`packages/embeddings/src/text.ts`:

```ts
import { DomUtils, parseDocument } from "htmlparser2";
import type { ChildNode } from "domhandler";

const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption", "figure", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul",
]);
const SKIP = new Set(["script", "style", "noscript", "template", "head"]);

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Release HTML to one line of plain text: entities decoded, blocks separated by a space. */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return "";
  const out: string[] = [];
  const walk = (nodes: ChildNode[]): void => {
    for (const n of nodes) {
      if (DomUtils.isText(n)) {
        out.push(n.data);
      } else if (DomUtils.isTag(n) && !SKIP.has(n.name.toLowerCase())) {
        const block = BLOCK.has(n.name.toLowerCase());
        if (block) out.push(" ");
        walk(n.children);
        if (block) out.push(" ");
      }
    }
  };
  walk(parseDocument(html).children);
  return collapseWhitespace(out.join(""));
}

/** Lower case, NFKC, letters and digits only, single spaces. Used for hashing and cache keys. */
export function normaliseForEmbedding(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
```

`packages/embeddings/src/stand-in.ts`:

```ts
import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "./provider";
import { normaliseForEmbedding } from "./text";

export const STAND_IN_MODEL = "stand-in-sha256-v1";

/**
 * Each normalised word's SHA-256 picks four (index, sign) slots; the sum is scaled to unit
 * length. Fixed output for a given text, and texts that share words share slots, so they are
 * closer: enough for ranking tests to mean something. Not a language model.
 */
function vectorFor(text: string, dimensions: number): number[] {
  const words = normaliseForEmbedding(text).split(" ").filter((w) => w.length > 0);
  const v = new Float64Array(dimensions);
  for (const word of words.length > 0 ? words : [""]) {
    const h = createHash("sha256").update(word, "utf8").digest();
    for (let k = 0; k < 4; k++) {
      const index = h.readUInt32BE(k * 8) % dimensions;
      v[index]! += (h[k * 8 + 4]! & 1) === 1 ? 1 : -1;
    }
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return Array.from(v, (x) => x / norm);
}

export function standInProvider(opts: { dimensions?: number } = {}): EmbeddingProvider {
  const dimensions = opts.dimensions ?? 1536;
  return {
    id: "stand-in",
    model: STAND_IN_MODEL,
    dimensions,
    async embed(texts) {
      return texts.map((t) => vectorFor(t, dimensions));
    },
  };
}
```

The empty text hashes the empty word, so its vector is never all zeros and never `NaN`.

- [ ] **Step 5: Run them to see them pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/embeddings/src/text.test.ts packages/embeddings/src/stand-in.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Write the failing Azure and settings tests**

`packages/embeddings/src/azure-openai.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { azureOpenAiProvider } from "./azure-openai";
import { EmbeddingError } from "./provider";

const settings = {
  endpoint: "https://embeddings.example.test/",
  apiKey: "test-key-not-real",
  deployment: "embed small",
  apiVersion: "2024-10-21",
  timeoutMs: 1000,
};
const vec = (seed: number) => Array.from({ length: 1536 }, (_, i) => (i === seed ? 1 : 0));
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("azureOpenAiProvider", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts to the deployment with the key header and dimensions pinned at 1536, and returns vectors in input order", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      ok({ data: [{ index: 1, embedding: vec(1) }, { index: 0, embedding: vec(0) }] }),
    );
    const p = azureOpenAiProvider(settings, fetchImpl as unknown as typeof fetch);
    expect([p.id, p.model, p.dimensions]).toEqual(["azure-openai", "text-embedding-3-small", 1536]);
    const out = await p.embed(["first", "second"]);
    expect(out).toEqual([vec(0), vec(1)]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://embeddings.example.test/openai/deployments/embed%20small/embeddings?api-version=2024-10-21");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["api-key"]).toBe("test-key-not-real");
    expect(JSON.parse(String(init?.body))).toEqual({ input: ["first", "second"], dimensions: 1536 });
  });

  it("makes no call for no texts", async () => {
    const fetchImpl = vi.fn();
    expect(await azureOpenAiProvider(settings, fetchImpl as unknown as typeof fetch).embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("turns a non-2xx answer into an EmbeddingError whose code names only the status", async () => {
    const fetchImpl = vi.fn(async () => new Response("quota exceeded for key test-key-not-real", { status: 429 }));
    const err = await azureOpenAiProvider(settings, fetchImpl as unknown as typeof fetch).embed(["t"]).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err.code).toBe("embedding_http_429");
    expect(String(err.message)).not.toContain("test-key");
  });

  it.each([
    ["the wrong number of vectors", { data: [{ index: 0, embedding: vec(0) }] }],
    ["a vector of the wrong size", { data: [{ index: 0, embedding: [0.1, 0.2] }, { index: 1, embedding: vec(1) }] }],
    ["a malformed body", { nope: true }],
  ])("refuses %s as embedding_bad_response", async (_label, body) => {
    const fetchImpl = vi.fn(async () => ok(body));
    const err = await azureOpenAiProvider(settings, fetchImpl as unknown as typeof fetch).embed(["a", "b"]).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err.code).toBe("embedding_bad_response");
  });

  it("times out at the clamped timeout, and honours the caller's own signal", async () => {
    const hang = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason))),
    );
    const started = Date.now();
    const timedOut = await azureOpenAiProvider({ ...settings, timeoutMs: 1 }, hang as unknown as typeof fetch).embed(["t"]).catch((e) => e);
    expect(timedOut.name).toBe("TimeoutError");
    expect(Date.now() - started).toBeGreaterThanOrEqual(190); // 1 ms clamps up to 200 ms

    const controller = new AbortController();
    const pending = azureOpenAiProvider(settings, hang as unknown as typeof fetch).embed(["t"], controller.signal).catch((e) => e);
    controller.abort();
    expect((await pending).name).toBe("AbortError");
  });

  it("never logs", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    await azureOpenAiProvider(settings, fetchImpl as unknown as typeof fetch).embed(["secret draft text"]).catch(() => {});
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
```

`packages/embeddings/src/settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { clampTimeoutMs, createEmbeddingProvider, embeddingsEnvSchema } from "./settings";

const parse = (env: Record<string, string>) => embeddingsEnvSchema.safeParse(env);
const azure = {
  EMBEDDINGS_PROVIDER: "azure-openai",
  AZURE_OPENAI_ENDPOINT: "https://embeddings.example.test",
  AZURE_OPENAI_API_KEY: "test-key-not-real",
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "embed-small",
};

describe("clampTimeoutMs", () => {
  it.each([
    [undefined, 1000], ["", 1000], ["abc", 1000], ["50", 200], ["200", 200], ["1500", 1500], ["9000", 5000], [750, 750],
  ])("%j -> %d", (raw, expected) => {
    expect(clampTimeoutMs(raw as string | number | undefined)).toBe(expected);
  });
});

describe("embeddingsEnvSchema and createEmbeddingProvider", () => {
  it("means full-text only (null) when no provider is set, or it is blank", () => {
    for (const env of [{}, { EMBEDDINGS_PROVIDER: "" }]) {
      const r = parse(env);
      expect(r.success).toBe(true);
      expect(createEmbeddingProvider(r.data!)).toBeNull();
    }
  });

  it("builds the stand-in outside production", () => {
    const r = parse({ EMBEDDINGS_PROVIDER: "stand-in", NODE_ENV: "development" });
    expect(createEmbeddingProvider(r.data!)?.id).toBe("stand-in");
  });

  it("refuses the stand-in on a real production deployment", () => {
    const r = parse({ EMBEDDINGS_PROVIDER: "stand-in", NODE_ENV: "production" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(["EMBEDDINGS_PROVIDER"]);
    expect(r.error!.issues[0]!.message).toMatch(/production/);
  });

  it.each([{ LOCAL_ADMIN_ALLOW_IN_PRODUCTION: "true" }, { SITE_ENVIRONMENT: "test" }])(
    "allows the stand-in on a production-mode test deployment (%j), as boxs.ca is",
    (extra) => {
      expect(parse({ EMBEDDINGS_PROVIDER: "stand-in", NODE_ENV: "production", ...extra }).success).toBe(true);
    },
  );

  it("builds the Azure provider with the default API version and the clamped timeout", () => {
    const r = parse({ ...azure, EMBEDDINGS_TIMEOUT_MS: "99999" });
    expect(r.success).toBe(true);
    expect(r.data!.AZURE_OPENAI_API_VERSION).toBe("2024-10-21");
    expect(r.data!.EMBEDDINGS_TIMEOUT_MS).toBe(5000);
    expect(createEmbeddingProvider(r.data!)?.id).toBe("azure-openai");
  });

  it.each(["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_EMBEDDING_DEPLOYMENT"] as const)(
    "requires %s for azure-openai, naming it",
    (missing) => {
      const { [missing]: _gone, ...rest } = azure;
      const r = parse(rest);
      expect(r.success).toBe(false);
      expect(r.error!.issues.map((i) => i.path[0])).toContain(missing);
    },
  );

  it("refuses an unknown provider name", () => {
    expect(parse({ EMBEDDINGS_PROVIDER: "openai" }).success).toBe(false);
  });
});
```

- [ ] **Step 7: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/embeddings/src/azure-openai.test.ts packages/embeddings/src/settings.test.ts`
Expected: FAIL, "Failed to resolve import "./azure-openai"" and "./settings".

- [ ] **Step 8: Implement `timeout.ts`, `azure-openai.ts` and `settings.ts`**

`packages/embeddings/src/timeout.ts`:

```ts
const DEFAULT_TIMEOUT_MS = 1000;
const MIN_TIMEOUT_MS = 200;
const MAX_TIMEOUT_MS = 5000;

/** Spec §4: default 1,000 ms, clamped to 200–5,000. Anything unparseable is the default. */
export function clampTimeoutMs(raw: string | number | undefined): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(n)));
}
```

`packages/embeddings/src/azure-openai.ts`:

```ts
import { z } from "zod";
import { EmbeddingError, type EmbeddingProvider } from "./provider";
import { clampTimeoutMs } from "./timeout";

export const AZURE_EMBEDDING_MODEL = "text-embedding-3-small";
export const AZURE_EMBEDDING_DIMENSIONS = 1536;

export interface AzureOpenAiSettings {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion: string;
  timeoutMs: number;
}

const responseSchema = z.object({ data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })) });

/** Azure OpenAI embeddings over its REST API (spec §4): dimensions pinned, every call timed out. */
export function azureOpenAiProvider(s: AzureOpenAiSettings, fetchImpl: typeof fetch = fetch): EmbeddingProvider {
  const url =
    `${s.endpoint.replace(/\/+$/, "")}/openai/deployments/${encodeURIComponent(s.deployment)}` +
    `/embeddings?api-version=${encodeURIComponent(s.apiVersion)}`;
  const timeoutMs = clampTimeoutMs(s.timeoutMs);
  return {
    id: "azure-openai",
    model: AZURE_EMBEDDING_MODEL,
    dimensions: AZURE_EMBEDDING_DIMENSIONS,
    async embed(texts, signal) {
      if (texts.length === 0) return [];
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "api-key": s.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ input: texts, dimensions: AZURE_EMBEDDING_DIMENSIONS }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new EmbeddingError(`embedding_http_${res.status}`);
      }
      const parsed = responseSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success || parsed.data.data.length !== texts.length) throw new EmbeddingError("embedding_bad_response");
      const sorted = [...parsed.data.data].sort((a, b) => a.index - b.index);
      if (sorted.some((d, i) => d.index !== i || d.embedding.length !== AZURE_EMBEDDING_DIMENSIONS)) {
        throw new EmbeddingError("embedding_bad_response");
      }
      return sorted.map((d) => d.embedding);
    },
  };
}
```

`packages/embeddings/src/settings.ts`:

```ts
import { z } from "zod";
import { azureOpenAiProvider } from "./azure-openai";
import type { EmbeddingProvider } from "./provider";
import { standInProvider } from "./stand-in";
import { clampTimeoutMs } from "./timeout";

export { clampTimeoutMs };

export const DEFAULT_AZURE_API_VERSION = "2024-10-21";

const blankToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optionalString = z.preprocess(blankToUndefined, z.string().optional());

/**
 * Merged into an app's own env schema (the News API's), so `node stack.js --check` applies the
 * same rules a real start does. NODE_ENV, LOCAL_ADMIN_ALLOW_IN_PRODUCTION and SITE_ENVIRONMENT
 * are read only for the production guard; they are shared, unprefixed stack variables.
 */
export const embeddingsEnvShape = {
  EMBEDDINGS_PROVIDER: z.preprocess(blankToUndefined, z.enum(["azure-openai", "stand-in"]).optional()),
  EMBEDDINGS_TIMEOUT_MS: optionalString.transform((v) => clampTimeoutMs(v)),
  AZURE_OPENAI_ENDPOINT: z.preprocess(blankToUndefined, z.string().url().optional()),
  AZURE_OPENAI_API_KEY: optionalString,
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: optionalString,
  AZURE_OPENAI_API_VERSION: z.preprocess(blankToUndefined, z.string().default(DEFAULT_AZURE_API_VERSION)),
  NODE_ENV: optionalString,
  LOCAL_ADMIN_ALLOW_IN_PRODUCTION: optionalString,
  SITE_ENVIRONMENT: optionalString,
};

const embeddingsEnvObject = z.object(embeddingsEnvShape);
export type EmbeddingsEnv = z.output<typeof embeddingsEnvObject>;

/** The platform's test-site rule (apps/public-site/src/site-env.ts, isTestSite), inverted. */
function isRealProduction(env: EmbeddingsEnv): boolean {
  return env.NODE_ENV === "production" && env.LOCAL_ADMIN_ALLOW_IN_PRODUCTION !== "true" && env.SITE_ENVIRONMENT !== "test";
}

const AZURE_REQUIRED = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_EMBEDDING_DEPLOYMENT"] as const;

export function refineEmbeddingsEnv(env: EmbeddingsEnv, ctx: z.RefinementCtx): void {
  if (env.EMBEDDINGS_PROVIDER === "azure-openai") {
    for (const name of AZURE_REQUIRED) {
      if (!env[name]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: "is required when EMBEDDINGS_PROVIDER=azure-openai" });
    }
  }
  if (env.EMBEDDINGS_PROVIDER === "stand-in" && isRealProduction(env)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["EMBEDDINGS_PROVIDER"],
      message:
        "stand-in is refused on a production deployment (NODE_ENV=production without LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true or SITE_ENVIRONMENT=test)",
    });
  }
}

export const embeddingsEnvSchema = embeddingsEnvObject.superRefine(refineEmbeddingsEnv);

/** The configured provider, or null: full-text only (spec §4). Call only with refined env. */
export function createEmbeddingProvider(env: EmbeddingsEnv, fetchImpl: typeof fetch = fetch): EmbeddingProvider | null {
  switch (env.EMBEDDINGS_PROVIDER) {
    case "stand-in":
      return standInProvider();
    case "azure-openai": {
      const { AZURE_OPENAI_ENDPOINT: endpoint, AZURE_OPENAI_API_KEY: apiKey, AZURE_OPENAI_EMBEDDING_DEPLOYMENT: deployment } = env;
      if (!endpoint || !apiKey || !deployment) throw new Error("azure-openai needs AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and AZURE_OPENAI_EMBEDDING_DEPLOYMENT");
      return azureOpenAiProvider(
        { endpoint, apiKey, deployment, apiVersion: env.AZURE_OPENAI_API_VERSION, timeoutMs: env.EMBEDDINGS_TIMEOUT_MS },
        fetchImpl,
      );
    }
    default:
      return null;
  }
}
```

`clampTimeoutMs` lives in its own module so that `settings.ts` (which builds the Azure provider) and `azure-openai.ts` (which clamps its own timeout) don't import each other.

- [ ] **Step 9: Run the package's tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/embeddings`
Expected: PASS.

- [ ] **Step 10: Write the failing News API env and stack-check tests**

Append to `apps/news-api/src/env.test.ts`:

```ts
describe("newsApiEnvSchema embeddings", () => {
  it("has no provider by default, and the default timeout", () => {
    const env = parseEnv(newsApiEnvSchema, BASE as unknown as NodeJS.ProcessEnv);
    expect(env.EMBEDDINGS_PROVIDER).toBeUndefined();
    expect(env.EMBEDDINGS_TIMEOUT_MS).toBe(1000);
  });

  it("refuses the stand-in under NODE_ENV=production on a real production deployment", () => {
    expect(() =>
      parseEnv(newsApiEnvSchema, { ...BASE, EMBEDDINGS_PROVIDER: "stand-in", NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/EMBEDDINGS_PROVIDER: stand-in is refused on a production deployment/);
  });
});
```

Append to the `describe("checkStack", …)` block in `apps/stack/src/stack-check.test.ts`:

```ts
  it("fails the News API when NEWSAPI_EMBEDDINGS_PROVIDER=stand-in on a real production deployment", async () => {
    const env = baseEnv();
    env.NODE_ENV = "production";
    env.NEWSAPI_EMBEDDINGS_PROVIDER = "stand-in";
    const result = await checkStack(env);
    expect(result.ok).toBe(false);
    expect(result.apps["news-api"]?.error).toMatch(/NEWSAPI_\*/);
    expect(result.apps["news-api"]?.error).toMatch(/EMBEDDINGS_PROVIDER: stand-in is refused/);
  });

  it("passes NEWSAPI_EMBEDDINGS_PROVIDER=stand-in on a production-mode test deployment (boxs.ca)", async () => {
    const env = baseEnv();
    env.NODE_ENV = "production";
    env.LOCAL_ADMIN_ALLOW_IN_PRODUCTION = "true";
    env.NEWSAPI_EMBEDDINGS_PROVIDER = "stand-in";
    const result = await checkStack(env);
    expect(result.apps["news-api"]?.ok).toBe(true);
  });
```

The first test also trips the local-admin production guard (baseEnv enables local admin). That's fine: the assertion is on the news-api entry's own error text, which joins every error for that app.

- [ ] **Step 11: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/env.test.ts apps/stack/src/stack-check.test.ts`
Expected: FAIL. `EMBEDDINGS_TIMEOUT_MS` is undefined, and the stand-in is accepted.

- [ ] **Step 12: Merge the embeddings env into the News API's**

In `apps/news-api/src/env.ts`, add `import { embeddingsEnvShape, refineEmbeddingsEnv } from "@gcpe/embeddings";`. Then change the schema's shape so the object's fields spread the embeddings fields last and the whole is refined:

```ts
export const newsApiEnvSchema = z
  .object({
    // …every existing field, unchanged…
    MIGRATIONS_FOLDER: z.string().default(fileURLToPath(new URL("../migrations", import.meta.url))),
    ...embeddingsEnvShape,
  })
  .superRefine(refineEmbeddingsEnv);
```

`NewsApiEnv` stays `z.infer<typeof newsApiEnvSchema>`.

- [ ] **Step 13: Run them, the stack check and the type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/env.test.ts apps/stack/src/stack-check.test.ts packages/embeddings`
Expected: PASS.

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

- [ ] **Step 14: Runbook and running notes**

In `docs/deploy/siteground.md`, insert this just before `## Troubleshooting`:

```markdown
## Search and embeddings (Phase 6a)

### Embedding settings

Nothing calls an embedding provider yet: semantic search and its worker arrive in 6b. The settings are parsed now so that `node stack.js --check` catches a bad one before it matters. All are News API settings, so on the stack each carries the `NEWSAPI_` prefix:

| Variable | Meaning |
|---|---|
| `NEWSAPI_EMBEDDINGS_PROVIDER` | Unset or blank: full-text search only. `stand-in`: the hashing stand-in, for tests and boxs.ca. `azure-openai`: Azure OpenAI. |
| `NEWSAPI_AZURE_OPENAI_ENDPOINT`, `NEWSAPI_AZURE_OPENAI_API_KEY`, `NEWSAPI_AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | Required for `azure-openai`. The deployment must be `text-embedding-3-small` in a Canada region (Q70). |
| `NEWSAPI_AZURE_OPENAI_API_VERSION` | Default `2024-10-21`. |
| `NEWSAPI_EMBEDDINGS_TIMEOUT_MS` | Per call. Default 1000; clamped to 200–5000. |

`stand-in` is refused on a real production deployment: `NODE_ENV=production` without `LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true` or `SITE_ENVIRONMENT=test`. That is the same test-site rule as Flickr and the TEST banner. boxs.ca qualifies as a test deployment.
```

Append to the `## Phase 6a — Search foundations` list in `docs/manuals/running-notes.md`:

```markdown
- **Operations** — The News API reads `EMBEDDINGS_PROVIDER` (`stand-in` or `azure-openai`) and the `AZURE_OPENAI_*` settings (`NEWSAPI_`-prefixed on the stack), but nothing calls a provider until semantic search arrives in 6b. Unset means full-text only. `stand-in` is refused on a real production deployment; `node stack.js --check` says so, naming `NEWSAPI_*`.
- **Developer** — `@gcpe/embeddings` holds the provider interface, the stand-in (fixed output, so tests can pin vectors), the Azure provider (plain `fetch`, `dimensions: 1536`), the env settings and `htmlToPlainText`. Providers never log.
```

- [ ] **Step 15: Commit**

```bash
git add packages/embeddings apps/news-api/package.json apps/news-api/src/env.ts apps/news-api/src/env.test.ts apps/stack/src/stack-check.test.ts package-lock.json docs/deploy/siteground.md docs/manuals/running-notes.md
git commit -m "feat(embeddings): provider interface, stand-in and Azure providers, and env settings"
```

---

### Task 3: The circuit breaker and the guarded embedder

**Risk:** high (it decides when visitors get a fallback). **Review:** full review B.

**Files:**
- Create: `packages/embeddings/src/breaker.ts`, `packages/embeddings/src/breaker.test.ts`, `packages/embeddings/src/guarded.ts`, `packages/embeddings/src/guarded.test.ts`
- Modify: `packages/embeddings/src/index.ts`, `docs/manuals/running-notes.md`

**Interfaces:**
- Consumes: `EmbeddingProvider` and `standInProvider` (Task 2); `safeErrorLabel` from `@gcpe/http-kit`.
- Produces, from `@gcpe/embeddings`:

```ts
export type BreakerState = "closed" | "open" | "half-open";
export class BreakerOpenError extends Error { readonly code: "breaker_open" }
export interface CircuitBreakerOptions { failureThreshold?: number; cooldownMs?: number; now?: () => number }  // 3, 60_000, Date.now
export class CircuitBreaker {
  constructor(opts?: CircuitBreakerOptions);
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  get state(): BreakerState;
  run<T>(fn: () => Promise<T>): Promise<T>;   // throws BreakerOpenError without calling fn while open
}
export interface GuardedEmbedder { readonly provider: EmbeddingProvider; readonly breaker: CircuitBreaker; embed(texts: string[], signal?: AbortSignal): Promise<number[][]> }
export function createGuardedEmbedder(opts: { provider: EmbeddingProvider; breaker?: CircuitBreaker; log?: (line: string) => void }): GuardedEmbedder;
```

6b's search route and worker call `guarded.embed(...)`. They catch every rejection, `BreakerOpenError` included, and fall back to text or skip the tick.

- [ ] **Step 1: Write the failing breaker tests**

`packages/embeddings/src/breaker.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { safeErrorLabel } from "@gcpe/http-kit";
import { BreakerOpenError, CircuitBreaker } from "./breaker";

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}
const fail = () => Promise.reject(new Error("provider down"));
const ok = () => Promise.resolve("ok");
async function failTimes(b: CircuitBreaker, n: number) {
  for (let i = 0; i < n; i++) await b.run(fail).catch(() => {});
}

describe("CircuitBreaker", () => {
  it("defaults to 3 failures and a 60-second cooldown", () => {
    const b = new CircuitBreaker();
    expect([b.failureThreshold, b.cooldownMs, b.state]).toEqual([3, 60_000, "closed"]);
  });

  it("stays closed through two consecutive failures and opens on the third", async () => {
    const b = new CircuitBreaker({ now: clock().now });
    await failTimes(b, 2);
    expect(b.state).toBe("closed");
    await failTimes(b, 1);
    expect(b.state).toBe("open");
  });

  it("counts consecutive failures only: a success resets the count", async () => {
    const b = new CircuitBreaker({ now: clock().now });
    await failTimes(b, 2);
    await b.run(ok);
    await failTimes(b, 2);
    expect(b.state).toBe("closed");
  });

  it("while open, throws BreakerOpenError without calling fn", async () => {
    const b = new CircuitBreaker({ now: clock().now });
    await failTimes(b, 3);
    const fn = vi.fn(ok);
    await expect(b.run(fn)).rejects.toBeInstanceOf(BreakerOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("after the cooldown is half-open: one probe at a time; a success closes it", async () => {
    const c = clock();
    const b = new CircuitBreaker({ now: c.now });
    await failTimes(b, 3);
    c.advance(59_999);
    expect(b.state).toBe("open");
    c.advance(1);
    expect(b.state).toBe("half-open");

    let release!: (v: string) => void;
    const probe = b.run(() => new Promise<string>((r) => (release = r)));
    const second = vi.fn(ok);
    await expect(b.run(second)).rejects.toBeInstanceOf(BreakerOpenError);
    expect(second).not.toHaveBeenCalled();
    release("probed");
    expect(await probe).toBe("probed");
    expect(b.state).toBe("closed");
    await failTimes(b, 2);
    expect(b.state).toBe("closed"); // the count started again from zero
  });

  it("a failed probe re-opens it for a fresh cooldown", async () => {
    const c = clock();
    const b = new CircuitBreaker({ now: c.now });
    await failTimes(b, 3);
    c.advance(60_000);
    await failTimes(b, 1);
    expect(b.state).toBe("open");
    c.advance(59_999);
    await expect(b.run(ok)).rejects.toBeInstanceOf(BreakerOpenError);
    c.advance(1);
    expect(await b.run(ok)).toBe("ok");
  });

  it("treats a synchronous throw from fn as a failure", async () => {
    const b = new CircuitBreaker({ now: clock().now });
    for (let i = 0; i < 3; i++) {
      await b.run(() => { throw new Error("sync"); }).catch(() => {});
    }
    expect(b.state).toBe("open");
  });

  it("labels BreakerOpenError safely", () => {
    expect(safeErrorLabel(new BreakerOpenError())).toBe("breaker_open");
  });
});
```

`packages/embeddings/src/guarded.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { BreakerOpenError, CircuitBreaker } from "./breaker";
import { createGuardedEmbedder } from "./guarded";
import { EmbeddingError, type EmbeddingProvider } from "./provider";
import { standInProvider } from "./stand-in";

const failing = (err: Error): EmbeddingProvider => ({
  id: "fake", model: "fake-1", dimensions: 3,
  embed: vi.fn(async () => { throw err; }),
});

describe("createGuardedEmbedder", () => {
  it("passes vectors through from the provider", async () => {
    const g = createGuardedEmbedder({ provider: standInProvider(), log: () => {} });
    expect(await g.embed(["a"])).toEqual(await standInProvider().embed(["a"]));
  });

  it("logs a failure with the provider id and a safe label only, never the input text", async () => {
    const lines: string[] = [];
    const g = createGuardedEmbedder({ provider: failing(new Error("cannot embed: Secret draft headline")), log: (l) => lines.push(l) });
    await expect(g.embed(["Secret draft headline"])).rejects.toThrow();
    expect(lines).toEqual(["[embeddings] fake call failed Error"]);

    const lines2: string[] = [];
    const g2 = createGuardedEmbedder({ provider: failing(new EmbeddingError("embedding_http_429")), log: (l) => lines2.push(l) });
    await g2.embed(["x"]).catch(() => {});
    expect(lines2).toEqual(["[embeddings] fake call failed embedding_http_429"]);
  });

  it("opens the breaker after three failures, then rejects with BreakerOpenError without calling the provider or logging", async () => {
    const provider = failing(new Error("down"));
    const lines: string[] = [];
    const g = createGuardedEmbedder({ provider, breaker: new CircuitBreaker({ now: () => 0 }), log: (l) => lines.push(l) });
    for (let i = 0; i < 3; i++) await g.embed(["t"]).catch(() => {});
    expect(provider.embed).toHaveBeenCalledTimes(3);
    await expect(g.embed(["t"])).rejects.toBeInstanceOf(BreakerOpenError);
    expect(provider.embed).toHaveBeenCalledTimes(3);
    expect(lines).toHaveLength(3);
  });

  it("defaults to console.error and a fresh breaker", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const g = createGuardedEmbedder({ provider: failing(new Error("down")) });
    expect(g.breaker.state).toBe("closed");
    await g.embed(["t"]).catch(() => {});
    expect(error).toHaveBeenCalledWith("[embeddings] fake call failed Error");
    error.mockRestore();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/embeddings/src/breaker.test.ts packages/embeddings/src/guarded.test.ts`
Expected: FAIL, "Failed to resolve import "./breaker"".

- [ ] **Step 3: Implement the breaker and the guarded embedder**

`packages/embeddings/src/breaker.ts`:

```ts
export type BreakerState = "closed" | "open" | "half-open";

/** Thrown instead of calling the provider: the caller falls back (spec §4). */
export class BreakerOpenError extends Error {
  readonly code = "breaker_open";
  constructor() {
    super("circuit breaker open");
    this.name = "BreakerOpenError";
  }
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

/**
 * Closed until `failureThreshold` consecutive failures; then open for `cooldownMs`, rejecting
 * every call with BreakerOpenError; then half-open, letting exactly one probe through. A
 * successful probe closes it and resets the count; a failed one re-opens it for a fresh cooldown.
 */
export class CircuitBreaker {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  private readonly now: () => number;
  private isOpen = false;
  private failures = 0;
  private openedAt = 0;
  private probing = false;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  get state(): BreakerState {
    if (!this.isOpen) return "closed";
    return this.now() - this.openedAt >= this.cooldownMs ? "half-open" : "open";
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen) {
      if (this.now() - this.openedAt < this.cooldownMs || this.probing) throw new BreakerOpenError();
      this.probing = true;
      try {
        const value = await fn();
        this.isOpen = false;
        this.failures = 0;
        return value;
      } catch (e) {
        this.openedAt = this.now();
        throw e;
      } finally {
        this.probing = false;
      }
    }
    try {
      const value = await fn();
      this.failures = 0;
      return value;
    } catch (e) {
      this.failures += 1;
      if (!this.isOpen && this.failures >= this.failureThreshold) {
        this.isOpen = true;
        this.openedAt = this.now();
      }
      throw e;
    }
  }
}
```

`packages/embeddings/src/guarded.ts`:

```ts
import { safeErrorLabel } from "@gcpe/http-kit";
import { BreakerOpenError, CircuitBreaker } from "./breaker";
import type { EmbeddingProvider } from "./provider";

export interface GuardedEmbedder {
  readonly provider: EmbeddingProvider;
  readonly breaker: CircuitBreaker;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/**
 * A provider behind a breaker. The one place a provider failure is logged: the provider id and
 * safeErrorLabel only, never the texts (spec §4). An open breaker isn't logged; it isn't a call.
 */
export function createGuardedEmbedder(opts: {
  provider: EmbeddingProvider;
  breaker?: CircuitBreaker;
  log?: (line: string) => void;
}): GuardedEmbedder {
  const { provider } = opts;
  const breaker = opts.breaker ?? new CircuitBreaker();
  const log = opts.log ?? ((line: string) => console.error(line));
  return {
    provider,
    breaker,
    async embed(texts, signal) {
      try {
        return await breaker.run(() => provider.embed(texts, signal));
      } catch (e) {
        if (!(e instanceof BreakerOpenError)) log(`[embeddings] ${provider.id} call failed ${safeErrorLabel(e)}`);
        throw e;
      }
    },
  };
}
```

Append to `packages/embeddings/src/index.ts`:

```ts
export { BreakerOpenError, CircuitBreaker, type BreakerState, type CircuitBreakerOptions } from "./breaker";
export { createGuardedEmbedder, type GuardedEmbedder } from "./guarded";
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/embeddings`
Expected: PASS.

- [ ] **Step 5: Running notes and commit**

Append to the Phase 6a list in `docs/manuals/running-notes.md`:

```markdown
- **Developer** — `createGuardedEmbedder` puts a provider behind `CircuitBreaker`: three consecutive failures open it for 60 seconds, then one probe at a time decides. While open, `embed` rejects with `BreakerOpenError` without calling the provider; callers fall back to text search. A failure is logged once as `[embeddings] <provider id> call failed <label>`.
```

```bash
git add packages/embeddings docs/manuals/running-notes.md
git commit -m "feat(embeddings): circuit breaker and a guarded embedder that logs safely"
```

---

### Task 4: Search columns on `posts`, written on every post write, the language check and `news-api:search-backfill`

**Risk:** high (a migration on the busiest table, every post write, and an irreversible bulk write). **Review:** full review C.

**Files:**
- Create:
  - `apps/news-api/src/search/search-text.ts` and `search-text.test.ts`;
  - `apps/news-api/src/search/language.ts` and `language.test.ts`;
  - `apps/news-api/src/cli/search-backfill.ts` and `search-backfill.test.ts`;
  - `apps/news-api/migrations/0003_post_search.sql` and `meta/0003_snapshot.json` (both generated).
- Modify:
  - `apps/news-api/src/db/schema.ts`, `migrations/meta/_journal.json` (generated), `src/projections.ts`, `src/projections.test.ts`, `src/posts.ts`, `src/start.ts`, `src/start.test.ts` and `package.json`;
  - the root `package.json`;
  - `docs/deploy/siteground.md` and `docs/manuals/running-notes.md`.

**Interfaces:**
- Consumes:
  - `htmlToPlainText` and `collapseWhitespace` (Task 2);
  - `SearchLanguage` (Task 1);
  - from the code at HEAD: `applyRelease(tx, r, opts)` (`src/projections.ts`), `createNewsTestDb()`, `TestDatabase` (`db`, `pool`, `url`, `drop`) and `sampleRelease` (`@gcpe/events/testing`).
- Produces:

```ts
// apps/news-api/src/db/schema.ts
posts.searchText    // text("search_text"), nullable: NULL means "not yet backfilled"
posts.searchVector  // generated tsvector("search_vector"), GIN index posts_search_vector_idx
export type PostRow = Omit<typeof posts.$inferSelect, "searchText" | "searchVector">;
// apps/news-api/src/search/search-text.ts
export const SEARCH_TEXT_MAX_CHARS = 100_000;
export type SearchTextSource = Pick<ReleaseRecord, "summary" | "keywords" | "location" | "documents">;
export function searchTextFor(p: SearchTextSource): string;
// apps/news-api/src/search/language.ts
export async function searchVectorLanguage(db: Db): Promise<string | null>;
export async function assertSearchLanguage(db: Db, expected: SearchLanguage): Promise<void>;
// apps/news-api/src/cli/search-backfill.ts
export interface SearchBackfillOptions { confirm: boolean; all: boolean; batchSize?: number }  // batchSize default 200
export interface SearchBackfillResult { confirmed: boolean; all: boolean; missingColumn: boolean; total: number; pending: number; filled: number; failure: string | null }
export async function searchBackfill(db: Db, opts: SearchBackfillOptions): Promise<SearchBackfillResult>;
export function parseBackfillArgs(argv: string[]): { confirm: boolean; all: boolean };
export function printBackfillResult(r: SearchBackfillResult, log?: (s: string) => void): void;
```

- [ ] **Step 1: Write the failing search-text tests**

`apps/news-api/src/search/search-text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sampleRelease } from "@gcpe/events/testing";
import { SEARCH_TEXT_MAX_CHARS, searchTextFor } from "./search-text";

describe("searchTextFor", () => {
  it("joins headline, summary, keywords, location, subheadline and the stripped body, skipping empty fields", () => {
    expect(searchTextFor(sampleRelease)).toBe(
      "Traffic-pattern change planned for Highway 11 at Highway 1 Drivers can expect major traffic-pattern changes on Highway 11. Abbotsford Drivers can expect…",
    );
  });

  it("puts every document's headline first, then each document's subheadline and body", () => {
    const doc = sampleRelease.documents[0]!;
    const text = searchTextFor({
      summary: "Summary.",
      keywords: "ferries, schedules",
      location: "Victoria",
      documents: [
        { ...doc, headline: "Main headline", subheadline: "Main sub", detailsHtml: "<p>Main&nbsp;body</p>" },
        { ...doc, languageId: 1036, headline: "Titre", subheadline: null, detailsHtml: "<p>Corps</p>" },
      ],
    });
    expect(text).toBe("Main headline Titre Summary. ferries, schedules Victoria Main sub Main body Corps");
  });

  it("caps the text at 100,000 characters", () => {
    const doc = sampleRelease.documents[0]!;
    const text = searchTextFor({ summary: null, keywords: null, location: null, documents: [{ ...doc, headline: null, detailsHtml: `<p>${"word ".repeat(30_000)}</p>` }] });
    expect(text.length).toBe(SEARCH_TEXT_MAX_CHARS);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/search/search-text.test.ts`
Expected: FAIL, "Failed to resolve import "./search-text"".

- [ ] **Step 3: Implement `search-text.ts`**

`apps/news-api/src/search/search-text.ts`:

```ts
import type { ReleaseRecord } from "@gcpe/events";
import { collapseWhitespace, htmlToPlainText } from "@gcpe/embeddings";

/**
 * Postgres refuses a tsvector over 1 MB, and search_vector is generated from this text: an
 * uncapped very long release would fail its own write. 100,000 characters stays far below that.
 */
export const SEARCH_TEXT_MAX_CHARS = 100_000;

export type SearchTextSource = Pick<ReleaseRecord, "summary" | "keywords" | "location" | "documents">;

/** posts.search_text (spec §5.1): headlines, summary, keywords, location, then subheadlines and bodies. */
export function searchTextFor(p: SearchTextSource): string {
  const parts = [
    ...p.documents.map((d) => d.headline),
    p.summary,
    p.keywords,
    p.location,
    ...p.documents.flatMap((d) => [d.subheadline, htmlToPlainText(d.detailsHtml)]),
  ];
  const text = collapseWhitespace(parts.filter((s): s is string => !!s).join(" "));
  if (text.length <= SEARCH_TEXT_MAX_CHARS) return text;
  return Array.from(text).slice(0, SEARCH_TEXT_MAX_CHARS).join("");
}
```

In the cap test, every character is ASCII, so the code-point slice and `.length` agree at exactly 100,000.

- [ ] **Step 4: Run it to see it pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/search/search-text.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the columns to the schema and generate the migration**

In `apps/news-api/src/db/schema.ts`:

1. Add the custom type below `bytea`:

   ```ts
   const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
   ```

2. Add the two columns after `origin`, inside `posts`' columns:

   ```ts
       /** Plain text the News API writes on every post write (src/search/search-text.ts). NULL until backfilled. */
       searchText: text("search_text"),
       /**
        * Generated by Postgres from search_text. The text-search configuration is fixed per
        * database; the News API refuses to start if the tenant's search.language differs
        * (src/search/language.ts). Another language needs its own migration.
        */
       searchVector: tsvector("search_vector").generatedAlwaysAs(sql`to_tsvector('english'::regconfig, coalesce(search_text, ''))`),
   ```

3. Add the index after `posts_index_keys_idx`:

   ```ts
       index("posts_search_vector_idx").using("gin", t.searchVector),
   ```

4. Replace `export type PostRow = typeof posts.$inferSelect;` with:

   ```ts
   /** A post as v1 reads it: the search columns stay in the database (src/posts.ts selects without them). */
   export type PostRow = Omit<typeof posts.$inferSelect, "searchText" | "searchVector">;
   ```

Run: `cd apps/news-api && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name post_search`

Expected: `migrations/0003_post_search.sql` holds exactly these three statements (this was verified while planning, and they ran on Postgres 14.17):

```sql
ALTER TABLE "posts" ADD COLUMN "search_text" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce(search_text, ''))) STORED;--> statement-breakpoint
CREATE INDEX "posts_search_vector_idx" ON "posts" USING gin ("search_vector");
```

If anything else appears, stop: the schema has drifted from the snapshot.

- [ ] **Step 6: Keep v1's reads off the search columns**

In `apps/news-api/src/posts.ts`:

1. Add `getTableColumns` to the `drizzle-orm` import.
2. Add, below `KEY_DESC`:

   ```ts
   // Every posts column v1 renders: search_text and search_vector are large and never part of a v1 response.
   const { searchText: _searchText, searchVector: _searchVector, ...postReadColumns } = getTableColumns(posts);
   ```

3. Change the three whole-row reads to select these columns. In `latestPosts`, `getPost` and `getPostsByKeys`, replace `db.select().from(posts)` and `db\n    .select()\n    .from(posts)` with `db.select(postReadColumns).from(posts)`.

- [ ] **Step 7: Write the failing projection tests**

In `apps/news-api/src/projections.test.ts`:
- add `import { createHash } from "node:crypto";`;
- add `import { SEARCH_TEXT_MAX_CHARS, searchTextFor } from "./search/search-text";`;
- `eq` and `sql` are already imported from `drizzle-orm`.

Then add these inside `describe("projections", …)`:

```ts
  it("writes search_text on every release write, from either pipeline, and search_vector follows it", async () => {
    await tdb.db.transaction((tx) => applyRelease(tx, sampleRelease));
    const read = async () =>
      (await tdb.db.select({ searchText: posts.searchText }).from(posts).where(eq(posts.key, sampleRelease.key)))[0]?.searchText;
    expect(await read()).toBe(searchTextFor(sampleRelease));
    const hits = await tdb.pool.query("SELECT key FROM posts WHERE search_vector @@ websearch_to_tsquery('english', 'abbotsford')");
    expect(hits.rows).toEqual([{ key: sampleRelease.key }]);

    const renamed = { ...sampleRelease, location: "Kamloops", documents: [{ ...sampleRelease.documents[0]!, headline: "Ferry schedule change" }] };
    await tdb.db.transaction((tx) => applyRelease(tx, renamed));
    expect(await read()).toBe(searchTextFor(renamed));
    expect((await tdb.pool.query("SELECT key FROM posts WHERE search_vector @@ websearch_to_tsquery('english', 'abbotsford')")).rows).toEqual([]);

    await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "LEGACY-1" }, { notify: false, origin: "legacy" }));
    const [legacy] = await tdb.db.select({ searchText: posts.searchText }).from(posts).where(eq(posts.key, "LEGACY-1"));
    expect(legacy?.searchText).toBe(searchTextFor(sampleRelease));
  });

  it("still applies a release whose body would overflow a tsvector, with search_text capped", async () => {
    // About 2 MB of distinct words: Postgres refuses the uncapped tsvector ("string is too long for tsvector").
    const words = Array.from({ length: 60_000 }, (_, i) => createHash("md5").update(String(i)).digest("hex")).join(" ");
    const big = { ...sampleRelease, key: "BIG-1", documents: [{ ...sampleRelease.documents[0]!, detailsHtml: `<p>${words}</p>` }] };
    await tdb.db.transaction((tx) => applyRelease(tx, big));
    const [row] = await tdb.db.select({ n: sql<number>`char_length(${posts.searchText})::int` }).from(posts).where(eq(posts.key, "BIG-1"));
    expect(row?.n).toBe(SEARCH_TEXT_MAX_CHARS);
  });
```

- [ ] **Step 8: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/projections.test.ts`
Expected: FAIL. In the first test `searchText` is `null`; in the second, `char_length` is `null`, not 100000.

After Step 9, to see the overflow the cap prevents: temporarily make `searchTextFor` return the text uncapped and re-run the second test. The insert fails with "string is too long for tsvector". Restore the cap.

- [ ] **Step 9: Write `search_text` in `applyRelease`**

In `apps/news-api/src/projections.ts`, add `import { searchTextFor } from "./search/search-text";`. Then add one line to `applyRelease`'s `values`, after `translations: r.translations,`:

```ts
    searchText: searchTextFor(r),
```

`values` is used both as the insert and as the conflict `set`, for both origins, so every path writes it.

- [ ] **Step 10: Run the projection tests and v1's suites**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/projections.test.ts apps/news-api/test/compat.test.ts apps/news-api/test/e2e-core.test.ts apps/news-api/src/http apps/news-api/src/app.test.ts apps/news-api/src/dto.test.ts`
Expected: PASS, with no edits to any v1 test.

- [ ] **Step 11: Write the failing language-check tests**

`apps/news-api/src/search/language.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNewsTestDb } from "../../test/helpers";
import { assertSearchLanguage, searchVectorLanguage } from "./language";

describe("the search language check", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("reads english from the migrated column, and passes for english", async () => {
    expect(await searchVectorLanguage(tdb.db)).toBe("english");
    await expect(assertSearchLanguage(tdb.db, "english")).resolves.toBeUndefined();
  });

  it("refuses another language, naming both", async () => {
    await expect(assertSearchLanguage(tdb.db, "french")).rejects.toThrow(/search\.language is "french" but posts\.search_vector uses "english"/);
  });

  it("refuses when the column is missing", async () => {
    const other = await createNewsTestDb();
    try {
      await other.pool.query("ALTER TABLE posts DROP COLUMN search_vector");
      expect(await searchVectorLanguage(other.db)).toBeNull();
      await expect(assertSearchLanguage(other.db, "english")).rejects.toThrow(/uses "\(none\)"/);
    } finally {
      await other.drop();
    }
  });
});
```

Add to `apps/news-api/src/start.test.ts`:
- the imports `mkdtempSync`, `readFileSync` and `writeFileSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path` and `fileURLToPath` from `node:url`;
- this test inside `describe("startNewsApi", …)`:

```ts
  it("refuses to start when the tenant's search.language differs from posts.search_vector's", async () => {
    const bc = JSON.parse(readFileSync(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url)), "utf8"));
    const file = join(mkdtempSync(join(tmpdir(), "tenant-")), "t.json");
    writeFileSync(file, JSON.stringify({ ...bc, search: { language: "french" } }));
    await expect(startNewsApi({ ...(await testEnv()), TENANT_CONFIG: file }, { hub: false })).rejects.toThrow(
      /search\.language is "french" but posts\.search_vector uses "english"/,
    );
  });
```

- [ ] **Step 12: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/search/language.test.ts apps/news-api/src/start.test.ts`
Expected: FAIL. `./language` doesn't resolve, and `startNewsApi` starts.

- [ ] **Step 13: Implement the check and call it at startup**

`apps/news-api/src/search/language.ts`:

```ts
import { sql } from "drizzle-orm";
import type { SearchLanguage } from "@gcpe/config";
import type { Db } from "@gcpe/db-kit";

/** The text-search configuration posts.search_vector is generated with, or null if there is no such column. */
export async function searchVectorLanguage(db: Db): Promise<string | null> {
  const { rows } = await db.execute<{ expr: string }>(sql`
    SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
    FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE d.adrelid = 'posts'::regclass AND a.attname = 'search_vector'`);
  return rows[0]?.expr.match(/to_tsvector\('([^']+)'::regconfig/)?.[1] ?? null;
}

/** Spec §5.1: queries must use the column's own configuration, so a mismatch refuses to start. */
export async function assertSearchLanguage(db: Db, expected: SearchLanguage): Promise<void> {
  const actual = await searchVectorLanguage(db);
  if (actual !== expected) {
    throw new Error(
      `Tenant search.language is "${expected}" but posts.search_vector uses "${actual ?? "(none)"}". ` +
        `Change one to match: see docs/deploy/siteground.md, "Search and embeddings".`,
    );
  }
}
```

In `apps/news-api/src/start.ts`, add `import { assertSearchLanguage } from "./search/language";`, then directly after `await runMigrations(db, parsed.MIGRATIONS_FOLDER);`:

```ts
  try {
    await assertSearchLanguage(db, tenant.search.language);
  } catch (e) {
    await pool.end();
    throw e;
  }
```

- [ ] **Step 14: Run them to see them pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/search/language.test.ts apps/news-api/src/start.test.ts`
Expected: PASS.

- [ ] **Step 15: Write the failing backfill tests**

`apps/news-api/src/cli/search-backfill.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { createNewsTestDb } from "../../test/helpers";
import { posts } from "../db/schema";
import { applyRelease } from "../projections";
import { searchTextFor } from "../search/search-text";
import { parseBackfillArgs, printBackfillResult, searchBackfill } from "./search-backfill";

// Mixed case: under COLLATE "C" upper case sorts first, so keyset paging must not skip any.
const KEYS = ["a-1", "B-2", "c-3", "D-4", "e-5"];
const releaseFor = (key: string) => ({ ...sampleRelease, key, reference: null, location: `Town ${key}` });

describe("searchBackfill", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE posts");
    for (const key of KEYS) await tdb.db.transaction((tx) => applyRelease(tx, releaseFor(key), { notify: false }));
    // As the rows stand straight after the migration: no search text yet.
    await tdb.pool.query("UPDATE posts SET search_text = NULL");
  });

  const textOf = async (key: string) => (await tdb.db.select({ t: posts.searchText }).from(posts).where(eq(posts.key, key)))[0]?.t;

  it("dry run counts and writes nothing", async () => {
    const r = await searchBackfill(tdb.db, { confirm: false, all: false });
    expect(r).toMatchObject({ confirmed: false, missingColumn: false, total: 5, pending: 5, filled: 0, failure: null });
    expect(await textOf("a-1")).toBeNull();
  });

  it("--confirm fills every NULL row in batches, and search_vector follows", async () => {
    const r = await searchBackfill(tdb.db, { confirm: true, all: false, batchSize: 2 });
    expect(r).toMatchObject({ confirmed: true, pending: 5, filled: 5, failure: null });
    for (const key of KEYS) expect(await textOf(key)).toBe(searchTextFor(releaseFor(key)));
    const hits = await tdb.pool.query("SELECT key FROM posts WHERE search_vector @@ websearch_to_tsquery('english', 'town')");
    expect(hits.rows).toHaveLength(5);
  });

  it("is safe to re-run: the second run finds nothing to do", async () => {
    await searchBackfill(tdb.db, { confirm: true, all: false });
    const again = await searchBackfill(tdb.db, { confirm: true, all: false });
    expect(again).toMatchObject({ pending: 0, filled: 0, failure: null });
  });

  it("default mode leaves rows that already have search text alone; --all recomputes them", async () => {
    await tdb.pool.query("UPDATE posts SET search_text = 'written by a newer release event' WHERE key = 'c-3'");
    const r = await searchBackfill(tdb.db, { confirm: true, all: false, batchSize: 2 });
    expect(r.filled).toBe(4);
    expect(await textOf("c-3")).toBe("written by a newer release event");

    const all = await searchBackfill(tdb.db, { confirm: true, all: true, batchSize: 2 });
    expect(all).toMatchObject({ all: true, pending: 5, filled: 5 });
    expect(await textOf("c-3")).toBe(searchTextFor(releaseFor("c-3")));
  });

  it("reports a missing column instead of failing on it", async () => {
    const other = await createNewsTestDb();
    try {
      await other.pool.query("ALTER TABLE posts DROP COLUMN search_vector, DROP COLUMN search_text");
      expect(await searchBackfill(other.db, { confirm: true, all: false })).toMatchObject({ missingColumn: true, filled: 0 });
    } finally {
      await other.drop();
    }
  });
});

describe("parseBackfillArgs and printBackfillResult", () => {
  it("accepts --confirm and --all and refuses anything else", () => {
    expect(parseBackfillArgs([])).toEqual({ confirm: false, all: false });
    expect(parseBackfillArgs(["--all", "--confirm"])).toEqual({ confirm: true, all: true });
    expect(() => parseBackfillArgs(["--confrim"])).toThrow(/Unknown argument: --confrim/);
  });

  it("prints what a dry run would do, what a run did, and how to recover", () => {
    const base = { all: false, missingColumn: false, total: 10, pending: 4, filled: 0, failure: null };
    const lines: string[] = [];
    printBackfillResult({ ...base, confirmed: false }, (s) => lines.push(s));
    printBackfillResult({ ...base, confirmed: true, filled: 4 }, (s) => lines.push(s));
    printBackfillResult({ ...base, confirmed: true, filled: 2, failure: "57014" }, (s) => lines.push(s));
    printBackfillResult({ ...base, confirmed: true, missingColumn: true }, (s) => lines.push(s));
    expect(lines).toEqual([
      "Would fill search text for 4 of 10 post(s).",
      "Dry run: nothing written. Re-run with --confirm to write.",
      "Filled search text for 4 of 4 post(s).",
      "Filled search text for 2 of 4 post(s).",
      "Stopped: 57014. Re-run to continue.",
      "posts.search_text doesn't exist yet: start the News API once (it runs migrations), then re-run.",
    ]);
  });
});
```

- [ ] **Step 16: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/cli/search-backfill.test.ts`
Expected: FAIL, "Failed to resolve import "./search-backfill"".

- [ ] **Step 17: Implement the backfill**

`apps/news-api/src/cli/search-backfill.ts`:

```ts
/**
 * `npm run news-api:search-backfill` (spec §5.1): fills posts.search_text for rows written
 * before the column existed. Dry run by default; `--confirm` to write; `--all` to recompute
 * every row rather than only the empty ones. Each batch locks its rows, so a post rewritten by
 * an event mid-run keeps the text its own write computed. Safe to re-run.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { and, sql } from "drizzle-orm";
import { z } from "zod";
import { parseEnv } from "@gcpe/config";
import { createDb, type Db } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import { posts } from "../db/schema";
import { searchTextFor } from "../search/search-text";

const DEFAULT_BATCH_SIZE = 200;
const USAGE = "Usage: npm run news-api:search-backfill -- [--all] [--confirm]";

export interface SearchBackfillOptions {
  confirm: boolean;
  all: boolean;
  batchSize?: number;
}

export interface SearchBackfillResult {
  confirmed: boolean;
  all: boolean;
  missingColumn: boolean;
  total: number;
  pending: number;
  filled: number;
  /** safeErrorLabel of the batch that stopped the run, or null. */
  failure: string | null;
}

export async function searchBackfill(db: Db, opts: SearchBackfillOptions): Promise<SearchBackfillResult> {
  const base = { confirmed: opts.confirm, all: opts.all, total: 0, pending: 0, filled: 0, failure: null };
  const { rows: columns } = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'posts' AND column_name = 'search_text'`);
  if (columns.length === 0) return { ...base, missingColumn: true };

  const scope = opts.all ? sql`true` : sql`${posts.searchText} IS NULL`;
  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)::int` }).from(posts);
  const [{ pending } = { pending: 0 }] = await db.select({ pending: sql<number>`count(*)::int` }).from(posts).where(scope);
  const counted = { ...base, missingColumn: false, total, pending };
  if (!opts.confirm) return counted;

  const size = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  let after = "";
  let filled = 0;
  for (;;) {
    let done: number;
    try {
      done = await db.transaction(async (tx) => {
        const rows = await tx
          .select({ key: posts.key, summary: posts.summary, keywords: posts.keywords, location: posts.location, documents: posts.documents })
          .from(posts)
          .where(and(scope, sql`${posts.key} COLLATE "C" > ${after}`))
          .orderBy(sql`${posts.key} COLLATE "C"`)
          .limit(size)
          .for("update");
        if (rows.length === 0) return 0;
        const values = rows.map((r) => ({ key: r.key, text: searchTextFor(r) }));
        await tx.execute(sql`
          UPDATE posts SET search_text = v.text
          FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS v(key text, text text)
          WHERE posts.key = v.key`);
        after = rows[rows.length - 1]!.key;
        return rows.length;
      });
    } catch (e) {
      return { ...counted, filled, failure: safeErrorLabel(e) };
    }
    if (done === 0) break;
    filled += done;
  }
  return { ...counted, filled };
}

export function parseBackfillArgs(argv: string[]): { confirm: boolean; all: boolean } {
  for (const arg of argv) {
    if (arg !== "--confirm" && arg !== "--all") throw new Error(`Unknown argument: ${arg}. ${USAGE}`);
  }
  return { confirm: argv.includes("--confirm"), all: argv.includes("--all") };
}

export function printBackfillResult(r: SearchBackfillResult, log: (s: string) => void = console.log): void {
  if (r.missingColumn) {
    log("posts.search_text doesn't exist yet: start the News API once (it runs migrations), then re-run.");
    return;
  }
  if (!r.confirmed) {
    log(`Would fill search text for ${r.pending} of ${r.total} post(s).`);
    log("Dry run: nothing written. Re-run with --confirm to write.");
    return;
  }
  log(`Filled search text for ${r.filled} of ${r.pending} post(s).`);
  if (r.failure) log(`Stopped: ${r.failure}. Re-run to continue.`);
}

async function main(): Promise<void> {
  let args: { confirm: boolean; all: boolean };
  try {
    args = parseBackfillArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : USAGE);
    process.exitCode = 1;
    return;
  }
  const env = parseEnv(z.object({ DATABASE_URL: z.string().url() }));
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    const result = await searchBackfill(db, args);
    printBackfillResult(result);
    if (result.missingColumn || result.failure) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (pathToFileURL(realpathSync(process.argv[1]!)).href === import.meta.url) {
  main().catch((e) => {
    console.error(safeErrorLabel(e));
    process.exitCode = 1;
  });
}
```

In `apps/news-api/package.json`'s `scripts`, after `"import:legacy"`, add:

```json
    "search-backfill": "tsx src/cli/search-backfill.ts",
```

In the root `package.json`'s `scripts`, after `"nrms:replay-activity-links"`, add:

```json
    "news-api:search-backfill": "npm --workspace @gcpe/news-api run search-backfill --",
```

- [ ] **Step 18: Run them, the whole News API suite and the type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api`
Expected: PASS, the v1 compatibility suite included.

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

- [ ] **Step 19: Runbook and running notes**

Append to `## Search and embeddings (Phase 6a)` in `docs/deploy/siteground.md`:

```markdown
### Search columns and the backfill

**Migration:** the News API's `0003_post_search` adds `posts.search_text`, the generated `posts.search_vector` (`to_tsvector('english', …)`) and a GIN index. It runs at startup like the others. Adding a generated column rewrites `posts` once under a lock, so the first start after the deploy takes longer, in proportion to the number of posts. No extension is needed; it runs on SiteGround as is.

**After deploy, once:** posts written before this deploy have no search text, so search can't find them until the backfill runs. Run it from a full checkout, outside the running stack, with the News API's database URL (the value of `NEWSAPI_DATABASE_URL`), as for the other commands:

```sh
DATABASE_URL=... npm run news-api:search-backfill              # dry run: how many posts it would fill
DATABASE_URL=... npm run news-api:search-backfill -- --confirm # fill them, 200 per transaction
```

It is safe to re-run: it fills only posts with no search text. `-- --all --confirm` recomputes every post (for example after a change to what search text contains). Exit code `0` is done; `1` means it stopped (it prints the label) or the column doesn't exist yet, in which case start the News API first. New and updated posts get their search text as they are written, so after one run nothing more is needed.

**Search language:** the column's language is fixed by the migration (`english`). The tenant's `search.language` must match, or the News API refuses to start: "Tenant search.language is "…" but posts.search_vector uses "…"". A tenant that needs another language adds its own drizzle-kit migration that redefines `search_vector` with that configuration, and sets `search.language` to match.
```

Append to the Phase 6a list in `docs/manuals/running-notes.md`:

```markdown
- **Operations** — After the first 6a deploy, run `npm run news-api:search-backfill` (a dry run) and then `-- --confirm` once, with the News API's `DATABASE_URL`. Until then search can't find older posts. New and updated posts get their search text when they're written. The News API refuses to start when the tenant's `search.language` differs from the database's search column (`english` from the migration).
- **Developer** — `applyRelease` writes `posts.search_text` for both NRMS events and the legacy importer (`src/search/search-text.ts`: headlines, summary, keywords, location, subheadlines and bodies, capped at 100,000 characters so the generated tsvector never exceeds Postgres's 1 MB). v1 reads select every column except the two search columns.
```

- [ ] **Step 20: Commit**

```bash
git add apps/news-api package.json docs/deploy/siteground.md docs/manuals/running-notes.md
git commit -m "feat(news-api): full-text search columns, written on every post write, with a backfill command"
```

---

### Task 5: `GET /api/v2/search` in text mode, with a mode seam for 6b

**Risk:** high (a public route; logging privacy; must not disturb v1). **Review:** full review D.

**Files:**
- Create:
  - `apps/news-api/src/search/query.ts` and `query.test.ts`;
  - `apps/news-api/src/search/text-search.ts`;
  - `apps/news-api/src/search/service.ts`;
  - `apps/news-api/src/search/search.test.ts`;
  - `apps/news-api/src/http/v2/routes.ts` and `search.test.ts`.
- Modify:
  - `apps/news-api/src/app.ts`, `src/env.ts`, `src/env.test.ts` and `src/start.ts`;
  - `apps/stack/src/stack.ts`;
  - `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/deploy/siteground.md` and `docs/manuals/running-notes.md`.

**Interfaces:**
- Consumes:
  - `posts.searchVector` and `PostRow` (Task 4);
  - `SearchLanguage` and `wallClockToInstant(d, timeZone)` (`@gcpe/config`, at HEAD);
  - `postKindSchema` (`@gcpe/events`, at HEAD);
  - `formatOffsetDateTime(date, tz)` (`src/time.ts`, at HEAD).
- Produces:

```ts
// apps/news-api/src/search/query.ts
export const SEARCH_PAGE_SIZE = 20, SEARCH_MAX_PAGE = 50, SEARCH_MAX_QUERY_CHARS = 200, SEARCH_MAX_KEY_CHARS = 100;
export interface SearchQuery { q: string; ministry?: string; sector?: string; type?: PostKind; from?: Date; toExclusive?: Date; page: number }
export type ParsedSearchQuery = { ok: true; query: SearchQuery } | { ok: false; parameter: string; message: string };
export function parseSearchQuery(raw: Record<string, unknown>, timeZone: string): ParsedSearchQuery;
// apps/news-api/src/search/text-search.ts
export interface SearchRow { key: string; kind: string; headline: string | null; summary: string | null; publishDate: Date; leadMinistryKey: string | null }
export interface SearchPage { total: number; rows: SearchRow[] }
export interface TextSearchOptions { language: SearchLanguage; defaultLanguageId: number; excludeKeys?: string[] }
export function searchFilters(query: SearchQuery): SQL[];   // published + ministry/sector/type/date filters
export async function textSearch(db: Db, query: SearchQuery, opts: TextSearchOptions): Promise<SearchPage>;
// apps/news-api/src/search/service.ts
export type SearchMode = "text" | "semantic";
export interface SearchResult { key: string; kind: string; headline: string | null; summary: string | null; publishDate: string; leadMinistryKey: string | null; url: string }
export interface SearchResponse { mode: SearchMode; page: number; total: number; results: SearchResult[] }
/** 6b: answers the whole page, or null to fall back to text. */
export interface SemanticSearch { search(query: SearchQuery): Promise<SearchPage | null> }
export interface SearchServiceOptions { db: Db; timeZone: string; language: SearchLanguage; defaultLanguageId: number; publicSiteUrl: string; semantic?: SemanticSearch | null; log?: (line: string) => void }
export interface SearchService { readonly timeZone: string; search(query: SearchQuery): Promise<SearchResponse> }
export function createSearchService(o: SearchServiceOptions): SearchService;
// apps/news-api/src/http/v2/routes.ts
export function v2Routes(deps: { search?: SearchService }): express.Router;
// apps/news-api/src/app.ts
AppDeps.search?: SearchService   // absent: /api/v2/search answers the v2 404
```

- [ ] **Step 1: Write the failing query-parsing tests**

`apps/news-api/src/search/query.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "./query";

const TZ = "America/Vancouver";
const ok = (raw: Record<string, unknown>) => {
  const r = parseSearchQuery(raw, TZ);
  if (!r.ok) throw new Error(`expected ok, got ${r.parameter}`);
  return r.query;
};

describe("parseSearchQuery", () => {
  it("trims q and defaults page to 1", () => {
    expect(ok({ q: "  wildfire  " })).toEqual({ q: "wildfire", page: 1 });
  });

  it("counts q in code points: 200 emoji pass, 201 characters fail", () => {
    expect(ok({ q: "🔥".repeat(200) }).q).toHaveLength(400);
    expect(parseSearchQuery({ q: "a".repeat(201) }, TZ)).toMatchObject({ ok: false, parameter: "q" });
  });

  it("turns from and to into whole BC calendar days", () => {
    const q = ok({ q: "x", from: "2026-10-01", to: "2026-10-01" });
    expect(q.from?.toISOString()).toBe("2026-10-01T07:00:00.000Z");
    expect(q.toExclusive?.toISOString()).toBe("2026-10-02T07:00:00.000Z");
    // After BC's permanent UTC-7 (2026-11-01) and before it, the offset comes from tzdata.
    expect(ok({ q: "x", from: "2027-01-15" }).from?.toISOString()).toBe("2027-01-15T07:00:00.000Z");
  });

  it("keeps ministry, sector and type", () => {
    expect(ok({ q: "x", ministry: "Health", sector: "economy", type: "stories", page: "3" })).toEqual({
      q: "x", ministry: "Health", sector: "economy", type: "stories", page: 3,
    });
  });

  it.each([
    [{}, "q"],
    [{ q: "   " }, "q"],
    [{ q: ["a", "b"] }, "q"],
    [{ q: "x", page: "0" }, "page"],
    [{ q: "x", page: "51" }, "page"],
    [{ q: "x", page: "1.5" }, "page"],
    [{ q: "x", page: "abc" }, "page"],
    [{ q: "x", page: ["1", "2"] }, "page"],
    [{ q: "x", type: "memos" }, "type"],
    [{ q: "x", ministry: "" }, "ministry"],
    [{ q: "x", sector: "s".repeat(101) }, "sector"],
    [{ q: "x", from: "2026-02-30" }, "from"],
    [{ q: "x", from: "0099-01-01" }, "from"],
    [{ q: "x", from: "2026-1-5" }, "from"],
    [{ q: "x", to: "2200-01-01" }, "to"],
    [{ q: "x", from: "2026-10-02", to: "2026-10-01" }, "to"],
  ])("refuses %j, naming %s", (raw, parameter) => {
    const r = parseSearchQuery(raw as Record<string, unknown>, TZ);
    expect(r).toMatchObject({ ok: false, parameter });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/search/query.test.ts`
Expected: FAIL, "Failed to resolve import "./query"".

- [ ] **Step 3: Implement `query.ts`**

`apps/news-api/src/search/query.ts`:

```ts
import { wallClockToInstant } from "@gcpe/config";
import { postKindSchema, type PostKind } from "@gcpe/events";

export const SEARCH_PAGE_SIZE = 20;
export const SEARCH_MAX_PAGE = 50;
export const SEARCH_MAX_QUERY_CHARS = 200;
export const SEARCH_MAX_KEY_CHARS = 100;
const MIN_YEAR = 1900;
const MAX_YEAR = 2199;

export interface SearchQuery {
  q: string;
  ministry?: string;
  sector?: string;
  type?: PostKind;
  /** The first instant of the `from` day in the tenant's time zone. */
  from?: Date;
  /** The first instant of the day after `to`, in the tenant's time zone. */
  toExclusive?: Date;
  page: number;
}

export type ParsedSearchQuery = { ok: true; query: SearchQuery } | { ok: false; parameter: string; message: string };

class Invalid {
  constructor(readonly parameter: string, readonly message: string) {}
}

function single(raw: Record<string, unknown>, name: string): string | undefined {
  const v = raw[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Invalid(name, `${name} must be given once`);
  return v;
}

function key(raw: Record<string, unknown>, name: string): string | undefined {
  const v = single(raw, name)?.trim();
  if (v === undefined) return undefined;
  if (v.length < 1 || v.length > SEARCH_MAX_KEY_CHARS) throw new Invalid(name, `${name} must be 1-${SEARCH_MAX_KEY_CHARS} characters`);
  return v;
}

/** The first instant of `ymd` (`YYYY-MM-DD`) plus `addDays`, in `timeZone`. */
function dayStart(raw: Record<string, unknown>, name: string, timeZone: string, addDays: number): Date | undefined {
  const v = single(raw, name);
  if (v === undefined) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const message = `${name} must be a date YYYY-MM-DD between ${MIN_YEAR} and ${MAX_YEAR}`;
  if (!m) throw new Invalid(name, message);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < MIN_YEAR || y > MAX_YEAR) throw new Invalid(name, message);
  const wall = new Date(Date.UTC(y, mo - 1, d));
  if (wall.getUTCFullYear() !== y || wall.getUTCMonth() !== mo - 1 || wall.getUTCDate() !== d) throw new Invalid(name, message);
  wall.setUTCDate(wall.getUTCDate() + addDays);
  return wallClockToInstant(wall, timeZone);
}

/** Validates `GET /api/v2/search`'s query (spec §5.4). Messages state the rule, never the value. */
export function parseSearchQuery(raw: Record<string, unknown>, timeZone: string): ParsedSearchQuery {
  try {
    const q = single(raw, "q")?.trim() ?? "";
    const chars = Array.from(q).length;
    if (chars < 1 || chars > SEARCH_MAX_QUERY_CHARS) throw new Invalid("q", `q must be 1-${SEARCH_MAX_QUERY_CHARS} characters`);

    const pageRaw = single(raw, "page");
    const page = pageRaw === undefined ? 1 : /^\d{1,3}$/.test(pageRaw) ? Number(pageRaw) : NaN;
    if (!(page >= 1 && page <= SEARCH_MAX_PAGE)) throw new Invalid("page", `page must be a whole number from 1 to ${SEARCH_MAX_PAGE}`);

    const typeRaw = single(raw, "type");
    const type = typeRaw === undefined ? undefined : postKindSchema.safeParse(typeRaw);
    if (type && !type.success) throw new Invalid("type", `type must be one of ${postKindSchema.options.join(", ")}`);

    const query: SearchQuery = { q, page };
    const ministry = key(raw, "ministry");
    const sector = key(raw, "sector");
    if (ministry !== undefined) query.ministry = ministry;
    if (sector !== undefined) query.sector = sector;
    if (type?.success) query.type = type.data;
    const from = dayStart(raw, "from", timeZone, 0);
    const toExclusive = dayStart(raw, "to", timeZone, 1);
    if (from && toExclusive && toExclusive <= from) throw new Invalid("to", "to must not be before from");
    if (from) query.from = from;
    if (toExclusive) query.toExclusive = toExclusive;
    return { ok: true, query };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, parameter: e.parameter, message: e.message };
    throw e;
  }
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/search/query.test.ts`
Expected: PASS (20 tests).

- [ ] **Step 5: Write the failing search tests (real Postgres)**

`apps/news-api/src/search/search.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { createNewsTestDb, TZ } from "../../test/helpers";
import { applyRelease, unpublishRelease } from "../projections";
import type { SearchQuery } from "./query";
import { createSearchService, type SemanticSearch } from "./service";
import { textSearch } from "./text-search";

const OPTS = { language: "english" as const, defaultLanguageId: 4105 };

function release(key: string, o: { headline?: string; body?: string; publishDate?: string; kind?: ReleaseRecord["kind"]; ministryKeys?: string[]; sectorKeys?: string[] } = {}): ReleaseRecord {
  return {
    ...sampleRelease,
    key,
    reference: null,
    kind: o.kind ?? "releases",
    summary: null,
    keywords: null,
    location: null,
    publishDate: o.publishDate ?? "2026-10-01T10:00:00-07:00",
    leadMinistryKey: o.ministryKeys?.[0] ?? null,
    ministryKeys: o.ministryKeys ?? [],
    sectorKeys: o.sectorKeys ?? [],
    documents: [{ ...sampleRelease.documents[0]!, headline: o.headline ?? key, detailsHtml: `<p>${o.body ?? ""}</p>` }],
  };
}

describe("textSearch and the search service", () => {
  let tdb: TestDatabase;
  const q = (over: Partial<SearchQuery>): SearchQuery => ({ q: "wildfire", page: 1, ...over });
  const keys = async (query: SearchQuery, excludeKeys?: string[]) => (await textSearch(tdb.db, query, { ...OPTS, excludeKeys })).rows.map((r) => r.key);
  const seed = async (...rs: ReleaseRecord[]) => {
    for (const r of rs) await tdb.db.transaction((tx) => applyRelease(tx, r, { notify: false }));
  };

  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE posts");
  });

  it("ranks by ts_rank_cd, then newest first, then key", async () => {
    await seed(
      release("R-MANY", { headline: "Wildfire update", body: "wildfire crews and wildfire smoke", publishDate: "2026-10-01T10:00:00-07:00" }),
      release("R-ONE", { headline: "Budget", body: "one wildfire mention", publishDate: "2026-10-03T10:00:00-07:00" }),
      release("R-TIE-OLD", { headline: "Budget", body: "one wildfire mention", publishDate: "2026-10-02T10:00:00-07:00" }),
      release("R-NONE", { headline: "School", body: "nothing relevant" }),
    );
    expect(await keys(q({}))).toEqual(["R-MANY", "R-ONE", "R-TIE-OLD"]);
    expect((await textSearch(tdb.db, q({}), OPTS)).total).toBe(3);
  });

  it("matches word forms (english stemming) and websearch syntax", async () => {
    await seed(release("R-1", { body: "Wildfires near Kamloops" }), release("R-2", { body: "Wildfire near Kelowna" }));
    expect((await keys(q({ q: "wildfire" }))).sort()).toEqual(["R-1", "R-2"]);
    expect(await keys(q({ q: "wildfire -kelowna" }))).toEqual(["R-1"]);
    expect(await keys(q({ q: '"near kamloops"' }))).toEqual(["R-1"]);
  });

  it("filters by ministry and sector case-insensitively, and by type", async () => {
    await seed(
      release("R-HEALTH", { body: "wildfire", ministryKeys: ["Health"], sectorKeys: ["economy"] }),
      release("R-FIN", { body: "wildfire", ministryKeys: ["finance"] }),
      release("R-STORY", { body: "wildfire", kind: "stories" }),
    );
    expect(await keys(q({ ministry: "HEALTH" }))).toEqual(["R-HEALTH"]);
    expect(await keys(q({ sector: "Economy" }))).toEqual(["R-HEALTH"]);
    expect(await keys(q({ type: "stories" }))).toEqual(["R-STORY"]);
    expect(await keys(q({ ministry: "no-such-ministry" }))).toEqual([]);
  });

  it("from and to are whole BC calendar days", async () => {
    await seed(
      release("R-EARLY", { body: "wildfire", publishDate: "2026-10-01T00:30:00-07:00" }),
      release("R-LATE", { body: "wildfire", publishDate: "2026-10-01T23:59:00-07:00" }),
      release("R-NEXT", { body: "wildfire", publishDate: "2026-10-02T00:00:00-07:00" }),
    );
    const oct1 = { from: new Date("2026-10-01T07:00:00Z"), toExclusive: new Date("2026-10-02T07:00:00Z") };
    expect((await keys(q(oct1))).sort()).toEqual(["R-EARLY", "R-LATE"]);
    expect(await keys(q({ from: new Date("2026-10-02T07:00:00Z") }))).toEqual(["R-NEXT"]);
  });

  it("never returns an unpublished post", async () => {
    await seed(release("R-GONE", { body: "wildfire" }), release("R-LIVE", { body: "wildfire" }));
    await tdb.db.transaction((tx) => unpublishRelease(tx, "R-GONE"));
    expect(await keys(q({}))).toEqual(["R-LIVE"]);
  });

  it("pages 20 at a time with the same total on every page", async () => {
    await seed(...Array.from({ length: 25 }, (_, i) => release(`F-${String(i).padStart(2, "0")}`, { body: "ferry sailing" })));
    const p1 = await textSearch(tdb.db, q({ q: "ferry", page: 1 }), OPTS);
    const p2 = await textSearch(tdb.db, q({ q: "ferry", page: 2 }), OPTS);
    const p3 = await textSearch(tdb.db, q({ q: "ferry", page: 3 }), OPTS);
    expect([p1.rows.length, p2.rows.length, p3.rows.length]).toEqual([20, 5, 0]);
    expect([p1.total, p2.total, p3.total]).toEqual([25, 25, 25]);
    expect(new Set([...p1.rows, ...p2.rows].map((r) => r.key)).size).toBe(25);
  });

  it("a stop-word-only or punctuation-only query matches nothing and does not fail", async () => {
    await seed(release("R-1", { body: "the wildfire" }));
    for (const text of ["the", "!!!", "-", '"']) {
      expect(await textSearch(tdb.db, q({ q: text }), OPTS)).toEqual({ total: 0, rows: [] });
    }
  });

  it("drops excludeKeys, case-insensitively (the seam 6b's text branch uses)", async () => {
    await seed(release("R-A", { body: "wildfire" }), release("R-B", { body: "wildfire" }));
    expect(await keys(q({}), ["r-a"])).toEqual(["R-B"]);
  });

  it("takes the headline from the default-language document, else the first", async () => {
    const doc = sampleRelease.documents[0]!;
    await seed({
      ...release("R-BI", { body: "wildfire" }),
      documents: [
        { ...doc, languageId: 1036, headline: "Incendie", detailsHtml: "<p>wildfire</p>" },
        { ...doc, languageId: 4105, headline: "Wildfire", detailsHtml: "<p>wildfire</p>" },
      ],
    });
    expect((await textSearch(tdb.db, q({}), OPTS)).rows[0]?.headline).toBe("Wildfire");
  });

  describe("createSearchService", () => {
    const service = (semantic?: SemanticSearch | null, log?: (l: string) => void) =>
      createSearchService({ db: tdb.db, timeZone: TZ, ...OPTS, publicSiteUrl: "https://news.example.test/", semantic, log });

    it("answers text mode with the response shape, BC offsets and public URLs", async () => {
      await seed({ ...release("2026TT0103-001121", { headline: "Wildfire update", body: "wildfire" }), summary: "Crews respond.", leadMinistryKey: "forests", ministryKeys: ["forests"] });
      expect(await service().search(q({}))).toEqual({
        mode: "text",
        page: 1,
        total: 1,
        results: [{
          key: "2026TT0103-001121",
          kind: "releases",
          headline: "Wildfire update",
          summary: "Crews respond.",
          publishDate: "2026-10-01T10:00:00-07:00",
          leadMinistryKey: "forests",
          url: "https://news.example.test/releases/2026TT0103-001121",
        }],
      });
    });

    it("uses the semantic branch's page when it answers, and falls back to text on null or a throw", async () => {
      await seed(release("R-TEXT", { body: "wildfire" }));
      const page = { total: 1, rows: [{ key: "R-SEM", kind: "releases", headline: "H", summary: null, publishDate: new Date("2026-10-01T17:00:00Z"), leadMinistryKey: null }] };
      expect((await service({ search: async () => page }).search(q({})))).toMatchObject({ mode: "semantic", results: [{ key: "R-SEM" }] });
      expect((await service({ search: async () => null }).search(q({})))).toMatchObject({ mode: "text", results: [{ key: "R-TEXT" }] });
      const lines: string[] = [];
      const thrown = await service({ search: async () => { throw new Error("embedding wildfire failed"); } }, (l) => lines.push(l)).search(q({}));
      expect(thrown).toMatchObject({ mode: "text", results: [{ key: "R-TEXT" }] });
      expect(lines).toEqual(["[news-api] search semantic branch failed Error"]);
    });
  });
});
```

- [ ] **Step 6: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/search/search.test.ts`
Expected: FAIL, "Failed to resolve import "./service"".

- [ ] **Step 7: Implement `text-search.ts` and `service.ts`**

`apps/news-api/src/search/text-search.ts`:

```ts
import { and, arrayContains, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import type { SearchLanguage } from "@gcpe/config";
import type { Db } from "@gcpe/db-kit";
import { posts } from "../db/schema";
import { SEARCH_PAGE_SIZE, type SearchQuery } from "./query";

export interface SearchRow {
  key: string;
  kind: string;
  headline: string | null;
  summary: string | null;
  publishDate: Date;
  leadMinistryKey: string | null;
}

export interface SearchPage {
  total: number;
  rows: SearchRow[];
}

export interface TextSearchOptions {
  language: SearchLanguage;
  /** Picks the headline: this language's document, else the first. */
  defaultLanguageId: number;
  /** Keys to leave out, case-insensitively. 6b's text branch passes the vector branch's keys. */
  excludeKeys?: string[];
}

const KEY_DESC = sql`${posts.key} collate "C" desc`;

/** Published posts matching the query's filters. Shared with 6b's vector branch. */
export function searchFilters(query: SearchQuery): SQL[] {
  const conds: SQL[] = [eq(posts.isPublished, true)];
  if (query.ministry) conds.push(arrayContains(posts.indexKeys, [`ministries:${query.ministry.toLowerCase()}`]));
  if (query.sector) conds.push(arrayContains(posts.indexKeys, [`sectors:${query.sector.toLowerCase()}`]));
  if (query.type) conds.push(eq(posts.kind, query.type));
  if (query.from) conds.push(gte(posts.publishDate, query.from));
  if (query.toExclusive) conds.push(lt(posts.publishDate, query.toExclusive));
  return conds;
}

/** Spec §5.4 text mode: websearch_to_tsquery against search_vector, ts_rank_cd, then newest first. */
export async function textSearch(db: Db, query: SearchQuery, opts: TextSearchOptions): Promise<SearchPage> {
  const tsquery = sql`websearch_to_tsquery(${opts.language}::regconfig, ${query.q})`;
  const conds = [...searchFilters(query), sql`${posts.searchVector} @@ ${tsquery}`];
  const excluded = (opts.excludeKeys ?? []).map((k) => k.toLowerCase());
  if (excluded.length > 0) conds.push(sql`lower(${posts.key}) NOT IN (${sql.join(excluded.map((k) => sql`${k}`), sql`, `)})`);
  const where = and(...conds);

  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)::int` }).from(posts).where(where);
  if (total === 0) return { total: 0, rows: [] };
  const rows = await db
    .select({
      key: posts.key,
      kind: posts.kind,
      documents: posts.documents,
      summary: posts.summary,
      publishDate: posts.publishDate,
      leadMinistryKey: posts.leadMinistryKey,
    })
    .from(posts)
    .where(where)
    .orderBy(sql`ts_rank_cd(${posts.searchVector}, ${tsquery}) desc`, desc(posts.publishDate), KEY_DESC)
    .limit(SEARCH_PAGE_SIZE)
    .offset((query.page - 1) * SEARCH_PAGE_SIZE);
  return {
    total,
    rows: rows.map(({ documents, ...r }) => ({
      ...r,
      headline: (documents.find((d) => d.languageId === opts.defaultLanguageId) ?? documents[0])?.headline ?? null,
    })),
  };
}
```

`apps/news-api/src/search/service.ts`:

```ts
import type { SearchLanguage } from "@gcpe/config";
import type { Db } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import { formatOffsetDateTime } from "../time";
import type { SearchQuery } from "./query";
import { textSearch, type SearchPage, type SearchRow } from "./text-search";

export type SearchMode = "text" | "semantic";

export interface SearchResult {
  key: string;
  kind: string;
  headline: string | null;
  summary: string | null;
  publishDate: string;
  leadMinistryKey: string | null;
  url: string;
}

export interface SearchResponse {
  mode: SearchMode;
  page: number;
  total: number;
  results: SearchResult[];
}

/** Semantic mode (6b): the whole page, or null to fall back to text. */
export interface SemanticSearch {
  search(query: SearchQuery): Promise<SearchPage | null>;
}

export interface SearchServiceOptions {
  db: Db;
  timeZone: string;
  language: SearchLanguage;
  defaultLanguageId: number;
  /** Results link to `<publicSiteUrl>/releases/<key>`. */
  publicSiteUrl: string;
  semantic?: SemanticSearch | null;
  log?: (line: string) => void;
}

export interface SearchService {
  readonly timeZone: string;
  search(query: SearchQuery): Promise<SearchResponse>;
}

export function createSearchService(o: SearchServiceOptions): SearchService {
  const base = o.publicSiteUrl.replace(/\/+$/, "");
  const log = o.log ?? ((line: string) => console.error(line));
  const toResult = (r: SearchRow): SearchResult => ({
    key: r.key,
    kind: r.kind,
    headline: r.headline,
    summary: r.summary,
    publishDate: formatOffsetDateTime(r.publishDate, o.timeZone),
    leadMinistryKey: r.leadMinistryKey,
    url: `${base}/releases/${encodeURIComponent(r.key)}`,
  });
  return {
    timeZone: o.timeZone,
    async search(query) {
      let semantic: SearchPage | null = null;
      if (o.semantic) {
        try {
          semantic = await o.semantic.search(query);
        } catch (e) {
          log(`[news-api] search semantic branch failed ${safeErrorLabel(e)}`);
        }
      }
      const page = semantic ?? (await textSearch(o.db, query, { language: o.language, defaultLanguageId: o.defaultLanguageId }));
      return { mode: semantic ? "semantic" : "text", page: query.page, total: page.total, results: page.rows.map(toResult) };
    },
  };
}
```

- [ ] **Step 8: Run them to see them pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/search`
Expected: PASS.

- [ ] **Step 9: Write the failing HTTP tests**

`apps/news-api/src/http/v2/search.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { jsonErrorHandler } from "@gcpe/http-kit";
import { createApp } from "../../app";
import { createNewsTestDb, envelope, EVENT_SECRETS, sendEvent, TZ } from "../../../test/helpers";
import type { SearchQuery } from "../../search/query";
import { createSearchService, type SearchService } from "../../search/service";
import { v2Routes } from "./routes";

const MARKER = "zqxmarker";

function stubApp(search: SearchService | undefined) {
  const app = express();
  app.use("/api/v2", v2Routes({ search }));
  app.use(jsonErrorHandler({ logPrefix: "[news-api]" }));
  return app;
}

describe("GET /api/v2/search (HTTP)", () => {
  const calls: SearchQuery[] = [];
  const stub: SearchService = {
    timeZone: TZ,
    async search(query) {
      calls.push(query);
      return { mode: "text", page: query.page, total: 0, results: [] };
    },
  };
  afterEach(() => {
    calls.length = 0;
    vi.restoreAllMocks();
  });

  it("answers 200 with no-store and passes the parsed query through", async () => {
    const res = await request(stubApp(stub)).get("/api/v2/search?q=%20wildfire%20&ministry=Health&page=2");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ mode: "text", page: 2, total: 0, results: [] });
    expect(calls).toEqual([{ q: "wildfire", ministry: "Health", page: 2 }]);
  });

  it.each([
    ["", "q"],
    [`q=${MARKER}&q=${MARKER}`, "q"],
    [`q=${"a".repeat(201)}${MARKER}`, "q"],
    [`q=x&page=0`, "page"],
    [`q=x&page=51`, "page"],
    [`q=x&page=1.5`, "page"],
    [`q=x&type=${MARKER}`, "type"],
    [`q=x&from=2026-02-30`, "from"],
    [`q=x&from=0099-01-01`, "from"],
    [`q=x&from=2026-10-02&to=2026-10-01`, "to"],
  ])("refuses ?%s with a 400 naming %s, never echoing the value", async (qs, parameter) => {
    const res = await request(stubApp(stub)).get(`/api/v2/search?${qs}`);
    expect(res.status).toBe(400);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ error: { code: "InvalidParameter", parameter, message: expect.any(String) } });
    expect(res.text).not.toContain(MARKER);
    expect(calls).toEqual([]);
  });

  it("on a failure answers a generic 500 and logs the route and a safe label, never the query", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: SearchService = { timeZone: TZ, search: async (query) => { throw new Error(`bad tsquery near ${query.q}`); } };
    const res = await request(stubApp(failing)).get(`/api/v2/search?q=${MARKER}&ministry=${MARKER}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal error" });
    expect(error).toHaveBeenCalledTimes(1);
    const logged = error.mock.calls[0]!.map(String).join(" ");
    expect(logged).toContain("/api/v2/search");
    expect(logged).not.toContain(MARKER);
    expect(logged).not.toContain("?");
  });

  it("answers any other v2 path, and search when no service is wired, with a JSON 404 and no-store", async () => {
    for (const [app, path] of [[stubApp(stub), "/api/v2/nope"], [stubApp(undefined), "/api/v2/search?q=x"]] as const) {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toEqual({ error: "not found" });
    }
  });
});

describe("GET /api/v2/search through createApp (real Postgres)", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
    const search = createSearchService({ db: tdb.db, timeZone: TZ, language: "english", defaultLanguageId: 4105, publicSiteUrl: "https://news.example.test" });
    app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS, search });
    await sendEvent(app, envelope("nrms", "release.published", sampleRelease.key, sampleRelease));
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("finds a release published by event, without api-version", async () => {
    const res = await request(app).get("/api/v2/search?q=highway");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: "text",
      total: 1,
      results: [{ key: sampleRelease.key, publishDate: "2026-10-01T15:10:00-07:00", url: `https://news.example.test/releases/${sampleRelease.key}` }],
    });
  });

  it("leaves v1 as it was: api-version still required, and no search column in a post", async () => {
    expect((await request(app).get("/api/Home")).status).toBe(400);
    const post = await request(app).get(`/api/Posts/${sampleRelease.key}?api-version=1.0`);
    expect(post.status).toBe(200);
    expect(Object.keys(post.body)).not.toContain("searchText");
    expect(Object.keys(post.body)).not.toContain("searchVector");
    expect(post.headers["cache-control"]).toBe("no-cache");
  });
});
```

- [ ] **Step 10: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/http/v2/search.test.ts`
Expected: FAIL, "Failed to resolve import "./routes"".

- [ ] **Step 11: Implement the router and mount it**

`apps/news-api/src/http/v2/routes.ts`:

```ts
import express from "express";
import { parseSearchQuery } from "../../search/query";
import type { SearchService } from "../../search/service";

/**
 * `/api/v2` (spec §5.4). Mounted before v1's `/api` router, so v1's api-version rule and its
 * problem-JSON 404 never apply here. Every response is `no-store`. Errors go to the app's
 * jsonErrorHandler, which logs the method, the path (never the query string) and a safe label.
 */
export function v2Routes(deps: { search?: SearchService }): express.Router {
  const r = express.Router();
  r.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  const { search } = deps;
  if (search) {
    r.get("/search", async (req, res) => {
      const parsed = parseSearchQuery(req.query as Record<string, unknown>, search.timeZone);
      if (!parsed.ok) {
        return void res.status(400).json({ error: { code: "InvalidParameter", parameter: parsed.parameter, message: parsed.message } });
      }
      res.json(await search.search(parsed.query));
    });
  }
  r.use((_req, res) => void res.status(404).json({ error: "not found" }));
  return r;
}
```

In `apps/news-api/src/app.ts`:
- add `import { v2Routes } from "./http/v2/routes";` and `import type { SearchService } from "./search/service";`;
- add to `AppDeps`:

  ```ts
    /** `GET /api/v2/search`. Absent (most tests): that path answers v2's 404. */
    search?: SearchService;
  ```

- directly before `const api = express.Router();`, add:

  ```ts
    app.use("/api/v2", v2Routes({ search: deps.search }));
  ```

- [ ] **Step 12: Wire the service at startup, and the result URL's base**

In `apps/news-api/src/env.ts`, add after `MIGRATIONS_FOLDER` (before the embeddings spread):

```ts
    /** Search results link to `<PUBLIC_SITE_URL>/releases/<key>`. Default: the tenant's publicSiteBaseUrl. */
    PUBLIC_SITE_URL: z.string().url().optional(),
```

Add to `apps/news-api/src/env.test.ts`:

```ts
describe("newsApiEnvSchema PUBLIC_SITE_URL", () => {
  it("is optional and must be a URL when set", () => {
    expect(parseEnv(newsApiEnvSchema, BASE as unknown as NodeJS.ProcessEnv).PUBLIC_SITE_URL).toBeUndefined();
    expect(() => parseEnv(newsApiEnvSchema, { ...BASE, PUBLIC_SITE_URL: "boxs.ca/site" } as unknown as NodeJS.ProcessEnv)).toThrow(/PUBLIC_SITE_URL/);
  });
});
```

In `apps/news-api/src/start.ts`, add `import { createSearchService } from "./search/service";`, and add to the `createApp({ … })` call:

```ts
    search: createSearchService({
      db,
      timeZone: tenant.timeZone,
      language: tenant.search.language,
      defaultLanguageId: tenant.defaultLanguageId,
      publicSiteUrl: parsed.PUBLIC_SITE_URL ?? tenant.publicSiteBaseUrl,
    }),
```

In `apps/stack/src/stack.ts`, directly after the existing `if (nrmsEnv.PUBLIC_FILES_BASE === undefined) …` line, add:

```ts
  // Search results link to the public site this stack serves, not the tenant's production domain.
  if (newsApiEnv.PUBLIC_SITE_URL === undefined) newsApiEnv.PUBLIC_SITE_URL = siteEnv.PUBLIC_SITE_URL ?? tenant.publicSiteBaseUrl;
```

- [ ] **Step 13: Run every News API and stack test, and the type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api apps/stack packages/config packages/embeddings`
Expected: PASS. `apps/news-api/test/compat.test.ts` and `test/e2e-core.test.ts` are green and unedited.

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

- [ ] **Step 14: Parity rows and open questions**

In `docs/parity/changes-from-legacy.md`, append a new section at the end:

```markdown

## Public site and AI (Phase 6)

| # | Legacy | New | Why | Status |
|---|---|---|---|---|
| C201 | news.gov.bc.ca had no API search or related-posts endpoint. | v2 search, related posts and a change feed beside v1. v1 is unchanged. | The platform's own site and staff help need them (addendum §5.4); BC's webapp keeps reading v1 unchanged (D1). Search arrives in 6a, related posts and the change feed in 6b. | Agreed |
| C202 | — | The platform's own static site uses monthly archives, not numbered pages, and has no legacy URL redirects (BC keeps its webapp, D1). | Numbered pages shift with every publish; a month's archive changes only when one of its posts does (addendum §6.1). | Agreed |
| C203 | — | Staff "Similar published releases", behind a flag that is off until a PIA. | Helps staff find related published releases; draft text goes to the AI service only on an explicit click, and only once a PIA approves it (D4, Q71). | Agreed |
| C204 | Carousel images travelled inline (C42's budget). | Slide events carry image URLs. | Inline images made slide events big enough to need a budget; URLs keep events small and the site links the image (addendum §6.4). | Agreed |
```

In `docs/parity/open-questions.md`, append these rows to the end of the `## Open` table (just before the blank line and `## Answered`):

```markdown
| Q70 | Who provides the Azure OpenAI deployment (`text-embedding-3-small`, Canada region), and when? | Semantic search, related posts and the relevance spot-check need a real provider; the stand-in proves only the plumbing. | Stand-in provider until then; relevance spot-checks wait. | 2026-10-11 |
| Q71 | Who owns the PIA for staff AI on drafts, and is one also needed for embedding *published* releases? | Staff AI sends unpublished draft text to an external service; the flag stays off until a PIA approves it. | Published content needs none; drafts need one; flag stays off. | 2026-10-11 |
| Q72 | Do old release pages link straight to Azure Blob storage (Q13), and will the importers copy and rewrite those links? | Links straight to Blob storage break, or keep pointing at the old store, when storage moves at cutover, whichever site serves BC. | To be checked in Phase 7; it affects cutover under any option. | 2026-10-11 |
| Q73 | Does BC want its webapp to show v2 search or related posts before any move to the static site? | Showing them on BC's current site needs a change to `gcpe-news-webapp`, which this platform doesn't own. | No. That needs a change to `gcpe-news-webapp`, outside this platform. | 2026-10-11 |
```

Check that no number is duplicated:

```sh
grep -oE "^\| C2[0-9]{2}" docs/parity/changes-from-legacy.md | sort | uniq -d
grep -oE "^\| Q[0-9]+" docs/parity/open-questions.md | sort | uniq -d
```

Expected: both print nothing.

- [ ] **Step 15: Runbook and running notes**

Append to `## Search and embeddings (Phase 6a)` in `docs/deploy/siteground.md`:

```markdown
### The search route

`GET /api/v2/search?q=&ministry=&sector=&type=&from=&to=&page=` (on boxs.ca: `https://boxs.ca/api/v2/search?q=…`):

- It is full-text only in 6a: every response says `"mode": "text"`.
- It needs no `api-version`, and answers `Cache-Control: no-store`.
- `q` is 1–200 characters; `page` is 1–50 (20 results each); `from` and `to` are BC calendar dates (`YYYY-MM-DD`, inclusive); `type` is `releases`, `stories`, `factsheets`, `updates` or `advisories`.
- A bad parameter is a 400 that names it.
- Errors are logged to `/stack/errors` as the route and a label, never the search words.
- Result links use the stack's public site URL (`SITE_PUBLIC_SITE_URL`), or `NEWSAPI_PUBLIC_SITE_URL` when set.

**Hand checks on boxs.ca after the backfill:**
1. `curl -s 'https://boxs.ca/api/v2/search?q=highway'` lists releases mentioning highways, with `"mode":"text"` and links under `https://boxs.ca/site/releases/`.
2. `curl -si 'https://boxs.ca/api/v2/search?q=highway&page=99'` is a 400 whose body names `page`, with `cache-control: no-store`.
3. `curl -si 'https://boxs.ca/api/Home'` is still the 400 `ApiVersionUnspecified`: v1 is unchanged.
```

Append to the Phase 6a list in `docs/manuals/running-notes.md`:

```markdown
- **Developer** — `GET /api/v2/search` (text mode) lives in `src/http/v2/routes.ts` and `src/search/`. v2 is mounted before v1's `/api` router: no `api-version`, `no-store`, and a JSON 404 for unknown v2 paths. `createSearchService` takes an optional `semantic` branch, which returns a page or null; a null or a throw falls back to `textSearch`. 6b plugs semantic mode in there, reusing `searchFilters` and `textSearch`'s `excludeKeys`. The route never logs the query string.
- **Operations** — Search results link to `<PUBLIC_SITE_URL>/releases/<key>`. On the stack that defaults to the public site's own URL (`SITE_PUBLIC_SITE_URL`); elsewhere to the tenant's `publicSiteBaseUrl`. Set `NEWSAPI_PUBLIC_SITE_URL` to point results at another site, for example BC's webapp.
```

- [ ] **Step 16: Commit**

```bash
git add apps/news-api apps/stack/src/stack.ts docs/parity docs/deploy/siteground.md docs/manuals/running-notes.md
git commit -m "feat(news-api): GET /api/v2/search in text mode, with a seam for semantic mode"
```

---

## Phase 6a at a glance

| Task | Delivers | Exit evidence |
|---|---|---|
| 1 | Flags, search language, theme and the contrast check; BC and NB themes | `theme.test.ts` (13), `tenant.test.ts` (+7, one changed) |
| 2 | Providers, text helpers, env settings and the production guard | `packages/embeddings` text, stand-in, Azure and settings tests; `env.test.ts`; `stack-check.test.ts` (+2) |
| 3 | The breaker and the guarded embedder | `breaker.test.ts` (8), `guarded.test.ts` (4) |
| 4 | The migration, search text on every write, the language check, the backfill | `projections.test.ts` (+2), `language.test.ts` (3), `start.test.ts` (+1), `search-backfill.test.ts` (7); v1 suites unchanged |
| 5 | `/api/v2/search` in text mode, the mode seam, docs | `query.test.ts` (20), `search.test.ts` (11), `http/v2/search.test.ts` (15); the whole suite |

## Risks and things to watch

- **The first start after deploy rewrites `posts`.** `ADD COLUMN … GENERATED … STORED` rewrites the table under an exclusive lock, so the cold start takes longer in proportion to the number of posts. It's fine at boxs.ca's size. *Not measured* at legacy volume (about 100k posts); Phase 7's import rehearsal should time it.
- **Search can't find posts that predate the deploy until the backfill runs.** The runbook and running notes say so. Nothing breaks: those posts simply don't match.
- **`ts_rank_cd` without normalisation favours long releases** that repeat a word. This is the spec's choice. 6e's spot-check is where relevance gets judged.
- **The `english` configuration stems French text badly.** NB's example keeps `english`. A bilingual tenant needs a decision (and its own migration) before it relies on search.
- **Not checked here:**
  - semantic mode and the breaker under real Azure latency (6b, Q70);
  - the query cost on 100k rows: a GIN index is used for `@@`, but `count(*)` over a common word scans every match. *Not measured*; 6e's spot-check should time the slowest query.

## Self-review (done while writing)

1. **Spec coverage.**
   - §3: Task 1 (flags, language, theme, contrast, BC and NB).
   - §4:
     - interface, providers and env: Task 2;
     - breaker and logging: Task 3;
     - "No provider configured: null": Task 2's settings test.
   - §5.1:
     - columns, the write on every post write, the GIN index and the startup check: Task 4;
     - the language noted in the runbook: Task 4, Step 19;
     - the backfill: Task 4.
   - §5.4 (text mode):
     - inputs, ranking, filters, response, `no-store`, logging, and `mode: "text"` on fallback: Task 5;
     - semantic mode and the cache: 6b, through the `SemanticSearch` seam.
   - §8: "v2 route errors: safeErrorLabel plus the route" (Task 5's 500 test); runbook additions for the backfill and the Azure settings (Tasks 2 and 4). Flags, pgvector and the PIA gate come with 6b and 6d.
   - §9: provider contract, stand-in fixed output, breaker state changes, HTML stripping, contrast check, full-text ranking and filters. Each has its test above.
   - §11 and §12: Task 5, Step 14.
2. **Placeholder scan.** None. Every code step has its code, and every docs step its text.
3. **Type consistency.**
   - `SearchLanguage` (Task 1) is used by `assertSearchLanguage` (Task 4), `textSearch` and `createSearchService` (Task 5).
   - `htmlToPlainText` and `collapseWhitespace` (Task 2) are used by `searchTextFor` (Task 4).
   - `EmbeddingProvider` and `standInProvider` (Task 2) are used by `createGuardedEmbedder` (Task 3).
   - `PostRow`'s `Omit` (Task 4) keeps `dto.test.ts`'s literal valid.
   - `SearchQuery` (Task 5, Step 3) is consumed by `textSearch`, `searchFilters`, `SemanticSearch` and `v2Routes`.
   - `SearchService.timeZone` is read by `v2Routes`.
4. **Review Focus.** Each of the five has its named test in its owning task: Task 4 (1, 3) and Task 5 (2, 4, 5).
5. **Checked against the code at `35953d5` while planning** (in scratch copies, not in this worktree):
   - drizzle-kit 0.31 generated exactly Task 4's three statements from the schema change.
   - On Postgres 14.17:
     - the generated column, GIN index and `websearch_to_tsquery($1::regconfig, $2)` work;
     - `pg_get_expr` returns `to_tsvector('english'::regconfig, COALESCE(search_text, ''::text))`;
     - a stop-word query returns an empty tsquery;
     - about 2.7 MB of distinct words fails with "string is too long for tsvector".
   - The stand-in's pinned hash and its similarities (0.83 shared words, 0.00 none) were computed with the code in Task 2.
   - `htmlToPlainText`'s expected strings were computed with htmlparser2 10.1.0.
   - The breaker's transitions were exercised with the code in Task 3.
   - The contrast figures were computed with the formula in Task 1.
   - The whole plan was *not* applied and run end to end. The first full run is the implementers'.

## Execution

Execution method: subagent-driven. A fresh implementer per task, then a whole-branch review. Reviews are lighter this phase, as Paul asked: low-risk tasks share one, while the breaker, the migration with its backfill, and the search route with its logging each get their own.

| Review | Tasks | Kind | Why |
|---|---|---|---|
| A | 1, 2 | shared | Config, providers and env: pure tests, with one production guard |
| B | 3 | full | The breaker decides when visitors get the fallback |
| C | 4 | full | A migration on `posts`, every post write, and an irreversible bulk write |
| D | 5 | full | A public route: input bounds, logging privacy, v1 untouched |

Order: Task 1 → 2 → (3 and 4 in either order; 4 needs only Tasks 1 and 2) → 5. Review B can run while Task 4 is built.
