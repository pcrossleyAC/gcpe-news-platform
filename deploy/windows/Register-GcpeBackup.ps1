<#
.SYNOPSIS
  Schedules the nightly GCPE backup on this server (Backup-Gcpe.ps1, as SYSTEM), runs it once
  now and reports whether it worked. Safe to run again: it replaces the task.

.DESCRIPTION
  What is backed up depends on what this server holds (or -Databases / -Files):
    - the databases, where this server runs the GCPE PostgreSQL (Dev and Test app servers; Prod's
      database server);
    - the files and settings, where this server runs the app (every app server).
  So on Dev and Test run it once on the app server; on Prod, once on the database server and
  once on the app server, with the same -BackupPath.

  1. Copies Backup-Gcpe.ps1 and lib\ to <Root>\backup\ (the task must not depend on the package
     folder, which you may delete).
  2. Registers the scheduled task "GCPE nightly backup": every day at -At, as SYSTEM, running
     Backup-Gcpe.ps1 -BackupPath <BackupPath> -RetentionDays <BackupRetentionDays>.
  3. Runs it once now and waits for it (unless -SkipFirstRun). The task runs as SYSTEM, which
     reaches a UNC share as this computer's account (DOMAIN\<computer>$): that account needs
     write access to the share. A first run that fails says so here.
  Every folder the backup makes is locked to Administrators and SYSTEM before anything is
  written into it; on a share, the share's own permissions must be restricted as well
  (docs/deploy/windows.md, "Backups").

.EXAMPLE
  .\Register-GcpeBackup.ps1 -BackupPath \\backup01\gcpe-backups
#>
[CmdletBinding()]
param(
    # Where backups go: a UNC share on another server (recommended), or a local folder (Dev only).
    [Parameter(Mandatory)][string]$BackupPath,
    [ValidateRange(1, 3650)][int]$BackupRetentionDays = 14,
    # Back up the databases / the files even if this server doesn't look like it holds them.
    [switch]$Databases,
    [switch]$Files,
    # Time of day, 24-hour HH:mm, server local time.
    [ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')][string]$At = '01:30',
    [string]$Root = 'C:\gcpe',
    [switch]$SkipFirstRun,
    [ValidateRange(1, 720)][int]$WaitMinutes = 120
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\Gcpe.psm1') -Force

Assert-GcpeAdministrator
$paths = Get-GcpePaths -Root $Root
$pgMajor = (Import-PowerShellDataFile (Join-Path $PSScriptRoot 'lib\prereqs.psd1')).PostgreSQL.Major
$pgBin = Join-Path $env:ProgramFiles "PostgreSQL\$pgMajor\bin"
$taskName = 'GCPE nightly backup'

Write-GcpeStep 'What this server holds'
if (-not $Databases -and -not $Files) {
    $Databases = [bool]((Test-Path -LiteralPath $paths.PgSuperuser) -and (Get-Service -Name "postgresql-x64-$pgMajor" -ErrorAction SilentlyContinue))
    $Files = [bool](Test-Path -LiteralPath $paths.EnvFile)
    if (-not $Databases -and -not $Files) { throw "Neither the GCPE PostgreSQL ($($paths.PgSuperuser)) nor the app ($($paths.EnvFile)) is on this server under $Root." }
}
$what = @()
if ($Databases) { $what += 'databases' }
if ($Files) { $what += 'files and settings' }
Write-GcpeOk ($what -join ' and ')

Write-GcpeStep "Backup destination $BackupPath"
if (-not (Test-Path -LiteralPath $BackupPath)) {
    if ($BackupPath.StartsWith('\\')) { throw "Cannot reach $BackupPath from this session. Check the share name and that it exists." }
    New-Item -ItemType Directory -Force -Path $BackupPath | Out-Null
    # Backups hold every secret and the subscribers' addresses: Administrators and SYSTEM only.
    Set-GcpePrivateDirectoryAcl -Path $BackupPath
}
if (-not $BackupPath.StartsWith('\\')) { Write-GcpeNote 'a local folder: a backup on the same server is lost with the server. Use a share on another server for Test and Prod.' }
Write-GcpeOk 'reachable from this session (the task itself runs as SYSTEM: the first run below checks that)'

Write-GcpeStep "Installing the backup script in $Root\backup"
$installDir = Join-Path $Root 'backup'
New-Item -ItemType Directory -Force -Path (Join-Path $installDir 'lib') | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Backup-Gcpe.ps1') -Destination $installDir -Force
Copy-Item -Path (Join-Path $PSScriptRoot 'lib\*') -Destination (Join-Path $installDir 'lib') -Force
Write-GcpeOk 'copied'

Write-GcpeStep "Scheduled task '$taskName' (daily at $At, as SYSTEM)"
$arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$installDir\Backup-Gcpe.ps1`"",
    '-BackupPath', "`"$BackupPath`"", '-RetentionDays', "$BackupRetentionDays", '-Root', "`"$Root`"", '-PgBin', "`"$pgBin`"")
if ($Databases) { $arguments += '-Databases' }
if ($Files) { $arguments += '-Files' }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ($arguments -join ' ')
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 6)
Register-ScheduledTask -TaskName $taskName -Description "GCPE backup to $BackupPath, keeping $BackupRetentionDays days (docs/deploy/windows.md, Backups)." -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-GcpeOk "registered: $($what -join ' and ') to $BackupPath\$env:COMPUTERNAME\<time>, kept $BackupRetentionDays days"

if ($SkipFirstRun) { Write-GcpeNote 'first run skipped: check the task after its first night (docs/deploy/windows.md)'; return }

Write-GcpeStep "Running it once now (waiting up to $WaitMinutes minutes)"
$started = (Get-Date).AddSeconds(-2)
Start-ScheduledTask -TaskName $taskName
$deadline = (Get-Date).AddMinutes($WaitMinutes)
do {
    Start-Sleep -Seconds 5
    $task = Get-ScheduledTask -TaskName $taskName
    $info = $task | Get-ScheduledTaskInfo
} while (($task.State -eq 'Running' -or $info.LastRunTime -lt $started) -and (Get-Date) -lt $deadline)
if ($task.State -eq 'Running') { throw "The first backup is still running after $WaitMinutes minutes; check it later with Get-ScheduledTaskInfo -TaskName '$taskName'." }
if ($info.LastTaskResult -ne 0) {
    throw "The first backup failed (result $($info.LastTaskResult)). Its log is the newest $($paths.Logs)\backup-*.log. If it could not write to $BackupPath, give $env:USERDOMAIN\$env:COMPUTERNAME`$ write access to the share."
}
$latest = Get-ChildItem -LiteralPath (Join-Path $BackupPath $env:COMPUTERNAME) -Directory | Sort-Object Name -Descending | Select-Object -First 1
Write-GcpeOk "done: $($latest.FullName)"
