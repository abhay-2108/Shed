<#
.SYNOPSIS
    Starts Shed on Windows (Web server + Cloudflare tunnel)
#>
$ErrorActionPreference = "Stop"
$ShedDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ShedDir

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "         Shed (Windows Edition)          " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is not found. Please install Node.js 20+ from https://nodejs.org"
    exit 1
}

# Ensure Cloudflared and Ngrok are in PATH
$ProgFilesX86 = if (${env:ProgramFiles(x86)}) { ${env:ProgramFiles(x86)} } else { $env:ProgramFiles }
$CloudflaredX86 = Join-Path $ProgFilesX86 "cloudflared"
$Cloudflared64 = Join-Path $env:ProgramFiles "cloudflared"
if (Test-Path "$CloudflaredX86\cloudflared.exe") {
    $env:PATH = "$CloudflaredX86;$env:PATH"
} elseif (Test-Path "$Cloudflared64\cloudflared.exe") {
    $env:PATH = "$Cloudflared64;$env:PATH"
}

$NgrokCandidates = @(
    "$ShedDir\bin",
    "$ShedDir",
    (Join-Path $env:ProgramFiles "ngrok"),
    "$env:LOCALAPPDATA\ngrok",
    "$env:USERPROFILE\bin"
)
$FoundNgrok = $false
foreach ($dir in $NgrokCandidates) {
    if (Test-Path "$dir\ngrok.exe") {
        $env:PATH = "$dir;$env:PATH"
        $FoundNgrok = $true
        break
    }
}

$RelayFile = Join-Path $ShedDir ".jev-data\relay.json"
if (Test-Path $RelayFile) {
    $RelayContent = Get-Content $RelayFile -Raw
    if ($RelayContent -match '"provider"\s*:\s*"ngrok"' -or $RelayContent -match '"domain"') {
        if (-not $FoundNgrok) {
            Write-Host "Downloading official Windows ngrok binary to .\bin\ngrok.exe..." -ForegroundColor Cyan
            $BinDir = Join-Path $ShedDir "bin"
            if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir -Force | Out-Null }
            $ZipPath = Join-Path $env:TEMP "ngrok-windows.zip"
            try {
                Invoke-WebRequest -Uri "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip" -OutFile $ZipPath
                Expand-Archive -Path $ZipPath -DestinationPath $BinDir -Force
                Remove-Item -Path $ZipPath -Force -ErrorAction SilentlyContinue
                $env:PATH = "$BinDir;$env:PATH"
                Write-Host "ngrok binary ready!" -ForegroundColor Green
            } catch {
                Write-Host "Could not auto-download ngrok: $_" -ForegroundColor Yellow
            }
        }
    }
}

$env:SHED_LAN = "1"

# Prevent Windows from going to sleep while Shed is running (screen can still turn off)
try {
    $KeepAwakeCode = @"
    using System;
    using System.Runtime.InteropServices;
    public class KeepAwake {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint SetThreadExecutionState(uint esFlags);
    }
"@
    Add-Type -TypeDefinition $KeepAwakeCode -Language CSharp -ErrorAction SilentlyContinue
    # ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001)
    [KeepAwake]::SetThreadExecutionState(0x80000001) | Out-Null
    Write-Host "Keep-Awake Active: Windows will stay awake while Shed is running (screen can turn off)." -ForegroundColor DarkGray
} catch {}

# Open browser after a brief delay
Start-Job -ScriptBlock {
    Start-Sleep -Seconds 2
    Start-Process "http://localhost:4378"
} | Out-Null

Write-Host "Starting Shed server and Cloudflare tunnel..." -ForegroundColor Green
Write-Host "A browser window will open shortly at http://localhost:4378" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop Shed at any time." -ForegroundColor Gray
Write-Host ""

try {
    # Run Shed in foreground
    node server/index.js
} finally {
    # Restore normal Windows sleep behavior on exit
    try { [KeepAwake]::SetThreadExecutionState(0x80000000) | Out-Null } catch {}
}
