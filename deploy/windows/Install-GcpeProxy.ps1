<#
.SYNOPSIS
  Sets up this Windows Server (in the DMZ) as the public reverse proxy in front of the internal
  GCPE app server: IIS terminates TLS and forwards only the public paths. Safe to run again.

.DESCRIPTION
  No app, no database and no secret other than the TLS certificate live on this server.

  1. Installs IIS, IIS URL Rewrite 2.1 and Application Request Routing 3.0 (the same pinned
     installers as Install-Gcpe.ps1, from .\prereqs\ or downloaded and SHA-256 checked), and IIS
     IP and Domain Restrictions when -AllowedClientRanges is given.
  2. Turns on the ARR proxy (Host header preserved, X-Forwarded-For without the client's port)
     and the ARR disk cache in <Root>\cache, capped at -CacheMaxSizeGB. The cache honours the
     app's Cache-Control (public pages: max-age=60, so a published change shows within about a
     minute); the API, the subscribe pages and any URL with a query string are never cached.
  3. Checks that this server trusts the app server's certificate (-Upstream is never reached
     with certificate checks turned off).
  4. Creates the IIS site "GCPE-Proxy": https on -HttpsPort (443) with the certificate, http on
     -HttpPort (80) redirecting to https. Its rules (docs/deploy/windows.md, 8 "DMZ proxy reference")
     forward only:
       - GET/HEAD of the public site and old news.gov addresses (everything outside the stack's
         own prefixes), /files/ and /updates/;
       - GET/HEAD/POST under /api/ (the public News API and the subscribe API), except
         /api/v2/changes and /api/v2/internal/.
     Everything else answers 404 here and never reaches the app server: /hub, /core, /nrms,
     /nod, /calendar, /distribution, /site-builder, /stack, /events, /health and the test fakes.
  5. -Environment Test adds "X-Robots-Tag: noindex, nofollow" to every response.
  6. IIS never logs the subscribe pages or /api/Subscribe (their URLs carry e-mail addresses and
     tokens), logs no Referer, and a nightly task deletes its logs older than -LogRetentionDays.

  The app server behind it needs Install-Gcpe.ps1 -ProxyHops 2, and its port 443 must accept
  connections only from this server (and the staff network): anything else that can reach it
  directly can choose its own X-Forwarded-For. See docs/deploy/windows.md.

.EXAMPLE
  # Test, open to anyone (still noindex):
  .\Install-GcpeProxy.ps1 -HostName news-test.example.gov.bc.ca -Upstream https://gcpe-test-app.example.internal `
      -CertificateThumbprint <public certificate> -UpstreamCertificateFile C:\install\gcpe-test-app.cer

.EXAMPLE
  # Test, government networks only:
  .\Install-GcpeProxy.ps1 -HostName news-test.example.gov.bc.ca -Upstream https://gcpe-test-app.example.internal `
      -AllowedClientRanges 142.22.0.0/16, 142.34.0.0/16
#>
[CmdletBinding()]
param(
    # The public host name, e.g. news-test.example.gov.bc.ca.
    [Parameter(Mandatory)][string]$HostName,
    # The internal app server: https://<name or IP>[:port], no path. Its certificate must carry that
    # name and be trusted here (an internal CA, or -UpstreamCertificateFile / -UpstreamCertificateThumbprint).
    [Parameter(Mandatory)][string]$Upstream,
    # A .cer file to trust for -Upstream: the app server's own (self-signed) certificate or its CA's
    # root. Imported into Cert:\LocalMachine\Root.
    [string]$UpstreamCertificateFile,
    # The thumbprint of the certificate to trust for -Upstream, already in a LocalMachine store here
    # (copied into LocalMachine\Root when it isn't there yet). With -UpstreamCertificateFile: the
    # file's thumbprint must match.
    [string]$UpstreamCertificateThumbprint,
    # Intermediate CA certificates (.cer) between the app server's certificate and the root above,
    # imported into Cert:\LocalMachine\CA (an internal CA chain: root via -UpstreamCertificateFile).
    [string[]]$UpstreamIntermediateCertificateFile,
    # The thumbprint of the public certificate in Cert:\LocalMachine\My. Omit for a self-signed one
    # (Test only); a re-run keeps the certificate already bound.
    [string]$CertificateThumbprint,
    # Only these client IPv4 ranges (CIDR) may use the site; everyone else gets 403. A re-run keeps
    # the ranges already set unless you pass new ones, or -AllowAllClients to remove the restriction.
    [string[]]$AllowedClientRanges,
    [switch]$AllowAllClients,
    # Test (the default on a first install) or Prod. -Environment, -CacheMaxSizeGB, -HttpsPort,
    # -HttpPort and -LogRetentionDays are saved in <Root>\proxy-settings.json: a re-run without them
    # keeps the values of the last run (so a Prod proxy never turns back into Test by itself).
    [ValidateSet('Test', 'Prod')][string]$Environment = 'Test',
    [ValidateRange(1, 1000)][int]$CacheMaxSizeGB = 5,
    [ValidateRange(1, 65535)][int]$HttpsPort = 443,
    [ValidateRange(1, 65535)][int]$HttpPort = 80,
    [string]$Root = 'C:\gcpe-proxy',
    # IIS log files (and http.sys's HTTPERR logs) older than this many days are deleted every night.
    [ValidateRange(1, 3650)][int]$LogRetentionDays = 30
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\Gcpe.psm1') -Force

# --- The allow-list (docs/deploy/windows.md, 8 "DMZ proxy reference"). ----------------------------
# Every first path segment the stack answers itself (STACK_OWNED_PREFIXES in
# apps/stack/src/stack.ts) must be in exactly one of these lists; anything else is the public
# site. tests/dmz-proxy-allow-list.test.ts fails when the stack gains a prefix that isn't here.
# Staff and internal: 404 here, never forwarded.
$BlockedPaths = @('hub', 'core', 'nrms', 'nod', 'calendar', 'distribution', 'site-builder', 'stack', 'events', 'health', 'fake-flickr', 'fake-media-hub', 'fake-emergency-feed', 'fake-entra', 'api/v2/changes', 'api/v2/internal')
# The public News API and subscribe API: GET, HEAD and POST.
$ApiPaths = @('api')
# Stack-owned but public, GET and HEAD only (like the rest of the site).
$GetOnlyOwnedPaths = @('files', 'updates')
# Public site pages that are never cached here (the subscribe and manage pages; tokens arrive in
# their query strings, and no URL with a query string is cached either).
$NeverCachedPaths = @('subscribe', 'news-subscribe', 'newsletters', 'enewsletters')
# ------------------------------------------------------------------------------------------------

Assert-GcpeAdministrator
if (-not (Get-Command Install-WindowsFeature -ErrorAction SilentlyContinue)) { throw 'This script needs Windows Server (Install-WindowsFeature is missing).' }
if ($AllowedClientRanges -and $AllowAllClients) { throw 'Pass -AllowedClientRanges or -AllowAllClients, not both.' }
# The settings of the last run, unless passed again.
$stateFile = Join-Path $Root 'proxy-settings.json'
$savedNames = @('Environment', 'CacheMaxSizeGB', 'HttpsPort', 'HttpPort', 'LogRetentionDays')
$kept = @()
if (Test-Path -LiteralPath $stateFile) {
    $saved = Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json
    foreach ($name in $savedNames) {
        if (-not $PSBoundParameters.ContainsKey($name) -and @($saved.PSObject.Properties.Name) -contains $name) {
            Set-Variable -Name $name -Value $saved.$name
            $kept += "-$name $($saved.$name)"
        }
    }
    if (@($saved.PSObject.Properties.Name) -contains 'Environment' -and $saved.Environment -eq 'Prod' -and $Environment -eq 'Test') {
        Write-Warning 'This proxy was Prod and -Environment Test turns it into Test: every response gets X-Robots-Tag noindex.'
    }
}
if ($HttpsPort -eq $HttpPort) { throw '-HttpsPort and -HttpPort must differ.' }
$ranges = @()
foreach ($r in @($AllowedClientRanges)) { if ($r) { $ranges += ConvertFrom-GcpeCidr -Cidr $r.Trim() } }

$upstreamUri = $null
if (-not [Uri]::TryCreate($Upstream, [UriKind]::Absolute, [ref]$upstreamUri) -or $upstreamUri.Scheme -ne 'https' -or $upstreamUri.AbsolutePath -ne '/' -or $upstreamUri.Query -or $upstreamUri.UserInfo) {
    throw "-Upstream must be https://<name or IP>[:port] with no path, e.g. https://gcpe-test-app.example.internal (got '$Upstream')."
}
$upstreamBase = $upstreamUri.GetLeftPart([UriPartial]::Authority)

$siteName = 'GCPE-Proxy'
$siteDir = Join-Path $Root 'site'
$cacheDir = Join-Path $Root 'cache'
$logDir = Join-Path $Root 'logs'
foreach ($dir in @($Root, $siteDir, $cacheDir, $logDir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$transcript = Join-Path $logDir ('install-proxy-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
Start-Transcript -Path $transcript | Out-Null
try {
if ($kept.Count -gt 0) { Write-GcpeNote "keeping the last run's $($kept -join ', ') ($stateFile)" }

# --- 1. Prerequisites ------------------------------------------------------------------------
Write-GcpeStep 'IIS'
$featureNames = @('Web-Server', 'Web-Mgmt-Console', 'Web-Http-Logging')
if ($ranges.Count -gt 0) { $featureNames += 'Web-IP-Security' }
$features = Install-WindowsFeature -Name $featureNames
if ($features.RestartNeeded -eq 'Yes') { Write-GcpeNote 'Windows asks for a restart to finish installing IIS; restart after this script completes.' }
Write-GcpeOk "installed: $($featureNames -join ', ')"

Write-GcpeStep 'IIS URL Rewrite'
if (Test-Path -LiteralPath (Join-Path $env:windir 'System32\inetsrv\rewrite.dll')) { Write-GcpeOk 'already installed' }
else { Invoke-GcpeMsi -MsiPath (Get-GcpePrereq -Name UrlRewrite -PackageRoot $PSScriptRoot).Path; Write-GcpeOk 'installed' }

Write-GcpeStep 'IIS Application Request Routing'
if (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'IIS\Application Request Routing\requestRouter.dll')) { Write-GcpeOk 'already installed' }
else { Invoke-GcpeMsi -MsiPath (Get-GcpePrereq -Name Arr -PackageRoot $PSScriptRoot).Path; Write-GcpeOk 'installed' }

$appcmd = Join-Path $env:windir 'System32\inetsrv\appcmd.exe'

# --- 2. ARR proxy and disk cache --------------------------------------------------------------
Write-GcpeStep 'ARR proxy'
# includePortInXForwardedFor off: the app reads X-Forwarded-For as plain addresses.
& $appcmd set config -section:system.webServer/proxy /enabled:"True" /preserveHostHeader:"True" /reverseRewriteHostInResponseHeaders:"False" /includePortInXForwardedFor:"False" /responseBufferLimit:"0" /timeout:"00:02:00" /commit:apphost | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'could not configure the ARR proxy' }
$allowed = (& $appcmd list config -section:system.webServer/rewrite/allowedServerVariables) -join "`n"
foreach ($var in @('HTTP_X_FORWARDED_PROTO', 'ARR_CACHE_CONTROL_OVERRIDE')) {
    if ($allowed -notmatch $var) {
        & $appcmd set config -section:system.webServer/rewrite/allowedServerVariables /+"[name='$var']" /commit:apphost | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "could not allow the server variable $var" }
    }
}
Write-GcpeOk 'on: Host preserved, X-Forwarded-For appended without the client port, 2-minute upstream timeout'

Write-GcpeStep "ARR disk cache ($cacheDir, at most $CacheMaxSizeGB GB)"
# The worker process writes the cache: IIS_IUSRS covers every application pool identity.
Grant-GcpeDirectoryAccess -Path $cacheDir -Account 'BUILTIN\IIS_IUSRS' -Rights Modify
$drives = (& $appcmd list config -section:system.webServer/diskCache) -join "`n"
if ($drives -match [regex]::Escape("path=`"$cacheDir`"")) {
    & $appcmd set config -section:system.webServer/diskCache /"[path='$cacheDir'].maxUsage:$CacheMaxSizeGB" /commit:apphost | Out-Null
} else {
    & $appcmd set config -section:system.webServer/diskCache /+"[path='$cacheDir',maxUsage='$CacheMaxSizeGB']" /commit:apphost | Out-Null
}
if ($LASTEXITCODE -ne 0) { throw "could not configure the ARR disk cache in $cacheDir" }
# ARR's cache ignores Vary. Per URL it keeps an unencoded copy ("full") and encoded ones
# ("full.br", "full.gzip"); once it has the unencoded copy it answers a brotli client with it, and
# a gzip client with its own gzip of it. It serves an encoded copy only for an encoding listed in
# allowedAcceptEncoding (default "gzip": every brotli request went to the app). So: brotli and
# gzip copies, served in that order of preference; none of ARR's own making (compression off:
# only the app's bytes and ETags go out); and the rules below never let it store an unencoded
# copy (docs/deploy/windows.md, 8.2). A URL with a query string is neither stored nor looked up
# (the default, Ignore, answered "/?q=x" with the stored "/").
& $appcmd set config -section:system.webServer/diskCache /allowedAcceptEncoding:"br,gzip" /compression.enabled:"False" /commit:apphost | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'could not set the encodings ARR''s cache keeps' }
& $appcmd set config -section:system.webServer/proxy /cache.queryStringHandling:"NoCaching" /commit:apphost | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'could not stop ARR caching URLs with a query string' }
Write-GcpeOk 'on; it follows the app''s Cache-Control, keeps only brotli and gzip copies, and never stores /api, the subscribe pages, a URL with a query string or an unencoded response'

# --- 3. Trust for the upstream's certificate --------------------------------------------------
Write-GcpeStep "Trust for $upstreamBase"
foreach ($file in @($UpstreamIntermediateCertificateFile | Where-Object { $_ })) {
    if (-not (Test-Path -LiteralPath $file)) { throw "No file $file" }
    $mid = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2((Resolve-Path -LiteralPath $file).Path)
    if ($mid.HasPrivateKey) { throw "$file holds a private key: export the certificate only (.cer)." }
    if (-not (Test-Path -LiteralPath "Cert:\LocalMachine\CA\$($mid.Thumbprint)")) { Import-Certificate -FilePath $file -CertStoreLocation Cert:\LocalMachine\CA | Out-Null }
    Write-GcpeOk "intermediate $($mid.Subject) ($($mid.Thumbprint)) in LocalMachine\CA"
}
if ($UpstreamCertificateFile) {
    if (-not (Test-Path -LiteralPath $UpstreamCertificateFile)) { throw "No file $UpstreamCertificateFile" }
    $fileCert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2((Resolve-Path -LiteralPath $UpstreamCertificateFile).Path)
    if ($fileCert.HasPrivateKey) { throw "$UpstreamCertificateFile holds a private key: export the certificate only (.cer), never the key." }
    if ($UpstreamCertificateThumbprint -and $fileCert.Thumbprint -ne $UpstreamCertificateThumbprint.ToUpperInvariant()) {
        throw "$UpstreamCertificateFile has thumbprint $($fileCert.Thumbprint), not $UpstreamCertificateThumbprint"
    }
    $UpstreamCertificateThumbprint = $fileCert.Thumbprint
    if (-not (Test-Path -LiteralPath "Cert:\LocalMachine\Root\$($fileCert.Thumbprint)")) {
        Import-Certificate -FilePath $UpstreamCertificateFile -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
    }
    Write-GcpeOk "trusting $($fileCert.Subject) ($($fileCert.Thumbprint)), valid until $($fileCert.NotAfter.ToString('yyyy-MM-dd'))"
} elseif ($UpstreamCertificateThumbprint) {
    $thumb = $UpstreamCertificateThumbprint.ToUpperInvariant()
    if (-not (Test-Path -LiteralPath "Cert:\LocalMachine\Root\$thumb")) {
        $found = $null
        foreach ($store in @('My', 'CA', 'WebHosting')) {
            $found = Get-Item -LiteralPath "Cert:\LocalMachine\$store\$thumb" -ErrorAction SilentlyContinue
            if ($found) { break }
        }
        if (-not $found) { throw "No certificate $thumb in Cert:\LocalMachine (Root, My, CA). Import it first, or pass -UpstreamCertificateFile." }
        # The public part only: Root never needs the private key.
        $rootStore = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine')
        $rootStore.Open('ReadWrite')
        try { $rootStore.Add((New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(, $found.RawData))) } finally { $rootStore.Close() }
    }
    Write-GcpeOk "trusting $thumb (Cert:\LocalMachine\Root)"
} else {
    Write-GcpeOk 'nothing added: the upstream''s certificate must already chain to a root this server trusts'
}
# curl.exe uses Windows' own certificate store and checks, like ARR. --ssl-no-revoke: an internal
# or self-signed certificate often has no reachable revocation list; ARR does not check one either.
$probe = Invoke-GcpeCapture -FilePath 'curl.exe' -Arguments @('-sS', '--ssl-no-revoke', '--max-time', '20', '-o', 'NUL', '-w', '%{http_code}', "$upstreamBase/stack/health")
if ($probe.ExitCode -ne 0) {
    throw "Cannot reach $upstreamBase over verified TLS (curl exit $($probe.ExitCode): $($probe.Err)). Check the name in -Upstream is on the app server's certificate, that this server trusts it (-UpstreamCertificateFile), and the firewall from here to the app server's port 443."
}
if ($probe.Out -eq '200') { Write-GcpeOk "$upstreamBase answers over verified TLS; its /stack/health is 200" }
else { Write-GcpeNote "$upstreamBase answers over verified TLS, but its /stack/health is HTTP $($probe.Out): the app may not be running yet" }

# --- 4. The site ------------------------------------------------------------------------------
Write-GcpeStep "IIS site $siteName"
$cert = $null
$boundThumbprint = Get-GcpeSslBinding -Port $HttpsPort
if (-not $CertificateThumbprint -and $boundThumbprint) {
    $CertificateThumbprint = $boundThumbprint
    Write-GcpeOk "keeping the certificate already bound to port $HttpsPort ($boundThumbprint)"
}
if ($CertificateThumbprint) {
    $cert = Get-Item -LiteralPath "Cert:\LocalMachine\My\$CertificateThumbprint" -ErrorAction SilentlyContinue
    if (-not $cert) { throw "No certificate $CertificateThumbprint in Cert:\LocalMachine\My" }
} else {
    if ($Environment -eq 'Prod') { throw 'Prod needs -CertificateThumbprint: a public site never runs on a self-signed certificate.' }
    $cert = Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.FriendlyName -eq "GCPE proxy self-signed ($HostName)" -and $_.NotAfter -gt (Get-Date).AddDays(30) } | Select-Object -First 1
    if (-not $cert) {
        $cert = New-SelfSignedCertificate -DnsName $HostName -CertStoreLocation Cert:\LocalMachine\My -NotAfter (Get-Date).AddYears(2) -FriendlyName "GCPE proxy self-signed ($HostName)"
    }
    Write-GcpeNote "self-signed certificate $($cert.Thumbprint): browsers will warn. Re-run with -CertificateThumbprint once the real certificate is installed."
}

foreach ($other in @(& $appcmd list site /text:name)) {
    if (-not $other -or $other -eq $siteName) { continue }
    $bindings = (& $appcmd list site $other /text:bindings) -join ','
    if ($bindings -match ":($HttpsPort|$HttpPort):") {
        if ($other -eq 'Default Web Site') {
            & $appcmd stop site 'Default Web Site' | Out-Null
            & $appcmd set site 'Default Web Site' /serverAutoStart:false | Out-Null
            Write-GcpeNote "stopped ""Default Web Site"" (it was bound to port $HttpPort or $HttpsPort)"
        } else {
            throw "The IIS site '$other' already uses port $HttpPort or $HttpsPort ($bindings). Pick other ports with -HttpsPort/-HttpPort, or remove that site."
        }
    }
}
if (-not (& $appcmd list apppool $siteName)) { & $appcmd add apppool /name:$siteName /managedRuntimeVersion:"" | Out-Null }
& $appcmd set apppool $siteName /processModel.idleTimeout:"00:00:00" | Out-Null
$wantBindings = "https/*:$($HttpsPort):,http/*:$($HttpPort):"
if (-not (& $appcmd list site $siteName)) {
    & $appcmd add site /name:$siteName /physicalPath:"$siteDir" /bindings:$wantBindings | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "could not create the IIS site $siteName" }
} else {
    & $appcmd set site $siteName /bindings:$wantBindings | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "could not set the bindings of $siteName" }
}
& $appcmd set app "$siteName/" /applicationPool:$siteName | Out-Null
if ($boundThumbprint -ne $cert.Thumbprint.ToUpperInvariant()) {
    if ($boundThumbprint) { Invoke-GcpeQuiet -FilePath netsh.exe -Arguments @('http', 'delete', 'sslcert', "ipport=0.0.0.0:$HttpsPort") }
    & netsh.exe http add sslcert "ipport=0.0.0.0:$HttpsPort" certhash=$($cert.Thumbprint) appid='{4dc3e181-e14b-4a21-b022-59fc669b0914}' certstorename=MY | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "could not bind the certificate to port $HttpsPort" }
}

Write-GcpeStep 'Client address restriction'
$ipSection = 'system.webServer/security/ipSecurity'
if ($ranges.Count -gt 0) {
    & $appcmd clear config $siteName -section:$ipSection /commit:apphost | Out-Null
    foreach ($r in $ranges) {
        & $appcmd set config $siteName -section:$ipSection /+"[ipAddress='$($r.Address)',subnetMask='$($r.Mask)',allowed='True']" /commit:apphost | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "could not allow $($r.Address)/$($r.Mask)" }
    }
    & $appcmd set config $siteName -section:$ipSection /allowUnlisted:"False" /denyAction:"Forbidden" /commit:apphost | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'could not turn on the client address restriction' }
    Write-GcpeOk "only $(@($AllowedClientRanges) -join ', ') may connect; everyone else gets 403"
} elseif ($AllowAllClients) {
    & $appcmd clear config $siteName -section:$ipSection /commit:apphost | Out-Null
    Write-GcpeOk 'removed: every client may connect'
} else {
    $current = (& $appcmd list config $siteName -section:$ipSection) -join "`n"
    if ($current -match 'allowUnlisted="false"') { Write-GcpeOk 'keeping the restriction already set (-AllowAllClients removes it)' }
    else { Write-GcpeOk 'none: every client may connect' }
}

Write-GcpeStep 'Firewall'
$ruleName = 'GCPE proxy: inbound web'
Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort @($HttpsPort, $HttpPort) -Action Allow | Out-Null
Write-GcpeOk "inbound TCP $HttpsPort and $HttpPort open"

# --- The rules --------------------------------------------------------------------------------
# match url is the decoded, normalised path without its leading "/" (IIS has already resolved
# "." and ".." segments), compared without regard to case like Express's own mounts. ^/* also
# catches "//hub".
function Join-Alternatives([string[]]$Items) { ($Items | ForEach-Object { [regex]::Escape($_) }) -join '|' }
$blockedPattern = '^/*(?:' + (Join-Alternatives $BlockedPaths) + ')(?:/|$)'
$apiPattern = '^/*(?:' + (Join-Alternatives $ApiPaths) + ')(?:/|$)'
$neverCachedPattern = '^/*(?:' + (Join-Alternatives $NeverCachedPaths) + ')(?:/|$)'
# The path as sent (before "?") must not hide a segment boundary from that decision: no "\",
# no encoded "/", "\" or ".", no NUL, no "." or ".." segment. The stack answers all of these with
# its 404 anyway (apps/stack/src/legacy/safe-path.ts); refusing them here means the path IIS
# matched is the path the app routes.
$ambiguousPattern = '^[^?]*(?:\\|%5c|%2f|%2e|%00|/\.\.?(?:/|\?|$))'
# A client that takes brotli or gzip (the app answers the rest unencoded; never stored, see 2).
$encodedPattern = '(?:^|[\s,])(?:br|gzip)\s*(?:[,;]|$)'
$httpsAuthority = $HostName
if ($HttpsPort -ne 443) { $httpsAuthority = "$($HostName):$HttpsPort" }
# ARR_CACHE_CONTROL_OVERRIDE "1,no-store": never store, whatever the response says (ARR also sends
# that Cache-Control to the client in place of the app's, so it must be no-store). "0,no-cache":
# store only what the app explicitly allows (a response without Cache-Control is not stored).
$forwardVariables = @'
          <serverVariables>
            <set name="HTTP_X_FORWARDED_PROTO" value="https" />
            <set name="ARR_CACHE_CONTROL_OVERRIDE" value="{0}" />
          </serverVariables>
'@
$neverCache = $forwardVariables -f '1,no-store'
$originDecides = $forwardVariables -f '0,no-cache'
$robots = ''
if ($Environment -eq 'Test') { $robots = '        <add name="X-Robots-Tag" value="noindex, nofollow" />' }
$target = "$upstreamBase{UNENCODED_URL}"

$webConfig = @"
<?xml version="1.0" encoding="UTF-8"?>
<!-- Written by Install-GcpeProxy.ps1 ($Environment). Forwards only the public paths to $upstreamBase.
     The allow-list and why: docs/deploy/windows.md, 8 "DMZ proxy reference". Re-run the script to change it. -->
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <clear />
        <rule name="https only" stopProcessing="true">
          <match url=".*" />
          <conditions><add input="{HTTPS}" pattern="^OFF$" /></conditions>
          <action type="Redirect" url="https://$httpsAuthority{UNENCODED_URL}" appendQueryString="false" redirectType="Permanent" />
        </rule>
        <rule name="refuse ambiguous paths" stopProcessing="true">
          <match url=".*" />
          <conditions><add input="{UNENCODED_URL}" pattern="$ambiguousPattern" /></conditions>
          <action type="CustomResponse" statusCode="404" statusReason="Not Found" statusDescription="Not Found" />
        </rule>
        <rule name="staff and internal paths: 404" stopProcessing="true">
          <match url="$blockedPattern" />
          <action type="CustomResponse" statusCode="404" statusReason="Not Found" statusDescription="Not Found" />
        </rule>
        <rule name="public API (GET, HEAD, POST; never cached)" stopProcessing="true">
          <match url="$apiPattern" />
          <conditions><add input="{REQUEST_METHOD}" pattern="^(?:GET|HEAD|POST)$" /></conditions>
$neverCache
          <action type="Rewrite" url="$target" appendQueryString="false" />
        </rule>
        <rule name="subscribe pages (GET, HEAD; never cached)" stopProcessing="true">
          <match url="$neverCachedPattern" />
          <conditions><add input="{REQUEST_METHOD}" pattern="^(?:GET|HEAD)$" /></conditions>
$neverCache
          <action type="Rewrite" url="$target" appendQueryString="false" />
        </rule>
        <rule name="public site with a query string (GET, HEAD; never cached)" stopProcessing="true">
          <match url=".*" />
          <conditions logicalGrouping="MatchAll">
            <add input="{REQUEST_METHOD}" pattern="^(?:GET|HEAD)$" />
            <add input="{QUERY_STRING}" pattern="." />
          </conditions>
$neverCache
          <action type="Rewrite" url="$target" appendQueryString="false" />
        </rule>
        <rule name="public site for a client that takes neither brotli nor gzip (GET, HEAD; never cached)" stopProcessing="true">
          <match url=".*" />
          <conditions logicalGrouping="MatchAll">
            <add input="{REQUEST_METHOD}" pattern="^(?:GET|HEAD)$" />
            <add input="{HTTP_ACCEPT_ENCODING}" pattern="$encodedPattern" negate="true" />
          </conditions>
$neverCache
          <action type="Rewrite" url="$target" appendQueryString="false" />
        </rule>
        <rule name="public site, files, old news.gov addresses (GET, HEAD; cached as the app says)" stopProcessing="true">
          <match url=".*" />
          <conditions><add input="{REQUEST_METHOD}" pattern="^(?:GET|HEAD)$" /></conditions>
$originDecides
          <action type="Rewrite" url="$target" appendQueryString="false" />
        </rule>
        <rule name="anything else: 404" stopProcessing="true">
          <match url=".*" />
          <action type="CustomResponse" statusCode="404" statusReason="Not Found" statusDescription="Not Found" />
        </rule>
      </rules>
    </rewrite>
    <security>
      <requestFiltering allowDoubleEscaping="true">
        <!-- The largest public request body is a subscribe form (the app accepts 100 KB). -->
        <requestLimits maxAllowedContentLength="1048576" />
      </requestFiltering>
    </security>
    <httpProtocol>
      <customHeaders>
$robots
      </customHeaders>
    </httpProtocol>
    <httpErrors existingResponse="PassThrough" />
  </system.webServer>
</configuration>
"@
$webConfigPath = Join-Path $siteDir 'web.config'
if (Test-Path -LiteralPath $webConfigPath) {
    # The rules this run replaces, for a rollback: copy it back over site\web.config.
    Copy-Item -LiteralPath $webConfigPath -Destination (Join-Path $logDir ('web.config.' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.bak')) -Force
}
[IO.File]::WriteAllText($webConfigPath, $webConfig, (New-Object Text.UTF8Encoding($false)))
$state = [ordered]@{ Environment = $Environment; CacheMaxSizeGB = $CacheMaxSizeGB; HttpsPort = $HttpsPort; HttpPort = $HttpPort; LogRetentionDays = $LogRetentionDays }
[IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Invoke-GcpeQuiet -FilePath $appcmd -Arguments @('start', 'site', $siteName)
Write-GcpeOk "https://$httpsAuthority/ forwards the public paths to $upstreamBase"

Write-GcpeStep "IIS logs: subscribe URLs never logged, $LogRetentionDays days kept"
$iisLogDir = Set-GcpeIisLogging -SiteName $siteName -RetentionDays $LogRetentionDays -PrivatePaths (@('api/Subscribe') + $NeverCachedPaths)
Write-GcpeOk "no entries for /api/Subscribe or the subscribe pages; no Referer field; $iisLogDir keeps $LogRetentionDays days"

# --- 5. Check it through the proxy --------------------------------------------------------------
Write-GcpeStep 'Checking through the proxy'
$resolve = "$($HostName):$($HttpsPort):127.0.0.1"
$base = "https://$httpsAuthority"
function Get-ProxyStatus([string]$Path) {
    $r = Invoke-GcpeCapture -FilePath 'curl.exe' -Arguments @('-k', '-s', '--max-time', '30', '--resolve', $resolve, '-o', 'NUL', '-w', '%{http_code}', "$base$Path")
    $r.Out
}
$restricted = ((& $appcmd list config $siteName -section:$ipSection) -join "`n") -match 'allowUnlisted="false"'
$hubStatus = Get-ProxyStatus '/hub/'
$rootStatus = Get-ProxyStatus '/'
if ($restricted -and $hubStatus -eq '403') {
    Write-GcpeNote 'this server itself is outside -AllowedClientRanges (403), so the check ran no further; check from an allowed address (docs/deploy/windows.md)'
} else {
    if ($hubStatus -ne '404') { throw "/hub/ through the proxy answered HTTP $hubStatus, not 404: the staff app must not be reachable here." }
    if ($rootStatus -eq '200') { Write-GcpeOk '/ is 200 (from the app server), /hub/ is 404' }
    else { Write-GcpeNote "/ answered HTTP $rootStatus through the proxy (502: the app server refused or its certificate isn't trusted; see $transcript and the IIS log); /hub/ is 404" }
}

Write-Host ''
Write-Host 'Installed.' -ForegroundColor Green
Write-Host "  Public site:       https://$httpsAuthority/   ($Environment$(if ($Environment -eq 'Test') { ', noindex' }))"
Write-Host "  Forwards to:       $upstreamBase"
Write-Host "  Cache:             $cacheDir (at most $CacheMaxSizeGB GB)"
Write-Host "  Rules:             $(Join-Path $siteDir 'web.config')"
Write-Host "  This install log:  $transcript"
Write-Host "  IIS logs:          $iisLogDir ($LogRetentionDays days)"
Write-Host '  The app server needs Install-Gcpe.ps1 -ProxyHops 2 -AllowedClientRanges <this server>/32, <staff ranges> (docs/deploy/windows.md, 4 "Test").'

} finally {
    Stop-Transcript | Out-Null
}
