<#
.SYNOPSIS
  One backup run: the GCPE databases on this server, and/or the files and settings on this app
  server, into <BackupPath>\<computer name>\<yyyyMMdd-HHmmss>\. Then deletes this computer's
  backups older than -RetentionDays. Register-GcpeBackup.ps1 runs it every night; run it by hand
  for a backup now.

.DESCRIPTION
  -Databases (where PostgreSQL was installed by Install-Gcpe.ps1 or Install-GcpeDatabaseServer.ps1):
     db\<name>.dump for every database whose name starts with gcpe_, made with pg_dump -Fc as the
     postgres superuser (password from <Root>\config\postgres-superuser.txt), each checked with
     pg_restore --list.
  -Files (on the app server):
     files\storage         <Root>\data\storage: release attachments (/files). Not rebuildable.
     files\calendar-files  <Root>\data\calendar-files: Calendar attachments. Not rebuildable.
     config\               <Root>\config: gcpe.env holds every setting and secret, so the backup
                           share must be readable by the server administrators only.
     The files are copied after the databases, so every file a dumped row points at is there.
  Not backed up: <Root>\data\site-output (the public site, rebuilt from the databases), logs, and
  the releases (the deploy packages are kept elsewhere).

  Every folder it makes (this computer's folder, the run's folder, and -BackupPath itself when it
  is a local folder it creates) gets an explicit ACL before anything is written into it:
  inheritance off, FullControl for Administrators and SYSTEM only. On a UNC share it warns if it
  can't set that; the share's own permissions must be restricted by its owner either way.

  A run that finishes writes COMPLETE.txt and manifest.json in its folder. Old folders are deleted
  only after a run has finished, and only folders named yyyyMMdd-HHmmss under this computer's own
  folder. A failed run exits non-zero (Task Scheduler's "Last Run Result") and deletes nothing.
  Its log: <Root>\logs\backup-<time>.log.

.EXAMPLE
  .\Backup-Gcpe.ps1 -BackupPath \\backup01\gcpe-backups -Databases -Files
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BackupPath,
    [switch]$Databases,
    [switch]$Files,
    [ValidateRange(1, 3650)][int]$RetentionDays = 14,
    [string]$Root = 'C:\gcpe',
    # PostgreSQL's bin folder (pg_dump, pg_restore, psql). Default: PostgreSQL 17's.
    [string]$PgBin = (Join-Path $env:ProgramFiles 'PostgreSQL\17\bin')
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\Gcpe.psm1') -Force

Assert-GcpeAdministrator
if (-not $Databases -and -not $Files) { throw 'Pass -Databases, -Files or both.' }
$paths = Get-GcpePaths -Root $Root
New-Item -ItemType Directory -Force -Path $paths.Logs | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$machineDir = Join-Path $BackupPath $env:COMPUTERNAME
$runDir = Join-Path $machineDir $stamp

# Arguments for Start-Process: Windows PowerShell 5.1 joins them with spaces and quotes nothing.
function Quote([string]$Value) { '"' + $Value + '"' }

# A backup holds gcpe.env (every secret) and the subscribers' e-mail addresses: each folder this
# script makes is locked to Administrators and SYSTEM (the account the task runs as) before
# anything is written into it. On a share the folder ACL is only half of it: the share's own
# permissions must be as narrow (docs/deploy/windows.md, "Backups").
function New-PrivateDirectory([string]$Path) {
    $isNew = -not (Test-Path -LiteralPath $Path)
    if ($isNew) { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
    try {
        Set-GcpePrivateDirectoryAcl -Path $Path
    } catch {
        if ($Path.StartsWith('\\')) { Write-GcpeNote "could not lock down $Path ($($_.Exception.Message)): restrict the share and its folder permissions to the backup administrators and this server's account by hand" }
        else { throw }
    }
}

Start-Transcript -Path (Join-Path $paths.Logs "backup-$stamp.log") | Out-Null
try {
    Write-GcpeStep "Backing up to $runDir"
    if (-not $BackupPath.StartsWith('\\') -and -not (Test-Path -LiteralPath $BackupPath)) { New-PrivateDirectory $BackupPath }
    New-PrivateDirectory $machineDir
    New-PrivateDirectory $runDir
    $manifest = [ordered]@{ computer = $env:COMPUTERNAME; started = (Get-Date).ToString('o'); databases = @(); files = @() }
    $versionFile = Join-Path $paths.Current 'VERSION.json'
    if (Test-Path -LiteralPath $versionFile) { $manifest.release = (Get-Content -Raw -LiteralPath $versionFile | ConvertFrom-Json).commit }

    if ($Databases) {
        Write-GcpeStep 'Databases (pg_dump -Fc)'
        foreach ($exe in @('pg_dump.exe', 'pg_restore.exe', 'psql.exe')) {
            if (-not (Test-Path -LiteralPath (Join-Path $PgBin $exe))) { throw "$exe is not in $PgBin (-PgBin)." }
        }
        if (-not (Test-Path -LiteralPath $paths.PgSuperuser)) { throw "No $($paths.PgSuperuser): this server's PostgreSQL was not installed by Install-Gcpe.ps1 or Install-GcpeDatabaseServer.ps1." }
        $dbDir = Join-Path $runDir 'db'
        New-Item -ItemType Directory -Force -Path $dbDir | Out-Null
        $password = (Get-Content -Raw -LiteralPath $paths.PgSuperuser).Trim()
        Invoke-GcpeWithEnv -Variables @{ PGPASSWORD = $password; PGHOST = 'localhost'; PGUSER = 'postgres' } -Script {
            $list = Invoke-GcpeCapture -FilePath (Join-Path $PgBin 'psql.exe') -Arguments @('-d', 'postgres', '-At', '-c', (Quote "SELECT datname FROM pg_database WHERE left(datname, 5) = 'gcpe_' ORDER BY 1"))
            if ($list.ExitCode -ne 0) { throw "psql could not list the databases: $($list.Err)" }
            $names = @($list.Out -split "`r?`n" | Where-Object { $_ })
            if ($names.Count -eq 0) { throw 'No gcpe_* databases on this server.' }
            foreach ($name in $names) {
                $file = Join-Path $dbDir "$name.dump"
                $dump = Invoke-GcpeCapture -FilePath (Join-Path $PgBin 'pg_dump.exe') -Arguments @('-Fc', '-f', (Quote $file), (Quote $name))
                if ($dump.ExitCode -ne 0) { throw "pg_dump $name failed (exit $($dump.ExitCode)): $($dump.Err)" }
                $check = Invoke-GcpeCapture -FilePath (Join-Path $PgBin 'pg_restore.exe') -Arguments @('--list', (Quote $file))
                if ($check.ExitCode -ne 0) { throw "pg_restore --list could not read $file : $($check.Err)" }
                $bytes = (Get-Item -LiteralPath $file).Length
                $manifest.databases += [ordered]@{ name = $name; bytes = $bytes }
                Write-GcpeOk "$name ($([math]::Round($bytes / 1MB, 1)) MB)"
            }
        }
    }

    if ($Files) {
        Write-GcpeStep 'Files and settings'
        $copies = @(
            @{ From = Join-Path $paths.Data 'storage'; To = Join-Path $runDir 'files\storage' },
            @{ From = Join-Path $paths.Data 'calendar-files'; To = Join-Path $runDir 'files\calendar-files' },
            @{ From = $paths.Config; To = Join-Path $runDir 'config' }
        )
        if (-not (Test-Path -LiteralPath $paths.EnvFile)) { throw "No $($paths.EnvFile): -Files belongs on the app server." }
        foreach ($c in $copies) {
            if (-not (Test-Path -LiteralPath $c.From)) { Write-GcpeNote "$($c.From) does not exist yet; nothing to copy"; continue }
            # /E every subfolder; /COPY:DAT data, attributes, timestamps, not the source's ACLs: every
            # copy (gcpe.env included) inherits the run folder's Administrators-and-SYSTEM-only ACL.
            # A restore puts gcpe.env's own ACL back with Set-GcpeSecretFileAcl (the runbook says how).
            $r = Invoke-GcpeCapture -FilePath 'robocopy.exe' -Arguments @((Quote $c.From), (Quote $c.To), '/E', '/COPY:DAT', '/R:2', '/W:5', '/NP', '/NFL', '/NDL')
            if ($r.ExitCode -ge 8) { throw "robocopy $($c.From) failed (exit $($r.ExitCode)): $($r.Out)" }
            $count = @(Get-ChildItem -LiteralPath $c.To -Recurse -File -ErrorAction SilentlyContinue).Count
            $manifest.files += [ordered]@{ from = $c.From; files = $count }
            Write-GcpeOk "$($c.From): $count files"
        }
    }

    $manifest.finished = (Get-Date).ToString('o')
    [IO.File]::WriteAllText((Join-Path $runDir 'manifest.json'), ($manifest | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText((Join-Path $runDir 'COMPLETE.txt'), "$($manifest.finished)`r`n")
    Write-GcpeOk 'complete'

    Write-GcpeStep "Deleting this computer's backups older than $RetentionDays days"
    $cutoff = (Get-Date).AddDays(-$RetentionDays)
    $removed = 0
    foreach ($dir in @(Get-ChildItem -LiteralPath $machineDir -Directory)) {
        if ($dir.Name -notmatch '^\d{8}-\d{6}$' -or $dir.FullName -eq $runDir) { continue }
        $when = [datetime]::ParseExact($dir.Name, 'yyyyMMdd-HHmmss', [Globalization.CultureInfo]::InvariantCulture)
        if ($when -lt $cutoff) { Remove-Item -LiteralPath $dir.FullName -Recurse -Force; $removed++; Write-GcpeOk "removed $($dir.Name)" }
    }
    foreach ($log in @(Get-ChildItem -LiteralPath $paths.Logs -Filter 'backup-*.log' -File | Where-Object { $_.LastWriteTime -lt $cutoff })) { Remove-Item -LiteralPath $log.FullName -Force }
    Write-GcpeOk "$removed removed"
} finally {
    Stop-Transcript | Out-Null
}
