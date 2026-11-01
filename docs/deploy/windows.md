# Deploying to Windows Server + IIS

This is the runbook for running the GCPE News Platform (the replacement for news.gov.bc.ca and the
staff Hub) on government Windows Servers. It is written for a Windows/IIS technician who has not
seen the project before. It goes server by server: **Dev**, then **Test**, then **Prod**. Every
step is a command from the package (`deploy/windows/` in the repository), followed by a **Check
it** block: the exact command to run and what it must print. Do not go to the next step until the
check passes.

boxs.ca (SiteGround) stays as it is; [siteground.md](siteground.md) covers it and remains the
reference for what every setting in `gcpe.env` means.

Contents:

1. [Overview](#1-overview)
2. [Before you start](#2-before-you-start)
3. [Dev server](#3-dev-server)
4. [Test: app server, then DMZ proxy](#4-test-app-server-then-dmz-proxy)
5. [Prod](#5-prod)
6. [After every deploy](#6-after-every-deploy)
7. [Operations](#7-operations)
8. [DMZ proxy reference](#8-dmz-proxy-reference)
9. [Not yet verified](#9-not-yet-verified)

Conventions:

- Every command runs in an **elevated** PowerShell (**Run as administrator**). Windows
  PowerShell 5.1, which comes with Windows Server, is enough.
- `<…>` is a value you fill in. `news-test.example.gov.bc.ca` and the `10.40.x.x` addresses are
  examples only.
- **Public host** means the name the public types (for example `news-test.example.gov.bc.ca`).
  **Internal host** means the app server's own name on the government network (for example
  `gcpe-test-app.<internal domain>`), which staff use for the Hub.

## 1. Overview

### What runs where

```
 DEV (internal only, never public)
   staff ──443──▶ [ Dev app server ]  IIS "GCPE" ─▶ 127.0.0.1:3000 gcpe-stack service ─▶ PostgreSQL 17 (same server)

 TEST (now)
   internet ──443/80──▶ [ DMZ proxy #1 ]  IIS "GCPE-Proxy": public paths only, 404 for the rest
                              │ 443 only
                              ▼
   staff ───────443──▶ [ Test app server ]  IIS "GCPE" ─▶ gcpe-stack ─▶ PostgreSQL 17 (same server)

 PROD (later)
   internet ──443/80──▶ [ DMZ proxy #2 ]  (+ planned: static copy of the public site for patch reboots)
                              │ 443 only
                              ▼
   staff ───────443──▶ [ Prod app server ]  IIS "GCPE" ─▶ gcpe-stack
                              │ 5432 only
                              ▼
                        [ Prod database server ]  PostgreSQL 17 + pgvector
```

| Server | Windows | Installed with | Holds |
|---|---|---|---|
| Dev app server (internal) | Server 2025 | `Install-Gcpe.ps1` | the app, PostgreSQL, uploaded files, every secret |
| Test app server (internal) | Server 2025 | `Install-Gcpe.ps1 -ProxyHops 2 -AllowedClientRanges …` | the same |
| DMZ proxy #1 (Test) | Server 2025 | `Install-GcpeProxy.ps1 -Environment Test` | IIS only, the public TLS certificate, a page cache |
| DMZ proxy #2 (Prod) | Server 2025 | `Install-GcpeProxy.ps1 -Environment Prod`, once Prod's app server exists | the same |
| Prod app server (later) | Server 2025 | `Install-Gcpe.ps1 -PostgresAdminUrl … -ProxyHops 2 -AllowedClientRanges …` | the app, uploaded files, every secret |
| Prod database server (later) | Server 2025 | `Install-GcpeDatabaseServer.ps1` | PostgreSQL |

- **One app server per environment runs everything** as one Windows service, `gcpe-stack`
  (`node.exe stack.js`): the staff Hub (Core, NRMS, NoD, Distribution, Calendar), the News API and
  the public site. There is no server per application.
- **The data is seven PostgreSQL databases** (`gcpe_core`, `gcpe_nrms`, `gcpe_news_api`,
  `gcpe_site`, `gcpe_nod`, `gcpe_distribution`, `gcpe_calendar`) plus files on the app server's
  disk under `C:\gcpe\data`. There is no separate database team: **backups are this team's job**
  ([7.1](#71-backups-and-the-restore-drill)).
- **Run only one app server per environment.** Uploaded files, the generated public site and the
  Calendar attachments live on its disk, and the background work (publishing, sending mail) runs
  inside the process. A second app server would need shared storage and has not been tested.
- **The stack compresses its own responses** (brotli or gzip). IIS forwards them as they are, so
  IIS dynamic compression (`Web-Dyn-Compression`) is not installed and must not be turned on.

### Why only IIS is in the DMZ

The DMZ server is the one the internet can reach. If it were broken into, the attacker should find
nothing worth having: no app code, no database, no database password, no `gcpe.env` secrets, no
staff sessions. So it runs IIS with URL Rewrite and ARR only. It forwards the public paths (the
news site, its files, the public News API and the subscribe API) to the internal app server over
HTTPS, and answers every other path, including the whole Hub, with its own 404
([8.1](#81-what-the-proxy-forwards)). Staff never go through the DMZ: they use the Hub on the app
server's internal host name (over VPN when they are off the network).

The app server's IIS accepts port 443 only from the DMZ proxy and the named staff ranges
(`-AllowedClientRanges`, Windows Firewall), and it never reaches into the DMZ.

### What the package contains

`gcpe-windows-<commit>.zip`, built by GitHub Actions (artifact **gcpe-windows** of the `windows`
and `deploy-windows-dev` workflows) or locally with `npm run build:windows`:

| | |
|---|---|
| `Install-Gcpe.ps1` | Sets up an app server and deploys the release. Safe to re-run. |
| `Deploy-GcpeRelease.ps1` | Deploys a new package; rolls back on its own if the new release isn't healthy. |
| `Import-GcpeLegacy.ps1` | Copies the legacy data from SQL Server, in the right order. Safe to re-run. |
| `Install-GcpeDatabaseServer.ps1` | Sets up a separate PostgreSQL server (Prod). |
| `Install-GcpeProxy.ps1` | Sets up a DMZ server as the public reverse proxy (Test, Prod). |
| `Register-GcpeBackup.ps1` | Schedules the nightly backup and runs it once. |
| `Backup-Gcpe.ps1` | One backup run (what the nightly task runs; also by hand). |
| `Install-GcpeRunner.ps1` | Installs the GitHub Actions runner that deploys pushes to Dev. |
| `Get-GcpePrereqs.ps1` | Downloads the installers (`-Names` for some only), for a server without internet access. |
| `app\` | The release: `stack.js`, the staff app, migrations, the bundled command-line tools. |
| `prereqs\pgvector\` | pgvector compiled for PostgreSQL 17 on Windows (by CI). |
| `lib\` | Shared PowerShell, and the pinned installer list with SHA-256 hashes. |

The same build also makes **`gcpe-proxy-<commit>.zip`** (artifact **gcpe-proxy**): only
`Install-GcpeProxy.ps1`, `Get-GcpePrereqs.ps1` and `lib\`, for the DMZ server. It never carries the
app, the importers or anything secret.

GitHub keeps CI artifacts for 14 days only: **keep a copy of every package you install** (the zip
and its `Get-FileHash` value) on a share, so Test and Prod can be given exactly what Dev ran, and a
rollback has its package.

Installers it pins (`lib\prereqs.psd1`): Node.js 24.21.0, IIS URL Rewrite 2.1, Application Request
Routing 3.0, WinSW 2.12.0, PostgreSQL 17.11 (EDB). Each is checked against its SHA-256 before it
runs. `Get-Help .\<script>.ps1 -Full` describes every script and every parameter.

## 2. Before you start

### 2.1 Checklist per environment

Every server: **Windows Server 2025**, 64-bit, joined to the domain (internal servers), a local
Administrator account, and:

- time synchronised to the government NTP source (embargo times depend on the clock:
  `w32tm /query /status` shows the source), and the same time zone everywhere:
  `Set-TimeZone -Id 'Pacific Standard Time'` (check: `Get-TimeZone`);
- Windows Update set to **download but not restart by itself** (your WSUS/GPO policy): a reboot of
  the app server or the DMZ proxy takes the public site down ([7.4](#74-patching)), so restarts
  happen in a patch window you choose.

| | Dev | Test | Prod |
|---|---|---|---|
| Servers | 1 internal: app + PostgreSQL | 1 internal (app + PostgreSQL), 1 DMZ (proxy #1) | 2 internal (app; database), 1 DMZ (proxy #2) |
| Size (app server) | 4+ cores, 8+ GB RAM, 50+ GB free | the same; add the legacy data and files (measure `C:\gcpe\data` on Dev after the import) | the same; database server sized like the Test app server |
| Size (DMZ) | — | 2 cores, 4 GB, 20 GB free (5 GB cache by default) | the same |
| Public host | none | e.g. `news-test.<domain>` (DMZ proxy) | `news.gov.bc.ca` and the other names in the URL cutover runbook (`docs/parity/url-cutover-runbook.md` §4) |
| Internal host | e.g. `gcpe-dev-app.<internal domain>` | e.g. `gcpe-test-app.<internal domain>` | e.g. `gcpe-prod-app.<internal domain>`, and the database server's name |
| Certificates | none needed (self-signed is made) or one for the internal host | app server: internal host; DMZ: public host (see 2.2) | the same, publicly trusted on the DMZ |
| Entra app registration | optional (break-glass `admin` works without it) | yes | yes |
| SMTP relay | yes, all mail redirected to a test inbox | yes, all mail redirected | yes, real mail |
| Backup share | a share on another server (or a local folder) | a share on another server | a share on another server; WAL archive share too |
| Legacy SQL Server login | yes (import) | yes (import) | yes (final import) |

Collect before the first install:

- [ ] **The IPv4 addresses** of every server, and the **staff ranges** (CIDR, for example
      `142.22.0.0/16`) that may use the Hub. Also the **staff egress ranges**: the addresses staff
      appear from on the internet (the government's outbound NAT), used to keep Test's public site
      closed to everyone else until T5.
- [ ] **The DMZ proxy's address as the app server sees it.** If the network translates (NAT) the
      DMZ server's address on the way in, the app server sees the translated address: that is the
      one `-AllowedClientRanges <address>/32` needs. Ask the network team.
- [ ] **A SQL Server login** (user name and password; Windows authentication is not supported)
      with read access to the legacy `Gcpe.Hub` and `Gcpe.NewsOnDemand` databases. The importers
      only read.
- [ ] **The SMTP relay**: host, port (25 by default), whether it needs TLS (`-SmtpSecure`) or a
      login, the From address, and **a test inbox**: Dev and Test redirect every outgoing email to
      it, whoever it was addressed to.
- [ ] **A password manager entry** for the break-glass `admin` login of each environment (12+
      characters).
- [ ] **A backup share** (`\\<backup server>\<share>`), on a different server, whose share and
      folder permissions allow only the backup administrators and the computer accounts of the
      servers that write to it (`<DOMAIN>\<server>$`, Change or Full Control). Backups contain
      `gcpe.env` (every secret) and the subscribers' e-mail addresses. Whoever restores needs an
      account that can read it (a member of the file server's Administrators, or one the share
      owner adds).
- [ ] Later (step D7 and D8): the **Entra app registration**, the **Media Hub** address and client
      credentials, the **emergency alerts feed** address, **Flickr** keys, and **Azure OpenAI** for
      semantic search (only after the privacy impact assessment allows it).

Service accounts: none to request. The app runs as the virtual account `NT SERVICE\gcpe-stack`
(created by the installer). The scheduled tasks (backup, log cleanup) run as `SYSTEM`, which
reaches the backup share as the server's computer account. The Dev deploy runner runs as
`LocalSystem`.

### 2.2 Certificates

| Server | The certificate must carry | Store | Notes |
|---|---|---|---|
| App server (all environments) | its **internal host** name | `Cert:\LocalMachine\My`, with private key | Staff browse to it; the DMZ proxy connects to it by that name. Internal CA is fine: the DMZ server then needs the CA's root (and any intermediate) certificates (T2). |
| DMZ proxy | the **public host** name (and any other public names) | `Cert:\LocalMachine\My`, with private key | Publicly trusted for Prod (the script refuses a self-signed one with `-Environment Prod`). Test may use a self-signed one while it is IP-restricted. |
| Prod database server | none | | PostgreSQL connections are not encrypted (see [9](#9-not-yet-verified)). |

**The public host name does not need to be on the app server's certificate**, even though the
proxy passes the visitor's `Host` header (the public name) on to the app server. Two reasons:

- the app server's IIS binds its certificate to `0.0.0.0:443` with no host name (no SNI), so it
  presents the same certificate whatever `Host` says; and
- ARR checks the app server's certificate against the name in `-Upstream`, not against `Host`.

Verified on Windows Server 2022 and 2025 GitHub runners (workflow `windows`, run 40796381759): the
proxy was installed with public host `gcpe-proxy-ci.example.test`, which is not on the app's
certificate (it carries `gcpe-ci.example.test` and `localhost`), and `-Upstream https://localhost`;
public pages came back 200 through the proxy over verified TLS.

**Alternative when the app server only has the installer's self-signed certificate** (it carries
the `-HostName` you gave `Install-Gcpe.ps1`, which for Test is the public host, plus `localhost`):
give the proxy `-Upstream https://<public host>`, add `<app server IP> <public host>` to the DMZ
server's `C:\Windows\System32\drivers\etc\hosts`, and `-UpstreamCertificateFile` the exported
self-signed certificate. Staff then get a browser warning on the internal host, so prefer a real
internal-CA certificate.

### 2.3 Entra (staff sign-in) per environment

Staff sign in on the **internal host**, so each environment needs its own redirect URI on that
host. Ask the Entra administrators for one app registration per environment (or one with every
redirect URI):

| Environment | Redirect URI (platform **Web**) |
|---|---|
| Dev | `https://<Dev internal host>/core/auth/entra/callback` |
| Test | `https://<Test internal host>/core/auth/entra/callback` |
| Prod | `https://<Prod internal host>/core/auth/entra/callback` |

Single tenant, a client secret, delegated permissions `openid`, `profile`, `email`; the manifest
needs `"accessTokenAcceptedVersion": 2`. Under **Expose an API**, set the Application ID URI to
`api://<client id>`: that is the audience every app checks (`<PREFIX>_AUTH_AUDIENCE` in D7), and
setting `ENTRA_TENANT_ID` turns those checks on in every app, so the site won't start until all
seven audiences are set. Roles stay in the Hub, not in Entra. The callback is
under `/core`, which the DMZ proxy never forwards, so it must be the internal host.

### 2.4 Firewall requests

Inbound:

| Source | Destination | Port | Purpose |
|---|---|---|---|
| internet | DMZ proxy (Test, Prod) | TCP 443 | the public site |
| internet | DMZ proxy | TCP 80 | redirects to 443 only |
| DMZ proxy | its environment's app server | TCP 443 | the only way in from the DMZ (if NAT changes the DMZ server's address, the app server's `-AllowedClientRanges` names the translated one) |
| staff ranges (named) | app server (Dev, Test, Prod) | TCP 443 (and 80, which redirects) | the Hub, on the internal host |
| Prod app server | Prod database server | TCP 5432 | PostgreSQL (`Install-GcpeDatabaseServer.ps1` opens it to that address only) |
| your admin workstations | every server | RDP / WinRM per your standard | administration |
| anything else | app server 443 | — | **closed** ([8.3](#83-why-the-app-servers-443-must-be-closed-to-everyone-else)) |
| DMZ proxy | anything internal other than its app server's 443 | any | **closed**: the DMZ never reaches a database or SQL Server |

Outbound from the app server (verified against the code and settings named; open each only when
you configure that service):

| Destination | Port | When | Setting |
|---|---|---|---|
| SMTP relay | TCP 25 (or your `-SmtpPort`) | always | `DIST_SMTP_HOST`, `DIST_SMTP_PORT` |
| `login.microsoftonline.com` | TCP 443 | Entra sign-in configured | `ENTRA_TENANT_ID` (sign-in and token keys) |
| `graph.microsoft.com` (and `login.microsoftonline.com`) | TCP 443 | only if bounce reading via Microsoft Graph is turned on | `DIST_BOUNCE_SOURCE=graph` |
| Media Hub host(s) | TCP 443 | Media Hub configured | `NOD_MEDIA_HUB_URL`, `NOD_MEDIA_HUB_TOKEN_URL` |
| `api.flickr.com`, `www.flickr.com` | TCP 443 | Flickr configured | NRMS `FLICKR_REST_URL`, `FLICKR_OEMBED_URL`, `FLICKR_OAUTH_URL` defaults |
| your Azure OpenAI endpoint host | TCP 443 | semantic search turned on | `NEWSAPI_AZURE_OPENAI_ENDPOINT` |
| `www.emergencyinfobc.gov.bc.ca` | TCP 443 | emergency alerts feed configured | `NOD_EMERGENCY_FEED_URL` |
| legacy SQL Server | TCP 1433 (a named instance: also UDP 1434, the SQL Browser, or its fixed port) | import period only | `Import-GcpeLegacy.ps1 -SqlServer` |
| `api.news.gov.bc.ca`, `bcgovnews-etg7c8etapa6btfr.z03.azurefd.net` (legacy files on Azure) | TCP 443 | import period only (`news-api-import-files.mjs`, `legacy-files-copy.mjs`) | defaults in `apps/news-api/src/import/public-fetch.ts`, `public-files.ts`, `apps/stack/src/legacy-files/options.ts` |
| backup share server | TCP 445 (SMB) | always | `Register-GcpeBackup.ps1 -BackupPath` |
| `github.com`, `api.github.com`, `codeload.github.com`, `*.actions.githubusercontent.com`, `results-receiver.actions.githubusercontent.com`, `*.blob.core.windows.net` (job logs and artifacts) | TCP 443 | **Dev only** (deploy runner) | `Install-GcpeRunner.ps1`; GitHub's own list of runner hosts is authoritative |
| `nodejs.org`, `download.microsoft.com`, `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` (WinSW and the runner download redirect there), `get.enterprisedb.com` | TCP 443 | install time only, and not at all if you copy the installers in with `Get-GcpePrereqs.ps1` | `lib\prereqs.psd1` |

Not needed at runtime: the npm registry (the package is self-contained), any internet access for
the public site's pages (browsers fetch YouTube thumbnails and the like themselves). Windows
Update, DNS and NTP follow your server standard. Node.js does not use the Windows proxy settings
by default: if outbound HTTPS must go through a proxy, say so before go-live (not tested).

**A load balancer or WAF in front of the DMZ proxy** that adds its own `X-Forwarded-For` entry
adds a hop: the app server then needs `-ProxyHops 3`, or every visitor is seen as the load
balancer. Ask the network team whether one exists before Test goes public.

Outbound from the Prod database server: the backup share (TCP 445) and the WAL archive share
(TCP 445). Outbound from a DMZ proxy: its app server's 443 only (plus Windows Update per your
standard). **DMZ → anything else: closed.**

## 3. Dev server

Dev is one internal server with the app and PostgreSQL. It is never public.

### D1. Get the package onto the server

1. In the GitHub repository open **Actions → windows** (or **deploy-windows-dev**), pick the latest
   green run, and download the **gcpe-windows** artifact. It downloads as a zip containing
   `gcpe-windows-<commit>.zip`.
2. Copy `gcpe-windows-<commit>.zip` to the server, e.g. `C:\install\`.
3. On the server:

   ```powershell
   cd C:\install
   Get-FileHash .\gcpe-windows-*.zip      # write the hash in the change record
   Unblock-File .\gcpe-windows-*.zip
   Expand-Archive .\gcpe-windows-*.zip -DestinationPath .
   cd .\gcpe-windows
   ```

   `Unblock-File` stops Windows refusing to run scripts that came from the internet. If the
   execution policy still blocks them: `Set-ExecutionPolicy -Scope Process RemoteSigned`.

**No internet on the server?** Run `.\Get-GcpePrereqs.ps1` in the extracted folder on any Windows
machine that has internet access, then copy the whole `gcpe-windows` folder, now with its
`prereqs\` filled, to the server.

**Check it**

```powershell
Get-ChildItem C:\install\gcpe-windows | Select-Object Name
Get-Content C:\install\gcpe-windows\app\VERSION.json
```

Expect the scripts in the table in [1](#what-the-package-contains), `app`, `lib`, `prereqs`, and a
`VERSION.json` with the `commit` you downloaded. With `Get-GcpePrereqs.ps1`: `prereqs\` holds five
installers and `prereqs\pgvector\vector.dll`.

### D2. Install

```powershell
.\Install-Gcpe.ps1 -HostName <Dev internal host> `
    -SmtpHost <relay> -MailFrom <noreply-dev@…> -MailRedirectTo <test inbox> `
    -AllowedClientRanges <staff range 1>, <staff range 2>
```

It asks for the password of the break-glass `admin` login (12+ characters); put it in the
password manager. Anything you leave off the command line that it needs is asked for, in this
order: first the PostgreSQL superuser password (only with `-PostgresAdminUrl`, after IIS, URL
Rewrite, ARR and Node.js are installed), then, in the configuration step, the SMTP relay host, the
From address, the inboxes mail is redirected to, the Entra client secret (`-Environment Prod`),
the `admin` password and the SMTP user's password. Every parameter:

| Parameter | Meaning |
|---|---|
| `-Environment` | `Test` (default): a test site (`SITE_ENVIRONMENT=test`, every message redirected). `Prod`: the real production site (P2). First install only. |
| `-HostName` (required) | The name the site is configured for (`SITE_PUBLIC_SITE_URL`, mail links) and the self-signed certificate's name. Dev: its internal host. Test/Prod: the **public** host. |
| `-Root` | Install folder, default `C:\gcpe`. |
| `-Port` | The stack's local port, default 3000 (blocked from other machines). |
| `-CertificateThumbprint` | A certificate already in `Cert:\LocalMachine\My` for 443. Omit on Dev for a self-signed one. A re-run keeps the bound certificate unless you pass this. |
| `-PostgresAdminUrl`, `-PostgresAdminPassword` | Prod only: `postgres://postgres@<database server>:5432/postgres`; the password is asked for. Omit to install PostgreSQL 17 on this server. |
| `-PostgresDataDir` | PostgreSQL's data folder when installed here, default `C:\gcpe\pgdata`. |
| `-SmtpHost`, `-SmtpPort` (25), `-SmtpSecure`, `-SmtpUser`, `-SmtpPassword` | The relay. Asked for if `-SmtpHost` is missing. With `-SmtpUser` and no `-SmtpPassword`, the password is asked for. |
| `-MailFrom` | From address. |
| `-MailRedirectTo` | Every outgoing message goes to these inboxes instead. Asked for if missing; an empty answer stops the install. With `Prod`, mail is redirected until go-live (P4). |
| `-SendRealMail` | `-Environment Prod` only, instead of `-MailRedirectTo`: mail goes to its real recipients from the first start. Never the default. |
| `-AdminUsername` (`admin`), `-AdminPassword` | The break-glass login; asked for if missing. |
| `-EntraTenantId`, `-EntraClientId`, `-EntraClientSecret`, `-EntraAudience` | Staff sign-in, all four together (or later, D7; required with `-Environment Prod`, which asks for the secret). `-EntraAudience` is `api://<client id>`. |
| `-EmergencyFeedUrl`, `-EmergencyFeedOff` | `-Environment Prod` only, one of the two: the emergency alerts feed (D8's address), or emergency alerts switched off on purpose. |
| `-GoogleVerificationFile`, `-GoogleSiteVerification` | Google Search Console tokens (Prod go-live). |
| `-ProxyHops` | Reverse proxies in front of this server: 1 (Dev), 2 behind the DMZ proxy (Test, Prod). Sets `TRUST_PROXY_HOPS`. A re-run changes it only when passed. |
| `-AllowedClientRanges` | IPv4 CIDR ranges that may reach IIS on 443 and 80 (Windows Firewall); everything else is refused. A re-run keeps them unless you pass new ones. |
| `-AllowAllClients` | Removes that restriction. |
| `-LogRetentionDays` | IIS logs older than this are deleted nightly, default 30. |
| `-HstsMaxAgeDays` | How long browsers keep to https only for this host (`Strict-Transport-Security`), default 365. Sent only with a real certificate, never a self-signed one. `0` sends `max-age=0`, which tells browsers to forget it. A re-run keeps the last value unless passed. |

`-SmtpPassword`, `-AdminPassword`, `-EntraClientSecret` and `-PostgresAdminPassword` are secure
strings, never plain text on the command line. Either leave them out (the script asks), or:

```powershell
$smtpPw = Read-Host 'SMTP password' -AsSecureString
$entraSecret = Read-Host 'Entra client secret' -AsSecureString
.\Install-Gcpe.ps1 … -SmtpUser <user> -SmtpPassword $smtpPw -EntraClientSecret $entraSecret …
```

Settings are written only on the first install: `gcpe.env` is kept on every re-run (the script
says which options it ignored because of that). To change a setting later, edit
`C:\gcpe\config\gcpe.env` and `Restart-Service gcpe-stack`.

What it does, in order (full log: `C:\gcpe\logs\install-<time>.log`):

1. Installs IIS with WebSockets, URL Rewrite, ARR, Node.js and PostgreSQL 17 with pgvector.
   PostgreSQL's superuser password is generated and saved to
   `C:\gcpe\config\postgres-superuser.txt` (Administrators only).
2. Writes `C:\gcpe\config\gcpe.env`: every setting, fresh random internal secrets, the admin
   password only as a hash. Readable only by Administrators, SYSTEM and the service.
3. Creates the PostgreSQL login `gcpe_app` and the seven databases, and enables pgvector in
   `gcpe_news_api`. The app creates its tables when it starts.
4. Installs the **gcpe-stack** service: `node.exe --env-file=C:\gcpe\config\gcpe.env
   C:\gcpe\current\stack.js` as `NT SERVICE\gcpe-stack`, which may change only `C:\gcpe\data` and
   its own logs. Automatic (delayed) start; restarted by Windows if it stops.
5. Firewall: blocks port 3000 from other machines; turns off any rule opening PostgreSQL's 5432
   to other machines (the EDB installer may add one); with `-AllowedClientRanges`, allows 443 and
   80 only from those ranges (rule **GCPE web: allowed client ranges only**) and turns off IIS's
   own rules that open them to everyone (HTTP, HTTPS, and QUIC on UDP 443). If any other enabled
   rule (including one from Group Policy) opens 443 or 80, TCP or UDP, it stops and names it.
   It also locks `C:\gcpe\data`, `C:\gcpe\service\logs`, `C:\gcpe\logs` and
   `C:\gcpe\import-reports` to Administrators, SYSTEM and (for the first two) the service: they
   would otherwise inherit read access for every local user from `C:\`.
6. Creates the IIS site **GCPE**: https on 443, http on 80 redirecting to https, forwarding
   everything to `127.0.0.1:3000`. ARR passes `Host` on and writes `X-Forwarded-For` **without the
   client's port**. Default Web Site is stopped if it held port 80 or 443. With a real
   certificate, every response carries `Strict-Transport-Security: max-age=31536000` (this host
   only: no `includeSubDomains`, no preload), so a browser that has been here once never tries http.
   A self-signed certificate gets no HSTS: it would turn the browser's warning into an error that
   can't be clicked past.
7. IIS logging: no log entry at all for `/api/Subscribe`, `/nod/Subscribe`, `/subscribe`,
   `/news-subscribe`, `/newsletters`, `/enewsletters` (their URLs carry e-mail addresses and
   tokens); no `Referer` field; scheduled task **GCPE IIS log cleanup (GCPE)** deletes logs older
   than `-LogRetentionDays` every night at 03:15.
8. Deploys the release (`Deploy-GcpeRelease.ps1`) and checks `/stack/health` directly and through
   IIS.

**Check it**

```powershell
curl.exe -k -s https://localhost/stack/health
Get-CimInstance Win32_Service -Filter "Name='gcpe-stack'" | Select-Object State, StartName
& "$env:windir\System32\inetsrv\appcmd.exe" list config -section:system.webServer/proxy
Get-NetFirewallRule -DisplayName 'GCPE web: allowed client ranges only' | Get-NetFirewallAddressFilter
Get-ScheduledTask -TaskName 'GCPE IIS log cleanup (GCPE)'
Get-NetFirewallRule -PolicyStore ActiveStore -Enabled True -Direction Inbound -Action Allow |
    Where-Object { @(($_ | Get-NetFirewallPortFilter).LocalPort) -match '^(80|443|5432)$' } |
    Select-Object DisplayName, @{ n = 'Protocol'; e = { ($_ | Get-NetFirewallPortFilter).Protocol } }
(Get-Acl C:\gcpe\data).Access | Select-Object IdentityReference, FileSystemRights
```

| Expect | |
|---|---|
| `{"status":"ok","apps":{…}}` with every app `true` | the stack is up and IIS forwards to it |
| `State: Running`, `StartName: NT SERVICE\gcpe-stack` | the service |
| the `<proxy …>` line contains `includePortInXForwardedFor="false"` and `preserveHostHeader="true"` | ARR settings |
| `RemoteAddress` lists your staff ranges (Windows may show them as address/mask) | the restriction |
| the task, state `Ready` | log retention |
| only **GCPE web: allowed client ranges only** (TCP): nothing for UDP 443, nothing for 5432 | no other way in |
| `BUILTIN\Administrators`, `NT AUTHORITY\SYSTEM`, `NT SERVICE\gcpe-stack` (Modify); no `BUILTIN\Users` | private data folder |

From a staff workstation: `https://<Dev internal host>/hub/` shows the Hub sign-in (a certificate
warning with the self-signed certificate is expected); sign in as `admin`. From a machine outside
the staff ranges the connection times out.

**Optional, recommended on Prod and Test: turn off 8.3 short names** on the volume that holds
`C:\gcpe`, and strip the ones already made under the data folder. The public site refuses
addresses with `~`, but `/files` and `/hub` have their own file servers, and on a volume with short
names an upload could be opened by its short name without its random part. Check with the
server's owner that nothing else on that volume needs short names (the change is volume-wide).
From the URL cutover runbook ([url-cutover-runbook.md](../parity/url-cutover-runbook.md), section
3, "Before the day (install)"); not tested on Windows from here:

```powershell
fsutil 8dot3name query C:
fsutil 8dot3name set C: 1
fsutil 8dot3name strip /t /s C:\gcpe\data    # lists what would change, changes nothing
fsutil 8dot3name strip /s C:\gcpe\data
```

### D3. Import the legacy data

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
4. Signs in as `admin`, asks Core and NRMS to send their data to the other apps, and waits for NoD
   to receive every media list.
5. **NoD**: subscribers, lists and the last 30 days of sends (from `Gcpe.NewsOnDemand`).
6. **Calendar**: a **dry run** that changes nothing. `CALENDAR_DATABASE_URL` must be set in
   `gcpe.env` first (the script stops if it isn't); check it before cutover. Read `calendar-import.txt`, then run it for
   real: `.\Import-GcpeLegacy.ps1 -SqlServer … -SqlUser … -Only Calendar -CalendarCutoff 2025-11-01 -ConfirmCalendar`.

Other parameters: `-SqlPassword`, `-TrustServerCertificate` (a legacy server with a self-signed
certificate), `-HubDatabase` (`Gcpe.Hub`), `-NodDatabase` (`Gcpe.NewsOnDemand`), `-Only Core|NewsApi|Nrms|Nod|Calendar`,
`-NodSinceDays` (30, at most 92), `-AdminPassword`, `-Root`.

Every importer is safe to re-run: nothing is duplicated, and anything staff changed in the new
system since the last import is kept and listed. A step that fails stops the run; fix the cause and
re-run. What each importer reads: [siteground.md](siteground.md), "Importing legacy NRMS / NoD /
Calendar data".

**Translations and media assets.** Legacy keeps translation PDFs and media assets in Azure, which
stays up. `news-api-import-files.mjs` fills in each legacy post's links from the public legacy API
(`api.news.gov.bc.ca`); this needs the outbound openings in [2.4](#24-firewall-requests). It is not
part of `Import-GcpeLegacy.ps1`: run it by hand after the News API step, days before cutover; then,
after the last legacy import and before `api.news.gov.bc.ca` is repointed, a plain run and a
`--refresh --since <full-run date minus 30 days>` run (URL cutover runbook, section 3):

```powershell
$env:DATABASE_URL = ((Get-Content C:\gcpe\config\gcpe.env | Where-Object { $_ -like 'NEWSAPI_DATABASE_URL=*' }) -split '=', 2)[1]
node.exe C:\gcpe\current\tools\news-api-import-files.mjs --dry-run         # real count and hours; sends nothing
node.exe C:\gcpe\current\tools\news-api-import-files.mjs --concurrency 2
node.exe C:\gcpe\current\tools\news-api-import-files.mjs                   # catch-up
node.exe C:\gcpe\current\tools\news-api-import-files.mjs --refresh --since 2026-10-01
Remove-Item Env:DATABASE_URL
```

Options and its 429 handling: [siteground.md](siteground.md), "Legacy translations and media
assets". Not yet run on Windows.

**Website > Files: any type, up to 512 MB** (owner decision 2026-10-29, like the legacy Hub). Every
layer lets that through: NRMS streams the upload to `<DATA_DIR>\storage` (cap `MAX_SITE_FILE_BYTES`,
`apps/nrms/src/website/files.ts`); the stack lets a request take 20 minutes to arrive
(`apps/stack/src/server-timeouts.ts`; Node's default is 5) but closes any connection that sends
nothing for 2 minutes, so a stalled upload is cut off early; the app server's IIS `web.config`
allows a 520 MiB body (`maxAllowedContentLength="545259520"`) and ARR waits 20 minutes
(`system.webServer/proxy` `timeout`), both written by `Install-Gcpe.ps1`. A server installed before
this change keeps 200 MB and 5 minutes until `Install-Gcpe.ps1` is run again (it keeps `gcpe.env`
and rewrites `web.config` and the proxy settings); `Deploy-GcpeRelease.ps1` does not change them.
The DMZ proxy keeps its 1 MB limit: staff upload on the app server's internal name, never through
it. Release translations and media assets (25 MB) and carousel/pin images keep their own limits.
An uploaded `.html`, `.svg`, `.js` or `.exe` is served only as a sandboxed download; a Windows
device name (`CON`, `nul.txt`, `COM1`, `LPT¹`, `CONIN$` …) is refused. Replacing a file a reader
has open is retried for about 3 seconds; if Windows still holds it, the Hub says "The file is in
use; try again in a minute." (503).

**Legacy `/files` import.** `https://news.gov.bc.ca/files/<name>` are the files staff uploaded in
the legacy Hub's Website > Files screen (Azure container `files`). `legacy-files-copy.mjs` imports
them as NRMS site files, so they appear in the Hub under **Website > Files** and the stack serves
them at `/files/<name>` in any letter case. A `/files/<path>` that is neither an NRMS file nor a
site file gets a `302` to legacy's Azure front door: **on by owner decision (2026-10-29)**, relying
on Azure staying up after cutover. `LEGACY_FILES_FALLBACK=false` in `gcpe.env` turns the 302 off
(the site's 404 instead); `LEGACY_FILES_ORIGIN` moves it. A name staff deleted under **Website >
Files** is never redirected: it gets the site's 404 in any letter case, and a later copy run doesn't
import it again; uploading a file served under that name lifts this (NRMS migration `0022`; details
in `siteground.md`, "Legacy /files import"). Release files (`/files/releases/…`) are
never looked up or redirected: Q17 still decides them. Get a **read + list SAS URL** for the legacy
`files` container from whoever holds the legacy Azure storage account. It is a secret: type it in,
don't store it in `gcpe.env`. Run the import after the last legacy import and before DNS moves, then
once more as a catch-up (URL cutover runbook, "Legacy /files"). It writes NRMS's database and
`<DATA_DIR>\storage`, nothing else:

```powershell
$cfg = Get-Content C:\gcpe\config\gcpe.env
foreach ($name in 'NRMS_DATABASE_URL', 'DATA_DIR') {
  # gcpe.env quotes a value with a backslash (DATA_DIR): the quotes are not part of it.
  $value = (($cfg | Where-Object { $_ -like "$name=*" }) -split '=', 2)[1]
  Set-Item "Env:$name" $value.Trim([char]39, [char]34)
}
$env:LEGACY_FILES_SAS_URL = Read-Host 'LEGACY_FILES_SAS_URL'
node.exe C:\gcpe\current\tools\legacy-files-copy.mjs --dry-run           # files, total bytes; downloads nothing
node.exe C:\gcpe\current\tools\legacy-files-copy.mjs --concurrency 2
node.exe C:\gcpe\current\tools\legacy-files-copy.mjs                     # catch-up: only what is new
Remove-Item Env:LEGACY_FILES_SAS_URL, Env:NRMS_DATABASE_URL, Env:DATA_DIR
```

Without a SAS, set `NEWSAPI_DATABASE_URL` (and `CORE_DATABASE_URL`) the same way instead: the tool
then imports the files our content links to, through the front door, plus any `--paths-file` /
`--scan-file` (an IIS log). Check: the files are listed in the Hub under Website > Files, and
`/files/News_Footage_License_British_Columbia.pdf` answers 200 `application/pdf`, not a 302. They
are backed up with the other site files (`files\storage` and the `gcpe_nrms` dump, D4). Options,
limits (30 s headers, 60 s idle, `--max-file-mb` 512, the same 512 MB as a Hub upload), report and
429 handling: [siteground.md](siteground.md), "Legacy /files import". Not yet
run on Windows.

**Cutover only, never on Dev or Test while legacy is live:** turning legacy's publisher off and
handing scheduling to NRMS (`replay-to-news-api`, `release-holds`) is in siteground.md, "Cutover
order".

**Check it**

```powershell
Get-ChildItem C:\gcpe\import-reports | Sort-Object Name | Select-Object -Last 1 | Get-ChildItem
```

The newest folder holds one `.log` per step and the JSON/text reports. The summary table the
script printed says `ok` for every step (`done, report does not balance` means: read that report
before relying on the data). In the Hub, **Releases** lists the legacy releases, and
`https://<Dev internal host>/` shows the public site filling in over the next minutes (the
background ticks render it).

### D4. Schedule the backup

```powershell
.\Register-GcpeBackup.ps1 -BackupPath \\<backup server>\<share>
```

On Dev and Test the app server holds both the databases and the files, so this one run covers
both. Parameters: `-BackupPath` (required), `-BackupRetentionDays` (14), `-At` (`01:30`),
`-Databases` / `-Files` (force what is backed up; normally detected), `-Root`, `-SkipFirstRun`,
`-WaitMinutes` (120). Details, contents and restore: [7.1](#71-backups-and-the-restore-drill).

The share must let this server's computer account (`<DOMAIN>\<server>$`) create folders: the
nightly task runs as SYSTEM, which is that account on the network. Each folder the backup makes is
then locked to the file server's Administrators and SYSTEM plus that computer account. **Run this
against the real share on Dev first** and check the result below before relying on backups
anywhere: the share's permissions are the part no script here can test.

**Check it**

The script ends with `OK  done: \\<backup server>\<share>\<SERVER>\<yyyyMMdd-HHmmss>`. Then:

```powershell
Get-ScheduledTask -TaskName 'GCPE nightly backup' | Get-ScheduledTaskInfo | Select-Object LastRunTime, LastTaskResult, NextRunTime
Get-ChildItem \\<backup server>\<share>\$env:COMPUTERNAME | Sort-Object Name | Select-Object -Last 1 | Get-ChildItem -Recurse -Depth 1
```

Expect `LastTaskResult 0`, and in the newest folder: `db\` with seven `gcpe_*.dump` files,
`config\gcpe.env`, `manifest.json`, `COMPLETE.txt`, and `files\storage` and
`files\calendar-files` once anything has been uploaded (before the first upload those folders
don't exist yet and the log says `nothing to copy`).

### D5. Move the repository to bcgov-c (once)

1. Create a **private** repository in the `bcgov-c` organization (an org owner may need to do it),
   e.g. `bcgov-c/gcpe-news-platform`.
2. Before pushing, scan the history for secrets: `gitleaks git` in a clone (nothing should be
   found: settings live in `gcpe.env` on servers, never in the repository).
3. Push `main` only for now (not `deploy/siteground`, the boxs.ca build output):

   ```sh
   git remote add bcgov https://github.com/bcgov-c/gcpe-news-platform.git
   git push bcgov main
   ```

   Push `develop` (`git push bcgov main:develop`) only after D6: every push to `develop` starts
   a deploy job that waits for the Dev server's runner.

4. In the new repository's **Settings**:
   - **Branches:** protect `main`, and `develop` once it exists (pull request with an approving review, and
     required status checks). The checks are named by job, as GitHub's picker lists them (a check only
     appears there after it has run once): `test` and `site-quality` (workflow `ci`), and `install (windows-2025)`
     (workflow `windows`; there is also a `windows` workflow job named `test`, which runs the suite on
     Windows). Paul decides whether `e2e` (workflow `ci`) and `image` (workflow `openshift-image`) are
     required too. `install (windows-2022)` is the previous Windows release; don't require it.
   - **Environments → New environment `dev`:** add required reviewers if Dev deploys should wait
     for a click; restrict it to the `develop` branch.

### D6. The deploy runner (Dev only)

GitHub can't reach into the government network, so the Dev server reaches out: a GitHub Actions
self-hosted runner connects to `github.com` over HTTPS and waits for deploy jobs. Nothing inbound is
opened. Test and Prod have no runner: they are deployed by hand ([6](#6-after-every-deploy)).

1. In the repository: **Settings → Actions → Runners → New self-hosted runner → Windows**. Copy the
   token from the `config.cmd` line (valid for one hour).
2. On the Dev server, from the package folder:

   ```powershell
   .\Install-GcpeRunner.ps1 -RepositoryUrl https://github.com/bcgov-c/gcpe-news-platform -Token <token> -Labels gcpe-dev
   ```

   Other parameters: `-RunnerDir` (`C:\actions-runner`), `-Version` and `-Sha256` (the pinned
   runner).

The runner runs as `LocalSystem`, because a deploy stops and starts the gcpe-stack service. Anyone
who can change `.github/workflows/deploy-windows-dev.yml` on `develop` can therefore run commands on
the Dev server, which is why D5 protects `develop`. If the server needs an outbound proxy for
github.com: `[Environment]::SetEnvironmentVariable('https_proxy','http://proxy:port','Machine')`,
then restart the runner service.

Day to day: merge a pull request into `develop`; **deploy-windows-dev** runs the tests, builds the
package, waits for the `dev` environment's approval if set, and runs `Deploy-GcpeRelease.ps1` on
this runner (rolls back by itself if the new release isn't healthy). Start one by hand with
**Actions → deploy-windows-dev → Run workflow**. No secrets are stored in GitHub.

**Check it**

**Settings → Actions → Runners** shows the server as **Idle**. Now push `develop` (D5), or
**Run workflow** once: the
deploy job is green and `Get-Content C:\gcpe\current\VERSION.json` shows its commit.

### D7. Staff sign-in with Microsoft Entra

Until this is done, staff sign in with passwords set in the Hub's **Users** screen, and `admin` is
the way in.

1. Get the registration from [2.3](#23-entra-staff-sign-in-per-environment).
2. Add to `C:\gcpe\config\gcpe.env` (Notepad, as Administrator). `CORE_PUBLIC_BASE_URL` is the
   **internal host** (on Test and Prod too: the callback must not go through the DMZ):

   ```
   ENTRA_TENANT_ID=<tenant id>
   CORE_ENTRA_CLIENT_ID=<client id>
   CORE_ENTRA_CLIENT_SECRET='<client secret>'
   CORE_PUBLIC_BASE_URL=https://<internal host>
   CORE_AUTH_AUDIENCE=api://<client id>
   NRMS_AUTH_AUDIENCE=api://<client id>
   NEWSAPI_AUTH_AUDIENCE=api://<client id>
   SITE_AUTH_AUDIENCE=api://<client id>
   NOD_AUTH_AUDIENCE=api://<client id>
   DIST_AUTH_AUDIENCE=api://<client id>
   CALENDAR_AUTH_AUDIENCE=api://<client id>
   ```

   (On a fresh server, `Install-Gcpe.ps1 -EntraTenantId … -EntraClientId … -EntraClientSecret …
   -EntraAudience …` writes the same lines, with `CORE_PUBLIC_BASE_URL=https://<-HostName>`: on Test
   and Prod change that one line to the internal host afterwards.)
3. `Restart-Service gcpe-stack`.
4. Each person signs in with Microsoft once their Hub user exists with their government email.
   Details: siteground.md, "Staff sign-in with Microsoft Entra".

**Check it**

`curl.exe -k -s https://localhost/stack/health` is `ok` (a wrong Entra setting stops the stack
from starting; the reason is in `C:\gcpe\service\logs\gcpe-stack.err.log`). On
`https://<internal host>/hub/`, **Sign in with Microsoft** returns you to the Hub signed in.

**Session length.** A staff session lasts at most 12 hours from sign-in (Microsoft, password or
`admin`), however often the Hub renews it; then the person signs in again. To change it, add
`SESSION_MAX_HOURS=<hours>` (more than 0, at most 168) to `gcpe.env` and `Restart-Service
gcpe-stack`; every app uses the one value. Deactivating a user in the Hub, or their **Sign out**,
ends that session at once in every app. If Core's database is down, staff see "The Hub can't check
your sign-in right now" (nobody is signed out) and `admin` still works. An `admin` Sign out during
that outage is held in memory only, so a restart before the database returns revives that cookie;
set a new `SESSION_SECRET` (any random value of 32+ characters) in `gcpe.env` afterwards if that
matters, keep it there, and restart; this signs every staff user out, not only `admin`. **Do not rotate `STACK_EVENT_SECRET` for this:** it also changes the key
for the unsubscribe links already in subscribers' e-mail (they would stop working) and the apps'
key for calling each other. The manual pages say 12
hours: edit them if you change the value. A break-glass `admin` bearer token (from
`/<app>/auth/local/token`; `Import-GcpeLegacy.ps1` doesn't use one, it signs in like the Hub) lasts
8 hours, or `SESSION_MAX_HOURS` if shorter. A Hub **Sign out** doesn't end one; signing out with the
token itself does (`curl.exe -k -s -X POST https://localhost/core/auth/logout -H "authorization:
Bearer <access_token>"`, which answers `204`). **To end all `admin` access at once** (every token and
every `admin` Hub session, including the import's), set a new break-glass password
(`LOCAL_ADMIN_PASSWORD_HASH`) and restart; nobody else is signed out. Turning break-glass off stops
them only while it stays off: when you turn it back on, set a new password (step 1 of
"Break-glass in an emergency" does), or tokens less than 8 hours old and `admin` sessions less than
12 hours old work again. Details: siteground.md, "Revoking access".

Rolling back past this change (Core migration 0012) means deploying the previous release and
leaving the `staff_sessions` table in place; never drop it by hand.

Core migration 0013 (applied at startup, nothing to configure) adds the Hub's Admin history
(`core_audit`, kept forever) and each user's last sign-in time. Rolling back past it means
deploying the previous release and leaving both in place; never drop them by hand. NRMS migration
0024 lets the Website log record Government terms changes; rolling back leaves it in place, harmlessly.

### D8. Connect the outside services

Until these are set, the stack uses built-in fakes and says so in its log. Add each to `gcpe.env`,
then `Restart-Service gcpe-stack`, and open its outbound firewall rule first
([2.4](#24-firewall-requests)):

| Service | Settings | Notes |
|---|---|---|
| Media Hub (NoD) | `NOD_MEDIA_HUB_URL`, `NOD_MEDIA_HUB_TOKEN_URL`, `NOD_MEDIA_HUB_CLIENT_ID`, `NOD_MEDIA_HUB_CLIENT_SECRET`, `NOD_MEDIA_HUB_SCOPE` | |
| Legacy Membership lookup (NoD) | `NOD_MEMBERSHIP_API_USERNAME`, `NOD_MEMBERSHIP_API_PASSWORD_HASH` | The password setting is the hash `npm run nod:membership-hash` prints, never a plain password. Run that on a developer machine from a full repository checkout after `npm ci`: the server package doesn't contain it. With either unset, the lookup always answers 503. |
| Emergency alerts feed | `NOD_EMERGENCY_FEED_URL=https://www.emergencyinfobc.gov.bc.ca/category/alerts/feed/?hide_expired=true` | Must be the final URL, no redirect. Prod refuses to start without it unless `NOD_EMERGENCY_FEED=off` is set on purpose ([Real production](#real-production-what-the-stack-refuses)). |
| Flickr (NRMS) | `NRMS_FLICKR_API_KEY`, `NRMS_FLICKR_API_SECRET`, `NRMS_FLICKR_ACCESS_TOKEN`, `NRMS_FLICKR_ACCESS_SECRET`, `NRMS_FLICKR_ALERT_EMAILS` | siteground.md, "Flickr". |
| Semantic search | `NEWSAPI_EMBEDDINGS_PROVIDER=azure-openai`, `NEWSAPI_AZURE_OPENAI_ENDPOINT`, `NEWSAPI_AZURE_OPENAI_API_KEY`, `NEWSAPI_AZURE_OPENAI_EMBEDDING_DEPLOYMENT`, and `"semanticSearch": true` in the tenant file (below) | pgvector is already on. `/stack/health` then says `"newsApiSearch": "semantic"`. Never turn on `staffAi` before the privacy impact assessment approves it. |
| Google Search Console | `SITE_GOOGLE_VERIFICATION_FILE`, `SITE_GOOGLE_SITE_VERIFICATION` | Prod go-live only ([5](#5-prod)). |
| Real mail | remove `DIST_MAIL_REDIRECT_TO` **and** add `DIST_MAIL_ALLOW_REAL_RECIPIENTS=true` | Prod only (P4). Removing the redirect alone stops Distribution starting, and the whole stack with it. |
| Bounce mailbox | `DIST_BOUNCE_SOURCE=graph`, `DIST_GRAPH_TENANT_ID`, `DIST_GRAPH_CLIENT_ID`, `DIST_GRAPH_CLIENT_SECRET`, `DIST_BOUNCE_MAILBOX` | All five or Distribution refuses to start. Without them Prod starts with a warning, and Operations says bounces aren't being read. **IT must provide:** the shared bounce mailbox (its address is `DIST_BOUNCE_MAILBOX`); an Entra app registration with a client secret and the Microsoft Graph **application** permission `Mail.ReadWrite` (admin consent), limited to that one mailbox by an Exchange Online application access policy (otherwise it can read every mailbox); and its tenant id, client id and secret (`DIST_GRAPH_TENANT_ID`, `DIST_GRAPH_CLIENT_ID`, `DIST_GRAPH_CLIENT_SECRET`; on the stack the app's own `GRAPH_*` and `BOUNCE_MAILBOX` settings carry the `DIST_` prefix). It reads the Inbox and moves handled messages to a `Processed` folder it creates, hence read-write. **Only tested against recorded responses, never against a real mailbox.** |

**The tenant file** (`semanticSearch`, `staffAi` and the other tenant features) ships inside each
release, at `C:\gcpe\current\config\tenants\bc.json`, so an edit there is lost at the next
deploy. Keep your own copy outside the releases and point the stack at it:

```powershell
New-Item -ItemType Directory -Force C:\gcpe\config\tenants | Out-Null
Copy-Item C:\gcpe\current\config\tenants\bc.json C:\gcpe\config\tenants\bc.json
notepad C:\gcpe\config\tenants\bc.json        # e.g. "semanticSearch": true
Add-Content C:\gcpe\config\gcpe.env 'TENANT_CONFIG=C:\gcpe\config\tenants\bc.json'
Restart-Service gcpe-stack
```

`TENANT_CONFIG` is the stack's own setting (`apps/stack/src/env.ts`), and `Import-GcpeLegacy.ps1`
uses it too. When a release's notes say `bc.json` changed, copy the new one over yours and make
your edit again.

**Check it**

After each restart, `curl.exe -k -s https://localhost/stack/health` is `ok` and the stack no longer
warns that it is using that service's fake (the warnings go to the error log):

```powershell
Get-Content C:\gcpe\service\logs\gcpe-stack.err.log -Tail 300 | Select-String 'using the FAKE'
```

Each line names a service still on its fake (`FLICKR`, `MEDIA HUB`, `EMERGENCY FEED`, `ENTRA`); a
configured service has no line after its restart.

## 4. Test: app server, then DMZ proxy

Test is one internal app server (app + PostgreSQL) and DMZ proxy #1. It is installed **closed**:
the proxy answers only the staff egress ranges (T3) until T0's release-files gate is deployed and
checked; only then is it opened (T5), and only to test the proxy. It is never indexed (noindex
header at the proxy, `robots.txt Disallow: /` and noindex pages from the app while
`SITE_ENVIRONMENT=test`).

### T0. Prerequisites for Test

- [ ] Everything in [2](#2-before-you-start) for Test: both servers, the DMZ firewall openings,
      both certificates, the Entra redirect URI on the Test internal host, the staff egress
      ranges, and whether a load balancer or NAT sits in front of the DMZ server.
- [ ] Before Test is **opened to the public** (T5): the **release-files gate** must be deployed.
      Today a release's attachments (`/files/…`) can be downloaded as soon as they are uploaded,
      before the release is published, by anyone who has the link; the gate makes them 404 until
      publish. It is a separate pull request (branch `feat/release-files-gate`), not in this
      package yet. Check after deploying it, from an allowed address: create a draft release in
      the Hub with an attachment, copy the attachment's `/files/…` link, and through the proxy
      `curl.exe -s -o NUL -w '%{http_code}' "https://<public host>/files/<rest of the link>"`
      must print `404`. Publish the release: within about a minute (the proxy caches files for 60
      seconds) the same command prints `200`.

### T1. The Test app server

Follow D1 to get the package on the server. Then install with the **public host** as `-HostName`,
two proxy hops, and IIS reachable only from the DMZ proxy and the staff ranges:

```powershell
.\Install-Gcpe.ps1 -HostName <public host> -CertificateThumbprint <app server certificate thumbprint> `
    -ProxyHops 2 -AllowedClientRanges <DMZ proxy IP as this server sees it>/32, <staff range 1>, <staff range 2> `
    -SmtpHost <relay> -MailFrom <noreply-test@…> -MailRedirectTo <test inbox>
```

- `-HostName` is the public host because the site's links, feeds and e-mail links must use the
  name the public sees. Staff still use the internal host for the Hub; the script's closing
  summary prints that address (`Staff app (Hub): https://<this server's name>/hub/`).
- `-ProxyHops 2`: the visitor's address is the second-last entry of `X-Forwarded-For` (the DMZ's
  IIS appends the visitor, this server's IIS appends the DMZ server). Without it every visitor
  looks like the DMZ server and shares one set of per-address limits. A load balancer or WAF in
  front of the DMZ that adds its own entry makes it `-ProxyHops 3`.
- `-AllowedClientRanges`: the DMZ proxy's address after any NAT. Why it matters:
  [8.3](#83-why-the-app-servers-443-must-be-closed-to-everyone-else).
- Every other parameter as in D2.

Then D3 (import), D4 (backup), D7 (Entra, with `CORE_PUBLIC_BASE_URL=https://<Test internal host>`)
and D8 as on Dev. The command above passes no Entra options, so D7 writes the whole block. If you
add `-EntraTenantId` and the other three Entra options here (as for Prod, P2), the installer
writes `CORE_PUBLIC_BASE_URL=https://<public host>` on Test too: change that line to the internal
host, run `stack.js --check` and `Restart-Service gcpe-stack`, as D7 says.

**Check it** (on the app server)

```powershell
curl.exe -k -s https://localhost/stack/health
Select-String -Path C:\gcpe\config\gcpe.env -Pattern '^TRUST_PROXY_HOPS=', '^SITE_PUBLIC_SITE_URL=', '^SITE_ENVIRONMENT='
Get-NetFirewallRule -DisplayName 'GCPE web: allowed client ranges only' -PolicyStore ActiveStore | Get-NetFirewallAddressFilter
Get-NetFirewallRule -Name 'IIS-WebServerRole-*' | Select-Object Name, Enabled
```

Expect: health `ok`; `TRUST_PROXY_HOPS=2`, `SITE_PUBLIC_SITE_URL=https://<public host>`,
`SITE_ENVIRONMENT=test`; the rule in the **active** store (if it is missing there, Group Policy
does not merge local firewall rules: ask the GPO owner, or every client including the DMZ is
refused) with the DMZ address and staff ranges; every IIS rule for 80/443 (HTTP, HTTPS, QUIC)
`Enabled False`. D2's firewall check lists only the GCPE rule.

From a staff workstation, `https://<Test internal host>/hub/` signs in. From any other internal
machine, the connection times out.

### T2. Hand the DMZ server the app server's certificate chain

The DMZ server must trust the app server's certificate. Skip this if it already trusts the issuing
CA (a domain-distributed root; DMZ servers are often not domain members, so usually it doesn't).

- **Internal CA (recommended):** get the CA's **root** certificate and every **intermediate** CA
  certificate as `.cer` files (from the PKI team, or on the app server: `certlm.msc` → the
  certificate → Certification Path → each CA → View Certificate → Details → Copy to File → DER).
  The root goes in `-UpstreamCertificateFile` (imported into `LocalMachine\Root`), the
  intermediates in `-UpstreamIntermediateCertificateFile` (imported into `LocalMachine\CA`).
- **Self-signed app certificate** (the installer's own): export it: `certlm.msc` → Personal →
  Certificates → the certificate → All Tasks → Export → **No, do not export the private key** → DER
  `.cer`. It goes in `-UpstreamCertificateFile`.

Copy the `.cer` files (never a `.pfx`) to the DMZ server, e.g. `C:\install\`.

### T3. The DMZ proxy (closed to everyone but staff)

The DMZ server gets the **proxy package** only, `gcpe-proxy-<commit>.zip` (artifact
**gcpe-proxy** of the same CI run as the app package): `Install-GcpeProxy.ps1`,
`Get-GcpePrereqs.ps1` and `lib\`. Never copy the app package (`app\`) into the DMZ. Unpack it as
in D1 (`Get-FileHash`, `Unblock-File`, `Expand-Archive`). If the DMZ server has no internet, on a
machine that has it run `.\Get-GcpePrereqs.ps1 -Names UrlRewrite, Arr` in the unpacked folder
and copy the folder, now with `prereqs\`, across.

If the DMZ's DNS doesn't resolve the internal host, add `<app server IP> <internal host>` to
`C:\Windows\System32\drivers\etc\hosts`. Then:

```powershell
.\Install-GcpeProxy.ps1 -HostName <public host> -Upstream https://<Test internal host> `
    -CertificateThumbprint <public certificate thumbprint> `
    -UpstreamCertificateFile C:\install\internal-root.cer -UpstreamIntermediateCertificateFile C:\install\internal-issuing.cer `
    -AllowedClientRanges <staff egress range 1>, <staff egress range 2> `
    -Environment Test
```

After the install, delete the package folder and the `.cer` files from `C:\install`: nothing on
the DMZ server needs them again (a re-run needs the package: copy it in again).

Every parameter:

| Parameter | Meaning |
|---|---|
| `-HostName` (required) | The public host. |
| `-Upstream` (required) | `https://<name>[:port]` of the app server, no path. The name must be on the app server's certificate. |
| `-UpstreamCertificateFile` | A `.cer` to trust for the upstream: the internal CA's root, or the app server's self-signed certificate (imported into `LocalMachine\Root`). Refused if it holds a private key. |
| `-UpstreamIntermediateCertificateFile` | Intermediate CA `.cer` files between the two (imported into `LocalMachine\CA`). |
| `-UpstreamCertificateThumbprint` | Or: a certificate already in a LocalMachine store here to trust. With the file: must match it. |
| `-CertificateThumbprint` | The public certificate in `Cert:\LocalMachine\My`. Omit on Test for a self-signed one (refused with `-Environment Prod`). A re-run keeps the bound certificate. |
| `-AllowedClientRanges` | Only these IPv4 CIDR ranges may use the site; everyone else gets 403 (IIS IP and Domain Restrictions). Kept on re-run. |
| `-AllowAllClients` | Removes that restriction. |
| `-Environment` | `Test` (adds `X-Robots-Tag: noindex, nofollow`) or `Prod`. First install: `Test` unless given. |
| `-CacheMaxSizeGB` | ARR disk cache cap, default 5. |
| `-HttpsPort`, `-HttpPort` | 443 and 80 by default. |
| `-Root` | Default `C:\gcpe-proxy` (site rules, cache, install logs, saved settings). |
| `-LogRetentionDays` | IIS logs older than this are deleted nightly, default 30. |
| `-HstsMaxAgeDays` | `Strict-Transport-Security` max-age, default 365; sent only with a real certificate. `0` sends `max-age=0` (browsers forget it). Use the same value as the app server. |

**Re-runs keep what you chose.** `-Environment`, `-CacheMaxSizeGB`, `-HttpsPort`, `-HttpPort`,
`-LogRetentionDays` and `-HstsMaxAgeDays` are saved in `C:\gcpe-proxy\proxy-settings.json`; a re-run without one of them
keeps the saved value (the script says so), so a Prod proxy never becomes Test by itself. Only an
explicit `-Environment Test` turns a Prod proxy into Test (with a warning). The client ranges and
the certificate are kept the same way.

What it does (log: `C:\gcpe-proxy\logs\install-proxy-<time>.log`):

1. Installs IIS, URL Rewrite 2.1 and ARR 3.0 (the same pinned installers), and IIS IP and Domain
   Restrictions when `-AllowedClientRanges` is given.
2. Turns on the ARR proxy: `Host` passed on, `X-Forwarded-For` gets the visitor's address (no
   port), `X-Forwarded-Proto: https`, 2-minute upstream timeout, responses streamed.
3. Turns on the ARR disk cache in `C:\gcpe-proxy\cache`, at most `-CacheMaxSizeGB`: brotli and
   gzip copies only, never one it compressed itself, never a URL with a query string
   ([8.2](#82-caching-at-the-proxy)).
4. Trusts the upstream certificate chain, then checks the app server answers over **verified**
   TLS. It never turns certificate checks off; it stops if the check fails.
5. Creates the IIS site **GCPE-Proxy** (https with the certificate, http → 301 to https) and writes
   its rules to `C:\gcpe-proxy\site\web.config` ([8.1](#81-what-the-proxy-forwards)), keeping the
   rules it replaces as `C:\gcpe-proxy\logs\web.config.<time>.bak`. Request bodies are capped at
   1 MB.
6. Opens 443 and 80 in Windows Firewall (rule **GCPE proxy: inbound web**).
7. IIS logging: no entries for `/api/Subscribe`, `/subscribe`, `/news-subscribe`, `/newsletters`,
   `/enewsletters`; no `Referer` field; task **GCPE IIS log cleanup (GCPE-Proxy)**.
8. Checks through itself that `/hub/` is 404 and `/` comes back from the app server (with
   `-AllowedClientRanges` that leave out the DMZ server itself, it says it got 403 and stops
   checking: run T4 from an allowed address).

**Check it**

The script ends with `OK  / is 200 (from the app server), /hub/ is 404`, or with the 403 note
above. A `502` note instead means the app server refused the DMZ (its `-AllowedClientRanges`), the
network firewall is closed, or the upstream certificate is not trusted or not for the `-Upstream`
name (the proxy's IIS log substatus, e.g. `502.3`, says which). Then:

```powershell
Get-Content C:\gcpe-proxy\proxy-settings.json
```

shows `"Environment": "Test"`.

### T4. End-to-end checks through the proxy

The same checks CI makes. Run them **from a staff workstation whose internet address is in the
allowed egress ranges** (and `-k` while the certificate is self-signed):

| Command | Expect |
|---|---|
| `curl.exe -s -o NUL -w '%{http_code}' https://<public host>/` | `200` |
| `curl.exe -s -o NUL -w '%{http_code}' https://<public host>/feed` | `200` |
| `curl.exe -s -o NUL -w '%{http_code}' https://<public host>/api/v2/ministries` | `200` (public News API) |
| `curl.exe -s https://<public host>/robots.txt` | ends with `Disallow: /` (test site) |
| `curl.exe -sI https://<public host>/` | contains `X-Robots-Tag: noindex, nofollow` |
| `curl.exe -s -o NUL -w '%{http_code}' https://<public host>/hub/` | `404`; the same for `/stack/health`, `/core/api/organizations`, `/core/auth/login`, `/nod/`, `/calendar/`, `/distribution/`, `/site-builder/`, `/events`, `/health/ready`, `/api/v2/changes`, `/api/v2/internal/similar` |
| `curl.exe -s --path-as-is -o NUL -w '%{http_code}' "https://<public host>/releases/../hub/"` | `404` or `400` (never the Hub) |
| `curl.exe -s -o NUL -w '%{http_code} %{redirect_url}' https://<public host>/contact` | `301 https://forms.gov.bc.ca/` (an old news.gov address) |
| `curl.exe -s -o NUL -w '%{http_code} %{redirect_url}' http://<public host>/archive/` | `301 https://<public host>/archive/` |
| `curl.exe -sI https://<public host>/` | contains `Strict-Transport-Security: max-age=31536000` (with the real certificate) |
| `curl.exe -sI -H 'Accept-Encoding: br' https://<public host>/` | `content-encoding: br` |
| `curl.exe -sI -H 'Accept-Encoding: gzip' https://<public host>/` | `content-encoding: gzip` or none, never `br` |
| `curl.exe -sI https://<public host>/` | no `content-encoding` |

**It is closed to everyone else.** From a machine outside the allowed ranges (a phone off Wi-Fi,
or a home connection): `curl.exe -s -o NUL -w '%{http_code}' https://<public host>/` prints `403`.

**The cache works.** Request `/` twice with `curl.exe -s -o NUL -H 'Accept-Encoding: br' https://<public host>/`,
more than 5 and less than 60 seconds apart (without `Accept-Encoding` nothing is stored,
[8.2](#82-caching-at-the-proxy)). In the proxy's
IIS log (`C:\inetpub\logs\LogFiles\W3SVC<id of GCPE-Proxy>\`, after `netsh http flush logbuffer`)
the second `GET /` line has `X-ARR-CACHE-HIT=1` in its query field, and the app server's IIS log
has no line for it. `/api/…`, the subscribe pages and any URL with a query string never show a
cache hit.

**The app server refuses everyone else.** From an internal machine that is neither the DMZ server
nor in a staff range: `curl.exe -k -s -o NUL --max-time 10 -w '%{http_code}' https://<Test internal host>/`
prints `000` (timed out).

### T5. Open Test to the public (only after T0's release-files gate)

1. Do T0's release-files gate check first, from an allowed address. Do not continue until it
   prints `404` for a draft's attachment.
2. On the DMZ server, with the proxy package copied in again:

   ```powershell
   .\Install-GcpeProxy.ps1 -HostName <public host> -Upstream https://<Test internal host> -AllowAllClients
   ```

   Everything else (environment, certificate, cache size) is kept.

To close it again, re-run with `-AllowedClientRanges <ranges>`. IPv4 CIDR ranges only; a range with
host bits set is refused. If a load balancer or NAT sits in front of the DMZ server, IIS sees its
address, not the visitor's, and the restriction cannot tell visitors apart.

**Check it**

- From outside the staff ranges, `curl.exe -s -o NUL -w '%{http_code}' https://<public host>/` prints
  `200`, and `curl.exe -sI https://<public host>/` still has `X-Robots-Tag: noindex, nofollow`.
- **The visitor's address reaches the app.** The stack doesn't log client addresses, but
  `/api/v2/search` counts requests per address and reports what is left in its `RateLimit` header.
  From two machines with different outside addresses, run
  `curl.exe -sI "https://<public host>/api/v2/search?q=test"` a few times each: each machine's
  remaining count (`r=`) goes down on its own. If the second machine's count carries on from the
  first's, the app sees every visitor as the DMZ server (or a load balancer): check `-ProxyHops`
  on the app server. (The app server's IIS log always shows the DMZ server as the client; that is
  expected.)

## 5. Prod

Prod is built (P1 to P4) and uses the same scripts as Test; what differs is below. It has not been
run on a real Prod server yet ([9](#9-not-yet-verified)). The order is: database server (P1), app
server (P2), DMZ proxy #2 (P3), go-live switches (P4). Only P5, the static fallback for patch
reboots, is not built.

### Real production: what the stack refuses

A deployment is the **real production site** when `NODE_ENV=production` and there is no
`SITE_ENVIRONMENT=test` line (Dev, Test and boxs.ca have that line). `-Environment Prod` writes
`SITE_ENVIRONMENT=production` to say so; keep that line. Break-glass
(`LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true`) doesn't change which it is: it only allows the local admin
login, and on the real production site only alongside `SITE_ENVIRONMENT=production`.
On the real production site the stack checks these at startup, before it opens any database; a
refusal stops the start (and a deploy's own `stack.js --check` fails first, so the running site isn't
changed), a warning starts it and says so:

| Setting | If it's wrong | |
|---|---|---|
| `ENTRA_TENANT_ID`, `CORE_ENTRA_CLIENT_ID`, `CORE_ENTRA_CLIENT_SECRET`, `CORE_PUBLIC_BASE_URL` | Refused if any is missing: without them staff passwords would quietly stay allowed. | refuse |
| `NOD_EMERGENCY_FEED_URL` | Refused unless it is set, or `NOD_EMERGENCY_FEED=off` is set on purpose. Both set is refused too. | refuse |
| `NOD_EMERGENCY_FEED=off` | Starts; logs that emergency alerts are switched off; Operations says so. | warning |
| `DIST_BOUNCE_SOURCE` | Unset or `fake`: starts; logs "Bounces aren't being read: bounce handling is set to manual upload"; Operations says so. `graph` needs all its settings (D8). | warning |
| `DIST_MAIL_REDIRECT_TO` with `DIST_MAIL_ALLOW_REAL_RECIPIENTS=true` | Refused: the redirect would still catch every message. | refuse |
| `LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true` with no `SITE_ENVIRONMENT` | Refused, whatever else is set: before 2026-10-31 that setting alone made a test site (boxs.ca's env), so such an env must never come up as the indexable live site. Set `SITE_ENVIRONMENT=test` for a test site, or `SITE_ENVIRONMENT=production` (or remove the setting) for the real one. | refuse |
| `SITE_ENVIRONMENT` | Read ignoring case and spaces (`Test ` is a test site). With `NODE_ENV=production`, any value other than `test` or `production` (a typo such as `staging` or `prod`) is refused. | refuse |
| `LOCAL_ADMIN_ENABLED=true` | Starts; logs that the break-glass admin is on ("Turn it off at go-live (P4), or once an emergency is over"); Operations says so. | warning |
| `CORE_LOCAL_PASSWORDS_ALLOWED=true` | Starts; logs that staff passwords are allowed; Operations says so. | warning |

The apps' calls to each other inside the stack don't need the break-glass admin: they use a key
the stack derives from `STACK_EVENT_SECRET` (owner decision 2026-10-31), and that key is accepted
only on the stack's own in-memory connections, never through IIS or the network.

**Check it** before a restart, with the new values (it starts nothing and opens no database):

```powershell
& 'C:\Program Files\nodejs\node.exe' --env-file=C:\gcpe\config\gcpe.env C:\gcpe\current\stack.js --check
```

`"ok": true`, and `production.errors` empty; `production.warnings` lists what will be logged.
After the restart, `Get-Content C:\gcpe\service\logs\gcpe-stack.err.log -Tail 300 | Select-String 'PRODUCTION WARNING|refusing to start'`
shows the same lines.

### P1. The database server

On the Prod database server, from the package:

```powershell
.\Install-GcpeDatabaseServer.ps1 -AppServerAddress <Prod app server IP>
```

Parameters: `-AppServerAddress` (required; only it may connect), `-Root` (`C:\gcpe`),
`-PostgresDataDir` (`C:\gcpe\pgdata`). It installs PostgreSQL 17 (service `postgresql-x64-17`) with
a generated superuser password in `C:\gcpe\config\postgres-superuser.txt` (Administrators only),
installs pgvector, adds the app server to `pg_hba.conf` (scram-sha-256), opens TCP 5432 to that
address only (and turns off any other rule opening 5432, such as one the EDB installer adds; it
stops if one comes from Group Policy), and prints the `-PostgresAdminUrl` for P2.

Then schedule its backup (databases only; it detects that) and set up WAL archiving
([7.2](#72-prod-point-in-time-recovery-to-set-up-when-prods-database-server-arrives)). No `gcpe_*`
database exists yet (P2 creates them), and the first run would stop with "No gcpe_* databases on
this server", so skip it now and run the task once after P2:

```powershell
.\Register-GcpeBackup.ps1 -BackupPath \\<backup server>\<share> -SkipFirstRun
```

Recommended: exclude the data folder from Defender real-time scanning
(`Add-MpPreference -ExclusionPath C:\gcpe\pgdata`) per your security standard.

**Check it**

```powershell
Get-Service postgresql-x64-17
Get-NetFirewallRule -DisplayName 'GCPE PostgreSQL from the app server' | Get-NetFirewallAddressFilter
Get-NetFirewallRule -DisplayName '*postgres*' -PolicyStore ActiveStore | Select-Object DisplayName, Enabled, Action
Select-String -Path C:\gcpe\pgdata\pg_hba.conf -Pattern 'GCPE app server'
Select-String -Path C:\gcpe\pgdata\postgresql.conf -Pattern '^listen_addresses'
Get-ScheduledTask -TaskName 'GCPE nightly backup'
```

Expect `Running`; the app server's address; among the `*postgres*` rules, only **GCPE PostgreSQL
from the app server** enabled; one `pg_hba` line for it; and `listen_addresses = '*'`
(the EDB installer's default; assumed, not yet seen on a real server: if it says `localhost`,
change it to `'*'` and `Restart-Service postgresql-x64-17`). From the app server:
`Test-NetConnection <database server> -Port 5432` is `TcpTestSucceeded : True`. The backup task is
registered (its first run comes after P2).

### P2. The app server

```powershell
.\Install-Gcpe.ps1 -Environment Prod -HostName <public host> -CertificateThumbprint <thumbprint> `
    -PostgresAdminUrl postgres://postgres@<database server>:5432/postgres `
    -ProxyHops 2 -AllowedClientRanges <DMZ proxy #2 IP>/32, <staff ranges> `
    -SmtpHost <relay> -MailFrom <…> -MailRedirectTo <inbox until go-live> `
    -EntraTenantId <tenant> -EntraClientId <client id> -EntraAudience api://<client id> `
    -EmergencyFeedUrl 'https://www.emergencyinfobc.gov.bc.ca/category/alerts/feed/?hide_expired=true'
```

It does not install PostgreSQL here. After it has installed IIS, URL Rewrite, ARR and Node.js, it
asks for the superuser password (copy it from `postgres-superuser.txt` on the database server);
then, in the configuration step, for the Entra client secret and the `admin` password (and the
SMTP password if you gave `-SmtpUser`). `-Environment Prod` writes the
real production site from the first start ([Real production](#real-production-what-the-stack-refuses)):
`SITE_ENVIRONMENT=production`, so the stack makes its production checks and uses no fakes. The site is
not public yet: DMZ proxy #2 lets only the staff ranges in until go-live (P3). The break-glass admin
is written on, for setting up; P4 turns it off. `-MailRedirectTo` keeps mail redirected until
go-live. Prod never sends real mail by default: without `-MailRedirectTo` it asks for an inbox, an
empty answer stops the install, and only `-SendRealMail` sends to the real recipients from the
first start. Then D3 (final import, at
cutover, while break-glass is still on), D7 (Entra: the redirect URI on the internal host), D8,
and the backup for the files (and, as D2 says, optionally turn off 8.3 short names), on the app server:

```powershell
.\Register-GcpeBackup.ps1 -BackupPath \\<backup server>\<share>
```

Now that the databases exist, run the database server's backup once (**on the database server**)
and check it finished (`LastTaskResult` 0):

```powershell
Start-ScheduledTask -TaskName 'GCPE nightly backup'
Get-ScheduledTaskInfo -TaskName 'GCPE nightly backup' | Select-Object LastRunTime, LastTaskResult
```

**Right after the install, point the Entra callback at the internal host.** Because the Entra
options were given, the installer wrote `CORE_PUBLIC_BASE_URL=https://<public host>` (the
`-HostName`), but the callback must not go through the DMZ (D7). In `C:\gcpe\config\gcpe.env`
change that one line to `CORE_PUBLIC_BASE_URL=https://<Prod internal host>`, then check and restart:

```powershell
& 'C:\Program Files\nodejs\node.exe' --env-file=C:\gcpe\config\gcpe.env C:\gcpe\current\stack.js --check
Restart-Service gcpe-stack
```

`--check` must say `"ok": true`. Until you do, **Sign in with Microsoft** sends people to the
public host, where it can't work. `Select-String C:\gcpe\config\gcpe.env -Pattern '^CORE_PUBLIC_BASE_URL='`
shows the value. This replaces D7's step 2 for Prod; D7's other steps still apply.

Set `NEWSAPI_SEARCH_SEMANTIC_MAX_CONCURRENT` explicitly in `gcpe.env` (its default counts this
server's cores, but the vector queries run on the database server's).

**Check it**: as T1, plus `Select-String C:\gcpe\config\gcpe.env -Pattern '^CORE_DATABASE_URL='`
names the database server.

### P3. DMZ proxy #2

As T2 and T3 (proxy package only), with `-Environment Prod`, a publicly trusted certificate
(`-CertificateThumbprint` is required), `-Upstream https://<Prod internal host>`, and
`-AllowedClientRanges <staff egress ranges>` until go-live. `-Environment Prod` is saved: later
re-runs (certificate renewal, `-AllowAllClients` at go-live) keep Prod without repeating it. Then
T4's checks; with Prod there is no `X-Robots-Tag` and, after P4, `robots.txt` allows crawling.
At go-live: `.\Install-GcpeProxy.ps1 -HostName <public host> -Upstream https://<Prod internal host> -AllowAllClients`.

**Check it**: `Get-Content C:\gcpe-proxy\proxy-settings.json` shows `"Environment": "Prod"`, and
`curl.exe -sI https://<public host>/` (from an allowed address) has no `X-Robots-Tag`.

### P4. Go-live switches

**Before you start**, all of these must be true:

1. **At least two people hold Core Admin**, are active, have their government email, and have each
   signed in with Microsoft on Prod (Admin → Users shows **Sign-in: Microsoft** for them). Add them
   on the Users screen while signed in as the break-glass `admin`. Core refuses to deactivate the
   last active Core Admin or take Core Admin from them, and logs `[core] NO ADMIN` at startup when
   break-glass is off and no active Core Admin has an email.
2. **The final legacy import (D3) is done.** Its Nrms and Nod steps sign in as the break-glass
   admin; with break-glass off, `Import-GcpeLegacy.ps1` stops before importing anything.
3. **The outside services are set** (D8): the emergency feed (or `NOD_EMERGENCY_FEED=off` on
   purpose), and the bounce mailbox if it's ready (without it, Prod starts with a warning and
   Operations says bounces aren't being read).

**Then** in `C:\gcpe\config\gcpe.env` on the Prod app server:

1. **Turn break-glass off:** cut these five lines and paste them into
   `C:\gcpe\config\break-glass.env`, which the service never reads (Notepad: in the
   Save As box set **Save as type** to **All files**, or it is saved as `break-glass.env.txt`.
   Lock the file the way `Install-Gcpe.ps1` locks `gcpe.env`: no inheritance, full control for
   Administrators and SYSTEM only, and no one else. SYSTEM must be there because the nightly
   backup runs as SYSTEM and copies all of `C:\gcpe\config`; without it the backup fails on this
   file. The service account is left out on purpose, since the service must never read it:
   `icacls C:\gcpe\config\break-glass.env /inheritance:r /grant:r "Administrators:F" "SYSTEM:F"`):
   `LOCAL_ADMIN_ENABLED`, `LOCAL_ADMIN_ALLOW_IN_PRODUCTION`, `LOCAL_ADMIN_USERNAME`,
   `LOCAL_ADMIN_PASSWORD_HASH`, `LOCAL_AUTH_SECRET`.
2. **`SITE_ENVIRONMENT=production`**: if the file says `SITE_ENVIRONMENT=test` instead (an install
   made with `-Environment Test`, or before `-Environment Prod` existed), change it to
   `SITE_ENVIRONMENT=production`. The site stops being noindex and `robots.txt` stops disallowing.
   Keep the line: break-glass in an emergency (below) needs it.
3. **Real mail:** remove `DIST_MAIL_REDIRECT_TO` **and** add `DIST_MAIL_ALLOW_REAL_RECIPIENTS=true`
   (if it isn't there). Removing the redirect alone stops Distribution starting; both together is
   refused.
4. Set `SITE_GOOGLE_VERIFICATION_FILE` and/or `SITE_GOOGLE_SITE_VERIFICATION` to the values Search
   Console issues for the live domain (formats: siteground.md, "Robots and Google Search Console
   verification").
5. **Check before restarting**, then restart:

   ```powershell
   & 'C:\Program Files\nodejs\node.exe' --env-file=C:\gcpe\config\gcpe.env C:\gcpe\current\stack.js --check
   Restart-Service gcpe-stack
   ```

   `--check` must say `"ok": true` with `production.errors` empty. The apps' calls to each other
   don't need break-glass (they use a key derived from `STACK_EVENT_SECRET`), so the stack starts
   with it off.

**Check it**:

- `curl.exe -s https://<public host>/robots.txt` no longer ends with `Disallow: /`;
  `curl.exe -sI https://<public host>/` has no `X-Robots-Tag`, and
  `curl.exe -s https://<public host>/ | Select-String noindex` finds nothing.
- `curl.exe -k -s -o NUL -w '%{http_code}' -X POST https://localhost/core/auth/local/token` is `404`
  (`-k`: Prod's certificate is for the public host, not for `localhost`)
  (no break-glass login), and `Get-Content C:\gcpe\service\logs\gcpe-stack.err.log -Tail 300 | Select-String 'LOCAL ADMIN LOGIN ENABLED|NO ADMIN|refusing to start'`
  finds nothing from the last start.
- One of the Core Admins signs in with Microsoft: Website → Project Blue Bridge no longer says
  "This is a TEST site.", and Subscribers → Operations shows no warning you didn't expect.

**Break-glass in an emergency** (nobody who can sign in has Core Admin, or Microsoft sign-in is
down). It makes no change to how the public site looks or is indexed:

1. On the app server, as an Administrator, make a fresh password and secret, and note the
   password in the password manager:

   ```powershell
   & 'C:\Program Files\nodejs\node.exe' C:\gcpe\current\packages\auth\src\cli\hash-password.js
   $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { '{0:x2}' -f $_ })
   ```

2. Copy the five lines from `C:\gcpe\config\break-glass.env` back into `gcpe.env`, with the new
   hash as `LOCAL_ADMIN_PASSWORD_HASH` and the new 64-character value as `LOCAL_AUTH_SECRET`.
   Check, then restart, so a pasted typo can't take the site down:

   ```powershell
   & 'C:\Program Files\nodejs\node.exe' --env-file=C:\gcpe\config\gcpe.env C:\gcpe\current\stack.js --check
   Restart-Service gcpe-stack
   ```

   `--check` must say `"ok": true` (it warns that the break-glass admin is on, and Operations shows
   that too). Sign in with the `admin` user name and the new password.
3. Fix the problem (for example, give a second person Core Admin).
4. Cut the five lines out of `gcpe.env` again, run the same `--check`, and `Restart-Service
   gcpe-stack`. Every break-glass session ends at that restart.
5. Record in the operations log who turned it on, when, why and when it went off.

### P5. Static fallback for patch reboots (planned, not built)

The plan is a copy of the public site's pages on DMZ proxy #2, served while the app server is
rebooted for patches, so the public site stays up. It is not built and has no steps yet; until it
exists, every app server reboot takes the public site down ([7.4](#74-patching)).

## 6. After every deploy

**Dev** deploys itself on every merge to `develop` (D6). **Test and Prod** are deployed by hand,
with the same package Dev ran, taken from your package archive (GitHub deletes CI artifacts after
14 days, so archive every `gcpe-windows-<commit>.zip` and `gcpe-proxy-<commit>.zip` you install,
with its hash). Run the **new** package's own scripts, not the ones left from an older package:

```powershell
cd C:\install
Get-FileHash .\gcpe-windows-<commit>.zip     # must match the hash recorded in the archive
Unblock-File .\gcpe-windows-<commit>.zip
Expand-Archive .\gcpe-windows-<commit>.zip -DestinationPath .\gcpe-windows-<commit>
cd .\gcpe-windows-<commit>\gcpe-windows
.\Deploy-GcpeRelease.ps1
```

When the release notes say the server setup changed (a new installer step, a new IIS or firewall
setting), run that package's `.\Install-Gcpe.ps1 -HostName <same -HostName>` instead (Prod: plus
`-PostgresAdminUrl …`): it keeps `gcpe.env`, the certificate, the client ranges and the proxy
hops, applies the new setup, and deploys the release itself. If the notes mention the DMZ proxy,
re-run that package's `Install-GcpeProxy.ps1` there (its saved settings are kept).

Parameters: `-Package` (a zip, or a folder containing `app\`; default the package the script is
in), `-Root` (`C:\gcpe`), `-Keep` (releases kept, 5), `-HealthTimeoutSec` (240). It copies the
release to `C:\gcpe\releases\<time>-<commit>`, checks it against `gcpe.env` (`stack.js --check`)
before touching the running site, switches `C:\gcpe\current`, lets the stack apply database
migrations as it starts, waits for `/stack/health` directly and through IIS, and **rolls back by
itself** if either doesn't become healthy. Nothing is needed on the DMZ proxy for a deploy; it may
serve a page up to 60 seconds old.

**Check it**

```powershell
Get-Content C:\gcpe\current\VERSION.json
curl.exe -k -s https://localhost/stack/health
```

Expect the new commit and `"status":"ok"`. Then, for Test and Prod, from outside:
`curl.exe -s -o NUL -w '%{http_code}' https://<public host>/` is `200` and `/hub/` is `404`.

**Precompressed pages.** The public site writes a `.br` and `.gz` copy next to each page as it
renders it. Pages written by an older release have none and are compressed per request instead
(they still work). After the **first** deploy of a release with precompression, write the missing
copies once (safe while the site is serving; later deploys don't need it, but it is harmless):

```powershell
$env:OUTPUT_DIR = 'C:\gcpe\data\site-output'
node.exe C:\gcpe\current\apps\public-site\src\cli\precompress.js
Remove-Item Env:OUTPUT_DIR
```

It prints `[public-site] precompressed <n> files, <n> already current, <n> orphans removed, 0 failed`.
It is in packages built from this commit on; an older package has no
`apps\public-site\src\cli\precompress.js` (there, the copies appear as pages are rewritten).

**Releases that change the page chrome** (`RENDER_CHROME_VERSION` in
`apps/public-site/src/rebuild.ts`): the first start queues one rebuild-all, and the stylesheets
change at once. Until the ticks have rewritten a page, its header and footer can look unstyled. On
a site with the full legacy import the drain takes much longer: deploy outside busy hours, and
watch the queue drain in `/hub/error-log` and on a few old release pages.

**Upgrading an install whose site URLs end in `/site`** (made before the public site moved to the
root): it keeps working at both `/site/…` and `/…`. To move to the root, set `SITE_PUBLIC_SITE_URL`
and `NOD_PUBLIC_SITE_URL` to the origin (`https://<host>`, no `/site`) in `gcpe.env` and restart;
one rebuild-all follows and `/site/…` then 301s to `/…`.

**If releases stop appearing on the public site**, check `/hub/error-log` for a failed site sync
step (`[stack] tick step failed` naming the public site's sync, with the News API's ministries call
or "returned no ministries" as the cause): no page is published while the ministry list can't be
read.

## 7. Operations

### 7.1 Backups and the restore drill

**What is backed up, nightly at 01:30** (`Register-GcpeBackup.ps1`, task **GCPE nightly backup**,
running `C:\gcpe\backup\Backup-Gcpe.ps1` as SYSTEM), into
`<BackupPath>\<COMPUTERNAME>\<yyyyMMdd-HHmmss>\`:

| | From | Which server |
|---|---|---|
| `db\gcpe_*.dump` | `pg_dump -Fc` of every database whose name starts with `gcpe_`, each checked with `pg_restore --list` | where PostgreSQL runs (Dev/Test app server; Prod database server) |
| `files\storage` | `C:\gcpe\data\storage`: release attachments (`/files`). Cannot be rebuilt. | app server |
| `files\calendar-files` | `C:\gcpe\data\calendar-files`: Calendar attachments. Cannot be rebuilt. | app server |
| `config\` | `C:\gcpe\config`: `gcpe.env` (every secret), and on Dev/Test the PostgreSQL superuser password | app server |
| `manifest.json`, `COMPLETE.txt` | sizes, file counts, the release's commit; written last | both |

Not backed up: `C:\gcpe\data\site-output` (the public site; rebuilt from the databases),
`C:\gcpe\releases` (redeploy the package), logs. The files are copied after the dumps, so every file
a dumped row points at is in the backup.

- **Retention:** after a run completes, it deletes this computer's run folders older than
  `-BackupRetentionDays` (14). Only folders it made (named `yyyyMMdd-HHmmss`); a failed run deletes
  nothing, so failures never eat the last good backup.
- **Permissions:** every folder the backup makes is created with inheritance off and
  **FullControl for Administrators and SYSTEM only**, before anything is written into it; on a
  share, also for the writing server's computer account (`<DOMAIN>\<server>$`, which is who SYSTEM
  is to the file server; Administrators and SYSTEM there mean the file server's own). The copied
  `gcpe.env` inherits that, not its source ACL (`robocopy /COPY:DAT`). On a share this is only
  half: the script warns if it cannot set the folder ACL there, and the **share's own permissions
  and its root folder's NTFS permissions must be restricted the same way** (backup administrators
  and the writing servers' computer accounts only) by whoever owns the share. **Restoring needs an
  account that can read the run folders**: a member of the file server's Administrators group, or
  one the share owner grants read access.
- **Recovery point:** up to 24 hours of changes for Dev and Test. Prod adds point-in-time recovery
  (7.2).
- **Failures:** the task's `LastTaskResult` is non-zero and the reason is in the newest
  `C:\gcpe\logs\backup-<time>.log`. Check weekly (or have monitoring read it):

  ```powershell
  Get-ScheduledTask -TaskName 'GCPE nightly backup' | Get-ScheduledTaskInfo | Select-Object LastRunTime, LastTaskResult
  ```

- **A backup now:** `C:\gcpe\backup\Backup-Gcpe.ps1 -BackupPath \\<server>\<share> -Databases -Files`
  (whichever this server holds).

#### Restore (same server, or a rebuilt one)

Run it as an account that can read the backup share. Pick the run folders: `$db` the run with
`db\` (Dev/Test: the app server's; Prod: the database server's), `$files` the app server's run
from the same night (on Dev and Test, the same folder):

```powershell
$db = '\\<backup server>\<share>\<SERVER>\<yyyyMMdd-HHmmss>'
$files = '\\<backup server>\<share>\<APP SERVER>\<yyyyMMdd-HHmmss>'
```

1. **A rebuilt server only:** put the old `gcpe.env` back **before** installing, then install once
   exactly as before (D2/T1, or P1 and P2, same `-HostName`). The installer keeps an existing
   `gcpe.env`, so the server gets its old settings, secrets and `gcpe_app` password, and creates
   PostgreSQL, the login and empty databases to match:

   ```powershell
   New-Item -ItemType Directory -Force C:\gcpe\config | Out-Null
   Import-Module C:\install\gcpe-windows\lib\Gcpe.psm1
   # Locked to Administrators and SYSTEM before it is written; the installer then adds the service.
   Write-GcpeSecretFile -Path C:\gcpe\config\gcpe.env -Value (Get-Content -Raw "$files\config\gcpe.env")
   cd C:\install\gcpe-windows
   .\Install-Gcpe.ps1 -HostName <same host>      # plus everything you passed the first time (Prod: -PostgresAdminUrl …)
   ```

   Do not copy `postgres-superuser.txt` back: a reinstalled PostgreSQL has a new superuser
   password. On Prod, rebuild the database server first (P1), then the app server.
2. Stop the app (on the app server):

   ```powershell
   Stop-Service gcpe-stack
   ```

3. Restore the databases (where PostgreSQL runs; on Prod, on the database server):

   ```powershell
   $bin = 'C:\Program Files\PostgreSQL\17\bin'
   $env:PGPASSWORD = (Get-Content -Raw C:\gcpe\config\postgres-superuser.txt).Trim()
   foreach ($dump in Get-ChildItem "$db\db\gcpe_*.dump") {
       & "$bin\dropdb.exe" -h localhost -U postgres --if-exists --force $dump.BaseName
       & "$bin\pg_restore.exe" -h localhost -U postgres -d postgres --create --exit-on-error $dump.FullName
       if ($LASTEXITCODE -ne 0) { throw "restore of $($dump.BaseName) failed" }
   }
   Remove-Item Env:PGPASSWORD
   ```

   `--create` recreates each database with its own name and owner (`gcpe_app`, which the install
   created) and pgvector.
4. Restore the files (app server). `/MIR` makes the folder exactly the backup's:

   ```powershell
   robocopy "$files\files\storage" C:\gcpe\data\storage /MIR /COPY:DAT /R:2 /W:5
   robocopy "$files\files\calendar-files" C:\gcpe\data\calendar-files /MIR /COPY:DAT /R:2 /W:5
   ```

   The copies inherit `C:\gcpe\data`'s permissions, which let the service change them.
5. Start and rebuild the public site:

   ```powershell
   Remove-Item C:\gcpe\data\site-output\* -Recurse -Force
   Start-Service gcpe-stack
   $e = Get-Content C:\gcpe\config\gcpe.env
   $env:DATABASE_URL = (($e | Where-Object { $_ -like 'SITE_DATABASE_URL=*' }) -split '=', 2)[1]
   $env:PUBLIC_SITE_URL = (($e | Where-Object { $_ -like 'SITE_PUBLIC_SITE_URL=*' }) -split '=', 2)[1]
   $env:NEWS_API_URL = 'http://127.0.0.1:3000/'
   $env:OUTPUT_DIR = 'C:\gcpe\data\site-output'
   node.exe C:\gcpe\current\apps\public-site\src\cli\rebuild-all.js
   Remove-Item Env:DATABASE_URL, Env:PUBLIC_SITE_URL, Env:NEWS_API_URL, Env:OUTPUT_DIR
   ```

   It prints `[public-site] queued <n> pages; they render over the next ticks`.

**Check it**: `curl.exe -k -s https://localhost/stack/health` is `ok`; the Hub lists the releases
from the night of the backup; a release with an attachment downloads it; the public site's home
page fills in as the queue drains (`/hub/error-log` shows no failed site sync).

#### The restore drill (onto Test)

Restore a Prod backup (Dev's, until Prod exists) onto Test at least every quarter, and **time it**:
that time is the recovery time you can promise.

- Follow steps 2 to 5 on the Test app server, with the Prod run folders.
- **Never step 1**: Test keeps its own `gcpe.env`. Prod's would point Test at real mail and
  production secrets. Test's `DIST_MAIL_REDIRECT_TO` keeps the restored subscribers from being
  emailed.
- Restrict Test's proxy to staff ranges while it holds production data (T5): drafts and embargoed
  releases come with it.
- Because Test's site URL differs from Prod's, the site queues a rebuild-all by itself; step 5 is
  still safe.
- Record: the backup's date, the time each step took, and the check results.

### 7.2 Prod point-in-time recovery (to set up when Prod's database server arrives)

The nightly dump can lose up to 24 hours. For Prod, add continuous WAL archiving and a weekly base
backup, so the database can be restored to any moment (recovery point about 5 minutes). Not built
or tested here; these are the settings to apply on the Prod database server.

1. A share for the WAL archive, e.g. `\\<backup server>\gcpe-wal`, writable by the database
   server's computer account (PostgreSQL's service runs as Network Service, which reaches shares
   as the computer account).
2. In `C:\gcpe\pgdata\postgresql.conf` (backslashes doubled, as PostgreSQL requires), then
   `Restart-Service postgresql-x64-17`:

   ```
   wal_level = replica
   archive_mode = on
   archive_command = 'copy "%p" "\\\\<backup server>\\gcpe-wal\\%f"'
   archive_timeout = 300
   ```

3. A weekly base backup (a scheduled task, Sundays), e.g.:

   ```powershell
   $env:PGPASSWORD = (Get-Content -Raw C:\gcpe\config\postgres-superuser.txt).Trim()
   & 'C:\Program Files\PostgreSQL\17\bin\pg_basebackup.exe' -h localhost -U postgres `
       -D "\\<backup server>\gcpe-base\$(Get-Date -Format yyyyMMdd)" -Ft -z -X none -c fast
   ```

   Keep the base backups and the WAL files since the oldest one you keep.
4. Check: `SELECT archived_count, failed_count, last_archived_time FROM pg_stat_archiver;` (in
   `psql`) shows `archived_count` rising and `failed_count` 0.
5. Restore to a moment: stop PostgreSQL, move `C:\gcpe\pgdata` aside, extract the newest base
   backup before that moment into `C:\gcpe\pgdata`, add to `postgresql.conf`
   `restore_command = 'copy "\\\\<backup server>\\gcpe-wal\\%f" "%p"'` and
   `recovery_target_time = '<yyyy-mm-dd hh:mm:ss> America/Vancouver'` (a named zone, so daylight
   time is right), create an empty `recovery.signal` in the
   data folder, and start PostgreSQL. Rehearse this on Test before relying on it.

### 7.3 Logs and retention

| Log | Where | Kept |
|---|---|---|
| IIS, app server | `C:\inetpub\logs\LogFiles\W3SVC<id of GCPE>\` | `-LogRetentionDays` (30), task **GCPE IIS log cleanup (GCPE)** |
| IIS, DMZ proxy | `C:\inetpub\logs\LogFiles\W3SVC<id of GCPE-Proxy>\` | `-LogRetentionDays` (30), task **GCPE IIS log cleanup (GCPE-Proxy)** |
| http.sys errors | `C:\Windows\System32\LogFiles\HTTPERR\` | the same tasks delete files older than the same limit |
| The stack | `C:\gcpe\service\logs\gcpe-stack.out.log`, `.err.log` | rolled at 10 MB, 10 files kept |
| Errors staff saw | `/hub/error-log` (`C:\gcpe\data\logs\errors.jsonl`) | managed by the app |
| Install, proxy install, backup | `C:\gcpe\logs\`, `C:\gcpe-proxy\logs\` | install logs kept; backup logs as long as the backups |

**What IIS still logs**, per request, on both tiers: date and time, the server's address and port,
method, path, query string, user name (none), the client's address, user agent, status, substatus,
Windows status, time taken. On the app server the client is the DMZ proxy for public traffic and
the staff member's address for the Hub; on the proxy it is the visitor. **Not logged:** any request
under `/api/Subscribe`, `/subscribe`, `/news-subscribe`, `/newsletters`, `/enewsletters` (and
`/nod/Subscribe` on the app server), and the `Referer` header anywhere (a subscribe page's own
requests for its stylesheet would carry its token-bearing URL in it). Still logged and worth
knowing: search terms (`/api/v2/search?q=…` query strings).

To see a site's id: `& "$env:windir\System32\inetsrv\appcmd.exe" list site`. To flush buffered
lines before reading: `netsh http flush logbuffer`.

### 7.4 Patching

Patch one tier at a time, in this order, and check after each:

1. **DMZ proxy.** The public site is down while it reboots (the app server and the Hub are not
   affected). Check T4's first rows afterwards.
2. **App server.** Everything is down while it reboots: the public site through the proxy answers
   `502`, and the Hub is unavailable. The service starts by itself (delayed start: about two
   minutes after boot). Check `curl.exe -k -s https://localhost/stack/health`.
3. **Prod database server** (later). The app's database calls fail while it reboots; the site's
   pages already on disk keep being served. Afterwards check health on the app server; if it is
   not `ok` within five minutes, `Restart-Service gcpe-stack`.

Expected public downtime: the length of each reboot of the proxy and of the app server (minutes;
not measured), until the static fallback (P5) exists. Patch outside busy hours, and not during a
scheduled release's embargo time (publishing waits until the stack is back, then catches up).

Windows Update must not restart these servers by itself ([2.1](#21-checklist-per-environment)):
check with your WSUS/GPO owner that the servers are set to download and wait, and restart them
yourself in the window, one tier at a time. After each restart:
`Get-ScheduledTask -TaskName 'GCPE*' | Get-ScheduledTaskInfo` still lists the tasks with their next
run time.

### 7.5 Certificate renewal

| Certificate | How |
|---|---|
| App server | Import the new certificate (with key) into `Cert:\LocalMachine\My`, then from the package of the release that is running: `.\Install-Gcpe.ps1 -HostName <same -HostName> -CertificateThumbprint <new>` (a re-run keeps every other setting; it redeploys the same release). Then, if the new certificate is self-signed or from a different CA, on the DMZ proxy re-run `Install-GcpeProxy.ps1 -HostName <public host> -Upstream https://<internal host> -UpstreamCertificateFile <new .cer>`. |
| DMZ proxy (public) | Import it into `Cert:\LocalMachine\My`, then `.\Install-GcpeProxy.ps1 -HostName <public host> -Upstream https://<internal host> -CertificateThumbprint <new>`. |

**Check it**: `netsh http show sslcert ipport=0.0.0.0:443` shows the new thumbprint (`Certificate
Hash`) on each server; T4's first row still prints `200`. To see expiry dates:
`Get-ChildItem Cert:\LocalMachine\My | Select-Object Subject, NotAfter, Thumbprint`.

### 7.6 Day to day

| Task | How |
|---|---|
| Roll back | Deploy the previous package again; or `Stop-Service gcpe-stack`, `cmd /c rmdir C:\gcpe\current`, `New-Item -ItemType Junction -Path C:\gcpe\current -Target C:\gcpe\releases\<older>`, `Start-Service gcpe-stack`. The last five releases are kept. A rollback doesn't undo database migrations; they are additive, so the older release still runs. One exception to watch: News API migration `0012_unpublish_advisories` takes Advisories off the public site, and a release older than it puts an Advisory published or corrected after the rollback back on the site. |
| Change a setting | Edit `C:\gcpe\config\gcpe.env` as Administrator, then `Restart-Service gcpe-stack`. |
| Restart | `Restart-Service gcpe-stack` (IIS doesn't need restarting). |
| Health | `https://<internal host>/stack/health`; `curl.exe http://127.0.0.1:3000/stack/health` on the server skips IIS. |
| Empty the proxy cache | On the DMZ server: `iisreset /stop`, delete `C:\gcpe-proxy\cache\*`, `iisreset /start`. |
| Roll back the proxy's rules | Each `Install-GcpeProxy.ps1` run keeps the rules it replaced as `C:\gcpe-proxy\logs\web.config.<time>.bak`. Copy the one you want over `C:\gcpe-proxy\site\web.config` (IIS picks it up at once). IIS also keeps copies of its own server settings (`applicationHost.config`) in `C:\inetpub\history`. Or re-run the previous proxy package's `Install-GcpeProxy.ps1`. |
| Scheduled tasks | `Get-ScheduledTask -TaskName 'GCPE*' \| Get-ScheduledTaskInfo \| Format-Table TaskName, LastRunTime, LastTaskResult, NextRunTime` |
| Settings reference | [siteground.md](siteground.md): `TRUST_PROXY_HOPS` (how many proxies are trusted), "Search result cache and semantic cap" (`NEWSAPI_SEARCH_CACHE_TTL_SECONDS`, `NEWSAPI_SEARCH_CACHE_MAX_ENTRIES`, `NEWSAPI_SEARCH_CACHE_MAX_MB`, `NEWSAPI_SEARCH_SEMANTIC_MAX_CONCURRENT`, `NEWSAPI_SEARCH_SEMANTIC_QUEUE`, `NEWSAPI_SEARCH_SEMANTIC_QUEUE_WAIT_MS`, `NEWSAPI_SEARCH_RATE_LIMIT_PER_MIN`), and every other variable. |

What is where on the app server:

```
C:\gcpe\
  current\            → junction to the live release
  releases\<time>-<commit>\
  config\gcpe.env     every setting and secret (Administrators, SYSTEM and the service only)
  config\postgres-superuser.txt   PostgreSQL superuser password, where PostgreSQL runs (Administrators only)
  data\storage\       release attachments (/files)           ← backed up
  data\calendar-files\  Calendar attachments                 ← backed up
  data\site-output\   the generated public site (rebuilt from the databases)
  data\logs\          errors staff saw
  pgdata\             PostgreSQL's data (Dev, Test; Prod: on the database server)
  service\            the WinSW service wrapper and the stack's logs
  site\web.config     the IIS site: forwarding rules only
  backup\             Backup-Gcpe.ps1 and lib\, run by the nightly task
  import-reports\     one folder per import run
  logs\               install and backup logs
```

On the DMZ proxy: `C:\gcpe-proxy\site\web.config` (the rules), `C:\gcpe-proxy\cache\` (the ARR
cache), `C:\gcpe-proxy\logs\` (install logs).

## 8. DMZ proxy reference

### 8.1 What the proxy forwards

Derived from the code at commit `6421522`. The stack answers a fixed list of first path segments
itself (`STACK_OWNED_PREFIXES`, `apps/stack/src/stack.ts:133`; `tests/stack-owned-prefixes.test.ts`
keeps it equal to the stack's mounts); every other GET/HEAD is the public site: old news.gov
addresses, then the static site, then the site's 404 page (`mountSite`,
`apps/stack/src/site-mount.ts:113`, root chain at `:145`; `rootSiteNotFound` at `:155`, mounted at
`apps/stack/src/stack.ts:615`). So the proxy blocks the stack-owned prefixes that aren't public and
forwards the rest by method. `tests/dmz-proxy-allow-list.test.ts` fails when the stack gains a
prefix the proxy doesn't classify. First match wins, in this order:

| Path (any case) | Methods | At the proxy | Why |
|---|---|---|---|
| any path containing `\`, `%5c`, `%2f`, `%2e`, `%00`, or a `.`/`..` segment | all | **404** | IIS decides on the normalised path but forwards the path as sent; refusing these makes them the same path. The stack 404s them anyway (`apps/stack/src/legacy/safe-path.ts:37`). |
| `/hub` | all | **404** | staff app (`apps/stack/src/stack.ts:419`, `:430`) |
| `/core` | all | **404** | Core: staff sign-in, sessions (the only `Set-Cookie`s: `apps/core/src/http/session.ts:52`, `:57`), staff API (`stack.ts:602`) |
| `/nrms`, `/calendar`, `/distribution`, `/site-builder` | all | **404** | staff/service APIs behind bearer tokens (`stack.ts:603`, `:605`, `:609`, `:610`; e.g. `apps/calendar/src/app.ts:41`, `apps/distribution/src/app.ts:30`) |
| `/nod` | all | **404** | NoD's staff API and event receiver (`stack.ts:604`). The public subscribe flow does not use `/nod`: pages call `/api/Subscribe` (`apps/public-site/src/subscribe-pages.ts:39`), which News API proxies to NoD in-process; emailed links point at `/subscribe/manage/` and `/api/Subscribe` (`apps/nod/src/start.ts:165`, `:170`). Open question: `/nod/Subscribe/SubscriberInformation` (Media Hub's lookup, `apps/nod/src/http/membership.ts:146`). |
| `/stack` | all | **404** | `/stack/health`, `/stack/errors`, `/stack/tick` (`stack.ts:533`-`:535`); Windows runs its own loops, no outside scheduler |
| `/events` | all | **404** | signed app-to-app events (`packages/events/src/receiver.ts:33`, News API's at `apps/news-api/src/app.ts:56`) |
| `/health` | all | **404** | News API's readiness probes (`apps/news-api/src/app.ts:53`) |
| `/fake-flickr`, `/fake-media-hub`, `/fake-emergency-feed`, `/fake-entra` | all | **404** | test fakes (`stack.ts:475`, `:493`, `:503`, `:521`) |
| `/api/v2/changes` | all | **404** | the site builder's change feed, bearer only, read in-process (`apps/news-api/src/http/v2/changes.ts:36`) |
| `/api/v2/internal/…` | all | **404** | NRMS's similar-releases call, service token only (`apps/news-api/src/http/v2/routes.ts:135`) |
| `/api/…` | GET, HEAD, POST | forwarded, **never cached** | the public News API other BC systems read (v1 `apps/news-api/src/app.ts:80`; v2 `routes.ts:42`-`:96`, search used by the site's search page, `apps/public-site/src/pages/search.ts:189`) and the subscribe API (`apps/news-api/src/http/v1/subscribe.ts:38`-`:44`, one-click unsubscribe POST `:133`). The app sends `no-store`. |
| `/api/…` | anything else | **404** | no public route takes it |
| `/subscribe…`, `/news-subscribe…`, `/newsletters…`, `/enewsletters…` | GET, HEAD | forwarded, **never cached**, **never logged** | subscribe, manage and unsubscribe pages and their old addresses; tokens travel in the query string |
| any URL with a query string | GET, HEAD | forwarded, **never cached** | search terms and tokens never land on the DMZ disk |
| `/files/…` | GET, HEAD | forwarded, cached as the app says | release attachments (`stack.ts:397`), `public, max-age=60`. Until the release-files gate (T0) is deployed, a file is downloadable from upload, before the release is published, behind a 16-hex random key (`stack.ts:385`-`:392`). |
| `/updates/…` | GET, HEAD | forwarded, cached as the app says | the site's Updates pages (`SITE_PASS_THROUGH`, `stack.ts:161`) |
| everything else (`/`, pages, feeds, assets, `robots.txt`, `/site/…`, old news.gov addresses) | GET, HEAD | forwarded, cached as the app says | the public site (`site-mount.ts:113`-`:145`), `public, max-age=60` |
| everything else | other methods | **404** | includes `POST /updates/negotiate`, the live-updates hub (`apps/news-api/src/updates/hub.ts:102`) |

### 8.2 Caching at the proxy

- It keeps what the app allows and for no longer: the site's pages, feeds, assets and `/files/` are
  `Cache-Control: public, max-age=60`. **After a release is published, the public sees it within
  about a minute**; nothing purges the cache on publish.
- A response without `Cache-Control`, or with `no-store`/`private`/`no-cache`, is not kept (every
  app response after the static mounts is `no-store`, `apps/stack/src/cache-control.ts:22`).
- Never kept, whatever the response says: `/api/…`, the subscribe pages, any URL with a query
  string, and every blocked path.
- `Set-Cookie`: no forwarded path sets a cookie (only `/core`, which is blocked).
- Encodings: the app sends brotli or gzip with `Vary: Accept-Encoding`; a gzip-only client must
  never get a brotli body (T4). **ARR's cache ignores `Vary`.** Per URL it keeps one unencoded copy
  (`full`) and encoded ones (`full.br`, `full.gzip`, in the cache folder). With its defaults it
  served the unencoded copy to every brotli client once that copy was stored, made its own gzip of
  it (with the unencoded copy's ETag) for gzip clients, and never served a stored brotli copy.
  So the script sets the disk cache to keep and serve the app's own brotli and gzip copies only
  (`allowedAcceptEncoding="br,gzip"`, its compression off), and a request whose `Accept-Encoding`
  names neither `br` nor `gzip` (curl, some bots) is forwarded and never stored, so no unencoded
  copy ever exists. Measured on the CI runner: brotli clients get the stored brotli copy, gzip
  clients the stored gzip copy, browsers (`gzip, deflate, br`) one of the two, and clients without
  `Accept-Encoding` an unencoded body straight from the app server. **Trade-off:** those
  unencoded requests always reach the app server.
- The never-kept rules make ARR send `Cache-Control: no-store` in place of the app's own header
  (ARR's override replaces the header the client sees, not only its own caching decision).
  Unencoded answers to a client that takes neither brotli nor gzip carry `no-store` too.
- A URL with a query string is neither stored nor looked up (`queryStringHandling="NoCaching"`):
  ARR's default ignored the query string and answered `/?q=x` with the stored `/`.
- The app server's IIS (`Install-Gcpe.ps1`) uses ARR as well. It has no disk cache of its own,
  but it gets the same never-store rule for unencoded answers, because where both share one
  server (CI) they share one cache, keyed on the public host name.
- Size cap: `-CacheMaxSizeGB` (re-run to change it). To see hits: `X-ARR-CACHE-HIT=1` in the query
  field of the proxy's IIS log.

### 8.3 Why the app server's 443 must be closed to everyone else

With `-ProxyHops 2` the app takes the visitor's address from the second-last entry of
`X-Forwarded-For`. Through the DMZ that is the visitor. A client that reaches the app server
directly controls that entry: it can send `X-Forwarded-For: <any address>` and be counted as that
address by every per-address limit (sign-in, subscribe, search). Hence `-AllowedClientRanges` on the
app server: its 443 accepts the DMZ proxy and the staff ranges only.

**Residual risk:** a person on a staff range can choose the address the app records for their own
requests (per-address limits such as the 10-a-minute sign-in limit). They are already on the
internal network. To close it later, the app server's IIS could clear `X-Forwarded-For` on requests
whose `REMOTE_ADDR` is not the DMZ proxy, or the app could trust a list of proxy addresses instead
of a count (not built).

## 9. Not yet verified

**Checked automatically** by the `windows` workflow on GitHub's Windows Server 2022 and 2025
runners (not on government servers, and not on a domain-joined machine):

- On every pull request until now (green runs on `main`): the full test suite; a clean
  `Install-Gcpe.ps1` (IIS, ARR, Node.js, PostgreSQL 17 + pgvector, the service); the site, staff
  app, https redirect and admin sign-in through IIS (on `https://localhost`, a host name different
  from `-HostName`); a re-run; the automatic rollback of a broken release; the bundled importers
  starting and connecting out.
- The DMZ proxy, first run (run 40796381759, commit `14e6e04`): `Install-GcpeProxy.ps1` in front
  of the app install on the same runner, public host not on the app's certificate; public pages,
  feed, News API and `robots.txt` through the proxy; every staff/internal path and every
  dot-segment or encoded trick answered 404. That run then failed at a test bug ("POST /stack/tick
  is 404": a bodyless POST, fixed in `5e9a2e4`), so the proxy's later checks (POST handling,
  caching per encoding, the client restriction) have **not yet passed on Windows**.
- Run 40799891105 (commit `d8ba43c`), on both 2022 and 2025: ARR leaves the client port out of
  `X-Forwarded-For` on the app server; `dontLog` is set for every subscribe path, real requests
  carrying a token or an e-mail address (including `/Subscribe/` in another case) leave no trace in
  the IIS log while a control request does; no `Referer` field; the log cleanup task deletes a
  40-day-old log and keeps a fresh one. The next step, `-AllowedClientRanges`, failed on a script
  bug (an empty result's `.Count` under StrictMode), fixed after that run; nothing after it ran.
- Added 2026-10-31, in the `windows` workflow's "Production configuration" step and **not yet
  run on Windows** when written: `Install-Gcpe.ps1 -Environment Prod` refusing an incomplete Prod
  before installing anything; the Prod `gcpe.env` passing `stack.js --check` before go-live, after
  P4, and refused when `LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true` has no `SITE_ENVIRONMENT`;
  `Import-GcpeLegacy.ps1` stopping early with break-glass off; the bundled
  `packages\auth\src\cli\hash-password.js`. A full second install in Prod mode isn't run (one
  IIS site per runner). The production-shaped stack itself (break-glass off,
  every app-to-app call) is checked on every pull request by `apps/stack/src/stack-production.test.ts`.
- Added since and **not yet run on Windows**: `-AllowedClientRanges` on the app server (only the
  rule set is checked: CI has no second machine to be refused, and Windows never filters
  loopback), closing 5432 and QUIC, the private data/log folders, the nightly backup (task run as
  SYSTEM, seven dumps, folder ACLs, retention, a dump restored into a scratch database), the proxy
  package and the proxy's saved settings (Prod kept on a re-run), intermediate CA import, and the
  packaged `precompress.js` (bundled and run on macOS against a sample folder).

**Checked by hand** on a Mac, from the built package against a copy of `Gcpe.Hub`: the Core, News
API (34,895 releases, under 2 minutes) and NRMS (balanced, about 3 minutes) imports, and the
Calendar dry run.

**Never run anywhere yet:**

- Any of this on a real government server, Windows Server 2025 from government media, a
  domain-joined server, or behind Group Policy firewall settings.
- A real DMZ: the network firewall, the proxy on its own server, a public certificate, a load
  balancer or NAT in front of it.
- The restore procedure in 7.1 end to end, the restore drill, and backups to a real UNC share
  (computer-account access, SMB signing, the share's permissions).
- WAL archiving and point-in-time recovery (7.2): settings only.
- `Install-GcpeDatabaseServer.ps1` and the app server using a separate database server (Prod).
- The legacy import on Windows against the real legacy SQL Server, and how long it takes; the NoD
  import against real data; SQL Server with Windows authentication only (not supported).
- Entra sign-in end to end on a government tenant, with the internal host as the callback.
- WebSockets through IIS for the News API's live-updates hub (`UPDATES_HUB_ENABLED=true`).
- Uploads refused as too large (over 25 MB on the Calendar, over 512 MB for Website > Files): on
  Windows the browser may see a dropped connection instead of the "file too large" message.
- A 512 MB Website > Files upload end to end through IIS/ARR (the limits below are set, not
  measured).
- A GitHub runner behind the government proxy; Node.js outbound calls through a proxy.
- The patch-reboot downtime (7.4): not measured.

**Built vs planned:**

| Built (in this package) | Planned / not built |
|---|---|
| Dev and Test app server install, DMZ proxy, database server script | Static fallback copy of the public site on the DMZ proxy (P5) |
| `-ProxyHops`, `-AllowedClientRanges`, no port in `X-Forwarded-For` | Clearing `X-Forwarded-For` from non-DMZ clients, or trusting proxy addresses instead of a count (8.3) |
| Private IIS logs and retention, nightly backups with retention | WAL archiving and point-in-time recovery for Prod (7.2), a deploy path for Test/Prod other than by hand |
| Test-site configuration (local admin on, mail redirected), and the production configuration (`-Environment Prod`, the real-production checks, the apps' calls to each other without break-glass, break-glass off at go-live, P4) | Entra client credentials for the apps' calls to each other, needed only once apps run on separate servers |
| | Release attachments blocked until publish: separate branch `feat/release-files-gate` (T0) |
| | Encrypted PostgreSQL connections between the Prod app and database servers |
| | Monitoring and alerting (health, disk, certificate expiry, backup task result) |
