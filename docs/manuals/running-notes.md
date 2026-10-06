# Manual running notes

The staff, operations and developer manuals (Markdown sources here, built to Word) are deferred
until the UI settles — decided 2026-10-05, replacing "manuals are part of each phase's exit".
Until then, every phase adds a few lines here: anything staff would trip over, workarounds, and
staff-facing behaviour that isn't obvious from the screen. The manual pass later starts from this
file, `docs/parity/changes-from-legacy.md` and the hand-check list in `docs/deploy/siteground.md`.

Tag each note with the manual(s) it belongs in: **Editor**, **Site editor**, **Viewer**,
**Administrator**, **Operations**, **Developer**.

## Phase 3 — NRMS (releases, media, website, staff app)

- **Editor** — Each release-editor section saves on its own. While any section has unsaved
  edits, a bar at the bottom of the page lists them.
- **Editor** — When Approve or Publish is greyed out, the reasons are listed right under the
  buttons (the same list as the header's checklist).
- **Editor** — Publishing and unpublishing happen in the background. The release page updates by
  itself until the release settles; no need to reload.
- **Editor** — A NoD email only goes to subscribers of the release's ministries. A release for a
  ministry nobody subscribes to publishes normally and sends no email (seen on boxs.ca with a
  CITZ release, 2026-10-05).
- **Editor** — If Flickr is down at publish time, the release still goes out on time without the
  photo. A Flickr alert shows on the release, and the photo appears once Flickr recovers.
- **Administrator** — The break-glass administrator (LOCAL_ADMIN_*) has no email address, so
  "Email me a copy" is disabled for it. Use a real staff account to test email.
- **Administrator** — A fresh install comes with the default page types (News Release,
  Information Bulletin, Statement, Backgrounder, Traffic Advisory). Without them, no release can
  be created.
- **Operations** — On SiteGround the public site is served under `/site`
  (`PUBLIC_SITE_URL=https://boxs.ca/site`), and staff use `/hub/`. Test sites carry noindex and a
  "TEST —" banner.
- **Operations** — On the test site, all outgoing mail goes to the operator. The intended
  recipient is in an `X-Original-To` header and a `[to: …]` subject prefix.
- **Operations** — SiteGround kills the process after 30–60 s idle and cold-starts it on the
  next request. Background work runs from the scheduled `/stack/tick`. A deploy only takes
  effect after the old process idles out (~60 s).
- **Developer** — Run tests under Node 24 (tzdata ≥ 2026b, for BC's permanent UTC−7). Under the
  shell's default Node 22, two time-zone tests fail.
- **Developer** — Public pages are static files. When `render.ts` changes what every page bakes
  in, bump `RENDER_CHROME_VERSION` (rebuild.ts), so startup self-heal re-renders the pages
  already on disk.

## Phase 4 — NoD and Distribution

- **Operations** — Subscription emails link to `SUBSCRIBE_PAGE_URL` (default: the public site's
  `/subscribe/manage/`). Links last 24 hours. An address gets at most 3 confirmation/manage
  emails an hour; more requests are quietly ignored.
- **Operations** — A fresh NoD has no lists until Core's reference data reaches it; the stack asks
  Core to republish once at startup when NoD has no ministry lists.
- **Developer** — The public Subscribe API never reveals whether an address is subscribed, and
  takes link tokens only, never an email address in place of a token (C60).
- **Operations** — Until 4b, As-It-Happens footers link with the old manage token, which the new
  manage page doesn't accept; keep NOD_MANAGE_URL pointed at its old value on test sites.
