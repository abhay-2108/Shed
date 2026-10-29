<#
.SYNOPSIS
    Installs and configures Shed for Windows
#>
$ErrorActionPreference = "Stop"
$ShedDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ShedDir

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "   Installing Shed for Windows           " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# 1. Node.js Check
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-Error "Node.js is not installed. Please install Node.js 20+ from https://nodejs.org"
    exit 1
}

$NodeVersion = node -p "process.versions.node.split('.')[0]"
if ([int]$NodeVersion -lt 20) {
    Write-Error "Shed requires Node.js 20 or newer (found version $NodeVersion)."
    exit 1
}
Write-Host "[OK] Node.js version $(node -v) detected." -ForegroundColor Green

# 2. Check / Install cloudflared
$Cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $Cloudflared) {
    Write-Host "[...] Installing cloudflared via winget..." -ForegroundColor Yellow
    try {
        winget install --id Cloudflare.cloudflared --silent --accept-package-agreements --accept-source-agreements
        Write-Host "[OK] cloudflared installed successfully." -ForegroundColor Green
    } catch {
        Write-Host "[!] Note: Could not auto-install cloudflared. You can install it manually with: winget install Cloudflare.cloudflared" -ForegroundColor Yellow
    }
} else {
    Write-Host "[OK] cloudflared is already installed." -ForegroundColor Green
}

# 3. Detect installed coding agents
Write-Host "[...] Checking installed coding agents..." -ForegroundColor Cyan
$FoundAgents = @()
foreach ($agent in @("claude", "codex", "gemini", "opencode", "pi")) {
    if (Get-Command $agent -ErrorAction SilentlyContinue) {
        $FoundAgents += $agent
    }
}
if ($FoundAgents.Count -gt 0) {
    Write-Host "[OK] Found agents: $($FoundAgents -join ', ')" -ForegroundColor Green
} else {
    Write-Host "[!] No coding agents found in PATH. Make sure Claude Code or Gemini CLI is installed." -ForegroundColor Yellow
}

# 4. Install npm dependencies
Write-Host "[...] Installing Node dependencies (including node-pty and Laya runtime)..." -ForegroundColor Cyan
npm install --loglevel=error
Write-Host "[OK] Dependencies installed." -ForegroundColor Green

Write-Host ""
Write-Host "=========================================" -ForegroundColor Green
Write-Host "   Shed Windows Installation Complete!   " -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Write-Host ""
Write-Host "To start Shed:" -ForegroundColor White
Write-Host "  powershell -File .\start.ps1" -ForegroundColor Cyan
Write-Host "  or run: npm start" -ForegroundColor Cyan
Write-Host ""
