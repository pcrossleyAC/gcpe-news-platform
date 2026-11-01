<#
.SYNOPSIS
  Sets up this Windows Server to run the GCPE News Platform behind IIS, then deploys the release
  in this package. Safe to run again: every step checks what's already there.

.DESCRIPTION
  1. Installs IIS (with WebSockets), IIS URL Rewrite 2.1, Application Request Routing 3.0,
     Node.js 24 and, unless -PostgresAdminUrl points at an existing server, PostgreSQL 17 with
     pgvector. Installers come from .\prereqs\ (Get-GcpePrereqs.ps1 fills it on a machine with
     internet access) or are downloaded, and each is checked against its pinned SHA-256.
  2. On first install, writes <Root>\config\gcpe.env (every setting and generated secret; readable
     only by Administrators and the service). Later runs keep it. -Environment Test (the default)
     writes a test site; -Environment Prod writes the real production site (docs/deploy/windows.md,
     section 5): Entra required, the emergency feed or -EmergencyFeedOff, and real mail unless
     -MailRedirectTo is given until go-live.
  3. Creates the PostgreSQL login and the seven databases, and enables pgvector.
  4. Installs the gcpe-stack Windows service (WinSW running node.exe as NT SERVICE\gcpe-stack).
  5. Creates the IIS site "GCPE": https on 443 (and http on 80 redirecting to it), forwarding
     everything to the stack on 127.0.0.1:<Port> (X-Forwarded-For without the client's port).
     With a real certificate it also sends Strict-Transport-Security (-HstsMaxAgeDays), so a
     browser that has been here once goes straight to https.
     With -AllowedClientRanges, Windows Firewall lets only those ranges reach 443 and 80.
     IIS never logs the subscribe pages or /api/Subscribe (their URLs carry e-mail addresses and
     tokens), logs no Referer, and a nightly task deletes its logs older than -LogRetentionDays.
  6. Deploys the release in this package (Deploy-GcpeRelease.ps1) and checks it's healthy.

.EXAMPLE
  # Dev, everything on this server, a self-signed certificate, mail redirected to one inbox:
  .\Install-Gcpe.ps1 -HostName news-dev.example.gov.bc.ca -SmtpHost apps.smtp.gov.bc.ca `
      -MailFrom noreply-dev@gov.bc.ca -MailRedirectTo you@gov.bc.ca

.EXAMPLE
  # Prod's app server: the real production site, behind DMZ proxy #2, mail redirected until go-live:
  .\Install-Gcpe.ps1 -Environment Prod -HostName news.gov.bc.ca -CertificateThumbprint <thumbprint> `
      -PostgresAdminUrl postgres://postgres@<database server>:5432/postgres -ProxyHops 2 `
      -AllowedClientRanges <DMZ proxy #2 IP>/32, <staff ranges> -SmtpHost apps.smtp.gov.bc.ca `
      -MailFrom noreply@gov.bc.ca -MailRedirectTo you@gov.bc.ca `
      -EntraTenantId <tenant> -EntraClientId <client> -EntraAudience api://<client> `
      -EmergencyFeedUrl 'https://www.emergencyinfobc.gov.bc.ca/category/alerts/feed/?hide_expired=true'

.EXAMPLE
  # Test's app server, behind the DMZ proxy 10.40.1.10, reachable from it and two staff ranges only:
  .\Install-Gcpe.ps1 -HostName news-test.example.gov.bc.ca -CertificateThumbprint <thumbprint> `
      -ProxyHops 2 -AllowedClientRanges 10.40.1.10/32, 142.22.0.0/16, 142.34.0.0/16 `
      -SmtpHost apps.smtp.gov.bc.ca -MailFrom noreply-test@gov.bc.ca -MailRedirectTo you@gov.bc.ca
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$HostName,
    # Test (default): a test site (SITE_ENVIRONMENT=test, all mail redirected). Prod: the real
    # production site. Used only on first install, when gcpe.env is written.
    [ValidateSet('Test', 'Prod')][string]$Environment = 'Test',
    [string]$Root = 'C:\gcpe',
    [int]$Port = 3000,
    # The thumbprint of a certificate already in Cert:\LocalMachine\My. Omit for a self-signed one (Dev only).
    [string]$CertificateThumbprint,
    # postgres://<superuser>@<host>:5432/postgres for an existing server (the password is asked for).
    # Omit to install PostgreSQL 17 on this server.
    [string]$PostgresAdminUrl,
    [Security.SecureString]$PostgresAdminPassword,
    [string]$PostgresDataDir,
    [string]$SmtpHost,
    [int]$SmtpPort = 25,
    [switch]$SmtpSecure,
    [string]$SmtpUser,
    [Security.SecureString]$SmtpPassword,
    [string]$MailFrom,
    [string[]]$MailRedirectTo,
    [string]$AdminUsername = 'admin',
    [Security.SecureString]$AdminPassword,
    [string]$EntraTenantId,
    [string]$EntraClientId,
    [Security.SecureString]$EntraClientSecret,
    [string]$EntraAudience,
    # Prod: the emergency alerts feed (NOD_EMERGENCY_FEED_URL), or -EmergencyFeedOff to switch
    # emergency alerts off on purpose. Prod refuses to start with neither.
    [string]$EmergencyFeedUrl,
    [switch]$EmergencyFeedOff,
    # Google Search Console verification (optional; formats are checked by windows-env.js).
    [string]$GoogleVerificationFile,
    [string]$GoogleSiteVerification,
    # How many reverse proxies sit in front of this server (TRUST_PROXY_HOPS): 1 (default) when
    # clients reach IIS directly; 2 when a DMZ reverse proxy sits in front of this server.
    [ValidateRange(1, 5)][int]$ProxyHops = 1,
    # Only these client IPv4 ranges (CIDR) may reach this server's IIS ports (443 and 80) through
    # Windows Firewall: the DMZ proxy's address and the named staff ranges. A re-run keeps the
    # ranges already set unless you pass new ones, or -AllowAllClients to remove the restriction.
    [string[]]$AllowedClientRanges,
    [switch]$AllowAllClients,
    # IIS log files (and http.sys's HTTPERR logs) older than this many days are deleted every night.
    [ValidateRange(1, 3650)][int]$LogRetentionDays = 30,
    # How long browsers remember to use only https for this host (HSTS). Sent only with a real
    # (not self-signed) certificate. 0 sends max-age=0, telling browsers to forget it. A re-run
    # keeps the value of the last run unless you pass it.
    [ValidateRange(0, 730)][int]$HstsMaxAgeDays = 365
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\Gcpe.psm1') -Force

Assert-GcpeAdministrator
if ($AllowedClientRanges -and $AllowAllClients) { throw 'Pass -AllowedClientRanges or -AllowAllClients, not both.' }
if ($Environment -eq 'Prod' -and -not (Test-Path -LiteralPath (Join-Path $Root 'config\gcpe.env'))) {
    # Checked before anything is installed (windows-env.js checks the same again).
    if (-not ($EntraTenantId -and $EntraClientId -and $EntraAudience)) { throw 'Prod needs Microsoft sign-in for staff: pass -EntraTenantId, -EntraClientId and -EntraAudience (the client secret is asked for).' }
    if ([bool]$EmergencyFeedUrl -eq [bool]$EmergencyFeedOff) { throw 'Prod needs -EmergencyFeedUrl <the emergency alerts feed>, or -EmergencyFeedOff to switch emergency alerts off on purpose (not both).' }
}
# Checked before anything is installed: a typo must never become a wider (or empty) allow-list.
$clientRanges = @()
foreach ($r in @($AllowedClientRanges)) { if ($r) { ConvertFrom-GcpeCidr -Cidr $r.Trim() | Out-Null; $clientRanges += $r.Trim() } }
if (-not (Get-Command Install-WindowsFeature -ErrorAction SilentlyContinue)) { throw 'This script needs Windows Server (Install-WindowsFeature is missing).' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'app\stack.js'))) { throw "Run this from the extracted package: $PSScriptRoot\app\stack.js is missing." }

$paths = Get-GcpePaths -Root $Root
$serviceName = Get-GcpeServiceName
$serviceAccount = Get-GcpeServiceAccount
$siteName = Get-GcpeSiteName
$packageApp = Join-Path $PSScriptRoot 'app'
if (-not $PostgresDataDir) { $PostgresDataDir = Join-Path $Root 'pgdata' }

foreach ($dir in @($paths.Root, $paths.Releases, $paths.Config, $paths.Data, $paths.Service, $paths.ServiceLogs, $paths.Site, $paths.ImportReports, $paths.Logs)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}
# A re-run keeps gcpe.env, so check what it says before installing anything.
$existingEnv = $null
if (Test-Path -LiteralPath $paths.EnvFile) {
    $existingEnv = Read-GcpeEnv -Path $paths.EnvFile
    $dbHost = ([Uri]$existingEnv['CORE_DATABASE_URL']).Host
    if (-not $PostgresAdminUrl -and @('localhost', '127.0.0.1', '::1') -notcontains $dbHost) {
        throw "This server's databases are on $dbHost (gcpe.env). Re-run with -PostgresAdminUrl postgres://postgres@$($dbHost):5432/postgres, or PostgreSQL would be installed here instead."
    }
    $ignored = @('Environment', 'SmtpHost', 'SmtpPort', 'SmtpSecure', 'SmtpUser', 'SmtpPassword', 'MailFrom', 'MailRedirectTo', 'AdminUsername', 'AdminPassword', 'EntraTenantId', 'EntraClientId', 'EntraClientSecret', 'EntraAudience', 'EmergencyFeedUrl', 'EmergencyFeedOff', 'Port') | Where-Object { $PSBoundParameters.ContainsKey($_) }
    $configuredHost = ([Uri]$existingEnv['SITE_PUBLIC_SITE_URL']).Host
}

$transcript = Join-Path $paths.Logs ('install-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
Start-Transcript -Path $transcript | Out-Null
try {
if ($existingEnv) {
    foreach ($name in $ignored) { Write-GcpeNote "-$name is ignored: $($paths.EnvFile) already exists. Edit that file instead, then Restart-Service gcpe-stack." }
    if ($configuredHost -ne $HostName) { Write-GcpeNote "the site is configured for $configuredHost (gcpe.env); -HostName $HostName only changes the self-signed certificate's name." }
}

# --- 1. Prerequisites ------------------------------------------------------------------------
Write-GcpeStep 'IIS with WebSockets'
$features = Install-WindowsFeature -Name Web-Server, Web-WebSockets, Web-Mgmt-Console, Web-Http-Logging
if ($features.RestartNeeded -eq 'Yes') { Write-GcpeNote 'Windows asks for a restart to finish installing IIS; restart after this script completes.' }
Write-GcpeOk 'installed'

Write-GcpeStep 'IIS URL Rewrite'
if (Test-Path -LiteralPath (Join-Path $env:windir 'System32\inetsrv\rewrite.dll')) { Write-GcpeOk 'already installed' }
else { Invoke-GcpeMsi -MsiPath (Get-GcpePrereq -Name UrlRewrite -PackageRoot $PSScriptRoot).Path; Write-GcpeOk 'installed' }

Write-GcpeStep 'IIS Application Request Routing'
if (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'IIS\Application Request Routing\requestRouter.dll')) { Write-GcpeOk 'already installed' }
else { Invoke-GcpeMsi -MsiPath (Get-GcpePrereq -Name Arr -PackageRoot $PSScriptRoot).Path; Write-GcpeOk 'installed' }

Write-GcpeStep 'Node.js'
$nodePrereq = Get-GcpePrereq -Name Node -PackageRoot $PSScriptRoot
$nodeExe = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$installedNode = $null
if (Test-Path -LiteralPath $nodeExe) { $installedNode = (& $nodeExe --version).TrimStart('v') }
if ($installedNode -eq $nodePrereq.Version) { Write-GcpeOk "Node.js $installedNode already installed" }
else { Invoke-GcpeMsi -MsiPath $nodePrereq.Path; Write-GcpeOk "Node.js $($nodePrereq.Version) installed (was: $(if ($installedNode) { $installedNode } else { 'none' }))" }

$pgServiceName = $null
if ($PostgresAdminUrl) {
    Write-GcpeStep 'PostgreSQL: using the existing server given by -PostgresAdminUrl'
    $given = [Uri]$PostgresAdminUrl
    if ($given.UserInfo -match ':') {
        Write-GcpeNote 'the password is part of -PostgresAdminUrl, so it is now in this console''s history; next time leave it out and type it when asked'
        $adminUrl = $PostgresAdminUrl
    } else {
        if (-not $PostgresAdminPassword) { $PostgresAdminPassword = Read-Host "Password for PostgreSQL user '$($given.UserInfo)' on $($given.Host)" -AsSecureString }
        $pgPort = $(if ($given.Port -gt 0) { $given.Port } else { 5432 })
        $adminUrl = 'postgres://{0}:{1}@{2}:{3}{4}' -f $given.UserInfo, [Uri]::EscapeDataString((ConvertFrom-GcpeSecureString $PostgresAdminPassword)), $given.Host, $pgPort, $given.AbsolutePath
    }
} else {
    $pg = Get-GcpePrereq -Name PostgreSQL -PackageRoot $PSScriptRoot
    $pgServiceName = "postgresql-x64-$($pg.Item.Major)"
    $pgPrefix = Join-Path $env:ProgramFiles "PostgreSQL\$($pg.Item.Major)"
    Write-GcpeStep "PostgreSQL $($pg.Version)"
    if (Get-Service -Name $pgServiceName -ErrorAction SilentlyContinue) {
        if (-not (Test-Path -LiteralPath $paths.PgSuperuser)) {
            throw "PostgreSQL is already installed ($pgServiceName) but not by this script. Re-run with -PostgresAdminUrl postgres://postgres:<password>@localhost:5432/postgres."
        }
        Write-GcpeOk 'already installed'
    } else {
        $superPassword = New-GcpeSecret -Bytes 24
        Write-GcpeSecretFile -Path $paths.PgSuperuser -Value $superPassword
        # An option file keeps the superuser password off the installer's command line.
        $optionFile = Join-Path $paths.Config 'pg-install-options.txt'
        Write-GcpeSecretFile -Path $optionFile -Value ((@(
            'mode=unattended', 'unattendedmodeui=none', "superpassword=$superPassword", 'serverport=5432',
            "servicename=$pgServiceName", "prefix=$pgPrefix", "datadir=$PostgresDataDir",
            'enable-components=server,commandlinetools', 'disable-components=pgAdmin,stackbuilder') -join "`r`n") + "`r`n")
        try { Invoke-GcpeInstaller -FilePath $pg.Path -Arguments @('--optionfile', "`"$optionFile`"") }
        finally { Remove-Item -LiteralPath $optionFile -Force -ErrorAction SilentlyContinue }
        Write-GcpeOk "installed: service $pgServiceName, data in $PostgresDataDir, superuser password in $($paths.PgSuperuser)"
    }
    $adminUrl = 'postgres://postgres:' + [Uri]::EscapeDataString((Get-Content -Raw -LiteralPath $paths.PgSuperuser).Trim()) + '@localhost:5432/postgres'

    Write-GcpeStep 'pgvector'
    $pgvector = Join-Path $PSScriptRoot 'prereqs\pgvector'
    if (Test-Path -LiteralPath (Join-Path $pgvector 'vector.dll')) {
        $copies = @(@{ From = Join-Path $pgvector 'vector.dll'; To = Join-Path $pgPrefix 'lib\vector.dll' })
        foreach ($f in Get-ChildItem -LiteralPath $pgvector -File | Where-Object { $_.Name -like 'vector*.sql' -or $_.Name -eq 'vector.control' }) {
            $copies += @{ From = $f.FullName; To = Join-Path $pgPrefix "share\extension\$($f.Name)" }
        }
        $changed = 0
        foreach ($c in $copies) {
            if ((Test-Path -LiteralPath $c.To) -and (Get-FileHash -LiteralPath $c.To).Hash -eq (Get-FileHash -LiteralPath $c.From).Hash) { continue }
            Copy-Item -LiteralPath $c.From -Destination $c.To -Force
            $changed++
        }
        Write-GcpeOk "$changed file(s) updated in $pgPrefix"
    } else {
        Write-GcpeNote 'this package has no prereqs\pgvector (built without it): semantic search stays off'
    }
}

# --- 2. Configuration -------------------------------------------------------------------------
Write-GcpeStep "Configuration ($($paths.EnvFile))"
if ($existingEnv) {
    Write-GcpeOk 'keeping the existing file (edit it and run Restart-Service gcpe-stack to change a setting)'
    if ($PSBoundParameters.ContainsKey('ProxyHops')) {
        # The one setting a re-run may change: it keeps its value unless -ProxyHops is passed.
        $kept = @([IO.File]::ReadAllLines($paths.EnvFile) | Where-Object { $_ -notmatch '^\s*TRUST_PROXY_HOPS\s*=' })
        Write-GcpeSecretFile -Path $paths.EnvFile -ReaderAccount $serviceAccount -Value ((($kept + "TRUST_PROXY_HOPS=$ProxyHops") -join "`n") + "`n")
        Write-GcpeOk "TRUST_PROXY_HOPS=$ProxyHops"
    }
    $coreUrl = [Uri]$existingEnv['CORE_DATABASE_URL']
    $userInfo = $coreUrl.UserInfo.Split(':', 2)
    $db = @{ user = [Uri]::UnescapeDataString($userInfo[0]); password = [Uri]::UnescapeDataString($userInfo[1]); prefix = $coreUrl.AbsolutePath.TrimStart('/') -replace '_core$', '' }
} else {
    if (-not $SmtpHost) { $SmtpHost = Read-Host 'SMTP relay host (e.g. apps.smtp.gov.bc.ca)' }
    if (-not $MailFrom) { $MailFrom = Read-Host 'From address for outgoing mail' }
    if (-not $MailRedirectTo) {
        $question = if ($Environment -eq 'Prod') { 'Until go-live, send ALL outgoing mail to (comma-separated inboxes; leave empty to send to the real recipients)' } else { 'Send ALL outgoing mail to (comma-separated test inboxes)' }
        $MailRedirectTo = @((Read-Host $question).Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }
    if ($Environment -eq 'Prod' -and $EntraTenantId -and -not $EntraClientSecret) { $EntraClientSecret = Read-Host 'Entra client secret for staff sign-in' -AsSecureString }
    if (-not $AdminPassword) { $AdminPassword = Read-Host "Password for the break-glass admin '$AdminUsername' (12+ characters)" -AsSecureString }
    $admin = [Uri]$adminUrl
    $db = @{ user = 'gcpe_app'; password = New-GcpeSecret -Bytes 24; prefix = 'gcpe' }
    $smtp = @{ host = $SmtpHost; port = $SmtpPort; secure = [bool]$SmtpSecure }
    if ($SmtpUser) { $smtp.user = $SmtpUser }
    if ($SmtpUser -and -not $SmtpPassword) { $SmtpPassword = Read-Host "Password for SMTP user '$SmtpUser'" -AsSecureString }
    if ($SmtpPassword) { $smtp.pass = ConvertFrom-GcpeSecureString $SmtpPassword }
    $settings = @{
        hostName = $HostName; dataDir = $paths.Data; port = $Port
        proxyHops = $ProxyHops
        adminUsername = $AdminUsername; adminPassword = ConvertFrom-GcpeSecureString $AdminPassword
        db = @{ host = $admin.Host; port = $(if ($admin.Port -gt 0) { $admin.Port } else { 5432 }); user = $db.user; password = $db.password; prefix = $db.prefix }
        smtp = $smtp; mailFrom = $MailFrom; mailRedirectTo = @($MailRedirectTo)
        environment = $Environment.ToLowerInvariant()
    }
    if ($EmergencyFeedUrl) { $settings.emergencyFeedUrl = $EmergencyFeedUrl }
    if ($EmergencyFeedOff) { $settings.emergencyFeedOff = $true }
    if ($Environment -eq 'Prod' -and @($MailRedirectTo).Count -eq 0) { Write-GcpeNote 'no -MailRedirectTo: mail goes to its real recipients from the first start.' }
    if ($GoogleVerificationFile) { $settings.googleVerificationFile = $GoogleVerificationFile }
    if ($GoogleSiteVerification) { $settings.googleSiteVerification = $GoogleSiteVerification }
    if ($EntraTenantId) {
        if (-not ($EntraClientId -and $EntraClientSecret -and $EntraAudience)) { throw 'Entra needs -EntraTenantId, -EntraClientId, -EntraClientSecret and -EntraAudience together.' }
        $settings.entra = @{ tenantId = $EntraTenantId; clientId = $EntraClientId; clientSecret = ConvertFrom-GcpeSecureString $EntraClientSecret; audience = $EntraAudience }
    }
    $lines = Invoke-GcpeNodeTool -Arguments @((Join-Path $packageApp 'scripts\windows-env.js')) -InputText ($settings | ConvertTo-Json -Depth 5 -Compress)
    Write-GcpeSecretFile -Path $paths.EnvFile -Value $lines
    Write-GcpeOk 'written'
}

# --- 3. Databases -----------------------------------------------------------------------------
Write-GcpeStep 'PostgreSQL login and databases'
$dbResult = Invoke-GcpeNodeTool -Arguments @((Join-Path $packageApp 'scripts\windows-db-setup.js')) -InputText ($db | ConvertTo-Json -Compress) -Environment @{ ADMIN_DATABASE_URL = $adminUrl } | ConvertFrom-Json
Write-GcpeOk "login $($db.user) $($dbResult.role); created: $(@($dbResult.created).Count), already there: $(@($dbResult.existing).Count); pgvector: $(if ($dbResult.pgvector) { 'on' } else { 'OFF (semantic search unavailable)' })"

# --- 4. Windows service -----------------------------------------------------------------------
Write-GcpeStep "Windows service $serviceName"
$winsw = Join-Path $paths.Service "$serviceName.exe"
$winswSource = (Get-GcpePrereq -Name WinSW -PackageRoot $PSScriptRoot).Path
if (-not (Test-Path -LiteralPath $winsw) -or (Get-FileHash -LiteralPath $winsw).Hash -ne (Get-FileHash -LiteralPath $winswSource).Hash) {
    # The running service holds its own exe open: stop it to replace it (the deploy below starts it).
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { Stop-Service -Name $serviceName; (Get-Service -Name $serviceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60)) }
    Copy-Item -LiteralPath $winswSource -Destination $winsw -Force
}
$depend = ''
if ($pgServiceName) { $depend = "  <depend>$pgServiceName</depend>" }
$xml = @"
<service>
  <id>$serviceName</id>
  <name>GCPE News Platform</name>
  <description>GCPE News Platform: every app in one Node.js process, behind IIS (docs/deploy/windows.md).</description>
  <executable>%ProgramFiles%\nodejs\node.exe</executable>
  <arguments>--env-file="$($paths.EnvFile)" "$($paths.Current)\stack.js"</arguments>
  <workingdirectory>$($paths.Current)</workingdirectory>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
$depend
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <onfailure action="restart" delay="60 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>30 sec</stoptimeout>
  <logpath>$($paths.ServiceLogs)</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>10</keepFiles></log>
</service>
"@
[IO.File]::WriteAllText((Join-Path $paths.Service "$serviceName.xml"), $xml, (New-Object Text.UTF8Encoding($false)))
if (-not (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)) {
    & $winsw install | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "WinSW install failed (exit $LASTEXITCODE)" }
    Write-GcpeOk 'installed'
} else {
    Write-GcpeOk 'already installed (the updated settings apply at its next start)'
}
& sc.exe config $serviceName obj= $serviceAccount | Out-Null
if ($LASTEXITCODE -ne 0) { throw "could not set the service to run as $serviceAccount" }
Set-GcpeSecretFileAcl -Path $paths.EnvFile -ReaderAccount $serviceAccount
# Data (subscriber files, attachments, the error log), the stack's logs, install logs and import
# reports would otherwise inherit BUILTIN\Users read access from C:\: Administrators, SYSTEM and
# (for the first two) the service only.
Set-GcpePrivateDirectoryAcl -Path $paths.Data -ModifyAccounts @($serviceAccount)
Set-GcpePrivateDirectoryAcl -Path $paths.ServiceLogs -ModifyAccounts @($serviceAccount)
Set-GcpePrivateDirectoryAcl -Path $paths.Logs
Set-GcpePrivateDirectoryAcl -Path $paths.ImportReports
Write-GcpeOk "runs as $serviceAccount; it may change only $($paths.Data) and its own logs, and read gcpe.env"

Write-GcpeStep "Firewall: port $Port reachable from this server only"
$ruleName = "GCPE stack port $Port (loopback only)"
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Block | Out-Null
}
Write-GcpeOk 'inbound connections to the stack''s port are blocked'

Write-GcpeStep 'Firewall: who may reach IIS (443, 80)'
# Windows Firewall blocks inbound by default and an Allow rule opens a port to the addresses it
# names, so "only these ranges" is: our one Allow rule scoped to the ranges, and no other enabled
# Allow rule for 443 or 80, TCP or UDP. IIS's own rules (IIS-WebServerRole-*: HTTP, HTTPS, and
# QUIC on UDP 443) open them to everyone; they are turned off while the restriction is on, and the
# TCP ones back on without it. Loopback traffic is never filtered, so this server always reaches
# its own IIS.
$webRule = 'GCPE web: allowed client ranges only'
$iisRules = @(Get-NetFirewallRule -Name 'IIS-WebServerRole-*' -ErrorAction SilentlyContinue | Where-Object {
    @(@(($_ | Get-NetFirewallPortFilter).LocalPort) | Where-Object { @('443', '80') -contains $_ }).Count -gt 0 })
$iisTcpRules = @($iisRules | Where-Object { ($_ | Get-NetFirewallPortFilter).Protocol -eq 'TCP' })
if ($clientRanges.Count -gt 0) {
    Get-NetFirewallRule -DisplayName $webRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $webRule -Direction Inbound -Protocol TCP -LocalPort 443, 80 -RemoteAddress $clientRanges -Action Allow | Out-Null
    foreach ($r in $iisRules) { Disable-NetFirewallRule -Name $r.Name }
    # @(): a function returning an empty array returns $null, and $null.Count fails under StrictMode.
    $others = @(Get-GcpeInboundAllowRules -Ports @('443', '80') -ExceptDisplayName @($webRule))
    if ($others.Count -gt 0) {
        throw "These enabled firewall rules also open port 443 or 80 (TCP or UDP) to other addresses, so the restriction would not hold: $(($others | ForEach-Object { "'$($_.DisplayName)' ($($_.Name))" }) -join ', '). Disable them (or ask whoever manages them), then re-run."
    }
    Write-GcpeOk "443 and 80 accept only $($clientRanges -join ', ') (and this server itself)"
} elseif ($AllowAllClients) {
    Get-NetFirewallRule -DisplayName $webRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    foreach ($r in $iisTcpRules) { Enable-NetFirewallRule -Name $r.Name }
    Write-GcpeOk 'restriction removed: 443 and 80 are open to every client'
} elseif (Get-NetFirewallRule -DisplayName $webRule -ErrorAction SilentlyContinue) {
    $kept = @((Get-NetFirewallRule -DisplayName $webRule | Get-NetFirewallAddressFilter).RemoteAddress)
    Write-GcpeOk "keeping the restriction already set: $($kept -join ', ') (-AllowAllClients removes it)"
} else {
    foreach ($r in $iisTcpRules) { Enable-NetFirewallRule -Name $r.Name }
    Write-GcpeOk '443 and 80 are open to every client (no -AllowedClientRanges)'
}

if ($pgServiceName) {
    Write-GcpeStep 'Firewall: PostgreSQL (5432) for this server only'
    # PostgreSQL here serves this server's own stack over localhost; the EDB installer may add a rule
    # opening 5432 to every address. pg_hba.conf refuses other machines anyway; this closes the port.
    foreach ($r in (Get-GcpeInboundAllowRules -Ports @('5432'))) {
        try { Disable-NetFirewallRule -Name $r.Name -ErrorAction Stop; Write-GcpeOk "turned off '$($r.DisplayName)'" }
        catch { Write-GcpeNote "could not turn off '$($r.DisplayName)' (Group Policy?): 5432 is still open to other machines; pg_hba.conf refuses them" }
    }
    Write-GcpeOk 'no rule opens 5432 to other machines'
}

# --- 5. IIS -----------------------------------------------------------------------------------
Write-GcpeStep "IIS site $siteName"
$appcmd = Join-Path $env:windir 'System32\inetsrv\appcmd.exe'
# includePortInXForwardedFor off: the app reads X-Forwarded-For as plain addresses, so per-visitor
# limits key on the client's address, not address:port (a new key for every connection).
# timeout 20 minutes: a 512 MiB Website > Files upload on a slow link (the stack's own request
# timeout is the same, apps/stack/src/server-timeouts.ts).
& $appcmd set config -section:system.webServer/proxy /enabled:"True" /preserveHostHeader:"True" /reverseRewriteHostInResponseHeaders:"False" /includePortInXForwardedFor:"False" /responseBufferLimit:"0" /timeout:"00:20:00" /commit:apphost | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'could not enable the ARR proxy' }
$allowed = (& $appcmd list config -section:system.webServer/rewrite/allowedServerVariables) -join "`n"
foreach ($var in @('HTTP_X_FORWARDED_PROTO', 'HTTP_X_FORWARDED_HOST', 'ARR_CACHE_CONTROL_OVERRIDE')) {
    if ($allowed -notmatch $var) { & $appcmd set config -section:system.webServer/rewrite/allowedServerVariables /+"[name='$var']" /commit:apphost | Out-Null }
}

$cert = $null
$boundThumbprint = Get-GcpeSslBinding
if (-not $CertificateThumbprint -and $boundThumbprint) {
    # A re-run keeps the certificate already in use: only -CertificateThumbprint replaces it.
    $CertificateThumbprint = $boundThumbprint
    Write-GcpeOk "keeping the certificate already bound to port 443 ($boundThumbprint)"
}
if ($CertificateThumbprint) {
    $cert = Get-Item -LiteralPath "Cert:\LocalMachine\My\$CertificateThumbprint" -ErrorAction SilentlyContinue
    if (-not $cert) { throw "No certificate $CertificateThumbprint in Cert:\LocalMachine\My" }
} else {
    $cert = Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.FriendlyName -eq "GCPE self-signed ($HostName)" -and $_.NotAfter -gt (Get-Date).AddDays(30) } | Select-Object -First 1
    if (-not $cert) {
        $cert = New-SelfSignedCertificate -DnsName $HostName, 'localhost' -CertStoreLocation Cert:\LocalMachine\My -NotAfter (Get-Date).AddYears(2) -FriendlyName "GCPE self-signed ($HostName)"
    }
    Write-GcpeNote "self-signed certificate $($cert.Thumbprint): browsers will warn. Re-run with -CertificateThumbprint once a real certificate is installed."
}

if ((& $appcmd list site 'Default Web Site') -and ((& $appcmd list site 'Default Web Site' /text:bindings) -match ':(80|443):')) {
    & $appcmd stop site 'Default Web Site' | Out-Null
    & $appcmd set site 'Default Web Site' /serverAutoStart:false | Out-Null
    Write-GcpeNote 'stopped "Default Web Site" (it was bound to port 80/443)'
}
if (-not (& $appcmd list apppool $siteName)) { & $appcmd add apppool /name:$siteName /managedRuntimeVersion:"" | Out-Null }
& $appcmd set apppool $siteName /processModel.idleTimeout:"00:00:00" | Out-Null
if (-not (& $appcmd list site $siteName)) {
    & $appcmd add site /name:$siteName /physicalPath:"$($paths.Site)" /bindings:"https/*:443:,http/*:80:" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "could not create the IIS site $siteName" }
}
& $appcmd set app "$siteName/" /applicationPool:$siteName | Out-Null
if ($boundThumbprint -ne $cert.Thumbprint.ToUpperInvariant()) {
    if ($boundThumbprint) { Invoke-GcpeQuiet -FilePath netsh.exe -Arguments @('http', 'delete', 'sslcert', 'ipport=0.0.0.0:443') }
    & netsh.exe http add sslcert ipport=0.0.0.0:443 certhash=$($cert.Thumbprint) appid='{4dc3e181-e14b-4a21-b022-59fc669b0914}' certstorename=MY | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'could not bind the certificate to port 443' }
}

# ARR's cache ignores Vary: once it holds an unencoded copy of a page it answers brotli clients
# with it (docs/deploy/windows.md, 8.2). This server configures no ARR disk cache, so ARR keeps
# nothing here; but when a DMZ proxy shares the server (CI), the cache is shared too, so an
# unencoded response is never stored here either (it goes out as Cache-Control: no-store).
$encodedPattern = '(?:^|[\s,])(?:br|gzip)\s*(?:[,;]|$)'
$webConfigPath = Join-Path $paths.Site 'web.config'
if (-not $PSBoundParameters.ContainsKey('HstsMaxAgeDays')) { $HstsMaxAgeDays = Get-GcpeHstsMaxAgeDays -WebConfigPath $webConfigPath -Default $HstsMaxAgeDays }
$hsts = Get-GcpeHstsHeaderLine -Certificate $cert -MaxAgeDays $HstsMaxAgeDays
$webConfig = @"
<?xml version="1.0" encoding="UTF-8"?>
<!-- Written by Install-Gcpe.ps1. IIS only terminates TLS and forwards to the stack on 127.0.0.1:$Port. -->
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="https only" stopProcessing="true">
          <match url=".*" />
          <conditions><add input="{HTTPS}" pattern="^OFF$" /></conditions>
          <action type="Redirect" url="https://{HTTP_HOST}{UNENCODED_URL}" appendQueryString="false" redirectType="Permanent" />
        </rule>
        <rule name="to the stack, for a client that takes neither brotli nor gzip (never cached)" stopProcessing="true">
          <match url=".*" />
          <conditions><add input="{HTTP_ACCEPT_ENCODING}" pattern="$encodedPattern" negate="true" /></conditions>
          <serverVariables>
            <set name="HTTP_X_FORWARDED_PROTO" value="https" />
            <set name="HTTP_X_FORWARDED_HOST" value="{HTTP_HOST}" />
            <set name="ARR_CACHE_CONTROL_OVERRIDE" value="1,no-store" />
          </serverVariables>
          <action type="Rewrite" url="http://127.0.0.1:$Port{UNENCODED_URL}" appendQueryString="false" />
        </rule>
        <rule name="to the stack" stopProcessing="true">
          <match url=".*" />
          <serverVariables>
            <set name="HTTP_X_FORWARDED_PROTO" value="https" />
            <set name="HTTP_X_FORWARDED_HOST" value="{HTTP_HOST}" />
          </serverVariables>
          <action type="Rewrite" url="http://127.0.0.1:$Port{UNENCODED_URL}" appendQueryString="false" />
        </rule>
      </rules>
    </rewrite>
    <security>
      <requestFiltering allowDoubleEscaping="true">
        <!-- 520 MiB: Website > Files uploads take any type up to 512 MiB (MAX_SITE_FILE_BYTES, apps/nrms/src/website/files.ts). -->
        <requestLimits maxAllowedContentLength="545259520" />
      </requestFiltering>
    </security>
    <httpProtocol>
      <customHeaders>
$hsts
      </customHeaders>
    </httpProtocol>
    <httpErrors existingResponse="PassThrough" />
  </system.webServer>
</configuration>
"@
[IO.File]::WriteAllText($webConfigPath, $webConfig, (New-Object Text.UTF8Encoding($false)))
Invoke-GcpeQuiet -FilePath $appcmd -Arguments @('start', 'site', $siteName)
Write-GcpeOk "https://$HostName/ forwards to 127.0.0.1:$Port"
if ($hsts) { Write-GcpeOk "Strict-Transport-Security: max-age=$($HstsMaxAgeDays * 86400) ($HstsMaxAgeDays days)" } else { Write-GcpeNote 'no Strict-Transport-Security on a self-signed certificate' }

Write-GcpeStep "IIS logs: subscribe URLs never logged, $LogRetentionDays days kept"
# The paths whose URLs carry e-mail addresses or tokens (docs/deploy/windows.md, 7.3 "Logs and retention").
$iisLogDir = Set-GcpeIisLogging -SiteName $siteName -RetentionDays $LogRetentionDays -PrivatePaths @('api/Subscribe', 'nod/Subscribe', 'subscribe', 'news-subscribe', 'newsletters', 'enewsletters')
Write-GcpeOk "no entries for /api/Subscribe, /nod/Subscribe or the subscribe pages; no Referer field; $iisLogDir keeps $LogRetentionDays days"

# --- 6. Deploy --------------------------------------------------------------------------------
Write-GcpeStep 'Deploying the release in this package'
& (Join-Path $PSScriptRoot 'Deploy-GcpeRelease.ps1') -Package $PSScriptRoot -Root $Root

Write-Host ''
Write-Host 'Installed.' -ForegroundColor Green
$hops = $ProxyHops
if (-not $PSBoundParameters.ContainsKey('ProxyHops') -and $existingEnv -and $existingEnv.Contains('TRUST_PROXY_HOPS') -and $existingEnv['TRUST_PROXY_HOPS']) { $hops = [int]$existingEnv['TRUST_PROXY_HOPS'] }
if ($hops -ge 2) {
    # Behind the DMZ proxy, which never forwards /hub or /stack: staff use this server's own name.
    $internal = [Net.Dns]::GetHostEntry('').HostName
    Write-Host "  Staff app (Hub):   https://$internal/hub/   (this server's internal name; sign in as '$AdminUsername')"
    Write-Host "  Public site:       https://$HostName/   (through the DMZ proxy)"
    Write-Host "  Health:            https://$internal/stack/health"
} else {
    Write-Host "  Staff app (Hub):   https://$HostName/hub/   (sign in as '$AdminUsername')"
    Write-Host "  Public site:       https://$HostName/"
    Write-Host "  Health:            https://$HostName/stack/health"
}
Write-Host "  Settings:          $($paths.EnvFile)"
Write-Host "  Stack logs:        $($paths.ServiceLogs)"
Write-Host "  This install log:  $transcript"
Write-Host "  IIS logs:          $iisLogDir ($LogRetentionDays days)"
Write-Host '  Next: import the legacy data with .\Import-GcpeLegacy.ps1, then schedule backups with .\Register-GcpeBackup.ps1 (docs/deploy/windows.md).'

} finally {
    Stop-Transcript | Out-Null
}
