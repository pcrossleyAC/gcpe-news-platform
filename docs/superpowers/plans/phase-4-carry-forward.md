# Phase 4 carry-forward (from the 4a reviews)

Items the 4a task and final reviews deferred to later sub-plans. Each later plan must pick up its section, then delete those lines here.

## Phase 4 exit (operations docs)
- Document the production Entra setup for `NoD.SubscribeApi`: the app role, and the grant to the News API's client.

## Low priority
- `PreferencesError` sets no `name`; the empty-`subscribedCategories` case is untested.
- Add a pointer comment in db-kit `migrate()` on drizzle's `folderMillis` skip.
- A Phase 2 subscriber whose subscriptions were all `as_it_happens=false` migrates to `active` with no timing. No Phase 2 path could create such rows.
