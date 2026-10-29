<#
.SYNOPSIS
  Copies the legacy Hub's data from its SQL Server into this server's GCPE databases, in the
  order the importers depend on, and writes a report for each step.

.DESCRIPTION
  Runs the importers that ship in the deployed release (<Root>\current), against the databases
  in <Root>\config\gcpe.env, while the gcpe-stack service is running (the stack delivers the
  events the importers write, so every app ends up with the same ministries, users and lists):

    1. Core       ministries, sectors, themes, tags              (Gcpe.Hub)
    2. NewsApi    published releases, home page, slides, links   (Gcpe.Hub)
    3. Nrms       users, media lists, every release, website     (Gcpe.Hub)
       then       asks Core and NRMS to republish, and waits for NoD to receive the media lists
    4. Nod        subscribers, lists, recent sends               (Gcpe.NewsOnDemand)
    5. Calendar   activities and everything around them          (Gcpe.Hub)
                  a dry run unless -ConfirmCalendar

  Every importer is safe to re-run: rows already imported are updated or skipped, never
  duplicated, and anything staff changed in the new system since the last import is kept and
  listed in the report. Nothing is published and no one is emailed. Reports go to
  <Root>\import-reports\<time>\.

  Only SQL Server logins (user name and password) are supported, not Windows authentication.

.EXAMPLE
  .\Import-GcpeLegacy.ps1 -SqlServer legacy-sql.example.gov.bc.ca -SqlUser gcpe_reader -CalendarCutoff 2025-11-01

.EXAMPLE
  # Only the Calendar, for real this time:
  .\Import-GcpeLegacy.ps1 -SqlServer legacy-sql -SqlUser gcpe_reader -Only Calendar -CalendarCutoff 2025-11-01 -ConfirmCalendar
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SqlServer,
    [Parameter(Mandatory)][string]$SqlUser,
    [Security.SecureString]$SqlPassword,
    # Accept the SQL Server's certificate without validating it (a self-signed legacy server).
    [switch]$TrustServerCertificate,
    [string]$HubDatabase = 'Gcpe.Hub',
    [string]$NodDatabase = 'Gcpe.NewsOnDemand',
    [ValidateSet('Core', 'NewsApi', 'Nrms', 'Nod', 'Calendar')][string[]]$Only = @('Core', 'NewsApi', 'Nrms', 'Nod', 'Calendar'),
    # Calendar activities that end before this date (yyyy-MM-dd) aren't imported. Required for the Calendar step.
    [string]$CalendarCutoff,
    [switch]$ConfirmCalendar,
    [ValidateRange(1, 92)][int]$NodSinceDays = 30,
    [Security.SecureString]$AdminPassword,
    [string]$Root = 'C:\gcpe'
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\Gcpe.psm1') -Force

Assert-GcpeAdministrator
$paths = Get-GcpePaths -Root $Root
$envValues = Read-GcpeEnv -Path $paths.EnvFile
$release = Get-GcpeJunctionTarget -Path $paths.Current
if (-not $release) { throw "Nothing is deployed at $($paths.Current). Run Install-Gcpe.ps1 first." }
$node = Get-GcpeNodePath
$base = "http://127.0.0.1:$($envValues['PORT'])"
# The session cookie is Secure-only, so signed-in calls go through IIS's https (-k: Dev may be self-signed).
$adminBase = 'https://localhost'
$script:jar = $null
if ($Only -contains 'Calendar') {
    if ($CalendarCutoff -notmatch '^\d{4}-\d{2}-\d{2}$') { throw '-CalendarCutoff yyyy-MM-dd is required for the Calendar step (activities ending before it are left out).' }
    if (-not $envValues.Contains('CALENDAR_DATABASE_URL')) { throw "CALENDAR_DATABASE_URL isn't set in $($paths.EnvFile)." }
}
Wait-GcpeHealth -Url "$base/stack/health" -TimeoutSec 60 | Out-Null
if (-not $SqlPassword) { $SqlPassword = Read-Host "Password for SQL Server login $SqlUser" -AsSecureString }

$reports = Join-Path $paths.ImportReports (Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Force -Path $reports | Out-Null
$legacy = @{
    LEGACY_SQL_SERVER     = $SqlServer
    LEGACY_SQL_USER       = $SqlUser
    LEGACY_SQL_PASSWORD   = ConvertFrom-GcpeSecureString $SqlPassword
    LEGACY_SQL_TRUST_CERT = $(if ($TrustServerCertificate) { 'true' } else { 'false' })
    TENANT_CONFIG         = Join-Path $release 'config\tenants\bc.json'
}
# The stack's own tenant file when gcpe.env names one (docs/deploy/windows.md, D8), so the
# importers and the running stack read the same settings.
if ($envValues.Contains('TENANT_CONFIG') -and $envValues['TENANT_CONFIG']) { $legacy.TENANT_CONFIG = $envValues['TENANT_CONFIG'] }
$summary = New-Object System.Collections.Generic.List[object]

function Get-EventSubscribers([string]$Prefix) {
    $vars = @{}
    foreach ($k in $envValues.Keys) { $vars[$k] = $envValues[$k] }
    (Invoke-GcpeNodeTool -Arguments @((Join-Path $release 'scripts\windows-env.js'), '--event-subscribers', $Prefix) -Environment $vars).Trim()
}

# Runs one importer with its own environment. Exit 0: done. Exit 2: done, but the report doesn't
# balance (read it). Anything else stops the run, since later steps depend on earlier ones.
function Invoke-Importer([string]$Step, [string]$Tool, [hashtable]$Variables, [string[]]$Arguments) {
    Write-GcpeStep $Step
    $vars = $legacy.Clone()
    foreach ($k in $Variables.Keys) { $vars[$k] = $Variables[$k] }
    $log = Join-Path $reports "$($Step.Split(' ')[0].ToLowerInvariant()).log"
    $exit = Invoke-GcpeWithEnv -Variables $vars -Script {
        # Continue, and each stderr line turned back into text: under Stop, Windows PowerShell 5.1
        # ends the step at an importer's first warning, before its exit code is read.
        $ErrorActionPreference = 'Continue'
        Push-Location $release
        try {
            & $node (Join-Path $release $Tool) @Arguments 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $log | Out-Host
            $LASTEXITCODE
        } finally { Pop-Location }
    }
    $outcome = switch ($exit) { 0 { 'ok' } 2 { 'done, report does not balance' } default { "FAILED (exit $exit)" } }
    $summary.Add([pscustomobject]@{ Step = $Step; Outcome = $outcome; Log = $log })
    if ($exit -eq 0) { Write-GcpeOk "done ($log)" }
    elseif ($exit -eq 2) { Write-GcpeNote "the report doesn't balance: read it before relying on this data ($reports)" }
    else { throw "$Step failed (exit $exit). Its output is in $log; fix the cause and re-run (completed steps are safe to repeat)." }
}

function Invoke-Admin([string]$Method, [string]$Path, [string]$Body = '{}') {
    $common = @('-k', '-sS', '-f', '-b', $script:jar, '-c', $script:jar, '-H', 'x-gcpe-request: 1')
    if ($Method -eq 'GET') { $out = & curl.exe @common "$adminBase$Path" }
    else { $out = $Body | & curl.exe @common -X $Method -H 'content-type: application/json' --data-binary '@-' "$adminBase$Path" }
    if ($LASTEXITCODE -ne 0) { throw "$Method $Path failed (curl exit $LASTEXITCODE)" }
    ($out | Out-String) | ConvertFrom-Json
}

$OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
    if ($Only -contains 'Core') {
        Invoke-Importer 'Core reference data' 'apps\core\src\import\cli.js' @{
            DATABASE_URL = $envValues['CORE_DATABASE_URL']; LEGACY_SQL_DATABASE = $HubDatabase; EVENT_SUBSCRIBERS = Get-EventSubscribers 'CORE'
        } @()
    }
    if ($Only -contains 'NewsApi') {
        Invoke-Importer 'NewsApi published news' 'apps\news-api\src\import\cli.js' @{
            DATABASE_URL = $envValues['NEWSAPI_DATABASE_URL']; LEGACY_SQL_DATABASE = $HubDatabase
        } @()
    }
    if ($Only -contains 'Nrms') {
        Invoke-Importer 'Nrms releases and website' 'apps\nrms\src\import\cli.js' @{
            DATABASE_URL = $envValues['NRMS_DATABASE_URL']; CORE_DATABASE_URL = $envValues['CORE_DATABASE_URL']; LEGACY_SQL_DATABASE = $HubDatabase; EVENT_SUBSCRIBERS = Get-EventSubscribers 'NRMS'
        } @('--report', (Join-Path $reports 'nrms-import.json'))
    }
    if ($Only -contains 'Nrms' -or $Only -contains 'Nod') {
        Write-GcpeStep 'Republishing Core''s reference data and NRMS''s media lists to the other apps'
        if (-not $AdminPassword) { $AdminPassword = Read-Host "Password for the break-glass admin '$($envValues['LOCAL_ADMIN_USERNAME'])'" -AsSecureString }
        $script:jar = Join-Path $reports '.session'
        Write-GcpeSecretFile -Path $script:jar
        $login = @{ username = $envValues['LOCAL_ADMIN_USERNAME']; password = ConvertFrom-GcpeSecureString $AdminPassword } | ConvertTo-Json -Compress
        Invoke-Admin POST '/core/auth/login' $login | Out-Null
        Invoke-Admin POST '/core/api/admin/republish' | Out-Null
        $sent = (Invoke-Admin POST '/nrms/api/media-lists/republish').count
        Write-GcpeOk "NRMS sent $sent media lists; waiting for NoD to receive them (up to 5 minutes)"
        $deadline = (Get-Date).AddMinutes(5)
        do {
            # Assigned first: Windows PowerShell's ConvertFrom-Json emits a JSON array as one object,
            # so @(...) around the call would count 1 whatever the length.
            $lists = Invoke-Admin GET '/nod/api/media-lists'
            $mirrored = $lists.Count
            if ($mirrored -ge $sent) { break }
            Start-Sleep -Seconds 15
        } while ((Get-Date) -lt $deadline)
        if ($mirrored -lt $sent) { throw "NoD has $mirrored of $sent media lists after 5 minutes. Check https://localhost/stack/health and $($paths.ServiceLogs), then re-run with -Only Nod." }
        Write-GcpeOk "NoD has all $mirrored media lists"
    }
    if ($Only -contains 'Nod') {
        Invoke-Importer 'Nod subscribers' 'apps\nod\src\import\cli.js' @{
            DATABASE_URL = $envValues['NOD_DATABASE_URL']; NRMS_DATABASE_URL = $envValues['NRMS_DATABASE_URL']; PUBLIC_SITE_URL = $envValues['NOD_PUBLIC_SITE_URL']; LEGACY_SQL_DATABASE = $NodDatabase
        } @('--report', (Join-Path $reports 'nod-import.json'), '--since-days', "$NodSinceDays")
    }
    if ($Only -contains 'Calendar') {
        $calendarArgs = @('--cutoff', $CalendarCutoff, '--report', (Join-Path $reports 'calendar-import.json'))
        if ($ConfirmCalendar) { $calendarArgs += '--confirm' }
        Invoke-Importer $(if ($ConfirmCalendar) { 'Calendar activities' } else { 'Calendar activities (dry run)' }) 'apps\calendar\src\import\cli.js' @{
            DATABASE_URL = $envValues['CALENDAR_DATABASE_URL']; CORE_DATABASE_URL = $envValues['CORE_DATABASE_URL']; LEGACY_SQL_DATABASE = $HubDatabase
            CALENDAR_STORAGE_DIR = Join-Path $envValues['DATA_DIR'] 'calendar-files'; CORE_EVENT_SUBSCRIBERS = Get-EventSubscribers 'CORE'
        } $calendarArgs
        if (-not $ConfirmCalendar) { Write-GcpeNote 'that was a dry run: read calendar-import.txt, then re-run with -Only Calendar -ConfirmCalendar' }
    }
} finally {
    if ($script:jar -and (Test-Path -LiteralPath $script:jar)) { Remove-Item -LiteralPath $script:jar -Force }
    Write-Host ''
    $summary | Format-Table -AutoSize | Out-Host
    Write-Host "Reports and logs: $reports"
}
