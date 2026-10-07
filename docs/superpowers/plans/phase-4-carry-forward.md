# Phase 4 carry-forward (from the 4a reviews)

Items the 4a task and final reviews deferred to later sub-plans. Each later plan must pick up its section, then delete those lines here.

## 4i (emergency feed, retention purge, importer)
- Purge on/off switch and next-run preview on Operations (deferred from 4g, Ruling R2).
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
