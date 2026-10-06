# NRMS Parity (Phase 3) — Design Addendum

**Status:** design approved section by section in conversation, 2026-10-03; this document awaits written review.
**Parent spec:** `docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md` (§9 NRMS, §10 testing, §11 roadmap). Where this addendum and the parent disagree, this addendum wins for Phase 3; the parent's §9 items it supersedes are listed in §10 below.
**Companion lists (kept current as work proceeds):**
- `docs/parity/changes-from-legacy.md` — every deliberate departure from legacy behaviour (C-numbers below refer to it).
- `docs/parity/open-questions.md` — questions for the business, each with a working assumption (Q-numbers below refer to it).

**Legacy sources:** `gcpe-hub-develop/Hub.Legacy` (News module, `Gcpe.Hub.Database` as the authoritative schema; `db-scripts` is a stale 2018 snapshot), and the public site `bcgov/gcpe-news-webapp` on GitHub. Research notes: the NRMS parity inventory and Flickr/media research (session scratchpad; facts carried into this document).

## 1. Goal and scope

Bring NRMS to parity with the legacy News Release Management module: the release workflow, the staff screens and the Website section, on the platform built in Phases 0–2. Builds on Phase 2's thin NRMS (`apps/nrms`), replacing its single-JSON release record with the full model.

**In scope:** staff sign-in and roles (Core); the full release data model and workflow; a staff web app; the Website section; media and Flickr; the NRMS legacy importer; the tests and acceptance list in §9.

**Out of scope (later phases):** Forecast tab and iCal feed, and anything else needing Corporate Calendar data (Phase 5); sending to media lists and their contact counts (Phase 4); public-site rendering beyond what already exists (Phase 6); Entra sign-in (plugs into §2 when keys exist); per-ministry permissions (legacy has none — decision "A").

## 2. Sign-in, users and roles

- **Core** gains `users` (id, email unique case-insensitive, display name, active, sign-in method `local` | `entra`, password hash for local) and `role_grants` (user id, role). No ministry scope.
- **Roles:**
  - `NRMS.Editor` — create, edit, approve, schedule, publish, unpublish, delete releases; set Top/Feature. Equivalent to legacy "Advanced" or higher.
  - `NRMS.SiteEditor` — the Website section (§6), except Project Blue Bridge.
  - `NRMS.Viewer` — read-only access to NRMS.
  - `Core.Admin` — users and roles; Project Blue Bridge.
- **Seed script** (`npm run core:seed-test-users`) creates three local test users: an editor, a site editor and a viewer. Passwords are typed in hidden prompts, never printed or stored in plain text. The environment `admin` account (Phase 2) stays as break-glass.
- **Session:** the staff app posts credentials to Core (`POST /core/auth/login`). Core sets one cookie for the whole site: `HttpOnly`, `Secure`, `SameSite=Lax`, path `/`, signed with a shared secret (`SESSION_SECRET`, ≥32 bytes), lifetime 1 hour. Any authenticated request in the last 15 minutes of the lifetime renews it, and renewal re-checks that the user is still active and re-reads their roles. Every app's API accepts this cookie, as well as the existing bearer tokens.
- **CSRF:** `SameSite` plus a required custom header (`X-GCPE-Request: 1`) on every state-changing request; requests without it are refused with 403.
- **Login rate limit:** reuse Phase 2's limiter.
- **Actor on every action:** user id and display name are recorded on every change. The publisher and other background jobs act as the actor `system` (C2).
- **Entra later:** Entra sign-in becomes a second way into Core's login and issues the same cookie.
- **Deferred:** user/role events to other apps; per-user ministry assignments (Calendar, Phase 5).

## 3. Releases: data model

NRMS's own database. These tables replace Phase 2's `releases.content` JSON. A migration moves Phase 2 rows across.

- **`releases`:**
  - identity and type: `id` (uuid), `legacy_id` (uuid, nullable, unique), `type` (`release` | `story` | `factsheet` | `update` | `advisory`);
  - keys and numbers: `key` (URL slug, unique per type, case-insensitive), `reference` (`NEWS-00000`, unique when set), `year`, `year_release`, `ministry_release`, `term_id`;
  - links: `lead_ministry_key`, `activity_id` (int, Calendar);
  - state and timing: `status` (§4), `publish_at`, `released_at` (first go-live), `on_hold` (bool, §8);
  - go-live choices: `to_web`, `to_subscribers`, `to_media_lists`;
  - content and media: `asset_url`, `asset_alt_text` (<150 chars), `has_media_assets`, `has_translations`, `redirect_url`, `keywords`, `atom_id`;
  - subscriber counts: `nod_subscribers` (cached at first publish), `media_subscribers` (null until Phase 4);
  - bookkeeping: `version` (int, optimistic concurrency), created/updated timestamps.
- **`release_languages`:** (release, language) → `location`, `summary`, `summary_edited` (bool), `social_media_summary`.
- **`documents`:** release, `sort_index`, `layout` (`formal` | `informal`).
- **`document_languages`:** (document, language) → `page_title` (≤50), `headline` (≤255), `subheadline` (≤100), `organizations` (formal) or `byline` (informal), `body_html`, `page_image_id`.
- **`document_contacts`:** (document, language, sort_index) → `information` (≤250).
- **Languages:** ids 4105 (English) and 3084 (French), the ids the News API contract already uses.
- **Links:** `release_ministries`, `release_sectors`, `release_themes`, `release_tags` (category keys from Core's taxonomy), and `release_media_lists`.
- **`category_features`:** (kind `home` | `ministries` | `sectors` | `themes`, key) → `top_release_id`, `feature_release_id`.
- **`media_lists`:** id, key, display name, sort order, active. These are owned by NRMS, as in legacy, where they live in the Hub DB. They're imported from legacy; sending to them is Phase 4.
- **`page_types`:** (page title, language) → type, sort order, default layout, default page image.
- **`page_images`:** id, name, sort order, MIME type, bytes, active (C12); **`page_image_languages`:** alt text per language.
- **`terms`:** government terms (e.g. "2017-2021") with an explicit `is_current` flag (C11).
- **`release_log`:** release, timestamp, actor id, actor name, text. Uses legacy's wording ("Approved Release", "Scheduled for Release on …", "Released for Publishing", "Republished to …", "Unpublished Release", "Cancelled Release", "Deleted Release").
- **`release_publications`:** a frozen copy of the full release (JSON) each time it's published or corrected, with timestamp and actor (C10).
- **`number_counters`:** (scope, year, ministry) → last value. Row-locked inside the approve transaction (C4).

## 4. Releases: workflow

**Statuses:** `draft` → `approved` → `scheduled` → `publishing` → `published`, plus `unpublishing`, `failed` and `deleted` (C3). The status text shown to staff keeps legacy's wording: Draft, Approved, Planned (draft with a date), Scheduled, Publishing…, Published, Republishing…, Unpublishing…. Advisories use "Sent" and "Unscheduling…".

- **Approve.**
  - Refused if the release is already approved.
  - If exactly one ministry is selected and no lead ministry is set, that ministry becomes the lead.
  - Release, Advisory and Update get a Key `{year}{MINISTRY}{n:0000}-{m:000000}`: the ministry abbreviation, or `ADVIS` when there is none; `n` counts per year and ministry; `m` counts per year across all ministries.
  - Every type gets the next global `NEWS-{n:00000}` reference.
  - `year` is the BC local year (C5).
  - All counters advance inside one transaction holding row locks (C4).
- **Slugs.**
  - Story and Factsheet keys come from the first English headline and stay editable until the release is scheduled.
  - The generator reproduces legacy's tested behaviour: lowercase; strip punctuation; transliterate diacritics (Métis→metis, K'ómoks→komoks, l'absentéisme→labsenteisme); hyphens; at most 100 characters; never blank.
  - Collisions get `-1`, `-2`, ….
- **Publish.**
  - The Publish button only schedules, as in legacy.
  - "Now" rounds `publish_at` to the current minute. A time more than 5 minutes in the past is refused.
  - On first publish, NRMS caches the NoD subscriber count. It gets it from a new count endpoint on NoD: `GET /nod/api/subscribers/count?lists=…`, Phase 3 adds this.
- **Go-live.**
  - The publisher worker runs once a minute (cron tick on SiteGround). It claims due releases with SKIP LOCKED.
  - It runs the "make photo public" job first (§7), then commits status `published` and `released_at` (first time only), writes the frozen copy and the log entries, and puts the outbound events in the outbox.
  - Each follow-up — News API, site rebuild, NoD, and later media lists — is a separately retried delivery (C6).
- **Corrections.** Saving any section of a published release saves it and moves it to `publishing`. The publisher re-sends it as `release.updated`, logs "Republished to …" and writes a new frozen copy.
- **Unpublish.**
  - Moves the release to `unpublishing`. The publisher emits `release.unpublished`, which removes it from the News API, the site and NoD, and logs it.
  - Advisories can't be unpublished (Q8).
  - A release that never went live returns to draft ("Cancelled Release").
- **Delete.**
  - Only allowed when the release isn't scheduled or published.
  - Without a reference, it's deleted for good. Otherwise its status becomes `deleted` and it's hidden from every list.
- **Validation on the server** (C8). One zod schema per type is shared by the API and the form. The rules:
  - non-Advisories need at least one ministry and one sector;
  - Advisories need at least one media list and get no assets, translations, sectors, themes, tags, summary, keywords or release date;
  - Story and Update releases get no media lists;
  - Organizations is required for the Formal layout;
  - headline is required;
  - activity id must be numeric;
  - redirect URL must be absolute http or https;
  - the asset URL must be Flickr, YouTube or `https://news.gov.bc.ca/live`; Facebook is refused (Q9);
  - alt text must be under 150 characters.
- **Before publish:** no empty body in any language (C7), and a publish date must be set.
- **Concurrency:** every save sends the `version` it loaded. A stale save gets HTTP 409 and "Someone else changed this release — reload to see their changes" (C9).
- **Body HTML.** The allow-list is `a[href]`, `p`, `ul`, `ol`, `li`, `strong` (with `b` normalised to `strong`), `br`, `div`, plus the `<asset>` embed tag. Disallowed tags are removed but their text kept, and empty paragraphs are removed. The server applies this on every save (C18).
- **Summary auto-fill.** Until someone edits the summary by hand (`summary_edited`), saving the first English document regenerates it from the body's opening paragraph.
- **Update type:** imported Updates can be edited and published; there's no way to create new ones (Q6).

## 5. Staff web app

- **App and stack:**
  - `apps/staff-web`, a React single-page app using `@bcgov/design-system-react-components` and `@bcgov/design-tokens`;
  - React Router for pages;
  - TipTap for the body editor, limited to the allow-list;
  - built with esbuild into static files.
- **Hosting:** the stack serves those files at `/hub/`, with unknown paths falling back to the app's index. The app calls `/core/api` and `/nrms/api` using the session cookie and CSRF header; it has no server of its own.
- **Dates and times:** stored in UTC and shown in BC time, using legacy's relative wording (Yesterday / Today / Tomorrow / weekday name).
- **Screens, in build order:**
  1. **Sign in.**
  2. **Release lists.** Drafts, Scheduled and Published, with type filters (All / Releases / Stories / Factsheets / Advisories) and paging on every tab (C13). Each row shows:
     - the type colour bar;
     - the lead ministry, resolved the way legacy does;
     - the page title;
     - the headline;
     - `LOCATION – summary`;
     - status and date;
     - Calendar activity id;
     - an "Approved" badge on drafts;
     - the Flickr alert badge (§7).

     Drafts sort into three groups (dated before tomorrow, then undated, then future); Scheduled sorts ascending and Published descending.
  3. **New release.** Type, page title, layout, page image, categories, headline. Per-type rules as in §4.
  4. **Release editor.** One page, with sections:
     - header and errors;
     - Approve, Publish, Unpublish and Delete/Deactivate actions;
     - publish settings;
     - categories, with Top/Feature switches for Home, ministries, sectors and themes;
     - media asset;
     - translations (PDF uploads);
     - page details (slug, redirect, location, summaries, keywords);
     - documents (English/French tabs; add and remove a translation; drag to reorder documents);
     - history (with a "show all" toggle).

     A side bar holds the reference block, "View on site", "View PDF" and "Email me a copy" (PDF + text version, sent to the signed-in user).
  5. **Search.**
     - Headline substring across languages, including drafts (C14).
     - `ABC-123` searches Calendar activity ids.
     - `NEWS-01234`, a 5-digit number, a release key or a `/releases/<key>` path jumps straight to that release.
     - Ministry and sector filters combine with AND.
     - 20 results per page.
  6. **Website section** (§6).
  7. **Users and roles** (Core.Admin).
- **Renditions:**
  - **HTML** is the public page.
  - **Plain text** follows legacy's template rules: ASCII punctuation clean-up; `<asset>` stripped; links as "text (url)"; the "Connect with the Province of B.C." footer (Q14).
  - **PDF** comes from a pure-JavaScript PDF library, laid out to resemble legacy's report (C17).
- **Not built:** listed in C15 and C16.

## 6. Website section

Every change emits the existing `site.content.changed` event (`packages/events/src/catalogue.ts`). It flows through the outbox to the News API and the site rebuild. Every change is logged with its actor (C23).

1. **Carousel.**
   - Slide fields: headline (≤255), summary (≤255), action URL (≤255), Facebook post URL (≤255), image (JPEG or PNG, checked by content, ≤2 MB; C20), text alignment left/right. Slides are drag-ordered.
   - There is one live carousel plus an optional next carousel with a go-live time; the publisher worker switches over at that time.
   - Five past carousels are kept. Each carousel owns its slides (C19).
2. **Emergency banner.** Primary and secondary pinned slides shown ahead of the carousel. Pin and unpin take effect at once and persist across carousel changes (C21).
3. **Live Feed.** An on/off switch plus the two webcast URLs (manifest URL and M3U playlist URL), with defaults from environment settings (Q1). When the switch is off, both URLs are sent as null. The public site shows the Live button only when the M3U URL is set and answers.
4. **Project Blue Bridge (`granville`).**
   - **What it does:** a non-empty value turns on the public site's mourning theme and the banner announcing the death of King Charles III (Q2, answered).
   - **Who can switch it:** Core.Admin only, after typing the confirmation phrase `KING CHARLES III` and acknowledging legacy's IGRS warning (Q15). Every change is logged and emailed to all Core.Admin users.
   - **Test sites:** on any environment where `NODE_ENV` is not `production`, the public site's banner is prefixed "TEST —" and every public page carries `noindex`.
5. **Top and Feature.** Set from the release editor (§5). Taking an occupied slot moves the previous release out of it. A read-only "What's featured where" page lists every slot (C25).
6. **Resource links.** An ordered list of text and URL, each with its own id, and drag to reorder (C22, Q3).
7. **Files.** Upload, list, search and delete general files, served at `/files/<name>`.
   - Storage sits behind one interface (`packages/storage`) with a local-folder driver now (C24). On SiteGround the folder lives outside the deploy directory (`STORAGE_DIR`, verified before use).
   - Uploads are single requests with a size limit (25 MB), and contents are checked against the claimed type (C32).

**Permissions:** NRMS.SiteEditor for 1–3, 6 and 7; Core.Admin for 4; NRMS.Editor for 5.

## 7. Media and Flickr

- **Headline media asset** (`asset_url`):
  - a Flickr photo (`flickr.com/photos/…` or `flic.kr/p/<base58>`);
  - a YouTube video (short links expanded to `youtube.com/watch?v=`);
  - or `https://news.gov.bc.ca/live`.
- **Body embeds:** `<asset>url</asset>` tags are resolved on save through each service's public oEmbed endpoint, over HTTPS. Anything unresolvable becomes a plain link. Renditions strip `<asset>` tags, as legacy does.
- **Uploaded files** (translations: PDF only, Q10; media asset files): stored through `packages/storage`, contents checked, size-limited (C32).
- **Page images:** stored in NRMS and served as uploaded (C31).
- **Flickr flow:**
  1. **On save:** read the photo id; call `flickr.photos.getInfo`. The editor shows whether the photo is public or private, or that it doesn't exist.
  2. **At go-live, before the release reaches the News API:**
     - a "make photo public" job calls `flickr.photos.setPerms` (public);
     - it then calls `flickr.photos.getPerms` and continues only if the photo is now public (C27);
     - it resolves the direct `staticflickr.com` image URL via oEmbed.

     This runs whenever the release actually goes out, even late (C26).
  3. **On failure:**
     - retry with back-off for 2 minutes;
     - then publish without the photo — the public record gets no `assetUrl`, but the release keeps the link;
     - mark the release with a Flickr alert, shown in the lists and the editor;
     - email the configured contacts (`FLICKR_ALERT_EMAILS`);
     - keep retrying in the background (every 5 minutes for 24 hours, then alert again and stop);
     - when the photo is confirmed public, re-publish as a correction (C28).
  4. **Unpublish** never makes the photo private again.
- **Flickr sign-in:**
  - **Assumed, to verify against Flickr's current API docs before building:** Flickr's API still uses OAuth 1.0a.
  - Requests are signed with the stored access token and secret (`FLICKR_API_KEY`, `FLICKR_API_SECRET`, `FLICKR_ACCESS_TOKEN`, `FLICKR_ACCESS_SECRET`).
  - `npm run flickr:authorize` runs the one-time three-step sign-in and prints the token for the environment (C30).
  - No status-page pre-check; no re-sign-in before every call (C29).
- **Fake Flickr** (`packages/flickr-fake`):
  - implements `getInfo`, `getPerms`, `setPerms` and oEmbed, and checks OAuth signatures;
  - holds seeded private and public photos;
  - accepts failure switches: refuse sign-in, photo deleted, outage for N calls.
  - It's used in tests, locally, and on boxs.ca when `FLICKR_MODE=fake`, in which case the stack mounts it at `/fake-flickr`.
  - Real credentials are tested at cutover.
- **Media-list emails** keep leaving the photo out (Q5).

## 8. Legacy importer

- **Command:** `npm run nrms:import`. It follows the Core and News API importers and reads SQL Server through `@gcpe/legacy-import`.
  - Re-runnable: upsert by legacy id.
  - Preserves keys, `NEWS-` references and activity ids.
- **Imports:**
  - **Releases, all of them** (active, inactive, every status), with documents, languages, contacts, category and media-list links, Top/Feature (including `HomeTopReleaseId` and `HomeFeatureReleaseId`), page types, page images (with bytes; the two hidden ones inactive, Q11), media lists and terms (newest current).
  - **Type map** 1→release, 2→story, 3→factsheet, 4→update, 5→advisory, pinned by a test.
  - **Status map:**
    - inactive → `deleted`;
    - committed and published → `published`;
    - committed and not published → `scheduled` with `on_hold = true`;
    - reference set → `approved`;
    - published and not committed → `draft`, with a log note;
    - otherwise → `draft`.
  - **Release log:** legacy `dbo.User` rows become inactive Core users matched by email; entries with no user get the actor `system`.
  - **Counters** seeded from the highest existing values, parsed as numbers.
  - **Website data:** carousel, slides, emergency pins, the Live Feed and `granville` settings, resource links.
  - **`NewsReleaseHistory` rows**, if present, become read-only frozen copies (Q12).
- **Separate step**, once Q13 is answered: `npm run nrms:import-files`, for translations, media assets and general files.
- **Safety:**
  1. The import writes no outbox events and starts no Flickr jobs.
  2. Imported scheduled releases stay on hold. The publisher skips `on_hold` rows. `npm run nrms:release-holds` clears the holds at cutover, after legacy's publisher is off.
  3. `npm run nrms:replay-to-news-api` sends each published release as `release.updated` with `notify: false`. NoD reacts only to `release.published` from NRMS (`apps/nod/src/app.ts:32`), so the replay sends no subscriber email. A test pins this.
  4. Every run writes a report: legacy and NRMS row counts per table, skipped rows with reasons, and warnings for releases that break the new validation (imported anyway; they must be fixed before publishing).
  5. A re-run skips rows edited in NRMS since the last import and lists them in the report.
- **Test data:**
  - `db-scripts` sample data;
  - fictional fixtures using real legacy values (LCIDs, nulls, GUIDs, all five types, inactive rows);
  - published releases copied as-is from api.news.gov.bc.ca.

## 9. Testing and acceptance

- **Unit tests (Vitest):**
  - slug generation, using legacy's `SlugUnitTests` cases verbatim;
  - the HTML allow-list, using legacy's cleaner cases;
  - per-type validation;
  - status transitions;
  - the BC-year boundary;
  - plain-text punctuation clean-up;
  - Flickr URL parsing (including base58).
- **Real Postgres:**
  - concurrent approve numbering;
  - optimistic concurrency;
  - publisher claim, retry and exactly-once;
  - importer on-hold and don't-notify replay.
- **Event contracts:** every NRMS event is validated by the shared schemas and by consumer tests in Core, the News API and NoD.
- **Fake Flickr scenarios:** private→public→verified; sign-in refused; deleted; outage then recovery-as-correction.
- **Staff app:** component tests (Testing Library), axe checks on every screen, and Playwright browser tests against the full local stack (new to the repo).

**Acceptance list.** Phase 3 exits when all of these pass automatically. Items marked * are also checked by hand on boxs.ca.

1. *Test editor signs in; viewer can read but not change; site editor reaches the Website section but cannot Approve.
2. *Each creatable type (Release, Story, Factsheet, Advisory) enforces legacy's per-type required fields in the form; the API refuses the same input directly.
3. Two documents in English and French with contacts; drag reorder; summary auto-fills until hand-edited.
4. Approve assigns a legacy-format Key and `NEWS-` reference; 20 concurrent approvals produce 20 distinct numbers.
5. *Publish now → News API post → static page → NoD email in Mailpit, within one publisher run.
6. Scheduled publish goes out at its minute; a late run still publishes and still makes the Flickr photo public.
7. *Editing a published release re-publishes it as a correction, with a log entry and a new frozen copy.
8. Unpublish removes the release from the News API and the site; an Advisory has no Unpublish.
9. *Flickr failure: the release goes out on time without the photo, the alert shows, and the photo returns after recovery.
10. Delete: permanent without a reference; hidden with one.
11. Search finds headline text, `NEWS-` numbers, keys and Calendar ids, drafts included.
12. *Website: carousel goes live at its time; emergency pin persists across carousel changes; Live Feed and its URLs reach the home record; Blue Bridge needs Core.Admin plus the phrase and shows "TEST —" off production; resource links and files work.
13. Top/Feature: taking a slot moves the previous release out; "What's featured where" reflects it.
14. "View PDF" and "Email me a copy" produce a PDF and a text version.
15. Import of the sample data: the report balances; a re-run changes nothing; scheduled releases stay on hold; replay sends no email.
16. Every staff screen passes axe with no serious or critical violations.

## 10. Changes to the parent spec

- §9 "images (multi-size)" → page images served as uploaded (C31).
- §9 "ministry-scoped permissions" → not built; legacy has none (decision "A", C1).
- §9 "media list selection (from NoD API)" → media lists are owned by NRMS, as in legacy (they live in the Hub DB). NoD and Distribution use them in Phase 4.
- §9 "subscriber counts (from NoD API)" → NoD subscriber count via the new count endpoint (§4). The media-list contact count waits for Phase 4.
- §9 views "Forecast / Drafts / Scheduled / Published" → Forecast moves to Phase 5 (C15).
- §10.1 adds the Core session cookie (§2) alongside bearer tokens.
