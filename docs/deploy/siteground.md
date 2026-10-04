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

This prompts for the domain, the six databases' user/password, SMTP details, the admin
username/password (hidden input — never echoed), and the subscriber manage/unsubscribe page
URL, and prints a block of `KEY=value` lines — generating every internal secret
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

## Staff sign-in (Phase 3)

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
"now", then polls `/nrms/api/releases/<id>` and `.../asset-status` once per cron tick (up to 5
minutes — background work only runs when something calls `/stack/tick`; see above) printing the
release's status, Flickr alert and asset state each time, and finally prints the public page
URL. It exits non-zero if the release never reaches the expected end state.

A second mode additionally drives the fake's outage switch, to exercise the up-to-2-minute grace
period, the alert, and the automatic correction once the photo becomes available again (C28 in
`docs/parity/changes-from-legacy.md`):

```sh
scripts/siteground-flickr-walkthrough.sh https://boxs.ca --outage
```

Only ever run either against a stack that is actually using the fake (no real `FLICKR_API_KEY`
set) — `--outage` calls a fake-only control endpoint and the photo id it uses only exists there.

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
   FLICKR_API_KEY=<key>
   FLICKR_API_SECRET=<secret>
   NRMS_FLICKR_ACCESS_TOKEN=<token printed above>
   NRMS_FLICKR_ACCESS_SECRET=<secret printed above>
   NRMS_FLICKR_ALERT_EMAILS=<comma-separated addresses>
   ```
   Setting `FLICKR_API_KEY` is what switches the stack off the fake and onto real Flickr for
   NRMS (Flickr settings are NRMS's alone — see `apps/stack/src/env.ts`).

**What the alert means.** If a release's photo can't be made public within 2 minutes of the
release actually going out, NRMS publishes the release anyway (keeping the photo link), raises
`flickrAlert` on it (shown in the staff app) and emails `NRMS_FLICKR_ALERT_EMAILS`. It keeps
retrying every 5 minutes for 24 hours; the moment the photo is confirmed public, the release is
automatically re-published with it and the alert clears. After 24 hours it stops retrying and
sends a final email — at that point the photo should be re-added or replaced by hand.

## Troubleshooting

- **`/stack/errors`** (`GET`, bearer token with the `Core.Admin` role — the same admin token
  from the smoke test's step 2): returns every `console.error` call captured in-process since
  the last cold start. This is the *only* way to see runtime errors — SiteGround's runtime
  environment is separate from the SSH user, so **runtime logs are not reachable over SSH**.
  An idle-killed-then-restarted process starts this log empty again; check it soon after
  reproducing a problem.
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
