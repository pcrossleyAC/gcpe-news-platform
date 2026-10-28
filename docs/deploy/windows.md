# Deploying to Windows Server + IIS

This is the runbook for running the GCPE News Platform on government Windows Servers: a Dev
server first, then Test and Production. It is written for the developer doing the setup. Every
step is a PowerShell command from the package in `deploy/windows/`; what each one does is listed
under it, so nothing happens that this page doesn't describe.

boxs.ca (SiteGround) stays as it is; [siteground.md](siteground.md) covers it and remains the
reference for what every setting means.

## How it fits together

```
                 ┌──────────────────────── app server ────────────────────────┐
 browser ──443──▶│ IIS (TLS, URL Rewrite + ARR) ──▶ 127.0.0.1:3000             │
                 │                                   gcpe-stack Windows service │
                 │                                   node.exe stack.js          │
                 │                                   (Core, NRMS, News API,     │
                 │                                    public site, NoD,         │
                 │                                    Distribution, Calendar)   │
                 │                                   C:\gcpe\data (files)       │
                 └────────────┬──────────────────────────┬──────────────────────┘
                              │ 5432                     │ 1433 (import only)
                 ┌────────────▼─────────────┐   ┌────────▼─────────────────────┐
                 │ PostgreSQL 17 + pgvector │   │ legacy SQL Server            │
                 │ 7 databases (gcpe_*)     │   │ Gcpe.Hub, Gcpe.NewsOnDemand  │
                 └──────────────────────────┘   └──────────────────────────────┘
```

- **The seven apps that replace the legacy Hub's applications run as one Node.js process**, one
  Windows service. There is no server per application any more.
- **The data is seven PostgreSQL databases on one PostgreSQL server**, the same shape as legacy's
  single SQL Server.
- **Dev:** the app and PostgreSQL on one server. **Test and Production:** PostgreSQL on its own
  server, owned and backed up like legacy's SQL Server.
- **The stack compresses its own text responses** (HTML, CSS, JS, JSON, SVG, XML: brotli, else
  gzip, from 1 KB up; `apps/stack/src/compress.ts`). IIS forwards them through ARR as they are, so
  the install needs no IIS dynamic compression (`Web-Dyn-Compression` is not installed, and must
  not be turned on for this site: it would only add CPU). Fonts and images are sent as they are.
  Check with `curl.exe -sI -H "Accept-Encoding: br" https://<host>/assets/legacy/Content/legacy.bundle.css`:
  expect one `content-encoding: br` and `vary: Accept-Encoding`.
- Run **one** app server per environment. Uploaded files, the generated public site and Calendar
  attachments live on its disk (`C:\gcpe\data`), and the background work (publishing, sending
  mail) runs inside the process; a second app server would need shared storage and has not been
  tested.

| | App server | Database server |
|---|---|---|
| Dev | `Install-Gcpe.ps1` (installs PostgreSQL too) | the same server |
| Test, Prod | `Install-Gcpe.ps1 -PostgresAdminUrl …` | `Install-GcpeDatabaseServer.ps1` |

## What the package contains

`gcpe-windows-<commit>.zip`, built by GitHub Actions (artifact **gcpe-windows** of the
`windows` and `deploy-windows-dev` workflows) or locally with `npm run build:windows`:

| | |
|---|---|
| `Install-Gcpe.ps1` | Sets up the app server and deploys the release. Safe to re-run. |
| `Deploy-GcpeRelease.ps1` | Deploys a new package; rolls back on its own if the new release isn't healthy. |
| `Import-GcpeLegacy.ps1` | Copies the legacy data from SQL Server, in the right order. Safe to re-run. |
| `Install-GcpeDatabaseServer.ps1` | Sets up a separate PostgreSQL server (Test, Prod). |
| `Install-GcpeRunner.ps1` | Installs the GitHub Actions runner that deploys pushes automatically. |
| `Get-GcpePrereqs.ps1` | Downloads every installer, for a server without internet access. |
| `app\` | The release: `stack.js`, the staff app, migrations, the bundled importers. |
| `prereqs\pgvector\` | pgvector compiled for PostgreSQL 17 on Windows (by CI). |
| `lib\` | Shared PowerShell, and the pinned installer list with SHA-256 hashes. |

Installers it pins (`lib\prereqs.psd1`): Node.js 24.21.0, IIS URL Rewrite 2.1, Application
Request Routing 3.0, WinSW 2.12.0, PostgreSQL 17.11 (EDB). Each is checked against its SHA-256
before it runs.

## Before you start

You need:

- [ ] **Windows Server 2019 or later**, 64-bit, 4+ cores, 8+ GB RAM, 50+ GB free on the system
      drive. The install is tested automatically on Server 2022 and 2025; GitHub has no 2019
      machines, so the first Dev install is the first run on 2019 (see "Not yet verified").
- [ ] A local **Administrator** account on it, and an elevated PowerShell (**Run as
      administrator**). Windows PowerShell 5.1, which comes with the server, is enough.
- [ ] **A DNS name** for the site, e.g. `news-dev.<ministry>.gov.bc.ca`, pointing at the server.
- [ ] **A TLS certificate** for that name in `Cert:\LocalMachine\My`, or nothing for Dev (the
      installer makes a self-signed one; browsers will warn).
- [ ] **An SMTP relay** the server may send through, a From address, and **a test inbox**: on Dev
      every outgoing email is redirected to that inbox, whoever it was addressed to.
- [ ] **A SQL Server login** (user name and password, not Windows authentication) with read
      access to the legacy `Gcpe.Hub` and `Gcpe.NewsOnDemand` databases. The importers only read.
- [ ] **Firewall openings from the app server:** to the legacy SQL Server on 1433, to the SMTP
      relay, to `github.com:443` (the deploy runner), and to the internet for the installers
      (or use `Get-GcpePrereqs.ps1` elsewhere and copy them over). Into the app server: 443 and
      80 from users.

Later, not needed for the first install: an **Entra app registration** for staff sign-in
(step 8), the **Media Hub** and **emergency alerts feed** addresses, **Flickr** keys, and
**Azure OpenAI** for semantic search (step 9).

## Step 1 — Get the package onto the server

1. In the GitHub repository, open **Actions → windows** (or **deploy-windows-dev**), pick the
   latest green run, and download the **gcpe-windows** artifact. It downloads as a zip
   containing `gcpe-windows-<commit>.zip`.
2. Copy `gcpe-windows-<commit>.zip` to the server, e.g. `C:\install\`.
3. On the server, in an elevated PowerShell:

   ```powershell
   cd C:\install
   Unblock-File .\gcpe-windows-*.zip
   Expand-Archive .\gcpe-windows-*.zip -DestinationPath .
   cd .\gcpe-windows
   ```

   `Unblock-File` stops Windows refusing to run scripts that came from the internet. If the
   execution policy still blocks them, run `Set-ExecutionPolicy -Scope Process RemoteSigned`
   in this window.

**No internet on the server?** Run `.\Get-GcpePrereqs.ps1` in the extracted folder on any
Windows machine that has internet access, then copy the whole `gcpe-windows` folder, now with
its `prereqs\` filled, to the server.

## Step 2 — (Test and Prod only) the database server

On the database server, from the same package:

```powershell
.\Install-GcpeDatabaseServer.ps1 -AppServerAddress <app server IP>
```

It installs PostgreSQL 17 (service `postgresql-x64-17`, data in `C:\gcpe\pgdata`) with a
generated superuser password saved to `C:\gcpe\config\postgres-superuser.txt` (Administrators
only), installs pgvector, allows connections from the app server's address only (`pg_hba.conf`
and Windows Firewall), and prints the `-PostgresAdminUrl` to use in step 3. Skip this step on Dev.

## Step 3 — Install on the app server

Dev (PostgreSQL on the same server, self-signed certificate):

```powershell
.\Install-Gcpe.ps1 -HostName news-dev.example.gov.bc.ca `
    -SmtpHost apps.smtp.gov.bc.ca -MailFrom noreply-dev@gov.bc.ca -MailRedirectTo you@gov.bc.ca
```

It asks for a password for the break-glass `admin` login (12+ characters). Keep it in the team's
password manager.

Test/Prod add `-PostgresAdminUrl postgres://postgres@<database server>:5432/postgres` (it asks
for the superuser password, from step 2's `postgres-superuser.txt`) and
`-CertificateThumbprint <thumbprint>`.
All the options: `Get-Help .\Install-Gcpe.ps1 -Full`.

What it does, in order (a full log goes to `C:\gcpe\logs\install-<time>.log`):

1. Installs IIS with WebSockets, URL Rewrite, ARR, Node.js and (Dev) PostgreSQL 17 with pgvector.
   PostgreSQL's superuser password is generated and saved to `C:\gcpe\config\postgres-superuser.txt`.
2. Writes `C:\gcpe\config\gcpe.env`: every setting, with fresh random internal secrets and the
   admin password stored only as a hash. Only Administrators and the service can read it. On a
   re-run the file is kept as it is.
3. Creates the PostgreSQL login `gcpe_app` and the databases `gcpe_core`, `gcpe_nrms`,
   `gcpe_news_api`, `gcpe_site`, `gcpe_nod`, `gcpe_distribution`, `gcpe_calendar`, and enables
   pgvector in `gcpe_news_api`. The tables are created by the app itself when it starts.
4. Installs the **gcpe-stack** Windows service: `node.exe --env-file=C:\gcpe\config\gcpe.env
   C:\gcpe\current\stack.js`, running as the virtual account `NT SERVICE\gcpe-stack`, which can
   change only `C:\gcpe\data` and its own logs. Automatic start; restarted by Windows if it stops.
5. Blocks inbound connections to port 3000 (only IIS on the same server talks to it).
6. Creates the IIS site **GCPE**: https on 443 with the certificate, http on 80 redirecting to
   https, forwarding every request to `127.0.0.1:3000` and telling the app it came in over https.
   If the **Default Web Site** was using port 80 or 443, it is stopped.
7. Deploys the release (step 10's script) and checks `/stack/health` directly and through IIS.

Re-running `Install-Gcpe.ps1` is safe; use it to repair a setup or to apply a new package's
server changes. A re-run keeps `gcpe.env` (it says which options it ignored because of that),
keeps the certificate already bound to port 443 unless you pass `-CertificateThumbprint`, and
refuses to run without `-PostgresAdminUrl` when the databases are on another server.

### Check it

| | |
|---|---|
| `https://<host>/stack/health` | `{"status":"ok", "apps": {… all true}}` |
| `https://<host>/hub/` | The staff app. Sign in as `admin`. |
| `https://<host>/` | The public news site (nearly empty until step 4). `/site/…` URLs 301 here. |

**Upgrading an existing install.** A re-run keeps `gcpe.env`, so an install made before the
public site moved to the root still has `SITE_PUBLIC_SITE_URL` and `NOD_PUBLIC_SITE_URL` ending
in `/site`. It keeps working — the site answers at both `/site/…` and `/…` — until you change
them. To move to the root, set both to the origin (`https://<host>`, no `/site`) in `gcpe.env`
and restart the `gcpe-stack` service. The site-state marker records the base URL, so the
change queues one rebuild-all, which the next ticks drain; `/site/…` then 301s to `/…`.

**Upgrading to a release that changes the page chrome** (`RENDER_CHROME_VERSION` in
`apps/public-site/src/rebuild.ts`, such as parity plan 1's new header and footer): the first start
queues one rebuild-all, and `theme.css` and the shared assets change at once. Until the ticks
have rewritten a page, that page still has the old markup under the new stylesheets, so its
header and footer can look unstyled. On a site with the full legacy import (tens of thousands of
releases) the drain takes much longer than on a test site: deploy outside busy hours, and watch
the queue drain in `/hub/error-log` and on a few old release pages.

**The public site stops publishing when the ministry list can't be read.** Each sync turn reads
the News API's ministries for the header's menu; if that call fails, the whole turn is retried
on the next tick and no page is published until it succeeds (this keeps a page from going out
with an empty News menu). If releases stop appearing on the site, check `/hub/error-log` for a
failed site sync step (`[stack] tick step failed` naming the public site's sync, with the News
API's ministries call or "returned no ministries" as the cause) before anything else.

## Step 4 — Import the legacy data

With the site running:

```powershell
.\Import-GcpeLegacy.ps1 -SqlServer <legacy SQL Server> -SqlUser <login> -CalendarCutoff 2025-11-01
```

It asks for the SQL login's password and the `admin` password, then runs, in order:

1. **Core**: ministries, sectors, themes, tags (from `Gcpe.Hub`).
2. **News API**: the published news, home page, slides and resource links.
3. **NRMS**: users (as inactive accounts, matched by email), media lists, every release in every
   status, the website settings. Nothing is published and nobody is emailed: imported scheduled
   releases are put on hold.
4. Signs in as `admin`, asks Core and NRMS to send their data to the other apps, and waits for
   NoD to receive every media list.
5. **NoD**: subscribers, lists and the last 30 days of sends (from `Gcpe.NewsOnDemand`).
6. **Calendar**: a **dry run** that changes nothing. Read `calendar-import.txt`, then run it for
   real: `.\Import-GcpeLegacy.ps1 … -Only Calendar -CalendarCutoff 2025-11-01 -ConfirmCalendar`.

Reports and logs land in `C:\gcpe\import-reports\<time>\`. Each report lists, per legacy table,
the rows seen, imported and skipped (with the reason); `balanced` means nothing went missing. A
step whose report doesn't balance is flagged and the run carries on; a step that fails stops the
run, and re-running is safe (nothing is duplicated, and anything staff changed in the new system
since the last import is kept and listed).

Run one step on its own with `-Only Core` (or `NewsApi`, `Nrms`, `Nod`, `Calendar`). What each
importer reads and how it treats a re-run is in [siteground.md](siteground.md), "Importing legacy
NRMS / NoD / Calendar data".

**Translations and media assets.** The News API step copies posts from SQL, but legacy keeps
their translation PDFs and media assets in Azure, which stays up. `import:files` fills in each
legacy post's links from the public legacy API (`api.news.gov.bc.ca`); this server needs
outbound HTTPS to it. It is not part of `Import-GcpeLegacy.ps1`: run it by hand after the News
API step, days before cutover; then, after the last legacy import and before
`api.news.gov.bc.ca` is repointed, a plain run (picks up flagged posts not filled yet; it never
revisits filled ones) and a `--refresh --since <full-run date minus 30 days>` run (asks again for
recent posts). See the URL cutover runbook, section 3. From the live release:

```powershell
$env:DATABASE_URL = ((Get-Content C:\gcpe\config\gcpe.env | Where-Object { $_ -like 'NEWSAPI_DATABASE_URL=*' }) -split '=', 2)[1]
node.exe C:\gcpe\current\tools\news-api-import-files.mjs --dry-run         # real count and hours; sends nothing
node.exe C:\gcpe\current\tools\news-api-import-files.mjs --concurrency 2
node.exe C:\gcpe\current\tools\news-api-import-files.mjs                                 # catch-up
node.exe C:\gcpe\current\tools\news-api-import-files.mjs --refresh --since 2026-10-01
Remove-Item Env:DATABASE_URL
```

What it reads, its options, and how it stops on a 429 are in [siteground.md](siteground.md),
"Legacy translations and media assets". Not run on Windows from here.

**Cutover only, never on Dev while legacy is live:** turning legacy's publisher off and handing
scheduling to NRMS (`replay-to-news-api`, `release-holds`) is in siteground.md, "Cutover order".

## Step 5 — Move the repository to bcgov-c

1. Create a **private** repository in the `bcgov-c` organization (an org owner may need to do it),
   e.g. `bcgov-c/gcpe-news-platform`.
2. Before pushing, scan the history for secrets: `gitleaks git` in a clone (nothing should be
   found: settings live in `gcpe.env` on servers, never in the repository).
3. Push every branch except `deploy/siteground` (the boxs.ca build output):

   ```sh
   git remote add bcgov https://github.com/bcgov-c/gcpe-news-platform.git
   git push bcgov main
   git push bcgov main:develop
   ```

4. In the new repository's **Settings**:
   - **Branches:** protect `main` and `develop` (pull request with an approving review, the
     `ci` and `windows` checks passing).
   - **Environments → New environment `dev`:** add yourself (and the team lead) as required
     reviewers if Dev deploys should wait for a click; restrict it to the `develop` branch.

## Step 6 — Install the deploy runner on the Dev server

GitHub can't reach into the government network, so the Dev server reaches out instead: a
GitHub Actions *self-hosted runner* on it connects to `github.com` over HTTPS and waits for
deploy jobs. Nothing inbound is opened.

1. In the repository: **Settings → Actions → Runners → New self-hosted runner → Windows**. Copy
   the token from the `config.cmd` line (valid for one hour).
2. On the Dev server, from the package folder:

   ```powershell
   .\Install-GcpeRunner.ps1 -RepositoryUrl https://github.com/bcgov-c/gcpe-news-platform -Token <token> -Labels gcpe-dev
   ```

3. Back in **Settings → Actions → Runners**, the server shows as **Idle**.

The runner runs as a Windows service under LocalSystem, because a deploy stops and starts the
gcpe-stack service. Anyone who can change `.github/workflows/deploy-windows-dev.yml` on
`develop` can therefore run commands on the Dev server, which is why step 5 protects `develop`.
If the server needs an outbound proxy for github.com, set it first:
`[Environment]::SetEnvironmentVariable('https_proxy','http://proxy:port','Machine')`, then
restart the runner service.

## Step 7 — From your code to Dev

Day to day:

1. Branch from `develop`, commit, push, and open a pull request into `develop`. The `ci` (Linux)
   and `windows` checks run on it; `windows` also installs the whole package on a clean Windows
   Server and checks it.
2. Merge the pull request. The **deploy-windows-dev** workflow then runs by itself:
   1. runs the tests,
   2. builds the package (`gcpe-windows` artifact),
   3. waits for the `dev` environment's approval, if you set one,
   4. on the Dev server's runner, runs `Deploy-GcpeRelease.ps1`, which copies the release,
      checks it against the server's settings, switches the site to it, applies any database
      migrations, checks health directly and through IIS, and **rolls back to the previous
      release by itself** if the new one isn't healthy.
3. Watch it under **Actions → deploy-windows-dev**. A red deploy job means the site is still on
   the previous release; the job log says why.

You can also start a deploy by hand: **Actions → deploy-windows-dev → Run workflow**. Your own
GitHub login is only used to push and to approve; the server never sees it, and no secrets are
stored in GitHub (they're in `gcpe.env` on the server).

## Step 8 — Staff sign-in with Microsoft Entra

Until this is done, staff sign in with passwords set in the Hub's **Users** screen, and `admin`
is the way in.

1. Ask the Entra administrators for an app registration: platform **Web**, redirect URI
   `https://<host>/core/auth/entra/callback`, single tenant, a client secret, delegated
   permissions `openid`, `profile`, `email`. Roles stay in the Hub, not in Entra. Its manifest
   needs `"accessTokenAcceptedVersion": 2`.
2. Add to `C:\gcpe\config\gcpe.env` (Notepad, as Administrator):

   ```
   ENTRA_TENANT_ID=<tenant id>
   CORE_ENTRA_CLIENT_ID=<client id>
   CORE_ENTRA_CLIENT_SECRET='<client secret>'
   CORE_PUBLIC_BASE_URL=https://<host>
   CORE_AUTH_AUDIENCE=api://<client id>
   NRMS_AUTH_AUDIENCE=api://<client id>
   NEWSAPI_AUTH_AUDIENCE=api://<client id>
   SITE_AUTH_AUDIENCE=api://<client id>
   NOD_AUTH_AUDIENCE=api://<client id>
   DIST_AUTH_AUDIENCE=api://<client id>
   CALENDAR_AUTH_AUDIENCE=api://<client id>
   ```

   (On a fresh server, `Install-Gcpe.ps1 -EntraTenantId … -EntraClientId … -EntraClientSecret …
   -EntraAudience …` writes the same lines.)
3. `Restart-Service gcpe-stack`, then check `https://<host>/stack/health`.
4. Each person signs in with Microsoft once their Hub user exists with their government email.
   Details: siteground.md, "Staff sign-in with Microsoft Entra".

## Step 9 — Connect the outside services

Until these are set, the stack uses built-in fakes and says so in its log. Add each to
`gcpe.env`, then `Restart-Service gcpe-stack`:

| Service | Settings | Notes |
|---|---|---|
| Media Hub (NoD) | `NOD_MEDIA_HUB_URL`, `NOD_MEDIA_HUB_TOKEN_URL`, `NOD_MEDIA_HUB_CLIENT_ID`, `NOD_MEDIA_HUB_CLIENT_SECRET`, `NOD_MEDIA_HUB_SCOPE` | |
| Emergency alerts feed | `NOD_EMERGENCY_FEED_URL=https://www.emergencyinfobc.gov.bc.ca/category/alerts/feed/?hide_expired=true` | Must be the final URL, no redirect. |
| Flickr (NRMS) | `NRMS_FLICKR_API_KEY`, `NRMS_FLICKR_API_SECRET`, `NRMS_FLICKR_ACCESS_TOKEN`, `NRMS_FLICKR_ACCESS_SECRET`, `NRMS_FLICKR_ALERT_EMAILS` | siteground.md, "Flickr". |
| Semantic search | `NEWSAPI_EMBEDDINGS_PROVIDER=azure-openai`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`, and `"semanticSearch": true` in `config\tenants\bc.json` | pgvector is already on. `/stack/health` then says `"newsApiSearch": "semantic"`. Never turn on `staffAi` before the privacy impact assessment approves it. |
| Google Search Console (public site) | `SITE_GOOGLE_VERIFICATION_FILE`, `SITE_GOOGLE_SITE_VERIFICATION` | Optional. On first install pass `-GoogleVerificationFile` and `-GoogleSiteVerification` to `Install-Gcpe.ps1`, which writes them to `gcpe.env` (formats are checked, so a bad value is refused); on an existing install add them to `gcpe.env` and restart. Windows Server is the production host: while `SITE_ENVIRONMENT=test` is set the site is noindex and `robots.txt` is `Disallow: /`, so at go-live remove that line and set the values Search Console issues for the live domain. Details: siteground.md, "Robots and Google Search Console verification". |
| Real mail | remove `DIST_MAIL_REDIRECT_TO` | Only when this server should email real people. |

## Step 10 — Running it

| Task | How |
|---|---|
| Deploy a package by hand | `.\Deploy-GcpeRelease.ps1 -Package C:\drops\gcpe-windows-<commit>.zip` |
| Roll back | Deploy the previous package again; or `Stop-Service gcpe-stack`, point the junction at an older folder with `cmd /c rmdir C:\gcpe\current` and `New-Item -ItemType Junction -Path C:\gcpe\current -Target C:\gcpe\releases\<older>`, `Start-Service gcpe-stack`. The last five releases are kept. A rollback doesn't undo database migrations; they are additive, so the older release still runs. |
| Change a setting | Edit `C:\gcpe\config\gcpe.env` as Administrator, then `Restart-Service gcpe-stack`. |
| Restart | `Restart-Service gcpe-stack` (IIS doesn't need restarting). |
| Logs | The stack: `C:\gcpe\service\logs\gcpe-stack.out.log` and `.err.log`. Errors staff saw: `/hub/error-log`. IIS: `C:\inetpub\logs\LogFiles`. |
| Health | `https://<host>/stack/health`; `curl.exe http://127.0.0.1:3000/stack/health` on the server skips IIS. |
| Back up the databases | `pg_dump -Fc` each `gcpe_*` database (in `C:\Program Files\PostgreSQL\17\bin`), plus `C:\gcpe\data` and `C:\gcpe\config`. On Test/Prod the DBAs' usual PostgreSQL backups replace this. |
| Renew the certificate | Import the new one into `LocalMachine\My`, then re-run `Install-Gcpe.ps1 -HostName <host> -CertificateThumbprint <new>`. |

What is where on the app server:

```
C:\gcpe\
  current\            → junction to the live release
  releases\<time>-<commit>\
  config\gcpe.env     every setting and secret (Administrators + the service only)
  config\postgres-superuser.txt   (Dev: PostgreSQL superuser password, Administrators only)
  data\               uploaded files, the generated public site, Calendar files, error log
  pgdata\             (Dev) PostgreSQL's data
  service\            the WinSW service wrapper and the stack's logs
  site\web.config     the IIS site: forwarding rules only
  import-reports\     one folder per import run
  logs\               install logs
```

## Not yet verified

Checked automatically on every pull request (`windows` workflow, Windows Server 2022 and 2025):
the full test suite; a clean install with `Install-Gcpe.ps1`; the site, staff app, https redirect
and admin sign-in through IIS; a second run of the installer; the automatic rollback of a broken
release; the bundled importers starting and connecting out. Checked by hand on a Mac, from the
built package against a copy of `Gcpe.Hub`: the Core, News API (34,895 releases, under 2 minutes)
and NRMS (balanced, about 3 minutes) imports, and the Calendar dry run.

Not yet checked anywhere:

- **Windows Server 2019** itself (GitHub has no 2019 machines). Everything used is supported on
  2019, but the first Dev install is the first real run.
- **The legacy import on Windows against the real legacy SQL Server**, and how long it takes.
- **The NoD import against real data**: the copy used for the check above has no
  `Gcpe.NewsOnDemand` database (the importer's own tests cover it).
- **SQL Server with Windows authentication only**: the importers need a SQL login.
- **Entra sign-in** end to end on a government tenant.
- **WebSockets through IIS** for the News API's live-updates hub (`UPDATES_HUB_ENABLED=true`).
- **Uploads refused as too large** (over 25 MB on the Calendar): on Windows the browser may see
  a dropped connection instead of the "file too large" message.
- **A GitHub runner behind the government proxy.**
- **Production settings:** this package writes a *test site* configuration (break-glass local
  admin on, mail redirected). Production needs Entra for the apps' calls to each other and local
  admin off; that comes before the first Production install.
