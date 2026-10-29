# GCPE News Platform — Windows Server package

The full runbook is `docs/deploy/windows.md` in the repository. The short version, in an elevated
PowerShell in this folder:

```powershell
# Dev: one server, self-signed certificate, all mail to one test inbox.
.\Install-Gcpe.ps1 -HostName news-dev.example.gov.bc.ca -SmtpHost apps.smtp.gov.bc.ca `
    -MailFrom noreply-dev@gov.bc.ca -MailRedirectTo you@gov.bc.ca

# Copy the legacy data in (the Calendar step is a dry run until -ConfirmCalendar).
.\Import-GcpeLegacy.ps1 -SqlServer <legacy SQL Server> -SqlUser <login> -CalendarCutoff 2025-11-01

# Let pushes to `develop` deploy here.
.\Install-GcpeRunner.ps1 -RepositoryUrl https://github.com/bcgov-c/<repo> -Token <token> -Labels gcpe-dev

# Nightly backup (databases where PostgreSQL runs here, files and settings where the app runs here).
.\Register-GcpeBackup.ps1 -BackupPath \\<backup server>\<share>

# Deploy a newer package by hand (rolls back by itself if it isn't healthy).
.\Deploy-GcpeRelease.ps1 -Package C:\drops\gcpe-windows-<commit>.zip

# Test/Prod: on the DMZ server, the public reverse proxy in front of the app server
# (the app server then needs Install-Gcpe.ps1 -ProxyHops 2 -AllowedClientRanges <DMZ server>/32, <staff ranges>).
.\Install-GcpeProxy.ps1 -HostName news-test.example.gov.bc.ca -Upstream https://<app server name> `
    -CertificateThumbprint <thumbprint> -UpstreamCertificateFile C:\install\app-server.cer
```

`Get-Help .\<script>.ps1 -Full` describes each script and every option. No internet on the
server? Run `.\Get-GcpePrereqs.ps1` on a machine that has it and copy this folder across.
