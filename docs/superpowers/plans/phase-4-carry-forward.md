# Phase 4 carry-forward (from the 4a reviews)

Items the 4a task and final reviews deferred to later sub-plans. Each later plan must pick up its section, then delete those lines here.

## 4e / 4f (bounces, staff section)
- When an email move deletes a `pending`/`deleted` row, its `subscriber_history` cascades away. Decide the audit-retention rule.
- History has no separate "subscribed" action, so a new signup and a reactivation both log "confirmed". Settle this for the 4f reports.
- After a move, the old address's unexpired manage/verify sessions still work for up to 24 h. Consider using up the subscriber's other session links when the move completes.
- A superseded verify link (claimed by a sibling confirm, no subscriber id) returns `null` from Confirm but `true` from CheckEmailActivationToken. Align them.
- NRMS staff-web media-list screen (4c built the admin API only — `POST`/`PUT /nrms/api/media-lists`, `.../republish`; existing lists arrive via the importer and republish).
- NoD media-list member screens (4c built the admin API only — `GET /nod/api/media-lists`, `GET`/`POST`/`DELETE .../members`, the Media Hub search/sync endpoints).
- A read route/screen listing who opted out of each media list (history action `media-list-opted-out`).

## 4g (retention/purge)
- Purge expired `origin='send'` `subscriber_links` rows (each send mints one per recipient, holding the address).
- Legacy emergency emails are a separate "Emergency Info BC" site with its own banner
  (`https://news.gov.bc.ca/files/systems/EMBC_Email_Banner.png`) and its own reply-to; ours use
  the BC Gov News banner today. Decide whether emergency emails need their own branding/reply-to
  to match. Legacy's reply-to was per-site, not global (`Site.ReplyToEmail`, `NodTask.cs:354`,
  falling back to `Settings.NotificationReplyToEmailAddress` only when a site had none set) — a
  single `NOD_REPLY_TO` can match the BC Gov News site but not a per-site override like
  Emergency Info BC's own reply-to; decide whether that needs its own setting too.

## Phase 4 exit (operations docs)
- Document the production Entra setup for `NoD.SubscribeApi`: the app role, and the grant to the News API's client.

## Low priority
- `PreferencesError` sets no `name`; the empty-`subscribedCategories` case is untested.
- Add a pointer comment in db-kit `migrate()` on drizzle's `folderMillis` skip.
- A Phase 2 subscriber whose subscriptions were all `as_it_happens=false` migrates to `active` with no timing. No Phase 2 path could create such rows.
