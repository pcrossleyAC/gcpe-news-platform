<#
.SYNOPSIS
  Downloads every installer Install-Gcpe.ps1 needs into .\prereqs\, checking each SHA-256.

.DESCRIPTION
  Run this on any Windows machine with internet access when the server itself has none, then
  copy the whole package folder (prereqs\ included) to the server. Install-Gcpe.ps1 uses the
  files in prereqs\ and only downloads what's missing.

.EXAMPLE
  # Only what the DMZ proxy needs (Install-GcpeProxy.ps1):
  .\Get-GcpePrereqs.ps1 -Names UrlRewrite, Arr
#>
[CmdletBinding()]
param(
    [ValidateSet('Node', 'UrlRewrite', 'Arr', 'WinSW', 'PostgreSQL')][string[]]$Names = @('Node', 'UrlRewrite', 'Arr', 'WinSW', 'PostgreSQL')
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\Gcpe.psm1') -Force

foreach ($name in $Names) {
    $p = Get-GcpePrereq -Name $name -PackageRoot $PSScriptRoot
    Write-GcpeOk "$name $($p.Version): $($p.Path)"
}
if ($Names -contains 'PostgreSQL' -and -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'prereqs\pgvector\vector.dll'))) {
    Write-GcpeNote 'prereqs\pgvector is missing: it comes only in packages built by CI (it is compiled there, not downloaded)'
}
