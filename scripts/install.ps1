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
# ProgramData is normally C:\ProgramData but can be redirected, or missing
# from the environment block entirely when the installer is launched from a
# service / scheduled task / restricted shell. Fall back rather than build a
# rootless path like "\XPThermalService".
$ProgramDataRoot = $env:ProgramData
if (-not $ProgramDataRoot) { $ProgramDataRoot = "$env:ALLUSERSPROFILE" }
if (-not $ProgramDataRoot) { $ProgramDataRoot = "$env:SystemDrive\ProgramData" }
if (-not $ProgramDataRoot) { $ProgramDataRoot = "C:\ProgramData" }
$InstallPath = "$ProgramDataRoot\XPThermalService"
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
$HeartbeatTaskName = "XPThermalServiceHeartbeat"

# Set while the install has the watchdog scheduled tasks disabled, so the
# installer can put them back if it bails out before Step 8 re-registers them.
$script:WatchdogSuspended = $false

# Byte offsets into the daemon's own logs, taken before this install's first
# start attempt so Get-DaemonFailureReason reads only what THIS run produced.
$script:DaemonLogMark = $null

# Detail about processes Stop-AllServiceProcesses could not terminate, so the
# caller can explain the problem instead of just reporting that there was one.
$script:StopFailure = $null

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
    Write-Host "Layer A: HTTP probe every 2 min  |  Layer B: trigger watcher every 10 min" -ForegroundColor DarkGray
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

<#
    Run a JavaScript program with the system node, WITHOUT going through
    "node -e".

    WHY THIS EXISTS. Windows PowerShell 5.1 builds the command line for a native
    executable by wrapping each argument in double quotes, and it does NOT
    escape double quotes that are already inside the argument. So the first `"`
    in a script passed to `node -e` ENDS the argument. Node receives a truncated
    program, and everything after that point is handed to it as unrelated extra
    argv entries, which -e ignores.

    It fails in two ways and the quiet one is worse:

      - If the cut lands mid-expression, node reports a SyntaxError whose line
        number and text point at a COMMENT, which sends you looking for a
        problem in prose. That is what happened here (2026-08-12, real install):
        the maxRestarts comment block was the first thing in this file to
        contain a double quote, and service registration started failing with
          [eval]:19
          // which is indistinguishable from the
          SyntaxError: Unexpected end of input
        The install still "succeeded" because the sc.exe fallback below caught
        it, so the only visible symptom was a warning scrolling past.

      - If the cut lands after a complete statement, node exits 0 having run
        HALF the program. Measured: a three-line script whose second line held a
        quoted comment ran, printed nothing, and exited 0.

    A temp file has no quoting rules at all, so this cannot come back. Do not
    "simplify" it back to node -e.

    WHERE THE FILE GOES IS PART OF THE FIX, not an implementation detail.

    `node -e` resolves require() against the CURRENT DIRECTORY. A script file
    resolves it against the SCRIPT'S OWN directory. So the first version of this
    helper wrote to %TEMP%, and registration then failed with:

        Error: Cannot find module 'node-windows'
        Require stack:
        - C:\Users\DELL\AppData\Local\Temp\xp-thermal-register-<guid>.js

    That is a regression this helper introduced while fixing the truncation: the
    quoting problem was gone and the module resolution broke in its place. The
    file must therefore live in the directory that OWNS node_modules, which is
    the install path - never %TEMP%.
#>
function Invoke-NodeScript {
    param(
        [Parameter(Mandatory = $true)][string]$Script,
        [string]$Name = 'xp-thermal',
        # Defaults to the install path because that is where node_modules is.
        [string]$WorkingDirectory = $InstallPath
    )

    if (-not $WorkingDirectory -or -not (Test-Path $WorkingDirectory)) {
        $WorkingDirectory = [System.IO.Path]::GetTempPath()
        Write-Log "Invoke-NodeScript: falling back to TEMP - require() may not resolve" "WARNING"
    }

    $tempFile = Join-Path $WorkingDirectory ("{0}-{1}.js" -f $Name, [guid]::NewGuid().ToString('N'))
    try {
        # No BOM: node tolerates one, but a stray BOM in a generated file is the
        # kind of thing that turns into a different afternoon later.
        [System.IO.File]::WriteAllText($tempFile, $Script, (New-Object System.Text.UTF8Encoding $false))
        return (& node $tempFile 2>&1)
    }
    finally {
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
    }
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

# ============================================================
# STOPPING WHAT IS ACTUALLY RUNNING
# ============================================================

<#
    THE SERVICE IS THREE PROCESSES DEEP, NOT ONE.

        xpthermalprintservice.exe    winsw - this is the Windows service
          |- node.exe                node-windows lib/wrapper.js
              |- node.exe            index.js  <- owns port 9100 and service.lock

    Only the leaf matters for a reinstall, and it is the one every previous
    version of this cleanup missed:

      * "taskkill /F /IM xpthermalprintservice.exe" kills the TOP of the tree
        and orphans both node processes. They keep the port and keep
        heartbeating the instance lock.
      * The block below it that was meant to catch the children collected
        their PIDs AFTER that taskkill had already run, so the list was always
        empty and the block never executed once.
      * Matching node.exe on Get-Process.Path never matched anything either -
        the binary is C:\Program Files\nodejs\node.exe. Only the COMMAND LINE
        mentions the install path.

    Measured, from a real daemon err.log on the dev box:

        Failed to start service: listen EADDRINUSE 127.0.0.1:9100
        FATAL: Another XP Thermal Service is already running (process 2700 ...)

    That pair IS the installer hanging on "Step 9 - Starting service". The new
    service starts, finds the old one still holding the port and the lock,
    exits; the wrapper respawns it and it does the same thing again, forever.
#>

# Who is listening on the service port range?
#
# Get-NetTCPConnection is the better answer but it rides the same MI/WMI stack
# that is damaged on some tills, and it was previously wrapped in
# SilentlyContinue - so a broken stack returned NOTHING rather than throwing,
# and the netstat fallback in the catch block never ran. The fallback is now
# checked on an empty result too, which is the case that actually happens.
function Get-PortHolderPids {
    $found = New-Object System.Collections.Generic.List[int]

    try {
        $conns = Get-NetTCPConnection -LocalPort ($ServicePortStart..$ServicePortEnd) -State Listen -ErrorAction Stop
        foreach ($c in $conns) {
            $owner = [int]$c.OwningProcess
            if ($owner -gt 0 -and -not $found.Contains($owner)) { $found.Add($owner) }
        }
    }
    catch { }

    if ($found.Count -eq 0) {
        # netstat has no dependency on WMI at all.
        try {
            netstat -ano -p TCP 2>$null | Select-String 'LISTENING' | ForEach-Object {
                if ("$_" -match ':(\d+)\s+\S+\s+LISTENING\s+(\d+)') {
                    $port = [int]$Matches[1]
                    $procId = [int]$Matches[2]
                    if ($port -ge $ServicePortStart -and $port -le $ServicePortEnd -and -not $found.Contains($procId)) {
                        $found.Add($procId)
                    }
                }
            }
        }
        catch { }
    }

    # Never hand back System (4) or the idle process: some listeners are owned
    # by the kernel and killing one must not be a typo away.
    return @($found | Where-Object { $_ -gt 4 })
}

# Every descendant of the given PIDs, breadth-first.
function Get-DescendantPids {
    param([int[]]$RootPids)

    if (-not $RootPids -or $RootPids.Count -eq 0) { return @() }

    $table = $null
    try { $table = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId) }
    catch {
        # No process table (damaged WMI). taskkill /T is the backstop, so hand
        # back the roots rather than failing the install here.
        return @($RootPids)
    }

    $seen  = New-Object System.Collections.Generic.List[int]
    $queue = New-Object System.Collections.Generic.Queue[int]
    foreach ($p in $RootPids) {
        if (-not $seen.Contains([int]$p)) { $seen.Add([int]$p); $queue.Enqueue([int]$p) }
    }

    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        foreach ($child in ($table | Where-Object { [int]$_.ParentProcessId -eq $parent })) {
            $procId = [int]$child.ProcessId
            if ($procId -gt 4 -and -not $seen.Contains($procId)) {
                $seen.Add($procId)
                $queue.Enqueue($procId)
            }
        }
    }
    return $seen.ToArray()
}

# This process and everything that launched it.
#
# The dashboard can launch the installer, which would make the installer a
# descendant of the service it is about to tree-kill. "taskkill /F /T" on that
# tree would take the installer down with it, mid-write, over a half-copied
# install. Cheap to rule out, and impossible to recover from if we do not.
function Get-SelfAncestorPids {
    $chain = New-Object System.Collections.Generic.List[int]
    $current = $PID
    $guard = 0

    while ($current -gt 4 -and $guard -lt 32) {
        if ($chain.Contains($current)) { break }
        $chain.Add($current)
        $guard++
        try {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction Stop
            if (-not $proc) { break }
            $current = [int]$proc.ParentProcessId
        }
        catch { break }
    }
    return $chain.ToArray()
}

# Which ports in our range is this process listening on? Reporting only.
function Get-PortsForPid {
    param([int]$ProcessId)

    $ports = New-Object System.Collections.Generic.List[int]
    try {
        Get-NetTCPConnection -State Listen -ErrorAction Stop |
            Where-Object {
                [int]$_.OwningProcess -eq $ProcessId -and
                [int]$_.LocalPort -ge $ServicePortStart -and
                [int]$_.LocalPort -le $ServicePortEnd
            } |
            ForEach-Object {
                $port = [int]$_.LocalPort
                if (-not $ports.Contains($port)) { $ports.Add($port) }
            }
    }
    catch { }
    return $ports.ToArray()
}

<#
    EVERY PROCESS BELONGING TO THIS SERVICE - AND HOW SURE WE ARE.

    The certainty matters as much as the list. A surviving process that is
    POSITIVELY ours holds the port and the instance lock, so a new copy cannot
    start and there is no honest way to continue the install. A node process we
    merely found listening on 9105 might just as easily be the customer's own
    application, and refusing to install over that would be a worse bug than
    the one being fixed - Step 5 can simply pick another port.

    So: kill on suspicion, abort only on proof.
#>
function Get-ServiceProcessInfo {
    $installLeaf = Split-Path $InstallPath -Leaf
    $self = @(Get-SelfAncestorPids)
    $found = @{}

    # 1. The winsw daemons and everything underneath them - unambiguous.
    $roots = @()
    try {
        $roots = @(Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object { $_.Name -eq 'xpthermalprintservice.exe' -or $_.Name -eq 'xpthermalservice.exe' } |
            ForEach-Object { [int]$_.ProcessId })
    }
    catch {
        $roots = @(Get-Process -Name 'xpthermalprintservice', 'xpthermalservice' -ErrorAction SilentlyContinue |
            ForEach-Object { [int]$_.Id })
    }
    foreach ($p in (Get-DescendantPids -RootPids $roots)) {
        $found[[int]$p] = @{ Ours = $true; Why = 'in the service process tree' }
    }

    # 2. node.exe running OUR script - matched on the command line, which is
    #    the only place the install path appears.
    try {
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
            Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$installLeaf*") } |
            ForEach-Object { $found[[int]$_.ProcessId] = @{ Ours = $true; Why = 'node running the service script' } }
    }
    catch { }

    # 3. Whoever is listening on the port range, if we can name them.
    foreach ($p in (Get-PortHolderPids)) {
        $procId = [int]$p
        if ($found.ContainsKey($procId)) { continue }

        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        if ($proc.Name -notmatch '^(node|xpthermalprintservice|xpthermalservice)$') { continue }

        $cmd = $null
        try { $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop).CommandLine } catch { }

        if ($cmd -and ($cmd -like "*$installLeaf*")) {
            $found[$procId] = @{ Ours = $true; Why = 'node running the service script' }
        }
        else {
            # Could be an orphan of ours whose parent is long gone, or could be
            # somebody else's program. Not proof either way.
            $found[$procId] = @{ Ours = $false; Why = 'unidentified listener in the service port range' }
        }
    }

    $result = New-Object System.Collections.Generic.List[object]
    foreach ($procId in @($found.Keys)) {
        if ($self -contains $procId) { continue }
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        $result.Add([pscustomobject]@{
            ProcessId = $procId
            Name      = if ($proc) { $proc.Name } else { 'gone' }
            Ours      = $found[$procId].Ours
            Why       = $found[$procId].Why
        })
    }
    return $result.ToArray()
}

function Get-ServicePids {
    return @(Get-ServiceProcessInfo | ForEach-Object { $_.ProcessId })
}

<#
    THREE WAYS TO KILL, AND KEEP THE REASON WHEN THEY FAIL.

    taskkill /F /T is the right default - it takes descendants with it. The
    previous code sent its output to $null, so when it failed the installer
    knew only that a PID was still there, which is what "Could not terminate
    node (PID 1340)" was: true, and useless.

    The distinction that matters to whoever reads the log:

      "Access is denied"      a privilege problem, worth another approach
      accepted, still listed  the process is blocked in the kernel - a wedged
                              device or driver I/O - and nothing short of a
                              reboot will clear it

    Stop-Process and the WMI terminate are genuinely different code paths and
    one occasionally succeeds where taskkill does not, which is worth trying
    before telling somebody to reboot a till in the middle of service.
#>
function Stop-ProcessHard {
    param([int]$ProcessId)

    $attempts = New-Object System.Collections.Generic.List[string]

    # Through cmd, NOT "taskkill ... 2>&1".
    #
    # Redirecting a native command's stderr in PowerShell 5.1 wraps every line
    # in an ErrorRecord, so the one sentence worth reading ("Reason: Access is
    # denied.") arrives buried in "At line:6 char:13 + $out = (taskkill ..."
    # and a stack of NativeCommandError decoration. cmd merges the streams
    # before PowerShell ever sees them.
    $out = (cmd /c "taskkill /F /T /PID $ProcessId 2>&1" | Out-String)
    if ($LASTEXITCODE -ne 0) {
        $why = @($out -split "`r?`n" |
            Where-Object { $_ -match 'Reason:' } |
            ForEach-Object { $_.Trim() } |
            Select-Object -Unique |
            Select-Object -First 2)
        if ($why.Count -gt 0) { $attempts.Add("taskkill: $($why -join ' / ')") }
        elseif ($out.Trim()) { $attempts.Add("taskkill: $($out.Trim())") }
    }
    Start-Sleep -Milliseconds 500
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $null }

    try { Stop-Process -Id $ProcessId -Force -ErrorAction Stop }
    catch { $attempts.Add("Stop-Process: $($_.Exception.Message)") }
    Start-Sleep -Milliseconds 500
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $null }

    try {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
        if ($proc) {
            $rc = (Invoke-CimMethod -InputObject $proc -MethodName Terminate -ErrorAction Stop).ReturnValue
            if ($rc -ne 0) { $attempts.Add("WMI Terminate returned $rc") }
        }
    }
    catch { $attempts.Add("WMI Terminate: $($_.Exception.Message)") }
    Start-Sleep -Milliseconds 500
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $null }

    if ($attempts.Count -eq 0) {
        $attempts.Add("every terminate call was accepted and the process is still running - it is stuck in a kernel call, which only a reboot clears")
    }
    return ($attempts -join '; ')
}

# sc.exe stop returns as soon as the SCM accepts the request, not when the
# service is down.
function Wait-ServiceStopped {
    param([string]$Name, [int]$TimeoutSec = 30)

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
        if (-not $svc -or $svc.Status -eq 'Stopped') { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

<#
    THE WATCHDOG HAS TO BE TOLD TO STAND DOWN DURING AN INSTALL.

    Layer A runs every two minutes as SYSTEM and its entire job is "if the
    service is not running, start it". An install stops the service for several
    minutes - the node_modules robocopy alone is over a minute on a till - so
    the OLD watchdog, belonging to the OLD install, spends that whole window
    faithfully restarting the OLD service on top of the one being deployed.

    That is where "the service is still listed in Task Manager" comes from, and
    it is the other half of the EADDRINUSE at Step 9. Nothing suspended these
    tasks before: Install-Watchdog re-registers them at Step 8, which is six
    steps too late to help.
#>
function Suspend-Watchdog {
    foreach ($task in @($WatchdogTaskName, $HeartbeatTaskName)) {
        try { Disable-ScheduledTask -TaskName $task -ErrorAction Stop | Out-Null }
        catch { schtasks /Change /TN $task /DISABLE 2>$null | Out-Null }
        # Disabling does not stop an instance that is already mid-run.
        schtasks /End /TN $task 2>$null | Out-Null
    }
    $script:WatchdogSuspended = $true
    Write-Log "Watchdog and heartbeat tasks suspended for the duration of the install"
}

# Step 8 re-registers both tasks with -Force, which re-enables them, so this
# only matters when the install bails out before then. A box left with no
# watchdog because an install failed is strictly worse than the state it
# started in.
function Resume-Watchdog {
    if (-not $script:WatchdogSuspended) { return }
    foreach ($task in @($WatchdogTaskName, $HeartbeatTaskName)) {
        try { Enable-ScheduledTask -TaskName $task -ErrorAction Stop | Out-Null }
        catch { schtasks /Change /TN $task /ENABLE 2>$null | Out-Null }
    }
    $script:WatchdogSuspended = $false
    Write-Log "Watchdog and heartbeat tasks re-enabled"
}

# The instance lock lives in data\, which an update deliberately preserves - so
# a lock written by a process we just force-killed survives into the new
# install carrying a heartbeat only seconds old. The new service then waits 20s
# for a handover that is never coming and exits with "Another XP Thermal
# Service is already running".
#
# Only call this once Stop-AllServiceProcesses has confirmed nothing of ours is
# left running: at that point the lock cannot have a live owner by definition.
function Clear-InstanceLock {
    $lockPath = "$InstallPath\data\service.lock"
    if (-not (Test-Path $lockPath)) { return }

    $owner = ""
    try {
        $lock = Get-Content $lockPath -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($lock.pid) { $owner = " (was held by process $($lock.pid))" }
    }
    catch { }

    Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
    Write-Log "Cleared the instance lock$owner"
}

function Stop-AllServiceProcesses {
    Write-Log "Stopping all service-related processes..."
    $script:StopFailure = $null

    # Ask politely first, and WAIT. A graceful stop lets the service drain
    # in-flight receipts and release its own instance lock, which is the whole
    # difference between an update and a corrupted one. Nothing here waited
    # before: sc.exe stop was fired and the force-kill followed two seconds
    # later regardless.
    $toStop = New-Object System.Collections.Generic.List[string]
    foreach ($name in (@($ServiceName) + $LegacyServiceNames)) {
        $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
        if ($svc -and -not $toStop.Contains($svc.Name)) { $toStop.Add($svc.Name) }
    }
    # An install that fell back to sc.exe create may have registered under a
    # different key. The display name is the one thing that stays put.
    $byDisplay = Get-Service -DisplayName $ServiceDisplayName -ErrorAction SilentlyContinue
    if ($byDisplay -and -not $toStop.Contains($byDisplay.Name)) { $toStop.Add($byDisplay.Name) }

    foreach ($name in $toStop) {
        $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
        if (-not $svc -or $svc.Status -eq 'Stopped') { continue }
        Write-Log "Stopping service $name (status $($svc.Status))..."
        sc.exe stop $name 2>$null | Out-Null
        if (-not (Wait-ServiceStopped -Name $name -TimeoutSec 30)) {
            Write-Log "Service $name did not stop within 30s - forcing" "WARNING"
        }
    }

    # Kill the TREE, not the root. /T takes the orphaned node children with it,
    # which "taskkill /F /IM" never did.
    foreach ($procId in (Get-ServicePids)) {
        Write-Log "Terminating service process tree at PID $procId"
        $err = Stop-ProcessHard -ProcessId $procId
        if ($err) { Write-Log "PID ${procId} survived: $err" "WARNING" }
    }

    # Image-name sweep for anything the tree walk could not see (damaged WMI).
    foreach ($exeName in @("xpthermalprintservice.exe", "xpthermalservice.exe")) {
        taskkill /F /IM $exeName 2>$null | Out-Null
    }

    Start-Sleep -Seconds 2

    # VERIFY, and say so.
    #
    # Everything downstream - the file copy, the service registration, the
    # start at Step 9 - assumed this worked, and until now nothing checked. A
    # single surviving node.exe holding port 9100 is the entire "installer
    # stops at Step 9" failure, and it was reported as "Stopped service
    # processes" with a tick next to it.
    $deadline = (Get-Date).AddSeconds(30)
    $remaining = @(Get-ServiceProcessInfo)
    while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline) {
        foreach ($p in $remaining) { $null = Stop-ProcessHard -ProcessId $p.ProcessId }
        Start-Sleep -Seconds 2
        $remaining = @(Get-ServiceProcessInfo)
    }

    if ($remaining.Count -gt 0) {
        $detail = New-Object System.Collections.Generic.List[string]
        foreach ($p in $remaining) {
            $line = "$($p.Name) (PID $($p.ProcessId)) - $($p.Why)"
            $ports = @(Get-PortsForPid -ProcessId $p.ProcessId)
            if ($ports.Count -gt 0) { $line += ", listening on port $($ports -join ', ')" }
            $reason = Stop-ProcessHard -ProcessId $p.ProcessId
            if ($reason) { $line += "; $reason" }
            $detail.Add($line)
            Write-Log "Could not terminate $line" "ERROR"
        }

        $blocking = @($remaining | Where-Object { $_.Ours })
        $script:StopFailure = @{
            Blocking = $blocking
            All      = $remaining
            Detail   = $detail.ToArray()
        }

        if ($blocking.Count -gt 0) { return $false }

        # Nothing left that we can positively call ours. Whatever is holding a
        # port is somebody else's program, so Step 5 routes around it rather
        # than the installer refusing to run.
        Write-Log "Survivors could not be identified as ours - continuing; Step 5 will choose a free port" "WARNING"
        return $true
    }

    Write-Log "All service processes terminated; ports $ServicePortStart-$ServicePortEnd released"
    return $true
}

function Remove-AllServices {
    Write-Log "Removing all service registrations..."

    $names = New-Object System.Collections.Generic.List[string]
    foreach ($name in (@($ServiceName) + $LegacyServiceNames)) {
        if ((Get-Service -Name $name -ErrorAction SilentlyContinue) -and -not $names.Contains($name)) {
            $names.Add($name)
        }
    }
    $byDisplay = Get-Service -DisplayName $ServiceDisplayName -ErrorAction SilentlyContinue
    if ($byDisplay -and -not $names.Contains($byDisplay.Name)) { $names.Add($byDisplay.Name) }

    if ($names.Count -eq 0) {
        Write-Log "No service registrations present"
        return $true
    }

    foreach ($name in $names) {
        sc.exe delete $name 2>$null | Out-Null
        Write-Log "Requested deletion of service: $name"
    }

    <#
        "sc delete" only MARKS a service for deletion. The registration lives on
        until the last open handle to it closes, and a service in that state
        still answers Get-Service - so Step 6 concluded it was registered, and
        every attempt to re-create or start it failed with error 1072
        (ERROR_SERVICE_MARKED_FOR_DELETE). From the outside that is a Step 9
        that never finishes.

        Handles are held by services.msc, Task Manager's Services tab, and
        Event Viewer. Waiting is worth it because they are usually transient;
        when they are not, saying so beats registering on top of a corpse.
    #>
    $stubborn = @()
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        $stubborn = @($names | Where-Object { Get-Service -Name $_ -ErrorAction SilentlyContinue })
        if ($stubborn.Count -eq 0) { break }
        Start-Sleep -Seconds 1
    }

    if ($stubborn.Count -gt 0) {
        foreach ($name in $stubborn) {
            Write-Log "Service '$name' is still registered 30s after deletion - marked for deletion, something holds a handle to it" "ERROR"
        }
        return $false
    }

    Write-Log "All service registrations removed"
    return $true
}

function Remove-DaemonFolder {
    $daemonPath = "$InstallPath\daemon"
    if (-not (Test-Path $daemonPath)) { return $true }

    Write-Log "Removing daemon folder..."

    # Anything still alive in here was missed by Stop-AllServiceProcesses.
    Get-ChildItem $daemonPath -Filter "*.exe" -ErrorAction SilentlyContinue | ForEach-Object {
        $exePath = $_.FullName
        Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exePath } | ForEach-Object {
            taskkill /F /T /PID $_.Id 2>$null | Out-Null
        }
    }

    $retries = 5
    while ($retries -gt 0 -and (Test-Path $daemonPath)) {
        try {
            Remove-Item $daemonPath -Recurse -Force -ErrorAction Stop
            Write-Log "Daemon folder removed successfully"
            return $true
        }
        catch {
            $retries--
            if ($retries -gt 0) { Start-Sleep -Seconds 2 }
        }
    }

    <#
        MOVE IT ASIDE RATHER THAN GIVING UP.

        The old branch logged "will be cleaned on reboot" and carried on into a
        directory it had just failed to empty. That is how a dev box ended up
        still holding xpthermalservice.exe and its descriptor from 19-Mar-26
        after months of reinstalls: node-windows wrote the new daemon alongside
        the old one, and the sc.exe fallback at Step 6 then registered whichever
        descriptor it found.

        A rename succeeds where a delete fails, because Windows only blocks
        deleting a file with an open handle - not renaming its parent. The new
        install therefore always gets a clean, empty daemon directory.
    #>
    $parked = "$InstallPath\daemon.old-$(Get-Date -Format 'yyyyMMddHHmmss')"
    try {
        Move-Item $daemonPath $parked -Force -ErrorAction Stop
        Write-Log "Daemon folder was locked - moved aside to $parked" "WARNING"
        # Best effort; if it is still locked it goes on the reboot queue below.
        Remove-Item $parked -Recurse -Force -ErrorAction SilentlyContinue
        return $true
    }
    catch {
        Write-Log "Could not remove or rename the daemon folder: $_" "ERROR"
        return $false
    }
}

# Sweep up daemon directories parked by a previous run that could not delete
# them at the time. By now nothing holds them.
function Remove-ParkedDaemonFolders {
    Get-ChildItem $InstallPath -Directory -Filter "daemon.old-*" -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ============================================================
# PRE-FLIGHT CHECKS
# ============================================================

# ─── Free space detection ────────────────────────────────────────────
# Get-PSDrive's .Free is not dependable across machines: it is $null when the
# target letter isn't a loaded PSDrive, when ProgramData is redirected to a
# UNC path or a mount point without a letter, and under restricted language
# modes (AppLocker / WDAC). A $null compares as 0, which is how a machine with
# plenty of space ends up being told it has "0MB". Try each method in turn and
# return $null for "genuinely unknown" so the caller can distinguish that from
# "actually full".
function Get-FreeSpaceBytes {
    param([string]$Path)

    # The install folder may not exist yet - walk up to the nearest real parent.
    $probe = $Path
    while ($probe -and -not (Test-Path -LiteralPath $probe -ErrorAction SilentlyContinue)) {
        $parent = Split-Path -Parent $probe
        if (-not $parent -or $parent -eq $probe) { break }
        $probe = $parent
    }
    if (-not $probe) { $probe = $Path }

    $root = ""
    try { $root = [System.IO.Path]::GetPathRoot($probe) } catch { }
    $deviceId = ($root -replace '\\+$', '')

    # 1. .NET DriveInfo - independent of PowerShell's provider drive list.
    if ($root -and $root -notmatch '^\\\\') {
        try {
            $di = New-Object System.IO.DriveInfo $root
            if ($di.IsReady) {
                Write-Log "Disk: DriveInfo reports $($di.AvailableFreeSpace) bytes free on $root" "INFO"
                return [int64]$di.AvailableFreeSpace
            }
            Write-Log "Disk: DriveInfo says $root is not ready" "WARNING"
        }
        catch { Write-Log "Disk: DriveInfo failed on '$root': $_" "WARNING" }
    }

    # 2. CIM, then legacy WMI - covers redirected and mapped volumes.
    if ($deviceId -match '^[A-Za-z]:$') {
        foreach ($method in 'Cim', 'Wmi') {
            try {
                $ld = if ($method -eq 'Cim') {
                    Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$deviceId'" -ErrorAction Stop
                } else {
                    Get-WmiObject -Class Win32_LogicalDisk -Filter "DeviceID='$deviceId'" -ErrorAction Stop
                }
                if ($ld -and $null -ne $ld.FreeSpace) {
                    Write-Log "Disk: $method reports $($ld.FreeSpace) bytes free on $deviceId" "INFO"
                    return [int64]$ld.FreeSpace
                }
            }
            catch { Write-Log "Disk: $method query failed on '$deviceId': $_" "WARNING" }
        }
    }

    # 3. Get-PSDrive - the original method, kept as a last resort.
    if ($deviceId -match '^[A-Za-z]:$') {
        try {
            $free = (Get-PSDrive $deviceId.TrimEnd(':') -ErrorAction Stop).Free
            if ($null -ne $free) {
                Write-Log "Disk: Get-PSDrive reports $free bytes free on $deviceId" "INFO"
                return [int64]$free
            }
        }
        catch { Write-Log "Disk: Get-PSDrive failed on '$deviceId': $_" "WARNING" }
    }

    Write-Log "Disk: could not determine free space for '$Path' (root '$root') by any method" "WARNING"
    return $null
}

function Test-Prerequisites {
    $issues = @()

    Write-Log "Pre-flight: InstallPath='$InstallPath' PSVersion=$($PSVersionTable.PSVersion) LanguageMode=$($ExecutionContext.SessionState.LanguageMode) 64bit=$([Environment]::Is64BitProcess)" "INFO"
    
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
    
    # 3. Disk space check (need at least 200MB). An undeterminable volume is a
    #    warning, never a hard stop - blocking a healthy machine is far worse
    #    than letting a genuinely full one fail later with a real disk error.
    $requiredSpace = 200MB
    $freeSpace = Get-FreeSpaceBytes -Path $InstallPath
    if ($null -eq $freeSpace) {
        Write-WARN "Could not read free space for $InstallPath - continuing anyway"
    }
    elseif ($freeSpace -lt $requiredSpace) {
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

            <#
                D3 / LINK-01. ADD this site's real origins, do not only remove.

                Until now this function only ever REMOVED a wildcard. Nothing
                ever added the origin the site actually uses, and the shipped
                config.example.json does not contain it either:

                    allowedOrigins: localhost:3000, 127.0.0.1:3000,
                                    localhost:3001, 127.0.0.1:3001, vercel
                    allowPrivateNetwork: (unset)

                OriginPolicy trusts loopback on any port and this machine's own
                IP addresses without configuration, so 127.0.0.1, localhost and
                the LAN IP all work regardless. But the address every site
                actually uses is the desktop shortcut,
                http://pos.xenithpulse.local:<port>, and that is a NAME - not
                loopback, not one of this machine's addresses. It falls through
                to the configured list, is absent from it, and is refused.

                Measured against the real compiled OriginPolicy, 2026-08-16:

                  FRESH INSTALL   pos.xenithpulse.local:8090  -> DENY
                  THIS DEV BOX    pos.xenithpulse.local:8090  -> ALLOW
                                  ("Listed in allowedOrigins")

                The dev box passes only because its config.json is a preserved,
                hand-edited file - install.ps1 never overwrites an existing one.
                A genuinely fresh box cannot print from its own shortcut.

                DEEP-QA-PLAN.md records the opposite ("works by luck ... happen
                to be in the shipped list"). They are not in the shipped list.

                A port wildcard is used rather than a fixed port because
                provisioning moves the POS off 8080 when it is taken, and this
                installer cannot know what it settled on. The service binds
                127.0.0.1 only - verified - so nothing off this machine can
                reach the API to present any origin at all.
            #>
            $localName = 'pos.xenithpulse.local'   # matches LOCAL_NAME in the POS
            $required = @("http://$localName`:*", "https://$localName`:*")

            $origins = [System.Collections.ArrayList]@($config.security.allowedOrigins)
            $addedOrigin = $false
            foreach ($needed in $required) {
                if ($origins -notcontains $needed) {
                    [void]$origins.Add($needed)
                    $addedOrigin = $true
                }
            }
            if ($addedOrigin) {
                $config.security.allowedOrigins = $origins.ToArray()
                Write-Dot "Added this site's origin ($localName, any port)"
                Write-Log "Added $localName origins to allowedOrigins - the desktop shortcut could not print without them (D3/LINK-01)"
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
# WATCHDOG (SCHEDULED TASKS)
# ============================================================
#
# Two independent layers of ensurance keep the service alive across
# multi-day idle periods:
#
#   Layer A — XPThermalServiceWatchdog (every 2 min)
#     - HTTP-probes /health on the active port
#     - If service is Stopped OR HTTP probe fails for 2 consecutive runs,
#       performs a FULL restart (Stop-Service / kill daemon process / Start-Service).
#     - This catches the "process is running but HTTP server is hung" failure mode
#       that the old Status-only check missed.
#
#   Layer B — XPThermalServiceHeartbeat (every 10 min)
#     - Independent of Layer A. Verifies Layer A's task itself is still scheduled.
#     - Watches C:\ProgramData\XPThermalService\triggers\restart.trigger:
#         the POS app (E:\xp-pos\pos_modules\orders\printing-facility) or any
#         admin script can drop a file there to force a restart even when both
#         the HTTP API and Layer A are dead.
#     - Acts as a "watchdog of the watchdog".
#
# Both tasks: run as SYSTEM, persist on battery, restart on failure, never expire.
# ============================================================

# ─── Power management ───────────────────────────────────────────────
# Restaurant POS terminals must NEVER sleep — a sleeping PC means orders
# stop printing. We disable system sleep on AC power and add a power
# request override so Windows treats the print service as a "system-required"
# process that prevents idle sleep.
function Set-PowerManagement {
    try {
        # Disable sleep / hibernate / display blanking on AC (laptop POS terminals
        # often run unplugged temporarily during cleaning — leave battery defaults
        # untouched to avoid surprise battery drain).
        powercfg /change standby-timeout-ac 0      2>&1 | Out-Null
        powercfg /change hibernate-timeout-ac 0    2>&1 | Out-Null
        powercfg /change disk-timeout-ac 0         2>&1 | Out-Null
        powercfg /hibernate off                    2>&1 | Out-Null
        Write-OK "Sleep / hibernate disabled (AC power)"
        Write-Log "Power: standby/hibernate/disk timeouts disabled on AC" "SUCCESS"
    } catch {
        Write-WARN "Could not adjust power plan: $_"
    }

    # Ensure the service is allowed to prevent system sleep
    try {
        powercfg /requestsoverride PROCESS "$ServiceName" SYSTEM DISPLAY AWAYMODE 2>&1 | Out-Null
        powercfg /requestsoverride PROCESS "node.exe"     SYSTEM 2>&1 | Out-Null
        Write-OK "Power request override granted"
        Write-Log "Power request override granted to $ServiceName + node.exe" "SUCCESS"
    } catch {
        Write-Log "Could not set power request override (non-fatal): $_" "WARNING"
    }

    # ── The Print Spooler: needed, NOT depended on ──────────────────────────
    #
    # This used to be `sc config <svc> depend= Spooler`, to stop the service
    # coming up before the spooler on a fast machine, finding no printers and
    # reporting everything offline until the next health check.
    #
    # It was the wrong trade and it caused a real outage. A Windows service
    # dependency does two things, and only the first was wanted:
    #
    #   start order    the dependency starts first.        <- what we wanted
    #   stop cascade   when the dependency is stopped
    #                  DELIBERATELY, Windows stops every
    #                  dependent with it - and never
    #                  starts them again afterwards.       <- the outage
    #
    # The spooler is stopped deliberately more often than anything else on a
    # Windows box: installing a printer driver does it, Windows Update does it,
    # and "restart the print spooler" is the first thing anyone tries when a
    # queue jams. Every one of those left this service Stopped, with nothing in
    # any log that mentions printing, and staff finding out when a receipt did
    # not come out.
    #
    # The start-order problem it was solving no longer exists: the device
    # watcher (src/printers/device-watcher.ts) subscribes to WMI device and
    # printer events, so a printer that becomes visible after startup is picked
    # up in under a second, and the watcher already recovers from a spooler
    # crash. Nothing needs the spooler to exist at the moment this service boots.
    #
    # What IS worth doing is making sure the spooler itself comes back.
    try {
        $spoolerCfg = Get-CimInstance Win32_Service -Filter "Name='Spooler'" -ErrorAction SilentlyContinue
        if ($spoolerCfg -and $spoolerCfg.StartMode -ne 'Auto') {
            sc.exe config Spooler start= auto 2>&1 | Out-Null
        }
        # Windows gives the spooler two restarts inside a one-hour window and
        # nothing after that. Three, over a day, for the service this one prints
        # through.
        sc.exe failure Spooler reset= 86400 actions= restart/5000/restart/10000/restart/30000 2>&1 | Out-Null
        $spooler = Get-Service -Name Spooler -ErrorAction SilentlyContinue
        if ($spooler -and $spooler.Status -ne 'Running') {
            Start-Service -Name Spooler -ErrorAction SilentlyContinue
        }

        # Remove the dependency if an older install of this service set one. A
        # single forward slash is how sc.exe clears a dependency list; an empty
        # string never reaches it.
        sc.exe config $ServiceName depend= / 2>&1 | Out-Null

        Write-OK "Print Spooler set to auto-restart (no hard dependency)"
        Write-Log "Spooler recovery configured; hard dependency removed" "SUCCESS"
    } catch {
        Write-Log "Could not configure the Print Spooler (non-fatal): $_" "WARNING"
    }
}

# ─── Icon assets, shortcuts, Add/Remove Programs entry ──────────────
function Install-IconAndShortcuts {
    param([int]$Port = 9100)
    $sourceDir = Split-Path -Parent $PSScriptRoot
    $icoSource = Join-Path $sourceDir "public\assets\icon.ico"
    $pngSource = Join-Path $sourceDir "public\assets\icon.png"
    $pngDest   = "$InstallPath\icon.png"
    $icoDest   = "$InstallPath\icon.ico"

    # 1. Copy native .ico (used for Add/Remove Programs, shortcuts, service icon)
    if (Test-Path $icoSource) {
        Copy-Item $icoSource $icoDest -Force -ErrorAction SilentlyContinue
        Write-Dot "Brand icon (.ico) copied"
        Write-Log "Icon copied from $icoSource to $icoDest"
    } else {
        Write-Log "icon.ico not found at $icoSource — skipping icon setup" "WARNING"
        return
    }

    # 2. Copy PNG too (dashboard / web UI uses the PNG)
    if (Test-Path $pngSource) {
        Copy-Item $pngSource $pngDest -Force -ErrorAction SilentlyContinue
        Write-Dot "Brand icon (.png) copied"
    }

    # 3. Resolve active port for shortcut URL — caller passes in the
    #    port discovered during installation; fall back to active_port.txt.
    $resolvedPort = $Port
    $portFile = "$InstallPath\active_port.txt"
    if ((-not $resolvedPort -or $resolvedPort -le 0) -and (Test-Path $portFile)) {
        try { $resolvedPort = [int](Get-Content $portFile -Raw).Trim() } catch { $resolvedPort = 9100 }
    }
    if (-not $resolvedPort -or $resolvedPort -le 0) { $resolvedPort = 9100 }
    $dashboardUrl = "http://127.0.0.1:$resolvedPort/dashboard"

    # 4. Internet shortcut (.url) — picks up custom icon natively, opens in
    #    default browser, works for both Start Menu and Desktop.
    $urlContent = @"
[InternetShortcut]
URL=$dashboardUrl
IconFile=$icoDest
IconIndex=0
"@

    # Start Menu — visible to all users (machine-wide POS install)
    $startMenuDir = "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\XP Thermal Service"
    try {
        if (-not (Test-Path $startMenuDir)) {
            New-Item -ItemType Directory -Path $startMenuDir -Force -ErrorAction Stop | Out-Null
        }
        Set-Content -Path "$startMenuDir\XP Thermal Dashboard.url" -Value $urlContent -Encoding ASCII -Force
        Write-OK "Start Menu shortcut created"
    } catch {
        Write-Log "Start Menu shortcut failed: $_" "WARNING"
    }

    # Public Desktop — visible to all users
    $publicDesktop = "$env:PUBLIC\Desktop"
    if (Test-Path $publicDesktop) {
        try {
            Set-Content -Path "$publicDesktop\XP Thermal Dashboard.url" -Value $urlContent -Encoding ASCII -Force
            Write-OK "Desktop shortcut created"
        } catch {
            Write-Log "Desktop shortcut failed: $_" "WARNING"
        }
    }

    # 5. Add/Remove Programs entry (uses the icon for the Apps list)
    $uninstallKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\XPThermalService"
    try {
        if (-not (Test-Path $uninstallKey)) {
            New-Item -Path $uninstallKey -Force | Out-Null
        }
        $uninstallCmd = "powershell.exe -ExecutionPolicy Bypass -NoProfile -File `"$InstallPath\install.ps1`" -Uninstall -Silent"
        $props = @{
            DisplayName     = $ServiceDisplayName
            DisplayIcon     = $icoDest
            DisplayVersion  = "2.2"
            Publisher       = "XenithPulse"
            URLInfoAbout    = "https://xenithpulse.com"
            InstallLocation = $InstallPath
            UninstallString = $uninstallCmd
            NoModify        = 1
            NoRepair        = 1
        }
        foreach ($k in $props.Keys) {
            $type = if ($props[$k] -is [int]) { 'DWord' } else { 'String' }
            New-ItemProperty -Path $uninstallKey -Name $k -Value $props[$k] -PropertyType $type -Force | Out-Null
        }
        Write-OK "Add/Remove Programs entry registered"
        Write-Log "Add/Remove Programs entry registered with icon" "SUCCESS"
    } catch {
        Write-Log "Add/Remove Programs registration failed: $_" "WARNING"
    }

    # 6. Service description in registry — DescriptionString w/ icon hint
    try {
        $svcKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
        if (Test-Path $svcKey) {
            New-ItemProperty -Path $svcKey -Name "ImagePathIcon" -Value $icoDest -PropertyType String -Force -ErrorAction SilentlyContinue | Out-Null
        }
    } catch {}

    # 7. Copy installer for self-uninstall reference
    $installerSrc = Join-Path $sourceDir "scripts\install.ps1"
    if (Test-Path $installerSrc) {
        Copy-Item $installerSrc "$InstallPath\install.ps1" -Force -ErrorAction SilentlyContinue
    }
}

function Remove-IconAndShortcuts {
    # Start Menu folder
    Remove-Item "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\XP Thermal Service" -Recurse -Force -ErrorAction SilentlyContinue

    # Desktop shortcut
    Remove-Item "$env:PUBLIC\Desktop\XP Thermal Dashboard.url" -Force -ErrorAction SilentlyContinue

    # Add/Remove Programs entry
    Remove-Item "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\XPThermalService" -Recurse -Force -ErrorAction SilentlyContinue

    # Power request override
    try {
        powercfg /requestsoverride PROCESS "$ServiceName"  2>&1 | Out-Null
        powercfg /requestsoverride PROCESS "node.exe"      2>&1 | Out-Null
    } catch {}

    Write-Log "Icon, shortcuts, ARP entry removed"
}

function Install-Watchdog {
    # Remove existing tasks
    schtasks /Delete /TN $WatchdogTaskName /F 2>$null | Out-Null
    schtasks /Delete /TN $HeartbeatTaskName /F 2>$null | Out-Null

    # Ensure trigger folder exists (POS app drops restart.trigger here)
    $triggerDir = "$InstallPath\triggers"
    if (-not (Test-Path $triggerDir)) {
        New-Item -ItemType Directory -Path $triggerDir -Force | Out-Null
    }

    # State file for tracking consecutive HTTP failures (Layer A)
    $stateFile = "$InstallPath\data\watchdog-state.json"

    # ── Layer A: HTTP-probing watchdog ──────────────────────────────────
    $watchdogScript = @'
# XP Thermal Service Watchdog — Layer A (HTTP probe)
$serviceName  = "xpthermalprintservice.exe"
$displayName  = "XP Thermal Print Service"
$installPath  = "$env:ProgramData\XPThermalService"
$logFile      = "$installPath\logs\watchdog.log"
$stateFile    = "$installPath\data\watchdog-state.json"
$portFile     = "$installPath\active_port.txt"
$portRangeStart = 9100
$portRangeEnd   = 9110
$maxFailuresBeforeRestart = 2

function Write-WatchdogLog($msg) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$timestamp [A] $msg" | Out-File -Append $logFile -ErrorAction SilentlyContinue
}

function Get-ActivePort {
    if (Test-Path $portFile) {
        try { return [int](Get-Content $portFile -Raw -ErrorAction Stop).Trim() } catch {}
    }
    return $portRangeStart
}

function Test-HealthEndpoint {
    param([int]$Port)
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 8 -UseBasicParsing -ErrorAction Stop
        return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500)
    } catch {
        # Non-2xx HTTP responses still mean the server is alive
        if ($_.Exception.Response -and ($_.Exception.Response.StatusCode.value__ -lt 500)) {
            return $true
        }
        return $false
    }
}

function Find-LiveHealthPort {
    for ($p = $portRangeStart; $p -le $portRangeEnd; $p++) {
        if (Test-HealthEndpoint -Port $p) { return $p }
    }
    return $null
}

# A lock file left behind by a process that was killed rather than stopped.
#
# The service refuses to run a second copy of itself, and the lock names the
# owning process ID. Windows reuses process IDs, so after a reboot that ID may
# belong to something unrelated - and the service then stands down a few
# seconds after every start, forever, including after a reinstall, because the
# lock lives in the data directory the installer preserves.
#
# The service itself now expires an abandoned lock (see utils/instance-lock),
# but this watchdog also clears one outright: it is the fastest responder on
# the box, and it fixes terminals still running an older build.
function Clear-StaleLock {
    $lockPath = "$installPath\data\service.lock"
    if (-not (Test-Path $lockPath)) { return }
    try {
        $lock = Get-Content $lockPath -Raw -ErrorAction Stop | ConvertFrom-Json
    } catch {
        Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
        Write-WatchdogLog "Removed an unreadable lock file"
        return
    }

    $stale = $false
    $why   = ""
    # Compare in UTC explicitly on both sides. The lock carries an ISO-8601 UTC
    # timestamp; a bare [datetime] cast reads it through the current culture and
    # may return local or UTC, and comparing the two by ticks would mark a
    # healthy lock stale and stop a working till from printing.
    try {
        $bootUtc = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime()
        if ($lock.startedAt) {
            $styles = [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal
            $startedUtc = [datetime]::Parse($lock.startedAt, [System.Globalization.CultureInfo]::InvariantCulture, $styles)
            if ($startedUtc -lt $bootUtc) { $stale = $true; $why = "written before the last boot" }
        }
    } catch {}

    if (-not $stale -and $lock.pid) {
        $holder = Get-Process -Id $lock.pid -ErrorAction SilentlyContinue
        if (-not $holder) {
            $stale = $true; $why = "process $($lock.pid) no longer exists"
        } elseif ($holder.ProcessName -notmatch 'node') {
            $stale = $true; $why = "process $($lock.pid) is '$($holder.ProcessName)', a reused process ID"
        }
    }

    if ($stale) {
        Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
        Write-WatchdogLog "Cleared a stale instance lock ($why) - this is what stops the service starting after a hard reset"
    }
}

function Get-FailureCount {
    if (Test-Path $stateFile) {
        try {
            $s = Get-Content $stateFile -Raw -ErrorAction Stop | ConvertFrom-Json
            return [int]$s.failures
        } catch {}
    }
    return 0
}

function Set-FailureCount {
    param([int]$Count)
    try {
        @{ failures = $Count; updated = (Get-Date).ToString("o") } | ConvertTo-Json | Set-Content $stateFile -Encoding UTF8 -ErrorAction Stop
    } catch {}
}

function Invoke-FullRestart {
    param([string]$Reason)
    Write-WatchdogLog "FULL RESTART: $Reason"

    # Stop the Windows service first (graceful)
    try {
        Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    } catch {
        sc.exe stop $serviceName 2>&1 | Out-Null
    }
    Start-Sleep -Seconds 3

    # Kill orphaned daemon and node child processes (in case stop didn't clean up)
    foreach ($exe in @("xpthermalprintservice.exe", "xpthermalservice.exe")) {
        taskkill /F /IM $exe 2>$null | Out-Null
    }
    try {
        Get-NetTCPConnection -LocalPort ($portRangeStart..$portRangeEnd) -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
            $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
            if ($proc -and $proc.Name -eq "node") {
                Write-WatchdogLog "Killing stuck node.exe on port $($_.LocalPort) (PID $($_.OwningProcess))"
                taskkill /F /PID $_.OwningProcess 2>$null | Out-Null
            }
        }
    } catch {}

    Start-Sleep -Seconds 2

    # The process we just killed cannot have released its own lock.
    Clear-StaleLock

    # Start the service again
    try {
        Start-Service -Name $serviceName -ErrorAction Stop
        Write-WatchdogLog "Service restart issued"
    } catch {
        sc.exe start $serviceName 2>&1 | Out-Null
        Write-WatchdogLog "Service restart issued via sc.exe"
    }
    Set-FailureCount 0
}

# ── Main ────────────────────────────────────────────────────────────
$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (-not $svc) {
    $svc = Get-Service -DisplayName $displayName -ErrorAction SilentlyContinue
}
if (-not $svc) {
    Write-WatchdogLog "Service not registered — skipping (re-run installer)"
    return
}

# 1. If service is not Running, start it immediately.
#    Clear an abandoned lock FIRST: without that, a start on a box that was
#    reset hard succeeds as far as Windows is concerned and the service exits
#    four seconds later, every two minutes, indefinitely.
if ($svc.Status -ne 'Running') {
    Write-WatchdogLog "Service status=$($svc.Status) — starting"
    Clear-StaleLock
    try { Start-Service -Name $svc.Name -ErrorAction Stop } catch {
        $out = (sc.exe start $svc.Name 2>&1 | Out-String)
        if ($out -match 'FAILED\s+(\d+)') {
            Write-WatchdogLog "Start failed with error $($Matches[1]). See the Windows event log and run collect-diagnostics.ps1."
        }
    }
    Set-FailureCount 0
    return
}

# 2. Service claims Running — verify HTTP responds
$port = Get-ActivePort
$alive = Test-HealthEndpoint -Port $port
if (-not $alive) {
    # Try other ports in the range (active_port.txt may be stale)
    $livePort = Find-LiveHealthPort
    if ($livePort) {
        Set-Content -Path $portFile -Value $livePort -ErrorAction SilentlyContinue
        $alive = $true
    }
}

if ($alive) {
    Set-FailureCount 0
    return
}

# 3. HTTP probe failed — increment counter; restart on threshold
$failures = (Get-FailureCount) + 1
Write-WatchdogLog "HTTP probe FAILED (port $port). Consecutive failures: $failures/$maxFailuresBeforeRestart"
Set-FailureCount $failures

if ($failures -ge $maxFailuresBeforeRestart) {
    Invoke-FullRestart -Reason "HTTP probe failed $failures times consecutively"
}

# Trim log to last 1000 lines
if (Test-Path $logFile) {
    try {
        $lines = Get-Content $logFile -Tail 1000 -ErrorAction SilentlyContinue
        if ($lines) { $lines | Set-Content $logFile -ErrorAction SilentlyContinue }
    } catch {}
}
'@

    $watchdogPath = "$InstallPath\watchdog.ps1"
    Set-Content -Path $watchdogPath -Value $watchdogScript -Force -Encoding UTF8

    # ── Layer B: Heartbeat (trigger-file watcher + watchdog-of-watchdog) ─
    $heartbeatScript = @"
# XP Thermal Service Heartbeat — Layer B (independent fallback)
`$serviceName     = "xpthermalprintservice.exe"
`$installPath     = "`$env:ProgramData\XPThermalService"
`$logFile         = "`$installPath\logs\heartbeat.log"
`$triggerFile     = "`$installPath\triggers\restart.trigger"
`$watchdogPath    = "`$installPath\watchdog.ps1"
`$watchdogTask    = "$WatchdogTaskName"

function Write-HbLog(`$msg) {
    `$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "`$timestamp [B] `$msg" | Out-File -Append `$logFile -ErrorAction SilentlyContinue
}

# 1. Trigger-file bridge — POS app or admin can drop a file here to force restart
if (Test-Path `$triggerFile) {
    `$payload = ""
    try { `$payload = (Get-Content `$triggerFile -Raw -ErrorAction Stop).Trim() } catch {}
    Write-HbLog "Trigger file detected (payload='`$payload') — restarting service"
    Remove-Item `$triggerFile -Force -ErrorAction SilentlyContinue
    try {
        Stop-Service -Name `$serviceName -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        foreach (`$exe in @('xpthermalprintservice.exe', 'xpthermalservice.exe')) {
            taskkill /F /IM `$exe 2>`$null | Out-Null
        }
        Start-Sleep -Seconds 2
        Start-Service -Name `$serviceName -ErrorAction Stop
        Write-HbLog "Service restarted via trigger file"
    } catch {
        sc.exe start `$serviceName 2>&1 | Out-Null
        Write-HbLog "Service start fallback via sc.exe: `$_"
    }
}

# 2. Watchdog-of-watchdog: ensure Layer A scheduled task still exists & is enabled
try {
    `$task = Get-ScheduledTask -TaskName `$watchdogTask -ErrorAction Stop
    if (`$task.State -eq 'Disabled') {
        Write-HbLog "Layer A task is Disabled — re-enabling"
        Enable-ScheduledTask -TaskName `$watchdogTask -ErrorAction SilentlyContinue | Out-Null
    }
} catch {
    Write-HbLog "Layer A watchdog task missing — re-creating"
    if (Test-Path `$watchdogPath) {
        try {
            schtasks /Create /TN `$watchdogTask ``
                /TR "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File ```"`$watchdogPath```"" ``
                /SC MINUTE /MO 2 /RU SYSTEM /F 2>`$null | Out-Null
        } catch {}
    }
}

# 3. Service sanity — if service is Stopped for any reason, try to start it
`$svc = Get-Service -Name `$serviceName -ErrorAction SilentlyContinue
if (`$svc -and `$svc.Status -ne 'Running') {
    Write-HbLog "Service status=`$(`$svc.Status) — starting"
    try { Start-Service -Name `$svc.Name -ErrorAction Stop } catch { sc.exe start `$svc.Name 2>&1 | Out-Null }
}

# Trim log
if (Test-Path `$logFile) {
    try {
        `$lines = Get-Content `$logFile -Tail 500 -ErrorAction SilentlyContinue
        if (`$lines) { `$lines | Set-Content `$logFile -ErrorAction SilentlyContinue }
    } catch {}
}
"@

    $heartbeatPath = "$InstallPath\heartbeat.ps1"
    Set-Content -Path $heartbeatPath -Value $heartbeatScript -Force -Encoding UTF8

    # ── Register Layer A scheduled task (every 2 minutes) ────────────────
    try {
        $actionA   = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogPath`""
        $triggerA  = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 9999)
        $principalA = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
        $settingsA  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
        Register-ScheduledTask -TaskName $WatchdogTaskName -Action $actionA -Trigger $triggerA -Principal $principalA -Settings $settingsA -Force | Out-Null
        Write-OK "Layer A watchdog scheduled (every 2 min, HTTP probe)"
        Write-Log "Layer A watchdog scheduled task installed" "SUCCESS"
    }
    catch {
        schtasks /Create /TN $WatchdogTaskName /TR "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogPath`"" /SC MINUTE /MO 2 /RU SYSTEM /F 2>$null | Out-Null
        Write-OK "Layer A watchdog scheduled (schtasks fallback)"
        Write-Log "Layer A watchdog scheduled task installed (schtasks)"
    }

    # ── Register Layer B heartbeat task (every 10 minutes) ───────────────
    try {
        $actionB   = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$heartbeatPath`""
        $triggerB  = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 9999)
        $principalB = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
        $settingsB  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
        Register-ScheduledTask -TaskName $HeartbeatTaskName -Action $actionB -Trigger $triggerB -Principal $principalB -Settings $settingsB -Force | Out-Null
        Write-OK "Layer B heartbeat scheduled (every 10 min, trigger-file watcher)"
        Write-Log "Layer B heartbeat scheduled task installed" "SUCCESS"
    }
    catch {
        schtasks /Create /TN $HeartbeatTaskName /TR "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$heartbeatPath`"" /SC MINUTE /MO 10 /RU SYSTEM /F 2>$null | Out-Null
        Write-OK "Layer B heartbeat scheduled (schtasks fallback)"
        Write-Log "Layer B heartbeat scheduled task installed (schtasks)"
    }
}

function Remove-Watchdog {
    schtasks /Delete /TN $WatchdogTaskName /F 2>$null | Out-Null
    schtasks /Delete /TN $HeartbeatTaskName /F 2>$null | Out-Null
    Remove-Item "$InstallPath\watchdog.ps1"  -Force -ErrorAction SilentlyContinue
    Remove-Item "$InstallPath\heartbeat.ps1" -Force -ErrorAction SilentlyContinue
    Write-Log "Watchdog and heartbeat removed"
}

# ============================================================
# UPDATE DETECTION AND FAILURE DIAGNOSIS
# ============================================================

# What is already on this machine?
#
# An install over an existing one is an UPDATE, and it has to say so: the
# operator needs to know their printers and job history are being kept, and the
# installer needs to know it is replacing something rather than landing on a
# clean box.
function Get-ExistingInstall {
    $info = [ordered]@{ Present = $false; Version = $null; ServiceStatus = $null; Description = "" }

    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) { $svc = Get-Service -DisplayName $ServiceDisplayName -ErrorAction SilentlyContinue }
    $hasFiles = Test-Path "$InstallPath\index.js"

    if (-not $svc -and -not $hasFiles) { return $info }

    $info.Present = $true
    if ($svc) { $info.ServiceStatus = $svc.Status.ToString() }

    $stamp = "$InstallPath\installed-version.json"
    if (Test-Path $stamp) {
        try { $info.Version = (Get-Content $stamp -Raw -ErrorAction Stop | ConvertFrom-Json).version } catch { }
    }
    if (-not $info.Version -and (Test-Path "$InstallPath\package.json")) {
        try { $info.Version = (Get-Content "$InstallPath\package.json" -Raw -ErrorAction Stop | ConvertFrom-Json).version } catch { }
    }

    $parts = @()
    if ($info.Version) { $parts += "v$($info.Version)" } else { $parts += "an earlier build" }
    if ($info.ServiceStatus) { $parts += "service $($info.ServiceStatus.ToLower())" }
    $info.Description = $parts -join ", "

    return $info
}

function Get-SourceVersion {
    param([string]$SourceDir)
    if (-not $SourceDir) { return $null }
    $pkg = Join-Path $SourceDir "package.json"
    if (-not (Test-Path $pkg)) { return $null }
    try { return (Get-Content $pkg -Raw -ErrorAction Stop | ConvertFrom-Json).version } catch { return $null }
}

# Stamped at the end of a successful install so the NEXT one can name what it
# is replacing. package.json alone is not enough: it is copied at Step 4, so by
# the time an install fails it already reports the new version.
function Set-InstalledVersion {
    param([string]$Version)
    if (-not $Version) { return }
    try {
        [ordered]@{ version = $Version; installedAt = (Get-Date).ToString('o') } |
            ConvertTo-Json | Set-Content "$InstallPath\installed-version.json" -Encoding UTF8 -ErrorAction Stop
    }
    catch { }
}

# ---- Reading the reason out of the daemon's own log ---------------------
#
# "Step 9 failed" is not a diagnosis, and the reason has always been sitting in
# daemon\xpthermalprintservice.err.log where nobody looks. Mark the file length
# before this install's first start attempt and read only what follows, so an
# error from five months ago cannot be reported as today's cause.

function Get-DaemonLogStem {
    return "$InstallPath\daemon\$([System.IO.Path]::GetFileNameWithoutExtension($ServiceName))"
}

function Set-DaemonLogMark {
    $mark = @{}
    foreach ($suffix in @('err', 'out')) {
        $log = "$(Get-DaemonLogStem).$suffix.log"
        $mark[$suffix] = if (Test-Path $log) { (Get-Item $log).Length } else { [long]0 }
    }
    $script:DaemonLogMark = $mark
}

# Read from a byte offset with FileShare::ReadWrite - winsw holds these files
# open while the service runs, so Get-Content would fail outright.
function Read-TextFromOffset {
    param([string]$Path, [long]$Offset)

    if (-not (Test-Path $Path)) { return "" }
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            if ($Offset -eq $fs.Length) {
                # Nothing has been written since the mark. This is the common
                # case and it MUST return empty: reading the file from the top
                # here is how a five-month-old EADDRINUSE gets reported as the
                # reason today's install failed.
                return ""
            }
            if ($Offset -gt 0 -and $Offset -lt $fs.Length) {
                $fs.Position = $Offset
            }
            # $Offset greater than the length means winsw rotated the log, so
            # the whole of what is there now is new: read from the start.
            $sr = New-Object System.IO.StreamReader($fs)
            return $sr.ReadToEnd()
        }
        finally { $fs.Dispose() }
    }
    catch { return "" }
}

function Get-DaemonFailureReason {
    $offset = [long]0
    if ($script:DaemonLogMark -and $script:DaemonLogMark['err']) { $offset = [long]$script:DaemonLogMark['err'] }
    $text = Read-TextFromOffset -Path "$(Get-DaemonLogStem).err.log" -Offset $offset
    if (-not $text -or -not $text.Trim()) { return $null }

    # These two account for essentially every "stuck on Step 9" report, and
    # both are caused by a previous install that was not fully removed.
    if ($text -match 'EADDRINUSE[\s\S]{0,400}?port:\s*(\d+)' -or $text -match 'EADDRINUSE[^\r\n]*?:(\d{4})') {
        $port = $Matches[1]
        $holders = @(Get-PortHolderPids)
        $who = ""
        if ($holders.Count -gt 0) {
            $names = $holders | ForEach-Object {
                $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
                if ($p) { "$($p.Name) (PID $_)" } else { "PID $_" }
            }
            $who = " Still held by $($names -join ', ')."
        }
        return @{
            Summary = "Port $port is already in use.$who"
            Hints   = @(
                "Another copy of this service never exited. Reboot this machine and",
                "run the installer again - it now stops the whole process tree first."
            )
        }
    }

    if ($text -match 'Another XP Thermal Service is already running \(process (\d+)') {
        return @{
            Summary = "A previous instance (PID $($Matches[1])) still owns the instance lock."
            Hints   = @(
                "Delete $InstallPath\data\service.lock and run the installer again,",
                "or reboot. The lock also expires on its own after 90 seconds."
            )
        }
    }

    # Anything else: hand back the last real line rather than guessing at it.
    $lastLine = ($text -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
    if ($lastLine) {
        return @{ Summary = $lastLine.Trim(); Hints = @("Full output: $(Get-DaemonLogStem).err.log") }
    }
    return $null
}

# ============================================================
# SERVICE INSTALLATION
# ============================================================

# The install disables the watchdog scheduled tasks at Step 2 and relies on
# Step 8 to re-register them. Every early return in between - a failed
# pre-flight, a service that will not stop, a service that will not start -
# would otherwise leave the machine with no watchdog at all, which is a worse
# place than it started from.
function Install-Service {
    try {
        return Invoke-ServiceInstall
    }
    finally {
        Resume-Watchdog
    }
}

function Invoke-ServiceInstall {
    Write-Banner
    
    # â”€â”€ Step 1: Pre-flight â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    Write-StepHeader "Pre-flight checks" 1
    
    if (-not (Test-Prerequisites)) {
        Write-FailBox "Pre-flight checks failed"
        return $false
    }
    
    Write-StepComplete
    
    # â”€â”€ Step 2: Cleanup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    $existing = Get-ExistingInstall
    $newVersion = Get-SourceVersion -SourceDir (Split-Path -Parent $PSScriptRoot)

    if ($existing.Present) {
        Write-StepHeader "Updating existing installation" 2
        $to = if ($newVersion) { " to v$newVersion" } else { "" }
        Write-Dot "Found $($existing.Description) - updating$to"
        Write-Dot "Config, printers and job history are kept"
        Write-Log "Existing installation detected ($($existing.Description)); updating$to"
    }
    else {
        Write-StepHeader "Cleaning previous installation" 2
    }

    # FIRST, before anything else touches the service.
    #
    # The watchdog restarts the service we are about to replace, on a two-minute
    # timer, for the entire length of the install. See Suspend-Watchdog.
    Suspend-Watchdog
    Write-Dot "Watchdog paused for the duration"

    if (Stop-AllServiceProcesses) {
        Write-Dot "Stopped service processes"

        # Survived, but not ours - say so rather than staying silent about a
        # process we tried to kill and could not.
        if ($script:StopFailure) {
            Write-WARN "Another program is using a port in the $ServicePortStart-$ServicePortEnd range"
            foreach ($line in $script:StopFailure.Detail) { Write-Dot $line }
            Write-Dot "It could not be identified as ours, so it has been left alone."
            Write-Dot "Step 5 will choose a free port instead."
        }
    }
    else {
        # Deploying over a live install is how the old files get half-replaced
        # and the new service ends up fighting the old one for port 9100. Stop
        # here instead: an install that refuses is recoverable, one that lands
        # on top of a running service is not.
        Write-FAIL "A previous XP Thermal Service is still running and will not stop"
        foreach ($line in $script:StopFailure.Detail) { Write-Dot $line }
        Write-Dot "That process holds the port and the instance lock, so a new copy"
        Write-Dot "would refuse to start even if this install finished."
        Write-Dot "Reboot this machine and run the installer again."
        Write-Log "Aborting: could not stop the previous installation" "ERROR"
        Write-FailBox "A previous service process will not stop. Reboot and re-run."
        return $false
    }

    if (Remove-AllServices) {
        Write-Dot "Removed service registrations"
    }
    else {
        Write-WARN "Windows still has the old service marked for deletion"
        Write-Dot "Close services.msc and Task Manager's Services tab, then re-run -"
        Write-Dot "registration will fail with error 1072 until that handle is gone."
    }

    # Safe now: nothing of ours is running, so the lock cannot have a live owner.
    Clear-InstanceLock
    Write-Dot "Instance lock cleared"

    $null = Remove-DaemonFolder
    Remove-ParkedDaemonFolders
    Write-Dot "Cleaned daemon folder"

    Start-Sleep -Seconds 2

    Write-StepComplete
    
    # â”€â”€ Step 3: Prepare directories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    Write-StepHeader "Preparing installation directory" 3
    
    if (-not (Test-Path $InstallPath)) {
        New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
    }
    
    Backup-Config
    
    @("$InstallPath\data", "$InstallPath\logs", "$InstallPath\backups", "$InstallPath\triggers") | ForEach-Object {
        if (-not (Test-Path $_)) {
            New-Item -ItemType Directory -Path $_ -Force | Out-Null
        }
    }
    Write-OK "Directories ready"
    
    Write-StepComplete
    
    # â”€â”€ Step 4: Copy files â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    Write-StepHeader "Copying service files" 4
    
    $sourceDir = Split-Path -Parent $PSScriptRoot
    
    <#
        NOT "dist\*" wholesale - the daemon folder must never be copied.

        node-windows writes the daemon next to the script it wraps, so any dev
        box that has ever run the service from source grows a dist\daemon
        folder: winsw, its descriptor, and its logs. Copying that in RESTORES
        the daemon folder Step 2 has just deleted, which is why it never looked
        cleaned no matter what Step 2 did.

        Measured in this repo, 2026-08-29. dist\daemon held a descriptor dated
        19-Mar pointing at

            E:\xp-thermal-service\dist\index.js     --maxrestarts 3

        - a path that exists on one developer's machine and on no till
        anywhere. Step 6's fallback registers whatever descriptor is already on
        disk, so on a client box that is a service whose wrapper spawns node
        against a file that is not there, gives up after three tries, and never
        answers the health check. It presents as an installer that stops at
        Step 9, on a machine that has never had the service installed.

        The daemon belongs to the target machine and is generated there.
    #>
    Invoke-WithRetry -Operation "Copy dist files" -ScriptBlock {
        Get-ChildItem "$sourceDir\dist" -Force -ErrorAction Stop |
            Where-Object { $_.Name -ne 'daemon' } |
            ForEach-Object { Copy-Item $_.FullName "$InstallPath\" -Recurse -Force -ErrorAction Stop }
    }
    Write-Dot "Application code copied"

    # Belt and braces: nothing else should be able to put a daemon folder here
    # between Step 2 and Step 6, but a stale one is expensive enough to assert
    # rather than assume.
    if (Test-Path "$InstallPath\daemon") {
        Write-Log "A daemon folder reappeared after the file copy - removing it again" "WARNING"
        $null = Remove-DaemonFolder
    }
    
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

    # Copy POS-side restart trigger helper to InstallPath for easy reference
    if (Test-Path "$sourceDir\scripts\trigger-restart.ps1") {
        Copy-Item "$sourceDir\scripts\trigger-restart.ps1" "$InstallPath\trigger-restart.ps1" -Force -ErrorAction SilentlyContinue
        Write-Dot "Restart-trigger helper copied"
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

    # Write active port early so external tools (and our own shortcut creator)
    # can resolve the dashboard URL even before the service finishes booting.
    try {
        Set-Content -Path "$InstallPath\active_port.txt" -Value $availablePort -Encoding ASCII -ErrorAction Stop
    } catch {}

    Write-OK "Configuration ready"
    
    Write-StepComplete
    
    # â”€â”€ Step 6: Register Windows service â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    Write-StepHeader "Registering Windows service" 6

    # Everything the daemon logs from here belongs to THIS install.
    Set-DaemonLogMark

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
    // A till must come back no matter how many times it has failed today.
    // node-windows counts restarts in a rolling 60-second window and then stops
    // respawning permanently. At the old value of 10, a service crash-looping
    // on something fixable - a stale lock, a busy port - burned through the
    // budget in under a minute and then stayed down until a human noticed,
    // which is indistinguishable from "the service will not start". Windows'
    // own recovery is the backstop, but it only fires when the WRAPPER dies,
    // not when the wrapper is alive and has given up on its child.
    maxRestarts: 100,
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
        
        # NOT "node -e": the comment block above contains double quotes, and
        # PowerShell 5.1 truncates a native argument at the first one. See
        # Invoke-NodeScript.
        $result = Invoke-NodeScript -Script $nodeScript -Name 'xp-thermal-register'
        $resultStr = $result -join "`n"
        
        if ($resultStr -match "SERVICE_INSTALLED|SERVICE_STARTED|SERVICE_ALREADY_INSTALLED") {
            Write-Dot "node-windows registration successful"
            Write-Log "Service registered via node-windows"
        }
        else {
            Write-Dot "node-windows result: $resultStr"
            Write-Log "node-windows registration result: $resultStr" "WARNING"
        }
        
        <#
            svc.install() is ASYNCHRONOUS, so give the SCM a moment to make the
            service enumerable before Get-Service below decides it is absent.

            THIS BLOCK USED TO SAY the fallback was the normal path - that
            node-windows emitted its 'install' event and the service never
            appeared in the SCM, on every run, measured 2026-08-16. That was
            true, and the cause was not node-windows.

            Step 4 was copying dist\daemon into the install directory, putting a
            populated daemon folder with a foreign descriptor back where Step 2
            had just removed one. node-windows found a daemon directory it had
            not created, and registration went sideways. Step 4 now excludes it.

            RE-MEASURED 2026-08-29, three consecutive reinstalls on the dev box:
            node-windows registers natively every time, in about four seconds,
            and neither the descriptor repair below nor the sc.exe fallback runs
            at all. The six-second poll is comfortably enough.

            The fallback stays because it has to - a till where node-windows
            genuinely fails still needs a service. But it is the exceptional
            path again, and if you find yourself in it, the first question is
            what put a daemon folder on disk before Step 6.

            Unchanged and still true: do not read "node-windows registration
            successful" as meaning the service exists. Only Get-Service does.
        #>
        $registerDeadline = (Get-Date).AddSeconds(6)
        while ((Get-Date) -lt $registerDeadline) {
            if ((Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) -or
                (Get-Service -DisplayName $ServiceDisplayName -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 500
        }

        # Verify the daemon XML has correct install paths (not dev paths)
        <#
            ChangeExtension, NOT "$ServiceName.xml".

            $ServiceName is "xpthermalprintservice.exe" - node-windows derives
            the service key from the display name and appends .exe. So the
            string form built "xpthermalprintservice.exe.xml", which has never
            existed on any machine. Test-Path was therefore always false and
            THIS ENTIRE REPAIR BLOCK HAS NEVER EXECUTED, on any installation,
            since it was written.

            That is why the dev box ran a descriptor dated 19-Mar-26 pointing at
            E:\xp-thermal-service with --maxrestarts 3: the code whose whole
            purpose is to detect dev paths and regenerate the descriptor could
            not find the file it was meant to inspect. It is also why INST-31
            and INST-34 read as open failures - the repair for them existed and
            was dead.

            Verified on the box 2026-08-16:
              built  -> ...\daemon\xpthermalprintservice.exe.xml   Test-Path False
              actual -> ...\daemon\xpthermalprintservice.xml       Test-Path True
        #>
        $daemonXml = [System.IO.Path]::ChangeExtension("$InstallPath\daemon\$ServiceName", '.xml')
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
        <argument>100</argument>
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

                    <#
                        SAY WHAT THIS FALLBACK DOES NOT DO.

                        node-windows GENERATES the wrapper descriptor - the
                        <argument> list carrying --maxrestarts, --wait,
                        --max-old-space-size and the environment. This path does
                        not: winsw and sc.exe both register whatever descriptor
                        is ALREADY on disk. If one is left over from an earlier
                        install, the service comes up green on the OLD settings
                        and the installer reports success.

                        Measured on the dev box, 2026-08-12: registration had
                        been falling back for months because of the node -e
                        truncation bug, and the live descriptor was five months
                        old - maxrestarts 3 instead of 100, wait 2 instead of 5,
                        a 256 MB heap cap instead of 512, no XP_CONFIG_PATH, and
                        an <executable> pointing at a system Node. Every one of
                        those is a setting somebody deliberately changed and
                        nobody received.

                        A running service is the right outcome here. Pretending
                        it is a fully configured one is not.
                    #>
                    $descriptor = [System.IO.Path]::ChangeExtension($daemonExe, '.xml')
                    if (Test-Path $descriptor) {
                        $descAge = (Get-Item $descriptor).LastWriteTime
                        if ($descAge -lt (Get-Date).AddMinutes(-10)) {
                            Write-WARN "The service kept its PREVIOUS configuration."
                            Write-Log "Fallback registration reused a stale descriptor: $descriptor (last written $descAge)" "WARNING"
                            Write-Dot "  $descriptor"
                            Write-Dot "  last written $($descAge.ToString('yyyy-MM-dd HH:mm')) - not by this install."
                            Write-Dot "  Restart limits, memory caps and environment settings from this"
                            Write-Dot "  release have NOT been applied. Re-run this installer once the"
                            Write-Dot "  node-windows registration above succeeds, or delete the file"
                            Write-Dot "  and re-run to force it to be regenerated."
                        }
                    }

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

        # Power management — POS terminals must never sleep
        Set-PowerManagement
    }
    finally {
        Pop-Location
    }
    
    Write-StepComplete
    
    # â”€â”€ Step 8: Firewall â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    Write-StepHeader "Configuring firewall & watchdog" 8
    
    Add-FirewallRules
    
    Install-Watchdog

    # Brand icon, shortcuts, Add/Remove Programs entry
    Install-IconAndShortcuts -Port $availablePort
    
    Write-StepComplete
    
    # â”€â”€ Step 9: Verify service â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    Write-StepHeader "Starting service" 9

    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) { $svc = Get-Service -DisplayName $ServiceDisplayName -ErrorAction SilentlyContinue }

    if (-not $svc) {
        Write-FAIL "The service is not registered - there is nothing to start"
        Write-Log "Step 9: no service registration found" "ERROR"
        Write-StepComplete "Failed"
        Write-FailBox "Windows service registration did not survive Step 6. See $LogFile."
        return $false
    }

    <#
        WHY THIS NO LONGER SPINS OUT THE CLOCK AND CARRIES ON.

        The old loop attempted sc.exe start once, waited out 45 seconds, called
        Write-StepComplete regardless of the outcome, and handed a dead service
        to Step 10 - which then spent another 60 seconds discovering the same
        thing. Nearly two minutes of progress bars, ending in "Service
        installed but API is not responding", for a failure whose cause was
        written in plain English in the daemon's err.log the entire time.

        That is what "the installer stops at Step 9" looks like from the far
        side. A service that exits three times running will not start on the
        fourth, so: stop, read the log, and say what is actually wrong.
    #>
    $maxWaitSecs = 45
    $waited = 0
    $serviceRunning = $false
    $startAttempts = 0

    while ($waited -lt $maxWaitSecs -and -not $serviceRunning) {
        try { $svc.Refresh() } catch { }

        if ($svc.Status -eq 'Running') {
            $serviceRunning = $true
            Clear-Spinner
            Write-OK "Service process running"
            Write-Log "Service process is running"
        }
        elseif ($svc.Status -eq 'Stopped') {
            if ($startAttempts -ge 3) { break }

            $startAttempts++
            Clear-Spinner
            Write-Log "Service stopped - start attempt $startAttempts via sc.exe..."
            $scOut = (sc.exe start $svc.Name 2>&1 | Out-String)
            if ($scOut -match 'FAILED\s+(\d+)') {
                $scErr = $Matches[1]
                Write-Log "sc start failed with error ${scErr}: $scOut" "ERROR"
                if ($scErr -eq '1072') {
                    # ERROR_SERVICE_MARKED_FOR_DELETE. Remove-AllServices warns
                    # about this at Step 2; by here it is terminal.
                    Write-FAIL "Windows still has the old service marked for deletion (error 1072)"
                    Write-Dot "Only a reboot clears that. No amount of retrying will."
                    Write-StepComplete "Failed"
                    Write-FailBox "Reboot this machine, then run the installer again."
                    return $false
                }
            }
            Start-Sleep -Seconds 3
            $waited += 3
        }
        else {
            Write-Spinner "Waiting for service to start" $waited $maxWaitSecs
            Start-Sleep -Seconds 2
            $waited += 2
        }
    }
    Clear-Spinner

    if (-not $serviceRunning) {
        Write-FAIL "The service did not stay running"
        Write-Log "Step 9: service never reached Running (after $startAttempts start attempts)" "ERROR"

        $reason = Get-DaemonFailureReason
        if ($reason) {
            Write-Dot $reason.Summary
            foreach ($hint in $reason.Hints) { Write-Dot $hint }
            Write-Log "Daemon reported: $($reason.Summary)" "ERROR"
        }
        else {
            Write-Dot "The daemon logged nothing to $(Get-DaemonLogStem).err.log."
            Write-Dot "Check the Windows event log (System) for service $($svc.Name)."
        }

        Write-StepComplete "Failed"
        Write-FailBox "Service registered but would not start. Details in $LogFile."
        return $false
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

        # Stamped only now, on a verified-working install. The next run reads
        # this to tell the operator what it is replacing.
        Set-InstalledVersion -Version $newVersion

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

        # The service is Running as far as Windows is concerned, so the wrapper
        # is up and its child is the thing failing - which means the reason is
        # in the daemon log, same as at Step 9.
        $reason = Get-DaemonFailureReason
        if ($reason) {
            Write-Dot $reason.Summary
            foreach ($hint in $reason.Hints) { Write-Dot $hint }
            Write-Log "Daemon reported: $($reason.Summary)" "ERROR"
        }

        Write-FailBox "Service installed but the API is not responding."

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

    # Remove icon, shortcuts, Add/Remove Programs entry, power overrides
    Remove-IconAndShortcuts
    if (-not $Silent) { Write-OK "Shortcuts and icon removed" }
    
    # Stop all processes. These return a status now, so discard it explicitly
    # rather than letting a bare "True" print itself into the uninstall output.
    if (Stop-AllServiceProcesses) {
        if (-not $Silent) { Write-OK "Processes stopped" }
    }
    else {
        if (-not $Silent) { Write-WARN "Some service processes could not be stopped - reboot to finish" }
    }

    Clear-InstanceLock
    
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
            # Same reason as the registration script - see Invoke-NodeScript.
            # This one carries no double quotes today, which is precisely why it
            # would break the first time somebody added a message to it.
            Invoke-NodeScript -Script $uninstallScript -Name 'xp-thermal-uninstall' | Out-Null
        }
        catch { }
        finally {
            Pop-Location
        }
        Start-Sleep -Seconds 2
    }
    
    # Force remove all services
    if (Remove-AllServices) {
        if (-not $Silent) { Write-OK "Service registrations removed" }
    }
    else {
        if (-not $Silent) { Write-WARN "Windows has the service marked for deletion - it goes on reboot" }
    }

    # Remove daemon folder
    $null = Remove-DaemonFolder
    Remove-ParkedDaemonFolders
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
    $null = Stop-AllServiceProcesses
    $null = Remove-AllServices
    Clear-InstanceLock
    $null = Remove-DaemonFolder
    Remove-ParkedDaemonFolders
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
