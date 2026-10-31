# Manual running notes

The staff, operations and developer manuals (Markdown sources here, built to Word) are deferred
until the UI settles — decided 2026-10-05, replacing "manuals are part of each phase's exit".
Until then, every phase adds a few lines here: anything staff would trip over, workarounds, and
staff-facing behaviour that isn't obvious from the screen. The manual pass later starts from this
file, `docs/parity/changes-from-legacy.md` and the hand-check list in `docs/deploy/siteground.md`.

Tag each note with the manual(s) it belongs in: **Editor**, **Site editor**, **Viewer**,
**Administrator**, **Operations**, **Developer**. Calendar notes are tagged with the Calendar
audience they apply to: **All Calendar users**, **Calendar editors**, **HQ** (any HQ role),
**HQ Editor and above**, **HQ Advanced and above**, **HQ Administrator**, **System Administrator**.

## Phase 3 — NRMS (releases, media, website, staff app)

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
- **Operations** — `NOD_BANNER_URL` (set as `BANNER_URL` in NoD's own schema; the stack strips
  the `NOD_` prefix) is optional. Unset, every NoD email (As-It-Happens, emergency, digest, and
  the manage/verify emails) shows a plain blue "Government of B.C." heading instead of a banner
  image.
- **Developer** — Besides the EMCR feed, an emergency item can be posted through
  `POST /api/emergency-items` (NoD.Admin only). The same guid always resolves to the same item
  (201 the first time, 200 after). Who it goes to is in the Subscribers administrator manual.
- **Developer** — An item's email summary is the release's own Summary field (`r.summary`),
  never the English document's subheadline, even when one is set.
- **Operations** — The digest runs from the scheduled tick at 17:00 BC time. A missed tick
  catches up on the next one, in one digest.
- **Operations** — Pause holds every NoD send (nothing is dropped). Pause and resume are logged
  and emailed to `NOD_OPS_EMAIL` when it is set.
- **Operations** — Media list membership (who's on each list, where they came from, and anyone
  flagged "needs attention" — a Media Hub contact whose chosen address collided with someone
  else's, or whose address disappeared) is managed through NoD's admin API, not a staff-web
  screen yet (4f adds the screens): `GET`/`POST`/`DELETE /nod/api/media-lists/…` for lists and
  members, `POST /nod/api/media-members/:id/resolve` to clear or re-point a flagged member, and
  `GET`/`POST /nod/api/media-hub/sync` for the Media Hub sync's status and manual trigger.
  Nothing is merged or removed automatically; staff resolve a flag by hand.
- **Operations** — Media list names and keys are created and edited through NRMS's admin API
  (`POST`/`PUT /nrms/api/media-lists`); there's no staff-web screen for this yet (4f). After a
  legacy NRMS import run from the CLI — which has no `EVENT_SUBSCRIBERS` to carry the lists over
  — call `POST /nrms/api/media-lists/republish` once so NoD picks them all up.
- **Operations** — `NOD_MEDIA_HUB_*` unset means the stack uses its own fake Media Hub
  (deterministic, made-up contacts) instead of a real one — but that's only true off real
  production. On real production, unset means no Media Hub at all: search, add-from-hub and the
  sync all answer 503. Manual entry (adding a media member by typed email address) still works
  either way.
- **Operations** — The legacy Membership tab's lookup (`Subscribe/SubscriberInformation`) needs
  `NOD_MEMBERSHIP_API_USERNAME` and `NOD_MEMBERSHIP_API_PASSWORD_HASH` (the hash from
  `npm run nod:membership-hash`, never a plain password) — unset, the route always answers 503.
- **Operations** — Distribution's own send settings, set on the stack as `DIST_MAIL_RATE_PER_MINUTE`
  (default 60/min, minimum 1 — no "unlimited" value), `DIST_MAIL_CONCURRENCY` (default 1, capped
  by `DIST_SMTP_MAX_CONNECTIONS`), `DIST_MAIL_REPLY_TO` (unset means no Reply-To header),
  `DIST_MESSAGE_ID_DOMAIN` (defaults to `DIST_MAIL_FROM`'s own domain) and `DIST_INTERNAL_DOMAINS`
  (default `gov.bc.ca,leg.bc.ca`, the +2 priority bump). NoD's own outgoing mail has its own
  Reply-To, `NOD_REPLY_TO` (unset means none) — never point it at a real government mailbox on a
  test site, since redirected test mail would put real replies in front of it. Production sets
  `NOD_REPLY_TO=gcpe.news@gov.bc.ca`, matching legacy's own configured reply address; test sites
  leave it unset.
- **Operations** — Distribution as a whole can be paused from NoD (`NoD.Admin`), the same as
  NoD's own pause (4b). `npm run distribution:capacity` measures local send throughput and
  confirms the per-minute cap holds under concurrent workers; it only ever runs against
  localhost and is never run against SiteGround (see `docs/deploy/siteground.md`).
- **Operations** — Bounce handling's own env keys: Distribution's `BOUNCE_SOURCE` (`fake` on
  every test site, including boxs.ca — `graph` is built but not run live until Q23 is answered),
  and, in `graph` mode only, `GRAPH_TENANT_ID`/`GRAPH_CLIENT_ID`/`GRAPH_CLIENT_SECRET`/
  `BOUNCE_MAILBOX` (all four, or startup refuses to boot). NoD's own `BOUNCE_SUMMARY_EMAIL`
  (unset means the daily bounce summary is never sent) and `DISTRIBUTION_APP_ID` (production
  sets this explicitly to NoD's own Entra client id, rather than relying on its default).
- **Operations** — To hand-test a bounce on a test site (boxs.ca always runs the fake inbox —
  `BOUNCE_SOURCE=fake`): `POST /nod/api/bounces/inbox` (`NoD.Admin`) with
  `{"raw": "<the .eml's full text>"}`; the next scheduled bounce run (every 15 minutes, or the
  next tick in dev) picks it up. Distribution's own `/api/bounces/inbox`
  (`Distribution.Operate`) 404s unless it's actually running in fake mode.
- **Editor** — Bulk actions apply to the rows ticked on the current page only, always after a
  confirmation. Skipped rows (already in that state, or a deleted subscriber you tried to
  activate) are counted in the message, not treated as errors.
- **Editor** — "Disabled" means no email is sent: either bounces disabled the subscriber (the
  detail screen says so) or staff did. Activate restarts the bounce count. "Unsubscribed or
  deleted" subscribers can't be reactivated; only their own re-subscribe brings them back.
- **Editor** — A staff email change sends no confirmation, stops every link in emails already
  sent except the unsubscribe links, and is refused if another record has that address (open
  that record instead). The address of a Media Hub contact, or of anyone linked to one, is
  changed in Media Hub: the subscriber page says so instead of offering Change email.
- **Editor** — Deleting a subscriber removes them from every media list too. That's recorded as
  a staff removal, so adding them back to a media list later needs no opt-out confirmation.
- **Viewer** — The History screen shows "Subscriber" for the person's own actions, staff names
  for staff actions, and "Bounce processing" / "Media Hub sync" for automatic ones.
- **Operations** — Two more test users: `nod-viewer@example.test` and `nod-editor@example.test`.
  `scripts/siteground-seed-users.sh` creates all five.
- **Developer** — Staff subscriber routes answer unexpected errors themselves and log only an
  error code, because their queries bind addresses (`privateErrors`). Use it for any new route
  that binds an address.
- **Editor** — After any email change (by staff, by the subscriber, or from Media Hub), the
  unsubscribe link in every email the subscriber already received still unsubscribes them. The
  other links in those emails, such as manage preferences, stop working.
- **Viewer** — For an all-news subscriber, the subscriber page shows "All news" and also their
  timing (As it happens, Daily digest, or both).
- **Editor** — Media lists: add a reporter from Media Hub (choose which of their emails) or type
  an address for someone not in Media Hub. If they unsubscribed, you'll be asked to confirm, and
  you'll see when they left; add them only if they've asked to come back.
- **Editor** — A flagged member shows why. "Bouncing": clear it once the mailbox works, and
  their bounce count starts again. A Media Hub email problem: pick another of their emails, or
  clear the flag.
- **Viewer** — Each media list shows who left it by unsubscribing, and whether they're back on
  it.
- **Operations** — Operations (NoD Admins) pauses and resumes News On Demand sending and
  Distribution. Each asks first and emails the operations inbox. Pausing holds email; nothing is
  dropped. The bounce summary address is set here; clearing it goes back to the server default.
- **Operations** — On test sites, Operations has a "Test bounce upload" for a `.eml` bounce
  message. Bounce processing picks it up within 15 minutes.
- **Developer** — A route that binds an address or a search term uses `privateErrorsWith`
  (`apps/nod/src/http/private-errors.ts`), and search terms go in POST bodies, never URLs.
- **Editor** — Adding someone to a media list they left by unsubscribing always asks first, even
  if they've since signed up again for public news. Confirm only if they've asked to receive
  media releases again.
- **Editor** — A retired media list can't be put on a release. If a release already had it when
  it was retired, Publish settings shows it ticked and greyed out, marked "(retired)"; it stays
  on the release, but nothing is sent to it.
- **Operations** — When Operations says "Using the server default: …", the bounce summary field
  is empty on purpose. Type an address only to override the default; saving the field empty
  keeps using the default.
- **Viewer** — Subscribers → Reports has five reports: active subscribers by list, recent
  unsubscribes, sends per release, daily digest runs, and Distribution sent and bounced. Dates
  are BC days; pick up to 92 at a time, or leave them empty for the last 30.
- **Viewer** — Every report downloads as a CSV that opens in Excel. Viewers get counts only;
  CSVs with email addresses (a list's members, recent unsubscribes) are for NoD Editors and
  Admins.
- **Editor** — Each address CSV you download is recorded in the operations log (who, which
  report; never the addresses).
- **Viewer** — In Sends per release and Daily digest runs, "Handed off, not bounced" counts
  emails News On Demand handed to Distribution, minus bounces. It isn't delivery: an email still
  queued in Distribution, or one Distribution failed to send, still counts as handed off. "Not
  sent" means not yet handed to Distribution, including a send still going out. Digest emails
  are in Daily digest runs, counted once per subscriber.
- **Viewer** — Totals in Sends per release or Daily digest runs won't match Distribution sent
  and bounced, and aren't meant to: Distribution's report has its own Failed column, counts by
  the day it sent (the other two go by the day the release was published, or the digest's 17:00
  cutoff), and counts every bounce recorded against one of its emails, while News On Demand
  counts only the bounces it could match back to one of its own sends.
- **Viewer** — In Daily digest runs, "Items in window" is worked out when you open the report,
  from the releases in that run's window as they stand now: a release withdrawn since the run no
  longer counts, so an older run's number can go down.
- **Viewer** — While a report is still loading you can already type new dates; what you type
  stays when the report arrives.
- **Operations** — The Distribution report comes from Distribution itself. If Distribution is
  down, that report says so and the others still work.
- **Developer** — Report day boundaries are computed in Node (`apps/nod/src/reports/range.ts`)
  and passed to SQL as instants; never use `AT TIME ZONE` in a report query. CSVs go through
  `streamCsv` (`reports/csv.ts`), which neutralises formula cells and aborts, rather than
  truncates, on error. The legacy-volume probes run with `REPORT_PROBE=1`.
- **Operations** — Adding an index to a big, populated `deliveries` or `messages` table blocks
  sending for a few seconds while the migration runs. `docs/deploy/siteground.md` ("Migrations on
  populated deliveries or messages tables") has the steps to pre-build those indexes without
  blocking and record the migrations as applied.

## Phase 4e.1 — bounce summary parity and Reply-To

- **Operations** — The daily bounce summary has four parts: totals, hard bounces (these count toward
  disabling), soft bounces (mailbox full and the like; usually nothing to do) and unrecorded bounces
  (they matched no email we sent, or bounced a verification email). For an address that keeps
  appearing as unrecorded, check the bounce mailbox; if the line says "NoD subscriber", remove it on
  Subscribers. Bold means a media-list member: tell Media Relations.
- **Operations** — A summary list stops at 500 lines and says how many more there were; the rest are
  in the bounce mailbox.
- **Operations** — Keep `DIST_MAIL_REPLY_TO` unset in production: if set, it becomes the Reply-To of
  every NoD email that has none (digest, emergency, subscription emails).
- **Developer** — Distribution's `GET /api/bounces/summary` (Distribution.Operate) replaced
  `/api/bounces/stats`. Its rows carry addresses in the response body only; never log them or put
  them in a URL. Soft rows are scoped to the calling app's token identity.
- **Operations** — A media-list member already flagged "bouncing" still shows, in bold, every time
  they bounce again — not just the first time. Tell Media Relations each time it reappears; the flag
  alone doesn't mean anyone has fixed the mailbox.

## Phase 4i — emergency alerts feed, retention purge, legacy import

- **Operations** — Emergency alerts come from the EMCR feed every 5 minutes and go to everyone on
  the Emergency Info BC list, whatever their timing. Operations → "Emergency alerts feed" shows the
  last check. A warning there (for example "http-503" or "not-a-feed") means nothing was read; it
  retries by itself. Production's feed URL must be the `www` form: the real site redirects the bare
  domain, and NoD refuses to follow a redirect.
- **Operations** — The first time NoD reads a feed (or after its address changes), it records the
  alerts already there without emailing anyone. Only alerts posted after that are sent.
- **Operations** — An alert edited on the EMCR site updates our copy but is not sent again.
- **Editor** — If you add a journalist to a media list and are asked to confirm because they opted
  out, that holds even if their old record was purged: the opt-out is kept without the address. The
  same applies to an address that simply unsubscribed and was later purged, even if it was never on
  a media list at all — a kept opt-out with no address can't otherwise tell the two apart.
- **Developer** — `npm run nod:import` (see docs/deploy/siteground.md) loads legacy NoD into NoD.
  Run `nrms:import` first and let Core's lists reach NoD. Read the report before trusting the data:
  every skipped row is grouped by reason. Re-running is safe; records changed in NoD since the last
  import are left alone and listed. A single batch can take up to about 1,000 advisory locks
  (`docs/deploy/siteground.md`); that's expected, not a sign of a stuck run.
- **Operations** — The NoD migration `0029_purge_indexes` adds indexes to `job_recipients` and
  `subscriber_links`. On a populated database, pre-build them with the CONCURRENTLY steps in
  docs/deploy/siteground.md.
- **Editor** — A media-list member can now be flagged "Media Hub email opted out of a media list
  this member is on": Media Hub moved their chosen email to an address that had unsubscribed from
  one of their lists, so NoD kept them at their old address instead of moving them. Resolve it
  from the media list: choose another of their emails, update the contact in Media Hub, or remove
  them and add them again, confirming the opt-out. "Clear the flag only" lasts only until the next
  Media Hub sync, which flags them again. Choosing an email that opted out is refused with the same
  explanation.
- **Editor** — Changing a subscriber's email to an address that unsubscribed from one of their
  media lists asks first ("That address unsubscribed"). Change it only if they've asked to receive
  media releases there again; confirming counts as re-adding them to those lists.
- **Editor** — Recent unsubscribes includes people who unsubscribed in legacy, at the dates they
  did so in legacy: after the import, the report's earlier weeks fill in with legacy's
  unsubscribes, not just NoD's own.
- **Developer** — Re-running `nod:import`: someone who unsubscribed in legacy since the last import
  is unsubscribed in NoD too, even if NoD changed their record in the meantime (the report lists
  them as "unsubscribed in legacy since the last import"); if NoD had already purged them, their
  address is kept as opted out of every media list, without the address itself. The newer choice
  wins: if they subscribed again in NoD (or staff reactivated them) after unsubscribing in legacy,
  NoD keeps them and the report lists them as "unsubscribed in legacy before a newer subscribe in
  NoD". A media list
  staff removed and re-added in NoD after legacy's own removal stays.
- **Operations** — The NoD migrations `0031_items_link_identity` (a column) and
  `0032_items_link_identity_index` (an index only, on the small `items` table) speed up the
  emergency feed's check of which alerts it already has. The first check after the deploy fills
  the column in for alerts already recorded.

## Phase 5a — Calendar roles, ministries and HQ organizations

- **Developer** — Core emits `user.upserted` for every user change and on republish. Nothing consumes
  it until the Calendar app (5b) subscribes. Ministries are named by organization key.
- **Operations** — After deploying 5a, re-run `scripts/seed-core-from-public-api.ts` on test sites to
  add the two HQ organizations. The seed and the legacy importer make GCPE Headquarters, GCPE Media
  Relations and the Office of the Premier HQ only when they create them. They never change the HQ
  flag of an organization that already exists, in either direction, so a re-seed or re-import never
  undoes a Core admin's choice. Where the Office of the Premier already existed (as on boxs.ca), tick
  it HQ on Hub → Organizations by hand once.

## Phase 5b — Calendar mounted in the stack

- **Operations** — The Calendar is live at `/calendar` only once its own database exists and
  `CALENDAR_DATABASE_URL` is set; until then the stack runs normally without it and `/calendar`
  answers 503. See `docs/deploy/siteground.md`'s "Corporate Calendar (Phase 5b)" for the exact Site
  Tools steps to turn it on later.
- **Developer** — Core now routes `user.upserted` and the organization/sector/theme/tag
  upserted/deactivated events to the Calendar (and only to the Calendar — no other subscriber
  receives `user.*`). The Calendar refuses a bearer token on every route, so staff always reach
  it through their `gcpe_session` cookie.

## Phase 5b-1 — Calendar app, lookups, public organizations

- **Operations** — The break-glass admin and service tokens have no Calendar access: the Calendar knows
  only users Core has sent it. Sign in as a real user with a Calendar role to use it.
- **Operations** — The Calendar needs its own database. Until `CALENDAR_DATABASE_URL` is set the stack
  runs without it, `/calendar` answers 503, and `node stack.js --check` prints
  `"calendar": {"ok": true, "skipped": …}`. Phase 7's cutover checklist must confirm it is set.
- **Developer** — The Calendar names ministries, sectors, themes and tags by Core key, not id. Its
  projections (`orgs`, `terms`, `users`) have no foreign keys pointing at them.
- **Developer** — The Calendar stores Core keys byte for byte and never case-folds them (spec §5.2).
  Legacy ministry keys are uppercase GUIDs and Core matches keys exactly, so `HEALTH` and `health`
  are two organizations, each with its own HQ flag. Only user ids, which are UUIDs, are lowercased.
- **Operations** — The Calendar has no local-admin sign-in route, so the stack's shared login limiter
  no longer lists `/calendar/auth/local/token`. Staff reach the Calendar only through the Core
  session; a bearer token is refused.

## Phase 5b-2 — Calendar users, test users, report spike

- **Operations** — `scripts/siteground-seed-users.sh` now also seeds five Calendar test users
  (cal-admin, cal-sysadmin, cal-hq-admin, cal-editor, cal-readonly @example.test) and gives them Calendar
  access; run it after the public-API seed so their organizations exist. Re-running it resets the
  cal-* users' Calendar role, ministries and active flag; their contact details and comm-contact
  ranks are untouched. A Calendar user whose organization is missing or inactive is skipped and
  reported.
- **Developer** — The report-rendering spike's code is on `spike/5b-report-rendering`, never merged; its
  findings are in `docs/superpowers/plans/2026-10-08-phase-5b-report-rendering-spike.md`.

## Phase 5c-1 — Activity rules and the activity API

- **Editor** — Between 4pm and 5pm BC time nobody outside HQ can create, change, clone or delete
  activities, or start editing one. A save begun at 3:58 and sent at 4:01 is refused with the same
  message; try again at 5pm. HQ users at Editor and above aren't affected.
- **Editor** — If someone else is editing an activity, it shows "<name> is editing this activity (since
  hh:mm)" and can't be saved until they finish or have been idle for 15 minutes.
- **Editor** — "Someone else changed this activity — reload to see their changes" means another save,
  a review or a Clear LA Status happened since you opened it. Reload, then make your change again.
- **Editor** — Every change is recorded with who made it and the old and new values. A clone's history
  starts with the activity it was cloned from.
- **HQ** — Review clears every needs-review flag and marks the activity Reviewed. On a deleted
  activity it clears only the "deleted" flag. Review selected skips rows changed since the list
  loaded and says which.
- **HQ** — Clear LA Status clears the LA status of every activity you can see that starts on or
  before the chosen number of days from today, past ones included.
- **Operations** — The Calendar's settings (freeze window, release categories, Other city, the
  Translations list, required fields) are in the tenant file's `calendar` section.
- **Operations** — The Calendar sends `activity.*` events to NRMS from now on; NRMS ignores them until
  phase 5h. They never go to the public News API.
- **HQ** — An Awareness activity, or one led by the consultations ministry, keeps the Look Ahead
  section it has (Not on LA for a new one); choosing another section for it has no effect, as in the
  old Calendar. Long Term Outlook can still be ticked.
- **Developer** — A request value the database can't hold (an id past 2,147,483,647, a NUL character,
  a year before 1900 or after 2199) answers 400, never a 500. A database data error the request
  checks miss also answers 400 `{"error":"invalid value"}`, and its code is logged.

## Phase 5c-2 — Transfer, the deactivation preview, undelivered events

- **Editor** — An activity can't be given a comm contact whose account is inactive ("That person's
  account is inactive"). An activity that already has that contact keeps it when saved, but can't
  be cloned until it has an active comm contact: a clone is a new assignment.

## Phase 5d — The activity list

- **All Calendar users** — Hub → Calendar opens the activity list: today onward by default, 30 at a
  time (more load as you scroll, or with "Show more"). Filter by dates, words, HQ Tags, Issue, Date
  Confirmed, Status, Category, Lead Ministry, Comm Contact, Representative, Initiative, Premier
  Requested and Distribution; choose Show All, My Ministries, My Activities or My Watchlist.
- **All Calendar users** — Type an activity number such as HLTH-12345 in "Search for" to go
  straight to it. A bare number up to 10,000 is searched as a word.
- **All Calendar users** — Awareness dates and the consultations ministry are hidden until you pick
  that category or ministry in the filter. They show on My Watchlist.
- **All Calendar users** — Columns: choose which show; your choice and your display are kept.
  The link in the address bar keeps your filter: bookmark it or send it to a colleague.
- **All Calendar users** — A link from an HQ colleague opens without their Corporate Query or Look
  Ahead filter if you can't use those. A filter choice whose lookup was since removed shows as
  "(no longer available)"; pick another or clear it.
- **All Calendar users** — My Queries: save the current filter, run it, rename it, move it and
  delete it. Only you see your queries. Saving works during the 4pm-5pm freeze.
- **All Calendar users** — The star watches an activity; its tooltip lists who else watches it.
- **All Calendar users** — Excel export downloads what the list shows (up to 10,000 activities),
  with the old header, columns and confidentiality footer.
- **All Calendar users** — Month and Week show the same filter as a calendar.
- **HQ Editor and above** — Clear LA Status for the next N days (8 by default).
- **HQ Advanced and above** — Corporate Queries and the Look Ahead filter.
- **HQ Advanced and above** — Searching the Executive Summary only finds it for users who can see
  that field.

## Phase 5e-1 — Activity files

- **Editor** — A file attached to an activity can be a PDF, a PNG, JPEG or GIF image, a Word, Excel or PowerPoint file, an Outlook message, RTF, text or CSV, up to 25 MB, and up to 50 files an activity. A file with the same name, in any case, replaces the old one.
- **Editor** — Adding or removing a file is blocked during the 4pm-5pm freeze (unless you're HQ) and while someone else is editing the activity, as saving is.
- **All Calendar users** — A file opens only for people who can see its activity. Anyone else, including someone holding an old link, gets "not found".
- **Operations** — Calendar files live in `<DATA_DIR>/calendar-files` (`CALENDAR_STORAGE_DIR`). Back that folder up with the Calendar database. The stack refuses to start if it is put inside a folder it serves publicly.

## Phase 5e-2 — Activity editor

- **All Calendar users** — If your session runs out while an activity has unsaved changes, sign in again and open the same activity: the page says "Your unsaved changes were restored." If someone else saved it meanwhile, Save says so and Reload, once you confirm, replaces your changes with their version. Signing out yourself discards kept changes.
- **All Calendar users** — Click an activity's title in the list or the calendar to open it. Save, Cancel, Review and Delete bring you back to the list as you left it, filter and all.
- **All Calendar users** — "View changes" lists every change to the activity, newest first: who, when, and each field before and after. Changes from the old Calendar are marked "from legacy log".
- **All Calendar users** — The star on the activity page adds it to My Watchlist; hover or focus it to see who else watches it.
- **All Calendar users** — An activity you can't see, or that doesn't exist, says "Activity not found".
- **All Calendar users** — When the activity opens read-only, each checklist (Shared With, Comm Materials, Sectors and the rest) lists only what is ticked, or "None".
- **Calendar editors** — "New activity" on the list opens a blank activity at 8:00 AM to 6:00 PM. Saving opens it, ready for files.
- **Calendar editors** — The form checks itself before saving: a box at the top lists what to fix, each linked to its field. A start or end date in the past is a warning, not a stop.
- **Calendar editors** — Potential Dates is shown again, under Schedule. Use a general timeline, like "late June": no numbers, TBC or TBD.
- **Calendar editors** — When someone else is editing, the page says who and since when, and stays read-only. It opens for you, without a reload, once they save, cancel or leave it for 15 minutes.
- **Calendar editors** — Open in two of your own tabs? "Continue here" moves your editing to this tab.
- **Calendar editors** — Leave the page alone for 15 minutes and your edit lock lapses. Your changes stay on the page, and Save still works if nobody else changed the activity; if they did, you're told to reload.
- **Calendar editors** — When Save or Review says someone else changed the activity, Reload asks before it replaces your unsaved changes with theirs. If the reload fails, your changes stay and the page still warns before you leave.
- **Calendar editors** — If someone deletes the activity while you're editing it, Save says so and your changes stay on the page, read-only. Nothing else is offered, except Review for an HQ Administrator.
- **Calendar editors** — Between 4pm and 5pm the page opens read-only, with the freeze message, unless you're HQ.
- **Calendar editors** — Records shows when the tenant turns on the Records section (off for BC, as in legacy, see Q51). Files are added several at a time, and each is checked and saved straight away.
- **HQ Editor and above** — The Look Ahead fieldset follows the activity: the section is worked out from the category, Issue, confirmation and comm materials. Choose another to override it (marked "Override"); "Use the inferred section" undoes that.
- **HQ Editor and above** — Fields changed since the last review say "Changed: needs review".
- **HQ Advanced and above** — Review marks the activity reviewed and brings you back. Review and Clone wait until you've saved or cancelled your own changes.
- **All Calendar users** — "BC Gov News" on an activity lists its releases. If you also have an NRMS role, each one links to the release.
- **All staff** — Who you're signed in as, and Sign out, are at the right-hand end of the header bar.
- **All staff** — A section's own screens (Releases' Drafts/Scheduled/Published, Website, Subscribers, Calendar) are a row of tabs above the page heading; the one you're on is bold and underlined.
- **NRMS editors** — Release history and published copies show times in BC time, like "Today 9:49 AM", not raw timestamps.
- **All Calendar users** — The list's filter is under "Filters", open when the page loads; close it to see more results. New activity, Review selected, Clear LA Status, Excel export and List/Month/Week sit above the results.

## Phase 5f — Updates feed

- **All Calendar users** — Calendar → Updates lists recent changes to the activities you can see. It opens on today's updates. "Latest 5 updates" shows the five newest.
- **All Calendar users** — Use From and To, then Search, to find updates between two dates. From starts at yesterday, and both dates are included; leave either blank to leave that end open. Narrow it further by Update type (Changed, Added, Deleted, Reviewed, Cloned) and by words in the activity's title or summary, or the name of who made the change.
- **All Calendar users** — Type an activity's number above 10,000 (such as HLTH-20001) in "Search for" to see just that activity's updates. Shorter numbers and words like "COVID-19" are searched as text.
- **All Calendar users** — Each line links to its activity. Save or Cancel there brings you back to the same updates.
- **All Calendar users** — Hover over an activity's title in the feed to see its summary. The title and dates shown are the activity's current ones.
- **All Calendar users** — At most 1,000 updates show at once. The page says when there were more: narrow the dates or the search.
- **All Calendar users** — The feed starts empty at cutover. Older changes are on each activity's "View changes", marked "from legacy log".
- **All Calendar users** — Transfers and Clear LA Status don't appear in the feed, as in the old Calendar. See the activity's "View changes".
- **Calendar editors** — When an activity is made confidential, moved to another ministry or deleted, its updates leave the feed for anyone who can no longer see it.
- **HQ Editor and above** — Changes to an activity's Look Ahead fields show as "changed activity" only to people who see the Look Ahead fieldset.

## Phase 5g — Reports

- **All Calendar users** — The list's toolbar has Look Ahead, 30/60/90 and Planning buttons after Excel export. Each makes a PDF of the activities the list's current filter finds, in date order, whatever the list is sorted by.
- **All Calendar users** — A report takes a few seconds. While it's being prepared the page says "Preparing your … report…" and the buttons wait; the PDF then downloads by itself. If you leave the page first, run it again.
- **All Calendar users** — A report holds only activities you can see. Other ministries' confidential activities, and deleted activities, are never in it.
- **All Calendar users** — "Too many activities match" or "Too many rows to print" means the filter is too wide for a PDF: narrow the dates or the filter. "Other reports are being prepared" means wait a few seconds and try again.
- **All Calendar users** — The Look Ahead has six sections; "Consultations and Dialogues" is gone. With no To date it covers 60 days and adds the Long Term Outlook.
- **All Calendar users** — Each activity number in a report links to the activity in the Hub.
- **HQ Editor and above** — Your Look Ahead shows each activity's Executive Summary, when it has one, and its NEW or CHANGED flag. Others see titles and details.
- **Operations** — The Calendar puts each activity on its day with the database's own time-zone data. At startup the stack checks it; if the database's data predates BC's permanent UTC−7 (tzdata 2026b), the error log shows "the Calendar database's time-zone data predates BC's permanent UTC−7", and activities between midnight and 1 a.m. (from 2026-11-01) are listed, exported and reported on the previous day until the database is upgraded. `node stack.js --check` shows the same as `"calendarDbTimeZone"`.
- **Operations** — Reports render in a worker thread of the stack process, one at a time: `CALENDAR_REPORT_CONCURRENCY` (1), `CALENDAR_REPORT_HEAP_MB` (320), `CALENDAR_REPORT_TIMEOUT_SECONDS` (120), `CALENDAR_REPORT_INLINE_WAIT_MS` (5000). A finished PDF stays in memory for 10 minutes; a restart forgets it.
- **Developer** — `npm run calendar:report-compare -- --legacy <pdf> --new <pdf> --out <folder outside the repo>` compares two reports' sections and activity order (5i's parity check).

## Phase 5h — The NRMS link and the Forecast

- **All Calendar users** — An activity's "BC Gov News" shows each linked release's status (Draft, Approved, Scheduled, Published, Failed) within a minute of the change in NRMS. A release being corrected or taken down still shows Published until it's done. A deleted release disappears.
- **Operations** — The NRMS migration adds `calendar_activities`, `calendar_viewers` and `organizations.is_hq`. On first start with the Calendar mounted, the stack asks Core to republish once, so NRMS learns who has Calendar access and which organizations are HQ.
- **Operations** — `npm run calendar:replay-to-nrms` and then `npm run nrms:replay-activity-links` (each a dry run until `-- --confirm`) fill NRMS's copy of the Calendar's activities and the Calendar's release lists. Run them in that order after any legacy release import too: the bulk importer doesn't emit link changes itself, so `nrms:replay-activity-links` is what sends status to the Calendar for the releases it just imported. The second reports how many releases name an activity that wasn't migrated.
- **Developer** — NRMS never holds a confidential activity's text: a database CHECK keeps such rows to the id, the flag and deletion. No event route says "*", and none carries `activity.*` or `release.status_changed` to the News API (`apps/stack/src/env.test.ts`).

## Phase 5i — Legacy Calendar import

- **Operations** — `npm run calendar:import -- --cutoff <date>` reads legacy's Calendar database and writes the Calendar's and Core's. `--cutoff` is required; there's no default. Run it first without `--confirm` and read the report before running it again with `--confirm`. The report balances when `legacy` equals the rows it accounts for; exit code `0` is balanced, `2` is not balanced (still completed — read the report), `1` is an error. After a confirmed import: if `CORE_EVENT_SUBSCRIBERS` wasn't set, run Core's republish; then `calendar:replay-to-nrms --confirm` and a tick; then `nrms:replay-activity-links --confirm` and a tick, in that order. A re-run never overwrites a change already made in the Calendar.
- **Operations** — An unknown legacy ministry, sector, theme or tag stops the import before it writes anything, listed in the report. Fix Core first (import or add the missing one there), then re-run.
- **All Calendar users** — Activities that ended before the cutoff aren't in the new Calendar, except awareness dates, which come in whatever their age. Their history, favourites and files stay in the old Calendar, which one HQ administrator can read for a year after cutover.
- **All Calendar users** — "View changes" on an imported activity shows the old Calendar's recorded changes (title, dates, city, contact, lead ministry, confirmation), marked "from legacy log".
- **Developer** — The import lives in `apps/calendar/src/import/` (`cli.ts`, `run.ts`, `scope.ts`, `map.ts`, `apply.ts`, `apply-related.ts`, `history-map.ts`, `report.ts`) and `apps/core/src/import/calendar-users.ts`. Tests run it against a fake source (`createFakeSource`, `@gcpe/legacy-import`) loaded with the synthetic fixture in `apps/calendar/test/legacy-calendar-fixture.ts`. Because the fake source ignores SQL, the scope rule runs twice for real: once in the SQL that narrows what's read, and again in `selectScope`, which is what the tests actually check.
- **Operations** — `npm run calendar:report-parity -- --csv <file> … --part-c <file> --legacy-dir <folder> --out <folder> --cutoff <date> --from <date> --to <date> --to-30-60-90 <date>` checks our reports against legacy's PDFs on a survey 08 CSV snapshot. Everything it writes holds real activities and people: `--out` must be outside the repository (it refuses one inside) in an owner-only folder, and nothing from it goes into the repo, a ticket or chat. It drops its throwaway `test_…` databases itself; after a crash, `npm run test:clean-dbs` finds them. Results of the first run: `docs/parity/calendar-report-parity.md`.
- **All Calendar users** — A report's CC ID# (for example a four-letter ministry and a six-digit id) now always stays on one line, as in legacy. A long one may run a little past its column's edge instead of breaking before its last digit.

## Phase 6a — Search foundations

- **Operations** — Each tenant config (`config/tenants/*.json`) now has `features` (`semanticSearch`, `staffAi`, both off), `search.language` (`english`, `french` or `simple`) and `site.theme` (colours, font, logo, footer links). A service refuses to start when the theme's text on background, text on surface, or primary text on primary is below 4.5:1 contrast; the error names the pair and the ratio. `branding` is gone: the theme replaces it.
- **Operations** — The News API reads `EMBEDDINGS_PROVIDER` (`stand-in` or `azure-openai`) and the `AZURE_OPENAI_*` settings (`NEWSAPI_`-prefixed on the stack), but nothing calls a provider until semantic search arrives in 6b. Unset means full-text only. `stand-in` is refused on a real production deployment; `node stack.js --check` says so, naming `NEWSAPI_*`.
- **Developer** — `@gcpe/embeddings` holds the provider interface, the stand-in (fixed output, so tests can pin vectors), the Azure provider (plain `fetch`, `dimensions: 1536`), the env settings and `htmlToPlainText`. Providers never log.
- **Developer** — `createGuardedEmbedder` puts a provider behind `CircuitBreaker`: three consecutive failures open it for 60 seconds, then one probe at a time decides. While open, `embed` rejects with `BreakerOpenError` without calling the provider; callers fall back to text search. A failure is logged once as `[embeddings] <provider id> call failed <label>`.
- **Operations** — After the first 6a deploy, run `npm run news-api:search-backfill` (a dry run) and then `-- --confirm` once, with the News API's `DATABASE_URL`. Until then search can't find older posts. New and updated posts get their search text when they're written. The News API refuses to start when the tenant's `search.language` differs from the database's search column (`english` from the migration).
- **Developer** — `applyRelease` writes `posts.search_text` for both NRMS events and the legacy importer (`src/search/search-text.ts`: headlines, summary, keywords, location, subheadlines and bodies, capped at 100,000 characters so the generated tsvector never exceeds Postgres's 1 MB). v1 reads select every column except the two search columns.
- **Developer** — `GET /api/v2/search` (text mode) lives in `src/http/v2/routes.ts` and `src/search/`. v2 is mounted before v1's `/api` router: no `api-version`, `no-store`, and a JSON 404 for unknown v2 paths. `createSearchService` takes an optional `semantic` branch, which returns a page or null; a null or a throw falls back to `textSearch`. 6b plugs semantic mode in there, reusing `searchFilters` and `textSearch`'s `excludeKeys`. The route never logs the query string, and the search handler now carries an `AbortSignal` from the request to that branch, so 6b's guarded embedder can treat a visitor closing the page as neutral to its breaker.
- **Operations** — The app never logs a search's query string, but it isn't the only thing in the path: SiteGround's own proxy, and OpenShift's router where its access logging is on, record the full request line, so `?q=…` and its value land in those proxy access logs outside the app's control.
- **Operations** — Search results link to `<PUBLIC_SITE_URL>/releases/<key>`. On the stack that defaults to the public site's own URL (`SITE_PUBLIC_SITE_URL`); elsewhere to the tenant's `publicSiteBaseUrl`. Set `NEWSAPI_PUBLIC_SITE_URL` to point results at another site, for example BC's webapp.

## Phase 6b — Semantic search, related posts and the change feed

- **Operations** — The News API's migrations add the embeddings, related-posts and change-feed tables, and try to enable pgvector. Where the database user can't (SiteGround), that step is skipped and everything else still runs. `/stack/health` now says `"newsApiSearch": "semantic"` or `"text"`. It is `semantic` only when the tenant's `semanticSearch` flag is on, an embeddings provider is configured, and the database has pgvector; the News API logs which one is missing at startup. boxs.ca always says `text`.
- **Developer** — No drizzle schema column uses the `vector` type. `post_embeddings.embedding` is `real[]`; the one custom migration (`0005_pgvector_optional`) wraps `CREATE EXTENSION vector` and the HNSW expression index on `embedding::vector(1536)` in a `DO` block that skips both on `insufficient_privilege` or `undefined_file`. `resolveSearchMode` (`src/embeddings/pgvector.ts`) decides the mode once at startup. Tests that need the SiteGround case use `createRestrictedNewsTestDb()`.
- **Operations** — The News API keeps a change feed, `GET /api/v2/changes`, for the public site's builder: one row per change to a post, a ministry, sector, theme or tag, home, slides or resource links. It needs a service token (role `NewsApi.ChangesRead`) or a `Core.Admin` token, answers `503` where the News API can verify neither, and keeps 90 days. An older cursor gets `410 { "resync": true, "next": … }`.
- **Developer** — Every projection write calls `recordChanges(tx, …)` (`src/changes.ts`) in its own transaction, as does the legacy importer's unpublish step. `recordChanges` takes one advisory lock (`[0x67637065, 4]`) before inserting, so change ids commit in order and a reader's cursor can't skip a late commit; it must stay the last lock a projection transaction takes. `410` is decided by `change_feed_state.pruned_through`, not `min(id)`, because rolled-back inserts leave gaps.
- **Operations** — In semantic mode the tick embeds up to 50 published posts a minute (about 33 hours for 100,000 posts the first time) and recomputes their related posts. Unpublishing a post removes its embedding and related posts in the same transaction. The worker has its own 5-second provider timeout and its own breaker, separate from search's.
- **Developer** — `runEmbeddingTick` (`src/embeddings/worker.ts`) keeps `post_embeddings` to published posts only: it re-reads and row-locks the posts before writing, and skips any that were unpublished or rewritten during the provider call. The embedding source text is the first 8,000 characters of `posts.search_text`; its SHA-256 is stored as `posts.embedding_text_hash` on every post write, so finding changed posts is a plain comparison. `deleteSemanticRows` (`src/embeddings/rows.ts`) runs inside every unpublish.
- **Operations** — In semantic mode, search lists posts close in meaning to the query first, then ordinary full-text matches. Each response says which mode answered. Search now allows 60 requests a minute per visitor IP (`NEWSAPI_SEARCH_RATE_LIMIT_PER_MIN`); the threshold for a semantic match is `NEWSAPI_SEARCH_SEMANTIC_THRESHOLD` (default 0.6). An open breaker no longer writes a log line per search.
- **Developer** — `createSemanticSearch` (`src/search/semantic.ts`) embeds `normaliseForEmbedding(q)` through `QueryVectorCache`, then, in one read-only repeatable-read transaction, reads up to 1,000 vector keys by exact cosine distance (a `MATERIALIZED` CTE, so the HNSW index is never used for search) and fills the rest of the page with `textSearch(…, { excludeKeys, window })`. It returns null instead of throwing on any embed failure. Text mode's count and page now share one snapshot too.
- **Site editor** — A published release now has related posts available to the platform's own public site (6c): in semantic mode, the releases closest in meaning; otherwise the newest releases from the same lead ministry that share a tag. An unpublished release drops out of every related list straight away.
- **Developer** — `createRelatedService` (`src/search/related.ts`) serves `post_related` only while the startup search mode is semantic, filtered to published posts at read time, and otherwise the lead-ministry-and-tag fallback. v2 answers a malformed percent-encoded path with its own 400, unlogged.
- **Developer** — A batch that fails on the provider (not an open breaker) is split in half and retried, recursing down to single posts, within the same tick, so one post whose text a provider refuses can't hold up the other posts behind it in the newest-50 window. A post that still fails alone is recorded in the new `post_embedding_failures` table (one row per post, keyed by its `embedding_text_hash`) and the candidate query skips it until a rewrite changes that hash. The splitting is breadth-first (a FIFO queue), not depth-first recursion, specifically so the breaker's consecutive-failure count never reaches its threshold of 3 from one poison post among healthy ones — a healthy sibling batch is always tried soon after a failing one, resetting the count. Provider calls per tick are capped at twice the batch size.
- **Developer** — The worker also looks directly for a published post with a current embedding but no `post_related` row (left behind by a process restart between the embedding commit and the related computation) and recomputes just its related list, with no provider call, even in a tick that found nothing new to embed.
- **Developer** — The worker's row lock (`SELECT … FOR UPDATE`) now uses `SKIP LOCKED`: a post a legacy import's bulk unpublish or `search-backfill --all` is locking at that moment is simply left for the next tick, instead of the worker waiting on it, so the two can never deadlock.
- **Operations** — Before turning semantic search on, the 6a search backfill must have already run: the worker skips a post whose `search_text` is still NULL. The 33-hour backlog figure is an upper bound — with the stack's internal loop also running, ticks can run back to back and the real pace can be faster.

## Phase 6c — The public site

- **Operations** — The site's colours and font come from the tenant config's `site.theme`. Logo and font files go in `config/site/assets/`; the site copies them on every start. Until a logo file exists the header shows the site name as text.
- **Viewer** — The public site has a page for every ministry (with its minister and media contacts), sector, theme and tag, each with its latest 20 posts and an RSS feed (`feed.xml`). Older news is in the archive, one page per month.
- **Operations** — The site rebuilds every page a post appears on when it's published, changed or unpublished. A deploy that changes the page layout rebuilds the whole site once, on start.
- **Operations** — Site rebuilds now go through a queue in the site's database and run on each tick (200 pages at a time). A publish, change or unpublish shows on the site at the next tick. A layout change or a Blue Bridge switch updates the home page at once and older pages over the following ticks, newest first.
- **Developer** — `npm run site:rebuild-all` (with the site's DATABASE_URL, NEWS_API_URL, OUTPUT_DIR and PUBLIC_SITE_URL) queues every page.
- **Operations** — If the site builder was stopped, it catches up from the News API's change feed when it starts again; if it was stopped for more than 90 days it rebuilds the whole site.
- **Administrator** — Standalone (OpenShift): the site builder needs an Entra app registration with the News API's `NewsApi.ChangesRead` app role (NEWS_API_TOKEN_URL, NEWS_API_CLIENT_ID, NEWS_API_CLIENT_SECRET, NEWS_API_SCOPE), and the News API needs AUTH_AUDIENCE. It won't start without them.
- **Viewer** — The site's Search page searches every published post, optionally within one ministry. Ministry and sector pages link to it. Without JavaScript it points to the archive instead.

## Phase 6d–6e — Staff help and the exit checks

- **Developer** — The News API has a service-only `POST /api/v2/internal/similar` for NRMS (role `NewsApi.Similar`). It never stores, caches or logs the draft text it is sent, and only ever returns published posts.
- **Operations** — With the staff-AI flag on (and a provider and pgvector), the News API's embedding worker runs even when semantic search is off: AI matching compares drafts with published posts' vectors. Search and related posts stay in text mode until `semanticSearch` is also on.
- **Administrator** — Standalone (OpenShift): NRMS needs `NEWS_API_URL` and an Entra app registration holding the News API's `NewsApi.Similar` app role (`NEWS_API_TOKEN_URL`, `NEWS_API_CLIENT_ID`, `NEWS_API_CLIENT_SECRET`, `NEWS_API_SCOPE`) for "Similar published releases". Without `NEWS_API_URL` the panel doesn't appear. On the stack it's wired automatically.
- **Viewer** — The panel is for editors only; viewers don't see it.
- **Developer** — `npm run site:quality` builds a fictional, production-config copy of the public site and runs axe (zero violations allowed) and Lighthouse (accessibility ≥ 95, performance, best practices and SEO ≥ 90) on every page type. It needs Playwright's Chromium (`npx playwright install chromium`). CI runs it as the `site-quality` job.
- **Developer** — `npm run search:spot-check` runs 20 searches over a fictional corpus in a throwaway database and lists the top 5 for each. Text mode must find every expected post. With the stand-in provider the semantic column proves only that the plumbing works; set `EMBEDDINGS_PROVIDER=azure-openai` and the Azure settings to check real relevance once Azure is available (Q70).

## Site settings (2026-10-27)

- **Viewer** — The public site has a new Connect page (`/connect/`) listing the government's social accounts, and a footer and banner that staff can change. Ministry pages now have a side column: media contacts, the ministry's website, photos and videos, and its featured topics and services.
- **Operations** — Until the first publish, the site uses `config/tenants/<tenant>.site-settings.json` (the bc tenant's file carries news.gov.bc.ca's footer and social links, banner off). Edit that file and redeploy to change the starting point.
- **Operations** — A theme or banner publish never rebuilds pages. A Connect change rebuilds the Connect page; a ministry-heading change rebuilds the ministry pages; a footer change rebuilds every page, and so does the new year each January.
- **Operations** — If the News API can't be reached for settings, the site keeps the last settings it applied (saved in `.site-settings.json`, which isn't served) and still handles Project Blue Bridge and deploys as normal.
- **Developer** — New public route `GET /api/v2/site-settings` on the News API (`{ revision, publishedAt, document }`, 404 before the first publish).

## Entra staff sign-in

- **Viewer** — "Sign in with Microsoft" signs you in with your government Microsoft account. You need a Core account first: if the screen says "Your account hasn't been set up", ask an administrator to create you. Signing out of the staff app doesn't sign you out of Microsoft.
- **Administrator** — Switching on Entra sign-in also switches on Entra token checks in every app (`ENTRA_TENANT_ID` is a shared, stack-wide setting), so each app's `<PREFIX>_AUTH_AUDIENCE` must be filled in too, or the site won't start.
- **Operations** — In *real* production with Entra sign-in on, user passwords are refused unless `CORE_LOCAL_PASSWORDS_ALLOWED=true`. A test site run with `NODE_ENV=production` (`LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true` or `SITE_ENVIRONMENT=test`, e.g. boxs.ca) is unaffected either way. The break-glass administrator (`LOCAL_ADMIN_*`) is unaffected too.
- **Developer** — `FAKE_ENTRA_ENABLED=true` (tests and test sites only) mounts a fake Microsoft sign-in at `/fake-entra` with two made-up identities, `entra-staff@example.test` and `entra-unknown@example.test`. It needs `CORE_PUBLIC_BASE_URL` and is refused in real production and alongside real Entra settings, by the same test-site rule as `CORE_LOCAL_PASSWORDS_ALLOWED` above.

## Hardening batch 1

- **Operations** — The tick now runs `calendar.orphan-sweep`. It deletes Calendar attachment bytes that no attachment references any more (left behind when a delete failed after a replace or remove), only once they are a day old, at most 50 per tick. A failure logs "[calendar] orphan sweep could not delete a stored file" with the error's type only; it retries on its next pass.
- **Developer** — `npm run test:clean-dbs` lists leftover test databases (`test_<20 hex>`, `test_nr_<16 hex>`) and roles (`nr_<16 hex>`); `-- --confirm` drops them. It skips anything in use or created in the last hour (`-- --min-age-minutes=N` to change), so it is safe while another checkout's tests run.
- **Developer** — NRMS's upload routes (release files, site files, page images) take the name in the `X-GCPE-File-Name` header, percent-encoded, like the Calendar's. `?name=` is refused with a 400.
