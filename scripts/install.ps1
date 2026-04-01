# ============================================================
# XP Thermal Service - Production-Grade Installation Script
# Enterprise installer with robust error recovery
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

$ErrorActionPreference = "Continue"

$ServiceName = "xpthermalprintservice.exe"
$ServiceDisplayName = "XP Thermal Print Service"
$ServiceDescription = "Production-grade thermal printing service for restaurant POS systems"
$InstallPath = "$env:ProgramData\XPThermalService"
$ServicePortStart = 9100
$ServicePortEnd = 9110
$MaxRetries = 3
$RetryDelayMs = 2000

$LegacyServiceNames = @(
    "XPThermalService", 
    "xpthermalservice.exe",
    "XP Thermal Print Service"
)

$WatchdogTaskName = "XPThermalServiceWatchdog"

# ============================================================
# UI HELPERS
# ============================================================

$LogFile = "$env:TEMP\XPThermalInstall_$(Get-Date -Format 'yyyyMMdd_HHmmss').log"

$script:TotalSteps = 10
$script:CurrentStep = 0
$script:SpinChars = @('|','/','-','\')
$script:SpinIdx = 0

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logEntry = "[$timestamp] [$Level] $Message"
    Add-Content -Path $LogFile -Value $logEntry -ErrorAction SilentlyContinue
}

function Write-Status($msg) { Write-Log $msg "INFO" }
function Write-Success($msg) { Write-Log $msg "SUCCESS" }
function Write-Warn($msg) { Write-Log $msg "WARNING" }
function Write-Err($msg) { Write-Log $msg "ERROR" }

# -- Character definitions -----------------------------------------------

# Single-line box (steps, info)
$script:BoxH  = [string][char]0x2500
$script:BoxV  = [string][char]0x2502
$script:BoxTL = [string][char]0x250C
$script:BoxTR = [string][char]0x2510
$script:BoxBL = [string][char]0x2514
$script:BoxBR = [string][char]0x2518

# Double-line box (banner, overall, success/fail)
$script:DBoxH  = [string][char]0x2550
$script:DBoxV  = [string][char]0x2551
$script:DBoxTL = [string][char]0x2554
$script:DBoxTR = [string][char]0x2557
$script:DBoxBL = [string][char]0x255A
$script:DBoxBR = [string][char]0x255D

# Progress and indicators
$script:BFull  = [string][char]0x2588
$script:BLight = [string][char]0x2591
$script:Tick   = [string][char]0x2713
$script:Cross  = [string][char]0x2717
$script:MDot   = [string][char]0x00B7
$script:BW = 64

# -- Double-line box helpers (banner, success, fail) ---------------------

function Write-DBoxTop {
    param([string]$Color = "DarkCyan")
    Write-Host ("  " + $script:DBoxTL + ($script:DBoxH * $script:BW) + $script:DBoxTR) -ForegroundColor $Color
}
function Write-DBoxBottom {
    param([string]$Color = "DarkCyan")
    Write-Host ("  " + $script:DBoxBL + ($script:DBoxH * $script:BW) + $script:DBoxBR) -ForegroundColor $Color
}
function Write-DBoxEmpty {
    param([string]$Color = "DarkCyan")
    Write-Host ("  " + $script:DBoxV + (" " * $script:BW) + $script:DBoxV) -ForegroundColor $Color
}
function Write-DBoxLine {
    param([string]$Text, [string]$TextColor = "White", [string]$BorderColor = "DarkCyan")
    $inner = $Text.PadRight($script:BW)
    if ($inner.Length -gt $script:BW) { $inner = $inner.Substring(0, $script:BW) }
    Write-Host ("  " + $script:DBoxV) -NoNewline -ForegroundColor $BorderColor
    Write-Host $inner -NoNewline -ForegroundColor $TextColor
    Write-Host $script:DBoxV -ForegroundColor $BorderColor
}

# -- Single-line box helpers (info panels) --------------------------------

function Write-BoxTop {
    param([string]$Color = "DarkCyan")
    Write-Host ("  " + $script:BoxTL + ($script:BoxH * $script:BW) + $script:BoxTR) -ForegroundColor $Color
}
function Write-BoxBottom {
    param([string]$Color = "DarkCyan")
    Write-Host ("  " + $script:BoxBL + ($script:BoxH * $script:BW) + $script:BoxBR) -ForegroundColor $Color
}
function Write-BoxEmpty {
    param([string]$Color = "DarkCyan")
    Write-Host ("  " + $script:BoxV + (" " * $script:BW) + $script:BoxV) -ForegroundColor $Color
}
function Write-BoxLine {
    param([string]$Text, [string]$TextColor = "White", [string]$BorderColor = "DarkCyan")
    $inner = $Text.PadRight($script:BW)
    if ($inner.Length -gt $script:BW) { $inner = $inner.Substring(0, $script:BW) }
    Write-Host ("  " + $script:BoxV) -NoNewline -ForegroundColor $BorderColor
    Write-Host $inner -NoNewline -ForegroundColor $TextColor
    Write-Host $script:BoxV -ForegroundColor $BorderColor
}

# -- Banner ---------------------------------------------------------------

function Write-Banner {
    if ($Silent) { return }
    Write-Host ""
    Write-DBoxTop "DarkCyan"
    Write-DBoxEmpty "DarkCyan"
    Write-DBoxLine "    XP Thermal Print Service" "White" "DarkCyan"
    Write-DBoxLine "    Enterprise Installer v2.2" "DarkGray" "DarkCyan"
    Write-DBoxEmpty "DarkCyan"
    Write-DBoxLine "    Powered by XenithPulse.com" "DarkGray" "DarkCyan"
    Write-DBoxEmpty "DarkCyan"
    Write-DBoxBottom "DarkCyan"
    Write-Host ""
}

# -- Step header -----------------------------------------------------------

function Write-StepHeader {
    param([string]$Label, [int]$StepNum = -1)
    if ($Silent) { return }

    if ($StepNum -gt 0) { $script:CurrentStep = $StepNum }
    else { $script:CurrentStep++ }

    $pct = [math]::Min(100, [math]::Round(($script:CurrentStep / $script:TotalSteps) * 100))

    # Native PowerShell progress bar (persistent at console top)
    Write-Progress -Activity "XP Thermal Print Service - Installation" `
        -Status "Step $($script:CurrentStep) of $($script:TotalSteps): $Label" `
        -PercentComplete $pct

    # Console step header
    $stepLabel = "Step $($script:CurrentStep) of $($script:TotalSteps)"
    $lineLen = 64 - $stepLabel.Length - $Label.Length - 6
    if ($lineLen -lt 4) { $lineLen = 4 }
    $line = $script:BoxH * $lineLen

    Write-Host ""
    Write-Host "  $($script:BoxH)$($script:BoxH) " -NoNewline -ForegroundColor DarkGray
    Write-Host $stepLabel -NoNewline -ForegroundColor Cyan
    Write-Host " $line " -NoNewline -ForegroundColor DarkGray
    Write-Host $Label -ForegroundColor White
    Write-Host ""
}

# -- Step completion (per-step bar + overall progress) ---------------------

function Write-StepComplete {
    param([string]$Status = "Complete")
    if ($Silent) { return }

    # Per-step mini bar (always 100% since step is done)
    $barW = 36
    $stepBar = $script:BFull * $barW
    $stepNum = $script:CurrentStep.ToString().PadLeft(2, '0')

    Write-Host ""
    Write-Host "       Step $stepNum  " -NoNewline -ForegroundColor DarkGray
    Write-Host $stepBar -NoNewline -ForegroundColor DarkCyan
    Write-Host "  $Status" -ForegroundColor DarkGray

    # Overall progress line
    $overallPct = [math]::Min(100, [math]::Round(($script:CurrentStep / $script:TotalSteps) * 100))
    $overallBarW = 28
    $filled = [math]::Round($overallPct / 100 * $overallBarW)
    $empty  = $overallBarW - $filled
    $fBar = $script:BFull * $filled
    $eBar = $script:BLight * $empty
    $pctStr = "${overallPct}%".PadLeft(4)

    $padR = 14
    $padL = 14
    $lineL = $script:BoxH * $padL
    $lineR = $script:BoxH * $padR

    Write-Host ""
    Write-Host "  $lineL " -NoNewline -ForegroundColor DarkGray
    Write-Host "Overall " -NoNewline -ForegroundColor Gray
    Write-Host $fBar -NoNewline -ForegroundColor Green
    Write-Host $eBar -NoNewline -ForegroundColor DarkGray
    Write-Host $pctStr -NoNewline -ForegroundColor White
    Write-Host " $lineR" -ForegroundColor DarkGray
}

# -- Sub-item indicators ---------------------------------------------------

function Write-OK   { param([string]$msg); if (-not $Silent) { Write-Host "       $($script:Tick)" -NoNewline -ForegroundColor Green;   Write-Host "  $msg" -ForegroundColor Gray } }
function Write-WARN { param([string]$msg); if (-not $Silent) { Write-Host "       !" -NoNewline -ForegroundColor Yellow;               Write-Host "  $msg" -ForegroundColor Gray } }
function Write-FAIL { param([string]$msg); if (-not $Silent) { Write-Host "       $($script:Cross)" -NoNewline -ForegroundColor Red;   Write-Host "  $msg" -ForegroundColor Gray } }
function Write-Dot  { param([string]$msg); if (-not $Silent) { Write-Host "       $($script:MDot)" -NoNewline -ForegroundColor DarkGray; Write-Host "  $msg" -ForegroundColor DarkGray } }

# -- Animated spinner for wait loops ---------------------------------------

function Write-Spinner {
    param([string]$Message, [int]$Elapsed, [int]$Total)
    if ($Silent) { return }
    $ch = $script:SpinChars[$script:SpinIdx % 4]
    $script:SpinIdx++
    $line = "       $ch  $Message ($Elapsed`s)"
    Write-Host "`r$line                    " -NoNewline -ForegroundColor DarkGray
    if ($script:CurrentStep -gt 0) {
        $pct = [math]::Min(100, [math]::Round(($script:CurrentStep / $script:TotalSteps) * 100))
        Write-Progress -Activity "XP Thermal Print Service - Installation" `
            -Status "Step $($script:CurrentStep) of $($script:TotalSteps)" `
            -CurrentOperation "$Message ($Elapsed`s)" `
            -PercentComplete $pct
    }
}

function Clear-Spinner {
    if ($Silent) { return }
    Write-Host "`r$(' ' * 80)`r" -NoNewline
}

# -- Success output --------------------------------------------------------

function Write-SuccessBox {
    param(
        [string]$Port,
        [string]$ApiKey = ""
    )
    if ($Silent) { return }

    Write-Progress -Activity "XP Thermal Print Service - Installation" -Completed

    $dash = "http://127.0.0.1:$Port/dashboard"
    $api  = "http://127.0.0.1:$Port/api"

    Write-Host ""
    Write-Host ""
    Write-DBoxTop "Green"
    Write-DBoxEmpty "Green"
    Write-DBoxLine "     INSTALLATION SUCCESSFUL" "Green" "Green"
    Write-DBoxLine "     Service Status: Running" "White" "Green"
    Write-DBoxEmpty "Green"
    Write-DBoxBottom "Green"

    Write-Host ""
    Write-Host "  Service Endpoints" -ForegroundColor White
    Write-Host ("  " + ($script:BoxH * 64)) -ForegroundColor DarkGray
    Write-Host "  Dashboard         " -NoNewline -ForegroundColor Gray
    Write-Host $dash -ForegroundColor Cyan
    Write-Host "  API               " -NoNewline -ForegroundColor Gray
    Write-Host $api -ForegroundColor Cyan
    Write-Host "  Configuration     " -NoNewline -ForegroundColor Gray
    Write-Host "$InstallPath\config.json" -ForegroundColor DarkGray
    Write-Host "  Logs              " -NoNewline -ForegroundColor Gray
    Write-Host "$InstallPath\logs\" -ForegroundColor DarkGray

    if ($ApiKey) {
        Write-Host ""
        Write-Host "  Authentication" -ForegroundColor White
        Write-Host ("  " + ($script:BoxH * 64)) -ForegroundColor DarkGray
        Write-BoxTop "Yellow"
        Write-BoxLine "   API Key:  $ApiKey" "White" "Yellow"
        Write-BoxBottom "Yellow"
        Write-Host "  Set this value in your POS application's " -NoNewline -ForegroundColor Gray
        Write-Host "X-API-Key" -NoNewline -ForegroundColor Yellow
        Write-Host " header." -ForegroundColor Gray
    }

    Write-Host ""
    Write-Host "  Service Configuration" -ForegroundColor White
    Write-Host ("  " + ($script:BoxH * 64)) -ForegroundColor DarkGray
    Write-Host "  Auto-start         " -NoNewline -ForegroundColor Gray
    Write-Host "Starts with Windows (delayed)" -ForegroundColor DarkGray
    Write-Host "  Crash recovery     " -NoNewline -ForegroundColor Gray
    Write-Host "Restarts after 5s / 10s / 30s" -ForegroundColor DarkGray
    Write-Host "  Watchdog           " -NoNewline -ForegroundColor Gray
    Write-Host "Monitored every 5 minutes" -ForegroundColor DarkGray
    Write-Host "  Port fallback      " -NoNewline -ForegroundColor Gray
    Write-Host "Scans ${ServicePortStart}-${ServicePortEnd} automatically" -ForegroundColor DarkGray
    Write-Host ""
}

# -- Failure output --------------------------------------------------------

function Write-FailBox {
    param([string]$Reason = "")
    if ($Silent) { return }

    Write-Progress -Activity "XP Thermal Print Service - Installation" -Completed

    Write-Host ""
    Write-Host ""
    Write-DBoxTop "Red"
    Write-DBoxEmpty "Red"
    Write-DBoxLine "     INSTALLATION DID NOT COMPLETE" "Red" "Red"
    Write-DBoxEmpty "Red"
    Write-DBoxBottom "Red"

    if ($Reason) {
        Write-Host ""
        Write-Host "  Reason" -ForegroundColor White
        Write-Host ("  " + ($script:BoxH * 64)) -ForegroundColor DarkGray
        Write-Host "  $Reason" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "  Troubleshooting" -ForegroundColor White
    Write-Host ("  " + ($script:BoxH * 64)) -ForegroundColor DarkGray
    Write-Host "    1.  Ensure you are running as Administrator" -ForegroundColor Gray
    Write-Host "    2.  Run  scripts\uninstall.bat  to clean up first" -ForegroundColor Gray
    Write-Host "    3.  Check the installation log:" -ForegroundColor Gray
    Write-Host "        $LogFile" -ForegroundColor DarkGray
    Write-Host ""
}


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
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
            # Any HTTP response means the service is alive and listening
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 600) {
                return $port
            }
        }
        catch {
            # Invoke-WebRequest throws on non-2xx responses. Check if there was still an HTTP response.
            if ($_.Exception.Response) {
                # Got an HTTP response (e.g. 503) â€” service IS running, just degraded
                return $port
            }
            # No response at all (connection refused) â€” try next port
        }
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
    
    # Kill daemon exe processes by image name (works even for SYSTEM processes
    # where Get-Process.Path is empty)
    foreach ($exeName in @("xpthermalprintservice.exe", "xpthermalservice.exe")) {
        taskkill /F /IM $exeName 2>$null | Out-Null
    }
    
    # Kill daemon exe processes by path match (fallback)
    Get-Process | Where-Object { 
        $_.Path -like "*$InstallPath*" -or 
        $_.Path -like "*xpthermalprintservice*" -or
        $_.Path -like "*xpthermalservice*"
    } | ForEach-Object {
        Write-Log "Terminating process: $($_.Name) (PID: $($_.Id))"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    
    # Kill any node.exe processes whose parent is a daemon wrapper
    # (handles SYSTEM processes where Path is empty)
    $daemonPids = @()
    Get-CimInstance Win32_Process -Filter "Name='xpthermalprintservice.exe' OR Name='xpthermalservice.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
        $daemonPids += $_.ProcessId
    }
    if ($daemonPids.Count -gt 0) {
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
            $_.ParentProcessId -in $daemonPids
        } | ForEach-Object {
            Write-Log "Terminating daemon child node.exe (PID: $($_.ProcessId))"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    
    # Kill any node processes running from install path
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { 
        $_.Path -like "*$InstallPath*"
    } | ForEach-Object {
        Write-Log "Terminating node process (PID: $($_.Id))"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }

    # Kill any process listening on the thermal service port range (9100-9110)
    # This catches orphaned SYSTEM node.exe processes from previous installs
    $PortRangeStart = 9100
    $PortRangeEnd = 9110
    try {
        $tcpConns = Get-NetTCPConnection -LocalPort ($PortRangeStart..$PortRangeEnd) -State Listen -ErrorAction SilentlyContinue
        foreach ($conn in $tcpConns) {
            $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
            if ($proc -and $proc.Name -eq "node") {
                Write-Log "Killing orphaned node.exe on port $($conn.LocalPort) (PID: $($conn.OwningProcess))"
                taskkill /F /PID $conn.OwningProcess 2>$null | Out-Null
            }
        }
    } catch {
        # Fallback: parse netstat for port-based cleanup
        netstat -ano | Select-String ":910[0-9]\s.*LISTENING" | ForEach-Object {
            if ($_ -match '\s+(\d+)\s*$') {
                $procId = $matches[1]
                $pname = (Get-Process -Id $procId -ErrorAction SilentlyContinue).Name
                if ($pname -eq "node") {
                    Write-Log "Killing orphaned node.exe (PID: $procId) via netstat fallback"
                    taskkill /F /PID $procId 2>$null | Out-Null
                }
            }
        }
    }
    
    Start-Sleep -Seconds 3
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
        
        # Force-kill daemon exe processes by image name (handles SYSTEM processes)
        foreach ($exeName in @("xpthermalprintservice.exe", "xpthermalservice.exe")) {
            taskkill /F /IM $exeName 2>$null | Out-Null
        }
        
        # Also kill by path match
        Get-ChildItem $daemonPath -Filter "*.exe" -ErrorAction SilentlyContinue | ForEach-Object {
            $exePath = $_.FullName
            Get-Process | Where-Object { $_.Path -eq $exePath } | ForEach-Object {
                Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            }
        }
        
        Start-Sleep -Seconds 2
        
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
            Write-OK "Node.js $version"
        }
    }
    
    # 3. Disk space check (need at least 200MB)
    $drive = (Split-Path $InstallPath -Qualifier)
    $freeSpace = (Get-PSDrive $drive.TrimEnd(':')).Free
    $requiredSpace = 200MB
    if ($freeSpace -lt $requiredSpace) {
        $issues += "Insufficient disk space. Need 200MB, have $([math]::Round($freeSpace/1MB))MB"
    }
    else {
        Write-OK "Disk space ($([math]::Round($freeSpace/1GB, 1)) GB free)"
    }
    
    # 4. Windows version check
    $osVersion = [Environment]::OSVersion.Version
    if ($osVersion.Major -lt 6 -or ($osVersion.Major -eq 6 -and $osVersion.Minor -lt 1)) {
        $issues += "Windows 7 or later required"
    }
    else {
        $winVer = if ($osVersion.Major -ge 10) { "Windows 10/11" } 
                  elseif ($osVersion.Major -eq 6 -and $osVersion.Minor -ge 2) { "Windows 8+" }
                  else { "Windows 7" }
        Write-OK "$winVer"
    }
    
    # 5. Check source directory
    $sourceDir = Split-Path -Parent $PSScriptRoot
    if (-not (Test-Path "$sourceDir\dist\index.js") -and -not (Test-Path "$sourceDir\package.json")) {
        $issues += "Invalid source directory. Run from project root/scripts folder"
    }
    else {
        Write-OK "Source files found"
    }
    
    if ($issues.Count -gt 0) {
        Write-Host ""
        foreach ($issue in $issues) {
            Write-FAIL $issue
        }
        return $false
    }
    
    Write-Host ""
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
        Write-Dot "Config backed up"
        Write-Log "Configuration backed up to $backupFile"
        
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
            Write-Dot "Config restored from backup"
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
            
            # Remove wildcard from allowedOrigins if present (security hardening)
            if ($config.security.allowedOrigins -contains "*") {
                $origins = [System.Collections.ArrayList]@($config.security.allowedOrigins)
                $origins.Remove("*") | Out-Null
                $config.security.allowedOrigins = $origins.ToArray()
                Write-Dot "Removed wildcard origin (security)"
                Write-Log "Removed wildcard from allowedOrigins for security"
            }

            # Generate API key if enableApiKey is true but no key is set
            if ($config.security.enableApiKey -and (-not $config.security.apiKey)) {
                $bytes = New-Object byte[] 32
                ([System.Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($bytes)
                $apiKey = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ''
                $config.security | Add-Member -NotePropertyName 'apiKey' -NotePropertyValue $apiKey -Force
                Write-Dot "API key generated"
                Write-Log "Generated API key for service authentication"
            }

            $config | ConvertTo-Json -Depth 10 | Set-Content $configFile -Encoding UTF8
        }
        catch {
            Write-WARN "Could not update config: $_"
            Write-Warn "Could not update config: $_"
        }
    }
}

# ============================================================
# FIREWALL MANAGEMENT
# ============================================================

function Add-FirewallRules {
    $ruleName = "XP Thermal Service"
    
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
            -Profile Private, Domain `
            -Description "Allow XP Thermal Print Service" | Out-Null
        
        Write-OK "Firewall rules configured"
        Write-Log "Firewall rules added (PowerShell)" "SUCCESS"
        return
    }
    catch {
        Write-Log "PowerShell firewall failed, trying netsh..."
    }
    
    netsh advfirewall firewall delete rule name="$ruleName" 2>$null | Out-Null
    netsh advfirewall firewall add rule name="$ruleName" dir=in action=allow protocol=tcp localport="$ServicePortStart-$ServicePortEnd" profile=private,domain | Out-Null
    Write-OK "Firewall rules configured (netsh)"
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
        Write-OK "Watchdog scheduled (every 5 min)"
        Write-Log "Watchdog scheduled task installed" "SUCCESS"
    }
    catch {
        # Fallback for older Windows
        schtasks /Create /TN $WatchdogTaskName /TR "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogPath`"" /SC MINUTE /MO 5 /RU SYSTEM /F 2>$null | Out-Null
        Write-OK "Watchdog scheduled (schtasks)"
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
    Write-Banner
    
    # â”€â”€ Step 1: Pre-flight â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    Write-StepHeader "Pre-flight checks" 1
    
    if (-not (Test-Prerequisites)) {
        Write-FailBox "Pre-flight checks failed"
        return $false
    }
    
    Write-StepComplete
    
    # â”€â”€ Step 2: Cleanup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    Write-StepHeader "Cleaning previous installation" 2
    
    Stop-AllServiceProcesses
    Write-Dot "Stopped service processes"
    
    Remove-AllServices
    Write-Dot "Removed service registrations"
    
    Remove-DaemonFolder
    Write-Dot "Cleaned daemon folder"
    
    Start-Sleep -Seconds 2
    
    Write-StepComplete
    
    # â”€â”€ Step 3: Prepare directories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    Write-StepHeader "Preparing installation directory" 3
    
    if (-not (Test-Path $InstallPath)) {
        New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
    }
    
    Backup-Config
    
    @("$InstallPath\data", "$InstallPath\logs", "$InstallPath\backups") | ForEach-Object {
        if (-not (Test-Path $_)) {
            New-Item -ItemType Directory -Path $_ -Force | Out-Null
        }
    }
    Write-OK "Directories ready"
    
    Write-StepComplete
    
    # â”€â”€ Step 4: Copy files â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    Write-StepHeader "Copying service files" 4
    
    $sourceDir = Split-Path -Parent $PSScriptRoot
    
    Invoke-WithRetry -Operation "Copy dist files" -ScriptBlock {
        Copy-Item "$sourceDir\dist\*" "$InstallPath\" -Recurse -Force -ErrorAction Stop
    }
    Write-Dot "Application code copied"
    
    Copy-Item "$sourceDir\package.json" "$InstallPath\" -Force -ErrorAction SilentlyContinue
    
    if (Test-Path "$sourceDir\node_modules") {
        Write-Dot "Copying node_modules (this may take a moment)..."
        $null = robocopy "$sourceDir\node_modules" "$InstallPath\node_modules" /E /NFL /NDL /NJH /NJS /NC /NS /NP /MT:4 2>&1
        $robocopyExit = $LASTEXITCODE
        if ($robocopyExit -gt 7) {
            Write-WARN "node_modules copy had issues (exit code $robocopyExit)"
        }
    }
    
    if (Test-Path "$sourceDir\public") {
        Copy-Item "$sourceDir\public" "$InstallPath\" -Recurse -Force -ErrorAction SilentlyContinue
        Write-Dot "Dashboard assets copied"
    }
    
    Write-OK "Files deployed"
    
    Write-StepComplete
    
    # â”€â”€ Step 5: Configuration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    Write-StepHeader "Configuring service" 5
    
    $configDest = "$InstallPath\config.json"
    if ($ConfigPath -and (Test-Path $ConfigPath)) {
        Copy-Item $ConfigPath $configDest -Force
        Write-Dot "Using custom configuration"
    }
    elseif (-not (Test-Path $configDest)) {
        if (-not (Restore-ConfigFromBackup)) {
            if (Test-Path "$sourceDir\config.json") {
                Copy-Item "$sourceDir\config.json" $configDest -Force
            }
            elseif (Test-Path "$sourceDir\config.example.json") {
                Copy-Item "$sourceDir\config.example.json" $configDest -Force
                Write-Dot "Config created from example"
            }
        }
    }
    
    Set-ConfigPrivateNetworkAccess
    
    $availablePort = Find-AvailablePort
    if ($availablePort -ne $ServicePortStart) {
        Write-Dot "Port $ServicePortStart busy, using port $availablePort"
        Write-Log "Port $ServicePortStart in use, using port $availablePort"
    } else {
        Write-Dot "Port $availablePort available"
    }
    Update-ConfigPort -Port $availablePort
    
    Write-OK "Configuration ready"
    
    Write-StepComplete
    
    # â”€â”€ Step 6: Register Windows service â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    Write-StepHeader "Registering Windows service" 6
    
    Push-Location $InstallPath
    try {
        if (-not (Test-Path "node_modules\node-windows")) {
            Write-Dot "Installing node-windows..."
            $npmResult = & npm install node-windows --save --silent 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-FAIL "Failed to install node-windows"
                Write-Err "Failed to install node-windows: $npmResult"
                Pop-Location
                Write-FailBox "node-windows dependency install failed"
                return $false
            }
        }
        
        # Register Windows service via node-windows
        Write-Dot "Running node-windows service registration..."
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
            Write-Dot "node-windows registration successful"
            Write-Log "Service registered via node-windows"
        }
        else {
            Write-Dot "node-windows result: $resultStr"
            Write-Log "node-windows registration result: $resultStr" "WARNING"
        }
        
        Start-Sleep -Seconds 3
        
        # Verify the daemon XML has correct install paths (not dev paths)
        $daemonXml = "$InstallPath\daemon\$ServiceName.xml"
        if (Test-Path $daemonXml) {
            $xmlContent = Get-Content $daemonXml -Raw
            $installPathFwd = $InstallPath -replace '\\', '/'
            # Check if wrapper.js path points somewhere other than install path
            if ($xmlContent -notmatch [regex]::Escape($installPathFwd) -and $xmlContent -notmatch [regex]::Escape($InstallPath)) {
                Write-Dot "Fixing daemon paths..."
                Write-Log "Daemon XML has wrong paths - regenerating..." "WARNING"
                $wrapperJs = "$InstallPath\node_modules\node-windows\lib\wrapper.js"
                $scriptJs = "$InstallPath\index.js"
                $newXml = @"
<service>
        <id>$ServiceName</id>
        <name>$ServiceDisplayName</name>
        <description>$ServiceDescription</description>
        <executable>$(Get-Command node | Select-Object -ExpandProperty Source)</executable>
        <argument>--max-old-space-size=512</argument>
        <argument>$wrapperJs</argument>
        <argument>--file</argument>
        <argument>$scriptJs</argument>
        <argument>--scriptoptions=</argument>
        <argument>--log</argument>
        <argument>$ServiceDisplayName wrapper</argument>
        <argument>--grow</argument>
        <argument>0.5</argument>
        <argument>--wait</argument>
        <argument>5</argument>
        <argument>--maxrestarts</argument>
        <argument>10</argument>
        <argument>--abortonerror</argument>
        <argument>n</argument>
        <argument>--stopparentfirst</argument>
        <argument>undefined</argument>
        <logmode>rotate</logmode>
        <stoptimeout>30sec</stoptimeout>
        <env name="XP_CONFIG_PATH" value="$installPathFwd/config.json" />
        <env name="NODE_ENV" value="production" />
        <workingdirectory>$InstallPath</workingdirectory>
</service>
"@
                Set-Content -Path $daemonXml -Value $newXml -Encoding UTF8
                Write-Dot "Daemon XML regenerated"
                Write-Log "Daemon XML regenerated with correct install paths"
            }
        }
        
        # Verify service exists in Windows
        $svcCheck = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $svcCheck) {
            $svcCheck = Get-Service -DisplayName $ServiceDisplayName -ErrorAction SilentlyContinue
        }
        
        if ($svcCheck) {
            Write-OK "Service registered as: $($svcCheck.Name)"
            Write-Log "Service registered as: $($svcCheck.Name) (Status: $($svcCheck.Status))"
            if ($svcCheck.Status -ne 'Running') {
                Write-Dot "Starting service..."
                Write-Log "Starting service via sc.exe..."
                sc.exe start $svcCheck.Name 2>&1 | Out-Null
                Start-Sleep -Seconds 5
                $svcCheck = Get-Service -Name $svcCheck.Name
                Write-Log "Service status after start: $($svcCheck.Status)"
            }
        }
        else {
            # Fallback: register service directly via sc.exe using the daemon exe
            $daemonExe = "$InstallPath\daemon\$ServiceName"
            if (Test-Path $daemonExe) {
                Write-Dot "Using fallback service registration..."
                Write-Log "node-windows did not register service - using sc.exe create fallback..."
                
                # First try to register via the daemon exe's own install command (winsw)
                Push-Location "$InstallPath\daemon"
                $winswResult = & ".\$ServiceName" install 2>&1
                $winswStr = $winswResult -join "`n"
                Write-Log "winsw install result: $winswStr"
                Pop-Location
                
                Start-Sleep -Seconds 2
                
                # Check again
                $svcCheck = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
                if (-not $svcCheck) {
                    $svcCheck = Get-Service -DisplayName $ServiceDisplayName -ErrorAction SilentlyContinue
                }
                
                if (-not $svcCheck) {
                    # Ultimate fallback: raw sc.exe create
                    Write-Log "winsw install failed - using raw sc.exe create..."
                    sc.exe create $ServiceName binPath= "`"$daemonExe`"" DisplayName= "$ServiceDisplayName" start= delayed-auto 2>&1 | Out-Null
                    sc.exe description $ServiceName "$ServiceDescription" 2>&1 | Out-Null
                    
                    Start-Sleep -Seconds 2
                    $svcCheck = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
                }
                
                if ($svcCheck) {
                    Write-OK "Service registered via fallback"
                    Write-Log "Service registered via fallback as: $($svcCheck.Name)"
                    sc.exe start $svcCheck.Name 2>&1 | Out-Null
                    Start-Sleep -Seconds 5
                }
                else {
                    Write-FAIL "Failed to register service through all methods"
                    Write-Err "Failed to register Windows service through all methods"
                }
            }
            else {
                Write-FAIL "Daemon exe not found"
                Write-Err "Daemon exe not found at $daemonExe - node-windows installation failed"
            }
        }
        
        Write-StepComplete
        
        # â”€â”€ Step 7: Recovery options â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        Write-StepHeader "Configuring recovery & protection" 7
        
        & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 2>&1 | Out-Null
        & sc.exe failureflag $ServiceName 1 2>&1 | Out-Null
        & sc.exe config $ServiceName start= delayed-auto 2>&1 | Out-Null
        Write-OK "Auto-restart on failure (5s/10s/30s)"
        Write-OK "Delayed auto-start on boot"
        Write-Log "Service recovery options configured"
    }
    finally {
        Pop-Location
    }
    
    Write-StepComplete
    
    # â”€â”€ Step 8: Firewall â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    Write-StepHeader "Configuring firewall & watchdog" 8
    
    Add-FirewallRules
    
    Install-Watchdog
    
    Write-StepComplete
    
    # â”€â”€ Step 9: Verify service â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    Write-StepHeader "Starting service" 9
    
    $maxWaitSecs = 45
    $waited = 0
    $serviceRunning = $false
    $startAttempted = $false
    
    while ($waited -lt $maxWaitSecs -and -not $serviceRunning) {
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $svc) {
            $svc = Get-Service -DisplayName $ServiceDisplayName -ErrorAction SilentlyContinue
        }
        
        if ($svc) {
            if ($svc.Status -eq 'Running') {
                $serviceRunning = $true
                Clear-Spinner
                Write-OK "Service process running"
                Write-Log "Service process is running"
            }
            elseif ($svc.Status -eq 'Stopped' -and -not $startAttempted) {
                $startAttempted = $true
                Write-Log "Service stopped - starting via sc.exe..."
                sc.exe start $svc.Name 2>&1 | Out-Null
                Start-Sleep -Seconds 3
                $waited += 3
            }
            else {
                Write-Spinner "Waiting for service to start" $waited $maxWaitSecs
                Start-Sleep -Seconds 2
                $waited += 2
            }
        }
        else {
            Write-Spinner "Waiting for service registration" $waited $maxWaitSecs
            Start-Sleep -Seconds 2
            $waited += 2
        }
    }
    
    if (-not $serviceRunning) {
        Clear-Spinner
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($svc) {
            Write-Log "Final start attempt via sc.exe..."
            sc.exe start $svc.Name 2>&1 | Out-Null
            Start-Sleep -Seconds 5
            $svc = Get-Service -Name $svc.Name
            $serviceRunning = ($svc.Status -eq 'Running')
            if ($serviceRunning) { Write-OK "Service started on retry" }
        }
    }
    
    Write-StepComplete
    
    # â”€â”€ Step 10: Health check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    Write-StepHeader "Verifying health endpoint" 10
    
    $healthPort = $null
    $healthWait = 0
    $maxHealthWait = 60
    
    while ($healthWait -lt $maxHealthWait -and -not $healthPort) {
        $healthPort = Get-ServiceHealthPort
        if (-not $healthPort) {
            Write-Spinner "Waiting for API to respond" $healthWait $maxHealthWait
            Start-Sleep -Seconds 2
            $healthWait += 2
        }
    }
    Clear-Spinner
    
    # Fallback: check port file if HTTP didn't respond
    if (-not $healthPort -and $serviceRunning) {
        $portFile = "$InstallPath\active_port.txt"
        if (Test-Path $portFile) {
            $savedPort = [int](Get-Content $portFile -Raw).Trim()
            Write-Log "Found saved port $savedPort - verifying..."
            try {
                Invoke-WebRequest -Uri "http://127.0.0.1:$savedPort/health" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop | Out-Null
                $healthPort = $savedPort
            }
            catch {
                if ($_.Exception.Response) { $healthPort = $savedPort }
            }
        }
    }
    
    if ($healthPort) {
        Set-Content -Path "$InstallPath\active_port.txt" -Value $healthPort
        Write-OK "Health endpoint responding on port $healthPort"
        
        Write-Log "XP Thermal Service installed successfully on port $healthPort" "SUCCESS"
        
        # Read API key for display
        $apiKeyDisplay = ""
        $configFile = "$InstallPath\config.json"
        if (Test-Path $configFile) {
            try {
                $cfg = Get-Content $configFile -Raw | ConvertFrom-Json
                if ($cfg.security.enableApiKey -and $cfg.security.apiKey) {
                    $apiKeyDisplay = $cfg.security.apiKey
                }
            } catch {}
        }
        
        Write-SuccessBox -Port $healthPort -ApiKey $apiKeyDisplay
        
        return $true
    }
    else {
        Write-FAIL "Health endpoint did not respond within $maxHealthWait seconds"
        Write-FailBox "Service installed but API is not responding."
        
        return $false
    }
}

# ============================================================
# SERVICE UNINSTALLATION
# ============================================================

function Uninstall-Service {
    if (-not $Silent) {
        Write-Host ""
        Write-DBoxTop "DarkCyan"
        Write-DBoxEmpty "DarkCyan"
        Write-DBoxLine "    XP Thermal Print Service" "White" "DarkCyan"
        Write-DBoxLine "    Uninstaller" "DarkGray" "DarkCyan"
        Write-DBoxEmpty "DarkCyan"
        Write-DBoxBottom "DarkCyan"
        Write-Host ""
    }
    
    Write-Log "Starting XP Thermal Service Uninstallation"
    
    # Remove watchdog first
    Remove-Watchdog
    if (-not $Silent) { Write-OK "Watchdog removed" }
    
    # Stop all processes
    Stop-AllServiceProcesses
    if (-not $Silent) { Write-OK "Processes stopped" }
    
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
    if (-not $Silent) { Write-OK "Service registrations removed" }
    
    # Remove daemon folder
    Remove-DaemonFolder
    if (-not $Silent) { Write-OK "Daemon folder cleaned" }
    
    # Remove firewall rules
    Remove-FirewallRules
    if (-not $Silent) { Write-OK "Firewall rules removed" }
    
    # Ask about removing files (unless silent)
    if (-not $Silent) {
        Write-Host ""
        $removeFiles = Read-Host "   Remove all service files and data? (y/N)"
        if ($removeFiles -eq 'y' -or $removeFiles -eq 'Y') {
            Remove-Item $InstallPath -Recurse -Force -ErrorAction SilentlyContinue
            Write-OK "All service files removed"
            Write-Log "Removed all service files"
        }
        Write-Host ""
        Write-DBoxTop "Green"
        Write-DBoxEmpty "Green"
        Write-DBoxLine "     Service uninstalled successfully." "Green" "Green"
        Write-DBoxEmpty "Green"
        Write-DBoxBottom "Green"
        Write-Host ""
    }
    
    Write-Log "XP Thermal Service uninstalled successfully" "SUCCESS"
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
Write-Log "XP Thermal Service Installer v2.2"
Write-Log "Log file: $LogFile"
Write-Log "================================================"

if (-not (Test-Administrator)) {
    Write-Err "This script must be run as Administrator"
    if (-not $Silent) {
        Write-Host ""
        Write-Host "  This script requires " -NoNewline -ForegroundColor Gray
        Write-Host "Administrator" -NoNewline -ForegroundColor Yellow
        Write-Host " privileges." -ForegroundColor Gray
        Write-Host "  Right-click PowerShell and select 'Run as Administrator'." -ForegroundColor DarkGray
        Write-Host ""
    }
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
