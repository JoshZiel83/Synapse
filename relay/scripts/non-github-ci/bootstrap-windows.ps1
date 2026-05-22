$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step {
    param([string]$Message)
    Write-Host "[relay-non-github-ci] $Message"
}

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $knownPaths = @(
        (Join-Path $env:ProgramFiles 'Git\cmd'),
        (Join-Path $env:ProgramFiles 'Go\bin'),
        (Join-Path $env:ProgramFiles 'nodejs'),
        (Join-Path $env:ProgramFiles 'Python313'),
        (Join-Path $env:ProgramFiles 'Python313\Scripts'),
        (Join-Path $env:LocalAppData 'Programs\Python\Python313'),
        (Join-Path $env:LocalAppData 'Programs\Python\Python313\Scripts'),
        (Join-Path $env:ProgramFiles '7-Zip'),
        (Join-Path ${env:ProgramFiles(x86)} 'NSIS'),
        (Join-Path $env:ProgramFiles 'NSIS'),
        'C:\msys64\mingw64\bin',
        'C:\msys64\usr\bin'
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    $env:Path = (@($machine, $user) + $knownPaths) -join [System.IO.Path]::PathSeparator
}

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing command after bootstrap: $Name"
    }
}

if ($env:SYNAPSE_RELAY_ENABLE_WINDOWS_SSH -eq '1') {
    Write-Step 'enabling OpenSSH server'
    try {
        $openSshCapabilityVersion = @('0', '0', '1', '0') -join '.'
        Add-WindowsCapability -Online -Name "OpenSSH.Client~~~~$openSshCapabilityVersion" | Out-Null
        Add-WindowsCapability -Online -Name "OpenSSH.Server~~~~$openSshCapabilityVersion" | Out-Null
        Set-Service -Name sshd -StartupType Automatic
        Start-Service sshd
        New-NetFirewallRule -Name OpenSSH-Server-In-TCP -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -ErrorAction SilentlyContinue | Out-Null
    } catch {
        Write-Warning "OpenSSH setup failed: $($_.Exception.Message)"
    }
} else {
    Write-Step 'skipping OpenSSH server setup'
}

Write-Step 'installing build tools with winget'
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'winget is required for the automated Windows bootstrap. Install Git, Go, Node.js, Python, 7-Zip, and NSIS manually, then rerun this script.'
}

$packages = @(
    'Git.Git',
    'GoLang.Go',
    'OpenJS.NodeJS.LTS',
    'Python.Python.3.13',
    '7zip.7zip',
    'NSIS.NSIS',
    'MSYS2.MSYS2'
)

foreach ($package in $packages) {
    Write-Step "installing $package"
    winget install --id $package --exact --source winget --accept-package-agreements --accept-source-agreements --silent --disable-interactivity
}

Refresh-Path

Write-Step 'installing MinGW GCC with MSYS2'
$msysBash = 'C:\msys64\usr\bin\bash.exe'
if (-not (Test-Path -LiteralPath $msysBash)) {
    throw "MSYS2 bash was not found at $msysBash"
}
& $msysBash -lc 'pacman -Sy --needed --noconfirm mingw-w64-x86_64-gcc'
if ($LASTEXITCODE -ne 0) {
    throw "MSYS2 pacman failed with exit code $LASTEXITCODE"
}
Refresh-Path

Write-Step 'installing Wails v2.11.0'
Require-Command go
go install github.com/wailsapp/wails/v2/cmd/wails@v2.11.0
$goPath = (& go env GOPATH).Trim()
$env:Path = (Join-Path $goPath 'bin') + [System.IO.Path]::PathSeparator + $env:Path

Require-Command git
Require-Command go
Require-Command node
Require-Command npm
Require-Command python
Require-Command 7z
Require-Command gcc
Require-Command makensis
Require-Command wails

Write-Step 'Windows builder bootstrap complete'
Write-Step 'Run the staged artifacts/relay/<version>/vm/run-windows-gui-build.ps1 script from the shared repo checkout.'
