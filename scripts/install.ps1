# ============================================================
# XP Thermal Service - Production-Grade Installation Script
# Bulletproof installation with full error recovery
# ============================================================

param(
    [switch]$Uninstall,
    [switch]$Start,
    [switch]$Stop,
    [switch]$Restart,
    [switch]$Repair,
    [switch]$Silent,
    [string]$ConfigPath
)

# ============================================================
# CONFIGURATION
# ============================================================

$ErrorActionPreference = "Continue"  # Don't stop on errors - handle them gracefully

# Service identification - node-windows converts "XP Thermal Print Service" to "xpthermalprintservice.exe"
$ServiceName = "xpthermalprintservice.exe"
$ServiceDisplayName = "XP Thermal Print Service"
$ServiceDescription = "Production-grade thermal printing service for restaurant POS systems"
$InstallPath = "$env:ProgramData\XPThermalService"
$ServicePortStart = 9100
$ServicePortEnd = 9110
$MaxRetries = 3
$RetryDelayMs = 2000

# Legacy service names to clean up (from previous installations)
$LegacyServiceNames = @(
    "XPThermalService", 
    "xpthermalservice.exe",
    "XP Thermal Print Service"
)

# Scheduled task for watchdog
$WatchdogTaskName = "XPThermalServiceWatchdog"

# ============================================================
# LOGGING
# ============================================================

$LogFile = "$env:TEMP\XPThermalInstall_$(Get-Date -Format 'yyyyMMdd_HHmmss').log"

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logEntry = "[$timestamp] [$Level] $Message"
    Add-Content -Path $LogFile -Value $logEntry -ErrorAction SilentlyContinue
    
    if (-not $Silent) {
        switch ($Level) {
            "INFO"    { Write-Host "[*] $Message" -ForegroundColor Cyan }
            "SUCCESS" { Write-Host "[+] $Message" -ForegroundColor Green }
            "WARNING" { Write-Host "[!] $Message" -ForegroundColor Yellow }
            "ERROR"   { Write-Host "[-] $Message" -ForegroundColor Red }
            default   { Write-Host "    $Message" }
        }
    }
}

function Write-Status($msg) { Write-Log $msg "INFO" }
function Write-Success($msg) { Write-Log $msg "SUCCESS" }
function Write-Warn($msg) { Write-Log $msg "WARNING" }
function Write-Err($msg) { Write-Log $msg "ERROR" }

# ============================================================
# UTILITY FUNCTIONS
# ============================================================

function Test-Administrator {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-WithRetry {
    param(
        [ScriptBlock]$ScriptBlock,
        [int]$MaxAttempts = $MaxRetries,
        [int]$DelayMs = $RetryDelayMs,
        [string]$Operation = "Operation"
    )
    
    $attempt = 1
    while ($attempt -le $MaxAttempts) {
        try {
            return & $ScriptBlock
        }
        catch {
            if ($attempt -eq $MaxAttempts) {
                Write-Warn "$Operation failed after $MaxAttempts attempts: $_"
                throw
            }
            Write-Log "$Operation attempt $attempt failed, retrying in $($DelayMs)ms..." "WARNING"
            Start-Sleep -Milliseconds $DelayMs
            $attempt++
        }
    }
}

function Test-PortAvailable {
    param([int]$Port)
    try {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        $listener.Stop()
        return $true
    }
    catch {
        return $false
    }
}

function Find-AvailablePort {
    param([int]$StartPort = $ServicePortStart, [int]$EndPort = $ServicePortEnd)
    for ($port = $StartPort; $port -le $EndPort; $port++) {
        if (Test-PortAvailable -Port $port) {
            return $port
        }
    }
    return $StartPort
}

function Get-ServiceHealthPort {
    for ($port = $ServicePortStart; $port -le $ServicePortEnd; $port++) {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
            if ($response.StatusCode -eq 200) {
                return $port
            }
        }
        catch { }
    }
    return $null
}

function Stop-AllServiceProcesses {
    Write-Log "Stopping all service-related processes..."
    
    # Stop via sc.exe first
    sc.exe stop $ServiceName 2>$null | Out-Null
    
    # Also try legacy names
    foreach ($legacySvc in $LegacyServiceNames) {
        sc.exe stop $legacySvc 2>$null | Out-Null
    }
    
    Start-Sleep -Seconds 2
    
    # Kill daemon exe processes
    Get-Process | Where-Object { 
        $_.Path -like "*$InstallPath*" -or 
        $_.Path -like "*xpthermalprintservice*" -or
        $_.Path -like "*xpthermalservice*"
    } | ForEach-Object {
        Write-Log "Terminating process: $($_.Name) (PID: $($_.Id))"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    
    # Kill any node processes running from install path
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { 
        $_.Path -like "*$InstallPath*"
    } | ForEach-Object {
        Write-Log "Terminating node process (PID: $($_.Id))"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    
    Start-Sleep -Seconds 2
}

function Remove-AllServices {
    Write-Log "Removing all service registrations..."
    
    # Remove main service
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc) {
        sc.exe delete $ServiceName 2>$null | Out-Null
        Write-Log "Removed service: $ServiceName"
    }
    
    # Remove by display name
    $svcByDisplay = Get-Service -DisplayName $ServiceDisplayName -ErrorAction SilentlyContinue
    if ($svcByDisplay) {
        sc.exe delete $svcByDisplay.Name 2>$null | Out-Null
        Write-Log "Removed service: $($svcByDisplay.Name)"
    }
    
    # Remove legacy services
    foreach ($legacySvc in $LegacyServiceNames) {
        $old = Get-Service -Name $legacySvc -ErrorAction SilentlyContinue
        if ($old) {
            sc.exe delete $legacySvc 2>$null | Out-Null
            Write-Log "Removed legacy service: $legacySvc"
        }
    }
    
    Start-Sleep -Seconds 2
}

function Remove-DaemonFolder {
    $daemonPath = "$InstallPath\daemon"
    if (Test-Path $daemonPath) {
        Write-Log "Removing daemon folder..."
        
        # Kill any processes holding file locks
        Get-ChildItem $daemonPath -Filter "*.exe" -ErrorAction SilentlyContinue | ForEach-Object {
            Get-Process | Where-Object { $_.Path -eq $_.FullName } | ForEach-Object {
                Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            }
        }
        
        Start-Sleep -Seconds 1
        
        # Remove with retries
        $retries = 5
        while ($retries -gt 0 -and (Test-Path $daemonPath)) {
            try {
                Remove-Item $daemonPath -Recurse -Force -ErrorAction Stop
                Write-Log "Daemon folder removed successfully"
                break
            }
            catch {
                $retries--
                if ($retries -gt 0) {
                    Start-Sleep -Seconds 2
                }
            }
        }
        
        if (Test-Path $daemonPath) {
            Write-Warn "Could not fully remove daemon folder - will be cleaned on reboot"
        }
    }
}

# ============================================================
# PRE-FLIGHT CHECKS
# ============================================================

function Test-Prerequisites {
    Write-Status "Running pre-flight checks..."
    $issues = @()
    
    # 1. Administrator check
    if (-not (Test-Administrator)) {
        $issues += "Script must run as Administrator"
    }
    
    # 2. Node.js check
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        $issues += "Node.js is not installed. Download from https://nodejs.org (v18+)"
    }
    else {
        $version = & node --version 2>$null
        $major = [int]($version -replace 'v(\d+)\..*', '$1')
        if ($major -lt 18) {
            $issues += "Node.js 18+ required. Current: $version"
        }
        else {
            Write-Log "Node.js version: $version" "INFO"
        }
    }
    
    # 3. Disk space check (need at least 200MB)
    $drive = (Split-Path $InstallPath -Qualifier)
    $freeSpace = (Get-PSDrive $drive.TrimEnd(':')).Free
    $requiredSpace = 200MB
    if ($freeSpace -lt $requiredSpace) {
        $issues += "Insufficient disk space. Need 200MB, have $([math]::Round($freeSpace/1MB))MB"
    }
    
    # 4. Windows version check (Win7+)
    $osVersion = [Environment]::OSVersion.Version
    if ($osVersion.Major -lt 6 -or ($osVersion.Major -eq 6 -and $osVersion.Minor -lt 1)) {
        $issues += "Windows 7 or later required"
    }
    else {
        $winVer = if ($osVersion.Major -ge 10) { "Windows 10/11" } 
                  elseif ($osVersion.Major -eq 6 -and $osVersion.Minor -ge 2) { "Windows 8+" }
                  else { "Windows 7" }
        Write-Log "Operating System: $winVer" "INFO"
    }
    
    # 5. Check if running from valid source directory
    $sourceDir = Split-Path -Parent $PSScriptRoot
    if (-not (Test-Path "$sourceDir\dist\index.js") -and -not (Test-Path "$sourceDir\package.json")) {
        $issues += "Invalid source directory. Run from project root/scripts folder"
    }
    
    if ($issues.Count -gt 0) {
        Write-Err "Pre-flight checks failed:"
        foreach ($issue in $issues) {
            Write-Err "  - $issue"
        }
        return $false
    }
    
    Write-Success "All pre-flight checks passed"
    return $true
}

# ============================================================
# CONFIGURATION MANAGEMENT
# ============================================================

function Backup-Config {
    $configFile = "$InstallPath\config.json"
    if (Test-Path $configFile) {
        $backupDir = "$InstallPath\backups"
        if (-not (Test-Path $backupDir)) {
            New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
        }
        $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
        $backupFile = "$backupDir\config_$timestamp.json"
        Copy-Item $configFile $backupFile -Force
        Write-Log "Configuration backed up to $backupFile"
        
        # Keep only last 5 backups
        Get-ChildItem $backupDir -Filter "config_*.json" | 
            Sort-Object LastWriteTime -Descending | 
            Select-Object -Skip 5 | 
            Remove-Item -Force
    }
}

function Restore-ConfigFromBackup {
    $backupDir = "$InstallPath\backups"
    $configFile = "$InstallPath\config.json"
    
    if (-not (Test-Path $configFile) -and (Test-Path $backupDir)) {
        $latestBackup = Get-ChildItem $backupDir -Filter "config_*.json" | 
            Sort-Object LastWriteTime -Descending | 
            Select-Object -First 1
        
        if ($latestBackup) {
            Copy-Item $latestBackup.FullName $configFile -Force
            Write-Log "Configuration restored from backup: $($latestBackup.Name)"
            return $true
        }
    }
    return $false
}

function Update-ConfigPort {
    param([int]$Port)
    
    $configFile = "$InstallPath\config.json"
    if (Test-Path $configFile) {
        try {
            $config = Get-Content $configFile -Raw | ConvertFrom-Json
            if ($config.server.port -ne $Port) {
                $config.server.port = $Port
                $config | ConvertTo-Json -Depth 10 | Set-Content $configFile -Encoding UTF8
                Write-Log "Updated config.json with port $Port"
            }
        }
        catch {
            Write-Warn "Could not update config port: $_"
        }
    }
}

function Set-ConfigPrivateNetworkAccess {
    $configFile = "$InstallPath\config.json"
    if (Test-Path $configFile) {
        try {
            $content = Get-Content $configFile -Raw
            $config = $content | ConvertFrom-Json
            
            # Ensure allowedOrigins has wildcard for easy setup
            if ($config.security.allowedOrigins -notcontains "*") {
                $origins = [System.Collections.ArrayList]@($config.security.allowedOrigins)
                $origins.Add("*") | Out-Null
                $config.security.allowedOrigins = $origins.ToArray()
                $config | ConvertTo-Json -Depth 10 | Set-Content $configFile -Encoding UTF8
                Write-Log "Added wildcard to allowedOrigins for browser compatibility"
            }
        }
        catch {
            Write-Warn "Could not update config: $_"
        }
    }
}

# ============================================================
# FIREWALL MANAGEMENT
# ============================================================

function Add-FirewallRules {
    Write-Status "Configuring firewall rules..."
    
    $ruleName = "XP Thermal Service"
    
    # Try modern PowerShell cmdlet first
    try {
        $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
        if ($existing) {
            Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
        }
        
        New-NetFirewallRule -DisplayName $ruleName `
            -Direction Inbound `
            -Protocol TCP `
            -LocalPort $ServicePortStart, ($ServicePortStart+1), ($ServicePortStart+2), ($ServicePortStart+3), ($ServicePortStart+4), ($ServicePortStart+5), ($ServicePortStart+6), ($ServicePortStart+7), ($ServicePortStart+8), ($ServicePortStart+9), ($ServicePortStart+10) `
            -Action Allow `
            -Profile Private, Domain, Public `
            -Description "Allow XP Thermal Print Service" | Out-Null
        
        Write-Log "Firewall rules added (PowerShell)" "SUCCESS"
        return
    }
    catch {
        Write-Log "PowerShell firewall failed, trying netsh..."
    }
    
    # Fallback to netsh for older Windows
    netsh advfirewall firewall delete rule name="$ruleName" 2>$null | Out-Null
    netsh advfirewall firewall add rule name="$ruleName" dir=in action=allow protocol=tcp localport="$ServicePortStart-$ServicePortEnd" profile=any | Out-Null
    Write-Log "Firewall rules added (netsh)" "SUCCESS"
}

function Remove-FirewallRules {
    $ruleName = "XP Thermal Service"
    
    try {
        Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    }
    catch {
        netsh advfirewall firewall delete rule name="$ruleName" 2>$null | Out-Null
    }
    
    Write-Log "Firewall rules removed"
}

# ============================================================
# WATCHDOG (SCHEDULED TASK)
# ============================================================

function Install-Watchdog {
    Write-Status "Setting up service watchdog..."
    
    # Remove existing task
    schtasks /Delete /TN $WatchdogTaskName /F 2>$null | Out-Null
    
    # Create watchdog script
    $watchdogScript = @'
# XP Thermal Service Watchdog
$serviceName = "xpthermalprintservice.exe"
$displayName = "XP Thermal Print Service"
$installPath = "$env:ProgramData\XPThermalService"
$logFile = "$installPath\logs\watchdog.log"

function Write-WatchdogLog($msg) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$timestamp - $msg" | Out-File -Append $logFile -ErrorAction SilentlyContinue
}

# Check if service exists and is running
$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (-not $svc) {
    $svc = Get-Service -DisplayName $displayName -ErrorAction SilentlyContinue
}

if ($svc) {
    if ($svc.Status -ne 'Running') {
        Write-WatchdogLog "Service not running (Status: $($svc.Status)) - attempting restart"
        try {
            Start-Service -Name $svc.Name -ErrorAction Stop
            Start-Sleep -Seconds 5
            $svc = Get-Service -Name $svc.Name
            if ($svc.Status -eq 'Running') {
                Write-WatchdogLog "Service restarted successfully"
            } else {
                Write-WatchdogLog "Service still not running after restart attempt"
            }
        }
        catch {
            Write-WatchdogLog "Failed to restart service: $_"
            # Try sc.exe as fallback
            sc.exe start $svc.Name 2>&1 | Out-Null
        }
    }
}
else {
    Write-WatchdogLog "Service not found - may need reinstallation"
}

# Clean old log entries (keep last 500 lines)
if (Test-Path $logFile) {
    try {
        $lines = Get-Content $logFile -Tail 500 -ErrorAction SilentlyContinue
        if ($lines) {
            $lines | Set-Content $logFile -ErrorAction SilentlyContinue
        }
    } catch { }
}
'@
    
    $watchdogPath = "$InstallPath\watchdog.ps1"
    Set-Content -Path $watchdogPath -Value $watchdogScript -Force
    
    # Create scheduled task to run every 5 minutes
    try {
        $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogPath`""
        $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 9999)
        $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
        
        Register-ScheduledTask -TaskName $WatchdogTaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
        Write-Log "Watchdog scheduled task installed" "SUCCESS"
    }
    catch {
        # Fallback for older Windows
        schtasks /Create /TN $WatchdogTaskName /TR "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogPath`"" /SC MINUTE /MO 5 /RU SYSTEM /F 2>$null | Out-Null
        Write-Log "Watchdog scheduled task installed (schtasks)"
    }
}

function Remove-Watchdog {
    schtasks /Delete /TN $WatchdogTaskName /F 2>$null | Out-Null
    $watchdogPath = "$InstallPath\watchdog.ps1"
    Remove-Item $watchdogPath -Force -ErrorAction SilentlyContinue
    Write-Log "Watchdog removed"
}

# ============================================================
# SERVICE INSTALLATION
# ============================================================

function Install-Service {
    Write-Log "============================================================"
    Write-Log "Starting XP Thermal Service Installation"
    Write-Log "============================================================"
    
    # Pre-flight checks
    if (-not (Test-Prerequisites)) {
        return $false
    }
    
    # Full cleanup of any previous installation
    Write-Status "Cleaning up previous installations..."
    Stop-AllServiceProcesses
    Remove-AllServices
    Remove-DaemonFolder
    
    # Wait for cleanup to complete
    Start-Sleep -Seconds 2
    
    # Create/verify install directory
    Write-Status "Preparing installation directory..."
    if (-not (Test-Path $InstallPath)) {
        New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
        Write-Log "Created directory: $InstallPath"
    }
    
    # Backup existing config
    Backup-Config
    
    # Copy files
    $sourceDir = Split-Path -Parent $PSScriptRoot
    
    Write-Status "Copying service files..."
    Invoke-WithRetry -Operation "Copy dist files" -ScriptBlock {
        Copy-Item "$sourceDir\dist\*" "$InstallPath\" -Recurse -Force -ErrorAction Stop
    }
    
    Copy-Item "$sourceDir\package.json" "$InstallPath\" -Force -ErrorAction SilentlyContinue
    
    # Use robocopy for node_modules (handles long paths)
    if (Test-Path "$sourceDir\node_modules") {
        Write-Status "Copying node_modules (this may take a moment)..."
        robocopy "$sourceDir\node_modules" "$InstallPath\node_modules" /E /NFL /NDL /NJH /NJS /NC /NS /NP /MT:4 2>&1 | Out-Null
        # Robocopy returns 0-7 for success
        if ($LASTEXITCODE -gt 7) {
            Write-Warn "node_modules copy had issues, but continuing..."
        }
    }
    
    # Copy public assets
    if (Test-Path "$sourceDir\public") {
        Copy-Item "$sourceDir\public" "$InstallPath\" -Recurse -Force -ErrorAction SilentlyContinue
        Write-Log "Copied dashboard files"
    }
    
    # Setup configuration
    $configDest = "$InstallPath\config.json"
    if ($ConfigPath -and (Test-Path $ConfigPath)) {
        Copy-Item $ConfigPath $configDest -Force
        Write-Log "Using custom configuration file"
    }
    elseif (-not (Test-Path $configDest)) {
        # Try to restore from backup first
        if (-not (Restore-ConfigFromBackup)) {
            # Copy from source
            if (Test-Path "$sourceDir\config.json") {
                Copy-Item "$sourceDir\config.json" $configDest -Force
            }
            elseif (Test-Path "$sourceDir\config.example.json") {
                Copy-Item "$sourceDir\config.example.json" $configDest -Force
                Write-Log "Created configuration from example"
            }
        }
    }
    
    # Ensure config has wildcard origin for browser compatibility
    Set-ConfigPrivateNetworkAccess
    
    # Create data and logs directories
    @("$InstallPath\data", "$InstallPath\logs", "$InstallPath\backups") | ForEach-Object {
        if (-not (Test-Path $_)) {
            New-Item -ItemType Directory -Path $_ -Force | Out-Null
        }
    }
    
    # Find available port and update config
    $availablePort = Find-AvailablePort
    if ($availablePort -ne $ServicePortStart) {
        Write-Log "Port $ServicePortStart in use, using port $availablePort"
    }
    Update-ConfigPort -Port $availablePort
    
    # Install node-windows
    Write-Status "Installing service dependencies..."
    Push-Location $InstallPath
    try {
        if (-not (Test-Path "node_modules\node-windows")) {
            $npmResult = & npm install node-windows --save --silent 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Err "Failed to install node-windows: $npmResult"
                Pop-Location
                return $false
            }
        }
        
        # Register Windows service
        Write-Status "Registering Windows service..."
        $nodeScript = @"
const Service = require('node-windows').Service;
const path = require('path');

const svc = new Service({
    name: '$ServiceDisplayName',
    description: '$ServiceDescription',
    script: path.join('$($InstallPath -replace '\\', '/')' , 'index.js'),
    nodeOptions: ['--max-old-space-size=512'],
    workingDirectory: '$($InstallPath -replace '\\', '/')',
    env: [
        { name: 'XP_CONFIG_PATH', value: '$($InstallPath -replace '\\', '/')' + '/config.json' },
        { name: 'NODE_ENV', value: 'production' }
    ],
    maxRestarts: 10,
    wait: 5,
    grow: 0.5,
    abortOnError: false
});

let timeout = setTimeout(() => {
    console.log('Service registration timeout - check manually');
    process.exit(1);
}, 60000);

svc.on('install', () => {
    clearTimeout(timeout);
    console.log('SERVICE_INSTALLED');
    svc.start();
});

svc.on('start', () => {
    console.log('SERVICE_STARTED');
    process.exit(0);
});

svc.on('alreadyinstalled', () => {
    clearTimeout(timeout);
    console.log('SERVICE_ALREADY_INSTALLED');
    svc.start();
});

svc.on('error', (err) => {
    console.error('SERVICE_ERROR:', err.message || err);
});

svc.install();
"@
        
        $result = & node -e $nodeScript 2>&1
        $resultStr = $result -join "`n"
        
        if ($resultStr -match "SERVICE_INSTALLED|SERVICE_STARTED|SERVICE_ALREADY_INSTALLED") {
            Write-Log "Service registered successfully"
        }
        else {
            Write-Warn "Service registration result: $resultStr"
        }
        
        Start-Sleep -Seconds 3
        
        # Configure Windows recovery options
        Write-Status "Configuring service recovery (auto-restart on failure)..."
        & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 2>&1 | Out-Null
        & sc.exe failureflag $ServiceName 1 2>&1 | Out-Null
        
        # Set to delayed auto-start (more reliable on boot)
        & sc.exe config $ServiceName start= delayed-auto 2>&1 | Out-Null
        
        Write-Log "Service recovery options configured"
    }
    finally {
        Pop-Location
    }
    
    # Setup firewall
    Add-FirewallRules
    
    # Install watchdog
    Install-Watchdog
    
    # Verify service is running
    Write-Status "Verifying service installation..."
    Start-Sleep -Seconds 3
    
    $maxWaitSecs = 30
    $waited = 0
    $serviceRunning = $false
    
    while ($waited -lt $maxWaitSecs -and -not $serviceRunning) {
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $svc) {
            $svc = Get-Service -DisplayName $ServiceDisplayName -ErrorAction SilentlyContinue
        }
        
        if ($svc) {
            if ($svc.Status -eq 'Running') {
                $serviceRunning = $true
            }
            elseif ($svc.Status -eq 'Stopped') {
                Write-Log "Service stopped - starting..."
                Start-Service -Name $svc.Name -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 3
            }
            else {
                Write-Log "Service status: $($svc.Status)"
                Start-Sleep -Seconds 2
            }
        }
        else {
            Start-Sleep -Seconds 2
        }
        $waited += 2
    }
    
    # Health check
    Write-Status "Performing health check..."
    Start-Sleep -Seconds 2
    
    $healthPort = $null
    $healthAttempts = 0
    
    while ($healthAttempts -lt 10 -and -not $healthPort) {
        $healthPort = Get-ServiceHealthPort
        if (-not $healthPort) {
            Start-Sleep -Seconds 2
            $healthAttempts++
        }
    }
    
    if ($healthPort) {
        # Save active port
        Set-Content -Path "$InstallPath\active_port.txt" -Value $healthPort
        
        Write-Log "============================================================" "SUCCESS"
        Write-Success "XP Thermal Service installed successfully!"
        Write-Log "============================================================" "SUCCESS"
        Write-Host ""
        Write-Host "  Service Status:     " -NoNewline; Write-Host "RUNNING" -ForegroundColor Green
        Write-Host "  Dashboard:          " -NoNewline; Write-Host "http://127.0.0.1:$healthPort/dashboard" -ForegroundColor White
        Write-Host "  API Endpoint:       " -NoNewline; Write-Host "http://127.0.0.1:$healthPort/api" -ForegroundColor White
        Write-Host "  Configuration:      " -NoNewline; Write-Host "$InstallPath\config.json" -ForegroundColor White
        Write-Host "  Logs:               " -NoNewline; Write-Host "$InstallPath\logs\" -ForegroundColor White
        Write-Host ""
        Write-Host "  The service will:" -ForegroundColor Cyan
        Write-Host "    - Start automatically on system boot"
        Write-Host "    - Auto-restart if it crashes"
        Write-Host "    - Be monitored by watchdog every 5 minutes"
        Write-Host ""
        
        return $true
    }
    else {
        Write-Warn "Service installed but health check did not pass"
        Write-Host ""
        Write-Host "  The service was installed but may need a moment to start." -ForegroundColor Yellow
        Write-Host "  Please verify manually:"
        Write-Host "    1. Check service: Get-Service '$ServiceDisplayName'"
        Write-Host "    2. Check ports $ServicePortStart-$ServicePortEnd"
        Write-Host "    3. Check logs: $InstallPath\logs\"
        Write-Host ""
        Write-Host "  Installation log saved to: $LogFile"
        Write-Host ""
        
        return $false
    }
}

# ============================================================
# SERVICE UNINSTALLATION
# ============================================================

function Uninstall-Service {
    Write-Log "============================================================"
    Write-Log "Starting XP Thermal Service Uninstallation"
    Write-Log "============================================================"
    
    # Remove watchdog first
    Remove-Watchdog
    
    # Stop all processes
    Stop-AllServiceProcesses
    
    # Uninstall via node-windows (if available)
    if (Test-Path "$InstallPath\node_modules\node-windows") {
        Write-Status "Uninstalling service via node-windows..."
        Push-Location $InstallPath
        try {
            $uninstallScript = @"
const Service = require('node-windows').Service;
const svc = new Service({
    name: '$ServiceDisplayName',
    script: '$($InstallPath -replace '\\', '/')' + '/index.js'
});
svc.on('uninstall', () => console.log('UNINSTALLED'));
svc.on('error', () => {});
svc.uninstall();
setTimeout(() => process.exit(0), 5000);
"@
            & node -e $uninstallScript 2>&1 | Out-Null
        }
        catch { }
        finally {
            Pop-Location
        }
        Start-Sleep -Seconds 2
    }
    
    # Force remove all services
    Remove-AllServices
    
    # Remove daemon folder
    Remove-DaemonFolder
    
    # Remove firewall rules
    Remove-FirewallRules
    
    # Ask about removing files (unless silent)
    if (-not $Silent) {
        $removeFiles = Read-Host "Remove all service files and data? (y/N)"
        if ($removeFiles -eq 'y' -or $removeFiles -eq 'Y') {
            Remove-Item $InstallPath -Recurse -Force -ErrorAction SilentlyContinue
            Write-Log "Removed all service files"
        }
    }
    
    Write-Success "XP Thermal Service uninstalled successfully!"
    return $true
}

# ============================================================
# SERVICE CONTROL
# ============================================================

function Start-PrintService {
    Write-Status "Starting XP Thermal Service..."
    
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) {
        $svc = Get-Service -DisplayName $ServiceDisplayName -ErrorAction SilentlyContinue
    }
    
    if (-not $svc) {
        Write-Err "Service not found. Please run installation first."
        return $false
    }
    
    Start-Service -Name $svc.Name -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    
    $svc = Get-Service -Name $svc.Name
    if ($svc.Status -eq 'Running') {
        $port = Get-ServiceHealthPort
        Write-Success "Service started successfully"
        if ($port) {
            Write-Host "  Dashboard: http://127.0.0.1:$port/dashboard"
        }
        return $true
    }
    else {
        Write-Err "Failed to start service. Status: $($svc.Status)"
        return $false
    }
}

function Stop-PrintService {
    Write-Status "Stopping XP Thermal Service..."
    
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) {
        $svc = Get-Service -DisplayName $ServiceDisplayName -ErrorAction SilentlyContinue
    }
    
    if ($svc) {
        Stop-Service -Name $svc.Name -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Write-Success "Service stopped"
    }
    else {
        Write-Warn "Service not found"
    }
}

function Restart-PrintService {
    Stop-PrintService
    Start-Sleep -Seconds 2
    Start-PrintService
}

function Repair-Service {
    Write-Status "Repairing XP Thermal Service..."
    
    # Backup config first
    Backup-Config
    
    # Full uninstall (but keep files)
    $script:Silent = $true
    Stop-AllServiceProcesses
    Remove-AllServices
    Remove-DaemonFolder
    Remove-Watchdog
    $script:Silent = $false
    
    # Reinstall
    Install-Service
}

# ============================================================
# MAIN ENTRY POINT
# ============================================================

Write-Log "================================================"
Write-Log "XP Thermal Service Installer v2.0"
Write-Log "Log file: $LogFile"
Write-Log "================================================"

if (-not (Test-Administrator)) {
    Write-Err "This script must be run as Administrator"
    Write-Host "Right-click PowerShell and select 'Run as Administrator'"
    exit 1
}

$result = $false

if ($Uninstall) {
    $result = Uninstall-Service
}
elseif ($Start) {
    $result = Start-PrintService
}
elseif ($Stop) {
    Stop-PrintService
    $result = $true
}
elseif ($Restart) {
    $result = Restart-PrintService
}
elseif ($Repair) {
    $result = Repair-Service
}
else {
    $result = Install-Service
}

if (-not $result -and -not $Silent) {
    Write-Host ""
    Write-Host "Installation log saved to: $LogFile" -ForegroundColor Yellow
    Write-Host "Please include this log when reporting issues."
}

exit $(if ($result) { 0 } else { 1 })
