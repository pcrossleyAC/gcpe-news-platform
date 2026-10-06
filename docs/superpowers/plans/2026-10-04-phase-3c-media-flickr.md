# Phase 3c — Media, Files and Flickr Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff can attach translations (PDF) and media files to releases, manage page images, and use a Flickr photo as a release's headline asset that NRMS makes public — verified — when the release goes out, with retries, alerts and a fake Flickr for testing; uploaded files and the public site survive SiteGround redeploys.

**Architecture:** A persistent data directory outside the deploy folder holds the public site output and a new `@gcpe/storage` local-folder object store. NRMS gains upload endpoints, a `release_files` table, a Flickr client (OAuth 1.0a HMAC-SHA1, implemented with `node:crypto`), a `flickr_jobs` table with a worker that makes photos public before go-live, and body-embed normalisation via oEmbed. A `@gcpe/flickr-fake` Express router imitates the Flickr endpoints NRMS uses (signature-checked) and is mounted by the stack when `FLICKR_MODE=fake`.

**Tech Stack:** Node 24, TypeScript 5.9 strict, Express 5, Drizzle 0.45 / drizzle-kit 0.31, zod 3.25, Vitest 4.1, supertest. No new third-party runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-03-nrms-parity-design.md` §6.7 (storage), §7 (media and Flickr), §9 acceptance item 9. Phase overview: `docs/superpowers/plans/2026-10-03-phase-3-overview.md`. Builds on 3a (auth) and 3b (releases; publisher `prepareMedia` seam; Distribution client; stack defaults).

## Global Constraints

- Worktree `/Users/paul/gcpe-news-platform-p3`, branch `feat/phase-3`. Commit locally after each task. Never add a `Co-Authored-By` trailer or any AI attribution.
- Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`; type-check: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`. Deps: `npx -y npm@11 install <pkg> -w <workspace>`.
- Migrations generated with drizzle-kit (`cd apps/<app> && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`); data migrations `--custom`. If drizzle-kit prompts, stop and report.
- Worker time comparisons use the DB clock (`sqlNow`).
- Reads: any of `NRMS.Viewer`, `NRMS.Editor`, `NRMS.SiteEditor`; release writes: `NRMS.Editor`; page images: `NRMS.SiteEditor` or `NRMS.Editor`.
- Uploads: single request body (`express.raw`), limit 25 MiB for release files, 2 MiB for page images; content checked by magic bytes — PDF `%PDF-`, PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`. Translations: PDF only. Media asset files: PDF, PNG, JPEG.
- Stored file names: `<16 hex random>-<sanitised original name>`; sanitised = lowercase, `[a-z0-9._-]` only (others → `-`), collapse repeats, max 100 chars, never empty (`file`). Public URL path: `/files/<storage key>`.
- Flickr: OAuth 1.0a, HMAC-SHA1 only (verified 2026-10-03 against flickr.com/services/api/auth.oauth.html). Endpoints: REST `…/services/rest`, oEmbed `…/services/oembed`, OAuth `…/services/oauth/{request_token,authorize,access_token}`. Methods used: `flickr.photos.getInfo`, `flickr.photos.getPerms`, `flickr.photos.setPerms`. Env: `FLICKR_MODE` (`real` | `fake`, default `real`), `FLICKR_API_KEY`, `FLICKR_API_SECRET`, `FLICKR_ACCESS_TOKEN`, `FLICKR_ACCESS_SECRET`, `FLICKR_REST_URL` (default `https://api.flickr.com/services/rest`), `FLICKR_OEMBED_URL` (default `https://www.flickr.com/services/oembed`), `FLICKR_OAUTH_URL` (default `https://www.flickr.com/services/oauth`), `FLICKR_ALERT_EMAILS` (comma list).
- Flickr publish behaviour: retry for 2 minutes after the first attempt (grace), then publish without the photo, set the alert, email `FLICKR_ALERT_EMAILS`, keep retrying every 5 minutes for 24 hours; on success re-publish as a correction and clear the alert; after 24 hours stop and email again. Unpublish never makes a photo private.
- Never log secrets, tokens, request signatures or file contents.

## Review Focus

1. A redeploy on SiteGround (new release folder) → the public site's pages and every uploaded file are still served. (Task 1 tests a relative `SITE_OUTPUT_DIR` resolving under `DATA_DIR`; Task 1 self-heal test.)
2. An upload whose bytes don't match its claimed type (an `.exe` renamed `.pdf`, an HTML file named `.png`) → 422, nothing stored. (Task 3 tests.)
3. A file name like `../../etc/passwd` or `a"b\r\n.pdf` → stored under a safe generated key; no path escape, no header injection. (Task 2/3 tests.)
4. Flickr refusing auth (the legacy silent-failure case) → the job does not report success; after the grace period the release goes out without the photo and the alert is raised. (Task 6 test with the fake's `refuse-auth` switch.)
5. A body `<asset>` URL pointing at an unknown host or `javascript:` → becomes a plain link or is dropped; never an embed. (Task 7 tests.)

---

## File structure

| File | Responsibility |
|---|---|
| `apps/stack/src/data-dir.ts` (new) | Resolve and verify the persistent data directory |
| `apps/public-site/src/self-heal.ts` (new) | Rebuild home + recent posts when the output folder is empty |
| `packages/storage/src/index.ts`, `local.ts`, `names.ts` (new) | `ObjectStore` interface, local-folder driver, safe key/name helpers |
| `packages/storage/src/sniff.ts` (new) | Magic-byte content type detection |
| `apps/nrms/src/media/files.ts` (new) | Release files (translations, media assets) service |
| `apps/nrms/src/media/page-images.ts` (new) | Page image upload, update, bytes |
| `apps/nrms/src/media/flickr-client.ts` (new) | OAuth 1.0a signing, REST calls, oEmbed, photo-id parsing |
| `apps/nrms/src/media/flickr-jobs.ts` (new) | Make-public worker, `prepareMedia`, alerts, correction on recovery |
| `apps/nrms/src/media/embeds.ts` (new) | `<asset>` normalisation on save |
| `apps/nrms/src/cli/flickr-authorize.ts` (new) | One-time OAuth sign-in CLI |
| `packages/flickr-fake/src/index.ts` (new) | Fake Flickr router |
| `apps/nrms/src/http/media-routes.ts` (new) | Upload/list/delete/status routes |

---

### Task 1: Persistent data directory and public-site self-heal

**Files:**
- Create: `apps/stack/src/data-dir.ts`, `apps/stack/src/data-dir.test.ts`, `apps/public-site/src/self-heal.ts`, `apps/public-site/src/self-heal.test.ts`
- Modify: `apps/stack/src/env.ts`, `apps/stack/src/env.test.ts`, `apps/stack/src/stack.ts`, `apps/public-site/src/start.ts`, `docs/deploy/siteground.md`, `scripts/siteground-env.ts` (+ its test) only if it hard-codes `SITE_OUTPUT_DIR`

**Interfaces:**
- Produces:
  - `resolveDataDir(env: NodeJS.ProcessEnv, home?: string): string` — `DATA_DIR` if absolute; else `path.join(home ?? os.homedir(), "gcpe-data")` when unset; a relative `DATA_DIR` resolves against `home`.
  - `ensureWritableDir(dir: string): Promise<void>` — `mkdir -p`, writes and removes `.write-test-<random>`; on failure throws `Error("data directory <dir> is not writable: <reason>")`.
  - Stack env: `DATA_DIR` (shared key). In `envFor`: a relative `SITE_OUTPUT_DIR` (e.g. the generator's `./site-output`) resolves to `path.join(dataDir, <relative>)`; `NRMS_STORAGE_DIR` defaults to `path.join(dataDir, "storage")` (applied with the other `STACK_APP_DEFAULTS`, explicit wins). `envFor` takes the resolved data dir as a new optional argument so it stays pure.
  - Stack startup calls `ensureWritableDir` for the data dir before starting apps and fails fast with the message above.
  - Public site: `selfHeal({ newsApi, storage, site, count = 200 }): Promise<{ rebuilt: number } | null>` — when `index.html` is missing in the output folder, renders the home page and the latest `count` posts (from `newsApi.latestHome(count)`), returning how many posts it wrote; returns `null` when `index.html` exists. Called once at public-site start (errors logged as `[public-site] self-heal failed: <message>`, never thrown — the News API may not be up yet in standalone runs).

- [ ] **Step 1: Write the failing tests**

`apps/stack/src/data-dir.test.ts`:

```ts
import { mkdtemp, readdir, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureWritableDir, resolveDataDir } from "./data-dir";

describe("data dir", () => {
  const made: string[] = [];
  afterAll(async () => {
    for (const d of made) await rm(d, { recursive: true, force: true });
  });
  it("defaults to ~/gcpe-data, honours absolute DATA_DIR, resolves relative against home", () => {
    expect(resolveDataDir({}, "/home/x")).toBe("/home/x/gcpe-data");
    expect(resolveDataDir({ DATA_DIR: "/srv/data" }, "/home/x")).toBe("/srv/data");
    expect(resolveDataDir({ DATA_DIR: "data" }, "/home/x")).toBe("/home/x/data");
  });
  it("creates the folder, leaves no test file behind, and fails clearly when unwritable", async () => {
    const base = await mkdtemp(join(tmpdir(), "gcpe-dd-"));
    made.push(base);
    await ensureWritableDir(join(base, "a", "b"));
    expect(await readdir(join(base, "a", "b"))).toEqual([]);
    const locked = join(base, "locked");
    await ensureWritableDir(locked);
    await chmod(locked, 0o500);
    await expect(ensureWritableDir(locked)).rejects.toThrow(/data directory .*locked is not writable/);
    await chmod(locked, 0o700);
  });
});
```

Add to `apps/stack/src/env.test.ts`:

```ts
describe("persistent data dir in env views", () => {
  it("resolves a relative SITE_OUTPUT_DIR under the data dir and defaults NRMS STORAGE_DIR", () => {
    expect(envFor({ SITE_OUTPUT_DIR: "./site-output" }, "SITE", "/data").OUTPUT_DIR).toBe("/data/site-output");
    expect(envFor({ SITE_OUTPUT_DIR: "/abs/out" }, "SITE", "/data").OUTPUT_DIR).toBe("/abs/out");
    expect(envFor({}, "NRMS", "/data").STORAGE_DIR).toBe("/data/storage");
    expect(envFor({ NRMS_STORAGE_DIR: "/x" }, "NRMS", "/data").STORAGE_DIR).toBe("/x");
    expect(envFor({}, "CORE", "/data").STORAGE_DIR).toBeUndefined();
  });
});
```

`apps/public-site/src/self-heal.test.ts`: use a temp folder with `fsStorage` and a fake `NewsApiClient` returning two posts (use the post DTO fixture other public-site tests use — read `apps/public-site/src/rebuild.test.ts` for one). Assert: empty folder → `{ rebuilt: 2 }`, `index.html` and both `releases/<key>/index.html` exist; second call → `null` and the fake was not called again; a client whose `latestHome` throws → `selfHeal` rejects (the caller logs it; test the caller separately is not required).

- [ ] **Step 2: Run to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/stack/src/data-dir.test.ts apps/stack/src/env.test.ts apps/public-site/src/self-heal.test.ts`
Expected: FAIL (modules missing; `envFor` has no third parameter).

- [ ] **Step 3: Implement**

`apps/stack/src/data-dir.ts`:

```ts
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Where everything that must survive a redeploy lives (public site output, uploaded files).
 * SiteGround unpacks each deploy into a new folder under .nodeapp/, so nothing relative to
 * the app may hold state (verified 2026-10-04: the Phase 2 /site pages vanished after a deploy).
 */
export function resolveDataDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const v = env.DATA_DIR;
  if (!v) return join(home, "gcpe-data");
  return isAbsolute(v) ? v : resolve(home, v);
}

export async function ensureWritableDir(dir: string): Promise<void> {
  const probe = join(dir, `.write-test-${randomBytes(6).toString("hex")}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, "ok");
    await rm(probe);
  } catch (e) {
    throw new Error(`data directory ${dir} is not writable: ${e instanceof Error ? e.message : String(e)}`);
  }
}
```

`envFor(env, prefix, dataDir?)`: after applying `STACK_APP_DEFAULTS` and before prefixed vars, if `dataDir` is given and `prefix === "NRMS"`, set `view.STORAGE_DIR = join(dataDir, "storage")`; after prefixed vars are applied, if `dataDir` is given, `prefix === "SITE"` and `view.OUTPUT_DIR` is relative, replace it with `join(dataDir, view.OUTPUT_DIR)`. Add `DATA_DIR` to the shared keys. Update `stack.ts` to resolve the data dir once (`resolveDataDir(env)`), `await ensureWritableDir(dataDir)` before starting apps, and pass it into every `envFor` call (through `resolvedEnvFor`).

`apps/public-site/src/self-heal.ts`: reuse `renderHomePage` / `renderPostPage` and the same key validation and `releases/<key>/index.html` path as `rebuild.ts` (extract a shared `postPath(key)` helper there rather than duplicating the regex). Needs a way to check existence: add `exists(path): Promise<boolean>` to `SiteStorage` (`apps/public-site/src/storage.ts`) with the same path-safety checks as `write`.

`apps/public-site/src/start.ts`: after building the handler, `void selfHeal(...).then((r) => r && console.log(\`[public-site] self-heal rebuilt \${r.rebuilt} posts\`)).catch((e) => console.error(\`[public-site] self-heal failed: \${e instanceof Error ? e.message : e}\`))`.

`docs/deploy/siteground.md`: a "Persistent data" section — `DATA_DIR` default `~/gcpe-data` (outside `.nodeapp/<release>/`), what lives there (`site-output/`, `storage/`), that the stack refuses to start if it isn't writable, and that the public site rebuilds itself on start if its pages are missing.

- [ ] **Step 4: Run to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/stack apps/public-site && npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: PASS. Then the full suite.

- [ ] **Step 5: Commit**

```bash
git add apps/stack apps/public-site docs/deploy scripts tests
git commit -m "fix(stack): keep site output and uploads in a persistent data dir; public site self-heals after a redeploy"
```

---

### Task 2: `@gcpe/storage` — local object store and content sniffing

**Files:**
- Create: `packages/storage/package.json`, `packages/storage/src/index.ts`, `packages/storage/src/names.ts`, `packages/storage/src/local.ts`, `packages/storage/src/sniff.ts`, `packages/storage/src/storage.test.ts`

**Interfaces:**
- Produces (`@gcpe/storage`):
  - `interface StoredObject { key: string; contentType: string; size: number; updatedAt: Date }`
  - `interface ObjectStore { put(key: string, bytes: Buffer, contentType: string): Promise<StoredObject>; get(key: string): Promise<{ bytes: Buffer; meta: StoredObject } | null>; delete(key: string): Promise<boolean>; list(prefix: string): Promise<StoredObject[]>; publicPath(key: string): string }`
  - `localStore(root: string, publicPrefix = "/files/"): ObjectStore` — objects at `<root>/<key>`, metadata at `<root>/.meta/<key>.json` (`{ contentType, size, updatedAt }`); writes are atomic (write `<file>.tmp-<random>` then `rename`); `publicPath(key)` = `publicPrefix + key` with each segment `encodeURIComponent`-ed.
  - `assertSafeKey(key: string): void` — throws `InvalidKeyError` unless every `/`-separated segment matches `^[a-z0-9][a-z0-9._-]{0,127}$` and no segment is `.`/`..`; max 4 segments; total ≤ 300 chars.
  - `safeFileName(original: string): string` and `randomFileKey(prefix: string, original: string): string` → `${prefix}/${16 hex}-${safeFileName(original)}`.
  - `sniff(bytes: Buffer): "application/pdf" | "image/png" | "image/jpeg" | null`
  - `class InvalidKeyError extends Error`

- [ ] **Step 1: Create the package** (`package.json` like `@gcpe/nrms-contract`'s: name `@gcpe/storage`, `"exports": { ".": "./src/index.ts" }`, no dependencies) and run `npx -y npm@11 install`.

- [ ] **Step 2: Write the failing tests** — `packages/storage/src/storage.test.ts`:

```ts
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeKey, InvalidKeyError, localStore, randomFileKey, safeFileName, sniff } from "./index";

const PDF = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);

describe("names", () => {
  it("sanitises file names and generates random keys", () => {
    expect(safeFileName("Budget 2027 — Backgrounder (FR).PDF")).toBe("budget-2027-backgrounder-fr-.pdf");
    expect(safeFileName("../../etc/passwd")).toBe("etc-passwd");
    expect(safeFileName('a"b\r\n.pdf')).toBe("a-b-.pdf");
    expect(safeFileName("")).toBe("file");
    expect(safeFileName("x".repeat(300)).length).toBeLessThanOrEqual(100);
    expect(randomFileKey("releases/abc/translations", "Doc.pdf")).toMatch(/^releases\/abc\/translations\/[0-9a-f]{16}-doc\.pdf$/);
  });
  it("rejects unsafe keys", () => {
    for (const bad of ["../x", "a/../b", "/abs", "A/b", "a//b", "a/b/c/d/e", ".hidden", "a/.."]) expect(() => assertSafeKey(bad), bad).toThrow(InvalidKeyError);
    expect(() => assertSafeKey("releases/abc/translations/0123456789abcdef-doc.pdf")).not.toThrow();
  });
});

describe("sniff", () => {
  it("recognises PDF, PNG and JPEG by magic bytes only", () => {
    expect(sniff(PDF)).toBe("application/pdf");
    expect(sniff(PNG)).toBe("image/png");
    expect(sniff(JPEG)).toBe("image/jpeg");
    expect(sniff(Buffer.from("<html><script>"))).toBeNull();
    expect(sniff(Buffer.from("MZ\x90\x00"))).toBeNull();
    expect(sniff(Buffer.alloc(0))).toBeNull();
  });
});

describe("localStore", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gcpe-store-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("puts, gets, lists, deletes, with metadata and public paths", async () => {
    const s = localStore(root);
    const key = "releases/r1/translations/0123456789abcdef-doc.pdf";
    const meta = await s.put(key, PDF, "application/pdf");
    expect(meta).toMatchObject({ key, contentType: "application/pdf", size: PDF.length });
    expect((await readFile(join(root, key))).equals(PDF)).toBe(true);
    expect((await s.get(key))!.bytes.equals(PDF)).toBe(true);
    expect((await s.list("releases/r1")).map((o) => o.key)).toEqual([key]);
    expect(s.publicPath(key)).toBe(`/files/${key}`);
    expect(await s.delete(key)).toBe(true);
    expect(await s.get(key)).toBeNull();
    expect(await s.delete(key)).toBe(false);
    await expect(stat(join(root, ".meta", `${key}.json`))).rejects.toThrow();
  });
  it("refuses unsafe keys at every entry point", async () => {
    const s = localStore(root);
    await expect(s.put("../escape", PDF, "application/pdf")).rejects.toThrow(InvalidKeyError);
    await expect(s.get("../escape")).rejects.toThrow(InvalidKeyError);
    await expect(s.delete("a/../b")).rejects.toThrow(InvalidKeyError);
  });
});
```

- [ ] **Step 3: Run to verify they fail**, then **Step 4: implement** `names.ts`, `sniff.ts`, `local.ts`, `index.ts` per the Interfaces (Node `fs/promises`, `crypto.randomBytes`). `safeFileName`: lowercase → replace any char outside `[a-z0-9._-]` with `-` → collapse runs of `-` → strip leading/trailing `.`/`-` → truncate to 100 keeping the extension (last `.` + up to 10 chars) → `file` if empty. `list(prefix)` walks the folder under `prefix` (skipping `.meta`), returns objects sorted by key. Missing metadata → contentType `application/octet-stream`.

- [ ] **Step 5: Run to verify they pass** (`packages/storage`) and tsc, then **Step 6: commit** `feat(storage): local object store with safe keys, atomic writes and magic-byte sniffing`.

---
### Task 3: Release files, page images and public file serving

**Files:**
- Modify: `apps/nrms/src/db/schema.ts` (+ generated migration `release_files`), `apps/nrms/src/start.ts` (`STORAGE_DIR`), `apps/nrms/src/app.ts`, `apps/nrms/src/releases/store.ts` (view), `apps/nrms/src/releases/record.ts`, `packages/nrms-contract/src/types.ts`, `apps/stack/src/stack.ts` (serve `/files`)
- Create: `apps/nrms/src/media/files.ts`, `apps/nrms/src/media/page-images.ts`, `apps/nrms/src/http/media-routes.ts`, `apps/nrms/src/media/files.test.ts`, `apps/nrms/src/http/media-routes.test.ts`

**Interfaces:**
- Table `release_files`: `id uuid pk`, `release_id uuid fk → news_releases on delete cascade`, `kind text check in ('translation','asset')`, `storage_key text not null unique`, `label text not null` (original file name, ≤ 200 chars, for display), `content_type text not null`, `size integer not null`, `created_at timestamptz default now()`, index `(release_id, kind)`.
- Contract: `interface ReleaseFileView { id: string; kind: "translation" | "asset"; label: string; url: string; contentType: string; size: number }`; `ReleaseView` gains `files: ReleaseFileView[]` (ordered by `created_at`). Update `@gcpe/nrms-contract/testing`'s `view()` default to `files: []`.
- `media/files.ts`: `addReleaseFile(db, store, id, { version, kind, fileName, bytes }, actor): Promise<ReleaseView>`; `removeReleaseFile(db, store, id, fileId, version, actor): Promise<ReleaseView>` — both via `mutateRelease` (so they bump the version and count as corrections on a live release). Rules: translations PDF only, assets PDF/PNG/JPEG (by `sniff`), else `ReleaseRuleError(["This file isn't a PDF."])` / `(["Upload a PDF, PNG or JPEG file."])`; empty file → `ReleaseRuleError(["The file is empty."])`; advisories may not have translations or assets (`typeRules(type).categoriesBeyondMinistries`, same rule as spec §4). Storage key `randomFileKey(\`releases/${id}/${kind}s\`, fileName)`; bytes are written **before** the DB transaction and deleted again if the transaction fails. `has_translations` / `has_media_assets` follow whether any file of that kind remains. Log lines `"Added translation <label>"`, `"Removed translation <label>"`, `"Added media file <label>"`, `"Removed media file <label>"`. Deleting a release (hard delete) removes its stored files afterwards (best effort, logged on failure).
- `media/page-images.ts`: `addPageImage(db, { name, bytes, altEn, altFr, sortOrder })` (PNG/JPEG only, ≤ 2 MiB, unique name → `ReleaseStateError("A page image with that name already exists.")`), `updatePageImage(db, id, { altEn?, altFr?, sortOrder?, isActive? })`, `pageImageBytes(db, id): Promise<{ bytes: Buffer; mimeType: string } | null>`.
- Routes (`media-routes.ts`, mounted inside `apiRoutes` before the generic routes; bodies via `express.raw({ type: () => true, limit })` on these routes only — the app's global `express.json` must not consume them, so mount them on the `/api` router **before** `express.json` is applied, or skip JSON parsing for these paths; choose and document):
  - `POST /releases/:id/files?kind=translation|asset&version=N&name=<file name>` (raw body; edit) → 201 view
  - `POST /releases/:id/files/:fileId/remove` (`{ version }`; edit) → view
  - `POST /page-images?name=&altEn=&altFr=&sortOrder=` (raw body; `NRMS.SiteEditor` or `NRMS.Editor`) → 201 `{ id, name }`
  - `PUT /page-images/:id` (`{ altEn?, altFr?, sortOrder?, isActive? }`; same roles) → 200
  - `GET /page-images/:id/image` (read) → bytes with stored MIME type, `cache-control: private, max-age=300`
- `record.ts`: `translations` and `assets` in the record become `[{ key: <absolute URL>, label, length: size }]` built from `view.files` (absolute URL = `PUBLIC_FILES_BASE` + `url`; `PUBLIC_FILES_BASE` env on NRMS, default `""`; stack default derived from the site's public origin, e.g. `https://boxs.ca`), or `null` when there are none.
- Stack: `app.use("/files", express.static(join(nrmsStorageDir), { index: false, dotfiles: "deny", fallthrough: false, maxAge: 60_000 }))` mounted **before** the no-store default, so uploaded files are publicly downloadable at `/files/<key>` (`.meta` is excluded by `dotfiles: "deny"`). Note in a code comment that translations become public when uploaded (as legacy did — its upload box only appeared once a release was committed or published), and that keys are unguessable random names.

- [ ] **Step 1: Write the failing tests** — `files.test.ts` (service-level, real DB + temp-folder `localStore`):

```ts
// 1. a PDF translation is stored, listed in view.files with url "/files/releases/<id>/translations/<16hex>-<name>", has_translations true, version bumped, log "Added translation Budget FR.pdf"
// 2. a PNG passed as a translation → ReleaseRuleError(["This file isn't a PDF."]) and nothing is written to the store (list is empty)
// 3. an HTML file passed as an asset → ReleaseRuleError(["Upload a PDF, PNG or JPEG file."])
// 4. an empty body → ReleaseRuleError(["The file is empty."])
// 5. removing the only translation → has_translations false, file deleted from the store, log "Removed translation …"
// 6. an advisory refuses files of either kind
// 7. on a published (live) release, adding a file moves it to "publishing" (correction)
// 8. a stale version → VersionConflictError and the stored bytes are deleted again
// 9. toReleaseRecord lists translations as [{ key: "https://example.test/files/…", label, length }] when PUBLIC_FILES_BASE is "https://example.test"
```

`media-routes.test.ts` (supertest, session cookies as in `routes.test.ts`): upload a PDF translation → 201; a viewer uploading → 403; file name `../../etc/passwd.pdf` → stored key ends with `-etc-passwd.pdf` and contains no `..`; a 26 MiB body → 413; page image upload as a site editor → 201, as a viewer → 403; `GET /page-images/:id/image` returns the bytes with `content-type: image/png`; duplicate page image name → 409.

Write each comment line as its own `it` with the stated expectations.

- [ ] **Step 2: Run to verify they fail.** **Step 3: Implement** (schema + `npx … drizzle-kit generate --name release_files`; services; routes; record; view; stack mount; `STORAGE_DIR` env — default `fileURLToPath(new URL("../../../data/storage", import.meta.url))` for standalone dev; the stack overrides it from Task 1). **Step 4: Run** `apps/nrms apps/stack packages/nrms-contract` + tsc + full suite. **Step 5: Commit** `feat(nrms): release translations and media files, page images, and public /files serving`.

---

### Task 4: Flickr client and the fake Flickr

**Files:**
- Create: `apps/nrms/src/media/flickr-client.ts`, `apps/nrms/src/media/flickr-client.test.ts`, `packages/flickr-fake/package.json`, `packages/flickr-fake/src/index.ts`, `packages/flickr-fake/src/fake.test.ts`

**Interfaces:**
- `flickr-client.ts`:

```ts
export interface FlickrConfig {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
  restUrl: string;
  oembedUrl: string;
  fetchImpl?: typeof fetch;
  /** Test hooks. */
  nonce?: () => string;
  timestamp?: () => number;
}
export type PhotoVisibility = "public" | "private";
export class FlickrError extends Error {
  constructor(readonly kind: "auth" | "not-found" | "unavailable" | "unexpected", message: string) { super(message); }
}
export interface FlickrClient {
  getVisibility(photoId: string): Promise<PhotoVisibility>;   // flickr.photos.getInfo
  makePublic(photoId: string): Promise<void>;                  // flickr.photos.setPerms is_public=1 is_friend=0 is_family=0 (POST)
  confirmPublic(photoId: string): Promise<boolean>;            // flickr.photos.getPerms
  staticImageUrl(pageUrl: string): Promise<string>;            // public oEmbed → "url" field; https only
}
export function flickrClient(cfg: FlickrConfig): FlickrClient;
export function oauthSignature(method: string, url: string, params: Record<string, string>, consumerSecret: string, tokenSecret: string): string;
export function percentEncode(s: string): string;
export function decodeBase58(s: string): string;              // Flickr's alphabet; returns the decimal id as a string
export function photoIdFromUrl(url: string): string | null;   // flickr.com/photos/<user>/<id>[/…], flic.kr/p/<base58>, *.staticflickr.com/<server>/<id>_<secret>[_x].jpg
export function isFlickrUrl(url: string): boolean;
```

  Error mapping: Flickr JSON `{ stat: "fail", code: 1 }` → `not-found`; codes 96, 97, 98, 99, 100 → `auth`; HTTP ≥ 500, network errors, timeouts (5 s via `AbortSignal.timeout`) → `unavailable`; anything else → `unexpected`. Every REST call sends `format=json`, `nojsoncallback=1`, `api_key`, and the OAuth 1.0a params (`oauth_consumer_key`, `oauth_nonce`, `oauth_signature_method=HMAC-SHA1`, `oauth_timestamp`, `oauth_token`, `oauth_version=1.0`, `oauth_signature`) as query/form parameters; reads use GET, `setPerms` uses POST with an `application/x-www-form-urlencoded` body. The signature base string includes every request parameter (query + form + oauth_*, excluding `oauth_signature`), sorted by encoded key then value.

  Reference implementation of the signature (RFC 5849 §3.4):

```ts
import { createHmac } from "node:crypto";

export function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function oauthSignature(method: string, url: string, params: Record<string, string>, consumerSecret: string, tokenSecret: string): string {
  const pairs = Object.entries(params)
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const base = [method.toUpperCase(), percentEncode(url), percentEncode(pairs.map(([k, v]) => `${k}=${v}`).join("&"))].join("&");
  return createHmac("sha1", `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`).update(base).digest("base64");
}

const B58 = "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
export function decodeBase58(s: string): string {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error("invalid base58");
    n = n * 58n + BigInt(i);
  }
  return n.toString();
}
```

- `@gcpe/flickr-fake` (`packages/flickr-fake`, depends on `express`):

```ts
export interface FakePhoto { id: string; secret: string; server: string; isPublic: boolean }
export interface FakeFlickrOptions {
  apiKey: string; apiSecret: string; accessToken: string; accessSecret: string;
  /** Absolute public base the oEmbed "url" points at, e.g. https://boxs.ca/fake-flickr */
  publicBaseUrl: string;
  photos?: FakePhoto[];   // default: 5 private (ids 53000000001–53000000005) and 2 public (53000000011–53000000012), user "bcgovphotos"
}
export interface FakeFlickrState { refuseAuth: boolean; outageCalls: number; deleted: string[] }
export function createFakeFlickr(opts: FakeFlickrOptions): { router: express.Router; photos: Map<string, FakePhoto>; state: FakeFlickrState };
```

  Router endpoints (all relative to its mount point):
  - `GET|POST /services/rest` — verifies `api_key` and the OAuth signature (recomputed with the fake's secrets over the received params, using the **external** URL the client signed: reconstruct it as `publicBaseUrl + "/services/rest"` for requests arriving through the stack, and also accept the request's own `protocol://host/originalUrl-path` form — accept if either matches); bad key/signature or `state.refuseAuth` → `{ stat: "fail", code: 98, message: "Invalid auth token" }`; `state.outageCalls > 0` → decrement and respond 503; deleted or unknown photo → `{ stat: "fail", code: 1, message: "Photo not found" }`. Methods: `flickr.photos.getInfo` → `{ stat: "ok", photo: { id, secret, server, visibility: { ispublic: 0|1, isfriend: 0, isfamily: 0 } } }`; `flickr.photos.getPerms` → `{ stat: "ok", perms: { id, ispublic: 0|1, isfriend: 0, isfamily: 0 } }`; `flickr.photos.setPerms` (POST only) → sets `isPublic` from `is_public`, `{ stat: "ok" }`.
  - `GET /services/oembed?url=&format=json` — public photo → `{ type: "photo", version: "1.0", url: "<publicBaseUrl>/static/<id>_<secret>_b.jpg", width: 1024, height: 768, title: "Fake photo <id>", author_name: "bcgovphotos" }`; private, deleted or unknown → 404.
  - `GET /static/:file` (`<id>_<secret>_b.jpg`) — public photo → a small valid JPEG (embed a fixed tiny JPEG as a base64 constant); else 404.
  - `GET /photos/:user/:id/` — an HTML page naming the photo.
  - `GET /services/oauth/request_token`, `GET /services/oauth/authorize`, `GET /services/oauth/access_token` — signature-checked like REST (consumer secret only for request_token); return `oauth_callback_confirmed=true&oauth_token=<t>&oauth_token_secret=<s>`, an HTML page showing verifier `123-456-789`, and `fullname=Fake%20Flickr&oauth_token=<accessToken>&oauth_token_secret=<accessSecret>&user_nsid=12345%40N00&username=bcgovphotos`.
  - `POST /__fake/state` (JSON body `Partial<FakeFlickrState>`) → merges and returns the state; `POST /__fake/photos` (JSON `FakePhoto`) adds/replaces a photo. These two exist for tests and the boxs.ca walkthrough only.

- [ ] **Step 1: Write the failing tests**

`flickr-client.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeBase58, oauthSignature, percentEncode, photoIdFromUrl } from "./flickr-client";

describe("OAuth 1.0a signature", () => {
  it("matches the RFC 5849 §1.2 example", () => {
    const sig = oauthSignature("GET", "http://photos.example.net/photos", {
      file: "vacation.jpg", size: "original", oauth_consumer_key: "dpf43f3p2l4k3l03", oauth_token: "nnch734d00sl2jdk",
      oauth_signature_method: "HMAC-SHA1", oauth_timestamp: "1191242096", oauth_nonce: "kllo9940pd9333jh", oauth_version: "1.0",
    }, "kd94hf93k423kf44", "pfkkdhi9sl3r4s00");
    expect(sig).toBe("tR3+Ty81lMeYAr/Fid0kMTYa/WM=");
  });
  it("percent-encodes per RFC 3986", () => {
    expect(percentEncode("a b!*'()~")).toBe("a%20b%21%2A%27%28%29~");
  });
});

describe("photo ids", () => {
  it("parses page, short and static URLs", () => {
    expect(photoIdFromUrl("https://www.flickr.com/photos/bcgovphotos/53212345678/")).toBe("53212345678");
    expect(photoIdFromUrl("https://flickr.com/photos/bcgovphotos/53212345678/in/album-721/")).toBe("53212345678");
    expect(photoIdFromUrl("https://live.staticflickr.com/65535/53212345678_abcdef1234_b.jpg")).toBe("53212345678");
    expect(photoIdFromUrl(`https://flic.kr/p/${"21"}`)).toBe("58");
    expect(decodeBase58("a")).toBe("9");
    expect(photoIdFromUrl("https://www.flickr.com/photos/bcgovphotos/")).toBeNull();
    expect(photoIdFromUrl("https://example.com/photos/x/1")).toBeNull();
  });
});
```

Plus a `describe("client against the fake")` block: start `createFakeFlickr` on an ephemeral express server (`app.listen(0)`), point `restUrl`/`oembedUrl` at it **and** set the fake's `publicBaseUrl` to the same base, and assert: a private photo reports `"private"`; `makePublic` then `confirmPublic` → `true`; `staticImageUrl(page)` returns `<base>/static/<id>_<secret>_b.jpg`; with `state.refuseAuth = true` every call rejects with `FlickrError` kind `auth`; `outageCalls = 1` → first call `unavailable`, second succeeds; a deleted photo → `not-found`; a wrong `apiSecret` in the client → `auth`.

`packages/flickr-fake/src/fake.test.ts`: supertest against the router: unsigned REST call → `stat: "fail", code: 98`; oEmbed of a private photo → 404, of a public one → JSON with the static URL; `/static/…` serves `image/jpeg` starting with `FF D8 FF`; `__fake/state` merges.

- [ ] **Step 2: Run to verify they fail.** **Step 3: Implement.** **Step 4: Run** `apps/nrms/src/media packages/flickr-fake` + tsc. **Step 5: Commit** `feat(nrms): Flickr client with OAuth 1.0a signing, and a signature-checking fake Flickr`.

---

### Task 5: Flickr wiring, asset status and asset checks

**Files:**
- Modify: `apps/nrms/src/start.ts`, `apps/nrms/src/app.ts`, `apps/nrms/src/http/routes.ts` (or `media-routes.ts`), `apps/nrms/src/releases/service.ts` (`saveAsset`), `apps/stack/src/env.ts`, `apps/stack/src/stack.ts`, tests alongside each

**Interfaces:**
- NRMS env: the `FLICKR_*` variables in Global Constraints. `flickrConfigFromEnv(parsed): FlickrConfig | null` — null when `FLICKR_API_KEY` is unset (Flickr features then report `unavailable`, and the publisher publishes Flickr releases without the photo plus an alert — same path as an outage).
- Stack: if `FLICKR_API_KEY` is not set for NRMS (neither `NRMS_FLICKR_API_KEY` nor shared), the stack runs the fake: mounts `createFakeFlickr({...}).router` at `/fake-flickr` (before the no-store default is fine; it sets its own headers) with fixed test credentials (`apiKey: "fake-key"`, `apiSecret: "fake-secret-0123456789"`, `accessToken: "fake-token"`, `accessSecret: "fake-token-secret-0123456789"`), `publicBaseUrl` = the site's public origin + `/fake-flickr` (from `SITE_PUBLIC_SITE_URL`'s origin; fall back to `http://localhost:<PORT>`), and gives NRMS's env view those credentials plus `FLICKR_REST_URL=self:/fake-flickr/services/rest`, `FLICKR_OEMBED_URL=self:/fake-flickr/services/oembed`, `FLICKR_OAUTH_URL=self:/fake-flickr/services/oauth`, `FLICKR_MODE=fake`. Signature verification in the fake must accept the in-process URL the client signed (`http://stack.internal/fake-flickr/services/rest`) — Task 4's "either URL" rule covers it; add a stack test proving a signed call through the stack works.
- `GET /api/releases/:id/asset-status` (read) → `{ kind: "none" } | { kind: "youtube" } | { kind: "live" } | { kind: "flickr"; photoId: string; state: "public" | "private" | "missing" | "unavailable"; message: string }` with messages: public → "Public on Flickr."; private → "Private — will be made public when the release publishes."; missing → "This photo no longer exists on Flickr."; unavailable → "Flickr can't be reached right now."
- `saveAsset`: a Flickr host URL whose photo id can't be parsed → `ReleaseRuleError(["That Flickr link doesn't point to a photo."])`. (No network call during save — the status endpoint does that.)

- [ ] **Steps:** failing tests (env defaults for fake mode; stack test: create a release with `assetUrl` = a private fake photo page URL, `GET …/asset-status` → private with that message; after `POST /fake-flickr/__fake/state { deleted: [id] }` → missing; `saveAsset` with `https://www.flickr.com/photos/bcgovphotos/` → 422) → implement → run `apps/nrms apps/stack` + full suite → commit `feat(nrms): Flickr configuration, fake Flickr in the stack, and asset status`.

---
### Task 6: Make the photo public at go-live — jobs, deferral, alerts, recovery

**Files:**
- Modify: `apps/nrms/src/db/schema.ts` (+ generated migration `flickr_jobs`), `apps/nrms/src/publisher.ts`, `apps/nrms/src/publisher.test.ts`, `apps/nrms/src/start.ts`, `apps/nrms/src/releases/store.ts`, `packages/nrms-contract/src/types.ts` (+ `testing.ts`), `apps/nrms/src/releases/queries.ts` (list item), `apps/stack/src/stack.ts` (tick order)
- Create: `apps/nrms/src/media/flickr-jobs.ts`, `apps/nrms/src/media/flickr-jobs.test.ts`

**Interfaces:**
- Column `news_releases.flickr_alert text null`. Table `flickr_jobs`: `release_id uuid pk fk → news_releases on delete cascade`, `photo_id text not null`, `status text check in ('pending','done','gave_up') default 'pending'`, `attempts int default 0`, `first_attempt_at timestamptz null`, `next_attempt_at timestamptz not null default now()`, `last_error text null`, `static_url text null`, `alerted_at timestamptz null`, `updated_at timestamptz default now()`.
- Contract: `ReleaseView.flickrAlert: string | null`; `ReleaseListItem.flickrAlert: string | null`.
- `flickr-jobs.ts`:
  - `class DeferPublish extends Error` (exported; thrown by `prepareMedia`).
  - `GRACE_MS = 120_000`, `RETRY_MS_IN_GRACE = 30_000`, `RETRY_MS = 300_000`, `GIVE_UP_MS = 86_400_000`.
  - `flickrPrepareMedia(opts: { now?: TestClock }): (tx, view) => Promise<{ assetUrl: string | null }>` — for a non-Flickr asset returns `view.assetUrl`. For a Flickr asset (`isFlickrUrl`) with photo id P:
    - job `done` for P → `{ assetUrl: job.static_url }` and clears `flickr_alert` on the release if set;
    - no job, or job for a different photo → upsert a fresh `pending` job for P (attempts 0, `next_attempt_at = now`) and `throw new DeferPublish("waiting for Flickr")`;
    - job `pending` and (`first_attempt_at` null or `now - first_attempt_at < GRACE_MS`) → `throw new DeferPublish(...)`;
    - otherwise (`pending` past grace, or `gave_up`) → set `news_releases.flickr_alert` = `"The Flickr photo couldn't be made public (<last_error>). The release went out without it; NRMS keeps trying for 24 hours."` (or for `gave_up`: `"The Flickr photo couldn't be made public after 24 hours (<last_error>). The release is live without it — re-add or replace the photo."`) and return `{ assetUrl: null }`.
    All "now" comparisons use the DB clock (`sqlNow`).
  - `processFlickrJobs(opts: { db, flickr: FlickrClient | null, alert: (subject: string, text: string) => Promise<void>, now?: TestClock, limit?: number }): Promise<{ done: string[]; retried: string[]; gaveUp: string[]; alerted: string[]; republished: string[] }>`:
    1. Claim up to `limit` (default 10) jobs with `status = 'pending' AND next_attempt_at <= now` using `FOR UPDATE SKIP LOCKED`, in a short transaction that only bumps `next_attempt_at = now + 60s` (a lease) and returns them; the network work happens **outside** any transaction.
    2. For each: if `flickr` is null → failure "Flickr isn't configured". Else `getVisibility` → if private, `makePublic`; then `confirmPublic` must return true (else failure "Flickr still reports the photo as private"); then `staticImageUrl(<photo page URL from the release's asset_url>)`. Success → `status = 'done'`, `static_url`, `last_error = null`. A `FlickrError` of kind `not-found` → `gave_up` immediately with `last_error = "photo not found"`. Other failures → `attempts + 1`, `first_attempt_at = coalesce(first_attempt_at, now)`, `last_error = <message ≤ 300 chars, no secrets>`, `next_attempt_at = now + (within grace ? RETRY_MS_IN_GRACE : RETRY_MS)`; if `now - first_attempt_at ≥ GIVE_UP_MS` → `gave_up`.
    3. Alerts: for every release with `flickr_alert` set whose job has `alerted_at` null (or whose job became `gave_up` after the last alert), call `alert(subject, text)` (subject `Flickr photo not public: <headline>`; text includes the release headline, key, status, the alert message and the asset URL) and set `alerted_at = now`. Alert failures are logged, not thrown.
    4. Recovery: for jobs `done` whose release has `flickr_alert` set and is `live` with status `published` → in one transaction set the release to `publishing` (a correction), `version + 1`, clear nothing yet (the publisher's `prepareMedia` clears the alert when it uses the photo), and log (`system`) `"Flickr photo is now public — republishing with the photo"`.
  - Wire-up: `start.ts` builds the Flickr client (Task 5) and an `alert` that sends through the existing `distribution` client to `FLICKR_ALERT_EMAILS` (priority `system`), logging `[nrms] flickr alert: <subject>` when no recipients/distribution are configured. `workers.flickr = () => processFlickrJobs(...)`; `startLoops` runs it every 30 s; the publisher gets `prepareMedia: flickrPrepareMedia({})`.
- Publisher: a `DeferPublish` thrown from `prepareMedia` rolls back that release's transaction and is **not** a failure: the release stays as it was (`scheduled`/`publishing`), is added to the run's `tried` list, and appears in a new `deferred: string[]` field of `PublishResult` (update existing tests' expected results to include `deferred: []`).
- Stack tick order: `nrms.flickr` runs immediately before `nrms.publish`.

**Behaviour tests** (`flickr-jobs.test.ts`, real DB + the fake Flickr on an ephemeral server, `now` test clocks seeded from `dbClock`):
1. Due release with a private fake photo: first `publishDue` → `deferred: [key]`; `processFlickrJobs` → `done`; the fake photo is now public; next `publishDue` → `published: [key]` and the event's `assetUrl` is the fake's static URL; no alert.
2. `refuseAuth = true`: publish defers; `processFlickrJobs` retries (status pending, `last_error` mentions auth); with the clock moved 2 min 1 s past `first_attempt_at`, `publishDue` publishes with `assetUrl: null`, the release has a `flickrAlert`; `processFlickrJobs` sends exactly one alert (captured by a fake `alert`), a second run sends none.
3. Recovery: then `refuseAuth = false`, clock + 5 min → `processFlickrJobs` marks `done` and moves the release to `publishing`; `publishDue` → `updated: [key]` with the static URL, `flickrAlert` cleared.
4. Deleted photo → `gave_up` immediately; the release (past grace) goes out without the photo with the gave-up alert text.
5. 24 h: with the clock at `first_attempt_at + 24 h`, a still-failing job becomes `gave_up` and a second alert is sent.
6. A YouTube asset publishes immediately with its URL (no job created).
7. Changing a published release's Flickr photo (correction) creates a fresh job for the new photo and defers the correction until done.

- [ ] **Steps:** failing tests → schema + `drizzle-kit generate --name flickr_jobs` → implement → run `apps/nrms apps/stack tests` + full suite + tsc → commit `feat(nrms): make Flickr photos public (verified) before go-live, with retries, alerts and recovery`.

---

### Task 7: Body embeds — `<asset>` normalisation on save

**Files:**
- Create: `apps/nrms/src/media/embeds.ts`, `apps/nrms/src/media/embeds.test.ts`
- Modify: `apps/nrms/src/releases/service.ts` (create, `saveDocumentLanguage`), `apps/nrms/src/start.ts`/`app.ts` (pass an `embeds` dependency), tests

**Interfaces:**
- `normalizeEmbeds(html: string, deps: { flickr: FlickrClient | null; soundcloudOembed: (url: string) => Promise<string | null>; maxEmbeds?: number }): Promise<string>` — for each `<asset>…</asset>` in order (at most `maxEmbeds`, default 10; extras become plain links without network calls):
  - decode HTML entities in the content and trim; parse as a URL; non-`http(s)` or unparsable → the whole tag is removed;
  - YouTube (`youtube.com/watch?v=<id>`, `youtu.be/<id>`, `youtube.com/shorts/<id>`) → `<asset>https://www.youtube.com/watch?v=<id></asset>` (`<id>` must match `^[A-Za-z0-9_-]{6,20}$`, else plain link);
  - `*.staticflickr.com` → kept, upgraded to `https`;
  - Flickr page or `flic.kr` → `flickr.staticImageUrl(url)` → `<asset>{static url}</asset>`; any failure (private photo, not found, unavailable, Flickr not configured) → plain link;
  - `soundcloud.com/...` → `soundcloudOembed(url)` returns the canonical URL → `<asset>{url}</asset>`; null/failure → plain link;
  - any other `http(s)` URL → plain link.
  - "Plain link" = `<a href="{escaped url}">{escaped url}</a>`. Each network call has a 5 s timeout (the clients already enforce it). The result is passed through `sanitizeBodyHtml` again.
- `defaultSoundcloudOembed(fetchImpl)`: `GET https://soundcloud.com/oembed?format=json&url=<encoded>` → the response's `url`-ish canonical field if present else the input URL when HTTP 200; else null.
- The service runs `normalizeEmbeds` **before** opening the transaction (no network while holding a row lock) and only when the body contains `<asset`. The service functions take the embeds deps via a new optional parameter (`deps?: EmbedDeps`); routes pass the app's deps; tests may omit them (no normalisation when absent).

**Tests** (`embeds.test.ts`, with a fake `FlickrClient` and a stub `soundcloudOembed`):

```ts
// youtu.be/abcdef12345 → <asset>https://www.youtube.com/watch?v=abcdef12345</asset>
// http://live.staticflickr.com/1/2_x_b.jpg → <asset>https://live.staticflickr.com/1/2_x_b.jpg</asset>
// a public Flickr page → <asset>{static url from the client}</asset>; a private one → <a href="…">…</a>
// soundcloud success → <asset>{canonical}</asset>; failure → plain link
// https://example.com/x → <a href="https://example.com/x">https://example.com/x</a>
// <asset>javascript:alert(1)</asset> → removed; <asset>not a url</asset> → removed
// <asset>https://youtu.be/abc&amp;x=1</asset> entity-decoded before parsing (id "abc" too short → plain link)
// 12 assets → first 10 resolved, last 2 plain links, and the Flickr stub was called at most 10 times
// a body without <asset> is returned unchanged and makes no calls
```

Plus a service test: saving a document whose body has `<asset>https://youtu.be/abcdef12345</asset>` stores the normalised tag.

- [ ] **Steps:** failing tests → implement → run `apps/nrms` + full suite + tsc → commit `feat(nrms): normalise body media embeds on save (YouTube, Flickr, SoundCloud) and degrade others to links`.

---

### Task 8: `flickr:authorize`, documentation and the parity lists

**Files:**
- Create: `apps/nrms/src/cli/flickr-authorize.ts`, `apps/nrms/src/media/flickr-authorize-flow.ts`, `apps/nrms/src/media/flickr-authorize-flow.test.ts`, `scripts/siteground-flickr-walkthrough.sh`
- Modify: `apps/nrms/package.json` (script `flickr:authorize`), root `package.json` (`nrms:flickr-authorize`), `docs/deploy/siteground.md`, `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`

**Interfaces:**
- `authorizeFlow(deps: { oauthUrl: string; apiKey: string; apiSecret: string; fetchImpl?: typeof fetch; prompt: (q: string) => Promise<string>; print: (line: string) => void; nonce?: () => string; timestamp?: () => number }): Promise<{ accessToken: string; accessSecret: string; username: string }>` — signed `GET {oauthUrl}/request_token?oauth_callback=oob` (consumer secret only) → prints `Open this address, approve access, and copy the code it shows:` and `{oauthUrl}/authorize?oauth_token=<t>&perms=write` → `prompt("Verification code: ")` → signed `GET {oauthUrl}/access_token?oauth_verifier=<code>` with the request token/secret → returns the parsed result. Non-200 or missing fields → throws with the HTTP status (never the response body if it could echo secrets).
- CLI: reads `FLICKR_API_KEY`, `FLICKR_API_SECRET`, `FLICKR_OAUTH_URL` (default `https://www.flickr.com/services/oauth`) from the environment; prompts with readline; on success prints:

```
Signed in to Flickr as <username>. Add these to the environment (Site Tools > Environment Variables):
NRMS_FLICKR_ACCESS_TOKEN=<token>
NRMS_FLICKR_ACCESS_SECRET=<secret>
```

  (These are secrets printed to the operator's own terminal on purpose — this is how they're handed over; the CLI writes them nowhere else.)
- `scripts/siteground-flickr-walkthrough.sh BASE`: signs in as the break-glass admin (same pattern and secrecy rules as `siteground-seed-users.sh` — passwords only via stdin/builtins, cookie jar private and deleted), creates a release with `assetUrl` = a fake private photo, `https://www.flickr.com/photos/bcgovphotos/53000000001/` (a real Flickr-shaped URL works in fake mode: NRMS parses the photo id from it and sends that id to the fake's REST and oEmbed endpoints). The script: create → approve → schedule now, then polls `GET /nrms/api/releases/:id` and `…/asset-status` once per tick (cron, up to 5 min) printing status, alert and asset state, then prints the public page URL. A second mode `--outage` first sets `POST /fake-flickr/__fake/state {"refuseAuth":true}`, waits until the release has published without the photo with an alert, then clears it and waits for the correction. Exits non-zero if the expected end state isn't reached.
- Docs: "Flickr" section in `siteground.md`: fake mode is automatic when no `FLICKR_API_KEY` is set; how to run the walkthrough; for real Flickr at cutover: create the API key under the bcgovphotos account (needs a Pro account — free accounts can't create keys, found 2026-10-03), run `npm run nrms:flickr-authorize` locally with the key/secret in the environment, paste the four values (+ `NRMS_FLICKR_ALERT_EMAILS`) into Site Tools; what the alert email means.
- Parity: add C-rows for: persistent data directory and self-healing public site (fixes a Phase 2 deploy defect; not a legacy behaviour change — put it under a new "Operations" heading); page images served as uploaded (already C31 — confirm, don't duplicate); uploads checked by content (C32 — confirm); embed normalisation uses HTTPS (C34 — confirm); Flickr publish deferral up to 2 minutes before publishing without the photo (C28 — confirm wording matches what was built). Update Q4's working assumption text if the built behaviour differs.

**Tests** (`flickr-authorize-flow.test.ts`): run the flow against the fake router on an ephemeral server with a scripted `prompt` returning `123-456-789` → returns the fake's access token/secret/username; a wrong consumer secret → throws mentioning HTTP status; `print` output contains the authorize URL with `perms=write`. Plus `bash -n scripts/siteground-flickr-walkthrough.sh` and a static check (like `tests/siteground-seed-users.test.ts`) that it never puts `$ADMIN_PASS` in a command's arguments.

- [ ] **Steps:** failing tests → implement → full suite + tsc + `bash -n` → commit `feat(nrms): flickr:authorize sign-in tool, boxs.ca Flickr walkthrough, and docs`.
