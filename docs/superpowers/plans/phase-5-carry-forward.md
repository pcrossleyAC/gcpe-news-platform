# Phase 5 carry-forward

Items one sub-plan leaves for a later one. Delete an item when the plan that takes it is written.

## 5b-2

- **Calendar users screen (§8.5).** Role and ministries go through `PUT /core/api/calendar-access/:id` (built in 5a). Active and Link for Calendar Administrators need new Core routes, under Q55's rule: Calendar-only users only, unless the caller is Core.Admin.
- **Calendar test users.** Add Calendar test users to `TEST_USERS`, `scripts/siteground-seed-users.sh` and `tests/e2e/constants.ts`, with ministries. `seedTestUsers` will need the organizations to exist first.

## 5c

- **Dead-letter page.** The Calendar's outbox has a dispatcher but no screen for dead deliveries; build it when the Calendar first emits `activity.*` (spec addendum §5.1).
- **Lock-expiry sweep** on the stack tick (spec addendum §5.1, §7.5), with the `activity_locks` table that 5b-1 created.
- **Tenant `calendar` config section** (spec addendum §5.1): freeze window and zone, release category ids 12 and 58, City "Other…" 311, comm material 61, category names, consultations ministry, contact-ministry exclusions, `SharedWithExcludes`, Translations default list, required-field switches, `ShowHqCommentsField`, `ShowRecordsSection`, cover image, banner text.
- **Transfer** (spec addendum §7.1, §8.5): the API and the screen, with the users screen 5b-2 builds.
- **Deactivation preview** (spec addendum §8.5, `User.aspx:183-223`): list a user's open activities before deactivating, filtered by `visible()`. Legacy listed every activity with that user as an active comm contact, past ones included; "open" here means not deleted and ending today or later.
- **A cloned activity's history must record its source id** — for example an `activity_change_fields` row `cloned_from` — so the clone's history can be traced back to the activity it came from.
- **`needs_review` writers must de-duplicate keys.** A write that adds to the `needs_review` set must not insert the same field key twice; the schema's check constraint (§5.2) only bounds the set to the 23 known keys, it doesn't dedupe.

## 5e

- **`CALENDAR_STORAGE_DIR`** for attachments, outside the deploy folder (spec addendum §5.1, §8.4).

## 5g

- **Look Ahead: don't build "Consultations and Dialogues".** That section hasn't been used in years (Paul, 2026-10-07). 5g does **not** build it. Record it in `docs/parity/changes-from-legacy.md` as dropped: "dropped: unused for years, Paul 2026-10-07". Update the spec's "all 7 sections" (R6, §10.2) and the cover legend to match. Check whether the §7 category rule "contact ministry is the consultations ministry → Consultations and Dialogues" still matters without the section.
- **Legacy report fixes** (from `docs/parity/legacy-report-layouts.md`'s discrepancies): drop the doubled "updated updated" wording in the Executive Look Ahead's "Last updated" line; drop the raw, unparsed `**CONFIDENTIAL**` markdown marker from a row's title. "Consultations and Dialogues" is dropped entirely, per the item above.

## 5h and later

- **The News API must never gain an `activity.*` handler.** Confidential Calendar content must stay inside the Calendar (C127); only the id-only confidential form of `activity.*` and `release.status_changed` cross that boundary (spec addendum §5.4).
- **If service tokens with Calendar roles ever exist, Core's `actorIsHq` should apply only to session callers.** `actorIsHq` (`apps/core/src/services/calendar-access.ts`) today only ever sees a session actor; before a service token could carry a Calendar role, re-check that it still reads HQ membership only for a session caller, not for a bearer/service subject.
- **The NRMS → News API event route is `"*"`** (`apps/stack/src/env.ts`, the `NRMS`→`NEWSAPI` entry). Before NRMS emits `release.status_changed`, make that route list its types explicitly, or at least exclude `release.status_changed`, so the event goes only to the Calendar. The Calendar's `projectionHandler` (`apps/calendar/src/projections.ts`) also accepts only `core` today: it must accept the `nrms` source for `release.status_changed`.
- **Re-check NRMS "email me a copy" if service tokens ever carry NRMS roles.** `POST /nrms/api/releases/:id/email-copy` (`apps/nrms/src/http/routes.ts`) sends to the bearer's `email` claim. A service token with an NRMS role could then send a release to whatever address its claims name.

## 5i

- **Sequences:** re-base every legacy-id identity (`activities`, every lookup, `comm_contacts`, `saved_filters`, `activity_files`) above the imported maximum (spec addendum §12.1).
- **Lookup names:** legacy allows a NULL `Name`; the Calendar's `name` is NOT NULL, so map NULL to `""`.
- **Keys, not ids:** legacy ministry GUIDs map to Core organization keys (`contact_ministry_key`, `ministry_key`, `activity_shared_with.ministry_key`), and sectors, themes and tags to term keys.
- **`comm_contacts` is unique on (user, ministry).** Merge the contacts of duplicate-email legacy users onto one, and remap `activities.comm_contact_id` to the surviving contact.
- **Legacy join tables:** keep only `IsActive` rows, and de-duplicate them (a legacy join table can hold more than one active row for the same pair).
- **Null legacy timestamps and status:** map a null legacy `CreatedDateTime`, `LastUpdatedDateTime` and `StatusId` to a value — none of the three is nullable here.
- **Null `Log.CreatedBy`:** give it a fallback actor name rather than importing a null actor.
- **`SortOrder`** maps to `rank`.
- **Empty mobile values:** a blank legacy mobile number imports as an empty string. `user_profiles.mobile`'s CHECK allows that (empty, or 12 characters of digits and hyphens), so don't map it to null or reject it.

## Entra sign-in (later phase)

- **Entra/OIDC matching must never match on a null email.** When Entra/OIDC sign-in is built, matching an incoming identity to a Core user by email must treat `email IS NULL` as "no match", never as a wildcard — a user imported without an email (spec addendum §4, "Users without email") must stay unmatched until an admin links a real address.

## Staff-web follow-up

- **Add `/hub/calendar` to the e2e axe sweep.** `tests/e2e/axe-sweep.spec.ts` (the stack-wide sweep) has no entry for the Calendar's landing screen or its lookup screens. The Calendar's target-size CSS is already done.
