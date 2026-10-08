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
- **Operations** — `NOD_BANNER_URL` (set as `BANNER_URL` in NoD's own schema; the stack strips
  the `NOD_` prefix) is optional. Unset, every NoD email (As-It-Happens, emergency, digest, and
  the manage/verify emails) shows a plain blue "Government of B.C." heading instead of a banner
  image.
- **Administrator** — Emergency alerts go out through `POST /api/emergency-items` (NoD.Admin
  only), to every active subscriber on the `emergency:alerts` list regardless of their own
  As-It-Happens/digest preference. The same guid always resolves to the same item (201 the first
  time, 200 after).
- **Developer** — An item's email summary is the release's own Summary field (`r.summary`),
  never the English document's subheadline, even when one is set.
- **Operations** — The digest runs from the scheduled tick at 17:00 BC time. A missed tick
  catches up on the next one, in one digest.
- **Operations** — Pause holds every NoD send (nothing is dropped). Pause and resume are logged
  and emailed to `NOD_OPS_EMAIL` when it is set.
- **Editor** — A correction never re-emails subscribers. Unpublishing stops anything not yet
  sent and keeps the release out of later digests.
- **Editor** — Subscriber emails show the release's Summary (pre-filled from the body,
  editable), not the subheadline — the same as legacy.
- **Editor** — A release's media lists (if any) are chosen in Publish settings; picking any
  media list sends the full-text media version to that list's members, replacing the
  As-It-Happens copy for anyone who's both (one email, never two). Media lists lock once a
  Release or Factsheet has gone live; an Advisory must have at least one.
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
- **Administrator** — Pausing Distribution holds every message below `system` priority
  (As-It-Happens, digests, media lists). It does not hold verification, manage-link or ops-notice
  mail, so subscribers can still confirm/unsubscribe and staff still get the pause/resume email
  while paused. Nothing is dropped — held messages send once resumed. A row already claimed by
  the sender when the switch flips still finishes sending; pausing only stops new claims.
- **Administrator** — A message held by a Distribution pause for longer than `MAIL_MAX_AGE_MS`
  (24 hours by default) fails on its first post-resume send error rather than retrying further,
  and otherwise still goes out on resume however old it is — age alone never blocks a send. A
  long pause (for example, across a writ period) releases whatever stale mail is still pending
  as soon as sending resumes; decide whether that's acceptable before resuming.
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
- **Administrator** — A bounce-disabled subscriber is `disabled`, exactly like a staff-disabled
  one (4a): kept, sent nothing, still shown as a member by the membership endpoint, and
  reactivated by re-subscribing themselves — the verify email reaching them again proves the
  mailbox works. Never deleted, unlike legacy. A media-list member is flagged "needs attention"
  instead and is never disabled; staff clear the flag by hand.
- **Administrator** — The 10-in-15-days disable/flag rule counts *emails*, not delivery rows: a
  digest that lands in a subscriber's inbox as one message is one count toward the 10, even
  though it leaves several delivery rows (one per item). Ten consecutive bounced digests disable
  (or flag) a subscriber just as fast as ten consecutive bounced As-It-Happens emails would — it
  is never easier to trip for a digest subscriber than for anyone else.
- **Administrator** — The daily bounce summary (`BOUNCE_SUMMARY_EMAIL`, unset means none) goes
  out at 08:00 BC time, only when there was a bounce to report since the last one — one line per
  bounced subscriber (address, hard/soft and status code, and the outcome: recorded/disabled/
  flagged, media-list members shown in bold), then the counts of unmatched and ignored messages.
  Soft bounces are recorded on the subscriber's deliveries but never counted or listed.
- **Administrator** — "Something to report" (what decides whether that daily summary sends at
  all) includes an *unmatched* bounce (a bounce report Distribution couldn't tie to any message
  it sent) — it still shows up in the unmatched count even with no subscriber line of its own.
  Mail Distribution classified `ignored` (not recognisable as a bounce at all — an auto-reply, a
  calendar response, anything else that landed in the inbox) never does; a window with only
  ignored mail sends no summary.
- **Administrator** — Staff roles for subscribers: **NoD Viewer** finds subscribers and reads
  their details and history; **NoD Editor** also adds, edits, deactivates, reactivates, deletes
  and changes email; **NoD Admin** can do everything an Editor can. Grant them on the Users
  screen.
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
- **Administrator** — "Lists and categories" (Subscribers) shows each list's active subscribers.
  NoD Admins can stop offering a list or a whole category (existing subscribers keep it and
  still get its releases) and set the order the public sees. Names come from Core, and media
  lists from NRMS.
- **Administrator** — "Media list names" (Core Admins) adds, renames, orders and retires media
  lists. Retiring stops releases going to a list but keeps its members. Changes reach News On
  Demand within a minute.
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
- **Administrator** — Operations → "Soft bounces counted as hard" lists 4.x.x codes that count like a
  hard bounce. It is empty until the business supplies its list (Q42). A change applies from the
  next bounce on, never to earlier ones, and is recorded in the operations log.
- **Editor** — Replies to a release, advisory, story or factsheet email go to the address set as
  `NOD_REPLY_TO` (gcpe.news in production). Replies to the digest, emergency alerts and
  subscription emails go to the sending mailbox (noreply.newsondemand), as in legacy.
- **Operations** — Keep `DIST_MAIL_REPLY_TO` unset in production: if set, it becomes the Reply-To of
  every NoD email that has none (digest, emergency, subscription emails).
- **Developer** — Distribution's `GET /api/bounces/summary` (Distribution.Operate) replaced
  `/api/bounces/stats`. Its rows carry addresses in the response body only; never log them or put
  them in a URL. Soft rows are scoped to the calling app's token identity.
- **Operations** — A media-list member already flagged "bouncing" still shows, in bold, every time
  they bounce again — not just the first time. Tell Media Relations each time it reappears; the flag
  alone doesn't mean anyone has fixed the mailbox.
- **Editor** — In the release editor you can save one section while another is still saving (or
  press several Save buttons in the sticky bar in a row). Each save waits its turn — the section
  shows "Waiting to save…", then "Saving…" — and nothing you typed is lost. "Someone else changed
  this — reload to see their changes" now only appears when another person really did change the
  release.

## Phase 4i — emergency alerts feed, retention purge, legacy import

- **Operations** — Emergency alerts come from the EMCR feed every 5 minutes and go to everyone on
  the Emergency Info BC list, whatever their timing. Operations → "Emergency alerts feed" shows the
  last check. A warning there (for example "http-503" or "not-a-feed") means nothing was read; it
  retries by itself. Production's feed URL must be the `www` form: the real site redirects the bare
  domain, and NoD refuses to follow a redirect.
- **Operations** — The first time NoD reads a feed (or after its address changes), it records the
  alerts already there without emailing anyone. Only alerts posted after that are sent.
- **Operations** — An alert edited on the EMCR site updates our copy but is not sent again.
- **Administrator** — Operations → "Retention purge" is off until the business sets retention rules
  (Q25). It lists what it would delete if it ran now. Turning it on asks first; from then on it
  deletes, every night at 3:00, for good. Turning it off stops further deletions. Subscribers
  disabled by bounces are never deleted by it.
- **Administrator** — Links in sent emails are cleared 10 days after they expire whether or not the
  purge is on. They stopped working long before.
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
- **Administrator** — Imported subscribers who had already ended in legacy are kept for 90 days from
  cutover, whatever their legacy end date (confirmed by Paul, Q47), so a bad import can still be
  redone from legacy before the purge removes anything.
- **Operations** — The NoD migrations `0031_items_link_identity` (a column) and
  `0032_items_link_identity_index` (an index only, on the small `items` table) speed up the
  emergency feed's check of which alerts it already has. The first check after the deploy fills
  the column in for alerts already recorded.

## Phase 5a — Calendar roles, ministries and HQ organizations

- **Administrator** — Calendar access (Hub → Calendar access) gives a person one Calendar role (Read
  Only, Editor, Advanced, Administrator, System Administrator) and their ministries. A role needs at
  least one ministry. Saving replaces the person's whole ministry list.
- **Administrator** — A Calendar Administrator can grant up to Administrator. Only a System
  Administrator or a Core admin can grant System Administrator, or change a System Administrator's
  access. Nobody but a Core admin can change their own access: ask another administrator.
- **Administrator** — Members of an HQ organization see every ministry. GCPE Headquarters, GCPE
  Media Relations and the Office of the Premier are HQ. Only an HQ Administrator, a System Administrator or a Core admin can add an
  HQ ministry to someone.
- **Administrator** — Only a Core admin adds users. A Calendar Administrator gives existing users
  Calendar access.
- **Administrator** — Core admins set which organizations are HQ on Hub → Organizations. Turning HQ off
  for an organization takes the all-ministry view away from every member at once.
- **Administrator** — A user with no email (imported from the legacy Calendar) is inactive and can't
  sign in. On Hub → Users, "Link and activate" sets their email and lets them sign in once they
  have a password.
- **Administrator** — A ministry that has been deactivated can't be added to anyone, but people who
  already have it keep it when their access is saved.
- **Developer** — Core emits `user.upserted` for every user change and on republish. Nothing consumes
  it until the Calendar app (5b) subscribes. Ministries are named by organization key.
- **Operations** — After deploying 5a, re-run `scripts/seed-core-from-public-api.ts` on test sites to
  add the two HQ organizations. The seed and the legacy importer make GCPE Headquarters, GCPE Media
  Relations and the Office of the Premier HQ only when they create them. They never change the HQ
  flag of an organization that already exists, in either direction, so a re-seed or re-import never
  undoes a Core admin's choice. Where the Office of the Premier already existed (as on boxs.ca), tick
  it HQ on Hub → Organizations by hand once.
- **Administrator** — On Calendar access, a Calendar Administrator who is not in an HQ organization
  isn't offered HQ ministries, and has no Edit button on someone who holds an HQ ministry: only an HQ
  Administrator, a System Administrator or a Core admin can change those. The server checks again on
  every save and shows its refusal in the form.
- **Administrator** — If a save names a ministry that doesn't exist or has been deactivated, the error
  lists which of the ministries you chose it refused.

## Phase 5b — Calendar mounted in the stack

- **Operations** — The Calendar is live at `/calendar` only once its own database exists and
  `CALENDAR_DATABASE_URL` is set; until then the stack runs normally without it and `/calendar`
  answers 503. See `docs/deploy/siteground.md`'s "Calendar app (Phase 5b)" for the exact Site
  Tools steps to turn it on later.
- **Developer** — Core now routes `user.upserted` and the organization/sector/theme/tag
  upserted/deactivated events to the Calendar (and only to the Calendar — no other subscriber
  receives `user.*`). The Calendar refuses a bearer token on every route, so staff always reach
  it through their `gcpe_session` cookie.
