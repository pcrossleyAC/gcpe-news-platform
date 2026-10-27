<#
.SYNOPSIS
  Installs a GitHub Actions self-hosted runner on this server, so pushes to the deploy branch
  deploy here automatically (.github/workflows/deploy-windows-dev.yml).

.DESCRIPTION
  The runner makes an outbound HTTPS connection to github.com and waits for jobs; nothing
  inbound is opened. It runs as a Windows service under LocalSystem, because a deploy stops
  and starts the gcpe-stack service and switches <Root>\current: anyone who can change the
  deploy workflow on the deploy branch can therefore run commands on this server. Protect that
  branch and the "dev" environment in the repository settings (docs/deploy/windows.md, step 7).

  Get -Token from the repository: Settings > Actions > Runners > New self-hosted runner
  (it is valid for one hour).

.EXAMPLE
  .\Install-GcpeRunner.ps1 -RepositoryUrl https://github.com/bcgov-c/gcpe-news-platform -Token AAAA... -Labels gcpe-dev
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RepositoryUrl,
    [Parameter(Mandatory)][string]$Token,
    [string]$Labels = 'gcpe-dev',
    [string]$RunnerDir = 'C:\actions-runner',
    [string]$Version = '2.338.2',
    [string]$Sha256 = 'a1f17aa987fc8158bc7521d284912267a0d01b7c2c4684b33c86783b5e8221cc'
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\Gcpe.psm1') -Force

Assert-GcpeAdministrator
if (Test-Path -LiteralPath (Join-Path $RunnerDir '.runner')) { Write-GcpeOk "a runner is already configured in $RunnerDir"; return }

Write-GcpeStep "Downloading the GitHub Actions runner $Version"
New-Item -ItemType Directory -Force -Path $RunnerDir | Out-Null
$zip = Join-Path $RunnerDir "actions-runner-win-x64-$Version.zip"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/actions/runner/releases/download/v$Version/actions-runner-win-x64-$Version.zip" -OutFile $zip
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant() -ne $Sha256) { Remove-Item -LiteralPath $zip; throw "The runner download doesn't match its SHA-256 $Sha256." }
Expand-Archive -LiteralPath $zip -DestinationPath $RunnerDir -Force
Remove-Item -LiteralPath $zip
Write-GcpeOk 'downloaded'

Write-GcpeStep 'Registering it with the repository and installing the service'
Push-Location $RunnerDir
try {
    & .\config.cmd --unattended --url $RepositoryUrl --token $Token --name $env:COMPUTERNAME --labels $Labels --work _work --runasservice --windowslogonaccount 'NT AUTHORITY\SYSTEM' --replace
    if ($LASTEXITCODE -ne 0) { throw "config.cmd failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }
Write-GcpeOk "registered with labels self-hosted, Windows, X64, $Labels"
