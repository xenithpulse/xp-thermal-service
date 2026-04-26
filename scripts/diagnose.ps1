# XP Thermal Service - Diagnostic Script
# Run this script to diagnose installation and connectivity issues

param(
    [switch]$Fix,     # Attempt to fix common issues
    [switch]$Verbose  # Show verbose output
)

$ServiceName = "XP Thermal Print Service"
$InstallPath = "$env:ProgramData\XPThermalService"
$PortStart = 9100
$PortRange = 10

function Write-Header($text) {
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host " $text" -ForegroundColor Cyan
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
}

function Write-Check($description, $status, $detail = "") {
    $icon = if ($status -eq "OK") { "[✓]" } elseif ($status -eq "WARN") { "[!]" } else { "[✗]" }
    $color = if ($status -eq "OK") { "Green" } elseif ($status -eq "WARN") { "Yellow" } else { "Red" }
    
    Write-Host "$icon " -NoNewline -ForegroundColor $color
    Write-Host "$description" -NoNewline
    if ($detail) {
        Write-Host " - $detail" -ForegroundColor Gray
    } else {
        Write-Host ""
    }
}

function Test-ServiceInstalled {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    return $null -ne $svc
}

function Test-ServiceRunning {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    return $svc -and $svc.Status -eq 'Running'
}

function Test-ServiceAutoStart {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    return $svc -and $svc.StartType -eq 'Automatic'
}

function Find-ActivePort {
    for ($p = $PortStart; $p -lt ($PortStart + $PortRange); $p++) {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$p/health" -TimeoutSec 2 -UseBasicParsing -ErrorAction SilentlyContinue
            if ($response.StatusCode -eq 200) {
                return $p
            }
        } catch {
            # Port not responding
        }
    }
    return $null
}

function Test-FirewallRule {
    try {
        $rule = Get-NetFirewallRule -DisplayName "XP Thermal Service" -ErrorAction SilentlyContinue
        return $null -ne $rule
    } catch {
        # Fallback for Windows 7
        $result = netsh advfirewall firewall show rule name="XP Thermal Service" 2>$null
        return $result -and $result -notmatch "No rules match"
    }
}

function Get-ServiceHealth($port) {
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 5 -ErrorAction Stop
        return $response
    } catch {
        return $null
    }
}

function Get-ConfiguredPrinters($port) {
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/printers" -TimeoutSec 5 -ErrorAction Stop
        return $response.printers
    } catch {
        return @()
    }
}

# ============================================================================
# MAIN DIAGNOSTICS
# ============================================================================

Write-Host ""
Write-Host "  XP Thermal Service Diagnostics" -ForegroundColor Cyan
Write-Host "  ===============================" -ForegroundColor Cyan
Write-Host "  Run Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host ""

# ─────────────────────────────────────────────────────────────────────────────
# 1. Check Node.js
# ─────────────────────────────────────────────────────────────────────────────
Write-Header "Node.js Environment"

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    $nodeVersion = & node --version 2>$null
    $major = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
    if ($major -ge 18) {
        Write-Check "Node.js installed" "OK" $nodeVersion
    } else {
        Write-Check "Node.js version" "FAIL" "v18+ required, found $nodeVersion"
    }
} else {
    Write-Check "Node.js installed" "FAIL" "Node.js not found in PATH"
}

# ─────────────────────────────────────────────────────────────────────────────
# 2. Check Service Installation
# ─────────────────────────────────────────────────────────────────────────────
Write-Header "Windows Service"

if (Test-ServiceInstalled) {
    Write-Check "Service installed" "OK" $ServiceName
    
    if (Test-ServiceAutoStart) {
        Write-Check "Auto-start enabled" "OK"
    } else {
        Write-Check "Auto-start enabled" "WARN" "Service won't start on boot"
        if ($Fix) {
            Write-Host "  Attempting fix..." -ForegroundColor Yellow
            & sc.exe config "$ServiceName" start= auto 2>&1 | Out-Null
        }
    }
    
    if (Test-ServiceRunning) {
        Write-Check "Service running" "OK"
    } else {
        Write-Check "Service running" "FAIL" "Service is not running"
        if ($Fix) {
            Write-Host "  Attempting to start service..." -ForegroundColor Yellow
            Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 3
            if (Test-ServiceRunning) {
                Write-Check "Service started" "OK"
            }
        }
    }
} else {
    Write-Check "Service installed" "FAIL" "Service not found"
    Write-Host "  Run install.ps1 to install the service" -ForegroundColor Yellow
}

# ─────────────────────────────────────────────────────────────────────────────
# 3. Check Installation Files
# ─────────────────────────────────────────────────────────────────────────────
Write-Header "Installation Files"

if (Test-Path $InstallPath) {
    Write-Check "Install directory exists" "OK" $InstallPath
    
    $requiredFiles = @("index.js", "config.json", "package.json")
    foreach ($file in $requiredFiles) {
        if (Test-Path "$InstallPath\$file") {
            Write-Check "  $file" "OK"
        } else {
            Write-Check "  $file" "FAIL" "Missing"
        }
    }
    
    if (Test-Path "$InstallPath\node_modules") {
        $moduleCount = (Get-ChildItem "$InstallPath\node_modules" -Directory).Count
        Write-Check "  node_modules/" "OK" "$moduleCount modules"
    } else {
        Write-Check "  node_modules/" "FAIL" "Missing"
    }
} else {
    Write-Check "Install directory" "FAIL" "Not found at $InstallPath"
}

# ─────────────────────────────────────────────────────────────────────────────
# 4. Check Network/Port
# ─────────────────────────────────────────────────────────────────────────────
Write-Header "Network & Connectivity"

if (Test-FirewallRule) {
    Write-Check "Firewall rule" "OK" "Port 9100 allowed"
} else {
    Write-Check "Firewall rule" "WARN" "May block connections"
}

$activePort = Find-ActivePort
if ($activePort) {
    Write-Check "Service responding" "OK" "Port $activePort"
    
    # Test health endpoint
    $health = Get-ServiceHealth $activePort
    if ($health) {
        Write-Check "Health check" "OK" "Status: $($health.status)"
        Write-Check "  Uptime" "OK" "$([math]::Round($health.uptime / 1000 / 60, 1)) minutes"
        
        if ($health.printers) {
            $online = $health.printers.online
            $total = $health.printers.total
            if ($total -eq 0) {
                Write-Check "  Printers" "WARN" "No printers configured"
            } elseif ($online -eq 0) {
                Write-Check "  Printers" "FAIL" "$total configured, none online"
            } elseif ($online -lt $total) {
                Write-Check "  Printers" "WARN" "$online/$total online"
            } else {
                Write-Check "  Printers" "OK" "$online/$total online"
            }
        }
        
        if ($health.queue) {
            $pending = $health.queue.pending
            if ($pending -gt 10) {
                Write-Check "  Queue" "WARN" "$pending jobs pending"
            } else {
                Write-Check "  Queue" "OK" "$pending jobs pending"
            }
        }
    } else {
        Write-Check "Health check" "FAIL" "Could not get health data"
    }
} else {
    Write-Check "Service responding" "FAIL" "No response on ports $PortStart-$($PortStart + $PortRange - 1)"
}

# ─────────────────────────────────────────────────────────────────────────────
# 5. Check Printers
# ─────────────────────────────────────────────────────────────────────────────
Write-Header "Printer Configuration"

if ($activePort) {
    $printers = Get-ConfiguredPrinters $activePort
    if ($printers -and $printers.Count -gt 0) {
        foreach ($printer in $printers) {
            $statusIcon = if ($printer.isOnline) { "OK" } else { "FAIL" }
            $statusText = if ($printer.isOnline) { "Online" } else { "Offline" }
            Write-Check "$($printer.name)" $statusIcon "$($printer.type) - $statusText"
        }
    } else {
        Write-Check "No printers configured" "WARN" "Add printers via dashboard"
    }
}

# Check Windows system printers
Write-Host ""
Write-Host "  System Printers:" -ForegroundColor Gray
try {
    $systemPrinters = Get-Printer -ErrorAction SilentlyContinue | Select-Object -First 5
    if ($systemPrinters) {
        foreach ($p in $systemPrinters) {
            Write-Host "    - $($p.Name) ($($p.DriverName))" -ForegroundColor Gray
        }
    }
} catch {
    # WMI fallback for Windows 7
    $wmPrinters = Get-WmiObject Win32_Printer -ErrorAction SilentlyContinue | Select-Object -First 5
    if ($wmPrinters) {
        foreach ($p in $wmPrinters) {
            Write-Host "    - $($p.Name)" -ForegroundColor Gray
        }
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# 6. Summary & Recommendations
# ─────────────────────────────────────────────────────────────────────────────
Write-Header "Summary"

$issues = @()

if (-not (Test-ServiceInstalled)) {
    $issues += "Service not installed - run install.ps1"
} elseif (-not (Test-ServiceRunning)) {
    $issues += "Service not running - run: Start-Service '$ServiceName'"
}

if (-not $activePort) {
    $issues += "Service not responding - check logs at $InstallPath\logs\"
}

if (-not (Test-FirewallRule)) {
    $issues += "Firewall rule missing - may need to allow port 9100"
}

if ($issues.Count -eq 0) {
    Write-Host "  All checks passed! Service is healthy." -ForegroundColor Green
    if ($activePort) {
        Write-Host ""
        Write-Host "  Dashboard: http://127.0.0.1:$activePort/dashboard" -ForegroundColor Cyan
        Write-Host "  API:       http://127.0.0.1:$activePort/api" -ForegroundColor Cyan
    }
} else {
    Write-Host "  Issues found:" -ForegroundColor Yellow
    foreach ($issue in $issues) {
        Write-Host "    - $issue" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "  Run with -Fix to attempt automatic fixes" -ForegroundColor Gray
}

Write-Host ""
