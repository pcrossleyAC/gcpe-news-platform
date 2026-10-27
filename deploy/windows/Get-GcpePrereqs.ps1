<#
.SYNOPSIS
  Downloads every installer Install-Gcpe.ps1 needs into .\prereqs\, checking each SHA-256.

.DESCRIPTION
  Run this on any Windows machine with internet access when the server itself has none, then
  copy the whole package folder (prereqs\ included) to the server. Install-Gcpe.ps1 uses the
  files in prereqs\ and only downloads what's missing.
#>
[CmdletBinding()]
param()
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\Gcpe.psm1') -Force

foreach ($name in @('Node', 'UrlRewrite', 'Arr', 'WinSW', 'PostgreSQL')) {
    $p = Get-GcpePrereq -Name $name -PackageRoot $PSScriptRoot
    Write-GcpeOk "$name $($p.Version): $($p.Path)"
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'prereqs\pgvector\vector.dll'))) {
    Write-GcpeNote 'prereqs\pgvector is missing: it comes only in packages built by CI (it is compiled there, not downloaded)'
}
