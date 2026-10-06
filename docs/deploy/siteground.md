# Deploying apps/stack to SiteGround

This is the operator runbook for running the whole platform (`apps/stack`, every app mounted
under one Node process) on SiteGround's Node.js hosting. It assumes the facts recorded in
`.superpowers/sdd/2026-10-03-phase-2-thin-e2e-slice/siteground-facts.md` (probed + SSH'd on the
owner's GrowBig account, project `boxs.ca`, host `giowm1258`) — the short version:

- One Node.js project runs everything. `PORT` is injected by the platform at startup.
- SiteGround's own build pipeline deletes `package-lock.json` and runs `npm install` on
  deploy — there must be nothing in the artifact's `package.json` `dependencies` for it to
  resolve. The artifact (`dist/siteground/`, built by `scripts/build-siteground.mjs`) bundles
  every dependency into `stack.js` for exactly this reason.
- The process is killed after 30–60s idle; the next request cold-starts it (measured locally:
  a cold start of all six apps completes in well under a second).
- WebSocket upgrades are stripped (SSE still works) — the stack runs with
  `UPDATES_HUB_ENABLED=false` here; there is no live-updates hub in production.
- The Postgres user SiteGround creates **cannot** `CREATE DATABASE` or `CREATE EXTENSION` —
  the six databases are created once, up front, in Site Tools; `pgvector` is installed but
  cannot be enabled (it stays off).
- Background work (publishing, event dispatch, notification sends) only happens when
  something calls `/stack/tick` — an external scheduler must call it roughly every minute.
- Each deploy unpacks into a brand-new folder, so nothing relative to the app may hold state
  that must survive the next one — see "Persistent data" below for `DATA_DIR`.

## One-time setup

### 1. Node.js project

Site Tools → Devs → Node.js → create a project. Select the **Node 24** selector
(`/usr/local/bin/node-24` — verified tzdata 2026b, BC offset −07:00 correct; do **not** use the
account's default Node, which may be older and have stale tzdata — the stack self-checks this
at startup and refuses to start if it's wrong). Leave the app's entry point as `stack.js` and
the **build command empty** — SiteGround's own build pipeline exists (and can't be skipped),
but the artifact has nothing for it to build.

### 2. Databases

In Site Tools → Databases, create **six PostgreSQL databases and one database user** with
access to all six (the user can't create its own databases, so this is a one-time manual
step, not something any script here can do). Suggested names (matching
`scripts/siteground-env.ts`'s defaults): `gcpe_core`, `gcpe_nrms`, `gcpe_news_api`,
`gcpe_site`, `gcpe_nod`, `gcpe_distribution`. Host is always `localhost` — the public
PostgreSQL hostname is rejected by `pg_hba.conf`.

### 3. Mailbox / SMTP

Create a SiteGround mailbox (or point at an external relay) for outbound mail. For the first
deploy, set `DIST_MAIL_REDIRECT_TO` to a mailbox you control (see the env generator below) —
every message the stack would otherwise send goes there instead, regardless of the real
recipient, until you deliberately clear it. There is no safe way to "try it against real
recipients a little bit"; it's redirect-everything or send-to-real-recipients, nothing between.

### 4. Environment variables

Generate the full set with:

```sh
npm run siteground:env
```

This prompts for the domain, the six databases' user/password, SMTP details, and the admin
username/password (hidden input — never echoed), and prints a block of `KEY=value` lines —
generating every internal secret
(`TICK_TOKEN`, `LOCAL_AUTH_SECRET`, and `STACK_EVENT_SECRET`, from which the stack derives every internal event subscription and per-pair signing secret — no JSON settings to paste) itself, with
`crypto.randomBytes`. Paste the output into Site Tools → Devs → Node.js → your project →
Environment Variables.

**Do not set `PORT`** — SiteGround injects it. **Do not set `TENANT_CONFIG`** — the artifact
carries its own `config/tenants/bc.json` next to `stack.js` and `stack.js` finds it
automatically (see "How MIGRATIONS_FOLDER and TENANT_CONFIG resolve" below).

**Never set any `*_DATABASE_URL` to a `self:/...` value.** Every other `*_URL` var in this
stack may use the `self:/path` shorthand (resolved at startup to
`http://127.0.0.1:<port>/path`, since the six apps talk to each other over loopback) — but
`*_DATABASE_URL` is deliberately excluded from that resolution (ruling P2-R32): a database is
never reached over the stack's own HTTP port, and the six databases above are only ever
reachable at `localhost:5432` directly. `scripts/siteground-env.ts` always generates real
`postgres://` URLs for these; if you ever hand-edit one, keep it that way.

**Keep `LOCAL_ADMIN_ENABLED=true`** (as generated) unless Entra is configured for NRMS's
service calls. NRMS calls NoD (the subscriber count shown at schedule time) and Distribution
("Email me a copy") with a service token; when the `NOD_TOKEN_URL`/`NOD_CLIENT_ID`/
`NOD_CLIENT_SECRET`/`NOD_SCOPE` and `DISTRIBUTION_TOKEN_URL`/`DISTRIBUTION_CLIENT_ID`/
`DISTRIBUTION_CLIENT_SECRET`/`DISTRIBUTION_SCOPE` sets are unset, that token is minted locally
from the local-admin settings. Turning local admin off without setting both Entra sets leaves
NRMS with no way to authenticate those calls.

For a non-interactive/scripted run (CI, or re-generating without re-typing everything), see
`npm run siteground:env -- --non-interactive` and the `SITEGROUND_*` env vars it reads
(`scripts/siteground-env.ts`'s module doc comment has the full list) — intended for tests, not
for typing a real production password into a shell history.

### 5. GitHub deploy

Site Tools → Devs → Node.js (or Git) → connect the repository, branch **`deploy/siteground`**,
**no build command**. SiteGround deploys whatever is pushed to that branch verbatim. This
branch's tree is never source — it's always exactly the output of
`scripts/build-siteground.mjs` (`dist/siteground/`), committed there by
`scripts/deploy-siteground.sh` (see "Per-deploy steps" below). Nobody edits it by hand.

### 6. Background work scheduler (ticking `/stack/tick`)

Background work (NRMS publishing due releases, event dispatch between apps, NoD sending
notifications, Distribution sending mail) only runs when `/stack/tick` is called — the process
has no internal clock that survives being idle-killed. Something external has to call it on an
interval.

First, generate a token file on the server over SSH (the token never appears in the cron
command line, where it would otherwise be visible to anyone who can list cron jobs or read
process listings):

```sh
umask 077; printf '%s' '<TICK_TOKEN>' > ~/.gcpe-tick-token
```

(`<TICK_TOKEN>` is the value `siteground:env` generated — the same one pasted into
`TICK_TOKEN` above.)

**Primary: SiteGround's own cron (Site Tools → Devs → Cron Jobs).** `curl` (8.15.0, verified
on the host) is available; there is no `crontab` binary over SSH — cron is managed only
through Site Tools, not hand-edited. Add a job running:

```sh
curl -fsS -X POST -H "Authorization: Bearer $(cat ~/.gcpe-tick-token)" https://<domain>/stack/tick > /dev/null
```

Interval: every minute if Site Tools' job editor accepts it (the documented minimum interval
here wasn't exact at time of writing); every 5 minutes is acceptable for testing — background
work then lags by up to 5 minutes instead of 1. Prefer the tightest interval Site Tools allows.

**Fallback: an external scheduler (e.g. cron-job.org).** Use this only if Site Tools' own cron
turns out not to support the interval you need, or isn't available on the plan. Configure a
job that POSTs to `https://<domain>/stack/tick` with header `Authorization: Bearer
<TICK_TOKEN>`, once a minute. (`?token=<TICK_TOKEN>` on the URL also works, for a scheduler
that can only issue a bare GET — but it then lands in plaintext in the stack's own and any
intermediate proxy's access logs; use the header whenever the scheduler supports one, and
rotate `TICK_TOKEN` on a schedule if you ever have to use the query-string form.)

Either way: an inbound POST to `/.../events` (one app calling another) also wakes an
idle-killed process, same as any other request — the scheduler's job is specifically to run
the *background* workers (publish/dispatch/send), which nothing else triggers.

## Persistent data

Each deploy unpacks into a brand-new `~/www/<domain>/public_html/.nodeapp/<timestamp>/` folder
(verified 2026-10-04) — nothing stored relative to the running app survives the *next* deploy.
Before Task 1 this included the public site's own output folder, so every `/site` page 404'd
after a redeploy until something rebuilt it.

Everything that must survive a redeploy now lives under one folder, **outside** any
`.nodeapp/<release>/` directory: `DATA_DIR`, defaulting to `~/gcpe-data` (the home directory is
writable over SSH and outside the deploy folders) if unset. Set `DATA_DIR` explicitly only if
you want it somewhere else — a relative value resolves against the home directory, same as the
default.

Today this folder holds:

- `site-output/` — the public site's `OUTPUT_DIR`. `SITE_OUTPUT_DIR` in the generated env
  (`SITE_OUTPUT_DIR=./site-output`) is relative, so the stack resolves it under `DATA_DIR`
  automatically; an absolute `SITE_OUTPUT_DIR` is left as-is.
- `storage/` — NRMS's `STORAGE_DIR` default (uploaded release files/media assets), same rule:
  overridable with an explicit `NRMS_STORAGE_DIR`.

The stack checks `DATA_DIR` is writable (creating it if needed) **before** starting any app and
refuses to start at all if it isn't — a misconfigured or unwritable `DATA_DIR` fails loudly at
startup instead of surfacing later as a silent write failure.

As a second line of defence against exactly the failure Task 1 fixes — a redeploy (or a
`DATA_DIR` pointed somewhere new) that leaves `site-output/` empty — the public site self-heals
once at startup: if its output folder has no `index.html`, it rebuilds the home page and the
latest posts from the News API itself, before anything else would have rebuilt them. This never
blocks or fails startup (the News API may not be reachable yet); a failure is only logged
(`[public-site] self-heal failed: ...`).

## Per-deploy steps

1. From a clean worktree (no uncommitted changes — the script refuses otherwise, since the
   artifact must come from a known commit):
   ```sh
   npm run deploy:siteground
   ```
   This builds the artifact (`scripts/build-siteground.mjs`, which also runs
   `node stack.js --check` as a build-time smoke test and fails the build if it doesn't pass),
   then commits it to `deploy/siteground` in a throwaway git worktree — your current
   branch/worktree is never touched. It prints the push command; **it never pushes**.
2. Review what changed if you want to (`git log deploy/siteground`, or diff the printed
   commit against the previous one) before publishing.
3. Run the printed push command yourself:
   ```sh
   git push --force origin deploy/siteground:deploy/siteground
   ```
   This is the moment it goes live — SiteGround's GitHub deploy watches this branch with no
   build step, so the push *is* the deploy.
4. Optionally, SSH in and re-run the same check the build already ran, against the real,
   deployed tree and real env vars this time (the build-time run above only proves the
   bundle's own structure is sound — it uses placeholder env, not your real Site Tools values):
   ```sh
   node ~/path/to/your/project/stack.js --check
   ```
   A non-zero exit, or `"ok": false` in the JSON it prints, names exactly which app and which
   `<PREFIX>_*` prefix is misconfigured.
5. Run the smoke test below.

### How MIGRATIONS_FOLDER and TENANT_CONFIG resolve in the artifact

Each app's own default `MIGRATIONS_FOLDER` (and the stack's own default `TENANT_CONFIG`) is
computed once, from that file's own `import.meta.url`, at module load. Bundled into one flat
`stack.js`, every one of those defaults would resolve to the same wrong path (one level above
the artifact, not `migrations/<app>` next to it). `apps/stack/src/main.ts` works around this:
before starting anything, it checks whether `./migrations/<app>/` and
`./config/tenants/bc.json` actually exist *next to the running `stack.js`* and, only if they
do, fills in the matching `<PREFIX>_MIGRATIONS_FOLDER` / `TENANT_CONFIG` env var — but only
when you haven't already set one yourself. This is why the artifact's own `migrations/` and
`config/` directories (populated by `scripts/build-siteground.mjs`) have to travel with
`stack.js`; it's also why `node stack.js --check` is the thing that actually proves this
resolution worked, both at build time (placeholder env) and, optionally, after a real deploy
(step 4 above, real env).

## Smoke test

NRMS checks every release's ministries and sectors against its own copy of Core's
taxonomy, and takes the Key's abbreviation from the lead ministry — so Core's data has to
reach NRMS first:

- After deploying Phase 3 (or on any fresh NRMS database), run Core's republish once with
  the admin token so NRMS receives every ministry and category:
  `curl -fsS -X POST https://<domain>/core/api/admin/republish -H "authorization: Bearer <access_token>"`
  (then tick, step 5 below, or wait for the cron job to deliver the events).
- The smoke test (by hand below, or `scripts/siteground-smoke.sh https://<domain>`) needs a
  `health` ministry with abbreviation `HLTH` and a `health` sector in Core.

Replace `<domain>` and `<TICK_TOKEN>` below.

```sh
# 1. Aggregate health — every mounted app's own /health/ready, cached 5s.
curl -s https://<domain>/stack/health

# 2. Log in as the local admin (the password you set via siteground:env).
curl -s -X POST https://<domain>/nrms/auth/local/token \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"<ADMIN_PASSWORD>"}'
# -> {"access_token": "..."}

# 3. Create, approve and schedule a release (use the access_token from step 2). Each step
#    returns the release; send back its current "version". Approve assigns the "key".
curl -s -X POST https://<domain>/nrms/api/releases \
  -H 'content-type: application/json' -H "authorization: Bearer <access_token>" \
  -d '{"type":"release","pageTitle":"News Release","layout":"formal","organizations":"Ministry of Health","headline":"Smoke test","bodyHtml":"<p>Smoke test.</p>","location":"Victoria","contacts":["Media Relations\n250-555-0100"],"ministries":["health"],"leadMinistryKey":"health","sectors":["health"]}'
# -> {"id": "<id>", "version": 1, ...}
curl -s -X POST https://<domain>/nrms/api/releases/<id>/approve \
  -H 'content-type: application/json' -H "authorization: Bearer <access_token>" \
  -d '{"version":1}'
# -> {"key": "<key>", "version": 2, ...}
curl -s -X POST https://<domain>/nrms/api/releases/<id>/schedule \
  -H 'content-type: application/json' -H "authorization: Bearer <access_token>" \
  -d '{"version":2,"publishAt":"now"}'

# 4. Add a notification subscriber.
curl -s -X POST https://<domain>/nod/api/subscribers \
  -H 'content-type: application/json' -H "authorization: Bearer <access_token>" \
  -d '{"email":"you@example.com","lists":["ministries:health"]}'

# 5. Drive the tick yourself (don't wait for the scheduler) — call it twice if the static
#    page isn't there yet after the first call (publish and rebuild run on separate steps).
curl -fsS -X POST -H "Authorization: Bearer <TICK_TOKEN>" https://<domain>/stack/tick
curl -fsS -X POST -H "Authorization: Bearer <TICK_TOKEN>" https://<domain>/stack/tick

# 6. View the published page.
curl -s https://<domain>/site/releases/<key>/

# 7. Check the redirected mailbox (DIST_MAIL_REDIRECT_TO) for the notification email.
```

If steps 1–6 all succeed and the email in step 7 arrives, the deploy is good end to end:
database connectivity, auth, publishing, event dispatch, static rebuild, and mail delivery.

## Staff app (Phase 3)

The staff app (apps/staff-web) is served at **`https://boxs.ca/hub/`** — `apps/stack/src/stack.ts` mounts the built bundle there (`STAFF_WEB_DIR`; `apps/stack/src/env.ts`'s default is `./hub`, next to the running stack, when that directory exists — which is what the deployed SiteGround bundle (`scripts/build-siteground.mjs`) lays down — falling back to `apps/staff-web/dist` otherwise, i.e. in dev) ahead of the News API's own catch-all. A deep link (e.g. `https://boxs.ca/hub/releases/<id>`) and a plain browser refresh on one both work (the `/hub` route serves `index.html` for anything under it, with `Cache-Control: no-store` on the shell itself and a year-long immutable cache on its hashed `/hub/assets/*`). `scripts/build-siteground.mjs` builds and bundles it into the artifact automatically — there is no separate staff-app deploy step.

**Who sees what.** The same `gcpe_session` cookie and roles gate every screen (constraints.md: "roles decide what's shown, but the server is the authority" — hiding a nav item or button is a convenience, never the actual enforcement):

| Role | Sees |
|---|---|
| `NRMS.Viewer` | Releases (Drafts/Scheduled/Published), Search — read-only everywhere; no Approve/Publish/Delete/etc., no Website, Users or Error log. |
| `NRMS.Editor` | Everything a Viewer sees, plus "New release" and every write action in the release editor (Approve, Schedule/Publish now, Cancel, Unpublish, Delete, documents, categories, media asset, page details, Top/Feature). No Website, Users or Error log. |
| `NRMS.SiteEditor` | Releases/Search read-only (same as Viewer, unless also an Editor) plus the whole Website section — carousel, emergency pins, Live Feed, resource links, files, "what's featured where", the website log. Sees Project Blue Bridge's current state and warning text but not its switch. No Users or Error log. |
| `Core.Admin` | Users (create/deactivate staff, set roles and passwords) and the Error log, plus Project Blue Bridge's switch (needs the typed confirmation phrase and the IGRS checkbox) and read access to the Website section. The environment break-glass `admin` account carries this role (see below). |

**Reporting a problem.** A Core.Admin signs in and opens `/hub/error-log` (`GET /stack/errors`, newest first) — entries are written to `<DATA_DIR>/logs/errors.jsonl` and survive a SiteGround idle-kill restart (unlike the in-memory log a Phase 2 deployment would have lost — see "Troubleshooting" below), so what happened before the last restart is still there to read. Values inside a logged error message are redacted before they're stored.

**Hand-check list.** The items below are automated against the whole stack running locally (`npm run test:e2e`, Phase 3's acceptance list, `docs/superpowers/specs/2026-10-03-nrms-parity-design.md` §9) but are also marked `*` there for a hand check on boxs.ca itself, since production Flickr, real SMTP delivery and the real SiteGround cron cadence can't be faked:

- [ ] **Item 1** — sign in as the test editor (`scripts/siteground-seed-users.sh` creates/resets the three test users); confirm a viewer can read a release but has no write controls, and a site editor reaches the Website section but never sees Approve.
- [ ] **Item 2** — create one of each type (Release, Story, Factsheet, Advisory) through `/hub/releases/new`; confirm the form's required/allowed fields match the type (e.g. an Advisory offers no Sectors/Themes/Tags).
- [ ] **Item 5** — approve and publish a release now; confirm it reaches the public site (`https://boxs.ca/site/releases/<key>/`) and a subscriber actually receives the NoD email, within one scheduled `/stack/tick` run (see "Background work scheduler" above).
- [ ] **Item 7** — edit a field on an already-published release; confirm it shows "Republishing…" and comes back as "Published" with a new entry in its History ("Show all") and an extra frozen copy.
- [ ] **Item 9** — with a real `NRMS_FLICKR_API_KEY` configured, run `scripts/siteground-flickr-walkthrough.sh https://boxs.ca --outage` (see "Flickr" below) and confirm the release goes out on time without the photo, the alert shows, and the photo appears once recovered.
- [ ] **Item 12** — schedule a carousel go-live a minute or two out and confirm it switches over on its own; confirm an emergency pin survives an unrelated carousel change; confirm Project Blue Bridge needs the Core.Admin phrase and (off production) shows "TEST —" on the public banner.
- [ ] **Phase 4 item 1** — on `https://boxs.ca/site/subscribe/`, subscribe an address you control (it arrives at the redirect addresses with a `[to: …]` prefix); open the link, change a preference, save; unsubscribe from the manage page. The footer manage link and one-click unsubscribe now work against the new manage page (fixed in 4b — see Phase 4 item 3 below).
- [ ] **Phase 4 item 3** — publish a release that reaches your test address; confirm the As-It-Happens email arrives exactly once, and that both its footer manage link and its one-click unsubscribe (`List-Unsubscribe`) work.
- [ ] **Phase 4 item 4** — after a publish, check the following evening that the 17:00 BC-time digest arrives and includes the item. Note: releases published before the 4b deploy have no NoD item, so the first digest after deploy only includes releases published after it.
- [ ] **Phase 4 item 10** — pause NoD sending; confirm nothing goes out while paused; resume; confirm sends release again.
- [ ] **Phase 4c item 6** — create a media list, add yourself as a member (`POST /nod/api/media-lists/<key>/members`), publish a release with that media list chosen; confirm the full-text media email arrives, with the standard footer and a working one-click unsubscribe.
- [ ] **Phase 4c item 7** — add a member from the Media Hub search (real or fake), change that contact's chosen email address, run the sync (`POST /nod/api/media-hub/sync`); confirm the member's address updates. Delete the contact and sync again; confirm the member is gone.
- [ ] **Phase 4c item 8** — with `NOD_MEMBERSHIP_API_USERNAME`/`NOD_MEMBERSHIP_API_PASSWORD_HASH` set, curl the legacy membership endpoint directly:
  ```sh
  curl -u '<username>:<password>' 'https://boxs.ca/nod/Subscribe/SubscriberInformation?emailAddress=<member email>'
  ```
  confirm it 200s with `SubscribedCategories["media-distribution-lists"]` listing the member's lists, and that a wrong password 401s with a `WWW-Authenticate` header.

Staff sign in at `POST /core/auth/login` and receive one `gcpe_session` cookie that every app's API accepts. Its signing key is derived from `STACK_EVENT_SECRET`, so there is nothing new to add in Site Tools. (Setting `SESSION_SECRET` explicitly overrides the derived one; changing either signs everyone out.)

The break-glass `admin` account signs in through the same endpoint. To create or reset the three test users (`editor@example.test`, `site-editor@example.test`, `viewer@example.test`), run from your Mac:

    scripts/siteground-seed-users.sh https://boxs.ca

It asks for the admin password and a password for each test user (12+ characters, input hidden).

**Revoking access.** A session renews (and its roles refresh) while the user stays active; changing a password or logging out does not end a user's *other* sessions. To cut someone off, deactivate the user — that takes effect at once in Core, and within the cookie's remaining life (at most 1 hour) in other apps. To end every session at once, including break-glass, rotate `SESSION_SECRET` (or `STACK_EVENT_SECRET`, which also re-derives the event secrets).

## Flickr (Phase 3c)

Fake mode is automatic whenever NRMS has no effective Flickr key (`FLICKR_API_KEY` /
`NRMS_FLICKR_API_KEY` unset or empty) **and** at least one of: `NODE_ENV` isn't `production`, or
`LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true`, or `FLICKR_MODE=fake` (see `usesFakeFlickr` in
`apps/stack/src/env.ts`) — the stack mounts a fake Flickr at `/fake-flickr` and points NRMS at
it instead, so the whole photo-publishing path can be exercised before a real key exists. boxs.ca
qualifies today because `siteground:env` sets `LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true`.

Without a key, a *real* production deployment (`NODE_ENV=production`, no
`LOCAL_ADMIN_ALLOW_IN_PRODUCTION` and no `FLICKR_MODE=fake`) fails closed instead: no Flickr at
all — the publisher alerts on every release with a photo and the asset-status endpoint reads
"unavailable" — rather than silently using the fake for real photos.

**Exercising it end to end.** From your Mac:

```sh
scripts/siteground-flickr-walkthrough.sh https://boxs.ca
```

Signs in as the break-glass admin (same hidden password prompt as `siteground-seed-users.sh`),
creates a release with a fake Flickr photo as its media asset, approves and schedules it for
"now", then polls `/nrms/api/releases/<id>` and `.../asset-status` once per cron tick (up to 8
minutes — background work only runs when something calls `/stack/tick`; see above) printing the
release's status, Flickr alert and asset state each time, and finally prints the public page
URL. It exits non-zero if the release never reaches the expected end state.

A second mode additionally drives the fake's outage switch, to exercise the up-to-2-minute grace
period, the alert, and the automatic correction once the photo becomes available again (C28 in
`docs/parity/changes-from-legacy.md`) — recovery gets its own, longer budget (up to 10 minutes),
since the worker only retries every 5 minutes once a job is out of grace:

```sh
scripts/siteground-flickr-walkthrough.sh https://boxs.ca --outage
```

Only ever run either against a stack that is actually using the fake (no real
`NRMS_FLICKR_API_KEY` / `FLICKR_API_KEY` set) — `--outage` calls a fake-only control endpoint and
the photo id it uses only exists there. The walkthrough itself checks this first and refuses to
run otherwise.

**Switching to real Flickr at cutover.** Free Flickr accounts can't create API keys (found
2026-10-03) — the key has to be created under the `bcgovphotos` account itself, which needs a
Pro subscription. Once a key and secret exist:

1. Locally (never on SiteGround — this needs an interactive browser step), with `FLICKR_API_KEY`
   and `FLICKR_API_SECRET` set in your shell:
   ```sh
   npm run nrms:flickr-authorize
   ```
   It prints a Flickr URL — open it, approve access, copy the verifier code it shows, and paste
   it back at the prompt. On success it prints the access token and secret (and only prints them
   — they're written nowhere else).
2. Paste these four values, plus `NRMS_FLICKR_ALERT_EMAILS` (comma-separated addresses), into
   Site Tools → Devs → Node.js → your project → Environment Variables:
   ```
   NRMS_FLICKR_API_KEY=<key>
   NRMS_FLICKR_API_SECRET=<secret>
   NRMS_FLICKR_ACCESS_TOKEN=<token printed above>
   NRMS_FLICKR_ACCESS_SECRET=<secret printed above>
   NRMS_FLICKR_ALERT_EMAILS=<comma-separated addresses>
   ```
   Setting `NRMS_FLICKR_API_KEY` is what switches the stack off the fake and onto real Flickr for
   NRMS (Flickr settings are NRMS's alone — see `apps/stack/src/env.ts`). The unprefixed
   `FLICKR_API_KEY` / `FLICKR_API_SECRET` also work (envFor's `nrmsFlickrSetting` falls back to
   the unprefixed name when no `NRMS_`-prefixed one is set) but the prefixed form is what the
   stack's own startup warning names, so it's used here for consistency.

**What the alert means.** If a release's photo can't be made public within 2 minutes of the
release actually going out, NRMS publishes the release anyway (keeping the photo link), raises
`flickrAlert` on it (shown in the staff app) and emails `NRMS_FLICKR_ALERT_EMAILS`. It keeps
retrying every 5 minutes for 24 hours; the moment the photo is confirmed public, the release is
automatically re-published with it and the alert clears. After 24 hours it stops retrying and
sends a final email — at that point the photo should be re-added or replaced by hand.

## Website section (Plan 3d)

The home-page carousel, emergency pins, Live Feed, resource links, general files and Project
Blue Bridge (the mourning banner) are all under `/nrms/api/site/*` — `NRMS.SiteEditor` edits
every one of them except Project Blue Bridge, which is `Core.Admin` only (spec §6). Reads
(`GET /nrms/api/site/*`) are open to any of `NRMS.Viewer`, `NRMS.Editor`, `NRMS.SiteEditor`,
`Core.Admin`.

**Live Feed defaults.** `LIVE_WEBCAST_MANIFEST_URL_DEFAULT` and `LIVE_WEBCAST_M3U_URL_DEFAULT`
(both optional URLs, `apps/nrms/src/start.ts`) are what the Live Feed editor shows when
`site_settings` has no URL stored for that field (constraints.md Q1) — they're never written
back to the row, just what's displayed unconfigured. Through the stack, set them prefixed —
`NRMS_LIVE_WEBCAST_MANIFEST_URL_DEFAULT` / `NRMS_LIVE_WEBCAST_M3U_URL_DEFAULT` — same as every
other `NRMS_*` SiteGround setting (`envFor` in `apps/stack/src/env.ts` strips the prefix before
NRMS ever sees it).

**Core, for Project Blue Bridge's admin directory.** Turning Project Blue Bridge on or off emails
every active `Core.Admin` user, looked up through Core's `GET /api/directory/admin-emails` with
a dedicated, read-only service role (`Core.AdminDirectory` — not `Core.Admin`, and never held by
a human; see `apps/nrms/src/clients.ts`'s `coreClient`). `CORE_URL` defaults to `self:/core`
in-stack (`STACK_APP_DEFAULTS`, `apps/stack/src/env.ts`) — nothing to set for that, and nothing
turns it off in-stack: `startNrms` builds a `coreClient` (and the `serviceTokenProvider` behind
it) whenever `CORE_URL` is set, exactly like `NOD_URL`/`DISTRIBUTION_URL` above. Its Entra
fields follow the same all-or-none rule as `NOD_*`/`DISTRIBUTION_*` above —
`CORE_TOKEN_URL`/`CORE_CLIENT_ID`/`CORE_CLIENT_SECRET`/`CORE_SCOPE` — with the same local-admin
token fallback when they're unset. **Production needs the quartet set** (or local admin left on)
— without either, `serviceTokenProvider` throws as soon as `startNrms` tries to build the Core
client, so **NRMS refuses to start at all**, exactly like an unset `NOD_*`/`DISTRIBUTION_*`
quartet with local admin off — not a soft failure limited to the Blue Bridge notify step. The
"notify step just logs instead of emailing" behaviour only exists for the `CORE_URL` genuinely
unset case, which is unreachable in-stack (the default above always sets it) — it only applies
outside the stack, where the Blue Bridge route still works and `notify()` just logs the
subject, never an address, instead of calling Core.

**The test-site rule and `SITE_ENVIRONMENT`.** A deployment is a *test site* — every public page
gets `<meta name="robots" content="noindex, nofollow">` and the Project Blue Bridge banner text
(when on) is prefixed `TEST — ` — unless it's the real production deployment:
`NODE_ENV=production` **and** not `LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true` **and** not
`SITE_ENVIRONMENT=test` (`isTestSite`, `apps/public-site/src/site-env.ts`; same rule as legacy's
Flickr fake-mode check). `SITE_ENVIRONMENT` is a shared, unprefixed var (`apps/stack/src/env.ts`'s
`isSharedKey`) so one setting marks a whole deployment a test site regardless of `NODE_ENV`.
**boxs.ca is a test site today**: `NODE_ENV=production` but `siteground:env` also sets
`LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true` (see "Flickr" above) — never remove that without first
confirming boxs.ca really is meant to go live for real, since it flips both the Flickr fake and
this rule at once.

**Running the walkthrough.** From your Mac, against a stack already confirmed to be a test site
(the script checks this itself and refuses otherwise):

```sh
scripts/siteground-website-walkthrough.sh https://boxs.ca
```

Signs in as the break-glass admin, creates a next carousel two minutes out with one slide, saves
and pins the primary emergency slide, turns the Live Feed on with test URLs, saves two resource
links (keeping whatever was already there), uploads a small in-script-generated PDF as a general
file, then turns Project Blue Bridge ON (typing the confirmation phrase and the IGRS
acknowledgement) and polls the public News API once a minute, up to 6 times, until the carousel
has switched over, the primary pin sorts first, the Live Feed URLs and `granville` all show up.
It then checks the public site shows the `TEST — ` banner and stays noindex, and fetches the
uploaded file back from `/files`. Its cleanup trap turns Project Blue Bridge back off and unpins
the primary slide on the way out — on success and on failure alike — so a run that fails partway
never leaves the banner showing or the pin up.

## Importing legacy NRMS data (Phase 3e)

`npm run nrms:import` reads legacy's SQL Server through `@gcpe/legacy-import` and writes NRMS's
and Core's databases directly — it does **not** go through the running NRMS service or the
stack. It needs its own environment: `DATABASE_URL` (NRMS's Postgres), `CORE_DATABASE_URL`
(Core's Postgres — legacy users are imported there, matched by email, as inactive Core users),
`LEGACY_SQL_SERVER`, `LEGACY_SQL_DATABASE` (default `Gcpe.Hub`), `LEGACY_SQL_USER`,
`LEGACY_SQL_PASSWORD`, `LEGACY_SQL_TRUST_CERT` (`true`/`false`). None of these are printed or
written anywhere by the tool itself; a missing required one fails fast naming only the variable,
never a value.

**Assumption to confirm before relying on this at cutover:** Site Tools' PostgreSQL only accepts
connections from `localhost` (see "Databases" above — the public hostname is rejected by
`pg_hba.conf`), so `DATABASE_URL`/`CORE_DATABASE_URL` can only be reached from a process running
*on* that SiteGround instance. The legacy SQL Server, on the other hand, almost certainly can't
be reached *from* SiteGround (it lives on the government network). That means the importer likely
can't run as a single process against boxs.ca's own databases the way the other `import:legacy`
CLIs do today — **it's expected to run from an operator's machine (on the government network, or
over a VPN) or from an OpenShift job, pointed at whichever Postgres actually ends up hosting the
target environment at cutover**, not necessarily SiteGround's. Confirm the real cutover target's
networking before scripting this into a deploy step.

**Prerequisites.** Import Core's reference data first (`npm --workspace @gcpe/core run
import:legacy` — ministries, sectors, themes, tags) — NRMS's release categories resolve against
those keys, and unresolved ones are dropped with a warning, not an error, so an incomplete Core
import silently loses data rather than failing loudly.

**Running it:**

```sh
DATABASE_URL=... CORE_DATABASE_URL=... LEGACY_SQL_SERVER=... LEGACY_SQL_USER=... LEGACY_SQL_PASSWORD=... \
  npm run nrms:import -- --report nrms-import.json
```

Runs migrations first (as the Core and News API importers do), then imports in order: Core
users, NRMS's own reference tables (page images, page types, media lists, government terms),
every release in every status (never publishing or notifying anyone — no `outbox_events` rows,
no `flickr_jobs` rows are ever written), then website data (carousel, slides, pins, Live Feed,
`granville`, resource links). `--force-website` re-imports the website bundle even if nothing
looks changed since the last import (normally a no-op re-run). Takes a whole-run advisory lock
(`pg_try_advisory_lock`) so two imports can never run against the same database at once; a second
one started while the first is running exits immediately with "another nrms:import is already
running" and touches nothing.

**Re-run behaviour is not the same for every stage.** Releases and website data are "NRMS
wins": a re-run skips (and reports) any release or Top/Feature slot edited in NRMS since the last
import, and the whole website bundle (carousel, pins, Live Feed, `granville`, resource links) is
skipped outright when anything there was touched since the last import (unless `--force-website`).
The reference tables (page images, media lists, government terms) are **"legacy wins"** instead:
every re-run overwrites them from legacy's current data regardless of any edit made to them
directly in NRMS in the meantime — there is no re-run-safety check on these tables at all. Don't
edit page images, media lists or government terms in NRMS while legacy imports are still running
on a schedule; those edits will be silently overwritten on the next run.

**Reading the report.** Every run writes `--report <path>` (default
`nrms-import-<UTC timestamp>.json`) plus a matching `.txt` beside it. For every table it lists
`legacy` (rows seen), `imported` (rows written or confirmed unchanged) and `skipped` (rows
deliberately not imported, each with a reason) — `legacy` always equals `imported + skipped`,
checked as the report's own `balanced` flag. A release edited in NRMS since the last import is
skipped and listed, not overwritten. `NewsReleaseHistory` rows (old published copies) are counted
under their own table and skipped with reason "frozen copies not imported (Q12)" — see
`docs/parity/open-questions.md` Q12; they are not yet imported as `release_publications` rows.
Exit code: `0` when the report balances, `2` when it doesn't (import still completed — check the
report), `1` on any error, including a stage failing partway through (a partial report is still
written) and the lock-contention case above.

**Cutover order**, once the report balances and every imported scheduled release is confirmed
correct:

1. Turn legacy's own publisher off (nothing may publish from both systems at once).
2. `npm run nrms:replay-to-news-api -- --confirm` — re-sends every already-published, live
   release to the News API as `release.updated` with `notify: false`, so the public site and the
   News API's own data agree with NRMS's copy before NRMS's publisher starts touching anything.
   NoD only reacts to `release.published` from `nrms` (`apps/nod/src/app.ts:32`), so this never
   emails a subscriber — pinned by a NoD test. Dry run (no `--confirm`) lists what it would send
   and changes nothing.
3. `npm run nrms:release-holds -- --confirm` — clears `on_hold` on every imported scheduled
   release (they import held, per spec §8's safety rule 2, so NRMS's publisher never fires on
   stale/incomplete data mid-import) and lets NRMS's own publisher take over scheduling. Dry run
   lists what's on hold, with past-due ones flagged "will publish immediately" since the
   publisher claims them on its very next tick, not before.

Both cutover commands default to a dry run and only act with `--confirm`, exactly like
`nrms:import`'s report-first approach — read the dry-run output before confirming either one.

## Troubleshooting

- **`/stack/errors`** (`GET`, bearer token with the `Core.Admin` role — the same admin token
  from the smoke test's step 2; optional `?limit=` query param, default 200, max 1000): returns
  captured `console.error` calls, newest last. This is the *only* way to see runtime errors —
  SiteGround's runtime environment is separate from the SSH user, so **runtime logs are not
  reachable over SSH**. The log is persisted to `<DATA_DIR>/logs/errors.jsonl` (the same
  DATA_DIR folder that already survives a redeploy), as a ring of the most recent 1000 entries,
  so it **survives the idle-kill-then-cold-start restart** that used to wipe it — before this,
  the log was held only in process memory and was nearly always empty by the time anyone
  checked it. Each entry also carries the `pid` and `startedAt` of the process that logged it,
  so entries from before and after a restart can be told apart in one combined list.
- **Build log** (the deploy pipeline itself, not the running app): over SSH,
  `.nodeapp/<build>/build_script.sh` is the script SiteGround generates and runs for a given
  build (verified by probe — see siteground-facts.md); `<build>` is a per-build identifier
  directory under `.nodeapp/`. `ls -t .nodeapp` (or similar) to find the most recent one if
  you're not sure which build corresponds to your last deploy. Check this when a deploy
  doesn't show up as live at all, or when `/stack/health` never responds — that's a
  build-pipeline failure (e.g. `npm install` itself failing, which would be unusual for an
  artifact with no dependencies — more likely a transient network issue on SiteGround's
  side), not a runtime one.
- **`node stack.js --check` fails, or `/stack/health` reports an app `false`**: the JSON names
  the app and tells you which `<PREFIX>_*` variables to check (e.g. `"[stack] NoD failed to
  start (its variables are NOD_*): ..."`, or `--check`'s own per-app `error` field). Re-run
  `npm run siteground:env` if you're not sure which values you pasted in.
- **A scheduled release never publishes / an email never arrives**: confirm the scheduler is
  actually calling `/stack/tick` (Site Tools → Devs → Cron Jobs' own run history, or
  cron-job.org's dashboard if you're on the fallback) and that it's getting `200`, not `401`
  (wrong/stale token in `~/.gcpe-tick-token`) or `202` (coalesced — a previous tick was still
  running; harmless, the next call will do the work).
- **A media file or translation upload fails, especially a large one**: NRMS itself allows up to
  25 MiB (`MAX_RELEASE_FILE_BYTES` in `apps/nrms/src/media/files.ts`), but SiteGround's nginx
  sits in front of it with its own upload size limit, which this stack doesn't control. An HTML
  `413` (not NRMS's own JSON error) means nginx refused the upload before it ever reached the
  app — check/raise nginx's limit (Site Tools → Devs, or ask SiteGround support) rather than
  NRMS's.

## Known limits

- **Phase 2 smoke releases need organizations before they can be republished.** The Phase 3
  migration copies Phase 2 releases into the new release model with the formal layout but no
  organizations line (Phase 2 had none). They stay live as they are, but saving a correction to
  one fails at republish until its document's organizations are filled in.

- **No live updates.** News API's SignalR hub is disabled (`UPDATES_HUB_ENABLED=false`) —
  SiteGround's proxy strips WebSocket upgrades. Clients poll instead of subscribing.
- **Background work lags by up to the scheduler's interval** (≤ 1 minute with SiteGround's own
  cron at its tightest setting; ≤ 5 minutes on the cron-job.org fallback's tested interval) —
  plus however long the process was idle-killed before the next tick or request woke it.
- **pgvector is off.** It's installed but the database user can't `CREATE EXTENSION`; nothing
  in this deployment depends on it.
- **Every dynamic response is `Cache-Control: no-store`** (the stack sets this by default,
  overriding anything an app sets itself) specifically because SiteGround's nginx caches any
  GET response that lacks cache headers *and ignores the query string* when deciding what
  counts as the "same" cached response. Only the static `/site/*` mount gets a real
  `Cache-Control: public, max-age=60` — on purpose, since it's genuinely static output.
- **The process is cold-started on the first request (or tick) after 30–60s idle.** Measured
  locally: a full cold start (all six apps, migrations already applied) completes in well
  under a second — but it's still a real request that pays for it, so don't be surprised by
  one slow request after a quiet period.
- **A general file replace can leave bytes and row out of sync if the commit fails right after
  the write.** `uploadFile`'s accepted residual (`apps/nrms/src/website/files.ts`): a brand-new
  upload cleans up after itself if anything later fails (no row ever existed, so the just-written
  bytes are simply deleted again), but a *replace* writes the new bytes inside the same
  transaction as the row update and doesn't try to undo that write if the commit itself then
  fails — the row can be left holding the old metadata while the real key already holds the new
  bytes. Rare, and not repaired automatically.
- **A static post page freezes the King's age until it's next re-rendered.** Project Blue
  Bridge's banner computes "the age of N" at render time from the DB clock
  (`apps/public-site/src/site-env.ts`'s `ageInBcYears`); a page nobody edits or that no
  `site.content.changed` event touches isn't re-rendered just because a birthday passed, so an
  old static page can show a stale age until something (a future edit, or a redeploy's self-heal)
  rebuilds it.
- **The public site's write queue assumes one process.** `enqueueSiteWrite`
  (`apps/public-site/src/rebuild.ts`) serialises rebuilds with an in-process promise chain, not a
  cross-process lock — correct for SiteGround's one Node.js process, but it would race if the
  public site were ever run as more than one process against the same `OUTPUT_DIR`.
