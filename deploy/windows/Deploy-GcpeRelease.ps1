<#
.SYNOPSIS
  Installs one GCPE release on this server and switches the site to it, rolling back on failure.

.DESCRIPTION
  1. Copies the package's app\ folder to <Root>\releases\<time>-<commit>.
  2. Checks the new release against this server's configuration (node stack.js --check) before
     touching the running site; a release that fails the check is removed and nothing changes.
  3. Stops the gcpe-stack service, points <Root>\current at the new release, starts the service.
     The stack applies any new database migrations as it starts.
  4. Waits for /stack/health to report "ok" (or "degraded": every app up, a background check red)
     directly and through IIS. If either doesn't, points
     <Root>\current back at the previous release, restarts, and exits with an error.
  5. Keeps the newest -Keep releases and deletes older ones.

  Run by Install-Gcpe.ps1 on first install, by the GitHub Actions deploy job, or by hand.

.PARAMETER Package
  A gcpe-windows-<commit>.zip, or a folder containing app\ (an extracted package). Defaults to the
  package this script is in.

.EXAMPLE
  .\Deploy-GcpeRelease.ps1 -Package D:\drops\gcpe-windows-1a2b3c4d5e6f.zip
#>
[CmdletBinding()]
param(
    [string]$Package = $PSScriptRoot,
    [string]$Root = 'C:\gcpe',
    [int]$Keep = 5,
    [int]$HealthTimeoutSec = 240
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\Gcpe.psm1') -Force

Assert-GcpeAdministrator
$paths = Get-GcpePaths -Root $Root
$service = Get-GcpeServiceName
if (-not (Get-Service -Name $service -ErrorAction SilentlyContinue)) { throw "The $service service isn't installed. Run Install-Gcpe.ps1 first." }
$envValues = Read-GcpeEnv -Path $paths.EnvFile
$port = $envValues['PORT']
$node = Get-GcpeNodePath

Write-GcpeStep 'Locating the release in the package'
$expanded = $null
if ($Package -like '*.zip') {
    $expanded = Join-Path $env:TEMP ('gcpe-package-' + [guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $Package -DestinationPath $expanded
    $Package = $expanded
}
$app = @((Join-Path $Package 'app'), (Join-Path $Package 'gcpe-windows\app')) | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'stack.js') } | Select-Object -First 1
if (-not $app) { throw "No app\stack.js under $Package" }
$version = Get-Content -Raw -LiteralPath (Join-Path $app 'VERSION.json') | ConvertFrom-Json
# Time first, so the release folders sort oldest to newest by name.
$id = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $version.commit.Substring(0, 12)
$release = Join-Path $paths.Releases $id
Write-GcpeOk "commit $($version.commit), built $($version.builtAt)"

try {
    Write-GcpeStep "Copying to $release"
    New-Item -ItemType Directory -Force -Path $paths.Releases | Out-Null
    & robocopy.exe $app $release /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE)" }
    Write-GcpeOk 'copied'

    Write-GcpeStep 'Checking the release against this server''s configuration (stack.js --check)'
    Push-Location $release
    try {
        & $node "--env-file=$($paths.EnvFile)" (Join-Path $release 'stack.js') --check
        $checkExit = $LASTEXITCODE
    } finally { Pop-Location }
    if ($checkExit -ne 0) {
        Remove-Item -LiteralPath $release -Recurse -Force
        throw "stack.js --check failed (exit $checkExit): the running site was not changed. Fix the configuration it names in $($paths.EnvFile) and deploy again."
    }
    Write-GcpeOk 'configuration accepted'
} finally {
    if ($expanded) { Remove-Item -LiteralPath $expanded -Recurse -Force -ErrorAction SilentlyContinue }
}

$previous = Get-GcpeJunctionTarget -Path $paths.Current

function Switch-GcpeRelease([string]$Target) {
    Stop-Service -Name $service -ErrorAction SilentlyContinue
    (Get-Service -Name $service).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
    Set-GcpeJunction -Path $paths.Current -Target $Target
    Start-Service -Name $service
}

Write-GcpeStep "Switching the site to $id"
Switch-GcpeRelease $release
try {
    $health = Wait-GcpeHealth -Url "http://127.0.0.1:$port/stack/health" -TimeoutSec $HealthTimeoutSec
    Write-GcpeOk ("the stack is healthy: " + (($health.apps.PSObject.Properties | ForEach-Object { $_.Name }) -join ', '))
    Wait-GcpeHealth -Url 'https://localhost/stack/health' -TimeoutSec 60 | Out-Null
    Write-GcpeOk 'IIS forwards https://localhost/ to it'
} catch {
    $failure = $_.Exception.Message
    if ($previous) {
        Write-GcpeNote "the new release isn't healthy ($failure); rolling back to $(Split-Path -Leaf $previous)"
        Switch-GcpeRelease $previous
        Wait-GcpeHealth -Url "http://127.0.0.1:$port/stack/health" -TimeoutSec $HealthTimeoutSec | Out-Null
        throw "Deploy of $id failed and was rolled back to $(Split-Path -Leaf $previous): $failure. The stack's own log is in $($paths.ServiceLogs)."
    }
    throw "Deploy of $id failed and there is no earlier release to roll back to: $failure. The stack's own log is in $($paths.ServiceLogs)."
}

Write-GcpeStep 'Removing old releases'
$current = Get-GcpeJunctionTarget -Path $paths.Current
Get-ChildItem -LiteralPath $paths.Releases -Directory | Sort-Object Name -Descending | Select-Object -Skip $Keep |
    Where-Object { $_.FullName -ne $current } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force; Write-GcpeOk "removed $($_.Name)" }

Write-Host ''
Write-Host "Deployed $id." -ForegroundColor Green
