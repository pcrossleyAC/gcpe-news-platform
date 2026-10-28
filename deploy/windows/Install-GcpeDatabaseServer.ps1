<#
.SYNOPSIS
  Sets up a separate Windows Server as the GCPE database server: PostgreSQL 17 with pgvector,
  accepting connections from the app server only. Run it on the database server, then run
  Install-Gcpe.ps1 on the app server with the -PostgresAdminUrl this script prints.

.DESCRIPTION
  Use this for Test and Production, where the databases live on their own server (as legacy's
  MSSQL does). For Dev, Install-Gcpe.ps1 installs PostgreSQL on the app server itself and this
  script isn't needed.

  1. Installs PostgreSQL 17 (service postgresql-x64-17) with a generated superuser password,
     saved to <Root>\config\postgres-superuser.txt (Administrators only).
  2. Installs pgvector into it.
  3. Allows password (scram-sha-256) connections from -AppServerAddress only, in pg_hba.conf,
     and opens TCP 5432 in Windows Firewall to that address only.
  Safe to run again.

.EXAMPLE
  .\Install-GcpeDatabaseServer.ps1 -AppServerAddress 10.20.30.40
#>
[CmdletBinding()]
param(
    # The app server's IP address (as this server sees it). Only it may connect.
    [Parameter(Mandatory)][Net.IPAddress]$AppServerAddress,
    [string]$Root = 'C:\gcpe',
    [string]$PostgresDataDir
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\Gcpe.psm1') -Force

Assert-GcpeAdministrator
$paths = Get-GcpePaths -Root $Root
New-Item -ItemType Directory -Force -Path $paths.Root, $paths.Config, $paths.Logs | Out-Null
if (-not $PostgresDataDir) { $PostgresDataDir = Join-Path $Root 'pgdata' }

$pg = Get-GcpePrereq -Name PostgreSQL -PackageRoot $PSScriptRoot
$pgServiceName = "postgresql-x64-$($pg.Item.Major)"
$pgPrefix = Join-Path $env:ProgramFiles "PostgreSQL\$($pg.Item.Major)"

Write-GcpeStep "PostgreSQL $($pg.Version)"
if (Get-Service -Name $pgServiceName -ErrorAction SilentlyContinue) {
    if (-not (Test-Path -LiteralPath $paths.PgSuperuser)) { throw "PostgreSQL ($pgServiceName) is already installed, but not by this script; set it up by hand (docs/deploy/windows.md, separate database server)." }
    Write-GcpeOk 'already installed'
} else {
    $superPassword = New-GcpeSecret -Bytes 24
    Write-GcpeSecretFile -Path $paths.PgSuperuser -Value $superPassword
    $optionFile = Join-Path $paths.Config 'pg-install-options.txt'
    Write-GcpeSecretFile -Path $optionFile -Value ((@(
        'mode=unattended', 'unattendedmodeui=none', "superpassword=$superPassword", 'serverport=5432',
        "servicename=$pgServiceName", "prefix=$pgPrefix", "datadir=$PostgresDataDir",
        'enable-components=server,commandlinetools', 'disable-components=pgAdmin,stackbuilder') -join "`r`n") + "`r`n")
    try { Invoke-GcpeInstaller -FilePath $pg.Path -Arguments @('--optionfile', "`"$optionFile`"") }
    finally { Remove-Item -LiteralPath $optionFile -Force -ErrorAction SilentlyContinue }
    Write-GcpeOk "installed, data in $PostgresDataDir"
}

Write-GcpeStep 'pgvector'
$pgvector = Join-Path $PSScriptRoot 'prereqs\pgvector'
if (-not (Test-Path -LiteralPath (Join-Path $pgvector 'vector.dll'))) { throw 'This package has no prereqs\pgvector; use a package built by CI.' }
# Only files that differ: a vector.dll loaded by a running backend can't be overwritten.
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
Write-GcpeOk "$changed file(s) updated"

Write-GcpeStep "Allowing connections from $AppServerAddress only"
$hba = Join-Path $PostgresDataDir 'pg_hba.conf'
$cidr = if ($AppServerAddress.AddressFamily -eq 'InterNetworkV6') { "$AppServerAddress/128" } else { "$AppServerAddress/32" }
$line = "host    all             all             $cidr            scram-sha-256    # GCPE app server (Install-GcpeDatabaseServer.ps1)"
if (-not (Select-String -LiteralPath $hba -Pattern ('(^|\s)' + [regex]::Escape($cidr) + '(\s|$)') -Quiet)) { Add-Content -LiteralPath $hba -Value $line -Encoding ASCII }
Restart-Service -Name $pgServiceName
$ruleName = 'GCPE PostgreSQL from the app server'
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort 5432 -RemoteAddress $AppServerAddress.ToString() -Action Allow | Out-Null
Write-GcpeOk 'pg_hba.conf and Windows Firewall updated'

Write-Host ''
Write-Host 'Database server ready.' -ForegroundColor Green
Write-Host 'On the app server, run Install-Gcpe.ps1 with:'
Write-Host "  -PostgresAdminUrl postgres://postgres@$($env:COMPUTERNAME):5432/postgres"
Write-Host '(use this server''s DNS name or IP address if the app server can''t resolve its computer name).'
Write-Host "It asks for the superuser password: copy it from $($paths.PgSuperuser) on this server."
