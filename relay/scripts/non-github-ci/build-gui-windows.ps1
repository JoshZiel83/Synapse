param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [string]$OutputDir,
    [string]$RuntimeBundle,
    [ValidateSet('all', 'portable', 'setup')]
    [string]$WindowsPackageVariants = 'all',
    [switch]$SkipPrepareBundle,
    [switch]$SkipSubmoduleUpdate
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ScriptDir = Split-Path -Parent $PSCommandPath
$RelayRoot = (Resolve-Path (Join-Path $ScriptDir '..\..')).Path
$RepoRoot = (Resolve-Path (Join-Path $RelayRoot '..')).Path
$Platform = 'windows-amd64'
$NodeVersion = if ($env:BUNDLED_NODE_VERSION) { $env:BUNDLED_NODE_VERSION } else { '24.14.1' }
$ChromeDevtoolsVersion = if ($env:CHROME_DEVTOOLS_MCP_VERSION) { $env:CHROME_DEVTOOLS_MCP_VERSION } else { '0.20.0' }
$PythonVersion = if ($env:BUNDLED_PYTHON_VERSION) { $env:BUNDLED_PYTHON_VERSION } else { '3.13.10' }
$PythonStandaloneRelease = if ($env:BUNDLED_PYTHON_STANDALONE_RELEASE) { $env:BUNDLED_PYTHON_STANDALONE_RELEASE } else { '20251202' }
$WindowsGitVersion = if ($env:BUNDLED_WINDOWS_GIT_VERSION) { $env:BUNDLED_WINDOWS_GIT_VERSION } else { '2.49.0.windows.1' }
$FfmpegReleaseTag = if ($env:BUNDLED_FFMPEG_RELEASE_TAG) { $env:BUNDLED_FFMPEG_RELEASE_TAG } else { 'n7.1-2' }
$CommandlinePackageProfile = if ($env:COMMANDLINE_PACKAGE_PROFILE) { $env:COMMANDLINE_PACKAGE_PROFILE } else { 'default-data-v5' }
if (-not $env:NPM_CONFIG_REGISTRY) {
    $env:NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/'
}
if (-not $env:NPM_CONFIG_REPLACE_REGISTRY_HOST) {
    $env:NPM_CONFIG_REPLACE_REGISTRY_HOST = 'always'
}

if (-not $OutputDir) {
    $OutputDir = Join-Path $RepoRoot "artifacts\relay\$Version"
}
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
$CliDir = Join-Path $OutputDir 'cli'
$GuiDir = Join-Path $OutputDir 'gui'
$RuntimeDir = Join-Path $OutputDir 'runtime'
$LogDir = Join-Path $OutputDir 'logs'
New-Item -ItemType Directory -Force -Path $CliDir, $GuiDir, $RuntimeDir, $LogDir | Out-Null

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing command: $Name"
    }
}

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$ScriptBlock
    )
    Write-Host "[relay-non-github-ci] $Name"
    & $ScriptBlock
}

function Use-GitHubEnvFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    Get-Content -LiteralPath $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#')) {
            $separator = $line.IndexOf('=')
            if ($separator -gt 0) {
                $name = $line.Substring(0, $separator)
                $value = $line.Substring($separator + 1)
                [Environment]::SetEnvironmentVariable($name, $value, 'Process')
            }
        }
    }
}

if (-not $env:RUNNER_TEMP) {
    $env:RUNNER_TEMP = Join-Path ([System.IO.Path]::GetTempPath()) 'synapse-relay-runner'
}
New-Item -ItemType Directory -Force -Path $env:RUNNER_TEMP | Out-Null

$SyntheticGithubPath = $false
$SyntheticGithubEnv = $false
if (-not $env:GITHUB_PATH) {
    $env:GITHUB_PATH = Join-Path $env:RUNNER_TEMP 'github-path.txt'
    $SyntheticGithubPath = $true
}
if (-not $env:GITHUB_ENV) {
    $env:GITHUB_ENV = Join-Path $env:RUNNER_TEMP 'github-env.txt'
    $SyntheticGithubEnv = $true
}
if ($SyntheticGithubPath) {
    Set-Content -LiteralPath $env:GITHUB_PATH -Value '' -NoNewline
}
if ($SyntheticGithubEnv) {
    Set-Content -LiteralPath $env:GITHUB_ENV -Value '' -NoNewline
}

Require-Command git
Require-Command go
Require-Command node
Require-Command npm
Require-Command tar

if (-not $SkipSubmoduleUpdate) {
    Invoke-Step 'initializing submodules' {
        git -C $RepoRoot submodule update --init --recursive
    }
}

Invoke-Step 'preparing Windows GUI prerequisites' {
    & (Join-Path $RepoRoot '.github\scripts\setup-windows-gui-build.ps1')
    if (Test-Path -LiteralPath $env:GITHUB_PATH) {
        Get-Content -LiteralPath $env:GITHUB_PATH | Where-Object { $_ } | ForEach-Object {
            $env:Path = $_ + [System.IO.Path]::PathSeparator + $env:Path
        }
    }
    Use-GitHubEnvFile -Path $env:GITHUB_ENV
}

if (-not (Get-Command wails -ErrorAction SilentlyContinue)) {
    Invoke-Step 'installing Wails v2.11.0' {
        go install github.com/wailsapp/wails/v2/cmd/wails@v2.11.0
        $goPath = (& go env GOPATH).Trim()
        $env:PATH = (Join-Path $goPath 'bin') + [System.IO.Path]::PathSeparator + $env:PATH
    }
}
Require-Command wails

$MingwBin = 'C:\msys64\mingw64\bin'
if (Test-Path -LiteralPath $MingwBin) {
    $env:Path = $MingwBin + [System.IO.Path]::PathSeparator + $env:Path
    $env:CC = Join-Path $MingwBin 'gcc.exe'
    $env:CXX = Join-Path $MingwBin 'g++.exe'
    $env:CGO_ENABLED = '1'
}

if (-not $RuntimeBundle) {
    $RuntimeBundle = Join-Path $RuntimeDir "relay-runtime-bundle-$Platform.tar.gz"
}

if (-not $SkipPrepareBundle -and -not (Test-Path -LiteralPath $RuntimeBundle)) {
    Invoke-Step "preparing runtime bundle for $Platform" {
        Push-Location $RelayRoot
        try {
            node scripts/prepare-node-bundle.mjs --target-platform=$Platform --node-version=$NodeVersion
            node scripts/prepare-chrome-devtools-bundle.mjs --target-platform=$Platform --node-version=$NodeVersion --package-version=$ChromeDevtoolsVersion
            node scripts/prepare-commandline-bundle.mjs --target-platform=$Platform --node-version=$NodeVersion --python-version=$PythonVersion --python-standalone-release=$PythonStandaloneRelease --windows-git-version=$WindowsGitVersion --ffmpeg-release-tag=$FfmpegReleaseTag --package-profile=$CommandlinePackageProfile
        } finally {
            Pop-Location
        }
        tar -czf $RuntimeBundle -C $RepoRoot relay/internal/nodebundle/assets relay/internal/chromemcpbundle/assets relay/internal/commandlinebundle/assets
    }
}

if (Test-Path -LiteralPath $RuntimeBundle) {
    Invoke-Step "extracting runtime bundle $RuntimeBundle" {
        tar -xzf $RuntimeBundle -C $RepoRoot
    }
}

Invoke-Step 'preparing Windows GUI build assets' {
    node (Join-Path $RelayRoot 'scripts\prepare-gui-build-assets.mjs') --goos=windows --runtime-mode=packaged
}

$FrontendDir = Join-Path $RelayRoot 'cmd\synapse-relay-gui\frontend'
$ViteCmd = Join-Path $FrontendDir 'node_modules\.bin\vite.cmd'
if (-not (Test-Path -LiteralPath $ViteCmd)) {
    Invoke-Step 'refreshing Windows frontend dependencies' {
        Push-Location $FrontendDir
        try {
            Remove-Item -LiteralPath (Join-Path $FrontendDir 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
            npm install
        } finally {
            Pop-Location
        }
    }
}

$WantPortable = $WindowsPackageVariants -eq 'all' -or $WindowsPackageVariants -eq 'portable'
$WantSetup = $WindowsPackageVariants -eq 'all' -or $WindowsPackageVariants -eq 'setup'
$ExtraArgs = @()
if ($WantSetup) {
    $ExtraArgs += '-nsis'
}

Invoke-Step 'building Windows GUI' {
    $WailsLog = Join-Path $LogDir 'windows-gui-wails.log'
    Push-Location (Join-Path $RelayRoot 'cmd\synapse-relay-gui')
    try {
        & wails build @ExtraArgs -tags 'desktop_cua,relay_packaged_runtime' -ldflags "-s -w -X main.Version=$Version" *> $WailsLog
        $wailsExitCode = $LASTEXITCODE
        Get-Content -LiteralPath $WailsLog | Out-Host
        if ($wailsExitCode -ne 0) {
            throw "wails build failed with exit code $wailsExitCode; see $WailsLog"
        }
    } finally {
        Pop-Location
    }
}

$BuildBin = Join-Path $RelayRoot 'cmd\synapse-relay-gui\build\bin'
$MainExe = Get-ChildItem -LiteralPath $BuildBin -File |
    Where-Object { $_.Name -match '^synapse-relay-gui(?:-windows-.+)?\.exe$' -and $_.Name -notmatch '-setup\.exe$' } |
    Select-Object -First 1
if (-not $MainExe) {
    throw "Windows GUI executable was not produced in $BuildBin"
}

if ($WantPortable) {
    Invoke-Step 'packaging Windows portable zip' {
        $PortableRoot = Join-Path $GuiDir "synapse-relay-gui-$Platform-portable"
        $PortableZip = Join-Path $GuiDir "synapse-relay-gui-$Platform-portable.zip"
        Remove-Item -LiteralPath $PortableRoot -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $PortableZip -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path $PortableRoot | Out-Null
        Copy-Item -LiteralPath $MainExe.FullName -Destination (Join-Path $PortableRoot 'synapse-relay-gui.exe') -Force

        $RuntimeStageFile = Join-Path $RelayRoot 'cmd\synapse-relay-gui\build\windows\runtime-path.txt'
        if (-not (Test-Path -LiteralPath $RuntimeStageFile)) {
            throw "runtime stage file missing: $RuntimeStageFile"
        }
        $RuntimeStage = (Get-Content -LiteralPath $RuntimeStageFile -Raw).Trim()
        $PortableRuntime = Join-Path $PortableRoot 'runtime'
        New-Item -ItemType Directory -Force -Path $PortableRuntime | Out-Null
        Copy-Item -Path (Join-Path $RuntimeStage '*') -Destination $PortableRuntime -Recurse -Force

        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::CreateFromDirectory(
            $PortableRoot,
            $PortableZip,
            [System.IO.Compression.CompressionLevel]::Optimal,
            $false
        )
    }
}

if ($WantSetup) {
    Invoke-Step 'collecting Windows setup exe' {
        $SetupExe = Get-ChildItem -LiteralPath $BuildBin -File |
            Where-Object {
                $_.Name -match 'synapse-relay-gui.*-(setup|installer)\.exe$' -or
                $_.Name -match '^Synapse Relay.*-installer\.exe$'
            } |
            Select-Object -First 1
        if (-not $SetupExe) {
            throw "Windows setup executable was not produced in $BuildBin"
        }
        Copy-Item -LiteralPath $SetupExe.FullName -Destination (Join-Path $GuiDir "synapse-relay-gui-$Platform-setup.exe") -Force
    }
}

Write-Host "[relay-non-github-ci] Windows GUI artifacts ready under $GuiDir"
