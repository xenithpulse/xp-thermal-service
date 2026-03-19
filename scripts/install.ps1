# XP Thermal Service - Installation Script
# Run as Administrator

param(
    [switch]$Uninstall,
    [switch]$Start,
    [switch]$Stop,
    [switch]$Restart,
    [string]$ConfigPath
)

$ErrorActionPreference = "Stop"
$ServiceName = "XPThermalService"
$ServiceDisplayName = "XP Thermal Print Service"
$ServiceDescription = "Production-grade thermal printing service for restaurant POS systems"
$InstallPath = "$env:ProgramData\XPThermalService"

function Write-Status($message) {
    Write-Host "[*] $message" -ForegroundColor Cyan
}

function Write-Success($message) {
    Write-Host "[+] $message" -ForegroundColor Green
}

function Write-Error($message) {
    Write-Host "[-] $message" -ForegroundColor Red
}

function Test-Administrator {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Install-NodeIfMissing {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Error "Node.js is not installed. Please install Node.js 18+ from https://nodejs.org"
        exit 1
    }
    
    $version = & node --version
    Write-Status "Node.js version: $version"
    
    # Check version >= 18
    $major = [int]($version -replace 'v(\d+)\..*', '$1')
    if ($major -lt 18) {
        Write-Error "Node.js 18+ is required. Current version: $version"
        exit 1
    }
}

function Install-Service {
    Write-Status "Installing XP Thermal Service..."
    
    # Check Node.js
    Install-NodeIfMissing
    
    # Create install directory
    if (-not (Test-Path $InstallPath)) {
        New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
        Write-Status "Created install directory: $InstallPath"
    }
    
    # Copy files
    $sourceDir = Split-Path -Parent $PSScriptRoot
    
    Write-Status "Copying service files..."
    Copy-Item "$sourceDir\dist\*" "$InstallPath\" -Recurse -Force
    Copy-Item "$sourceDir\package.json" "$InstallPath\" -Force
    # Use robocopy for node_modules to handle long paths on older Windows
    if (Test-Path "$sourceDir\node_modules") {
        Write-Status "Copying node_modules (this may take a moment)..."
        robocopy "$sourceDir\node_modules" "$InstallPath\node_modules" /E /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
    }
    
    # Copy public dashboard assets
    if (Test-Path "$sourceDir\public") {
        Copy-Item "$sourceDir\public" "$InstallPath\" -Recurse -Force
        Write-Status "Copied dashboard files"
    }
    
    # Copy config if specified
    if ($ConfigPath -and (Test-Path $ConfigPath)) {
        Copy-Item $ConfigPath "$InstallPath\config.json" -Force
        Write-Status "Copied configuration file"
    } elseif (Test-Path "$sourceDir\config.json") {
        Copy-Item "$sourceDir\config.json" "$InstallPath\config.json" -Force
    } elseif (Test-Path "$sourceDir\config.example.json") {
        Copy-Item "$sourceDir\config.example.json" "$InstallPath\config.json" -Force
        Write-Status "Created default configuration from example"
    }
    
    # Create data directory
    $dataDir = "$InstallPath\data"
    if (-not (Test-Path $dataDir)) {
        New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    }
    
    # Create logs directory
    $logsDir = "$InstallPath\logs"
    if (-not (Test-Path $logsDir)) {
        New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
    }
    
    # Install node-windows if not present
    Push-Location $InstallPath
    try {
        if (-not (Test-Path "node_modules\node-windows")) {
            Write-Status "Installing node-windows..."
            & npm install node-windows --save 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Error "Failed to install node-windows. Check network/permissions."
                Pop-Location
                exit 1
            }
        }
        
        # Run the node-windows installer
        Write-Status "Registering Windows service..."
        & node -e @"
const Service = require('node-windows').Service;
const path = require('path');

const svc = new Service({
    name: '$ServiceDisplayName',
    description: '$ServiceDescription',
    script: path.join('$($InstallPath -replace '\\', '\\\\')'.replace(/\\\\/g, '/'), 'index.js'),
    nodeOptions: ['--max-old-space-size=512'],
    workingDirectory: '$($InstallPath -replace '\\', '\\\\')'.replace(/\\\\/g, '/'),
    env: [
        { name: 'XP_CONFIG_PATH', value: '$($InstallPath -replace '\\', '\\\\')'.replace(/\\\\/g, '/') + '/config.json' },
        { name: 'NODE_ENV', value: 'production' }
    ]
});

svc.on('install', () => {
    console.log('Service installed');
    svc.start();
});

svc.on('alreadyinstalled', () => {
    console.log('Service already installed');
});

svc.on('error', (err) => {
    console.error('Service error:', err);
});

svc.install();
"@
    }
    finally {
        Pop-Location
    }
    
    # Add firewall rule (use netsh for Win7 compatibility)
    Write-Status "Adding firewall rule..."
    try {
        $firewallRule = Get-NetFirewallRule -DisplayName "XP Thermal Service" -ErrorAction SilentlyContinue
        if (-not $firewallRule) {
            New-NetFirewallRule -DisplayName "XP Thermal Service" `
                -Direction Inbound `
                -Protocol TCP `
                -LocalPort 9100 `
                -Action Allow `
                -Profile Private,Domain | Out-Null
        }
    } catch {
        # Fallback to netsh for Windows 7
        $existing = netsh advfirewall firewall show rule name="XP Thermal Service" 2>$null
        if (-not $existing -or $existing -match "No rules match") {
            netsh advfirewall firewall add rule name="XP Thermal Service" dir=in action=allow protocol=tcp localport=9100 profile=private,domain | Out-Null
        }
    }
    
    Write-Success "XP Thermal Service installed successfully!"
    Write-Host ""
    Write-Host "Service will start automatically on system boot."
    Write-Host "Configuration file: $InstallPath\config.json"
    Write-Host "Dashboard:          http://127.0.0.1:9100/dashboard"
    Write-Host "Log files:          $InstallPath\logs\"
    Write-Host ""
    Write-Host "To manage the service:"
    Write-Host "  Start:   .\install.ps1 -Start"
    Write-Host "  Stop:    .\install.ps1 -Stop"
    Write-Host "  Restart: .\install.ps1 -Restart"
    Write-Host ""
}

function Uninstall-Service {
    Write-Status "Uninstalling XP Thermal Service..."
    
    # Stop the service first
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') {
        Write-Status "Stopping service..."
        Stop-Service -Name $ServiceName -Force
        Start-Sleep -Seconds 2
    }
    
    # Uninstall via node-windows
    if (Test-Path "$InstallPath\node_modules\node-windows") {
        Push-Location $InstallPath
        try {
            & node -e @"
const Service = require('node-windows').Service;
const path = require('path');

const svc = new Service({
    name: '$ServiceDisplayName',
    script: path.join('$($InstallPath -replace '\\', '\\\\')'.replace(/\\\\/g, '/'), 'index.js')
});

svc.on('uninstall', () => {
    console.log('Service uninstalled');
});

svc.uninstall();
"@
        }
        finally {
            Pop-Location
        }
    }
    
    # Remove firewall rule (Win7-compatible)
    try {
        $firewallRule = Get-NetFirewallRule -DisplayName "XP Thermal Service" -ErrorAction SilentlyContinue
        if ($firewallRule) {
            Remove-NetFirewallRule -DisplayName "XP Thermal Service" | Out-Null
            Write-Status "Removed firewall rule"
        }
    } catch {
        netsh advfirewall firewall delete rule name="XP Thermal Service" 2>$null | Out-Null
        Write-Status "Removed firewall rule (netsh)"
    }
    
    # Optionally remove files
    $removeFiles = Read-Host "Remove all service files and data? (y/N)"
    if ($removeFiles -eq 'y' -or $removeFiles -eq 'Y') {
        Remove-Item $InstallPath -Recurse -Force -ErrorAction SilentlyContinue
        Write-Status "Removed service files"
    }
    
    Write-Success "XP Thermal Service uninstalled successfully!"
}

function Start-PrintService {
    Write-Status "Starting XP Thermal Service..."
    Start-Service -Name $ServiceName
    Start-Sleep -Seconds 2
    
    $svc = Get-Service -Name $ServiceName
    if ($svc.Status -eq 'Running') {
        Write-Success "Service started successfully"
    } else {
        Write-Error "Failed to start service. Status: $($svc.Status)"
    }
}

function Stop-PrintService {
    Write-Status "Stopping XP Thermal Service..."
    Stop-Service -Name $ServiceName -Force
    Write-Success "Service stopped"
}

function Restart-PrintService {
    Stop-PrintService
    Start-Sleep -Seconds 1
    Start-PrintService
}

# Main
if (-not (Test-Administrator)) {
    Write-Error "This script must be run as Administrator"
    Write-Host "Right-click PowerShell and select 'Run as Administrator'"
    exit 1
}

if ($Uninstall) {
    Uninstall-Service
} elseif ($Start) {
    Start-PrintService
} elseif ($Stop) {
    Stop-PrintService
} elseif ($Restart) {
    Restart-PrintService
} else {
    Install-Service
}
