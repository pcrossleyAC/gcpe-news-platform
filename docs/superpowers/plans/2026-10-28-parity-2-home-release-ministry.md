# news.gov.bc.ca Parity, Plan 2: Home, Release and Ministry Pages (with Minister Bios and Media Contacts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the home, release and ministry pages look like news.gov.bc.ca and carry its content, and add the minister biography page (spec §4 B). Ship the Hub screens that feed those pages: the minister bio editor and the Premier's team links (T1), and ministry media contacts as free text (T2) (spec §5 step 2).

**Architecture:**
- **Core:** the organization profile PATCH now accepts:
  - a sanitised biography (`minister.detailsHtml`);
  - `teamLinks`;
  - the two media contacts;
  - the after-hours number.

  `teamLinks` is a new optional field on `OrgRecord`.
- **News API:** stores `teamLinks` and serves the extra ministry data on a new `GET /api/v2/ministries`. The v1 responses stay byte-compatible with the recorded legacy responses.
- **Public site:**
  - The renderers emit legacy `HomeView`, `PostCard`, `PostView`, `Ministry` and `Biography` skeletons, with the plan-1 accessibility deviations.
  - Two new `PageOptions` slots, `lead` and `trail`, hold the full-width bands legacy renders outside `#main-content`: the carousel and the related-articles band.
  - The biography page is a third file of the ministry category page. Every existing rebuild trigger therefore covers it.

**Tech Stack:** TypeScript, Express 5, zod, drizzle (Core/News API migrations via `drizzle-kit generate`), `sanitize-html` (new Core dependency), vitest + supertest + jsdom, React + TipTap (`apps/staff-web/src/editor`), and the Playwright parity harness in `tools/parity`.

**Spec:** `docs/superpowers/specs/2026-10-28-news-gov-parity-design.md` (binding; §4 B home/release/ministry, §4 D T1 and T2, P8, P9). Evidence: `docs/parity/inputs/look-and-feel.md` §2.1, §2.2, §2.4 and §5; `gap-audit.md` (M2–M7, M15, H2, L3, L6); `admin-editability.md` §3 T1 and T2. Conventions come from `docs/superpowers/plans/2026-10-28-parity-1-foundation.md`. Legacy source (Apache-2.0): `/Users/paul/News-Hub/gcpe-news-webapp/Gov.News.WebApp` at `3fdf3e6` (`WA/` below), views `Views/Default/HomeView.cshtml`, `Views/Shared/{PostView,PostCard,HomeCarousel,ConnectSocialMedia,ResourceLinks,Ministry,Minister,MinisterOfState,Biography,MoreFromThis,CommContact}.cshtml`, `Components/TopSectors`, and `Helpers/{AssetHelper,FormattingExtensions}.cs`.

**Prerequisite:** Plan 1 is merged into `feat/parity`, including the `RENDER_CHROME_VERSION = 7` state and ruling R10.

## Global Constraints

- **Chrome version rule (R10): one bump per deploy.** A task that changes HTML baked into pages (body or head) checks the deployed version first:

  ```bash
  git fetch origin deploy/siteground && git show origin/deploy/siteground:stack.js | grep -o 'RENDER_CHROME_VERSION=[0-9]*'
  ```

  - If that equals `RENDER_CHROME_VERSION` in `apps/public-site/src/rebuild.ts`, bump it by 1 and add a line to its doc comment.
  - Otherwise leave it, and write "RENDER_CHROME_VERSION stays N (R10)" in the commit message.
  - Today HEAD is 7 and the deployed value is 5, because plan 1 is not yet deployed.

  Tests read the constant and never hard-code a number.
- **Deploy batches.** Each batch must leave boxs.ca working. Deploy with `npm run deploy:siteground` and then push `deploy/siteground` (`docs/deploy/siteground.md`), and check the site live after each one.

  | Batch | Tasks | Page HTML |
  |---|---|---|
  | A | 1–4 | unchanged |
  | B | 5–6 | home |
  | C | 7–8 | release, plus the head of every page |
  | D | 9–10 | biography and ministry |
- **News API v1 stays exact.** `apps/news-api/test/compat.test.ts` compares v1 responses with recorded live responses, and `apps/news-api/src/dto.test.ts` pins their key order. Do not add fields to `toMinistryDto`, `toMinisterDto` or `toPostDto`; new data goes through `/api/v2`. Both tests pass unchanged at the end of every task.
- **Old records stay valid.** `OrgRecord.teamLinks` is `.optional()`, so stored envelopes and Core rows written before it still parse. Readers treat an absent value as `[]`. The public site treats every new DTO field as optional, and an older News API answering 404 on `/api/v2/ministries` gives `[]`.
- **P8 as resolved here:** a media contact is free text: `fullName`, `phoneNumber`, `mobileNumber` and `emailAddress`, in the stored `contactSchema` shape. There is no title field (see "Spec conflicts" at the end). The after-hours number is Core's existing `weekendContactNumber`.
- **P9:** no new role. Bio, team links and contacts go through the existing profile PATCH, which `Core.Admin` or `NRMS.SiteEditor` may call. None of them is in `ADMIN_ONLY_PROFILE_FIELDS`.
- **P6 and look-and-feel §5:**
  - One `<h1>` per page.
  - Legacy `h3`/`h4` side-column and section headings are emitted one level up (`h2`/`h3`), so heading order holds. `overrides.css` copies the legacy metrics onto the new selectors, as plan 1 did for `#footer h2`.
  - Every control is a `<button>` or a link with an `href`, and no legacy `<a>` without an `href` survives.
  - No duplicate ids.
  - Images have `alt`.
  - Side columns are `<section class="… " aria-label="…">`, not `<aside>`: `<aside>` inside `<main>` fails axe best-practice `landmark-complementary-is-top-level`, and `site:quality` runs best-practice.
  - The `lead` and `trail` bands are `<section aria-label>` landmarks.
- **Escaping:**
  - Every value from the News API or settings goes through `e()`, `safeHref()`, `safeSrc()` or `settingsHref()`.
  - Body and bio HTML goes through `sanitizeBodyHtml`, after `renderBodyAssets` (Task 5).
  - Share URLs are built with `encodeURIComponent` and then `e()`.
  - `site.js` uses `textContent` and `classList` only.
- **C209 stands:** no `<iframe>` and no third-party script.
  - **[call]** No third-party request at page load except an image the content names, a Flickr static photo (Flickr is where BC publishes its photos).
  - A YouTube lead or embed renders as a link with the vendored placeholder image. This replaces legacy's proxied thumbnail and consent player.
- **Vendored files** are byte-identical to `WA/wwwroot/…`. Each is added to `assets/legacy/NOTICE.md` with its sha256, and the count in `site-assets.test.ts` ("the vendored tree on disk holds exactly …") is updated.
- **Copy:** visible text is legacy's verbatim, with these exceptions:
  - the `visually-hidden` additions named in each task;
  - "Search News" links, which point at our `/search/`.

  Headings that legacy hardcodes stay hardcoded ("Share", "Backgrounders", "Media Assets", "Translations", "Related Articles", "Meet the Team", "Read Bio", "Contact", "Connect With Us", "News by Sector", "Load More News", "Read More"). Plan 4's T5 and T9 make them editable. The side-column labels that `settings.ministryPages` already holds keep coming from settings.
- Tests sit beside the source. At the end of every task these pass: `npm run check`, `npx vitest run --project node`, `--project staff-web` (Task 4) and `npm run site:quality` (Tasks 6–10).

## Review Focus

1. **Data written before this plan.** Cases: a Core row or News API `ministry` JSON with no `teamLinks`; a News API older than the public site answering 404 on `/api/v2/ministries`; posts without `hasMediaAssets`/`assetUrl`. Expected: the page renders without those blocks, with no "undefined" and no thrown turn. Pinned in Task 3 (client 404 → `[]`), Task 5 (`postCard` with absent flags) and Task 10 (ministry page with `profile: null`).
2. **A pasted biography carrying `<script>`, `<iframe>`, `onclick=`, `<h1>`, `<img>` or `<asset>`.** Expected: Core stores only the bio allow-list, and the bio page has exactly one `<h1>`. Pinned in Task 2 (`sanitizeBioHtml`) and Task 9 (bio page structure).
3. **A biography cleared in the Hub.** The editor is emptied and its HTML is `<p></p>`. Expected: the PATCH sends `detailsHtml: null`, "Read Bio" disappears, and the stale `ministries/<key>/biography/index.html` is deleted on the next render instead of lingering. Pinned in Task 4 (patch) and Task 9 (builder removes the file).
4. **A release with unusual documents.** Cases: French only; French listed before English; a backgrounder with no headline; zero documents; a document with `detailsHtml: null`. Expected: the page renders, the headline falls back to the key, and there is no empty "Backgrounders" heading and no French toggle without French. Pinned in Task 7.
5. **Share and Open Graph values with `&`, `"`, `<`, `é` or `简体`, on a base path (`/site`).** Expected:
   - share hrefs are percent-encoded and then escaped;
   - `og:url` and `og:image` are absolute and keep the base path;
   - no raw `<` or `"` appears inside any attribute.

   Pinned in Task 8.

---

### Task 1: Harness — plan-2 pages, `--ours` overrides, structure check

**Files:**
- Modify: `tools/parity/pages.ts`, `tools/parity/capture.ts`
- Create: `tools/parity/structure.ts`, `tools/parity/structure.test.ts`

**Interfaces — Produces:**
- `PARITY_PAGES` gains:
  - `{ name: "biography", path: "/ministries/citizens-services/biography", oursPath: "/ministries/citizens-services/biography/" }`
  - `{ name: "premier", path: "/office-of-the-premier", oursPath: "/ministries/office-of-the-premier/" }`
- `capture.ts --ours name=path[,name=path]` overrides `oursPath` for a run (for example `release=/releases/<boxs key>/`), because boxs.ca holds different posts.
- `STRUCTURE: Record<string, string[]>` holds selectors queried on the whole document:
  - `home`: `.home-features`, `.home-body`, `.top-article .article h2 a`, `.regular-articles .article .item-date`, `.news-control`, `.resource-links`, `#carousel-holder .home-banner`
  - `release`: `.story-page`, `.story-features .resource-links.share`, `.story-features .location-and-date`, `.story-body .story-copy`, `.backgrounder`, `#assets`, `.media-container .related-articles`
  - `ministry` and `premier`: `.ministry-listing`, `.home-features .resource-links.minister`, `.home-body .article`, `.collapsible-regions .resource-links`
  - `biography`: `.ministry-listing`, `.biography-details`, `.minister-bio-picture img`, `.news-control .read-more`
- `structureReport(legacy: Record<string, boolean>, ours: Record<string, boolean>): { selector: string; status: "ok" | "missing" | "legacy-absent" }[]`:
  - `missing` means legacy has the selector and ours lacks it;
  - `legacy-absent` is reported only, because the content differs.

  `capture.ts` prints one `structure` row per page. Any `missing` makes the run exit 1. `main` stays report-only, as in plan 1.

- [ ] **Step 1: Write failing tests** (`structure.test.ts`):

```ts
it("ok when both have the selector; missing when only legacy has it; legacy-absent when legacy lacks it")
it("every PARITY_PAGES name with a STRUCTURE entry exists, and every selector parses (document.querySelector in jsdom does not throw)")
it("parseOursOverrides('release=/releases/A/,home=/x/') maps names to paths; an unknown page name throws")
```

- [ ] **Step 2:** Run `npx vitest run tools/parity`. Expected: FAIL.
- [ ] **Step 3:** Implement. In `capture.ts`, after `networkidle`, evaluate `sel => !!document.querySelector(sel)` for each selector on both pages.
- [ ] **Step 4:** Run `npx vitest run tools/parity`. Expected: PASS. Then run `npm run parity -- --target https://boxs.ca --pages home,ministry,biography,premier`. Expected: it completes. Structure rows show `missing` (the pages aren't ported yet), so the exit code is 1. Keep the output as the baseline.
- [ ] **Step 5: Commit** with `git commit -m "feat(parity): plan-2 pages, --ours path overrides and a legacy-structure check"`.

---

### Task 2: Core — sanitised biography, team links, media contacts (T1 and T2 data)

**Files:**
- Modify: `packages/events/src/catalogue.ts` (`orgRecordSchema.teamLinks: z.array(linkSchema).optional()`).
- Modify: `packages/nrms-contract/src/html.ts`, adding `BIO_TAGS`.
- Modify: `apps/core/package.json`: dependencies `sanitize-html` (same version as `apps/nrms`), `@gcpe/nrms-contract`; devDependency `@types/sanitize-html`.
- Modify: `apps/core/src/db/schema.ts`: `teamLinks: jsonb("team_links").$type<Link[]>().notNull().default([])`, and `toOrgRecord` returns `teamLinks`.
- Create: `apps/core/migrations/0006_org_team_links.sql`, generated by `npm --workspace @gcpe/core run db:generate`, then renamed. It holds `ALTER TABLE "organizations" ADD COLUMN "team_links" jsonb DEFAULT '[]'::jsonb NOT NULL;`.
- Create: `apps/core/src/services/bio-html.ts`, `bio-html.test.ts`.
- Modify: `apps/core/src/services/organizations.ts` (`orgProfilePatchSchema`, `sameContent`) and `organizations.test.ts`; `apps/core/src/http/routes.test.ts` (a SiteEditor PATCH case).

**Interfaces — Produces:**
- `BIO_TAGS = ["a", "p", "ul", "ol", "li", "strong", "br", "div"] as const`, which is `BODY_TAGS` without `asset`.
- `sanitizeBioHtml(html: string): string`:
  - `sanitize-html` with `BIO_TAGS`, `a[href]`, schemes `http`/`https`/`mailto`, no protocol-relative URLs, and `b`→`strong`;
  - `nonTextTags` `script`, `style`, `textarea`, `option`, `noscript`, `iframe`, `object`, `embed`;
  - empty `<p>`s are removed, as `apps/nrms/src/text/sanitize.ts` does;
  - the result is trimmed.
- `MAX_BIO_CHARS = 20_000`, measured after sanitising.
- `orgProfilePatchSchema` changes:
  - `minister.detailsHtml: z.string().max(100_000).nullable()`, transformed to `sanitizeBioHtml`. A result with no text (`/^\s*$/` once tags are stripped) becomes `null`. A sanitised result over `MAX_BIO_CHARS` is refused on `minister.detailsHtml` with "Keep the biography to 20,000 characters or fewer."
  - `teamLinks: sideLinksSchema` (max 20, the same text and URL rules and messages).
  - `contact` and `secondContact: mediaContactSchema.nullable()`. `mediaContactSchema` is a strict `{ fullName, phoneNumber, mobileNumber, emailAddress }`:
    - each field is `trimmedOrNull`;
    - each phone is at most 50 characters, with the message "Keep phone numbers to 50 characters or fewer.";
    - the email must be valid, with the message "Enter an email address like name@gov.bc.ca.";
    - an object whose four fields are all null becomes `null`.
  - `weekendContactNumber: trimmedOrNull`, at most 50 characters, with the same message.
- `patchOrganizationProfile` merges `contact`/`secondContact` whole (not field by field) and `teamLinks` whole.
- `sameContent` compares with `teamLinks ?? []` on both sides.

- [ ] **Step 1: Write failing tests**

```ts
// bio-html.test.ts
it("keeps p, strong, ul/ol/li, a[href], br, div; b becomes strong")
it("drops script/iframe/object content, on* attributes, img, h1 (text kept), <asset> and javascript: hrefs")
it("removes empty paragraphs and trims")
// organizations.test.ts
it("PATCH minister.detailsHtml stores the sanitised HTML and emits one org.upserted")
it("PATCH detailsHtml '<p></p>' or '<p> </p>' stores null")
it("a sanitised biography over 20,000 characters is refused on minister.detailsHtml")
it("PATCH teamLinks replaces the list; an unsafe url is refused on teamLinks[0].url")
it("PATCH contact sets all four fields; a contact of four blanks stores null; a bad email is refused on contact.emailAddress")
it("PATCH weekendContactNumber trims and stores; '' stores null")
it("an importer upsert that omits teamLinks on a row whose team_links is [] is not a change (no event)")
it("a record and an envelope without teamLinks still parse (orgRecordSchema)")
// routes.test.ts
it("NRMS.SiteEditor may PATCH detailsHtml, teamLinks and both contacts; Core.Admin-only fields stay refused for it")
```

- [ ] **Step 2:** Run `npx vitest run apps/core packages/events packages/nrms-contract`. Expected: FAIL.
- [ ] **Step 3:** Implement. Generate the migration. Fix every place that builds an `OrgInput` or row in the type-checker's error list (the importer `import/map.ts`, seeds, test factories) by leaving `teamLinks` out (it's optional). Only the DB default applies.
- [ ] **Step 4:** Run the same command, plus `npx vitest run apps/news-api/test/compat.test.ts` and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(core): minister biography (sanitised HTML), Meet the Team links and free-text media contacts on the profile PATCH"`.

---

### Task 3: News API — store team links; `GET /api/v2/ministries`; public-site client

**Files:**
- Modify: `apps/news-api/src/db/schema.ts` (`MinistryDetails` adds `"teamLinks"`; it is jsonb, so no migration), `apps/news-api/src/projections.ts` (`applyOrg` stores `teamLinks: org.teamLinks ?? []`), `apps/news-api/src/read.ts` and `apps/news-api/src/http/v2/routes.ts`.
- Create: `apps/news-api/src/http/v2/ministries.test.ts`.
- Modify (public site): `apps/public-site/src/dto.ts`, `news-api-client.ts`, `news-api-client.test.ts`, `test/fake-news-api.ts` and `builder.ts` (`RunCache.profiles`).

**Interfaces — Produces:**
- `MinistryProfileDto = { key: string; ministerEmail: string | null; teamLinks: { text: string; url: string }[]; childKeys: string[] }`, exported from both `apps/news-api/src/read.ts` and `apps/public-site/src/dto.ts`.
- `listMinistryProfiles(db: Db): Promise<MinistryProfileDto[]>` works over `allMinistries(db)` (public only):
  - `ministerEmail` is `ministry.minister.email`;
  - `teamLinks` is `ministry.teamLinks ?? []`;
  - `childKeys` are the active public ministries whose `parentKey` matches the key case-insensitively, in `sortOrder` then key order.
- `GET /api/v2/ministries` → `200 { ministries: MinistryProfileDto[] }`. It is public and `no-store`, mounted inside the existing `if (db)` block.
- `NewsApiClient.ministryProfiles(): Promise<MinistryProfileDto[]>` fetches `api/v2/ministries`. A 404 gives `[]`; any other failure rejects.
- `RunCache.profiles?: Promise<MinistryProfileDto[]>`, with the helper `profiles(run)` in `builder.ts`. Tasks 9 and 10 use it.

- [ ] **Step 1: Write failing tests**

```ts
// ministries.test.ts (news-api, test DB, events applied through the receiver)
it("lists public ministries with ministerEmail, teamLinks and childKeys; a non-public ministry is absent")
it("a ministry stored before teamLinks existed answers teamLinks: []")
it("childKeys holds only active public children, ordered by sortOrder")
it("is no-store")
// news-api-client.test.ts
it("ministryProfiles reads { ministries }; a 404 is []; a 500 rejects")
```

- [ ] **Step 2:** Run `npx vitest run apps/news-api/src/http/v2/ministries.test.ts apps/public-site/src/news-api-client.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same, plus `npx vitest run apps/news-api` (compat and dto tests unchanged) and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(news-api): GET /api/v2/ministries with minister email, Meet the Team links and child ministries"`.

---

### Task 4: Hub — biography editor, Meet the Team links, media contacts on the Organizations form

**Files:**
- Modify: `apps/staff-web/src/editor/BodyEditor.tsx` (prop `allowAssets?: boolean`, default `true`; `false` hides "Insert asset") and `BodyEditor.test.tsx`.
- Modify: `apps/staff-web/src/screens/admin/organizations/OrganizationEditForm.tsx` and `OrganizationEditForm.test.tsx`.

**Interfaces — Consumes:** Task 2's PATCH fields and error paths. **Produces** (form, in this order after "Minister photo URL"):
- **"Minister biography".** `<BodyEditor id={id("mbio")} label="Minister biography" allowAssets={false} …>`, with the hint "Shown on the minister's biography page, linked as Read Bio from the ministry page. Leave it empty for no biography page."
  - `bioToPatch(html: string): string | null` treats editor HTML with no text as `null`.
  - The patch sends `minister.detailsHtml` only when `bioToPatch(current)` differs from the stored value.
  - The "Remove the previous minister's biography" checkbox goes. When the minister name changed and the bio didn't, a note reads "The biography still describes the previous minister."
- **"Meet the Team links".** A `<LinkListEditor legend="Meet the Team links" pathPrefix="teamLinks" reorderable withSummary={false}>`, with the description "Shown as Meet the Team on the ministry page (the Office of the Premier uses it for Cabinet Ministers, Deputy Ministers and Cabinet Committees)." The list is sent whole when it changed, minus blank rows.
- **"Media contacts".** A `<fieldset>` holding:
  - "Primary contact" and "Alternate contact" sub-fieldsets, each with Name, Phone ("Direct"), Cell and Email inputs (`type="tel"` for both phones, `type="email"` for the email);
  - "After-hours phone".

  A changed contact is sent whole: `contact: { fullName, phoneNumber, mobileNumber, emailAddress }`, with blanks as `""`, which the server turns into `null`. When only Alternate is filled, a note reads "The public page shows the alternate only with a primary contact."
- `INLINE_FIELD` also matches `minister.detailsHtml`, `(contact|secondContact)\.\w+`, `weekendContactNumber` and `teamLinks\[\d+\]\.\w+`.
- The component doc comment no longer says contacts are untouched.

- [ ] **Step 1: Write failing tests**

```ts
// BodyEditor.test.tsx
it("allowAssets={false} shows no Insert asset button; default still does")
// OrganizationEditForm.test.tsx
it("opens with the stored biography in the editor and saves an edit as minister.detailsHtml")
it("emptying the biography sends minister.detailsHtml: null")
it("an untouched biography is not sent")
it("adds a Meet the Team link and sends teamLinks whole; a server teamLinks[0].url error shows beside that row")
it("edits the primary contact and sends contact with all four fields; an emailAddress error shows beside Primary email")
it("sends weekendContactNumber when the after-hours phone changes")
it("a SiteEditor (not Core.Admin) sees and can save biography, team links and contacts")
it("renaming the minister without touching the biography shows the previous-minister note")
```

- [ ] **Step 2:** Run `npx vitest run --project staff-web apps/staff-web/src/editor apps/staff-web/src/screens/admin/organizations`. Expected: FAIL.
- [ ] **Step 3:** Implement. Reuse `fieldErrorsOf`, `LinkListEditor` and the existing `sendable` pattern for the team links.
- [ ] **Step 4:** Run the same, plus `npx vitest run --project staff-web` (including `a11y.test.tsx`) and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(staff-web): minister biography editor, Meet the Team links and media contacts on the Organizations form"`.
- [ ] **Step 6: Deploy batch A, then verify on boxs.ca:**
  1. In the Hub, open Citizens' Services. Paste the biography text from `https://news.gov.bc.ca/ministries/citizens-services/biography`, and copy the two contacts and the after-hours number from `https://news.gov.bc.ca/ministries/citizens-services`.
  2. On the Office of the Premier, add the three legacy links from `WA/Views/Shared/MoreFromThis.cshtml`: Cabinet Ministers, Deputy Ministers and Cabinet Committees.
  3. `curl -s https://boxs.ca/api/v2/ministries | jq '.ministries[] | select(.key=="office-of-the-premier")'`. Expected: three `teamLinks`.
  4. `curl -s 'https://boxs.ca/api/Ministries/citizens-services?api-version=1.0' | jq .contactUser`. Expected: the contact entered.
  5. Public pages are unchanged (no render change in this batch).

---

### Task 5: Shared render pieces — PostCard, long date with time, media, body embeds, `lead`/`trail`, vendored images (no page change)

**Files:**
- Create: `apps/public-site/src/pages/post-card.ts`, `post-card.test.ts`, `apps/public-site/src/pages/media.ts`, `media.test.ts`.
- Modify: `apps/public-site/src/pages/format.ts` (`displayDateTime`, `bytesReadable`) and `format.test.ts` (create it if absent); `apps/public-site/src/dto.ts`; `apps/public-site/src/render.ts` (`PageOptions.lead`/`trail`); `render.test.ts`; `apps/public-site/src/sanitize-body.ts` (allowed classes) and `sanitize-body.test.ts`.
- Vendor from `WA/wwwroot/Content/Images/`:
  - `SocialMedia/{facebook-svg-logo,twitter-X-svg-logo,Instagram_logo_2016,threads_logo,bluesky-logo,linkedin-logo-blue,flickr-svg-logo,youtube,rss-logo}.svg`;
  - `Gov/default-og-meta-image-1.jpg` (70,524 B);
  - `Gov/default-og-image-new.jpg` (153,333 B).

  Update `NOTICE.md` and the vendored count test (35 → 46). Add `.jpg` → `image/jpeg` to `scripts/fixture-site.ts` `TYPES`.

**Interfaces — Produces:**
- `PostDocument` adds `pageTitle?: string | null` and `byline?: string | null`. `PostDto` adds `hasMediaAssets?: boolean | null`, `hasTranslations?: boolean | null` and `assetUrl?: string | null`. All are already in v1.
- `SlideDto` adds `justify?: string | null`, which is already in v2.
- `displayDateTime(publishDate: string): string` takes the wall-clock from the BC-local ISO string (no time-zone maths): `"2026-09-22T11:45:00-07:00"` → `"Tuesday, September 22, 2026 11:45 AM"`, and `T00:05` → `"12:05 AM"`. The weekday comes from `Date.UTC(y, m-1, d)`. An unparseable string is returned as is.
- `bytesReadable(n: number): string` follows legacy `ToBytesReadable`:
  - `< 1024` → `"1 KB"`;
  - otherwise `${Math.round(n / 1024).toLocaleString("en-CA")} KB`;
  - legacy shows megabytes as KB too, so `5_000_000` → `"4,883 KB"`.
- `type LeadMedia = { kind: "image"; src: string; href: string } | { kind: "youtube"; id: string; href: string } | { kind: "live"; href: string }`.
- `leadMedia(url: string | null | undefined): LeadMedia | null`:
  - A URL matching `/^https?:\/\/(farm\d+|live)\.staticflickr\.com\/\d+\/(\d+)_[0-9a-f]+(_[a-z])?\.jpg$/` gives `image`. The `src` is upgraded to https, and `href` is `https://www.flickr.com/photos/bcgovphotos/<id>/` (the `AssetHelper` rule).
  - A `youtube.com/watch?v=` or `youtu.be/` URL whose id matches `/^[A-Za-z0-9_-]{6,20}$/` gives `youtube`, with `href` `https://www.youtube.com/watch?v=<id>`.
  - `https://news.gov.bc.ca/live` (trailing slash optional) gives `live`.
  - Anything else gives null.
- `renderMedia(m: LeadMedia, base: string, alt: string): string`:
  - `image` → `<div class="asset flickr"><a href><img src alt></a></div>`;
  - `youtube` → `<div class="asset youtube"><a href><img src="{base}/assets/legacy/Content/Images/Gov/default-og-meta-image-1.jpg" alt=""><span>Watch on YouTube</span><span class="visually-hidden">: {alt}</span></a></div>`;
  - `live` → `<p><a href>Watch the live webcast</a></p>`.
- `renderBodyAssets(html: string, base: string): string` replaces each `<asset>URL</asset>`, with the URL entity-decoded:
  - a `LeadMedia` → `renderMedia(…, alt "")`;
  - an http(s) URL on another host (SoundCloud included) → `<p><a href=URL>URL</a></p>`;
  - an unparseable or unsafe URL → removed.

  It always runs before `sanitizeBodyHtml`. That function now allows `class` on `div` (only `asset`, `flickr`, `youtube`) and on `span` (only `visually-hidden`).
- `postCard(site: Pick<SiteInfo, "baseUrl">, p: PostDto, o: { hidden?: boolean } = {}): string` emits legacy `PostCard.cshtml` with no inline `<style>`:
  - `div.article[.hidden-article]`;
  - `h2 > a[href=post]{headline}`;
  - `div.list-container.ps-0.pb-0` holding `div.item-date{displayDateTime}`, plus, when the flag is true, `div.item-medialink.media-assets > a[href=post#assets]{icon download} Media Assets` and `div.item-medialink.translations > a[href=post#translationList]{icon language} Translations`;
  - `div.item-content`, holding (only for a Flickr `image` lead) `div.item-asset.asset.flickr > a[href=post] > img[src][alt=""]`, then `div.item-text[.with-image] > p{summary} + a.read-more[href=post]{icon caret-right} Read More<span class="visually-hidden">: {headline}</span>`;
  - `div.clear`.

  The headline is the English document's (as today), falling back to the key. A YouTube lead gets no card thumbnail (third-party call).
- `PageOptions.lead?: string` and `PageOptions.trail?: string` are trusted renderer HTML. `renderPage` emits `lead` between the header and `div#main-content`, and `trail` right after `div#main-content`. Absent means nothing is emitted, so every current page is byte-identical.

- [ ] **Step 1: Write failing tests**

```ts
// format.test.ts
it("displayDateTime('2026-09-22T11:45:00-07:00') is 'Tuesday, September 22, 2026 11:45 AM'; T00:05 is 12:05 AM; T12:00 is 12:00 PM")
it("bytesReadable: 500 → '1 KB'; 1536 → '2 KB'; 5_000_000 → '4,883 KB'")
// media.test.ts
it("leadMedia: live.staticflickr.com jpg → image with the bcgovphotos page; youtu.be/x and youtube.com/watch?v=x → youtube; news.gov.bc.ca/live → live; flickr.com page, javascript:, '' → null")
it("renderMedia youtube never references youtube.com in a src; image keeps https src and escapes alt")
it("renderBodyAssets: '<asset>https://www.youtube.com/watch?v=abcdef1&amp;t=2</asset>' → div.asset.youtube; soundcloud → plain link; '<asset>javascript:alert(1)</asset>' → removed")
it("sanitizeBodyHtml keeps div.asset/flickr/youtube and span.visually-hidden classes, drops any other class")
// post-card.test.ts
it("emits div.article > h2 > a, .item-date with time, .item-text p, a.read-more with a visually-hidden headline")
it("media-assets and translations links only when the flags are true; absent flags render neither")
it("a Flickr assetUrl adds .item-asset img alt=''; a YouTube assetUrl adds no image")
it("hidden: true adds .hidden-article")
// render.test.ts
it("lead renders between header#main-nav and #main-content; trail right after #main-content; absent → page unchanged")
// site-assets.test.ts (existing count test updated to 46)
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site/src/pages apps/public-site/src/render.test.ts apps/public-site/src/sanitize-body.test.ts apps/public-site/src/site-assets.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement and vendor the files.
- [ ] **Step 4:** Run the same, plus `npx vitest run apps/public-site tests/fixture-site.test.ts` and `npm run check`. Expected: PASS. No page HTML changes, so there is no chrome bump.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): legacy PostCard, long dates with time, lead media and body embeds without third-party loads, page lead/trail slots"`.

---

### Task 6: Home page — carousel band, PostCards, Load More, Connect With Us, Resources, News by Sector (L6)

**Files:**
- Modify: `apps/public-site/src/pages/home.ts`, `home.test.ts`, `builder.ts` (home case), `change-feed.ts` (`pagesForChange`: a `sector` change also queues `home`), `change-feed.test.ts`, `site-script.ts`, `site-script.test.ts`, `assets/site/overrides.css`, `rebuild.ts` (R10), `scripts/fixture-site.ts` (slides with images, `hasTranslations`, a Flickr `assetUrl` on one post) and `test/fake-news-api.ts`.

**Interfaces — Consumes:** `postCard`, `displayDateTime` and `PageOptions.lead` (Task 5), and `settings.connect`. **Produces:**
- `HomeView` adds `sectors: { key: string; name: string; latest: PostDto | null }[]`. In the builder's home case, these are the active sectors from `newsApi.categories("sectors")`, each with `latest("sectors", key, 1)` fetched in parallel and sorted by name with `localeCompare("en")`.
- `renderCarousel(slides: SlideDto[], base: string): string`. Non-emergency slides, in sort order, inside `<section id="carousel-holder" aria-label="Highlights" aria-roledescription="carousel">`. For each slide:
  - `div.home-banner[.current on the first]`;
  - `img.home-banner-image[src=safeSrc(imageUrl)][alt=""]`, when the slide has an image;
  - `div.home-banner-content > div.stories > div.story.(left|right)`. `right` applies when `justify === "right"`, else `left`. The story holds `h2` (with `a[href=safeHref(actionUri)]{headline}` when there is an action, else the plain text), `p.summary`, and, with an action, `div > a.read-more[href]{icon caret-right} {actionLabel ?? "Learn more"}`;
  - `div.bottom-fade`.

  With two or more slides, there are also `button.story-nav.story-previous[type=button][aria-label="Previous highlight"]` and `.story-next[aria-label="Next highlight"]`. With no slides, the band is empty (`""`). There is no auto-advance (C205).
- `renderHomePage` body:
  1. `<h1 class="visually-hidden">Latest news</h1>`.
  2. `<div class="home-layout">`, containing:
     - `<section class="home-features" aria-label="Connect and resources">`, which holds:
       - `div.resource-links.connect` with `h2 "Connect With Us"`;
       - two `ul`s of `li > a[href={base}/connect/#{network}] > img[src={base}/assets/legacy/Content/Images/SocialMedia/{file}][alt={Network}][width=22][height=22]`, for Facebook, X, Instagram, Threads and Bluesky in the first and Flickr and YouTube in the second;
       - `a.read-more[href={base}/connect/] "View all Social Media"`.

       A network is listed only when `settings.connect[network].accounts` is non-empty. LinkedIn and RSS wait for plan 4's T7 anchors.
     - `div.collapsible-regions`, holding `div.resource-links > h2 "Resources" + ul` (resource links) and `div.resource-links > h2 "News by Sector" > div > (h3 {name} + p > a[href=post]{headline})`, the latter only for sectors with a latest post.
     - `div.home-body#main-content-release`, holding the emergency section (C208, as today but as `div.article` cards), then `div.top-article > postCard(top)`, then `div.other-articles` containing `div.feature-article > postCard(feature)`, `div#regular-articles.regular-articles` with `postCard × latest` (index ≥ 3 is `hidden: true`), and `div.news-control`.

       `div.news-control` holds `button.load-more.link-button[type=button][aria-controls=regular-articles] "Load More News"`, only when a card is hidden, followed by `a.read-more[href={base}/search/] "Search News"` and `div.clear`.
  3. The `lead` is `renderCarousel(...)`.
- `overrides.css`:
  - `.home-layout{display:flex}`;
  - under 768px, `.home-layout{flex-direction:column}` and `.home-layout>.home-features{order:2;width:100%}`, which replaces legacy's JS clone;
  - `.resource-links h2` and `.home-body .article h2` carry legacy's `h3` and `h2` metrics where the level moved;
  - `#carousel-holder .home-banner-image{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}`;
  - `html.js #carousel-holder .home-banner:not(.current){display:none}`. Without JS, every slide shows stacked;
  - `html:not(.js) .hidden-article{display:block}` and `html:not(.js) .load-more{display:none}`.
- `site.js` additions:
  - **Carousel:** Previous and Next move `.current`, wrapping around. The `aria-live="polite"` on the holder is set only after the first click.
  - **Load More:** reveals every `.hidden-article` inside its `aria-controls` target, removes the button and moves focus to the first revealed card's headline link.

- [ ] **Step 1: Write failing tests**

```ts
// home.test.ts (parse with JSDOM)
it("exactly one h1 (visually hidden); .home-layout > section.home-features[aria-label] + .home-body; no <aside> inside main")
it("top-article and feature-article hold one div.article each; regular-articles shows 3 and hides the rest with .hidden-article; Load More only when something is hidden")
it("Connect With Us lists only networks with accounts, each img with alt and the base path; View all Social Media links /connect/")
it("Resources and News by Sector (sector name + latest headline link); a sector with no post is left out")
it("carousel goes in opts.lead: one .current, story.right for justify right, action label default 'Learn more', no buttons for one slide, empty for none; emergency slides are not in it")
it("a slide with a javascript: action renders its headline as text, no link")
// change-feed.test.ts
it("a sector change queues home as well as the sector page")
// site-script.test.ts
it("Next/Previous move .current and wrap; Load More reveals hidden cards, removes itself, focuses the first revealed link")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site/src/pages/home.test.ts apps/public-site/src/change-feed.test.ts apps/public-site/src/site-script.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Apply the R10 check.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS, with axe at 0 violations on `/`.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): news.gov home — carousel band, PostCards with Load More, Connect With Us, Resources and News by Sector"`.
- [ ] **Step 6: Deploy batch B. After the rebuild-all, run** `npm run parity -- --target https://boxs.ca --pages home`. Expected:
  - header, landAck and footer ≤ 0.03 at both widths;
  - the home `structure` row is all `ok`, or `legacy-absent`;
  - axe reports 0 serious/critical;
  - the `main` ratio is recorded in the commit message of any follow-up fix.

  Then do a keyboard pass: Previous/Next, Load More and focus.

---

### Task 7: Release page — story header, side column, documents and backgrounders, French, assets, translations, print (M3, M4, M7 side column, L3)

**Files:**
- Modify: `apps/public-site/src/pages/release.ts`, `release.test.ts`, `builder.ts` (`renderPost` passes `leadMinistry`), `site-script.ts` (print, language toggle) and `site-script.test.ts`; `overrides.css`; `rebuild.ts` (R10); `scripts/fixture-site.ts` (the first post gets 2 backgrounders, a French document, 2 translations, 2 assets with `hasMediaAssets`/`hasTranslations` true and a byline).
- Create: `apps/public-site/src/pages/languages.ts`, `languages.test.ts`.

**Interfaces — Consumes:** `displayDateTime`, `bytesReadable` and `renderBodyAssets` (Task 5); `ministryPages` labels. **Produces:**
- `interface ReleaseContext { ministryNames: Map<string, string>; related: RelatedPost[]; leadMinistry: MinistryDto | null; ministryLatest: PostDto[] }`. `ministryLatest` is filled by Task 8, so `[]` until then.
- `renderReleasePage(post: PostDto, site: SiteInfo, opts: PageOptions, ctx: ReleaseContext): string`.
- `documentsByLanguage(docs: PostDocument[]): { main: PostDocument | null; backgrounders: PostDocument[]; french: PostDocument | null; frenchBackgrounders: PostDocument[] }`:
  - English is `languageId 4105`, or any document not `3084` when no 4105 exists;
  - French is `3084`;
  - `main` is the first English document, else the first French one (in which case `french` is null).
- `translationLanguage(label: string | null): { name: string; lang: string | null }` uses legacy `ToDefaultTranslationLanguage`'s 25 keys (case-insensitive contains; the last match wins, as legacy), each with a BCP 47 tag. Examples: `Chinese(Simplified)`/`Chinese_Simplified` → `简体中文`, `zh-Hans`; `Punjabi` → `ਪੰਜਾਬੀ`, `pa`. With no match it returns `{ name: label ?? "View translation", lang: null }`.
- Body, inside `div.story-page.pt-4`:
  - `button.print-document[type=button]{icon print} Print`.
  - `p.story-ministry > a[href=ministry page]{lead ministry name}`, when the lead ministry is known (the h3-above-h1 of legacy, kept out of the heading outline).
  - `div.print-title{site.name}`.
  - `h1.story-lang.primary{headline}`, then, with French, `p.story-lang.secondary.story-headline[lang=fr]{fr headline}`.
  - `div.print-url{canonical}` and `div.print-date{displayDateTime}`.
  - `p.story-lang.primary.subheadline`, when present (and the French one with `lang=fr`).
  - `div.story-info`, the phone rows: translations (no id), then `div.resource-links` with `h2.story-lang.primary{main.pageTitle}`, `p{location}` and `div{date}`.
  - `<section class="story-features" id="sidebar" aria-label="About this release">`, holding:
    - `div.resource-links.translate#translationList`, with `h2 "Translations"`, `ul > li > a[href][hreflang][lang]{icon language}{name}`;
    - `div.resource-links.location-and-date`, with `h2{pageTitle}`, `p.location{location}`, `div{displayDateTime}` and, when `hasMediaAssets`, `div.media-assets > a.assets-link[href=#assets]{icon download} Media Assets`;
    - `div.resource-links.comm-contacts`, with `h2{labels.mediaContacts}` and `div.comm-contact > h3{title} + details with <br>` for each document contact of `main`;
    - then from `leadMinistry`: More from this Ministry (website, photos, videos; no Factsheets until H5), Featured Topics and Featured Services, using `categories.ts`'s `sideLinks` rules, moved to a shared `pages/side-links.ts`.
  - `div.story-body#main-content-release`, holding:
    - `p.story-lang.primary.byline > b{byline with <br>}`;
    - with French, `div.language-selector.story-lang.primary` ("Cet article est aussi disponible en " `button[type=button][data-story-lang=secondary][lang=fr]` "français") and the mirror `.secondary` ("This article also available in " `button[data-story-lang=primary]` "English");
    - `div.story-copy.story-lang.primary > article{sanitizeBodyHtml(renderBodyAssets(main.detailsHtml))}` and the French copy (`lang=fr`);
    - `div.comm-contacts-body-section`, with the phone copy of the contacts block and no ids;
    - `h2 "Backgrounders"` (with French: `Backgrounders`/`Détails supplémentaires` in matching `.story-lang` spans), only when there is at least one. Each one is `div.backgrounder > div.backgrounder-header > h3{headline ?? "Backgrounder"}` + `div.backgrounder-content` holding `p.subheadline`, `p > b{byline}`, the body, and its contacts only when they differ from `main`'s (legacy rule). French ones carry `.story-lang.secondary[lang=fr]`;
    - `div#assets.assets.expanded`, when `hasMediaAssets` and there are assets: `h2 "Media Assets"` + `div.media-assets-container > ul > li > (div > b{label}) + div > a[href][download] "Download (" bytesReadable ")"`. The licence line waits for plan 4's T4, which owns its URL;
    - `div#translations.assets.expanded`, when there are translations: `h2 "Translations"` + `ul > li > a[href][hreflang][lang]{name}`, with no `target=_blank` (§5 #16).
- `overrides.css`: legacy metrics onto `.story-page h1`, `.story-page .subheadline`, `.story-ministry`, `.story-headline` and `.resource-links h2`; `body.lang-secondary .story-lang.primary{display:none}` and `body.lang-secondary .story-lang.secondary{display:block}`; `html:not(.js) .story-lang.secondary{display:block}` (both languages without JS); `html:not(.js) .language-selector, html:not(.js) .print-document{display:none}`.
- `site.js`:
  - `.print-document` calls `window.print()`;
  - `[data-story-lang]` buttons toggle `body.lang-secondary`, and `document.documentElement.lang` follows (`fr` or `en`).
- Builder: `leadMinistry` is found case-insensitively by `leadMinistryKey ?? ministryKeys[0]` in `ministries(run)`. No extra fetch.
- Remove the old Contacts, Media assets, Translations and Related news sections. Related comes back in Task 8.

- [ ] **Step 1: Write failing tests**

```ts
// languages.test.ts
it("maps Chinese(Simplified) and Chinese_Simplified to 简体中文 zh-Hans; Punjabi to ਪੰਜਾਬੀ pa; unknown keeps the label; null is 'View translation'")
// release.test.ts
it("one h1 (English headline); .story-page > .story-features[aria-label] + .story-body; no <aside>; no duplicate ids")
it("kind label from documents[0].pageTitle and the long date with time in .location-and-date")
it("backgrounders: every English document after the first, in order, each with an h3; none → no Backgrounders heading")
it("French document: secondary headline/copy with lang=fr and both language buttons; no French → no .language-selector")
it("documents French-before-English, French only, zero documents, null detailsHtml: renders, headline falls back to the key")
it("backgrounder contacts shown only when they differ from the main document's")
it("Media Assets list: label, Download (n KB) with download attribute; only when hasMediaAssets")
it("translations show language names with lang/hreflang and no target=_blank; #translationList and #translations each appear once")
it("side column from the lead ministry: More from this Ministry, Featured Topics, Featured Services with settings labels; unknown ministry → none")
it("a body <asset> YouTube link renders as div.asset.youtube; an <iframe> in the body is dropped")
// site-script.test.ts
it("Print calls window.print; the language buttons toggle body.lang-secondary and html[lang]")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site/src/pages/release.test.ts apps/public-site/src/pages/languages.test.ts apps/public-site/src/site-script.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Apply the R10 check.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS.
- [ ] **Step 5:** Check print by hand: open the fixture release with `npx tsx scripts/fixture-site.ts` (or `serve-fixture`) and run Chrome print preview. Expected: legacy print layout (print-title/url/date shown; header, sidebar and footer hidden).
- [ ] **Step 6: Commit** with `git commit -m "feat(public-site): news.gov release page — story header, side column, every document and backgrounder, French toggle, media assets and named translations, print"`.

---

### Task 8: Release page — share, Open Graph/Twitter, lead media, related band with fallback (M5, M6, M7 band, L7)

**Files:**
- Modify: `apps/public-site/src/pages/release.ts`, `release.test.ts`, `render.ts` (social meta on every page), `render.test.ts`, `builder.ts` (`RunCache.ministryLatest`), `builder.test.ts`, `overrides.css` and `rebuild.ts` (R10; batch C bumps at most once across Tasks 7 and 8).

**Interfaces — Consumes:** `leadMedia`/`renderMedia` and `PageOptions.trail` (Task 5); `ReleaseContext` (Task 7). **Produces:**
- `PageOptions.social?: { title?: string | null; description?: string | null; image?: string | null; type?: "website" | "article" }`. `renderPage` always emits, after the description meta:
  - `og:site_name` = `site.name`;
  - `og:url` = canonical;
  - `og:type` = `social.type ?? "website"`;
  - `og:title` = `social.title ?? title`;
  - `og:description` = `social.description ?? opts.description`, omitted when empty;
  - `og:image` = `social.image ?? origin + base + "/assets/legacy/Content/Images/Gov/default-og-image-new.jpg"`;
  - `twitter:card` = `summary_large_image`;
  - `twitter:title`, `twitter:description` and `twitter:image`, the same values.

  `og:image` is absolute, and anything that is not `https:`/`http:` falls back to the default. No `twitter:site`: the handle is tenant identity, and plan 5 T10 owns it.
- Release social values: title is the headline, description is the summary, `type: "article"`. The image is a Flickr lead's `src`, else for YouTube `https://img.youtube.com/vi/{id}/hqdefault.jpg` (fetched by crawlers only, never by readers), else the default.
- `shareLinks(canonical: string, title: string, instagramUrl: string | null, base: string): string` → `div.resource-links.connect.share > h2 "Share" > ul > li > a[href][aria-label]{icon}`:
  - `share-facebook` → `https://www.facebook.com/sharer/sharer.php?u={enc canonical}`, "Share on Facebook";
  - `share-twitter` → `https://twitter.com/intent/tweet?url={enc}`, "Share on X";
  - `share-instagram` → `instagramUrl` (the first account in `settings.connect.instagram.accounts`, as legacy links the profile), "BC Government on Instagram", omitted when null;
  - `share-threads` → `https://threads.net/intent/post?text={enc}`;
  - `share-bluesky` → `https://bsky.app/intent/compose?text={enc}`;
  - email → `mailto:?subject={enc title}&body={enc canonical}`, "Share by email".

  The icons are `facebook`, `square-x-twitter`, `instagram`, `threads`, `bluesky` and `envelope`. The block is placed in the side column after Translations, and once in `.story-info` (`.mobile-toolbar`).
- Lead media: `div.story-copy.primary-asset{renderMedia(leadMedia(post.assetUrl), base, headline)}` as the first child of `.story-body`, when not null. The Flickr image alt is the headline [call] (see the risk in the final report).
- `trail` = `<section class="media-container" aria-label="Related"><div class="story-parts">`, containing:
  - `div.related-articles > h2 "Related Articles" + div.related-article > h3 > a + div.item-date{displayDate}`. Up to 3 come from `ctx.related`; when that is empty, from `ctx.ministryLatest` minus this post;
  - `div.related-image > img[src={base}/assets/legacy/Content/Images/Gov/default-og-meta-image-1.jpg][alt=""]`;
  - `div.connect-with-bc > h2 "Connect with the Ministry"` + `h3 > a[href=flickrUri] "Photos"` + `p "View the Ministry's latest photos on Flickr."` + `h3 > a[href=youtubeUri] "Videos"` + `p "Watch the Ministry's latest videos on YouTube."`, each pair only when its URI is safe, and the whole div only when one exists.

  No `trail` when there is neither related nor a connect block.
- Builder: `RunCache.ministryLatest?: Map<string, Promise<PostDto[]>>`. `renderPost` fetches `newsApi.latest("ministries", leadKey, 4)` through it only when `related` is empty. A rejection is logged with `safeErrorLabel` and gives `[]`, like `related`.

- [ ] **Step 1: Write failing tests**

```ts
// render.test.ts
it("every page has og:site_name/url/type/title and absolute og:image (default image with the base path) and twitter:card summary_large_image")
it("a non-http social.image falls back to the default; empty description omits og:description")
// release.test.ts
it("share hrefs: headline 'Fish & \"Chips\" <é简体>' on base /site → subject percent-encoded, canonical https://news.example/site/releases/K/, no raw < or \" in any attribute")
it("instagram share only when settings.connect.instagram has an account")
it("og:image is the Flickr lead src; YouTube lead → img.youtube.com/vi/ID/hqdefault.jpg in og:image but no youtube host in any src")
it("lead media div.story-copy.primary-asset first in .story-body; live asset → link to the live webcast")
it("trail: v2 related first (max 3); empty related → ministry latest without this post; neither → no Related Articles")
it("Connect with the Ministry only with a safe Flickr or YouTube URI")
// builder.test.ts
it("fetches the ministry's latest once per run and only when related is empty; a failure renders the page without a fallback")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site/src/pages/release.test.ts apps/public-site/src/render.test.ts apps/public-site/src/builder.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): share links, Open Graph and Twitter cards, lead media and the related band with a same-ministry fallback"`.
- [ ] **Step 6: Deploy batch C, then verify:**
  1. In the boxs.ca Hub, publish a release with two backgrounders, a Flickr asset URL, a translation file and a media asset.
  2. Run `npm run parity -- --target https://boxs.ca --pages release --ours release=/releases/<that key>/`. Expected: chrome ≤ 0.03; the release `structure` row is all `ok`; axe reports 0 serious/critical.
  3. Run `curl -s https://boxs.ca/releases/<key>/ | grep -c 'property="og:'`. Expected: at least 6.
  4. Paste the URL into a card validator (for example `https://cards-dev.twitter.com/validator` or the LinkedIn Post Inspector). Expected: a card with the image.

---

### Task 9: Minister card and the biography page `/ministries/<key>/biography/` (H2, M2 card)

**Files:**
- Create: `apps/public-site/src/pages/minister.ts` (card, sidebar and bio page) and `minister.test.ts`.
- Modify:
  - `apps/public-site/src/site-paths.ts`: `pageFiles` for `category`/`ministries` gains `ministries/<key>/biography/index.html` as a third file; add `biographyUrl`.
  - `site-paths.test.ts`.
  - `builder.ts`: `renderCategory` ministries writes or removes the bio page and fetches `profiles(run)`.
  - `builder.test.ts`, `overrides.css`, `rebuild.ts` (R10).
  - `scripts/fixture-site.ts`: Health's minister gets `details` and a photo; add `"/ministries/health/biography/"` to `FIXTURE_PAGES`.

**Interfaces — Consumes:** `MinistryProfileDto` and `profiles(run)` (Task 3). **Produces:**
- `biographyUrl(site: Pick<SiteInfo, "baseUrl">, key: string): string` → `${base}/ministries/${key.toLowerCase()}/biography/`.
- `PREMIER_KEY = "office-of-the-premier"`.
- `bioHtml(details: string | null): string`: `sanitizeBodyHtml(details ?? "")`. When the result has no `p`/`div`/`ul`/`ol` element, each non-empty line is wrapped in `<p>`, as legacy's `AsHtmlParagraphs` did.
- `hasBiography(minister: MinisterDto | null): boolean` is true when `bioHtml(minister.details)` has any text.
- `ministerCard(site, m: MinistryDto, minister: MinisterDto | null, profile: MinistryProfileDto | null, o: { ministryHeading?: boolean } = {}): string`. It is `""` when `minister?.headline` is blank (this also covers legacy's name check for Intergovernmental Relations Secretariat). Otherwise it is `div.resource-links.minister` holding:
  - with `ministryHeading`, `h2 > a[href=ministry page]{m.name}`;
  - `img[src=safeSrc(photo)][alt={headline}]`, when there is a photo;
  - `h2|h3{headline}` (h3 when `ministryHeading`);
  - the summary paragraphs, split on newlines;
  - when `hasBiography`, `a.read-more[href=biographyUrl] "Read Bio"<span class="visually-hidden">: {headline}</span>`;
  - when `profile.ministerEmail` passes `safeHref("mailto:"+email)`, `h3 "Contact"` + `p.minister-email "Email: " a[href=mailto:…]{email}`.

  The legacy large-photo link to www2 is not reproduced (admin-editability "missing (low)").
- `ministrySidebar(site, m, minister, profile, extra: string): string` → `<section class="home-features" aria-label="About {m.name}"><p class="ministry-title" aria-hidden="true">{m.name}</p>{ministerCard}{extra}</section>`.
- `renderBiographyPage(m: MinistryDto, minister: MinisterDto, profile: MinistryProfileDto | null, site: SiteInfo, opts: PageOptions): string`:
  - title: the minister's headline; description: the summary; `social.image`: the photo; canonical: `biographyUrl`;
  - body: `div.ministry-listing > div.home-layout`, containing `ministrySidebar(..., extra = Featured Topics + Featured Services)` and `div.home-body`;
  - `div.home-body` holds `div.biography-details#main-content-release > h1{headline} + div.minister-bio-picture > img[alt={headline}] + bioHtml(details)`, then `div.news-control > a.read-more[href=ministry page]` reading "All News From This Ministry", or "All News From The Premier" for `PREMIER_KEY`.
- Builder: after the ministry page, write the bio file when `hasBiography(minister)`; otherwise call `storage.remove(<bio file>)`. `removeAll` for a vanished ministry also removes it via `pageFiles`.
- `overrides.css`: `.home-features .ministry-title` gets legacy `.home-features h3` metrics; `.biography-details h1` gets legacy `.biography-details h2` metrics; `.minister-bio-picture{text-align:center}` replaces legacy `<center>`.

- [ ] **Step 1: Write failing tests**

```ts
// site-paths.test.ts
it("a ministries category page owns index.html, feed.xml and biography/index.html; a sector page still owns two files")
// minister.test.ts
it("card: photo alt, headline, summary paragraphs, Read Bio only with a biography, Contact email only when the profile has one")
it("blank minister headline → no card")
it("bio page: one h1 (the minister's name), .biography-details, .minister-bio-picture img, Featured Topics/Services in the sidebar, 'All News From This Ministry'")
it("premier bio says 'All News From The Premier'")
it("bio HTML with <h1>, <script>, <iframe>, onclick is reduced: still exactly one h1, no script/iframe/on* in the output")
it("plain-text details with newlines become paragraphs")
// builder.test.ts
it("writes ministries/<key>/biography/index.html when the minister has details; clearing details removes the file on the next render")
it("profile fetch failure: renders the pages without the Contact email (profiles(run) failure is logged, not thrown)")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site/src/site-paths.test.ts apps/public-site/src/pages/minister.test.ts apps/public-site/src/builder.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. `profiles(run)` failures resolve to `[]` with a logged `safeErrorLabel`. Apply the R10 check.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality` (now including `/ministries/health/biography/`). Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): minister card and the biography page at /ministries/<key>/biography/"`.

---

### Task 10: Ministry page — sidebar card, PostCards, Media Contacts, Meet the Team, Premier and ministers of state (M2, M15)

**Files:**
- Modify: `apps/public-site/src/pages/categories.ts` (`renderMinistryPage` only; `renderCategoryPage` and `renderMinistriesPage` wait for plan 4), `categories.test.ts`, `builder.ts` (child ministries), `builder.test.ts`, `overrides.css`, `rebuild.ts` (R10; batch D bumps at most once across Tasks 9 and 10), `scripts/fixture-site.ts` (a premier ministry with team links and one child ministry with a minister) and `tools/parity/pages.ts` if `premier` needs an `--ours` default.

**Interfaces — Consumes:** `ministerCard`, `ministrySidebar`, `biographyUrl` and `PREMIER_KEY` (Task 9); `postCard` (Task 5); `MinistryProfileDto` (Task 3). **Produces:**
- `interface MinistryPageContext { profile: MinistryProfileDto | null; children: { ministry: MinistryDto; minister: MinisterDto | null; profile: MinistryProfileDto | null }[] }`.
- `renderMinistryPage(m, minister, posts, site, opts, ctx: MinistryPageContext): string`:
  - Body starts with `<h1 class="ministry-name-mobile">{m.name}</h1>`. Overrides make it `visually-hidden` at ≥ 768px and visible below, with legacy metrics.
  - Then `div.pt-2.ministry-listing > div.home-layout`, containing `ministrySidebar(site, m, minister, ctx.profile, "")` and `div.home-body#main-content-release`.
  - `div.home-body` holds:
    - `div.top-article > postCard(top)` and `div.feature-article > postCard(feature)`;
    - `div.other-articles > div#regular-articles.regular-articles`, with `postCard × latest` (index ≥ 3 hidden);
    - `div.news-control`, with the Load More button as on home and `a.read-more[href={base}/search/?ministry={enc key}] "Search News"`;
    - `div.collapsible-regions`, in legacy order:
      1. Media Contacts: `div.resource-links > h2{labels.mediaContacts}` + the existing contact rendering (`span.contact-name`, `Direct:`, `Cell:`, mailto, `Alternate:`, `After hours:`);
      2. Meet the Team: `div.resource-links > h2 "Meet the Team" ul`, from `profile.teamLinks` via the `sideLinks` rules;
      3. More from this Ministry, headed "More from the Premier" for `PREMIER_KEY`;
      4. Featured Topics;
      5. Featured Services;
      6. one `ministerCard(site, child.ministry, child.minister, child.profile, { ministryHeading: true })` per child.
  - The archive link stays: `p > a[href={base}/archive/] "Browse the archive by month"` after the news-control.
- Builder: `children` are `profile.childKeys`, each with `newsApi.ministry(k)`, `newsApi.minister(k)` and its profile, skipping a null ministry. A child failure rejects the page render, like the parent's own fetches.

- [ ] **Step 1: Write failing tests**

```ts
// categories.test.ts (ministry page cases rewritten for the new skeleton)
it("one h1.ministry-name-mobile; section.home-features[aria-label] with the minister card; .home-body with PostCards; no <aside>")
it("Media Contacts from contactUser/secondContactUser/weekendContactNumber in .collapsible-regions; none without a primary contact")
it("Meet the Team from profile.teamLinks (unsafe url dropped); absent profile or [] → no Meet the Team")
it("office-of-the-premier: 'More from the Premier'; other ministries use labels.moreFromMinistry")
it("a child ministry renders a minister-of-state card: ministry name linked, minister, Read Bio to the child's biography URL")
it("profile null (older News API): page renders with card (no email), no Meet the Team, no children")
it("Search News links /search/?ministry=<key> with the base path")
// builder.test.ts
it("renders each childKey's ministry and minister; a null child ministry is skipped")
```

- [ ] **Step 2:** Run `npx vitest run apps/public-site/src/pages/categories.test.ts apps/public-site/src/builder.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run apps/public-site tests/fixture-site.test.ts`, `npm run check` and `npm run site:quality`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(public-site): news.gov ministry page — minister card, PostCards, Media Contacts, Meet the Team, ministers of state"`.
- [ ] **Step 6: Deploy batch D, then verify:**
  1. Run `npm run parity -- --target https://boxs.ca --pages ministry,premier,biography`. Expected:
     - chrome ≤ 0.03 at both widths;
     - the structure rows are all `ok` or `legacy-absent`;
     - axe reports 0 serious/critical.
  2. `curl -s -o /dev/null -w '%{http_code}' https://boxs.ca/ministries/citizens-services/biography/` prints `200` (the bio entered in Task 4).
  3. Clear that bio in the Hub. After the next tick, the same URL prints `404`, and the ministry page has no Read Bio.
  4. Restore the bio.

---

### Task 11: Decision records and the plan-2 parity gate

**Files:**
- Modify: `docs/parity/changes-from-legacy.md`. Add rows numbered from the next free C-number after plan 1's, each with Status "Proposed":
  1. YouTube lead media and embeds are links with a placeholder image; no consent player and no thumbnail from youtube.com.
  2. There is no story navigator bar.
  3. The carousel is static, with Previous/Next buttons and no auto-advance (C205 restated for the new markup).
  4. "Load More News" reveals the 20 pre-rendered cards; there is no server paging.
  5. There is no minister large-photo link.
  6. No "Factsheets" entry appears in "More from this Ministry" until H5.
  7. The Connect With Us strip shows LinkedIn and RSS only after plan 4's T7.
  8. There is no `twitter:site` until T10.
  9. A default `og:image` appears on every page.
  10. The media-assets licence line waits for T4.
  11. Untranslated labels keep their text instead of "View translation".
  12. Media contacts have no title field (P8 as resolved).
  13. The release side column has no minister card (legacy shows it only in the story navigator).
  14. Share links match live (Facebook, X, Instagram profile, Threads, Bluesky, email), not the gap audit's LinkedIn.
  15. The lead image alt is the headline until NRMS publishes `assetAltText`.
- Modify: `docs/parity/inputs/admin-editability.md` §1.4 rows: Minister biography → **editable** (`/organizations` form); media contacts and after-hours → **editable**; Premier "Meet the Team" → **editable** (team links). Mark M2, M3, M4, M5, M6, M7, M15, H2, L3 and L6 as addressed in `gap-audit.md`, with this plan's commits.
- Modify: `docs/parity/inputs/url-compat.md` row `/ministries/{key}/biography`. It now reads: "serve `/ministries/{key}/biography/` (plan 2); plan 3 maps `/office-of-the-premier/biography` there", replacing "301 to the ministry page".

- [ ] **Step 1:** Make the edits. Each one cites the commit that introduced the behaviour.
- [ ] **Step 2: Gate.**
  1. Run `npm run parity -- --target https://boxs.ca --pages home,release,ministry,premier,biography --ours release=/releases/<Task 8 key>/`. Expected: every strict region ≤ 0.03 at 1280 and 390, structure rows all `ok`/`legacy-absent`, and axe 0 serious/critical.
  2. Run `npm run site:quality` and `npm run parity:urls -- --base https://boxs.ca`. Expected: PASS.

  Record the per-page `main` ratios under a "Plan 2 result" heading in `look-and-feel.md`. Any strict region over 0.03, or any `missing` structure selector, becomes a named fix task before plan 3 starts. The threshold is not raised without the owner.
- [ ] **Step 3: Commit** with `git commit -m "docs(parity): plan-2 deliberate differences, editability and gap status, parity results"`.

---

## Spec conflicts found and how this plan resolves them

1. **P8 lists a "title" field for media contacts.** Core's stored `contactSchema`, the v1 `contactUser` contract (exact-match compat test) and legacy's `CommContact.cshtml` have no title. Adding one would mean a v1-stripping shim plus a v2 carrier for a value legacy never showed. Resolved: name, phone, cell and email only. The owner can ask for a title later; it would be additive on v2.
2. **admin-editability T1 says to add `teamLinks` "to … the News API DTO".** v1 must match recorded live responses exactly (`compat.test.ts`, `dto.test.ts`). Resolved: `teamLinks`, the minister email and child ministries go on the new `GET /api/v2/ministries`.
3. **gap-audit M7 puts a minister card in the release side column, and M5 lists LinkedIn and print share links.** `PostView.cshtml` renders the minister card only in the story navigator, which look-and-feel recommends dropping. Live `rel1.html` shares to Facebook, X, Instagram, Threads, Bluesky and email, with Print as a separate link. Resolved: follow the source and live (no card; that share set; a Print button).
4. **url-compat says `/ministries/{key}/biography` should 301 to the ministry page**, because it assumed the bio stays inline. Spec H2 builds the page. Resolved: serve it; Task 11 updates url-compat for plan 3.
5. **Plan 1 says `RENDER_CHROME_VERSION` ends at 9; HEAD is 7 under ruling R10.** Resolved: this plan uses the deploy-relative check in Global Constraints instead of fixed numbers.
6. **French releases.** The Phase-6 "English only" decision was never restated in the parity spec, and legacy shows French with a toggle. Resolved [call]: render French, with a no-JS fallback that shows both. This costs one step in Task 7.
