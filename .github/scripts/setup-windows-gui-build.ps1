$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-SevenZipExecutable {
    $commands = @('7z.exe', '7z', '7za.exe', '7za')
    foreach ($command in $commands) {
        $resolved = Get-Command $command -ErrorAction SilentlyContinue
        if ($resolved) {
            return $resolved
        }
    }

    $searchRoots = @()
    if ($env:ProgramFiles) {
        $searchRoots += (Join-Path $env:ProgramFiles '7-Zip')
    }
    if (${env:ProgramFiles(x86)}) {
        $searchRoots += (Join-Path ${env:ProgramFiles(x86)} '7-Zip')
    }
    if ($env:ChocolateyInstall) {
        $searchRoots += (Join-Path $env:ChocolateyInstall 'bin')
        $searchRoots += (Join-Path $env:ChocolateyInstall 'lib\7zip.commandline\tools')
    }

    foreach ($root in $searchRoots | Where-Object { $_ } | Select-Object -Unique) {
        foreach ($name in @('7z.exe', '7za.exe')) {
            $candidate = Join-Path $root $name
            if (Test-Path -LiteralPath $candidate) {
                return (Get-Item -LiteralPath $candidate)
            }
        }
    }

    return $null
}

function Ensure-SevenZip {
    $sevenZip = Get-SevenZipExecutable
    if ($sevenZip) {
        $directory = Split-Path -Parent $sevenZip.Path
        if ($directory) {
            $directory | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
        }
        & $sevenZip.Path | Select-Object -First 1 | Out-Null
        return
    }

    if (-not $env:ChocolateyInstall) {
        throw '7-Zip is required to extract PortableGit, and Chocolatey is unavailable to install it'
    }

    Write-Host 'Installing 7-Zip command line tools via Chocolatey...'
    choco install 7zip.commandline -y --no-progress

    $sevenZip = Get-SevenZipExecutable
    if (-not $sevenZip) {
        throw '7-Zip is required to extract PortableGit, but installation did not make 7z available'
    }

    $directory = Split-Path -Parent $sevenZip.Path
    if ($directory) {
        $directory | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
    }
    & $sevenZip.Path | Select-Object -First 1 | Out-Null
}

function Get-MakeNSIS {
    param(
        [string[]]$SearchRoots
    )

    foreach ($root in $SearchRoots | Where-Object { $_ } | Select-Object -Unique) {
        $candidate = Join-Path $root 'makensis.exe'
        if (Test-Path -LiteralPath $candidate) {
            return (Get-Item -LiteralPath $candidate)
        }
    }

    return $null
}

function Register-MakeNSIS {
    param(
        [System.IO.FileInfo]$Executable
    )

    $Executable.Directory.FullName | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
    "NSISDIR=$($Executable.Directory.FullName)" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
    & $Executable.FullName /VERSION
}

function Test-ZipArchive {
    param(
        [string]$Path
    )

    try {
        $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
        $archive.Dispose()
        return $true
    } catch {
        return $false
    }
}

$nsisSearchRoots = @()
if ($env:ProgramFiles) {
    $nsisSearchRoots += (Join-Path $env:ProgramFiles 'NSIS')
}
if (${env:ProgramFiles(x86)}) {
    $nsisSearchRoots += (Join-Path ${env:ProgramFiles(x86)} 'NSIS')
}
if ($env:ChocolateyInstall) {
    $nsisSearchRoots += (Join-Path $env:ChocolateyInstall 'bin')
}

$existingMakeNSIS = Get-MakeNSIS -SearchRoots $nsisSearchRoots
if ($existingMakeNSIS) {
    Ensure-SevenZip
    Register-MakeNSIS -Executable $existingMakeNSIS
    exit 0
}

$version = '3.11'
$repoArchivePath = Join-Path $PSScriptRoot ('..\vendor\nsis\nsis-{0}.zip' -f $version)
$downloadUrls = @(
    ('https://downloads.sourceforge.net/project/nsis/NSIS%203/{0}/nsis-{0}.zip' -f $version),
    ('https://sourceforge.net/projects/nsis/files/NSIS%203/{0}/nsis-{0}.zip/download' -f $version)
)
$downloadRoot = Join-Path $env:RUNNER_TEMP 'synapse-relay-nsis'
$archivePath = Join-Path $downloadRoot ('nsis-{0}.zip' -f $version)
$extractRoot = Join-Path $downloadRoot ('nsis-{0}' -f $version)

New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null

$downloaded = $false
if (Test-Path -LiteralPath $repoArchivePath) {
    if (-not (Test-ZipArchive -Path $repoArchivePath)) {
        throw "Vendored NSIS archive is not a valid zip: $repoArchivePath"
    }
    Write-Host "Using vendored NSIS archive from $repoArchivePath"
    Copy-Item -LiteralPath $repoArchivePath -Destination $archivePath -Force
    $downloaded = $true
} else {
    foreach ($url in $downloadUrls) {
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            try {
                Write-Host "Downloading NSIS from $url (attempt $attempt)..."
                Invoke-WebRequest -Uri $url -OutFile $archivePath -MaximumRedirection 5 -Headers @{ 'User-Agent' = 'Mozilla/5.0' }
                if ((Get-Item -LiteralPath $archivePath).Length -gt 0 -and (Test-ZipArchive -Path $archivePath)) {
                    $downloaded = $true
                    break
                }
                Write-Warning "Downloaded file from $url is not a valid NSIS zip archive"
                Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
            } catch {
                Write-Warning ("NSIS download failed from {0} on attempt {1}: {2}" -f $url, $attempt, $_.Exception.Message)
                if ($attempt -lt 3) {
                    Start-Sleep -Seconds (2 * $attempt)
                }
            }
        }

        if ($downloaded) {
            break
        }
    }
}

if (-not $downloaded) {
    throw 'Failed to download NSIS from all configured sources'
}

if (Test-Path -LiteralPath $extractRoot) {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
}

Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force

$downloadedMakeNSIS = Get-ChildItem -Path $extractRoot -Filter 'makensis.exe' -File -Recurse | Select-Object -First 1
if (-not $downloadedMakeNSIS) {
    throw 'makensis.exe not found after extracting downloaded NSIS archive'
}

Ensure-SevenZip
Register-MakeNSIS -Executable $downloadedMakeNSIS
