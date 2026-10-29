<#
.SYNOPSIS
    Configures Shed to use your permanent free Ngrok static domain.
.EXAMPLE
    .\setup-ngrok.ps1 -Domain "your-name.ngrok-free.app" -Authtoken "your-authtoken"
#>
param(
    [string]$Domain,
    [string]$Authtoken
)

$ShedDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ShedDir

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "     Shed Permanent Ngrok Setup          " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# Prompt for values if not provided via parameters
if (-not $Domain) {
    $Domain = Read-Host "Enter your Ngrok static domain (e.g. my-shed.ngrok-free.app)"
}
if (-not $Authtoken) {
    $Authtoken = Read-Host "Enter your Ngrok authtoken"
}

$Domain = $Domain.Trim()
$Authtoken = $Authtoken.Trim()

if (-not $Domain) {
    Write-Error "A static domain is required (claim one free at https://dashboard.ngrok.com/cloud-edge/domains)"
    exit 1
}

# Clean domain prefix
$Domain = $Domain -replace '^https?://', ''

# Ensure .jev-data directory exists
$DataDir = Join-Path $ShedDir ".jev-data"
if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}

# Save relay configuration
$RelayConfig = @{
    provider  = "ngrok"
    domain    = $Domain
    authtoken = $Authtoken
} | ConvertTo-Json

$RelayFile = Join-Path $DataDir "relay.json"
Set-Content -Path $RelayFile -Value $RelayConfig -Encoding UTF8

Write-Host ""
Write-Host "Configuration saved to $RelayFile" -ForegroundColor Green
Write-Host "Your permanent URL: https://$Domain" -ForegroundColor Cyan
Write-Host ""

# Check for ngrok binary
$BinDir = Join-Path $ShedDir "bin"
$LocalNgrok = Join-Path $BinDir "ngrok.exe"
$HasNgrok = (Get-Command ngrok -ErrorAction SilentlyContinue) -or (Test-Path $LocalNgrok) -or (Test-Path (Join-Path $env:ProgramFiles "ngrok\ngrok.exe"))

if (-not $HasNgrok) {
    Write-Host "Notice: ngrok.exe was not found in your PATH." -ForegroundColor Yellow
    Write-Host "Downloading the official Windows ngrok binary to .\bin\ngrok.exe..." -ForegroundColor DarkGray
    try {
        if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir -Force | Out-Null }
        $ZipPath = Join-Path $env:TEMP "ngrok-windows.zip"
        Invoke-WebRequest -Uri "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip" -OutFile $ZipPath
        Expand-Archive -Path $ZipPath -DestinationPath $BinDir -Force
        Remove-Item -Path $ZipPath -Force -ErrorAction SilentlyContinue
        Write-Host "ngrok.exe downloaded successfully to .\bin\ngrok.exe!" -ForegroundColor Green
    } catch {
        Write-Host "Could not auto-download ngrok: $_" -ForegroundColor Yellow
        Write-Host "Please download ngrok for Windows from https://ngrok.com/download and place ngrok.exe in '$BinDir'." -ForegroundColor Gray
    }
} else {
    Write-Host "ngrok binary detected and ready!" -ForegroundColor Green
}

Write-Host ""
Write-Host "Setup complete! Whenever you start Shed (.\start.ps1), it will" -ForegroundColor Green
Write-Host "use https://$Domain every single time." -ForegroundColor Cyan
