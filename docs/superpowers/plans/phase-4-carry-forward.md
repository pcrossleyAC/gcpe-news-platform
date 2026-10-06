# Phase 4 carry-forward (from the 4a reviews)

Items the 4a task and final reviews deferred to later sub-plans. Each later plan must pick up its section, then delete those lines here.

## 4b (sending)
- **Must do:** As-It-Happens footers still link `MANAGE_URL?token=<manage_token>` (`send-jobs.ts`), which the new manage page rejects. Switch footers to fresh `manage` links, then retire `subscribers.manage_token` and its unsubscribe fallback.
- **Must do:** point `List-Unsubscribe` at `/api/Subscribe/OneClickUnsubscribe/<stable token>` (`tokens.ts`). Before that: give one-click POSTs their own rate-limit bucket (mail providers POST from shared IPs), pass the upstream content-type through and share forwarding code with the generic proxy loop, and assert the forwarded body in its test.
- Test pages polish: `loadCategories` swallows fetch errors; a manage page with no token sends `"null"`; the unsubscribe button has no network-failure handling; a bad email shows the generic "invalid request"; the status role switches at runtime; the emergency category isn't offered; rename `id="unsubscribe-link"` (it's a button); the expired-link wording is unpinned. The e2e spec has a dead `waitForMessageWithSubject` import.

## 4c (media lists)
- **Must do before any media member exists:** `infoFor` lists `media-distribution-lists:*` keys in a public manage view; `update()` (via `replaceSubscriptions`) deletes media memberships because `toPrefs` drops media lists; a public unsubscribe sets a media member to `deleted` (C59 says media members are flagged, not deleted).
- Q27: the Media Hub Membership tab most likely calls legacy `Subscribe/SubscriberInformation?emailAddress=`.
- Add a test for re-activating a deactivated list (`upsertList`).
- Media-list send layout from a real sample: no banner or footer, the full release text ("For Immediate Release", key, date, ministry, TYPE, headline, body, contact), then READ MORE and the topic line without media-list names. See `docs/parity/samples/media-list-as-it-happens-2026-09-21.md`.

## 4e / 4f (bounces, staff section)
- Define `disabled` (bounce- or staff-disabled). 4a already treats it like `active` when someone moves onto that address. Decide whether a disabled subscriber may reactivate themselves through subscribe/confirm (today they can, and a test pins it).
- When an email move deletes a `pending`/`deleted` row, its `subscriber_history` cascades away. Decide the audit-retention rule.
- History has no separate "subscribed" action, so a new signup and a reactivation both log "confirmed". Settle this for the 4f reports.
- After a move, the old address's unexpired manage/verify sessions still work for up to 24 h. Consider using up the subscriber's other session links when the move completes.
- A superseded verify link (claimed by a sibling confirm, no subscriber id) returns `null` from Confirm but `true` from CheckEmailActivationToken. Align them.

## Phase 4 exit (operations docs)
- Document the production Entra setup for `NoD.SubscribeApi`: the app role, and the grant to the News API's client.

## Low priority
- `PreferencesError` sets no `name`; the empty-`subscribedCategories` case is untested.
- Add a pointer comment in db-kit `migrate()` on drizzle's `folderMillis` skip.
- A Phase 2 subscriber whose subscriptions were all `as_it_happens=false` migrates to `active` with no timing. No Phase 2 path could create such rows.
