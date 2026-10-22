# ============================================================
# XP Thermal Service - Restart Trigger
# ============================================================
#
# Forces a restart of the XP Thermal Print Service using a cascade of methods.
# Designed to be invoked from the POS app at:
#   E:\xp-pos\pos_modules\orders\printing-facility
#
# Usage (from PowerShell):
#   powershell -ExecutionPolicy Bypass -File trigger-restart.ps1
#   powershell -ExecutionPolicy Bypass -File trigger-restart.ps1 -Reason "stuck after idle"
#
# Usage (from Node.js inside the POS module):
#   const { spawn } = require('child_process');
#   spawn('powershell.exe', [
#     '-ExecutionPolicy', 'Bypass',
#     '-WindowStyle', 'Hidden',
#     '-File', 'C:\\ProgramData\\XPThermalService\\trigger-restart.ps1',
#     '-Reason', 'pos-health-check-failed'
#   ], { detached: true, stdio: 'ignore' }).unref();
#
# Method cascade (each attempted in order; succeeds on first that works):
#   1. HTTP API call to /api/service/restart (loopback, requires API key)
#   2. Drop a file at <InstallPath>\triggers\restart.trigger (handled by the
#      service's in-process watcher OR Layer B heartbeat scheduled task)
#   3. Restart-Service via Windows Service Control Manager (requires admin)
# ============================================================

param(
    [string]$Reason = "manual",
    [string]$InstallPath = "$env:ProgramData\XPThermalService",
    [int]$TimeoutSec = 10
)

$ErrorActionPreference = "SilentlyContinue"

function Write-Result($method, $ok, $detail) {
    $status = if ($ok) { "OK" } else { "FAIL" }
    Write-Host "[$status] $method - $detail"
}

# ── Method 1: HTTP API ──────────────────────────────────────────────
function Invoke-HttpRestart {
    $portFile = "$InstallPath\active_port.txt"
    if (-not (Test-Path $portFile)) {
        Write-Result "HTTP API" $false "active_port.txt not found"
        return $false
    }

    $port = (Get-Content $portFile -Raw).Trim()
    if (-not $port) {
        Write-Result "HTTP API" $false "active_port.txt is empty"
        return $false
    }

    # Read API key from config.json (loopback restart endpoint requires it
    # when API key auth is enabled)
    $apiKey = ""
    $configFile = "$InstallPath\config.json"
    if (Test-Path $configFile) {
        try {
            $cfg = Get-Content $configFile -Raw | ConvertFrom-Json
            if ($cfg.security.enableApiKey -and $cfg.security.apiKey) {
                $apiKey = $cfg.security.apiKey
            }
        } catch {}
    }

    $headers = @{ 'Content-Type' = 'application/json' }
    if ($apiKey) { $headers['X-API-Key'] = $apiKey }

    try {
        $body = @{ reason = $Reason } | ConvertTo-Json -Compress
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/service/restart" `
            -Method Post -Headers $headers -Body $body `
            -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop
        if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) {
            Write-Result "HTTP API" $true "POST /api/service/restart returned $($resp.StatusCode)"
            return $true
        }
        Write-Result "HTTP API" $false "Unexpected status $($resp.StatusCode)"
        return $false
    } catch {
        Write-Result "HTTP API" $false $_.Exception.Message
        return $false
    }
}

# ── Method 2: Trigger file ──────────────────────────────────────────
function Invoke-TriggerFile {
    $triggerDir  = "$InstallPath\triggers"
    $triggerFile = "$triggerDir\restart.trigger"
    try {
        if (-not (Test-Path $triggerDir)) {
            New-Item -ItemType Directory -Path $triggerDir -Force -ErrorAction Stop | Out-Null
        }
        $payload = "reason=$Reason; ts=$(Get-Date -Format 'o'); user=$env:USERNAME"
        Set-Content -Path $triggerFile -Value $payload -Encoding UTF8 -ErrorAction Stop
        Write-Result "Trigger File" $true $triggerFile
        return $true
    } catch {
        Write-Result "Trigger File" $false $_.Exception.Message
        return $false
    }
}

# ── Method 3: Windows Service Control ───────────────────────────────
function Invoke-ServiceRestart {
    $svc = Get-Service -Name "xpthermalprintservice.exe" -ErrorAction SilentlyContinue
    if (-not $svc) {
        $svc = Get-Service -DisplayName "XP Thermal Print Service" -ErrorAction SilentlyContinue
    }
    if (-not $svc) {
        Write-Result "Service Control" $false "Service not registered"
        return $false
    }

    try {
        Restart-Service -Name $svc.Name -Force -ErrorAction Stop
        Write-Result "Service Control" $true "Restart-Service issued (status=$((Get-Service $svc.Name).Status))"
        return $true
    } catch {
        # Fallback to sc.exe (works without elevation on stop, may need it on start)
        sc.exe stop $svc.Name 2>&1 | Out-Null
        Start-Sleep -Seconds 3
        sc.exe start $svc.Name 2>&1 | Out-Null
        Write-Result "Service Control" $true "sc.exe stop+start issued"
        return $true
    }
}

# ── Run cascade ─────────────────────────────────────────────────────
Write-Host "XP Thermal Service - Restart Trigger (reason=$Reason)"
Write-Host ("-" * 60)

# Always drop the trigger file first — it's the most resilient and works
# even if the HTTP API is dead. Layer B picks it up within 10 min;
# the in-process watcher picks it up within 15 sec.
$triggerOk = Invoke-TriggerFile

# Try HTTP for a fast restart (sub-second)
$httpOk = Invoke-HttpRestart

# If HTTP failed AND user is admin, also force a service restart
if (-not $httpOk) {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($isAdmin) {
        Invoke-ServiceRestart | Out-Null
    } else {
        Write-Host "[SKIP] Service Control - not running as Administrator (trigger file will be picked up by Layer B within 10 min)"
    }
}

if ($triggerOk -or $httpOk) {
    Write-Host ""
    Write-Host "Restart requested successfully."
    exit 0
} else {
    Write-Host ""
    Write-Host "All restart methods failed. Service may need manual intervention."
    exit 1
}
