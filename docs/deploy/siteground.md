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
  a cold start of all six apps completes in well under a second). A deploy takes effect only once
  the old process has idled out (about 60 s).
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

In Site Tools → Databases, create **seven PostgreSQL databases and one database user** with
access to all seven (the user can't create its own databases, so this is a one-time manual
step, not something any script here can do). Suggested names (matching
`scripts/siteground-env.ts`'s defaults): `gcpe_core`, `gcpe_nrms`, `gcpe_news_api`,
`gcpe_site`, `gcpe_nod`, `gcpe_distribution`, `gcpe_calendar`. Where Site Tools assigns a
generated name instead of letting you choose one (it did for the Calendar's database on boxs.ca),
use the name it shows: the stack only ever reads the name from the `*_DATABASE_URL` setting.
Host is always `localhost` — the public PostgreSQL hostname is rejected by `pg_hba.conf`.

**The Calendar's database can be added later: the stack runs without it until
`CALENDAR_DATABASE_URL` is set.** Until then it starts and runs normally without the Calendar,
and `/calendar` answers `503 {"error": "calendar not configured"}`. See "Corporate Calendar (Phase 5b)"
below for exactly what to do in Site Tools when you're ready to turn it on.

### 3. Mailbox / SMTP

Create a SiteGround mailbox (or point at an external relay) for outbound mail. For the first
deploy, set `DIST_MAIL_REDIRECT_TO` to a mailbox you control (see the env generator below) —
every message the stack would otherwise send goes there instead, regardless of the real
recipient, until you deliberately clear it. There is no safe way to "try it against real
recipients a little bit"; it's redirect-everything or send-to-real-recipients, nothing between.
While mail is redirected, each message keeps its intended recipient in an `X-Original-To` header
and a `[to: …]` prefix on its subject.

boxs.ca keeps every Distribution send setting at its default: `DIST_MAIL_RATE_PER_MINUTE`
(60/min), `DIST_MAIL_CONCURRENCY` (1), and both `DIST_MAIL_REPLY_TO` and NoD's own `NOD_REPLY_TO`
left unset. A test site has no reason to send fast, and never sets a Reply-To — every message it
sends is already redirected to `DIST_MAIL_REDIRECT_TO`, so a Reply-To pointed at a real
government mailbox would put real replies to test mail in front of it.

The other Distribution send settings: `DIST_MAIL_RATE_PER_MINUTE` has a minimum of 1 and no
"unlimited" value; `DIST_MAIL_CONCURRENCY` is capped by `DIST_SMTP_MAX_CONNECTIONS`;
`DIST_MESSAGE_ID_DOMAIN` defaults to `DIST_MAIL_FROM`'s own domain; `DIST_INTERNAL_DOMAINS`
(default `gov.bc.ca,leg.bc.ca`) lists the domains that get the +2 send priority. Production sets
`NOD_REPLY_TO=gcpe.news@gov.bc.ca`, legacy's own reply address, and keeps `DIST_MAIL_REPLY_TO`
unset: when set, it becomes the Reply-To of every NoD email that has none of its own (the digest,
emergency alerts and the subscription emails).

While mail is redirected, `DIST_MAIL_REDIRECT_SEND_CAP` (default 5) limits how many messages any
one Distribution batch may produce, so testing a release for a ministry with hundreds of
subscribers does not put hundreds of copies in the redirect inboxes. Within a batch only the
first 5 recipients are delivered (to the redirect inboxes, as usual); the rest are kept in the
delivery counts as failed with the reason "skipped: test-site send cap", and a log line names the
batch and how many went out. The cap is per batch, not per release: a release usually sends one
batch to its public subscribers and one to its media lists, so expect about 10 copies per release
(5 each), plus 5 for each digest that includes it. It has no effect at all when mail is not
redirected.

`npm run distribution:capacity` (Distribution's local throughput/cap measurement) is a developer
tool, **local only**: it refuses to run against any SMTP target other than localhost, only ever
addresses made-up `@example.test` recipients, and never reads `.env`. It is never run against
boxs.ca or any other deployed environment.

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

`npm run siteground:env` leaves `CALENDAR_DATABASE_URL` out of the generated block when you
answer the Calendar database name prompt blank (the non-interactive `SITEGROUND_DB_NAME_CALENDAR`
likewise defaults to blank) — that's correct for boxs.ca today, since `gcpe_calendar` doesn't
exist yet. Re-run it (or add the one line by hand) once "Corporate Calendar (Phase 5b)" below is done.

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

NRMS calls the News API the same way, for "Similar published releases" (addendum §7) — under
`NRMS_NEWS_API_TOKEN_URL`/`NRMS_NEWS_API_CLIENT_ID`/`NRMS_NEWS_API_CLIENT_SECRET`/
`NRMS_NEWS_API_SCOPE` (that Entra app registration needs the News API's `NewsApi.Similar` app
role). `NRMS_NEWS_API_URL` itself already defaults to this stack's own in-process `self:/`, so
it needs no setting of its own; only the four credential vars are missing when Entra is
configured for NoD, Distribution and Core but not for this. All four or none, with the same
local-token fallback as `NOD_*`/`DISTRIBUTION_*` above: turning local admin off without setting
this set too leaves NRMS unable to authenticate that call, and the "Similar published releases"
panel 503s.

NoD calls Distribution the same way, under its own `NOD_DISTRIBUTION_TOKEN_URL`/
`NOD_DISTRIBUTION_CLIENT_ID`/`NOD_DISTRIBUTION_CLIENT_SECRET`/`NOD_DISTRIBUTION_SCOPE` (the
stack's `NOD_` prefix on the same four `DISTRIBUTION_*` names NoD reads). **That Entra app
registration must be granted both app roles on Distribution — `Distribution.Send` and
`Distribution.Operate`** — not `Distribution.Send` alone: NoD uses the same token both to forward
send jobs and to control Distribution's pause switch (`POST /distribution/api/settings/pause` and
`/resume`), and a registration with only `Distribution.Send` will send mail fine but get a 403
the moment staff try to pause or resume Distribution from NoD's admin in production. (Locally and
on boxs.ca, with `LOCAL_ADMIN_ENABLED=true`, the locally minted token already carries both roles
— see `apps/nod/src/distribution-token.ts` — so this only bites once Entra is configured.)

**`NOD_EMERGENCY_FEED_URL` must be the feed's final URL — no redirect.** The ingester fetches it
with `redirect: "error"` and fails the check closed rather than follow one (so an attacker who
could redirect that URL elsewhere can't get the ingester to read it instead). EMCR's real feed,
`https://emergencyinfobc.gov.bc.ca/category/alerts/feed/?hide_expired=true`, 301s to the `www.`
host (confirmed with a single `HEAD` request on 2026-10-07) — configure
`NOD_EMERGENCY_FEED_URL` as `https://www.emergencyinfobc.gov.bc.ca/category/alerts/feed/?hide_expired=true`
instead, or every check fails with `error: "redirect"`.

**News On Demand settings** (all optional):

- `NOD_SUBSCRIBE_PAGE_URL`: where subscription emails link (default: the public site's
  `/subscribe/manage/`). The links last 24 hours. An address gets at most 3 confirmation or manage
  emails an hour; more requests are quietly ignored.
- `NOD_BANNER_URL` (`BANNER_URL` in NoD's own settings; the stack strips the `NOD_` prefix): the
  banner image on every NoD email (As-It-Happens, emergency, digest, and the manage and verify
  emails). Unset, they show a plain blue "Government of B.C." heading instead.
- `NOD_OPS_EMAIL`: where pausing and resuming NoD sending and Distribution is emailed. Pause holds
  every send; nothing is dropped. Pause and resume are logged either way.
- `NOD_MEDIA_HUB_*`: unset means the stack's own fake Media Hub (made-up contacts), except on real
  production, where unset means no Media Hub at all: search, add-from-hub and the sync answer 503.
  Typing a media member's address by hand works either way.
- `NOD_MEMBERSHIP_API_USERNAME` and `NOD_MEMBERSHIP_API_PASSWORD_HASH`: the login for the legacy
  Membership tab's lookup (`Subscribe/SubscriberInformation`). The password setting is the hash
  that `npm run nod:membership-hash` prints, never a plain password. If either is unset, the
  lookup always answers 503.
- Bounces: Distribution's `DIST_BOUNCE_SOURCE` is `fake` on every test site, boxs.ca included
  (`graph` is built but not run live until Q23 is answered). In `graph` mode Distribution also needs
  all four of `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` and `BOUNCE_MAILBOX`
  (`DIST_`-prefixed on the stack), or it refuses to start. NoD's `NOD_BOUNCE_SUMMARY_EMAIL` unset
  means the daily bounce summary is never sent. Production sets `NOD_DISTRIBUTION_APP_ID`
  explicitly to NoD's own Entra client id rather than relying on its default.

A fresh NoD has no lists until Core's reference data reaches it: when NoD has no ministry lists,
the stack asks Core to republish once at startup. The daily digest runs from the tick at 17:00 BC
time; a missed tick catches up on the next one, in one digest.

**The public site is served at the root** (`https://<domain>/`), so news.gov.bc.ca's
root-relative URLs (`/releases/<key>`, `/ministries/…`) work unchanged. The generated
`SITE_PUBLIC_SITE_URL` and `NOD_PUBLIC_SITE_URL` are the bare origin (`https://<domain>`, no
`/site`). With that setting, any `/site/<rest>?<query>` URL (an old bookmark, or a link in an
email already sent) answers `301` to `/<rest>?<query>`, with the query unchanged.

**Upgrading an existing install** (boxs.ca, or any env generated before the root mount): the
old `…/site` values keep working — the site answers at both `/site/…` and `/…`, with no
redirect — until you change them. To move to the root, set `SITE_PUBLIC_SITE_URL` and
`NOD_PUBLIC_SITE_URL` to the origin (`https://boxs.ca`) in Site Tools → Environment Variables
and restart the Node.js app. The site-state marker records the base URL, so the change queues
one rebuild-all, which the next ticks drain; `/site/…` then 301s to `/…`. Check with
`curl -sI https://<domain>/site/ministries/` (expect `301`, `location: /ministries/`).

**`TRUST_PROXY_HOPS`** (optional, a whole number 1 to 5, default `1`). How many reverse proxies sit
in front of the stack and add to `X-Forwarded-For`. Every app, and the stack itself, uses it to
find the visitor's address (`req.ip`), which the logs and the per-IP limits (login, subscribe,
search, the live-updates connection cap) rely on. `1` is right for SiteGround's nginx, the
OpenShift router and a single IIS in front of the stack, so leave it unset there. Set `2` on the
Windows servers when a DMZ reverse proxy sits in front of the app server's IIS (see
`docs/deploy/windows.md`; the installer's `-ProxyHops 2` writes it). A value that is not a whole
number from 1 to 5 (empty means the default) stops the stack from starting. With `2`, the internal IIS must accept connections only from the DMZ proxy (firewall or IIS IP restriction); otherwise a client that reaches it directly picks its own address. Set too low, every visitor looks like the
proxy; set too high, a visitor can choose their own address by sending `X-Forwarded-For`. An app
run on its own (not under the stack) reads the same variable, unprefixed, and defaults to `1`.

**Compression.** The stack compresses its own text responses (brotli, else gzip;
`apps/stack/src/compress.ts`). SiteGround's nginx passes an already-encoded response through
without encoding it again, so nothing changes for visitors; check with
`curl -sI -H 'Accept-Encoding: br' https://<domain>/assets/legacy/Content/legacy.bundle.css`
(expect a single `content-encoding: br` and `vary: Accept-Encoding`).

**A release that changes the page chrome** (`RENDER_CHROME_VERSION`) queues one rebuild-all on
its first start. Until the ticks rewrite a page, it keeps its old markup under the new
`theme.css`, so its header and footer can look unstyled for a few minutes on boxs.ca (about 73
pages). **If pages stop publishing**, check `/hub/error-log` for a failed site sync step
(`[stack] tick step failed`, caused by the News API's ministries call): each
sync turn reads the ministries for the header's menu, and a failure retries the whole turn on the
next tick rather than publish a page with an empty News menu.

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
- `calendar-files/` — the Calendar's attachments (`CALENDAR_STORAGE_DIR`, overridable, and — same
  rule as `SITE_OUTPUT_DIR` — a relative override resolves under `DATA_DIR`, not the working
  directory). Never served directly: the Calendar's own route checks who may see each file. The
  stack refuses to start if this folder is inside, equal to or holds `storage/`, `site-output/` or
  the staff-web build.

The stack checks `DATA_DIR` is writable (creating it if needed) **before** starting any app and
refuses to start at all if it isn't — a misconfigured or unwritable `DATA_DIR` fails loudly at
startup instead of surfacing later as a silent write failure. An explicit `CALENDAR_STORAGE_DIR`
gets the same writability check (the default, under `DATA_DIR`, is already covered by the check
above); an unwritable folder is refused at startup instead of surfacing as a 500 on someone's
first upload.

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
   `<PREFIX>_*` prefix is misconfigured. With the Calendar configured, it also prints
   `"calendarDbTimeZone"`: `"ok"`, or `"stale"` when the Calendar database's Postgres predates
   tzdata 2026b (BC's permanent UTC−7), or `"unreachable"`. It is a warning and never fails the
   check.
5. **Hand check, after the first request has started the stack:** look in
   `<DATA_DIR>/logs/errors.jsonl` (or `/hub/error-log`) for "the Calendar database's time-zone
   data predates BC's permanent UTC−7". The stack checks this once at startup. If the line is
   there, the Calendar's list, export and reports put an activity between midnight and 1 a.m.
   (from 2026-11-01) on the previous day: ask the host for a PostgreSQL with tzdata 2026b or
   later (open question Q64). "the Calendar database's time-zone check failed" means the check
   couldn't ask; the label after it says why.
6. Run the smoke test below.

### Migrations on populated `deliveries` or `messages` tables

Drizzle runs every migration inside one transaction, so a `CREATE INDEX` on a large, populated
`deliveries` (NoD) or `messages` (Distribution) table blocks writes while it builds — about 8 s
at legacy volume, measured locally. Where that matters, either run migrations before the table
holds data, or pre-build the indexes `CONCURRENTLY` with drizzle's exact index names and then
record the migrations as applied, so the deploy's own migrate skips them:

1. **Only for pending migrations that are nothing but `CREATE INDEX` statements** (NoD `0023`,
   `0024`, `0027`, `0029`, `0032`; Distribution `0010`). `0029_purge_indexes` indexes `job_recipients` and
   `subscriber_links`, which grow by tens of thousands of rows a day, so it belongs here too.
   `0026_emergency_feed_state` and `0028_retention_purge` (columns and a new table),
   `0030_legacy_import` (a new table) and `0031_items_link_identity` (a column; the emergency feed
   check fills it in for existing alerts on its next run) are not index-only — they run in the
   normal deploy, same as any other additive migration. Any other statement would have to be run by hand, so for those
   use a quiet window instead. Drizzle's migrator applies every migration newer than the
   *latest* row it has recorded, so pre-build and record **every** pending migration, in journal
   order — recording a later one alone would make it skip the earlier ones forever.
2. Over SSH, from the new release's folder (the deployed artifact keeps migrations under
   `migrations/<app>`, not `apps/<app>/migrations`), before the app next starts. On SiteGround
   the push *is* the deploy, so stop the Node app in Site Tools before pushing and start it again
   after step 3; if it starts first, startup fails with "already exists" until the rows are
   recorded (loud, and fixed by finishing these steps). Example for NoD; for Distribution use
   `DIR=migrations/distribution`, `DB="$DIST_DATABASE_URL"` and `TAGS="0010_report_indexes"`:

   ```sh
   export DB="$NOD_DATABASE_URL" DIR=migrations/nod TAGS="0023_report_history_index 0024_report_delivery_indexes 0027_items_emergency_url_index 0029_purge_indexes 0032_items_link_identity_index"
   # Pre-build each index without blocking writes. psql runs each statement on its own, outside
   # a transaction, which CONCURRENTLY requires.
   for tag in $TAGS; do
     sed -e 's/--> statement-breakpoint/\n/g' -e 's/^CREATE INDEX "/CREATE INDEX CONCURRENTLY IF NOT EXISTS "/' "$DIR/$tag.sql" \
       | psql "$DB" -v ON_ERROR_STOP=1
   done
   # A failed concurrent build leaves an INVALID index behind: this must print 0. If it doesn't,
   # DROP INDEX CONCURRENTLY the index it names and run the loop above again.
   psql "$DB" -Atc "SELECT count(*) FROM pg_index WHERE NOT indisvalid"
   # Record each migration exactly as drizzle would: the SHA-256 of its file, and its journal time.
   for tag in $TAGS; do
     row=$(node -e "const f = require('fs'), d = process.argv[1], t = process.argv[2];
       const when = JSON.parse(f.readFileSync(d + '/meta/_journal.json', 'utf8')).entries.find((e) => e.tag === t).when;
       const hash = require('crypto').createHash('sha256').update(f.readFileSync(d + '/' + t + '.sql').toString()).digest('hex');
       console.log(\`'\${hash}', \${when}\`)" "$DIR" "$tag")
     psql "$DB" -v ON_ERROR_STOP=1 -c "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($row)"
   done
   ```

3. Restart the app. Its migrate finds nothing newer than the last recorded row and does nothing.
   (Rehearsed locally: a database migrated through `0022`, the steps above, then the real
   migrator — no error, and the recorded hashes match drizzle's own.)

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
- A fresh NRMS database comes with the default page types (News Release, Information Bulletin,
  Statement, Backgrounder, Traffic Advisory). Without them no release can be created.
- After deploying Phase 4c (or on any fresh NoD database, including the first tick after a
  legacy NRMS import run from the CLI — which has no `EVENT_SUBSCRIBERS` to carry the lists
  over as it runs), run NRMS's own media-lists republish once, signed in as `Core.Admin`, so NoD
  gets every legacy-imported media list: `POST /nrms/api/media-lists/republish` (then tick, or
  wait for the cron job, to deliver the events).
  `scripts/siteground-media-lists.sh https://<domain>` does this, waits for NoD to mirror the
  lists, and checks NoD's media contact count for one of them (it prompts for the break-glass
  admin password).
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
curl -s https://<domain>/releases/<key>/

# 7. Check the redirected mailbox (DIST_MAIL_REDIRECT_TO) for the notification email.
```

If steps 1–6 all succeed and the email in step 7 arrives, the deploy is good end to end:
database connectivity, auth, publishing, event dispatch, static rebuild, and mail delivery.

## Staff app (Phase 3)

The staff app (apps/staff-web) is served at **`https://boxs.ca/hub/`** — `apps/stack/src/stack.ts` mounts the built bundle there (`STAFF_WEB_DIR`; `apps/stack/src/env.ts`'s default is `./hub`, next to the running stack, when that directory exists — which is what the deployed SiteGround bundle (`scripts/build-siteground.mjs`) lays down — falling back to `apps/staff-web/dist` otherwise, i.e. in dev) ahead of the News API's own catch-all. A deep link (e.g. `https://boxs.ca/hub/releases/<id>`) and a plain browser refresh on one both work (the `/hub` route serves `index.html` for anything under it, with `Cache-Control: no-store` on the shell itself and a year-long immutable cache on its hashed `/hub/assets/*`). `scripts/build-siteground.mjs` builds and bundles it into the artifact automatically — there is no separate staff-app deploy step. The same build writes one Word file per staff manual (`hub/manuals/<manual id>.docx`, 11 files, served at `/hub/manuals/<manual id>.docx` for the "Download as Word" link in Help); the stack serves that folder next to `assets/`, so a package that copies only `assets/` would lose them. The OpenShift image and the Windows package copy the whole artifact, so they carry the files too, and nothing is added to the runtime image (`docx` is a build-time dependency only).

**Who sees what.** The same `gcpe_session` cookie and roles gate every screen (constraints.md: "roles decide what's shown, but the server is the authority" — hiding a nav item or button is a convenience, never the actual enforcement):

| Role | Sees |
|---|---|
| `NRMS.Viewer` | Releases (Drafts/Scheduled/Published), Search — read-only everywhere; no Approve/Publish/Delete/etc., no Website, Users or Error log. |
| `NRMS.Editor` | Everything a Viewer sees, plus "New release" and every write action in the release editor (Approve, Schedule/Publish now, Cancel, Unpublish, Delete, documents, categories, media asset, page details, Top/Feature). No Website, Users or Error log. |
| `NRMS.SiteEditor` | Releases/Search read-only (same as Viewer, unless also an Editor) plus the whole Website section — carousel, emergency pins, Live Feed, resource links, files, "what's featured where", the website log. Sees Project Blue Bridge's current state and warning text but not its switch. No Users or Error log. |
| `Core.Admin` | Users (create/deactivate staff, set roles and passwords) and the Error log, plus Project Blue Bridge's switch (needs the typed confirmation phrase and the IGRS checkbox) and read access to the Website section. The environment break-glass `admin` account carries this role (see below). |

**Reporting a problem.** A Core.Admin signs in and opens `/hub/error-log` (`GET /stack/errors`, newest first) — entries are written to `<DATA_DIR>/logs/errors.jsonl` and survive a SiteGround idle-kill restart (unlike the in-memory log a Phase 2 deployment would have lost — see "Troubleshooting" below), so what happened before the last restart is still there to read. Values inside a logged error message are redacted before they're stored.

**Hand-check list.** The items below are automated against the whole stack running locally (`npm run test:e2e`, Phase 3's acceptance list, `docs/superpowers/specs/2026-10-03-nrms-parity-design.md` §9) but are also marked `*` there for a hand check on boxs.ca itself, since production Flickr, real SMTP delivery and the real SiteGround cron cadence can't be faked:

- [ ] **Item 1** — sign in as the test editor (`scripts/siteground-seed-users.sh` creates/resets the five test users); confirm a viewer can read a release but has no write controls, and a site editor reaches the Website section but never sees Approve.
- [ ] **Item 2** — create one of each type (Release, Story, Factsheet, Advisory) through `/hub/releases/new`; confirm the form's required/allowed fields match the type (e.g. an Advisory offers no Sectors/Themes/Tags).
- [ ] **Item 5** — approve and publish a release now; confirm it reaches the public site (`https://boxs.ca/releases/<key>/`) and a subscriber actually receives the NoD email, within one scheduled `/stack/tick` run (see "Background work scheduler" above).
- [ ] **Item 7** — edit a field on an already-published release; confirm it shows "Republishing…" and comes back as "Published" with a new entry in its History ("Show all") and an extra frozen copy.
- [ ] **Item 9** — with a real `NRMS_FLICKR_API_KEY` configured, run `scripts/siteground-flickr-walkthrough.sh https://boxs.ca --outage` (see "Flickr" below) and confirm the release goes out on time without the photo, the alert shows, and the photo appears once recovered.
- [ ] **Item 12** — schedule a carousel go-live a minute or two out and confirm it switches over on its own; confirm an emergency pin survives an unrelated carousel change; confirm Project Blue Bridge needs the Core.Admin phrase and (off production) shows "TEST —" on the public banner.
- [ ] **Phase 4 item 1** — on `https://boxs.ca/subscribe/`, subscribe an address you control (it arrives at the redirect addresses with a `[to: …]` prefix); open the link, change a preference, save; unsubscribe from the manage page. The footer manage link and one-click unsubscribe now work against the new manage page (fixed in 4b — see Phase 4 item 3 below).
- [ ] **Phase 4 item 3** — publish a release that reaches your test address; confirm the As-It-Happens email arrives exactly once, and that both its footer manage link and its one-click unsubscribe (`List-Unsubscribe`) work.
- [ ] **Phase 4 item 4** — after a publish, check the following evening that the 17:00 BC-time digest arrives and includes the item. Note: releases published before the 4b deploy have no NoD item, so the first digest after deploy only includes releases published after it.
- [ ] **Phase 4 item 10** — pause NoD sending; confirm nothing goes out while paused; resume; confirm sends release again. Also pause **Distribution** itself (same NoD admin control); confirm a verification/manage-link email still goes out while Distribution is paused, that a release's As-It-Happens/digest mail is held, and that it sends once Distribution is resumed.
- [ ] **Phase 4c item 6** — create a media list, add yourself as a member (`POST /nod/api/media-lists/<key>/members`), publish a release with that media list chosen; confirm the full-text media email arrives, with the standard footer and a working one-click unsubscribe.
- [ ] **Phase 4c item 7** — add a member from the Media Hub search (real or fake), change that contact's chosen email address, run the sync (`POST /nod/api/media-hub/sync`); confirm the member's address updates. Delete the contact and sync again; confirm the member is gone. On a fake-Media-Hub site, change or delete a contact with a Core.Admin bearer: `POST /fake-media-hub/__fake/contacts/:id/email { ref, address }` to change one of its emails, or `POST /fake-media-hub/__fake/contacts/:id/delete` to soft-delete the contact.
- [ ] **Phase 4c item 8** — with `NOD_MEMBERSHIP_API_USERNAME`/`NOD_MEMBERSHIP_API_PASSWORD_HASH` set, curl the legacy membership endpoint directly:
  ```sh
  curl -u '<username>:<password>' 'https://boxs.ca/nod/Subscribe/SubscriberInformation?emailAddress=<member email>'
  ```
  confirm it 200s with `SubscribedCategories["media-distribution-lists"]` listing the member's lists, and that a wrong password 401s with a `WWW-Authenticate` header.
- [ ] **Phase 4e item 9** — bounces end to end. boxs.ca always runs `BOUNCE_SOURCE=fake` (the
  Graph source isn't run live until Q23 is answered), so a bounce is hand-fed through the fake
  inbox rather than actually failing an SMTP send:
  1. Subscribe and confirm an address you control, then publish a release that reaches it; note
     the `Message-ID` header on the email it receives (view source, or check the redirect
     mailbox's own headers).
  2. Build a `.eml` with a `550 5.1.1` RFC 3464 delivery-status report carrying that
     `Message-ID` (see `apps/distribution/test/fixtures/bounces/gmail-dsn.eml` for the shape),
     then upload it as the admin:
     ```sh
     curl -X POST https://boxs.ca/nod/api/bounces/inbox \
       -H "authorization: Bearer <admin access_token>" -H 'content-type: application/json' \
       --data-binary @- <<'EOF'
     {"raw": "<the .eml's full text, with embedded newlines escaped>"}
     EOF
     ```
  3. Within 15 minutes (or sooner, once the scheduler ticks), confirm the subscriber shows a
     hard bounce. The 10-in-15-days rule counts *emails* (one release send), not uploads — each
     of the nine remaining repeats needs its own new release reaching the address, each with its
     own fresh `Message-ID` in a fresh `.eml`; re-uploading the exact same `.eml` again only
     re-confirms the same one email and counts once by design, never advancing the count.
     Repeat with nine genuinely new sends within 15 days and confirm the tenth disables them (no
     further mail reaches them, and the membership endpoint still lists them). Re-subscribing
     the same address (verify → confirm) reactivates them.
  4. The next day at 08:00 BC time, confirm `BOUNCE_SUMMARY_EMAIL` received exactly one
     "News On Demand - Bounce Manager - <date>" email listing the address as disabled.
- [ ] **Phase 4f item 14** — sign in as `nod-viewer`, `nod-editor` and the admin in turn and confirm
  what each sees on Subscribers: the Viewer finds and reads subscribers but has no Save
  preferences/Delete/Change email/status controls and no bulk actions; the Editor has all of
  those plus Add a subscriber; the Admin sees the same controls as the Editor. Confirm an
  NRMS-only user (the test editor or site editor) never sees the Subscribers link at all.
- [ ] **Phase 4g items 10 and 14** — Lists & categories, Media lists and Operations on boxs.ca:
  1. As the admin, open Subscribers → Operations.
  2. Confirm the Test bounce upload panel shows on boxs.ca (it only does while Distribution
     reports `source: "fake"`).
  3. Pause and resume News On Demand sending, and confirm the ops email arrives at the redirect
     address each time.
  4. As `nod-editor`, open a media list and add and remove a member from the fake Media Hub.
- [ ] **Phase 4h (reports)** — Subscribers → Reports on boxs.ca:
  1. As `nod-viewer`, open each of the five reports under Subscribers → Reports and confirm each
     loads.
  2. Download Sends per release and confirm it opens in Excel with accents intact.
  3. Confirm the address-CSV links (a list's members, Recent unsubscribes' address list) are
     absent for `nod-viewer`.
  4. As `nod-editor`, download Active subscribers by list → everyone. The operations log has no
     screen, so confirm the export was recorded over SSH with psql:
     `psql "$NOD_DATABASE_URL" -c "SELECT at, actor, action, detail FROM operations_log WHERE action = 'report-exported' ORDER BY at DESC LIMIT 5"`
     — the newest row's actor is the editor's display name and its detail is `subscribers all any`
     (report and list key, never an address).

Staff sign in at `POST /core/auth/login` and receive one `gcpe_session` cookie that every app's API accepts. Its signing key is derived from `STACK_EVENT_SECRET`, so there is nothing new to add in Site Tools. (Setting `SESSION_SECRET` explicitly overrides the derived one; changing either signs everyone out.)

The break-glass `admin` account signs in through the same endpoint. To create or reset the five test users (`editor@example.test`, `site-editor@example.test`, `viewer@example.test`, `nod-viewer@example.test`, `nod-editor@example.test`), run from your Mac:

    scripts/siteground-seed-users.sh https://boxs.ca

It asks for the admin password and a password for each test user (12+ characters, input hidden).

The break-glass `admin` has no email address, so "Email me a copy" is disabled for it. Test email
with a real staff account.

**Revoking access.** A session renews (and its roles refresh) while the user stays active; changing a password or logging out does not end a user's *other* sessions. To cut someone off, deactivate the user — that takes effect at once in Core, and within the cookie's remaining life (at most 1 hour) in other apps. To end every session at once, including break-glass, rotate `SESSION_SECRET` (or `STACK_EVENT_SECRET`, which also re-derives the event secrets).

## Staff sign-in with Microsoft Entra

Staff can sign in with their government Microsoft account. It is **off** unless configured: boxs.ca sets none of these settings and keeps password sign-in exactly as before (`npm run siteground:env` never generates them).

**Entra app registration** (for the Entra administrator):

- Platform: **Web**. Redirect URI, exactly: **`https://boxs.ca/core/auth/entra/callback`** on boxs.ca; elsewhere `<CORE_PUBLIC_BASE_URL>/core/auth/entra/callback`, for example `https://news.example.gov.bc.ca/core/auth/entra/callback`.
- Supported account types: this organization only (single tenant).
- A client secret.
- Delegated permissions `openid`, `profile` and `email` (Microsoft Graph). No app roles or groups: roles stay in Core.
- No front-channel logout URL: signing out of the staff app doesn't sign anyone out of Microsoft.

**Settings:**

| Setting | Value |
|---|---|
| `ENTRA_TENANT_ID` | The tenant id (shared by every app). |
| `CORE_ENTRA_CLIENT_ID` | The app registration's client id. |
| `CORE_ENTRA_CLIENT_SECRET` | Its client secret. |
| `CORE_PUBLIC_BASE_URL` | The site's origin, e.g. `https://boxs.ca`: https, no path. The redirect URI is this plus `/core/auth/entra/callback`. |
| `CORE_LOCAL_PASSWORDS_ALLOWED` | Optional, and only matters in **real** production: a deployment with `NODE_ENV=production` that is *not* also a test site under the same rule `LOCAL_ADMIN_ALLOW_IN_PRODUCTION`/`SITE_ENVIRONMENT=test` use (boxs.ca is a test site, so it's unaffected either way). There, with Entra on, user passwords are refused unless this is `true`. The break-glass admin isn't affected. |

Entra sign-in is on when `CORE_ENTRA_CLIENT_ID`, `CORE_ENTRA_CLIENT_SECRET` or `CORE_PUBLIC_BASE_URL` is set. Setting only some of them fails at startup and in `node stack.js --check`, naming what's missing. `SESSION_SECRET` is needed too; on the stack it is derived from `STACK_EVENT_SECRET`.

**Setting `ENTRA_TENANT_ID` on the stack also turns on Entra token checks in every app**, so each app then needs its `<PREFIX>_AUTH_AUDIENCE` (`CORE_`, `NRMS_`, `NEWSAPI_`, `SITE_`, `NOD_`, `DIST_`, and `CALENDAR_` when the Calendar runs), or the site won't start. `--check` names any that are missing.

**Who can sign in.** Only people who already have an active Core user with the same address: matching tries the token's `preferred_username` (the person's Microsoft sign-in name, usually their government email) first, falling back to its `email` claim only when `preferred_username` is absent — so create the Core user with the sign-in name. The first sign-in links the user to their Microsoft account (Users shows "Sign-in: Microsoft (Entra)"), and their password stops working. "Unlink Microsoft sign-in" on the Users screen undoes that. Anyone else sees "Your account hasn't been set up. Contact an administrator."

**`returnTo`.** Core's own check (`apps/core/src/entra/return-to.ts`) is deliberately stricter than staff-web's `safeReturnTo.ts`: it scopes the path to `/hub/`, resolves `.`/`..` segments before checking, and refuses control characters, on top of staff-web's own same-origin check. This is intentional, not drift — a sign-in link is a more sensitive redirect target than an in-app navigation.

**Troubleshooting.** Staff must start sign-in on the `CORE_PUBLIC_BASE_URL` host: a sign-in started on another host (say `www.` when the setting has none) can't read its state cookie at the callback and ends with "Your sign-in took too long". Refusals are logged as `[core] entra sign-in refused route=… code=… user=…`, with no names, emails or tokens. `code=failed` and `code=conflict` also go to the error log (`/hub/error-log`); `failed` carries an `error=` label such as `OAUTH_JWT_CLAIM_COMPARISON_FAILED` or `wrong_tenant`.

**Fake Microsoft sign-in (test sites only).** `FAKE_ENTRA_ENABLED=true` plus `CORE_PUBLIC_BASE_URL` mounts a fake at `/fake-entra` and points Core at it. Its picker offers two made-up identities, `entra-staff@example.test` and `entra-unknown@example.test`; create a Core user with the first email to try a successful sign-in. **Anyone who can reach the site can then sign in as that user without a password**, so enable it only while testing and give that user no more roles than the test needs. The stack refuses it in real production and alongside any real Entra setting; on a test site such as boxs.ca, turning it on doesn't touch `CORE_LOCAL_PASSWORDS_ALLOWED` or anyone's existing password.

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

## Site settings

The public site's banner, footer, social links (the Connect page), theme colours and the section
headings on ministry pages are one published settings document that staff edit in the Hub — no
deploy needed. Every publish is kept in a history and can be restored. The design is in
`docs/superpowers/specs/2026-10-27-site-settings-design.md`; this section is what an operator
needs.

**Where, and who.** Hub → Website → **Banner**, **Footer**, **Social links**, **Theme**,
**Ministry pages** and **Settings history**. `NRMS.SiteEditor` edits; `Core.Admin` can read.
The routes are `/nrms/api/site/settings/*` (reads: `NRMS.SiteEditor` or `Core.Admin`; writes:
`NRMS.SiteEditor`).

**Drafts, publishing, conflicts, restore.** Each editor has one draft of the whole document: Save
draft keeps it (even with problems), Publish validates and makes it live as the next revision,
with an optional note. If someone else published since the editor started, nothing is published
and the draft is kept; the editor chooses to keep their section on top of the newer version or
discard theirs. Restore on Settings history publishes an old revision again as a new one (note
`Restored revision N`). Nothing is ever pruned.

**What a publish rebuilds.** NRMS emits `site.settings.published`; the News API keeps the newest
revision; the public site picks it up on its next sync turn, so changes show within a few minutes
(the tick is the backstop).

| Section | Effect on the public site |
|---|---|
| Theme | Regenerates `assets/theme.css` only; no page rebuild. |
| Banner | Rewrites `assets/site-banner.json` only. Every page's small script fetches it, so the schedule (show from / hide after) needs no rebuild. No banner without JavaScript. Hidden while the Project Blue Bridge banner shows. |
| Footer | Every page is rebuilt. The copyright year is part of the footer, so every January the whole site rebuilds once. |
| Social links | Only the `/connect/` page. |
| Ministry pages (headings) | Only the ministry pages. |

Rebuilds go through the normal rebuild queue (see "The rebuild queue" under the public site), so a
footer change reaches older pages over the following ticks, newest first.

**Defaults.** Until the first publish the site uses `config/tenants/<tenant>.site-settings.json`
when it exists, otherwise defaults built from the tenant's `site.theme`. `bc.site-settings.json`
carries news.gov.bc.ca's footer lists and social links with the banner **off**. The file must
validate against the settings schema; the Hub's Reset to defaults uses it too. NRMS answers the `/site/settings` routes with 503 if it has none.

**Resilience.** The public site keeps the last applied settings in `.site-settings.json`, beside
`.site-state.json`; both are dotfiles and are not served. If fetching settings from the News API
fails, the site keeps the last applied settings (logged as "site settings unavailable"); with
nothing applied yet it uses the defaults for that turn without recording them as applied. A
settings failure never holds back Project Blue Bridge or deploy-driven rebuilds.

**News API.** `GET /api/v2/site-settings` returns `{ revision, publishedAt, document }` for the
newest published revision, or 404 when nothing has been published. It is public and sent with
`Cache-Control: no-store`, like the other v2 routes.

**Organizations (Hub → Organizations).** Three additions that belong with this work:

- **Ministry page links.** The edit form has a "Ministry page links" group: ministry website,
  Photos (Flickr) and Videos (YouTube) addresses, and ordered Featured Topics and Featured
  Services lists (text and address). `NRMS.SiteEditor` and `Core.Admin` can edit them. They feed
  the side column on the public ministry page; the column's headings come from Ministry pages
  settings, and groups with nothing in them are left out.
- **Abbreviation.** A Core.Admin-only field on Add ministry and the edit form: 2 to 10 capital
  letters or digits (stored upper-case), unique across organizations. It is used in release
  numbers (for example `2026HLTH0001`); changing it only affects releases approved afterwards.
  A release whose lead ministry has no abbreviation cannot be approved.
- **Not public.** A "Not public" badge sits beside every non-public organization's name, for every
  role. Deactivating or reactivating never changes the Public flag, so after reactivating a
  non-public ministry the status says "It isn't public: tick Public to list it on the public site."

## Seeding boxs.ca with public news.gov posts

For parity checks on a test host, `import:public` copies a slice of **public** posts from the
legacy News API (`https://api.news.gov.bc.ca`, read-only, no credentials) into the News API's
database: by default the latest 20 releases, stories, factsheets and updates, plus the latest 3
posts of every ministry, sector, theme and tag the legacy API lists (74 requests on 2026-10-28,
about 185 posts), plus any `--keys`. It is polite by construction: one request at a time, at least
1 s apart, User-Agent `gcpe-boxs-test-import (contact Paul@mtheory.ca)`, one retry on a 5xx, and it
stops on a 429 before writing anything. It prints the request plan before the bulk of the
requests; `--max-requests <n>` (default 300) caps it by leaving categories out.

Posts are written through the legacy importer's own write path (`applyRelease`, `origin
'legacy'`, no PostUpdate NOTIFY), so they look exactly like legacy-imported posts, and each one
records a `post.upserted` row in the change feed: the public site rebuilds the post, home, archive
and category pages on its next `site.sync` poll (every `SYNC_INTERVAL_MS`, 30 s). It writes **no**
`outbox_events` row, so nothing reaches NRMS, NoD or distribution — no notification or email can
come of it (pinned by `apps/news-api/src/import/public.test.ts`). A key that already exists and
wasn't created by this tool (NRMS-published or legacy-imported) is skipped and counted, never
overwritten. Categories are never created: a post keeps the ministry/sector/theme/tag keys it has,
and the report lists those the database doesn't know (the site leaves them out). The keys it
created are listed in `public_import_posts` (migration `0011`), which `--remove` uses.

The News API database only accepts `localhost` connections, so run it on the server from the
deployed artifact, which carries the tool as `tools/news-api-import-public.mjs` (with its
migrations beside it). Paste the value of `NEWSAPI_DATABASE_URL` from Site Tools at the prompt
(it is read hidden, never put on a command line):

```sh
ssh boxs
TOOL=~/www/boxs.ca/public_html/.nodeapp/latest/app_source/tools/news-api-import-public.mjs   # `latest` is the live release
read -rs -p 'NEWSAPI_DATABASE_URL: ' DATABASE_URL && export DATABASE_URL && echo
/usr/local/bin/node-24 "$TOOL" --dry-run   # fetch, compare with the database, write nothing
/usr/local/bin/node-24 "$TOOL"             # import the slice
```

Options: `--per-kind <n>` (default 20), `--per-category <n>` (default 3; `0` skips categories),
`--keys k1,k2,...`, `--from <base>`, `--max-requests <n>`, `--files-base <url>`, `--refresh`,
`--dry-run`. A plain re-run refreshes only posts the source has changed since (by `timestamp`); the
rest are reported `unchanged`. `--refresh` rewrites every post this tool created even when the
timestamp is unchanged (still never one it didn't create) — use it after upgrading the tool, e.g.
`/usr/local/bin/node-24 "$TOOL" --refresh`. The source lists translations and media assets with
relative keys; the tool makes them absolute under `--files-base` (default
`https://bcgovnews-etg7c8etapa6btfr.z03.azurefd.net`) as `<base>/translations/<key>` and
`<base>/assets/<key>`, path segments percent-encoded; an already-absolute `https` key is kept and
anything else invalidates that post (reported under `invalid`, not written). The
report is JSON on stdout; exit code `1` on any failure, including a 429.

**Removing the slice:**

```sh
/usr/local/bin/node-24 "$TOOL" --remove --dry-run   # list what would go
/usr/local/bin/node-24 "$TOOL" --remove
```

This deletes every post the tool created, in one transaction with a `post.unpublished` change row
for each, so the site removes those pages and rebuilds the lists they were on. A key NRMS has
published since (origin `event`) is kept. Caveat: a later full `import:legacy` run rewrites
legacy-owned posts it also has, and those stay listed in `public_import_posts` — `--remove` would
then delete them too.

From a checkout (for a database you can reach directly), the same command is
`DATABASE_URL=... npm run news-api:import-public -- --dry-run`.

## Seeding boxs.ca with news.gov's carousel

`import:public-slides` copies news.gov's **current** home-page carousel into NRMS and publishes it,
for test hosts that never had the legacy SQL import. It makes **one** request (`GET
https://api.news.gov.bc.ca/api/Slides?api-version=1.0`, public, read-only, same User-Agent as
`import:public`); the list's order is the carousel's order. Each slide becomes an NRMS carousel
slide exactly like the Hub's (and the SQL importer's) — `headline`, `summary`, `actionUri` → action
URL, `actionLabel` → action label (empty when missing or over the Hub's 40-character plain-text
rule, so the site shows its default), `facebookPostUri` (empty when null), `justify` (`left` when
missing) and the image, stored on the slide and as `slides/<sha256>.<png|jpg>` in NRMS's file store.
A slide the Hub would refuse is reported under `refused` and left out, the rest imported: an image
that isn't strict base64, isn't a PNG or JPEG by its bytes, doesn't match its `imageType`
(`image/jpg` counts as `image/jpeg`), or is over the Hub's 2 MiB limit (base64 text longer than a
2 MiB image needs is refused before it is decoded); an action or Facebook URL that isn't http(s); a headline or summary
over 255 characters; a missing or duplicate key. An answer over 20 MB stops the run before anything
is written.

**How it publishes.** Carousels are `live` / `next` / `past` (no draft). The imported carousel goes
live through the Hub's own switch-over — what "Make live now" runs: the old live carousel becomes
`past`, one `site_log` line ("Imported news.gov's current carousel", by System) and one
`site.content.changed` (`site:slides`) snapshot in NRMS's outbox, which the running stack delivers
to the News API; the public home page rebuilds from it. Nothing else is emitted: no release event,
nothing to NoD or Distribution, no email (pinned by `apps/nrms/src/import/public-slides.test.ts`).
The one difference from the Hub: the switch-over doesn't trim past carousels to five (the next one
does), so `--remove` can always restore the carousel it replaced. A staff-scheduled `next`
carousel is left alone and reported; it still goes live at its time.

**Staff edits are protected.** If the live carousel has staff edits (a non-System `carousel` line
in the site log naming that carousel — anything made in the Hub counts; editing a scheduled next
carousel doesn't), the tool refuses, exits
`1`, and the report's `write.replaces` lists the carousel and slides it would replace and
`write.staffEdits` the edits; pass `--replace` to replace it anyway (`--remove` puts it back).
Carousel log lines name their carousel from migration `0021` on; an older line that doesn't still
counts, and the refusal then says "a carousel was edited in the Hub since…".
A carousel left by the SQL importer and never edited is replaced without asking.

**Re-runs.** Slides are matched by news.gov key (`public_import_slides`, migration `0020`): a re-run
against an unchanged source reports `unchanged` and writes nothing; a changed source updates the
imported carousel in place (slide ids kept) and emits one snapshot. If staff edited the imported
carousel since, a changed re-run refuses without `--replace`; if staff have since made another
carousel live, it refuses and says to `--remove` first.

Run it on the server from the deployed artifact, which carries the tool as
`tools/nrms-import-public-slides.mjs` (with NRMS's migrations beside it). Paste the value of
`NRMS_DATABASE_URL` from Site Tools at the prompt (read hidden, never put on a command line). The
tool writes the images where the running stack serves `/files` from: `NRMS_STORAGE_DIR` if set,
else `<DATA_DIR>/storage`, with `DATA_DIR` defaulting to `~/gcpe-data` — on boxs.ca
`~/gcpe-data/storage`, in the SSH user's home, the same home the stack runs under (it refuses to
run if that folder doesn't exist). If Site Tools
sets `DATA_DIR` or `NRMS_STORAGE_DIR`, export the same value first (only the stack's names count:
a bare `STORAGE_DIR` or `PUBLIC_FILES_BASE` is ignored, with a warning). Image URLs in the event
carry the public site's origin, as the stack's own `NRMS_PUBLIC_FILES_BASE` does: copy
`SITE_PUBLIC_SITE_URL` from Site Tools if it is set there; otherwise use `https://boxs.ca`. The
commands are bash (SiteGround's SSH shell):

```sh
ssh boxs
TOOL=~/www/boxs.ca/public_html/.nodeapp/latest/app_source/tools/nrms-import-public-slides.mjs   # `latest` is the live release
read -rs -p 'NRMS_DATABASE_URL: ' DATABASE_URL && export DATABASE_URL && echo
export SITE_PUBLIC_SITE_URL=https://boxs.ca   # or Site Tools' value, if set there
ls -d ~/gcpe-data/storage                     # NRMS's file store (served at /files)
/usr/local/bin/node-24 "$TOOL" --dry-run      # fetch once, compare with the database, write nothing
/usr/local/bin/node-24 "$TOOL"                # import and publish (refuses if staff edited the carousel)
/usr/local/bin/node-24 "$TOOL" --replace      # …replacing a staff-edited carousel (e.g. a test slide)
```

The report is JSON on stdout (`source` lists each slide with its image type, size and SHA-256,
plus `refused` and `warnings`; `write.action` is `create`, `update`, `unchanged` or `refused`);
diagnostics go to stderr; exit code `1` on any failure or refusal. Within a minute the outbox
delivers the snapshot and the home page shows the slides; check
`https://boxs.ca/api/Slides?api-version=1.0` lists them.

**Removing it:**

```sh
/usr/local/bin/node-24 "$TOOL" --remove --dry-run   # show what would be restored
/usr/local/bin/node-24 "$TOOL" --remove
```

This deletes the imported carousel and makes the carousel it replaced live again exactly as it
was (same slides, ids, version and timestamps), then emits the same snapshot the Hub would, so the
site shows what it showed before; with no carousel before the import, the site has none again. If
the carousel it replaced is gone (a later switch-over trimmed it), `--remove` refuses rather than
leave the site with no carousel; `--replace` removes it anyway. The restore is all or nothing: if
the old carousel can't be made live, nothing changes. If
staff edited the imported carousel since, `--remove` refuses without `--replace` (their edits go
with it). If staff have since made another carousel live, `--remove` only deletes the imported
(now past) one and leaves the live carousel alone. Image files stay in the store
(content-addressed, harmless, as the Hub leaves them).

From a checkout, the same command is `DATABASE_URL=... NRMS_STORAGE_DIR=... NRMS_PUBLIC_FILES_BASE=...
npm run nrms:import-public-slides -- --dry-run`. Outside the stack, an explicit `EVENT_SUBSCRIBERS`
(or `NRMS_EVENT_SUBSCRIBERS`) replaces the stack's own NRMS → News API route.

## Legacy translations and media assets (`import:files`, cutover)

The News API's legacy import (`import:legacy`, apps/news-api/src/import) copies posts from legacy
SQL, but a post's translation PDFs and media assets are not in SQL: they are files in legacy's
Azure blob storage, which stays up after cutover and serves them at
`https://bcgovnews-etg7c8etapa6btfr.z03.azurefd.net/translations/<key>` and `…/assets/<key>`.
`import:legacy` therefore leaves every post's `translations` and `assets` empty, and imported
releases would have no translation or media-asset links. `import:files` fills them in: for each
legacy-imported post it asks the public legacy API (`GET
https://api.news.gov.bc.ca/api/Posts/<key>`) for its `azureTranslations` / `azureAssets` and stores
them with absolute file URLs (the same conversion as `import:public`), plus `hasTranslations` /
`hasMediaAssets`.

**Which posts.** Published posts with origin `legacy` whose file lists are still empty, newest
first, and only those legacy flags as having translations (`NewsRelease.HasTranslations`) or
media assets (`HasMediaAssets`): news.gov shows a post's translations only when the first is set
and its media assets only when the second is, and the API lists them only then. In legacy's
`NewsRelease` table (the 2026 survey, all rows) 3,549 rows have `HasTranslations` and 990
`HasMediaAssets`, so a full run is at most 4,539 requests (an upper bound: those counts include
unpublished rows and count a post with both flags twice; `--dry-run` gives the real number and
hours): at most about 1.3 hours at `--concurrency 1`, 20 minutes at 4. `import:legacy` carries `HasTranslations` since this tool was
added; on a database imported before that, `import:files` refuses to run until `import:legacy`
has been run again (or pass `--all` to ask for every legacy post, about 35,000 requests: 10 hours
at 1, 2.5 at 4). A post NRMS has published (origin `event`) is never touched.

**Politeness.** At most `--concurrency` (1 to 4, default 1) requests in flight, each worker at
least 1 s between request starts, so never more than `--concurrency` requests a second, with
User-Agent `gcpe-cutover-files (contact Paul@mtheory.ca)`. One retry on a 5xx. A 404 (the post
is gone or unpublished there) is skipped and counted. A **429 stops the run**: nothing more is
sent, what was filled is kept, and the report's `resume` says what to do — wait, then run the same
command again; filled posts are skipped, so it carries on where it stopped (`--since` limits it
to recent posts).

**Writes.** One transaction per post under the same per-key lock as the importers' write path:
only the four file columns change, and a `post.upserted` change row is recorded, so the public
site rebuilds that release page on its next `site.sync`. Nothing else is written: no
`outbox_events` row (nothing reaches NRMS, NoD or distribution), no PostUpdate NOTIFY (pinned by
`apps/news-api/src/import/files.test.ts`). A post whose stored lists already match is not
written. A post the source lists no files for is stored with two empty lists (checked, nothing
there), so a plain re-run doesn't ask again. A re-run of `import:legacy` keeps the lists
`import:files` filled while legacy still sets the matching flag; a flag legacy clears clears its
list. The site shows a card's Translations / Media Assets link only when the flag is set and the
list has a file.

**Re-runs.** A plain run (no `--refresh`) asks only for flagged posts whose lists are still empty:
it never revisits a post it already filled, so a translation legacy adds later to such a post is
not picked up. For that, `--refresh --since <date>` asks again for every flagged post published
since `<date>`. At cutover: a plain run, then `--refresh --since <full-run date minus 30 days>`,
both before `api.news.gov.bc.ca` is repointed (the URL cutover runbook, section 3).

Run it on the server from the deployed artifact, which carries it as
`tools/news-api-import-files.mjs`:

```sh
ssh boxs
TOOL=~/www/boxs.ca/public_html/.nodeapp/latest/app_source/tools/news-api-import-files.mjs
read -rs -p 'NEWSAPI_DATABASE_URL: ' DATABASE_URL && export DATABASE_URL && echo
/usr/local/bin/node-24 "$TOOL" --dry-run                  # how many posts, how long; sends nothing
/usr/local/bin/node-24 "$TOOL" --concurrency 2            # the whole archive
/usr/local/bin/node-24 "$TOOL"                            # catch-up: flagged posts not filled yet
/usr/local/bin/node-24 "$TOOL" --refresh --since 2026-10-01   # ask again for recent posts
```

Options: `--concurrency <1..4>`, `--since <YYYY-MM-DD>` (publish date, Pacific), `--keys k1,k2,...`
(exactly those posts, flagged or not), `--all` (every legacy post, not only flagged ones),
`--refresh` (ask again for posts already filled; unchanged ones are not written), `--max-requests
<n>` (stop after n), `--from <base>` (default `https://api.news.gov.bc.ca`), `--files-base <url>`,
`--dry-run`. The report is JSON on stdout (`filled`, `unchanged`, `notFound`, `failed`,
`invalid`, `remaining`, `stopped`, `resume`); exit code `1` on a failure or a 429. From a
checkout: `DATABASE_URL=... npm run news-api:import-files -- --dry-run`. When to run it at cutover
is in [the URL cutover runbook](../parity/url-cutover-runbook.md), section 3.

## Legacy /files import (`legacy-files:copy`, cutover)

`https://news.gov.bc.ca/files/<name>` are the files staff uploaded in the legacy Hub's **Website >
Files** screen (legacy `News/FileManagement.aspx.cs`). The legacy Hub keeps them in the Azure blob
container `files`, one blob per file under its **lowercased** name, with blob metadata `filename`
holding the name as uploaded, and lists them newest first. news.gov serves them through legacy's
Azure front door (`https://bcgovnews-etg7c8etapa6btfr.z03.azurefd.net/files/<name>`, same bytes;
verified 2026-10-29), trying the lowercased name first. Release bodies link them (absolute,
relative, percent-encoded), and `/assets/license` redirects to
`/files/News_Footage_License_British_Columbia.pdf`.

Our equivalent is NRMS's site files: the Hub's **Website > Files** screen, served at
`/files/<name>`. `legacy-files:copy` imports the legacy files **as site files**, so after a run
they are in the Hub's Files list (dated with the legacy upload time, created by "Legacy import",
one site-log line each) and staff can open, delete or replace them like any upload. Uploading a
file with an imported file's name (any letter case) asks to replace it, and a replace keeps the
imported file's name and URL (`/files/Fact%20Sheet.pdf` stays), so legacy links keep working, as
long as the replacement has the same extension (an imported `.docx` is replaced by a `.docx`).

**Hub uploads: any type, up to 512 MB** (owner decision 2026-10-29, like the legacy Hub, whose
Files screen took any type with no practical size limit). Only site files: release translations
and media assets and carousel/pin images keep their own rules. The upload is streamed to
`<DATA_DIR>/storage` (never held in memory), so the cap is disk, not RAM. A PDF, PNG or JPEG still
gets the extension its bytes prove; any other file keeps its own (sanitised) name. What a browser
is given is decided by the serving policy below, so an uploaded `.html`, `.svg`, `.js` or `.exe`
is only ever a sandboxed download. The Hub refuses a file over 512 MB before sending it; NRMS
answers `413` for a declared or streamed body over the cap. A name already taken is the `409`
replace prompt before the body is sent on (except PDF, PNG and JPEG names, whose final extension
depends on the bytes); a Windows device name (`CON`, `nul.txt`, `COM1`, `CONIN$` …) is refused.
The stack allows one request 20 minutes to arrive but closes a connection idle for 2 minutes. **SiteGround hand check:** its nginx
has its own request-body limit and proxy timeout in front of the app (see "Troubleshooting"); a
site file over that limit gets nginx's HTML `413` instead of the Hub's message. Raise it to clear
512 MB for `/nrms/api/site/files` if large site files are needed on that host.

**What the stack serves at `/files/<name>`**, in this order:

1. NRMS's file at that storage key, as before. `releases/…` and `slides/…` (any letter case) are
   NRMS's alone: a release file is public only while its release is live (Q17), anything else
   there is the site's 404. Never a site-file lookup, never a redirect.
2. A site file of that name **in any letter case** (legacy parity), through NRMS's database. This
   is how an imported file whose name is not its storage key is found (`Q1_ MediaDeck.pdf` is
   stored as `legacy-<8 hex>-q1_-mediadeck.pdf`; names that are already safe lowercase keys keep
   them).
3. **The safety net (on):** a `302` (`Cache-Control: no-store`) to
   `<LEGACY_FILES_ORIGIN>/files/<path, lowercased, each segment percent-encoded>`. On by owner
   decision (2026-10-29), relying on legacy's Azure storage staying up after cutover (Q72, which
   the owner answered for translations and media assets; assumed to hold for this container on the
   same front door). A 302, not a 301, so it can be withdrawn. Lowercased because the legacy Hub
   stores uploads that way (46 of 46 mixed-case links surveyed on 2026-10-29 answered only
   lowercased); a mixed-case-only blob (the footage licence is one) is reachable only through the
   import, so check it (below). Stack-level settings: `LEGACY_FILES_FALLBACK=false` turns it off
   (the site's 404 instead); `LEGACY_FILES_ORIGIN` (default the front door above, https origin
   only) moves it. **Never for a deleted name** (suite review W2, owner 2026-10-31): deleting a
   file under Website > Files records its name, lowercased, in NRMS's `site_file_tombstones`
   (migration `0022`), and a path whose lowercased name is there gets the site's 404 instead of
   the 302, so legacy's copy of an imported file stops answering too. A Hub upload or replace
   served under that name removes the record. `legacy-files:copy` skips a recorded name (counted
   as skipped, even with `--refresh`), so a re-run doesn't bring a deleted file back. To let one
   fall back again, delete its row from `site_file_tombstones`.
4. Otherwise the site's 404. Unsafe paths (`..`, dot names, `~`, `:`, a trailing dot or space,
   encoded separators) are never looked up or redirected.

**What a browser is given.** The legacy Hub accepted any file type, so `/files` now serves by an
allowlist of inert types (`apps/stack/src/files-policy.ts`): PDF; PNG, JPEG, GIF, WebP, BMP, ICO
(not SVG); Word, Excel, PowerPoint, OpenDocument, RTF; ZIP; MP3, MP4, M4A, WAV, MOV; CSV and TXT as
`text/plain; charset=utf-8`. Anything else (HTML, SVG, XML, JavaScript, an unknown or missing
extension) is `application/octet-stream` with `Content-Disposition: attachment` and
`Content-Security-Policy: sandbox; default-src 'none'`, so it downloads instead of running on
news.gov.bc.ca. Inline types get no CSP (a sandboxed top-level PDF can break Firefox's and Safari's
viewers). Every `/files` answer carries `X-Content-Type-Options: nosniff`. The same policy covers Hub
uploads, which take any type (above), so an uploaded `.html` or `.svg` is a sandboxed download too.

**The command.** `tools/legacy-files-copy.mjs` (from a checkout, `npm run legacy-files:copy --`).
It writes NRMS's database (`NRMS_DATABASE_URL`) and object store (`NRMS_STORAGE_DIR`, else
`<DATA_DIR>/storage`: the same folder the stack serves, so set `DATA_DIR` as the stack has it).

- **Discovery, preferred: the whole container.** Set `LEGACY_FILES_SAS_URL` to the `files`
  container's URL with a **read + list** SAS
  (`https://<account>.blob.core.windows.net/files?sv=…&sp=rl&sig=…`). Whoever holds the legacy
  Azure storage account issues it (the legacy Hub's configuration holds a container SAS; a fresh,
  short-lived read+list one is better). It is a secret: the tool never prints it, and redacts it
  from errors and the report. Every blob is listed with its metadata; each top-level blob is
  imported under its metadata `filename` (else its blob name), fetched by its exact blob name. A
  blob with a `/` in its name is not a Hub upload and is reported in `nested`, not imported (the
  302 covers it). If two blobs differ only in case, the lowercased one (which legacy served) wins;
  the other is listed in `duplicates`.
- **Discovery without a SAS:** the links in our content: the databases named by
  `NEWSAPI_DATABASE_URL`, `NRMS_DATABASE_URL` and `CORE_DATABASE_URL` (read-only: posts' bodies,
  summaries and file lists, ministries and the minister's bio, carousels, site settings, resource
  links, releases in every status), plus the footage licence, every `--paths-file <file>` (one path
  per line) and `--scan-file <file>` (any text: an IIS log, saved HTML, a JSON export). Fetched
  through the front door (`--origin`), lowercased name first, as legacy did; named by the blob's
  `x-ms-meta-filename` when it answers with one. `--no-db` skips the databases.
- **Downloads.** Throttled: `--concurrency` 1 to 4 (default 1), each worker at most one request a
  second; User-Agent `gcpe-cutover-legacy-files (contact Paul@mtheory.ca)`; `Accept-Encoding:
  identity`. A redirect is followed only on the same host. One retry on a 5xx. A **429 stops the
  run** (nothing more is sent; `resume` says what to do); `--max-requests <n>` stops after n. Per
  file: no response headers within 30 s, or no body bytes for 60 s, fails that file (a slow but
  steady download is never cut off); a body shorter than its Content-Length fails (not checked when
  the server compressed it anyway); a file larger than `--max-file-mb` (default 512) fails with
  that reason (the same 512 MB as a Hub upload by default). A file is
  held in memory while it is written, so allow the cap's worth of free memory per worker.
- **Writes.** One site file per name, idempotent case-insensitively: a name that is already a site
  file (a staff upload included) is skipped without a request; `--refresh` downloads again and
  replaces the bytes. The bytes are written in the same transaction as the row, as Hub uploads are.
- **Report.** JSON on stdout: `source` (`sas-listing` or `references`), `found`, `files`,
  `totalBytes` (SAS only), `imported`, `replaced`, `skipped`, `bytes`, `notFound`, `failed`,
  `nested`, `invalid`, `duplicates`, `remaining`, `stopped`, `resume`. `--dry-run` downloads and
  writes nothing (with a SAS it still lists the container) and adds `alreadyImported`, `toFetch`,
  `overSizeCap`, `sample`. Exit code 1 on a 429 or any failure.

Run it on the server:

```sh
ssh boxs
TOOL=~/www/boxs.ca/public_html/.nodeapp/latest/app_source/tools/legacy-files-copy.mjs
read -rs -p 'NRMS_DATABASE_URL: ' NRMS_DATABASE_URL && export NRMS_DATABASE_URL && echo
read -rs -p 'LEGACY_FILES_SAS_URL: ' LEGACY_FILES_SAS_URL && export LEGACY_FILES_SAS_URL && echo
/usr/local/bin/node-24 "$TOOL" --dry-run           # files, total bytes, already imported; downloads nothing
/usr/local/bin/node-24 "$TOOL" --concurrency 2     # import
/usr/local/bin/node-24 "$TOOL"                     # catch-up: only what is new
unset LEGACY_FILES_SAS_URL NRMS_DATABASE_URL
```

Without a SAS, export `NEWSAPI_DATABASE_URL` (and `CORE_DATABASE_URL`) instead of
`LEGACY_FILES_SAS_URL`. When to run it (URL cutover runbook, "Legacy /files"): after the final
content imports and before DNS moves, then a catch-up run. Check: the files appear in the Hub under
**Website > Files**; `curl -sI https://<host>/files/News_Footage_License_British_Columbia.pdf`
answers 200 `application/pdf` (not a 302); a `/files/` link from an imported release downloads.
Backups: the imported files are site files, so they are in NRMS's database dump and its `storage`
folder like any upload.

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
import:legacy` — ministries, sectors, themes, tags). The importer copies them from
`CORE_DATABASE_URL` into NRMS's own copy before importing releases, so the NRMS service doesn't
need to be running to receive Core's events. Release categories resolve against those keys, and
unresolved ones are dropped with a warning, not an error, so an incomplete Core import still
silently loses data rather than failing loudly.

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

## Emergency alerts feed (Phase 4i)

NoD reads an EMCR emergency alerts feed (RSS or Atom) every 5 minutes from the tick and emails
new alerts to everyone on the Emergency Info BC list, whatever their own timing preference.

- On test sites the stack serves a fake feed at `/fake-emergency-feed/feed.xml`. Add an alert
  with:
  ```sh
  curl -X POST -H "Authorization: Bearer <admin token>" -H "content-type: application/json" \
    -d '{"title":"Test alert","html":"<p>Test.</p>"}' https://boxs.ca/fake-emergency-feed/__fake/alerts
  ```
  then wait up to 5 minutes (or trigger a tick).
- Production sets `NOD_EMERGENCY_FEED_URL`. With it unset, no alerts are read, and Operations
  says so. The production feed redirects the bare domain to `www`, and the fetch refuses
  redirects on purpose (an operator must point it at the real, final URL, not trust whatever a
  redirect's target happens to be) — configure the `www` form, not the bare domain.
- The first successful read of a feed URL (including a changed one) records its current alerts
  without emailing anyone; only alerts that appear after that are sent. An alert edited at the
  source updates NoD's copy in place and is never re-sent.

## Retention purge (Phase 4i)

Off by default. The switch is on Operations (NoD.Admin), which also shows what turning it on
would delete right now. When on, it runs nightly at 03:00 BC from the tick: unconfirmed
subscribers and unused request links older than 10 days, and subscribers ended more than 90 days
ago with their deliveries, history, links and subscriptions. Expired links in sent emails
(`origin = 'send'`) are cleared every night regardless of the switch. The preview and the purge
itself share one selection function, so they can't drift apart. Bounce-disabled subscribers are
never purged. Before a subscriber is deleted, any media-list opt-out the live check would still
enforce is kept as a hash of their address (no address) — see migration `0028_retention_purge`'s
`media_opt_outs` table — so staff are still asked to confirm before re-adding that address to a
list, even after the record that opted out is long gone.

Migrations `0028_retention_purge` (a new table plus columns — additive, runs in the normal
deploy) and `0029_purge_indexes` (pure `CREATE INDEX`, on `job_recipients` and `subscriber_links`
— see "Migrations on populated `deliveries` or `messages` tables" above) ship the purge; neither
hand-edits existing data.

## Importing legacy NoD data (Phase 4i)

`npm run nod:import` reads legacy NoD's SQL Server through `@gcpe/legacy-import` and writes
NoD's own database directly, modelled on `nrms:import` above.

**Env:** `DATABASE_URL` (NoD's Postgres), `NRMS_DATABASE_URL` (NRMS's Postgres, read-only —
legacy articles resolve to NRMS's own release keys through it), `PUBLIC_SITE_URL` (imported
release items link here, as NoD's own items do), `LEGACY_SQL_SERVER`, `LEGACY_SQL_DATABASE`
(default `Gcpe.NewsOnDemand`), `LEGACY_SQL_USER`, `LEGACY_SQL_PASSWORD`, `LEGACY_SQL_TRUST_CERT`
(`true`/`false`). None of these, nor any address, are printed or written anywhere by the tool
itself.

**Prerequisites.** Core's reference data must already have reached NoD (via `media_list.*`
events from NRMS, which itself needs `nrms:import` run first), and media lists republished, so
the importer's list keys resolve.

**Running it:**

```sh
DATABASE_URL=... NRMS_DATABASE_URL=... PUBLIC_SITE_URL=... LEGACY_SQL_SERVER=... \
LEGACY_SQL_USER=... LEGACY_SQL_PASSWORD=... \
  npm run nod:import -- --report nod-import.json [--since-days 30]
```

Takes a whole-run advisory lock (the same `pg_try_advisory_lock` pattern as `nrms:import`, in its
own two-int slot), so two imports can never run against the same database at once; a second one
started while the first runs exits at once with "another nod:import is already running" and
touches nothing. Imports in order: lists, subscribers (in batches of 500 candidates; each
candidate's own address lock, plus a second lock when a legacy media-list leave applies to a
different address's current record, means a single batch can take up to about 1,000
`pg_advisory_xact_lock` calls — harmless, but worth knowing if `log_lock_waits` ever looks busy
during a run), recent sends (`--since-days`, at most 92, default 30), then the digest cutoff.

**Reading the report.** Every run writes `--report <path>` (default
`nod-import-<UTC timestamp>.json`) plus a matching `.txt`. For every legacy table it lists
`legacy` (rows seen), `imported` and `skipped` (each skip reason grouped, with up to 10 sample
legacy GUIDs — never an address). Exit code: `0` when the report balances (`legacy = imported +
skipped` for every table), `2` when it doesn't (the import still completed — read the report),
`1` on any error (a partial report is still written) or when another run holds the lock.
**Re-running is safe:** a subscriber nobody has touched in NoD since the last import takes
legacy's newer data (except a media list staff re-added in NoD after legacy's own removal from
it, which stays); one changed in NoD (by staff, a bounce, the Media Hub sync) or removed by the
purge is left as NoD has it and reported, not overwritten. Consent always carries over: a legacy
unsubscribe made since the last import ends the NoD record even if NoD changed it (reported as
"unsubscribed in legacy since the last import"), unless the person subscribed again in NoD after
it (reported as "unsubscribed in legacy before a newer subscribe in NoD"); for a purged record it
is kept as an every-media-list opt-out without the address, or ends NoD's newer record of the
address on the same terms. Legacy moving a member onto an address that opted
out of one of their media lists takes them off those lists (reported per list, by id). An
article row the database refuses (a value out of range) is skipped and reported by id with the
error's code; the rest of the run carries on. The same networking
assumption as `nrms:import` applies — run it from a machine that can reach both the legacy SQL
Server and the target Postgres, which SiteGround itself likely cannot do (see "Importing legacy
NRMS data" above).

**Warning: run the final import before turning the purge on.** An imported ended subscriber gets
`ended_at` no earlier than the import itself (legacy's own end date when that is later), so the
purge's 90 days start at the import at the earliest: a bad import can still be rolled back from
legacy within that window. But once the purge has deleted a record, a later import can't bring
it back; it only reports the mismatch. Run the import (trial, then final) first, confirm the report, and only
then flip the Operations switch.

## Importing legacy Calendar data (Phase 5i)

`npm run calendar:import` reads legacy's SQL Server through `@gcpe/legacy-import` and writes the
Calendar's and Core's databases directly, modelled on `nrms:import` above — the same networking
caveat applies (see "Importing legacy NRMS data" above).

**What it needs:** the same env as `nrms:import` — `DATABASE_URL` (the Calendar's Postgres),
`CORE_DATABASE_URL` (Core's Postgres), `LEGACY_SQL_SERVER`, `LEGACY_SQL_DATABASE` (default
`Gcpe.Hub`), `LEGACY_SQL_USER`, `LEGACY_SQL_PASSWORD`, `LEGACY_SQL_TRUST_CERT` (`true`/`false`) —
plus `CALENDAR_STORAGE_DIR` (where imported attachments are written) and the optional
`CORE_EVENT_SUBSCRIBERS` (names and types only, as the replay CLIs use below: `"types":
["user.upserted"]` for both the `calendar` and `nrms` entries). None of these are printed or
written anywhere by the tool itself.

**`CALENDAR_STORAGE_DIR` must be the running Calendar's own attachment store**, not a directory on
whichever machine happens to run the import. On SiteGround that means running the import on the
server itself (`ssh boxs`), with `CALENDAR_STORAGE_DIR` left at its default or pointed explicitly
at `~/gcpe-data/calendar-files` (see "Persistent data" above). An import run from an operator's own
machine writes the attachment bytes to that machine's disk while the Calendar rows point at keys
the server never receives; downloads then fail, silently, and a re-run won't repair it, because the
rows already exist and come back "unchanged".

**Prerequisite:** Core's reference import first (ministries, sectors, themes, tags). An unknown
legacy ministry, sector, theme or tag GUID stops the run before it writes anything, and is listed
in the report by kind and GUID ("fix Core first").

**Running it:**

```sh
DATABASE_URL=... CORE_DATABASE_URL=... CALENDAR_STORAGE_DIR=... LEGACY_SQL_SERVER=... LEGACY_SQL_USER=... LEGACY_SQL_PASSWORD=... \
CORE_EVENT_SUBSCRIBERS='[{"name":"calendar","url":"https://import-cli.example.test/unused","secret":"unused-by-cli-000000000000000000000000","types":["user.upserted"]},{"name":"nrms","url":"https://import-cli.example.test/unused","secret":"unused-by-cli-000000000000000000000000","types":["user.upserted"]}]' \
  npm run calendar:import -- --cutoff <YYYY-MM-DD> --report calendar-import.json
```

That is a dry run: it applies any pending Calendar migrations (the same as a confirmed run), then
writes no Calendar or Core data. Read the report, then run it again with `--confirm`. The cutoff
has no default (Q53); at a 2026-11-01 cutoff, Survey 08 estimates about 6,700 activities. The CLI
prints which configured subscriber(s) `user.upserted` would go to before it does anything else.

**What a re-run does.** Activities are upserted by legacy id under a version guard: a new one is
inserted; one changed in the Calendar since the last import is skipped and listed ("changed in
the Calendar since the last import"); otherwise it's updated or left unchanged. Every other row —
lookups, comm contacts, Core users and their access, profiles, saved filters, favourites,
attachments and history — is copied the first time only and never overwritten, because none of
them carries a version the import could use to tell a Calendar edit from stale legacy data.
**Do test imports into an empty Calendar database:** a Calendar activity created between two runs
can take an id a newer legacy activity needs, and the second run then skips that legacy activity
instead of importing it. A confirmed run takes a whole-run advisory lock, as `nrms:import` does; a
second one started while the first runs exits at once with "another calendar:import is already
running" and touches nothing. **After exit 1, fix the cause and re-run:** nothing already imported
is duplicated, and no favourite already imported is lost, whatever stage the failure happened in.

**Reading the report.** Every run writes `--report <path>` (default
`calendar-import-<UTC timestamp>.json`) plus a matching `.txt`. For each of users, comm contacts,
every lookup, activities, saved filters, favourites, files and log rows, it lists `legacy` (rows
seen) against `outOfScope`, `planned` (dry run) or `inserted`/`updated`/`unchanged` (confirmed),
and `skipped` — `legacy` always equals the rest added together, which is the report's own
`balanced` flag. Unknown legacy keys are listed by kind and GUID; activities changed in the
Calendar since the last import are listed by id; skipped rows are listed by table, legacy id and
reason; validation problems are listed by activity id and field name only (imported anyway, fixed
on the next save). Facts cover users without or with an invalid email, duplicate-email groups, the
lowest and highest imported activity id, comm contacts of inactive users, non-deleted awareness
dates, activities with two or more categories, history row counts, and release links in and out
of scope. The report never holds a person's email, a title or a saved query's typed values.
Exit code: `0` when the report balances, `2` when it doesn't (the import still completed — read
the report), `1` on any error (unknown keys, a stage failure, another import already running). A
partial report is still written once the run has started reading legacy data; it is not written
when another run already holds the lock, or when the legacy connection or tenant configuration
fails before that point.

**After a confirmed import, in this order:**

1. If `CORE_EVENT_SUBSCRIBERS` wasn't set, run Core's republish by hand
   (`POST /core/api/admin/republish`, as in "Smoke test").
2. `npm run calendar:replay-to-nrms` (dry run), then `-- --confirm`, then a tick.
3. `npm run nrms:replay-activity-links` (dry run), then `-- --confirm`, then a tick. Its "name an
   activity NRMS doesn't hold" count is the number of releases linked to activities that weren't
   imported (C158) — compare it with the report's `releaseLinksOutOfScope` fact.

See "NRMS link and Forecast (Phase 5h)" above for how these two commands take their own
`EVENT_SUBSCRIBERS`.

**R14 (Phase 7):** legacy stays readable for one HQ administrator for a year after cutover; it's
the only place to see activities outside the import.

**Checking our reports against legacy's.** `npm run calendar:report-parity -- --csv <file> …
--part-c <file> --legacy-dir <folder> --out <folder> --cutoff <date> --from <date> --to <date>
--to-30-60-90 <date>` compares our reports with legacy's PDFs on a survey 08 CSV snapshot.
Everything it writes holds real activities and people: `--out` must be outside the repository (it
refuses one inside), in an owner-only folder, and nothing from it goes into the repo, a ticket or
chat. It drops its throwaway `test_…` databases itself; after a crash, `npm run test:clean-dbs`
finds them. The first run's results are in `docs/parity/calendar-report-parity.md`.

## Calendar access (Phase 5a)

- **Migration:** Core's `0002_calendar_access` is additive: a column, a nullable email with a check, two
  tables and a partial index on `role_grants`. It runs in the normal deploy. It succeeds on boxs.ca's
  data because every existing user has an email and no grant is a Calendar role.
- **Seed:** re-run `GCPE_TOKEN=… npm run core:seed-from-public-api -- https://boxs.ca`. Its summary has
  a `hq-organizations: upserted=2` line. The Office of the Premier is updated in the ministries pass;
  it is not created twice.
- **HQ is set only when an organization is created (C124).** The seed and the legacy importer make
  GCPE Headquarters, GCPE Media Relations and the Office of the Premier HQ only when they create them.
  On an organization that already exists they never change the HQ flag, either way: after that only a
  Core admin changes it, on Hub → Organizations (or `PUT /core/api/organizations/:key/hq`). So
  re-seeding or re-importing never undoes an admin's choice. On boxs.ca the Office of the Premier
  already exists from earlier seeds, so the seed leaves it as it is: tick it HQ on Hub → Organizations
  once, by hand. The two GCPE organizations are new there, so the seed creates them HQ.
- **Rollback caveat.** Once anyone holds a Calendar role, rolling the code back to before Phase 5a is
  unsafe: the old `setRoles` deletes every grant a user has, so the next flat-role save on Hub → Users
  would silently delete that user's Calendar role too. Reversing the `0002_calendar_access` migration
  is possible only while every user still has an email (the old `users.email` was not nullable). If
  you must roll back, first check `SELECT count(*) FROM users WHERE email IS NULL` is 0, and record
  every Calendar grant so it can be re-entered.
- **Hand checks** (acceptance item 1, Core half):
  - As the break-glass admin, on Hub → Organizations, GCPE Headquarters and GCPE Media Relations are
    ticked HQ, and there is exactly one Office of the Premier. Tick it HQ (see above), then re-run the
    seed: all three stay ticked.
  - Untick the Office of the Premier, re-run the seed, and check it stays unticked. Tick it again.
  - Until 5b hides them (Q54), GCPE Headquarters and GCPE Media Relations show on boxs.ca's public
    ministry list. That is expected on the test site.
  - On Hub → Users, add a user with a password. On Calendar access, give them Administrator with one
    ministry.
  - Sign in as them. They land on Calendar access.
  - Give another user Editor with a ministry. "System Administrator" is not offered.
  - Their own row and any System Administrator's row are read-only.
  - GCPE Headquarters is not offered to them, and a user who holds an HQ ministry has no Edit button
    (the server would refuse both).

## Corporate Calendar (Phase 5b)

The Calendar is mounted at `/calendar` only when `CALENDAR_DATABASE_URL` is set
(`apps/stack/src/env.ts`'s `calendarConfigured`). **Until that database exists on boxs.ca, the
stack runs with the Calendar switched off.** Every other app starts and runs normally,
`/calendar/*` answers `503 {"error": "calendar not configured"}`, `GET /stack/health` has no
`calendar` key at all, and `node stack.js --check` reports
`{"ok": true, "skipped": "CALENDAR_DATABASE_URL is not set"}` for it rather than failing the
check. This is expected and not a bug.

**To turn it on (one time, in Site Tools):**

1. **Databases → create one more PostgreSQL database**, granted to the same database user the
   other six databases already use (no new user, no new password). Call it `gcpe_calendar` if
   Site Tools lets you name it; if it assigns a generated name, use that name in the next step.
2. **Devs → Node.js → your project → Environment Variables → add one line:**
   ```
   CALENDAR_DATABASE_URL=postgres://<the same db user>:<the same db password>@localhost:5432/<the database's name>
   ```
   (The same `postgres://user:pass@localhost:5432/<name>` shape as the other six — never a
   `self:/...` value; see "Never set any `*_DATABASE_URL` to a `self:/...` value" above.) If you
   still have the inputs `npm run siteground:env` was run with, re-running it with the Calendar's
   database name filled in regenerates this line for you alongside everything else — safe to
   paste just that one new line into the existing environment variables instead of replacing
   them all. No other setting is needed: the stack derives the Calendar's event secrets from
   `STACK_EVENT_SECRET`.
3. **Restart the Node app** (Site Tools → Devs → Node.js → your project → Restart). The very
   next request (or the next scheduled `/stack/tick`) runs the migrations (see "Per-deploy
   steps" above for how `--check` and a real deploy apply them) and starts mounting the Calendar.
   The migrations are Core `0003_org_public` (one column), News API `0002_category_public` (one
   column) and Calendar `0000_init` (new database), all additive.
4. **Confirm:** `GET https://boxs.ca/calendar/health/ready` answers `200`, and
   `GET https://boxs.ca/stack/health`'s `apps.calendar` is `true`.
5. **Reference data:** the stack sees an empty `orgs` table and asks Core to republish once
   (the same mechanism as NoD's first-tick backfill above), so the Calendar's copies of Core's
   organizations, sectors, themes, tags and users aren't empty on an already-running deployment.
   After the next tick, `SELECT count(*) FROM orgs` and `SELECT count(*) FROM users` in
   `gcpe_calendar` are non-zero.

6. **HQ organizations.** GCPE Headquarters and GCPE Media Relations come from the Core seed
   (`core:seed-from-public-api`, "Calendar access (Phase 5a)" above). Where that seed can't run, for
   want of an admin bearer token, `scripts/siteground-add-hq-orgs.sh https://boxs.ca` creates just
   those two (HQ, not listed publicly) as the break-glass admin. Run it in a real terminal, since it
   prompts for the password. Then tick HQ on the Office of the Premier by hand on Hub →
   Organizations. On boxs.ca the two were created this way on 2026-10-10.
7. **First access.** Nobody has a Calendar role until one is given, and the break-glass admin never
   has one (by design), so: as a Core admin, Hub → Calendar access → give yourself System
   Administrator with GCPE Headquarters. It reaches the Calendar on a following tick (allow a few
   minutes the first time, while the backfill above is delivered). The Hub's **Calendar** menu link
   follows the roles in your session, so it appears after you sign out and back in; the Calendar
   itself works as soon as the role arrives. Then run `scripts/siteground-seed-users.sh` for the
   `cal-*` test users.

No code change and no redeploy of the artifact itself is needed for this — `CALENDAR_DATABASE_URL`
is the only thing gating it, and it's read fresh from Site Tools' own environment variables on
every process start.

**After the deploy:**

- **Q54 on boxs.ca:** on Hub → Organizations, untick "listed publicly" for GCPE Headquarters and
  GCPE Media Relations (they existed before the flag). Then
  `curl -s https://boxs.ca/api/Ministries | grep -c gcpe-` prints `0`, and the test subscribe
  page no longer offers them.
- **Break-glass:** has no Calendar access, by design. The Calendar has no local-admin route and
  refuses bearer tokens; staff reach it through the Core session.
- **Hand checks (5b exit, lookup half):** as a user with Calendar.Administrator and a ministry:
  Hub → Calendar → Lookups; HQ tags: add, rename, deactivate a "Sample keyword …"; Categories
  shows read-only. As a Calendar.SysAdmin: add and deactivate a "Sample category …". Remove the
  Administrator's role on Hub → Calendar access, wait one tick, click in the Calendar: "You don't
  have Calendar access".

### Calendar users (Phase 5b-2)

No migration. Re-run `scripts/siteground-seed-users.sh https://boxs.ca` (interactive, Paul) to add
the five Calendar test users (cal-admin, cal-sysadmin, cal-hq-admin, cal-editor, cal-readonly).
Re-running the seed resets the cal-* users' Calendar role, ministries and active flag; their
contact details and comm-contact ranks are untouched.

**Hand checks:**

- As cal-admin: Hub → Calendar → Users lists "Test Calendar Editor (HLTH)"; open it, save a phone
  number, set rank PAO for Health.
- Deactivate a fresh Calendar-only user, then reactivate them.
- Tick "Show users without Calendar access": "Test Editor" (an NRMS user with no Calendar role)
  appears only then. Open them and try to deactivate: refused with "only a Core admin can change a
  user who has no Calendar role".
- As cal-hq-admin: open an HQ user and change their rank (allowed); as cal-admin, deactivating
  cal-hq-admin is refused (HQ user).

### Activity API (Phase 5c-1)

**No migration.** The Calendar refuses to start if the tenant file has no `calendar` section.
`config/tenants/bc.json` carries it, and the artifact ships it.
That section holds the Calendar's settings: the freeze window, the release categories, the Other
city, the Translations list and the required fields.

**New tick step:** `calendar.lock-sweep`.

**New route:** Calendar → NRMS for `activity.*`. NRMS records these events as `ignored` until 5h.

**Hand checks on boxs.ca**, through the API. The screens are 5d and 5e. Use `curl` with a session
cookie from `POST /core/auth/login` and the `X-GCPE-Request: 1` header:

1. As cal-editor, `POST /calendar/api/activities` needs lookups to exist. As cal-sysadmin, first
   add a "Sample category" and a "Sample City" on Hub → Calendar → Lookups. Set cal-editor's
   comm-contact rank for Health on the users screen; that creates the comm contact. The create
   answers 201.
2. Between 16:00 and 17:00 BC, the same create answers 423 with "You cannot make content changes
   between 4pm-5pm." As cal-hq-admin it answers 201.
3. `PUT /calendar/api/activities/<id>/lock` as cal-editor, then as cal-admin: the second answers
   423 "… is editing this activity".
4. `GET /calendar/api/activities/<id>/changes` lists the `created` entry.
5. After one tick, NRMS's `inbox_events` has an `ignored` row of type `activity.created` from
   source `calendar`, and the News API's has none.

### Transfer and undelivered events (Phase 5c-2)

**No migration.**

**Hand checks:**

1. As cal-admin: Hub → Calendar → Transfer. Pick two Health comm contacts and Preview. The count
   matches the activities created in 5c-1's hand checks. Transfer.
2. On a user's page, Deactivate shows "No open activities." or the list.
3. As cal-sysadmin: Hub → Calendar → Undelivered events shows "Nothing is waiting".

### Activity list (Phase 5d)

**No migration.**

**Seeded users:** run `scripts/siteground-seed-users.sh https://boxs.ca` again to add
`cal-advanced`, `cal-hq-editor` and `cal-hq-advanced`. It prompts for every seeded password.

**Hand checks** (they need the Calendar database, `gcpe_calendar`, on boxs.ca):

**Still to do:** checks 1–5 are all waiting for the `gcpe_calendar` database on boxs.ca. None has
been run there yet, including the list timing in check 1.

1. **Waiting for `gcpe_calendar`.** As cal-editor: Hub → Calendar shows the list with today onward.
   Time the first load and a "Show more" with the browser's network panel; record both beside
   5d-1's measured numbers in `docs/superpowers/plans/2026-10-08-phase-5d-list-performance.md`.
2. **Waiting for `gcpe_calendar`.** Save a query, reload, run it; rename and delete it.
3. **Waiting for `gcpe_calendar`.** Excel export: open the downloaded file in real Excel. The header
   row, 16 columns and red footer show; no repair prompt.
4. **Waiting for `gcpe_calendar`.** As cal-hq-admin: tick two rows, Review selected; Corporate
   Queries → Show all → Search.
5. **Waiting for `gcpe_calendar`.** Month and Week views show activities on their days.

### Activity files (Phase 5e-1)

**No migration.**

Nothing to configure on boxs.ca: `CALENDAR_STORAGE_DIR` defaults to `calendar-files/` under
`DATA_DIR` (see "Persistent data" above). Include `~/gcpe-data/calendar-files` in backups, beside
the Calendar database. Set `CALENDAR_STORAGE_DIR` explicitly only to move it elsewhere.

**Hand check, Paul: the nginx request body limit.** An upload is a raw request body (no
multipart), up to 25 MiB (`ATTACHMENT_MAX_BYTES`) plus header overhead. As with NRMS's media
uploads (see "Troubleshooting" below), SiteGround's nginx sits in front of the app with its own
upload size limit, which this stack doesn't control and which refuses an oversized request before
it ever reaches `/calendar/api/activities/*/files`. Plain nginx's default is 1 MB; SiteGround's
actual limit on boxs.ca (our test environment — not production) is unverified. Confirm it (Site
Tools → Devs, or ask SiteGround support) and raise it to comfortably clear 25 MiB for that path
before testing Calendar attachment uploads there; an HTML `413` instead of the Calendar's own
JSON error means it hasn't been raised.

### Activity page (Phase 5e-2)

**No migration.** Nothing to configure.

**Hand checks on boxs.ca after deploy** (spec §16's starred items):

1. Open one activity as two users in two browsers: the second sees "<name> is editing".
2. Between 16:00 and 17:00 BC time, a ministry editor's activity page opens read-only with the
   freeze message; an HQ Editor's doesn't.
3. "View changes" shows the edit just made.
4. An attachment's link opens for a user in its own ministry and is "not found" for another
   ministry's user. BC's tenant hides Records (`showRecordsSection` is off, as legacy), so the page
   shows no link: open `/calendar/api/activities/:id/files/:fileId` directly as each user.

### Updates feed (Phase 5f)

**No migration.** Nothing to configure.

**Hand checks on boxs.ca after deploy** (spec §16 acceptance 2 and 9):

1. As cal-editor: Hub → Calendar → Updates shows "Today's updates". Change a scratch activity's title and it heads "Latest 5 updates", worded "Test Calendar Editor changed activity HLTH-<id>: …", with no email anywhere.
2. Click that entry's `HLTH-<id>`, then Cancel: you are back on the same updates.
3. As cal-hq-editor: a Health activity marked confidential by cal-editor doesn't appear in any view, and `?mode=activity&activity=<its id>` says "Activity not found".
4. As cal-hq-admin: delete a scratch activity. Its entries show "(deleted)", and the deletion is listed. As cal-editor they are gone.
5. On boxs.ca new activity ids are small, so typing one in "Search for" searches text. Use `?mode=activity&activity=<id>` instead. Production ids are legacy-sized (above 10,000).

### Reports (Phase 5g)

**No migration.** The artifact now carries `report-worker.cjs` and `fonts/` beside `stack.js`; they deploy with it. Optional settings: `CALENDAR_REPORT_CONCURRENCY` (default 1), `CALENDAR_REPORT_HEAP_MB` (320), `CALENDAR_REPORT_TIMEOUT_SECONDS` (120), `CALENDAR_REPORT_INLINE_WAIT_MS` (5000). If the worker or the fonts are missing, the Calendar still starts, its report buttons say "Reports aren't available on this server right now", and `/stack/errors` shows "[calendar] reports are unavailable…".

**Hand checks on boxs.ca after deploy** (spec §3 row 5g, §16 acceptance 10):

1. As cal-editor: Hub → Calendar, filter a week with activities, click Look Ahead. The PDF downloads: Letter, BC Sans (the viewer's document properties list BCSans fonts), the cover, then "Inside Government". Each CC ID# opens the activity.
2. Click 30/60/90 (Letter) and Planning (Legal landscape).
3. As cal-hq-editor the toolbar has no Exec Look Ahead. As cal-hq-admin it does, and its rows end "Last updated …", said once.
4. As cal-hq-admin, run a Look Ahead with no To date (60 days). Note whether it arrived without a "Preparing…" pause, and how many seconds it took; record both here. While it renders, load `/` in another tab: it answers at once.
5. `/stack/errors` holds no "[calendar] a report failed" line. If it does, its label says which limit was hit: `ERR_WORKER_OUT_OF_MEMORY` (raise `CALENDAR_REPORT_HEAP_MB`) or `ERR_REPORT_TIMEOUT`.

### NRMS link and Forecast (Phase 5h)

**Migration:** NRMS's `0015_calendar_link` (`calendar_activities`, `calendar_viewers`, `organizations.is_hq`, an index on `news_releases.publish_at`). It runs at startup like the others. The Calendar's schema doesn't change.

**After deploy:**

1. With the Calendar mounted, the stack's reference-data backfill sees NRMS has no Calendar viewers and asks Core to republish once. Without the Calendar (boxs.ca until `gcpe_calendar` exists), nothing is needed yet. After `gcpe_calendar` exists, if NRMS's Forecast shows "Calendar activities are listed here for people with Calendar access" to an HQ user who has Calendar access, run Core's republish by hand (`POST /core/api/admin/republish`, as in "Smoke test").
2. Activities created before this deploy reached NRMS as `ignored` events. Fill NRMS's copy once: `npm run calendar:replay-to-nrms` (dry run), then `-- --confirm`, then a tick. Then `npm run nrms:replay-activity-links` (dry run), then `-- --confirm`, then a tick. Run them in this order after any legacy release import too — `calendar:replay-to-nrms` first, then `nrms:replay-activity-links` — since the bulk importer itself doesn't emit link changes: `nrms:replay-activity-links` is what sends status to the Calendar for the releases the import just linked. Both commands are dry runs unless given `--confirm`.

   Both run from a full checkout, outside the running stack, with the app's `DATABASE_URL` and their own `EVENT_SUBSCRIBERS` — there is no SiteGround setting to copy this from, so set it explicitly on the command line. `--confirm` refuses to run (prints why, exits non-zero) unless `EVENT_SUBSCRIBERS` names at least one subscriber whose `types` include the event the CLI sends; both a dry run and a confirmed run print which configured subscriber(s) matched. Only each entry's `name` and `types` matter for this check — the stack already running on boxs.ca delivers the enqueued events itself, by matching the `subscriber` name against its own `EVENT_SUBSCRIBERS` (derived from `STACK_EVENT_SECRET`), never by calling the `url`/`secret` given here — so any placeholder value works for those two fields:

   ```sh
   DATABASE_URL=... \
   EVENT_SUBSCRIBERS='[{"name":"nrms","url":"https://replay-cli.example.test/unused","secret":"unused-by-cli-000000000000000000000000","types":["activity.updated"]}]' \
     npm run calendar:replay-to-nrms -- --confirm
   ```

   ```sh
   DATABASE_URL=... \
   EVENT_SUBSCRIBERS='[{"name":"calendar","url":"https://replay-cli.example.test/unused","secret":"unused-by-cli-000000000000000000000000","types":["release.status_changed"]}]' \
     npm run nrms:replay-activity-links -- --confirm
   ```

   (`nrms:replay-to-news-api`'s own `EVENT_SUBSCRIBERS` isn't needed for this step — it sends `release.updated`, not `activity.updated`/`release.status_changed` — but is set up the same way, with a subscriber naming `news-api` and `types: ["release.updated"]`.)
3. **Seeded users:** run `scripts/siteground-seed-users.sh https://boxs.ca` again to add `planner@example.test` ("Test Release Planner", NRMS Editor with Calendar Read Only at GCPE Headquarters).

**Hand checks on boxs.ca** (spec §16 acceptance 13 and 14; they need `gcpe_calendar`):

1. As cal-editor: create a confirmed Health activity two weeks out, with a category starting "Approved" (cal-sysadmin adds one on Calendar → Lookups) and a city.
2. As planner: Releases → Forecast lists it as "Planned for …". "Start a release" opens New release with the id, the date, the city and Health filled in. Create it.
3. As cal-editor: the activity's "BC Gov News" shows "Release: Draft, …" after a minute. Approve and schedule the release as planner; the activity follows. As editor (no Calendar role), the Forecast lists only releases and says why.
4. Make the activity confidential as cal-editor. As planner, the lookup of its id says "its details aren't shown to you", and the Forecast no longer lists it.
5. In NRMS's database, `SELECT title FROM calendar_activities WHERE is_confidential` returns only nulls; the News API's `inbox_events` has no `activity.%` or `release.status_changed` row.

## Search and embeddings (Phase 6a)

### Embedding settings

Nothing calls an embedding provider yet: semantic search and its worker arrive in 6b. The settings are parsed now so that `node stack.js --check` catches a bad one before it matters. All are News API settings, so on the stack each carries the `NEWSAPI_` prefix:

| Variable | Meaning |
|---|---|
| `NEWSAPI_EMBEDDINGS_PROVIDER` | Unset or blank: full-text search only. `stand-in`: the hashing stand-in, for tests and boxs.ca. `azure-openai`: Azure OpenAI. |
| `NEWSAPI_AZURE_OPENAI_ENDPOINT`, `NEWSAPI_AZURE_OPENAI_API_KEY`, `NEWSAPI_AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | Required for `azure-openai`. The deployment must be `text-embedding-3-small` in a Canada region (Q70). |
| `NEWSAPI_AZURE_OPENAI_API_VERSION` | Default `2024-10-21`. |
| `NEWSAPI_EMBEDDINGS_TIMEOUT_MS` | Per call. Default 1000; clamped to 200–5000. |

`stand-in` is refused on a real production deployment: `NODE_ENV=production` without `LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true` or `SITE_ENVIRONMENT=test`. That is the same test-site rule as Flickr and the TEST banner. boxs.ca qualifies as a test deployment.

### Search columns and the backfill

**Migration:** the News API's `0003_post_search` adds `posts.search_text`, the generated `posts.search_vector` (`to_tsvector('english', …)`) and a GIN index. It runs at startup like the others. Adding a generated column rewrites `posts` once under a lock, so the first start after the deploy takes longer, in proportion to the number of posts. No extension is needed; it runs on SiteGround as is.

**After deploy, once:** posts written before this deploy have no search text, so search can't find them until the backfill runs. Run it from a full checkout, outside the running stack, with the News API's database URL (the value of `NEWSAPI_DATABASE_URL`), as for the other commands:

```sh
DATABASE_URL=... npm run news-api:search-backfill              # dry run: how many posts it would fill
DATABASE_URL=... npm run news-api:search-backfill -- --confirm # fill them, 200 per transaction
```

It is safe to re-run: it fills only posts with no search text. `-- --all --confirm` recomputes every post (for example after a change to what search text contains). Exit code `0` is done; `1` means it stopped (it prints the label) or the column doesn't exist yet, in which case start the News API first. New and updated posts get their search text as they are written, so after one run nothing more is needed.

**Search language:** the column's language is fixed by the migration (`english`). The tenant's `search.language` must match, or the News API refuses to start: "Tenant search.language is "…" but posts.search_vector uses "…"". A tenant that needs another language adds its own drizzle-kit migration that redefines `search_vector` with that configuration, and sets `search.language` to match.

### The search route

`GET /api/v2/search?q=&ministry=&sector=&type=&from=&to=&page=` (on boxs.ca: `https://boxs.ca/api/v2/search?q=…`):

- It is full-text only in 6a: every response says `"mode": "text"`.
- It needs no `api-version`, and answers `Cache-Control: no-store`.
- `q` is 1–200 characters; `page` is 1–50 (20 results each); `from` and `to` are BC calendar dates (`YYYY-MM-DD`, inclusive); `type` is `releases`, `stories`, `factsheets`, `updates` or `advisories`.
- A bad parameter is a 400 that names it.
- Errors are logged to `/stack/errors` as the route and a label, never the search words.
- Result links use the stack's public site URL (`SITE_PUBLIC_SITE_URL`), or `NEWSAPI_PUBLIC_SITE_URL` when set.
- The app itself never logs the query string. But this is not a promise that search terms are never logged anywhere: SiteGround's own proxy (and OpenShift's router, where its access logging is on) records the full request line in its access logs, so `?q=…` and its values land there outside the app's control, the same way `/stack/tick`'s `?token=` form does (above).

**Hand checks on boxs.ca after the backfill:**
1. `curl -s 'https://boxs.ca/api/v2/search?q=highway'` lists releases mentioning highways, with `"mode":"text"` and links under `https://boxs.ca/releases/`.
2. `curl -si 'https://boxs.ca/api/v2/search?q=highway&page=99'` is a 400 whose body names `page`, with `cache-control: no-store`.
3. `curl -si 'https://boxs.ca/api/Home'` is still the 400 `ApiVersionUnspecified`: v1 is unchanged.

## Semantic search, related posts and the change feed (Phase 6b)

### pgvector and the search mode

**Migrations:** `0004_semantic_tables` adds `post_embeddings`, `post_related`, `changes`, `change_feed_state` and `posts.embedding_text_hash`. `0005_pgvector_optional` then tries to enable pgvector and index the embeddings. On SiteGround the database user may not create extensions, so that step is skipped with a notice and every migration still succeeds. No setting is needed.

**The search mode** is decided once, when the News API starts. It is `semantic` only when all of these hold:
- the tenant config has `"features": { "semanticSearch": true }`;
- `NEWSAPI_EMBEDDINGS_PROVIDER` is set (`azure-openai`, or `stand-in` on a test site);
- the News API's database has the `vector` extension.

Otherwise it is `text`. `/stack/health` reports it as `"newsApiSearch": "semantic"` or `"text"`. When the flag is on but something is missing, the News API logs one line at startup, for example `[news-api] semantic search is off: missing pgvector`.

On boxs.ca it is always `text`: SiteGround's Postgres user can't enable pgvector.

**Enabling pgvector later** (OpenShift or any Postgres where a DBA can): connect to the News API's database as a role allowed to create extensions, and run:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE INDEX CONCURRENTLY IF NOT EXISTS post_embeddings_embedding_hnsw_idx
  ON post_embeddings USING hnsw ((embedding::vector(1536)) vector_cosine_ops);
```

Then restart the News API. `CONCURRENTLY` keeps the table writable while the index builds; it can't run inside a transaction block. Without the index, semantic search still works, but each related-posts computation scans every embedding, and the News API logs `post_embeddings has no HNSW index` at startup.

### The change feed

`GET /api/v2/changes?after=<id>&limit=<1-500>` lists what changed in the News API, oldest first, for the public site's builder (6c). Every post write, unpublish, ministry, sector, theme and tag change, and every home, slides and resource-links change adds one row, in the same transaction as the change itself.

- **Access:** a bearer token with the `NewsApi.ChangesRead` service role, or an operator's `Core.Admin` token. Staff sign-in cookies don't work here. With no Entra audience (`NEWSAPI_AUTH_AUDIENCE` with `ENTRA_TENANT_ID`) and no local admin, the route answers `503 changes feed not configured`. On boxs.ca local admin is on, so it works with a local token.
- **Reading it:** start with `after=0`; each response has `next`, the `after` to send next time. A response with `"changes": []` means nothing new.
- **Retention:** rows older than 90 days are deleted on every `/stack/tick` (the `news-api.changes-prune` step). A cursor older than that gets `410` with `{ "resync": true, "next": <id> }`: rebuild everything, then continue from `next`.
- **Volume:** a full legacy import writes one row per release it applies (Q78), about 100,000 rows. They are pruned after 90 days like any other.

**Hand check on boxs.ca:** `curl -si https://boxs.ca/api/v2/changes` is a `401` with `cache-control: no-store`.

### The embedding worker

In semantic mode, each `/stack/tick` (the `news-api.embed` step) embeds up to 50 published posts that have no embedding, or whose text, provider or model changed, newest first, in one provider call, and then recomputes each one's 5 related posts. In text mode the step does nothing.

- **Backlog:** at one tick a minute, 50 posts a tick, about 100,000 posts take about 33 hours or less to embed the first time — `STACK_LOOPS` (default on) also runs the worker's own internal 60 s loop in the same process, and the two can run back to back, so the real pace can be faster than one tick a minute. Until a post is embedded, search still finds it through the text half of a semantic search, and its related posts use the text fallback.
- **Changing provider or model** re-embeds every post, at the same pace.
- **Failures:** a provider failure is logged as `[embeddings] <provider> call failed <label>` and the posts are retried on the next tick. If a batch of several posts fails, the worker splits it and keeps retrying the halves, in the same tick, down to single posts, so one bad post never blocks the healthy ones behind it. A post that still fails alone is skipped by later ticks (until its text changes) rather than retried forever. After three failures in a row with no success between them the worker's breaker opens and the step skips its ticks for 60 seconds — isolating a single bad post among healthy ones is specifically designed not to trip this, since a healthy post's success resets the count. Search has its own breaker, so a failing batch doesn't turn search off.
- **Timeout:** the worker has its own 5-second provider timeout and its own breaker, separate from search's.
- **Unpublishing** deletes the post's embedding and related posts in the same transaction, so it disappears from semantic results and related lists at once. That includes a legacy import's unpublish step.
- **Before turning semantic search on**, make sure the 6a search backfill has run: the worker skips a post whose `search_text` is still NULL, so such a post is never embedded until that backfill fills it in. A plain re-run of the backfill fills only posts with no search text; `--all` recomputes every post's search text. Either way, the worker fills missing embedding hashes itself, so re-running the backfill is never required just for that.

### Semantic search

In semantic mode, `GET /api/v2/search` embeds the query (each distinct query once per 5 minutes; up to 5,000 kept) and lists posts whose meaning is close to it first, nearest first, then the full-text matches not already listed. Responses say `"mode": "semantic"`. If the provider fails or its breaker is open, the same request answers in text mode and says `"mode": "text"`; while the breaker is open nothing is logged per request.

| Variable | Meaning |
|---|---|
| `NEWSAPI_SEARCH_SEMANTIC_THRESHOLD` | Cosine distance at or below which a post counts as a semantic match. Default `0.6`; 0–2. Lower is stricter. |
| `NEWSAPI_SEARCH_RATE_LIMIT_PER_MIN` | Search requests a minute per client IP (Q74). Default `60`. A client over it gets `429 {"error":"too many requests"}`. Uses `NEWSAPI_SUBSCRIBE_CLIENT_IP_HEADER` to find the client's address, as Subscribe does. |

#### Search result cache and semantic cap

Two protections keep public search from being the platform's bottleneck (an exact vector scan costs about 200 ms of database CPU per query at 35,000 posts).

- **Result cache.** `GET /api/v2/search` keeps each answer in the process's memory for `NEWSAPI_SEARCH_CACHE_TTL_SECONDS` (default 60, the public site's max-age). The key is the query text (whitespace collapsed, case kept), ministry, sector, type, from, to, page, page size and facets, so every distinct combination is its own entry. It is a least-recently-used cache bounded by entry count and by bytes. Identical queries arriving together share one database read. Errors, and degraded answers (see below), are never kept. The route is public and anonymous, so nothing staff-only is ever cached. The API still sends `Cache-Control: no-store`: this cache lives only inside the process, and the proxy must not cache `/api`.
- **No invalidation on publish.** A publish or unpublish shows in search results within the TTL. That staleness is already accepted for pages, a purge hook would need cross-app wiring for no gain at 60 s, and per-process caches could not be purged consistently anyway. Set the TTL to `0` to turn the cache off.
- **Semantic cap.** At most `NEWSAPI_SEARCH_SEMANTIC_MAX_CONCURRENT` vector queries run at once (default `max(2, CPU cores - 1)`). Up to `NEWSAPI_SEARCH_SEMANTIC_QUEUE` more (default 8) wait up to `NEWSAPI_SEARCH_SEMANTIC_QUEUE_WAIT_MS` (default 250) for a slot. Beyond that the request is answered in text mode (`"mode": "text"`) with the response header `X-Search-Fallback: capacity`, so visitors still get results and an overloaded database sheds the expensive work first. A degraded answer is not cached. Filter-only searches and text-only deployments never take a slot. Text search has no cap of its own: it uses the database index and is bounded by the connection pool.

| Variable | Meaning |
|---|---|
| `NEWSAPI_SEARCH_CACHE_TTL_SECONDS` | Default `60`; 0–3600. `0` turns the cache off. |
| `NEWSAPI_SEARCH_CACHE_MAX_ENTRIES` | Default `500`. |
| `NEWSAPI_SEARCH_CACHE_MAX_MB` | Default `32`. Serialised size of what is cached, estimated. |
| `NEWSAPI_SEARCH_SEMANTIC_MAX_CONCURRENT` | Vector queries at once. Default `max(2, CPU cores - 1)`. |
| `NEWSAPI_SEARCH_SEMANTIC_QUEUE` | Semantic queries allowed to wait for a slot. Default `8`; `0` means none wait. |
| `NEWSAPI_SEARCH_SEMANTIC_QUEUE_WAIT_MS` | Longest wait for a slot. Default `250`; 0–5000. |

Each running process has its own cache and its own cap, so with N processes behind a farm the totals are N times these numbers.

**Cost:** an uncached semantic query compares the query with every published post's vector that the filters allow: 120–170 ms at 20,000 posts on a laptop, growing in proportion (Q79).

**Hand check on boxs.ca** (text mode there): after 61 quick `curl -s -o /dev/null -w '%{http_code}\n' 'https://boxs.ca/api/v2/search?q=x'` calls from one machine within a minute, the last is `429`.

### Related posts

`GET /api/v2/posts/<key>/related` lists up to 5 published posts related to a published post, in the same shape as search results, `no-store`.

- In semantic mode it serves the post's 5 nearest posts by meaning, computed when the post was embedded (`"mode": "semantic"`). A post unpublished since is left out at once.
- Otherwise, and before a post is embedded, it serves the newest published posts with the same lead ministry and at least one shared tag (`"mode": "text"`). A post with neither gets an empty list.
- An unknown or unpublished key is a `404`.

**Hand checks on boxs.ca:**
1. `curl -s https://boxs.ca/api/v2/posts/<a published key>/related` answers `"mode":"text"`.
2. `curl -si https://boxs.ca/api/v2/posts/no-such-key/related` is a `404` with `cache-control: no-store`.
3. `curl -s https://boxs.ca/stack/health` includes `"newsApiSearch":"text"`.

## The public site (Phase 6c)

### Theme and assets

The public site's colours, font and footer links come from `site.theme` in `config/tenants/<tenant>.json`. A service refuses to start when the theme's text on background, text on surface, or primary text on primary is below 4.5:1 contrast; the error names the pair and the ratio. Files under `config/site/assets/` are published at `<site>/assets/…`; `SITE_SITE_ASSETS_DIR` overrides the folder (the stack prefixes every public-site variable with `SITE_`) — the folder holds only a `.gitkeep` in the repo. The built-in assets are written beside them on every start and build: the BC logos are committed under `apps/public-site/assets/legacy/Content/Images/Gov/` (published at `<site>/assets/legacy/Content/Images/Gov/…`), and the BC Sans font files and their licence come from the pinned `@bcgov/bc-sans` package (published at `<site>/assets/legacy/fonts/`). Test sites serve `robots.txt` with `Disallow: /` and add `<meta name="robots" content="noindex, nofollow">` to every page.

### Pages and rebuilds

Every page the site serves under `<OUTPUT_DIR>`:

| Page | Path |
|---|---|
| Home | `/index.html`, `/feed.xml` |
| Release/story/factsheet/update | `/releases/<key>/index.html` |
| Ministries index | `/ministries/index.html` |
| Ministry/sector/theme/tag | `/<kind>/<key>/index.html`, `/<kind>/<key>/feed.xml` |
| Archive index | `/archive/index.html` |
| Monthly archive | `/archive/<yyyy>/<mm>/index.html` |
| Sitemap index | `/sitemap.xml` |
| Monthly/pages sitemap | `/sitemaps/<yyyy-mm>.xml`, `/sitemaps/pages.xml` |
| Static (theme, 404, robots) | `/assets/theme.css`, `/404.html`, `/robots.txt` |

The public site keeps a local index of every post it has rendered (`site_posts`, in the public site's own database) — its headline, date, month and category keys — so a post change can rebuild exactly the pages that listed it, both before and after the change (the News API has no "posts in a month" query). A post's publish, update or unpublish event rebuilds its own page, then its dependents (home, archive, sitemap, and its ministry/sector/theme/tag pages), reading the index row from before the change.

A layout change (bumping `RENDER_CHROME_VERSION`) or a Blue Bridge/test-flag switch queues every page on the site — every published post, then every aggregate page — on the next `site.rebuild_requested` event, at the next start, or on the next `site.sync` tick (the chrome check runs every tick, not only on an event or a start). See "The rebuild queue" below for how that queue drains.

**Advisories never get a page.** A release NRMS marks as not for the web (every Advisory, as in legacy) is never stored as a published post by the News API, so it has no page and is in no listing, search, feed, sitemap or API answer; NoD still gets its event and sends it to its media lists. A key that was public before comes off the site the way an unpublish takes it off. News API migration `0012_unpublish_advisories` (data only, safe to re-run) does that on deploy for every Advisory an older build put on the site, and writes a `post.unpublished` change for each, so the public site removes its page and rebuilds the pages that listed it within a few `site.sync` ticks. It also writes a `post.upserted` change for each post whose related band may link one, so those pages are re-rendered without it; an ordinary unpublish does the same. Check afterwards, once every process (each Windows server, every pod) runs the new build: `/releases/<advisory key>/` answers 404, and `<site>/api/Posts/Latest/home/default?postKind=advisories&api-version=1.0` returns an empty list. If not (an older process re-stored one while the deploy rolled), run the migration file again as one transaction against the News API database (`psql "$NEWSAPI_DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f migrations/news-api/0012_unpublish_advisories.sql` from the release folder; it only acts on Advisories still published), or `npm run site:rebuild-all` for a page that is still on disk.

To force a full rebuild by hand, delete `<OUTPUT_DIR>/.site-state.json` and restart — the next startup finds no marker and queues a rebuild of everything.

### The rebuild queue

Every page waiting to be rendered sits in `rebuild_queue` (the public site's own database), one row per page id, in four priorities — lowest drains first:

| Priority | What |
|---|---|
| 0 (live post) | A post an event just published, changed or unpublished. |
| 1 (live aggregate) | That post's dependents (home, archive, sitemap, its ministry/sector/theme/tag pages) — and, on a layout/Blue Bridge change, `static`, `home`, `ministries`, `archive` and `sitemap` themselves, so the home page shows the new chrome at once. |
| 2 (bulk post) | Every post, newest first, queued by a full rebuild (a layout/Blue Bridge change, or `site:rebuild-all`). |
| 3 (bulk aggregate) | Every other aggregate page (ministries/sectors/themes/tags, monthly archives and sitemaps), queued by the same full rebuild. |

Each tick (`site.sync`, or the standalone loop) renders up to `SITE_SITE_REBUILD_BATCH` pages (default 200) off the front of the queue, lowest priority first, then whatever's oldest within that priority. A page that fails to render goes to the back of its own priority with its `attempts` count bumped, and is retried on a later run — it never blocks the pages behind it. On a large site (about 100,000 posts), a full rebuild's bulk posts drain at roughly `SITE_SITE_REBUILD_BATCH` pages a tick — about eight hours at one tick a minute (Q84).

To watch a rebuild drain:

```sql
SELECT priority, count(*) FROM rebuild_queue GROUP BY 1;
```

To find pages that keep failing (and confirm they're still being retried, not stuck):

```sql
SELECT page_id, attempts FROM rebuild_queue WHERE attempts > 3;
```

`npm run site:rebuild-all` (with `DATABASE_URL`, `NEWS_API_URL`, `OUTPUT_DIR` and `PUBLIC_SITE_URL` set for the site) queues every page without rendering anything itself — the queue drains on the stack's own ticks afterwards. The public site can also run its own standalone loop (`SYNC_INTERVAL_MS`, default 30000) when it isn't behind the stack's `/stack/tick`.

### The change feed

Each `site.sync` turn (every `/stack/tick`, or the standalone loop) reads the News API's change feed (`GET /api/v2/changes` — see "The change feed" under Phase 6b above) from a stored cursor and queues the pages each change affects, before draining the queue — events (`site.rebuild_requested`) are now just a doorbell that wakes a sync up sooner; the feed is what actually keeps the site current if an event is ever missed.

- **The cursor:** one row, in the public site's own database — `SELECT change_cursor FROM site_state WHERE id = 1`. `NULL` means the builder has never synced; it reads to the News API's current head first, then queues a full rebuild (nothing from the changes themselves), so this deploy's first sync is a one-time full rebuild, not a 100,000-row catch-up.
- **`410` (behind the News API's 90-day pruning watermark):** the builder queues a full rebuild and jumps its cursor straight to the response's `next`, in the same database transaction — so a site builder left stopped for more than 90 days also gets a full rebuild on its first sync back, same as a brand-new deploy.
- **Credentials:** the builder authenticates its own `GET /api/v2/changes` calls with a service token carrying the `NewsApi.ChangesRead` role — never a staff session. On boxs.ca (the stack) it mints this from the shared local admin secret; on OpenShift (standalone) it uses Entra client credentials (`NEWS_API_TOKEN_URL`, `NEWS_API_CLIENT_ID`, `NEWS_API_CLIENT_SECRET`, `NEWS_API_SCOPE`, `SITE_`-prefixed on the stack). With neither configured the builder refuses to start.
- **Failures:** a feed read that errors (the News API down, a bad token) is logged and the sync continues straight to draining whatever is already queued; the feed is retried on the next tick, so a transient outage never blocks pages already queued from rendering.

To watch where the builder's cursor sits relative to the News API's own feed:

```sql
SELECT change_cursor FROM site_state WHERE id = 1; -- on the public site's database
SELECT max(id) FROM changes;                       -- on the News API's database
```

### Search page

`/search/` is a static page that calls the News API's `GET /api/v2/search` (Phase 6b) from the browser, client-side — nothing server-rendered. `SITE_SEARCH_API_URL` (the stack prefixes every public-site variable with `SITE_`) names the host to call when it isn't the site's own origin; unset on the stack and left unset until Q81 (same origin: a reverse proxy routes `/api/v2/search` on the site's own host) is settled, in which case the page calls `location.origin`.

The News API limits `/api/v2/search` to 60 requests a minute per client IP (Q74, Phase 6b). A visitor who hits it sees "Too many searches. Wait a minute and try again." in the page's alert region, same as a 400 ("Enter between 1 and 200 characters to search.") or any other failure ("Search isn't available right now. You can browse the archive instead.").

### Robots and Google Search Console verification

`robots.txt` on a live site is the legacy news.gov.bc.ca Disallows (`/error`, `/files`, `/search`, `/Search`, `/SEARCH`, `/subscribe`) plus the `Sitemap:` line; `/assets` is deliberately not disallowed, so crawlers can fetch the CSS and JS. On a test site (`SITE_ENVIRONMENT=test`, boxs.ca) it stays `Disallow: /` and every page carries `noindex`.

Two optional, operator-owned variables (the stack prefixes them with `SITE_`) prove ownership to Google Search Console. Both values are public; empty or unset means none. A value that doesn't match its format stops the site from starting, so nothing unchecked reaches a file path or the page `<head>`.

| Variable | Format | Effect |
|---|---|---|
| `SITE_GOOGLE_VERIFICATION_FILE` | `google` + 16 lowercase hex digits + `.html` | Writes that file at the site root, containing `google-site-verification: <file name>`. |
| `SITE_GOOGLE_SITE_VERIFICATION` | 20 to 100 letters, digits, `-` or `_` | Adds `<meta name="google-site-verification" content="…">` to the home page `<head>` only. |

`npm run siteground:env` sets both for boxs.ca (the real values belong to news.gov.bc.ca, so they prove nothing for boxs.ca; they let the rehearsal exercise the path). At cutover, set the values Search Console issues for the live domain. Clearing `SITE_GOOGLE_VERIFICATION_FILE` stops writing the file but does not delete one already written: remove it from `site-output/` by hand. Setting, changing or clearing either value is recorded in the render-state marker and queues exactly the static page (the file) and the home page (the meta), not a full rebuild.

### Carousel images

A slide or pin image lives at `<NRMS STORAGE_DIR>/slides/<sha256>.<png|jpg>` (content-addressed: the same image uploaded twice shares one file) and is served publicly at `/files/slides/…`, same as any other uploaded file. On start, NRMS writes a file for any stored slide or pin image that has none yet (the backfill for images stored before this change, or recovery after a lost file) and logs `[nrms] published <n> slide image files` when it writes any.

A `slides` event now carries each image's URL, storage key and SHA-256 instead of its bytes (C42, reversed — there's no longer a combined size limit; each image still keeps NRMS's own 2 MB upload limit). The News API fetches and verifies the bytes once while projecting the event, so v1 `/api/Slides` keeps returning base64, byte-identical to before. The fetch target is always `NEWSAPI_SLIDE_IMAGES_FETCH_BASE` plus the event's own storage key — never the event's own `imageUrl` (that has no host allow-list, and the fetch refuses a redirect too). `NEWSAPI_SLIDE_IMAGES_FETCH_BASE` is therefore **required**: the News API refuses to start without it. On the stack it's built in as `self:/files`, resolved in-process (SiteGround blocks loopback, so the News API can't reach its own public `https://boxs.ca/files/…`); a standalone deployment must set it to a route that reaches NRMS's files (Q85).

A stuck slide event (a mismatched hash, a missing file, or a file over 2 MB) fails the projection: NRMS's outbox keeps retrying it, and the carousel doesn't show the new image until it's fixed. `/stack/errors` shows `SlideImageError` for it; the slide and pin editors keep whatever image they last showed until the retry succeeds.

## Staff help and the exit checks (Phases 6d–6e)

### The internal similar route

`POST /api/v2/internal/similar` answers NRMS's "Similar published releases" panel. It accepts only a bearer token with the `NewsApi.Similar` role, verified the same way as the change feed (Entra with `NEWSAPI_AUTH_AUDIENCE`, or local tokens where `LOCAL_ADMIN_ENABLED=true`); with neither it answers 503. A staff session cookie never opens it. It uses AI matching only when this News API's own tenant config has `features.staffAi: true`, an embeddings provider is configured and pgvector is present; otherwise it answers in text mode and says so (`"mode": "text"`). At start the News API logs `staff AI is off: missing …` when the flag is on but something else is missing.

### Turning the flags on, and the PIA gate for staff AI

Both flags live in the tenant config (`config/tenants/<tenant>.json`), under `"features"`, and both are off by default. Changing one needs a restart (the stack reads the file at start).

- **`semanticSearch`** (public search and related posts). Safe to turn on once an embeddings provider is configured (`NEWSAPI_EMBEDDINGS_PROVIDER` plus the Azure settings, Q70) and the News API's database has pgvector (see "pgvector and the search mode"). `/stack/health` then reports `"newsApiSearch": "semantic"`; it stays `text` on boxs.ca, whose Postgres has no pgvector (Q80).
- **`staffAi`** (AI matching in "Similar published releases") **sends unpublished draft text to the AI service. Do not turn it on in any environment that holds real drafts until the privacy impact assessment approves it (D4, Q71).** NRMS and the News API each check their own copy of the flag: NRMS only asks for AI matching when its flag is on, and the News API only calls the provider when its own flag, a provider and pgvector are all present. On the stack both read the same `TENANT_CONFIG`; standalone, set it in both apps' tenant files. With it off, the panel still works with text matching, and nothing is sent anywhere but the News API.
- After turning `staffAi` on, check the News API's start log has no `staff AI is off: missing …` line, then press **Find similar** on a draft: results labelled *AI match* mean the whole path works.
- With `staffAi` on (and a provider and pgvector), the News API's embedding worker runs even when `semanticSearch` is off, because AI matching compares drafts with published posts' vectors. Search and related posts stay in text mode until `semanticSearch` is also on.

### Exit checks: site quality and the search spot-check

Both run on a developer machine (or in CI), never against boxs.ca. `npm run site:quality` needs Playwright's Chromium; `npm run search:spot-check` needs the local Postgres (`TEST_DATABASE_ADMIN_URL`) with pgvector, and creates and drops its own database. Once Azure is configured (Q70), run the spot-check with `EMBEDDINGS_PROVIDER=azure-openai`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` set: that's the relevance check the Phase 6 exit is waiting for.

## Hardening batch 1

**No migration.** **New tick step:** `calendar.orphan-sweep` (after `calendar.lock-sweep`). It
deletes Calendar attachment bytes that no attachment references any more (left behind when a
delete failed after a replace or remove), only once they are a day old, at most 50 per tick. A
failure logs "[calendar] orphan sweep could not delete a stored file" with the error's type only,
and it retries on its next pass.

**Hand check on boxs.ca:** run `bash scripts/siteground-website-walkthrough.sh`. Its file upload now sends the name in `X-GCPE-File-Name` and must still pass. Upload a release translation from the editor. The access log line for `POST /nrms/api/releases/<id>/files` must show `?kind=…&version=…` and no file name.

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
- **A media file or translation upload fails, especially a large one** (or a Website > Files upload,
  which NRMS allows up to 512 MiB): NRMS itself allows up to
  25 MiB for release files (`MAX_RELEASE_FILE_BYTES` in `apps/nrms/src/media/files.ts`), but SiteGround's nginx
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
  counts as the "same" cached response. Only the static site mount (`/`, plus `/site/*` while
  `SITE_PUBLIC_SITE_URL` still ends in `/site`) gets a real
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
- **The Calendar is optional until its database exists (`/calendar` 503).**
