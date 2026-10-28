# Pinned installers for Install-Gcpe.ps1. Get-GcpePrereqs.ps1 downloads each into ..\prereqs\ and
# checks its SHA-256; Install-Gcpe.ps1 refuses a file whose hash doesn't match. To upgrade one,
# change Url, File and Sha256 together (compute the hash with Get-FileHash on a trusted download).
@{
    Node = @{
        Version = '24.21.0'
        File    = 'node-v24.21.0-x64.msi'
        Url     = 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-x64.msi'
        Sha256  = 'bb0eaee134f9357f22aea915ee793343e627aefc1e66488164bac6915bce2cac'
    }
    UrlRewrite = @{
        Version = '2.1'
        File    = 'rewrite_amd64_en-US.msi'
        Url     = 'https://download.microsoft.com/download/1/2/8/128E2E22-C1B9-44A4-BE2A-5859ED1D4592/rewrite_amd64_en-US.msi'
        Sha256  = '37342ff2f585f263f34f48e9de59eb1051d61015a8e967dbde4075716230a32a'
    }
    Arr = @{
        Version = '3.0'
        File    = 'requestRouter_amd64.msi'
        Url     = 'https://download.microsoft.com/download/E/9/8/E9849D6A-020E-47E4-9FD0-A023E99B54EB/requestRouter_amd64.msi'
        Sha256  = 'fb61fdb7101795a34d5129cb37eee43ab675c7ed76ba3a3b23b039d8c90c2a4b'
    }
    WinSW = @{
        Version = '2.12.0'
        File    = 'WinSW-x64.exe'
        Url     = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
        Sha256  = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'
    }
    PostgreSQL = @{
        Version = '17.11'
        Major   = '17'
        File    = 'postgresql-17.11-1-windows-x64.exe'
        Url     = 'https://get.enterprisedb.com/postgresql/postgresql-17.11-1-windows-x64.exe'
        Sha256  = 'f104c552d8495a6f20738c2a03f643164bc64b9985363329e314dec24559f0b7'
    }
}
