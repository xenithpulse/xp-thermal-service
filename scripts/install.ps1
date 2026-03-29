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
# NOTE: node-windows creates service names by converting DisplayName: "XP Thermal Print Service" -> "xpthermalprintservice.exe"
$ServiceName = "xpthermalprintservice.exe"
$ServiceDisplayName = "XP Thermal Print Service"
$ServiceDescription = "Production-grade thermal printing service for restaurant POS systems"
$InstallPath = "$env:ProgramData\XPThermalService"
$ServicePort = 9100
$MaxServiceStartAttempts = 30

# Legacy service names to clean up
$LegacyServiceNames = @("XPThermalService", "xpthermalservice.exe")

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
    
    # Clean up any legacy/duplicate services
    foreach ($legacySvc in $LegacyServiceNames) {
        $oldSvc = Get-Service -Name $legacySvc -ErrorAction SilentlyContinue
        if ($oldSvc) {
            Write-Status "Removing legacy service: $legacySvc"
            sc.exe stop $legacySvc 2>$null | Out-Null
            Start-Sleep -Seconds 2
            sc.exe delete $legacySvc 2>$null | Out-Null
            Start-Sleep -Seconds 1
        }
    }
    
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
        
        # CRITICAL: Check if Windows service actually exists
        # If daemon folder exists but service doesn't, clean up daemon folder first
        $existingService = Get-Service -Name "$ServiceDisplayName" -ErrorAction SilentlyContinue
        $daemonPath = "$InstallPath\daemon"
        
        if (-not $existingService -and (Test-Path $daemonPath)) {
            Write-Status "Cleaning up stale daemon folder (service not registered)..."
            # Kill any processes that might be using daemon files
            Get-Process | Where-Object { $_.Path -like "$daemonPath*" } | ForEach-Object {
                Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            }
            Start-Sleep -Seconds 1
            Remove-Item $daemonPath -Recurse -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        }
        
        # Run the node-windows installer with enhanced recovery settings
        Write-Status "Registering Windows service with auto-recovery..."
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
    ],
    // Enhanced recovery settings for production reliability
    maxRestarts: 10,
    wait: 5,
    grow: 0.5,
    // Ensure auto-start on boot
    startType: 'auto'
});

svc.on('install', () => {
    console.log('Service installed');
    svc.start();
});

svc.on('alreadyinstalled', () => {
    console.log('Service already installed - starting it');
    svc.start();
});

svc.on('error', (err) => {
    console.error('Service error:', err);
});

svc.install();
"@

        # Wait for node-windows to complete
        Start-Sleep -Seconds 3

        # Configure Windows Service Recovery options (restart on failure)
        Write-Status "Configuring service recovery options..."
        $scConfig = @(
            "failure", "$ServiceDisplayName",
            "reset=", "86400",
            "actions=", "restart/5000/restart/10000/restart/30000"
        )
        & sc.exe $scConfig 2>&1 | Out-Null

        # Ensure service is set to auto-start
        & sc.exe config "$ServiceDisplayName" start= auto 2>&1 | Out-Null
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
    
    # Verify service installation and wait for it to start
    Write-Status "Verifying service installation..."
    Start-Sleep -Seconds 3
    
    $verifyAttempts = 0
    $serviceReady = $false
    $serviceExists = $false
    
    while ($verifyAttempts -lt $MaxServiceStartAttempts -and -not $serviceReady) {
        $svc = Get-Service -Name "$ServiceDisplayName" -ErrorAction SilentlyContinue
        if ($svc) {
            $serviceExists = $true
            if ($svc.Status -eq 'Running') {
                $serviceReady = $true
            } elseif ($svc.Status -eq 'Stopped') {
                Write-Host "  Service stopped - attempting to start..." -ForegroundColor Yellow
                Start-Service -Name "$ServiceDisplayName" -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 3
            } else {
                Write-Host "  Service status: $($svc.Status) - waiting..." -ForegroundColor Yellow
                Start-Sleep -Seconds 2
            }
        } else {
            Write-Host "  Waiting for service registration..." -ForegroundColor Yellow
            Start-Sleep -Seconds 2
        }
        $verifyAttempts++
        
        # If service exists but won't start after 5 tries, break out
        if ($serviceExists -and $verifyAttempts -ge 5 -and -not $serviceReady) {
            Write-Host "  Service exists but not starting - will try manual start" -ForegroundColor Yellow
            break
        }
    }
    
    if (-not $serviceReady) {
        Write-Error "Service did not start within expected time. Please check logs."
        Write-Host "Attempting manual start..."
        Start-Service -Name "$ServiceDisplayName" -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 5
    }
    
    # Health check - probe the service endpoint
    Write-Status "Performing health check..."
    $healthCheckAttempts = 0
    $healthOk = $false
    $activePort = $ServicePort
    
    while ($healthCheckAttempts -lt 15 -and -not $healthOk) {
        for ($p = $ServicePort; $p -lt ($ServicePort + 10); $p++) {
            try {
                $response = Invoke-WebRequest -Uri "http://127.0.0.1:$p/health" -TimeoutSec 2 -UseBasicParsing -ErrorAction SilentlyContinue
                if ($response.StatusCode -eq 200) {
                    $healthOk = $true
                    $activePort = $p
                    break
                }
            } catch {
                # Port not responding, try next
            }
        }
        if (-not $healthOk) {
            Start-Sleep -Seconds 2
            $healthCheckAttempts++
        }
    }
    
    if ($healthOk) {
        Write-Success "XP Thermal Service installed and running successfully!"
        Write-Host ""
        Write-Host "Service Status:     RUNNING" -ForegroundColor Green
        Write-Host "Service will start automatically on system boot."
        Write-Host "Configuration file: $InstallPath\config.json"
        Write-Host "Dashboard:          http://127.0.0.1:$activePort/dashboard"
        Write-Host "API Endpoint:       http://127.0.0.1:$activePort/api"
        Write-Host "Log files:          $InstallPath\logs\"
        Write-Host ""
        
        # Store active port for reference
        Set-Content -Path "$InstallPath\active_port.txt" -Value $activePort
        
        Write-Host "To manage the service:"
        Write-Host "  Start:   .\install.ps1 -Start"
        Write-Host "  Stop:    .\install.ps1 -Stop"
        Write-Host "  Restart: .\install.ps1 -Restart"
        Write-Host ""
    } else {
        Write-Host ""
        Write-Host "Service installed but health check failed." -ForegroundColor Yellow
        Write-Host "The service may still be starting. Please verify manually:"
        Write-Host "  1. Check service status: Get-Service '$ServiceDisplayName'"
        Write-Host "  2. Open dashboard: http://127.0.0.1:$ServicePort/dashboard"
        Write-Host "  3. Check logs: $InstallPath\logs\"
        Write-Host ""
    }
}

function Uninstall-Service {
    Write-Status "Uninstalling XP Thermal Service..."
    
    # Stop the service first using sc.exe for more reliable control
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc) {
        Write-Status "Stopping service..."
        # Use sc.exe stop for reliability
        sc.exe stop $ServiceName 2>$null | Out-Null
        
        # Wait for service to actually stop (up to 30 seconds)
        $timeout = 30
        $waited = 0
        while ($waited -lt $timeout) {
            $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
            if (-not $svc -or $svc.Status -eq 'Stopped') {
                break
            }
            Start-Sleep -Seconds 1
            $waited++
            Write-Host "." -NoNewline
        }
        Write-Host ""
        
        # Kill any lingering node processes running the service
        $daemonExe = "$InstallPath\daemon\xpthermalprintservice.exe"
        if (Test-Path $daemonExe) {
            # Find and kill processes using this exe
            Get-Process | Where-Object { $_.Path -eq $daemonExe } | ForEach-Object {
                Write-Status "Terminating service process (PID: $($_.Id))..."
                Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            }
        }
        
        # Also kill any node.exe running from the install path
        Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { 
            $_.Path -like "$InstallPath*" 
        } | ForEach-Object {
            Write-Status "Terminating node process (PID: $($_.Id))..."
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
        
        # Give processes time to fully terminate and release file handles
        Start-Sleep -Seconds 3
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

svc.on('error', (err) => {
    // Ignore errors - we'll clean up manually if needed
});

svc.uninstall();
"@
        }
        catch {
            Write-Status "node-windows uninstall had issues, cleaning up manually..."
        }
        finally {
            Pop-Location
        }
        
        # Wait a moment for node-windows to finish
        Start-Sleep -Seconds 2
    }
    
    # CRITICAL: Force delete the Windows service using sc.exe (backup for node-windows)
    $svcCheck = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svcCheck) {
        Write-Status "Force removing Windows service registration..."
        sc.exe delete $ServiceName 2>$null | Out-Null
        Start-Sleep -Seconds 2
    }
    
    # Also clean up any legacy services
    foreach ($legacySvc in $LegacyServiceNames) {
        $oldSvc = Get-Service -Name $legacySvc -ErrorAction SilentlyContinue
        if ($oldSvc) {
            Write-Status "Removing legacy service: $legacySvc"
            sc.exe stop $legacySvc 2>$null | Out-Null
            sc.exe delete $legacySvc 2>$null | Out-Null
        }
    }
    
    # Manually remove daemon folder if it still exists (fallback for EPERM errors)
    $daemonPath = "$InstallPath\daemon"
    if (Test-Path $daemonPath) {
        Write-Status "Cleaning up daemon folder..."
        # Try to remove each file individually with retries
        Get-ChildItem $daemonPath -File -ErrorAction SilentlyContinue | ForEach-Object {
            $retries = 3
            while ($retries -gt 0) {
                try {
                    Remove-Item $_.FullName -Force -ErrorAction Stop
                    break
                }
                catch {
                    $retries--
                    if ($retries -gt 0) {
                        Start-Sleep -Milliseconds 500
                    }
                }
            }
        }
        Remove-Item $daemonPath -Recurse -Force -ErrorAction SilentlyContinue
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
