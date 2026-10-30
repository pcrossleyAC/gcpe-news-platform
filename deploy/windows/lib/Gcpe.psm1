# Shared helpers for the GCPE Windows Server scripts (docs/deploy/windows.md).
# Written for Windows PowerShell 5.1, which every supported Windows Server has: no PowerShell 7-only
# syntax (no ?:, ??, && or ||).
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$script:ServiceName = 'gcpe-stack'
$script:ServiceAccount = 'NT SERVICE\gcpe-stack'
$script:SiteName = 'GCPE'

function Get-GcpeServiceName { $script:ServiceName }
function Get-GcpeServiceAccount { $script:ServiceAccount }
function Get-GcpeSiteName { $script:SiteName }

function Write-GcpeStep {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-GcpeOk {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "    OK  $Message" -ForegroundColor Green
}

function Write-GcpeNote {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "    --  $Message" -ForegroundColor Yellow
}

function Assert-GcpeAdministrator {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this from an elevated PowerShell (Run as administrator).'
    }
}

function Get-GcpePaths {
    param([Parameter(Mandatory)][string]$Root)
    [pscustomobject]@{
        Root          = $Root
        Releases      = Join-Path $Root 'releases'
        Current       = Join-Path $Root 'current'
        Config        = Join-Path $Root 'config'
        EnvFile       = Join-Path $Root 'config\gcpe.env'
        PgSuperuser   = Join-Path $Root 'config\postgres-superuser.txt'
        Data          = Join-Path $Root 'data'
        Service       = Join-Path $Root 'service'
        ServiceLogs   = Join-Path $Root 'service\logs'
        Site          = Join-Path $Root 'site'
        ImportReports = Join-Path $Root 'import-reports'
        Logs          = Join-Path $Root 'logs'
    }
}

function New-GcpeSecret {
    param([int]$Bytes = 32)
    $buffer = New-Object byte[] $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    -join ($buffer | ForEach-Object { $_.ToString('x2') })
}

function ConvertFrom-GcpeSecureString {
    param([Parameter(Mandatory)][Security.SecureString]$Value)
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

# Reads the env file the way Node's --env-file does for the values windows-env.js writes:
# KEY=value, a value optionally wrapped in one pair of ' or " quotes, # lines are comments.
function Read-GcpeEnv {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { throw "No environment file at $Path. Run Install-Gcpe.ps1 first." }
    $values = [ordered]@{}
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        if ($line -match '^\s*(#|$)') { continue }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) { continue }
        $key = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1)
        if ($value.Length -ge 2 -and (($value[0] -eq "'" -and $value[-1] -eq "'") -or ($value[0] -eq '"' -and $value[-1] -eq '"'))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$key] = $value
    }
    $values
}

# Runs $Script with extra process environment variables, then restores what was there before, so
# secrets set for one tool never leak into the next one or outlive the script.
function Invoke-GcpeWithEnv {
    param([Parameter(Mandatory)][hashtable]$Variables, [Parameter(Mandatory)][scriptblock]$Script)
    $saved = @{}
    foreach ($name in $Variables.Keys) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, [string]$Variables[$name], 'Process')
    }
    try { & $Script } finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    }
}

function Get-GcpeNodePath {
    $path = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (-not (Test-Path -LiteralPath $path)) { throw "Node.js is not installed at $path. Run Install-Gcpe.ps1." }
    $path
}

# Runs node.exe with stdin text and returns its stdout; throws with its stderr on a non-zero exit.
function Invoke-GcpeNodeTool {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [string]$InputText = '',
        [hashtable]$Environment = @{}
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Get-GcpeNodePath
    $psi.Arguments = ($Arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    foreach ($name in $Environment.Keys) { $psi.EnvironmentVariables[$name] = [string]$Environment[$name] }
    $process = [System.Diagnostics.Process]::Start($psi)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    # Raw UTF-8 bytes on the base stream: .NET Framework's StandardInput writer would add a
    # byte-order mark (when the console's input encoding is UTF-8), even on Close with nothing written.
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($InputText)
    $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $process.StandardInput.BaseStream.Close()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "node $($Arguments[0]) failed (exit $($process.ExitCode)): $($stderr.Result.Trim())" }
    $stdout.Result
}

# Only Administrators and SYSTEM have full control; the service account (when given) may read.
function Set-GcpeSecretFileAcl {
    param([Parameter(Mandatory)][string]$Path, [string]$ReaderAccount)
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($who in @('BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM')) {
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($who, 'FullControl', 'Allow')))
    }
    if ($ReaderAccount) {
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($ReaderAccount, 'Read', 'Allow')))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

# The same lock-down as Set-GcpeSecretFileAcl, for a folder and everything that will be created in
# it: inheritance from the parent off, FullControl for Administrators and SYSTEM only, passed down
# to every file and subfolder (ContainerInherit, ObjectInherit). Call it on an empty folder,
# before anything is written into it.
# -FullControlAccounts adds others with FullControl (a backup share's writer, whose own
# Administrators and SYSTEM are not this server's); -ModifyAccounts adds accounts that may change
# the contents (the gcpe-stack service on C:\gcpe\data).
function Set-GcpePrivateDirectoryAcl {
    param([Parameter(Mandatory)][string]$Path, [string[]]$FullControlAccounts = @(), [string[]]$ModifyAccounts = @())
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($who in @('BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM') + @($FullControlAccounts | Where-Object { $_ })) {
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($who, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    foreach ($who in @($ModifyAccounts | Where-Object { $_ })) {
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($who, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

# This computer's domain account (DOMAIN\NAME$), as a file server sees this server (and SYSTEM on
# it) over SMB; $null when the server isn't in a domain.
function Get-GcpeComputerAccount {
    if (-not (Get-CimInstance Win32_ComputerSystem).PartOfDomain) { return $null }
    $name = "$env:USERDOMAIN\$($env:COMPUTERNAME)`$"
    try { (New-Object Security.Principal.NTAccount($name)).Translate([Security.Principal.SecurityIdentifier]) | Out-Null; $name }
    catch { $null }
}

# Enabled inbound Allow rules in force (ActiveStore: Group Policy's included) that open one of
# $Ports, TCP or UDP, other than those named in $ExceptDisplayName.
function Get-GcpeInboundAllowRules {
    param([Parameter(Mandatory)][string[]]$Ports, [string[]]$ExceptDisplayName = @())
    @(Get-NetFirewallPortFilter -PolicyStore ActiveStore -ErrorAction SilentlyContinue |
        Where-Object { ($_.Protocol -eq 'TCP' -or $_.Protocol -eq 'UDP') -and @(@($_.LocalPort) | Where-Object { $Ports -contains $_ }).Count -gt 0 } |
        Get-NetFirewallRule -ErrorAction SilentlyContinue |
        Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' -and $_.Enabled -eq 'True' -and $ExceptDisplayName -notcontains $_.DisplayName })
}

# Creates the file empty, locks it down, then writes it: written first, it would inherit
# BUILTIN\Users read access from C:\ for a moment.
function Write-GcpeSecretFile {
    param([Parameter(Mandatory)][string]$Path, [string]$Value = '', [string]$ReaderAccount)
    [IO.File]::WriteAllText($Path, '')
    Set-GcpeSecretFileAcl -Path $Path -ReaderAccount $ReaderAccount
    [IO.File]::WriteAllText($Path, $Value, (New-Object Text.UTF8Encoding($false)))
}

function Grant-GcpeDirectoryAccess {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Account, [ValidateSet('Modify', 'ReadAndExecute')][string]$Rights)
    $acl = Get-Acl -LiteralPath $Path
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($Account, $Rights, 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

# The pinned installers (lib\prereqs.psd1). Returns the local file, downloading it into
# <package>\prereqs\ when it isn't there yet, and refuses one whose SHA-256 doesn't match.
function Get-GcpePrereq {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$PackageRoot)
    $table = Import-PowerShellDataFile (Join-Path $PSScriptRoot 'prereqs.psd1')
    $item = $table[$Name]
    if (-not $item) { throw "Unknown prerequisite $Name" }
    $dir = Join-Path $PackageRoot 'prereqs'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $file = Join-Path $dir $item.File
    if (-not (Test-Path -LiteralPath $file)) {
        Write-Host "    downloading $($item.File) ..."
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -UseBasicParsing -Uri $item.Url -OutFile $file
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
    if ($actual -ne $item.Sha256) {
        Remove-Item -LiteralPath $file -Force
        throw "$($item.File) has SHA-256 $actual, expected $($item.Sha256). The file was deleted; download it again from $($item.Url)."
    }
    [pscustomobject]@{ Path = $file; Version = $item.Version; Item = $item }
}

function Invoke-GcpeInstaller {
    param([Parameter(Mandatory)][string]$FilePath, [Parameter(Mandatory)][string[]]$Arguments)
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -Wait -PassThru -NoNewWindow
    # 3010: success, reboot required later (msiexec).
    if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) { throw "$FilePath exited $($process.ExitCode)" }
}

function Invoke-GcpeMsi {
    param([Parameter(Mandatory)][string]$MsiPath, [string[]]$Properties = @())
    $log = Join-Path $env:TEMP ("gcpe-" + [IO.Path]::GetFileNameWithoutExtension($MsiPath) + '.log')
    Invoke-GcpeInstaller -FilePath 'msiexec.exe' -Arguments (@('/i', "`"$MsiPath`"", '/qn', '/norestart', '/l*v', "`"$log`"") + $Properties)
}

# Polls a /stack/health URL until it answers 200 with status "ok" (curl.exe ships with Windows
# Server 2019 and later; -k because a Dev site may use a self-signed certificate).
function Wait-GcpeHealth {
    param([Parameter(Mandatory)][string]$Url, [int]$TimeoutSec = 180)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $last = ''
    while ((Get-Date) -lt $deadline) {
        # -s and no 2>&1: Windows PowerShell 5.1 turns a native command's redirected stderr into a
        # terminating error under ErrorActionPreference=Stop, so "not up yet" would end the wait.
        $body = & curl.exe -k -s --max-time 10 $Url
        $last = ($body | Out-String).Trim()
        if ($LASTEXITCODE -eq 0) {
            try {
                $json = $last | ConvertFrom-Json
                if ($json.status -eq 'ok') { return $json }
            } catch { }
        }
        Start-Sleep -Seconds 3
    }
    throw "$Url did not report status ok within $TimeoutSec s. Last response: $last"
}

function Get-GcpeJunctionTarget {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.LinkType -ne 'Junction') { throw "$Path exists and is not a junction" }
    @($item.Target)[0]
}

# Points the junction at $Target. rmdir removes only the link: Remove-Item on a junction can
# delete the target's contents on Windows PowerShell 5.1.
function Set-GcpeJunction {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Target)
    if (Test-Path -LiteralPath $Path) {
        Get-GcpeJunctionTarget -Path $Path | Out-Null
        cmd.exe /c rmdir "$Path" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "could not remove the junction $Path" }
    }
    New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
}

# The thumbprint bound to https on 0.0.0.0:<Port> (443 unless given), or $null when there is no binding.
function Get-GcpeSslBinding {
    param([int]$Port = 443)
    $ErrorActionPreference = 'Continue'
    $out = (& netsh.exe http show sslcert "ipport=0.0.0.0:$Port" | Out-String)
    if ($out -match 'Certificate Hash\s*:\s*([0-9a-fA-F]{40})') { return $Matches[1].ToUpperInvariant() }
    $null
}

# Runs a native command whose output and exit code we don't act on ("delete if present"). Its
# output goes to temporary files: piped back into Windows PowerShell 5.1, stderr would stop the
# script under ErrorActionPreference=Stop.
function Invoke-GcpeQuiet {
    param([Parameter(Mandatory)][string]$FilePath, [Parameter(Mandatory)][string[]]$Arguments)
    $out = [IO.Path]::GetTempFileName()
    $err = [IO.Path]::GetTempFileName()
    try { Start-Process -FilePath $FilePath -ArgumentList $Arguments -Wait -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err | Out-Null }
    finally { Remove-Item -LiteralPath $out, $err -Force -ErrorAction SilentlyContinue }
}

# Runs a native command and returns its exit code, stdout and stderr without letting stderr stop
# the script (stderr is read here, never piped back into Windows PowerShell 5.1).
# System.Diagnostics.Process, not Start-Process -Wait -PassThru: Windows PowerShell 5.1's
# Start-Process closes its own handle to the process before -Wait first checks it, so a command
# that has already exited by then (pg_restore --list on a small dump, on a busy server) comes back
# with an ExitCode of $null, and every "-ne 0" check reads that as a failure with an empty stderr.
# Process.Start keeps its handle, so ExitCode is always the real one.
function Invoke-GcpeCapture {
    param([Parameter(Mandatory)][string]$FilePath, [Parameter(Mandatory)][string[]]$Arguments)
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    # Resolved through PATH as Start-Process does (CreateProcess would try the current folder first).
    $psi.FileName = @(Get-Command -Name $FilePath -CommandType Application -ErrorAction Stop)[0].Path
    # Joined with spaces and nothing quoted, as Start-Process did: callers quote their own values.
    $psi.Arguments = $Arguments -join ' '
    $psi.WorkingDirectory = (Get-Location -PSProvider FileSystem).ProviderPath
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $utf8
    $psi.StandardErrorEncoding = $utf8
    $p = [System.Diagnostics.Process]::Start($psi)
    try {
        # Both streams at once: reading one to its end first can block on the other's full pipe.
        $out = $p.StandardOutput.ReadToEndAsync()
        $err = $p.StandardError.ReadToEndAsync()
        $p.WaitForExit()
        [pscustomobject]@{ ExitCode = $p.ExitCode; Out = $out.Result.Trim(); Err = $err.Result.Trim() }
    } finally { $p.Dispose() }
}

# "10.20.0.0/16" -> @{ Address = '10.20.0.0'; Mask = '255.255.0.0' } for IIS ipSecurity. IPv4 only:
# throws on anything else, so a typo never becomes a wider (or empty) allow-list.
function ConvertFrom-GcpeCidr {
    param([Parameter(Mandatory)][string]$Cidr)
    if ($Cidr -notmatch '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/(\d{1,2})$') { throw "Not an IPv4 CIDR range: '$Cidr' (expected e.g. 142.34.0.0/16)" }
    $octets = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], [int]$Matches[4])
    $bits = [int]$Matches[5]
    if (@($octets | Where-Object { $_ -gt 255 }).Count -gt 0 -or $bits -gt 32) { throw "Not an IPv4 CIDR range: '$Cidr'" }
    # Plain [long] arithmetic, no bitwise operators: Windows PowerShell 5.1's -band/-bnot on
    # 32-bit unsigned values go through signed types.
    [long]$value = 0
    foreach ($o in $octets) { $value = $value * 256 + $o }
    [long]$block = [long][math]::Pow(2, 32 - $bits)
    [long]$mask = [long][math]::Pow(2, 32) - $block
    if (($value % $block) -ne 0) { throw "'$Cidr' has host bits set; did you mean $(ConvertTo-GcpeDottedIp ($value - ($value % $block)))/$($bits)?" }
    [pscustomobject]@{ Address = ConvertTo-GcpeDottedIp $value; Mask = ConvertTo-GcpeDottedIp $mask }
}

# Registers (or replaces) a daily scheduled task, run as SYSTEM, that runs $Command in Windows
# PowerShell. The command goes in as -EncodedCommand, so no quoting survives into Task Scheduler.
function Register-GcpeDailyTask {
    param([Parameter(Mandatory)][string]$TaskName, [Parameter(Mandatory)][string]$Command, [Parameter(Mandatory)][string]$At, [string]$Description = '')
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    $trigger = New-ScheduledTaskTrigger -Daily -At $At
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
    Register-ScheduledTask -TaskName $TaskName -Description $Description -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

# IIS logging for one site, on the app server and the DMZ proxy alike:
#  - no log entry at all for requests under $PrivatePaths (the subscribe pages and API, whose URLs
#    carry e-mail addresses and tokens): <location path="<site>/<path>"> httpLogging dontLog,
#    in applicationHost.config (the section can't be set in a site's web.config);
#  - no Referer field: a subscribe page's own requests for its CSS and scripts would carry the
#    page's token-bearing URL in it;
#  - logs in %SystemDrive%\inetpub\logs\LogFiles\W3SVC<site id>, and a daily task deleting the
#    site's log files (and http.sys's HTTPERR logs) older than $RetentionDays.
# Returns the site's log folder.
function Set-GcpeIisLogging {
    param([Parameter(Mandatory)][string]$SiteName, [Parameter(Mandatory)][string[]]$PrivatePaths, [Parameter(Mandatory)][ValidateRange(1, 3650)][int]$RetentionDays)
    $appcmd = Join-Path $env:windir 'System32\inetsrv\appcmd.exe'
    # IIS's default W3C fields without Referer.
    $fields = 'Date,Time,ClientIP,UserName,ServerIP,Method,UriStem,UriQuery,HttpStatus,Win32Status,TimeTaken,ServerPort,UserAgent,HttpSubStatus'
    & $appcmd set site $SiteName "/logFile.directory:%SystemDrive%\inetpub\logs\LogFiles" "/logFile.logExtFileFlags:$fields" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "could not set the log fields of the IIS site $SiteName" }
    foreach ($p in $PrivatePaths) {
        & $appcmd set config "$SiteName/$p" -section:system.webServer/httpLogging /dontLog:"True" /commit:apphost | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "could not turn off IIS logging for /$p on $SiteName" }
    }
    $id = (& $appcmd list site $SiteName /text:id | Out-String).Trim()
    if ($id -notmatch '^\d+$') { throw "could not read the id of the IIS site $SiteName" }
    $logDir = Join-Path $env:SystemDrive "inetpub\logs\LogFiles\W3SVC$id"
    $httpErr = Join-Path $env:windir 'System32\LogFiles\HTTPERR'
    $command = "`$cutoff = (Get-Date).AddDays(-$RetentionDays); Get-ChildItem -LiteralPath '$logDir', '$httpErr' -Filter *.log -File -ErrorAction SilentlyContinue | Where-Object { `$_.LastWriteTime -lt `$cutoff } | Remove-Item -Force"
    Register-GcpeDailyTask -TaskName "GCPE IIS log cleanup ($SiteName)" -At '03:15' -Command $command -Description "Deletes $SiteName's IIS logs ($logDir) and HTTPERR logs older than $RetentionDays days (docs/deploy/windows.md)."
    $logDir
}

# The web.config <customHeaders> line for Strict-Transport-Security (HSTS), or '' for a self-signed
# certificate: HSTS turns a browser's certificate warning into an error nobody can click past, so a
# Dev site on a self-signed certificate never sends it. This host only (no includeSubDomains: the
# parent domain is shared) and no preload. -MaxAgeDays 0 sends max-age=0, which tells browsers that
# saw it before to forget it: the way back if a site must ever answer over http again.
function Get-GcpeHstsHeaderLine {
    param([Parameter(Mandatory)][Security.Cryptography.X509Certificates.X509Certificate2]$Certificate, [Parameter(Mandatory)][int]$MaxAgeDays)
    if ($Certificate.Subject -eq $Certificate.Issuer) { return '' }
    "        <add name=`"Strict-Transport-Security`" value=`"max-age=$($MaxAgeDays * 86400)`" />"
}

# -HstsMaxAgeDays as the last run wrote it into web.config (a re-run keeps it), else $Default.
function Get-GcpeHstsMaxAgeDays {
    param([Parameter(Mandatory)][string]$WebConfigPath, [Parameter(Mandatory)][int]$Default)
    if ((Test-Path -LiteralPath $WebConfigPath) -and ((Get-Content -Raw -LiteralPath $WebConfigPath) -match 'name="Strict-Transport-Security" value="max-age=(\d+)"')) { return [int]([long]$Matches[1] / 86400) }
    $Default
}

function ConvertTo-GcpeDottedIp {
    param([Parameter(Mandatory)][long]$Value)
    (@(24, 16, 8, 0) | ForEach-Object { [long][math]::Floor($Value / [math]::Pow(2, $_)) % 256 }) -join '.'
}

Export-ModuleMember -Function *-Gcpe*
