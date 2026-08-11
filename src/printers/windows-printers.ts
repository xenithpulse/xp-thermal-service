/**
 * Windows Print System Layer
 *
 * A single, cached view of everything Windows knows about printers, plus the
 * repair operations needed to keep a USB thermal printer usable.
 *
 * Why this exists
 * ---------------
 * The naive check ("is Win32_Printer.WorkOffline true?") produces false
 * OFFLINE readings constantly on cheap thermal printers. Observed on a real
 * XPrinter-class device:
 *
 *     Name        : Generic / Text Only
 *     PortName    : USB011
 *     WorkOffline : True      <-- would be reported OFFLINE
 *     PrinterState: 0         <-- Ready
 *     DetectedErrorState : 0  <-- no error
 *
 * ...while the Windows test page printed instantly. WorkOffline is sticky: the
 * spooler sets it when a USB device disappears and frequently never clears it
 * when the device comes back. It must be corroborated, never trusted alone.
 *
 * The second failure mode is USB port migration. Every physical USB socket a
 * printer is plugged into mints a fresh port (USB001, USB002, ... USB018 on the
 * reference machine). The print queue stays pinned to whichever port existed at
 * install time, so moving the cable silently breaks printing. Windows records
 * the live device -> port mapping at:
 *
 *     HKLM\SYSTEM\CurrentControlSet\Enum\<PNPDeviceID>\Device Parameters\PortName
 *
 * Reading that lets us detect the migration and repoint the queue.
 *
 * All PowerShell runs through one batched snapshot (cached, single-flight) so a
 * health check across N printers costs one process, not 2N.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import { WINSPOOL_SOURCE } from './winspool';
import { Logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** One Windows print queue, as reported by WMI/CIM. */
export interface WindowsPrinterInfo {
  name: string;
  portName: string;
  driverName: string;
  shared: boolean;
  shareName: string;
  workOffline: boolean;
  /** WMI PrinterStatus: 1=Other 2=Unknown 3=Idle 4=Printing 5=Warmup 6=Stopped 7=Offline */
  printerStatus: number;
  /** WMI PrinterState bitfield: 2=Error 8=PaperJam 16=PaperOut 128=Offline 1024=Busy */
  printerState: number;
  /** WMI DetectedErrorState: 2=NoError 3=LowPaper 4=NoPaper 8=Jammed 9=Offline */
  detectedErrorState: number;
  /** WMI ExtendedPrinterStatus: 2=Unknown 3=Idle 7=Offline */
  extendedPrinterStatus: number;
  isDefault: boolean;
  isLocal: boolean;
  isNetwork: boolean;
}

/** A USB printing device that is physically present right now. */
export interface UsbPrintDevice {
  /** PnP instance id, e.g. USBPRINT\UnknownPrinter\7&11222418&0&USB011 */
  instanceId: string;
  name: string;
  /** Live port claimed by this device, read from the PnP registry key. */
  portName: string | null;
  status: string;
  /** Hardware id fragment (VID/PID or model), used for stable re-identification. */
  hardwareId: string;
}

/** What the host's PowerShell/Windows build can actually do. */
export interface HostCapabilities {
  /** PowerShell major version. 2 on a stock Windows 7. */
  psVersion: number;
  osCaption: string;
  /** Get-Printer / Set-Printer / Get-PrinterPort — Windows 8 and Server 2012+. */
  hasPrintManagement: boolean;
  /**
   * False when the WMI repository is damaged (Win32_Printer reports "Invalid
   * class"). Printer data then comes from the spooler directly, which works,
   * but some detail is unavailable.
   */
  wmiHealthy: boolean;
  /**
   * True when USB presence could not be probed properly. Presence is then a
   * weak signal, so a printer must never be declared unplugged on it alone.
   */
  devicePresenceDegraded: boolean;
}

export interface WindowsPrintSnapshot {
  takenAt: number;
  spoolerRunning: boolean;
  printers: WindowsPrinterInfo[];
  /** Every port Windows knows about. NOTE: USB00x ports persist forever, so a
   *  port existing here says nothing about whether a device is attached. */
  ports: string[];
  /** USB printers physically attached right now. */
  usbDevices: UsbPrintDevice[];
  /** Ports actually backed by a connected device. This is the liveness signal. */
  livePorts: string[];
  /** Non-fatal problems collected while building the snapshot. */
  warnings: string[];
  host: HostCapabilities;
}

export interface PowerShellResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// WMI / spooler constants
// ─────────────────────────────────────────────────────────────────────────────

/** Win32_Printer.PrinterState bit flags. */
export const PRINTER_STATE = {
  PAUSED: 0x00000001,
  ERROR: 0x00000002,
  PENDING_DELETION: 0x00000004,
  PAPER_JAM: 0x00000008,
  PAPER_OUT: 0x00000010,
  MANUAL_FEED: 0x00000020,
  PAPER_PROBLEM: 0x00000040,
  OFFLINE: 0x00000080,
  IO_ACTIVE: 0x00000100,
  BUSY: 0x00000200,
  PRINTING: 0x00000400,
  OUTPUT_BIN_FULL: 0x00000800,
  NOT_AVAILABLE: 0x00001000,
  WAITING: 0x00002000,
  PROCESSING: 0x00004000,
  INITIALIZING: 0x00008000,
  WARMING_UP: 0x00010000,
  TONER_LOW: 0x00020000,
  NO_TONER: 0x00040000,
  PAGE_PUNT: 0x00080000,
  USER_INTERVENTION: 0x00100000,
  OUT_OF_MEMORY: 0x00200000,
  DOOR_OPEN: 0x00400000,
  SERVER_UNKNOWN: 0x00800000,
  POWER_SAVE: 0x01000000
} as const;

/** Win32_Printer.DetectedErrorState enumeration. */
export const DETECTED_ERROR = {
  UNKNOWN: 0,
  OTHER: 1,
  NO_ERROR: 2,
  LOW_PAPER: 3,
  NO_PAPER: 4,
  LOW_TONER: 5,
  NO_TONER: 6,
  DOOR_OPEN: 7,
  JAMMED: 8,
  OFFLINE: 9,
  SERVICE_REQUESTED: 10,
  OUTPUT_BIN_FULL: 11
} as const;

// How long a snapshot stays fresh. Health checks run every 30s, and a single
// dashboard page load fans out to several endpoints; 4s collapses that burst
// into one PowerShell process while staying responsive to a replugged cable.
const SNAPSHOT_TTL_MS = 4000;
const SNAPSHOT_TIMEOUT_MS = 20000;
const CONTROL_TIMEOUT_MS = 25000;

// ─────────────────────────────────────────────────────────────────────────────
// PowerShell scripts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Field separator for the snapshot protocol: ASCII Unit Separator.
 *
 * The output is line-based rather than JSON because ConvertTo-Json does not
 * exist before PowerShell 3.0, and a stock Windows 7 ships PowerShell 2.0 — the
 * whole snapshot would fail there. A delimited protocol works from 2.0 upwards
 * and sidesteps ConvertTo-Json's single-element-array and depth quirks as well.
 *
 * U+001F cannot occur in a Windows printer name, port, or driver name, so no
 * escaping is required.
 */
const FS = String.fromCharCode(31);

/**
 * Collect the full print-system state in one pass.
 *
 * Written defensively: every section is independently guarded so that one
 * failing provider (a hung WSD network printer, a locked registry key) still
 * yields a usable snapshot rather than nothing. Every cmdlet used here exists
 * in PowerShell 2.0, and each modern cmdlet is tried inside a try/catch with a
 * WMI fallback, so the same script serves Windows 7 through 11.
 */
const SNAPSHOT_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# Unit Separator. Cannot occur in a printer name, port, or driver name.
# Kept as a string so String.Replace always binds the (String, String) overload
# rather than depending on char coercion, which differs between PS versions.
$S = [string][char]31

function Emit($kind, $fields) { Write-Output ($kind + $S + ($fields -join $S)) }
function Warn($msg) { Write-Output ('W' + $S + [string]$msg) }

# Normalise anything into a flat string: WMI can hand back nulls and arrays.
function Txt($v) {
  if ($v -eq $null) { return '' }
  $t = [string]$v
  return $t.Replace($S, ' ').Replace("\`r", ' ').Replace("\`n", ' ')
}
function Bit($v) { if ($v) { return '1' } else { return '0' } }
function Num($v) { $n = 0; if ([int]::TryParse([string]$v, [ref]$n)) { return [string]$n } else { return '0' } }

# ── Host capabilities ──────────────────────────────────────────────────────
# Windows 7 ships PowerShell 2.0 and has no Get-Printer / Set-Printer, so the
# service needs to know which code paths are even available here.
$psv = 2
try { $psv = [int]$PSVersionTable.PSVersion.Major } catch { }

# The OS name comes from the registry first: on a machine with a damaged WMI
# repository the Win32_OperatingSystem class is missing too, and a blank OS in
# a support report is one more thing nobody can explain later.
$osCaption = ''
try {
  $osCaption = Txt (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -Name ProductName -ErrorAction Stop).ProductName
} catch { }
if (-not $osCaption) {
  try { $osCaption = Txt (Get-WmiObject -Class Win32_OperatingSystem -ErrorAction Stop).Caption } catch { }
}
if (-not $osCaption) {
  try { $osCaption = Txt [System.Environment]::OSVersion.VersionString } catch { }
}

$emittedAny = $false
$hasPrintMgmt = '0'
if (Get-Command Get-Printer -ErrorAction SilentlyContinue) { $hasPrintMgmt = '1' }
Emit 'V' @((Num $psv), $osCaption, $hasPrintMgmt)

# ── Spooler ────────────────────────────────────────────────────────────────
$spoolerRunning = '0'
try {
  $svc = Get-Service -Name Spooler -ErrorAction Stop
  if ($svc.Status -eq 'Running') { $spoolerRunning = '1' }
} catch { Warn "Could not query the Print Spooler service: $($_.Exception.Message)" }
Emit 'S' @($spoolerRunning)

# ── Print queues ───────────────────────────────────────────────────────────
# Get-CimInstance is PowerShell 3.0+; Get-WmiObject covers 2.0. If the WMI
# repository is damaged both fail with 'Invalid class "Win32_Printer"', which
# has been seen in the field, so a third path talks to the spooler directly.
$raw = @()
$wmiOk = $false
# Support switch: set XP_FORCE_SPOOLER_FALLBACK=1 to exercise the no-WMI path
# on a healthy machine, so the fallback can be tested without breaking anything.
$forceFallback = ($env:XP_FORCE_SPOOLER_FALLBACK -eq '1')
try {
  if ($forceFallback) { throw 'forced' }
  $raw = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction Stop)
  $wmiOk = $true
} catch {
  try {
    if ($forceFallback) { throw 'forced' }
    $raw = @(Get-WmiObject -Class Win32_Printer -ErrorAction Stop)
    $wmiOk = $true
  } catch {
    Warn "WMI could not enumerate printers ($($_.Exception.Message)); using the spooler directly."
  }
}

if ($wmiOk) {
  foreach ($p in $raw) {
    if (-not $p) { continue }
    Emit 'P' @(
      (Txt $p.Name), (Txt $p.PortName), (Txt $p.DriverName),
      (Bit $p.Shared), (Txt $p.ShareName), (Bit $p.WorkOffline),
      (Num $p.PrinterStatus), (Num $p.PrinterState),
      (Num $p.DetectedErrorState), (Num $p.ExtendedPrinterStatus),
      (Bit $p.Default), (Bit $p.Local), (Bit $p.Network)
    )
  }
} else {
  # winspool fallback. PRINTER_INFO_2.Status uses the same bit values as
  # Win32_Printer.PrinterState, and Attributes carries the WorkOffline flag,
  # so the classifier upstream needs no special handling.
  Emit 'X' @('wmi-unavailable')
  try {
    $helper = $env:XP_HELPER_DLL
    $loaded = $false
    if ($helper -and (Test-Path $helper)) {
      try { Add-Type -Path $helper -ErrorAction Stop; $loaded = $true } catch { }
    }
    if (-not $loaded) {
      Add-Type -TypeDefinition @"
${WINSPOOL_SOURCE}
"@ -Language CSharp -ErrorAction Stop
    }

    foreach ($line in [PrinterEnum]::ListPrinters()) {
      if (-not $line) { continue }
      $f = $line -split '\\|'
      if ($f[0] -eq 'ERR') { Warn "Spooler enumeration failed (win32 error $($f[1]))"; continue }
      $emittedAny = $true

      $attr = 0; [void][int]::TryParse($f[3], [ref]$attr)
      $status = 0; [void][int]::TryParse($f[4], [ref]$status)

      $isDefault = 0; if ($attr -band 0x4)   { $isDefault = 1 }
      $isShared  = 0; if ($attr -band 0x8)   { $isShared = 1 }
      $isNetwork = 0; if ($attr -band 0x10)  { $isNetwork = 1 }
      $isLocal   = 0; if ($attr -band 0x40)  { $isLocal = 1 }
      $offline   = 0; if ($attr -band 0x400) { $offline = 1 }

      Emit 'P' @(
        (Txt $f[0]), (Txt $f[1]), (Txt $f[2]),
        $isShared, (Txt $f[6]), $offline,
        '0', (Num $status),
        '0', '0',
        $isDefault, $isLocal, $isNetwork
      )
    }
  } catch {
    Warn "Spooler enumeration was unavailable ($($_.Exception.Message)); trying Get-Printer."
  }

  # Last resort. Get-Printer lives in root\\standardcimv2, a different namespace
  # from the damaged one, and needs no runtime compilation — so it can work
  # where both cimv2 and Add-Type are unavailable. It cannot report WorkOffline,
  # which is fine: that flag is never trusted on its own anyway.
  if (-not $emittedAny) {
    try {
      foreach ($p in @(Get-Printer -ErrorAction Stop)) {
        $st = 0
        if ($p.PrinterStatus -ne $null) { [void][int]::TryParse([string][int]$p.PrinterStatus, [ref]$st) }
        $isNet = 0; if ($p.Type -eq 'Connection') { $isNet = 1 }
        Emit 'P' @(
          (Txt $p.Name), (Txt $p.PortName), (Txt $p.DriverName),
          (Bit $p.Shared), (Txt $p.ShareName), '0',
          '0', '0', '0', '0',
          '0', (Bit ($isNet -eq 0)), $isNet
        )
      }
    } catch {
      Warn "Could not enumerate printers by any method: $($_.Exception.Message)"
    }
  }
}

# ── Ports ──────────────────────────────────────────────────────────────────
# Get-PrinterPort is Win8+. Fall back to the ports the queues reference.
$portSeen = @{}
try {
  foreach ($pp in @(Get-PrinterPort -ErrorAction Stop)) {
    if ($pp.Name -and -not $portSeen.ContainsKey([string]$pp.Name)) {
      $portSeen[[string]$pp.Name] = $true
      Emit 'O' @((Txt $pp.Name))
    }
  }
} catch {
  foreach ($p in $raw) {
    if ($p.PortName -and -not $portSeen.ContainsKey([string]$p.PortName)) {
      $portSeen[[string]$p.PortName] = $true
      Emit 'O' @((Txt $p.PortName))
    }
  }
}

# ── Physically attached USB printers ───────────────────────────────────────
# Win32_PnPEntity only returns devices that are present, so anything listed
# here is genuinely plugged in and powered on. This is the liveness signal that
# distinguishes "cable moved to another socket" from "printer switched off".
$devs = @()
$pnpOk = $false
try {
  if ($forceFallback) { throw 'forced' }
  $devs = @(Get-CimInstance -ClassName Win32_PnPEntity -Filter "PNPDeviceID LIKE 'USBPRINT%'" -ErrorAction Stop)
  $pnpOk = $true
} catch {
  try {
    if ($forceFallback) { throw 'forced' }
    $devs = @(Get-WmiObject -Class Win32_PnPEntity -Filter "PNPDeviceID LIKE 'USBPRINT%'" -ErrorAction Stop)
    $pnpOk = $true
  } catch {
    Warn "WMI could not enumerate USB printing devices ($($_.Exception.Message)); using the registry."
  }
}

# Registry fallback for a damaged WMI repository. PnP creates a volatile
# 'Control' subkey for a device that is started, so its presence distinguishes
# an attached printer from the stale instance left behind by every previous
# USB socket. Emitted with a marker so the service knows presence is a weaker
# signal here and stays optimistic rather than declaring printers unplugged.
if (-not $pnpOk) {
  Emit 'X' @('pnp-registry-fallback')
  try {
    foreach ($hw in @(Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\USBPRINT' -ErrorAction Stop)) {
      foreach ($inst in @(Get-ChildItem $hw.PSPath -ErrorAction SilentlyContinue)) {
        if (-not (Test-Path (Join-Path $inst.PSPath 'Control'))) { continue }

        $port = $null
        try {
          $port = (Get-ItemProperty (Join-Path $inst.PSPath 'Device Parameters') -Name PortName -ErrorAction Stop).PortName
        } catch { }

        $name = ''
        try { $name = (Get-ItemProperty $inst.PSPath -Name FriendlyName -ErrorAction Stop).FriendlyName } catch { }
        if (-not $name) {
          try { $name = (Get-ItemProperty $inst.PSPath -Name DeviceDesc -ErrorAction Stop).DeviceDesc } catch { }
        }

        Emit 'D' @(
          (Txt ($hw.PSChildName + '\\' + $inst.PSChildName)),
          (Txt $name), (Txt $port), 'OK', (Txt $hw.PSChildName)
        )
      }
    }
  } catch {
    Warn "Could not read USB printer devices from the registry: $($_.Exception.Message)"
  }
}
# Vendor stacks that enumerate outside USBPRINT but still bind usbprint.sys.
try {
  $devs += @(Get-CimInstance -ClassName Win32_PnPEntity -Filter "Service='usbprint'" -ErrorAction Stop)
} catch {
  try { $devs += @(Get-WmiObject -Class Win32_PnPEntity -Filter "Service='usbprint'" -ErrorAction Stop) } catch { }
}

$seen = @{}
foreach ($d in $devs) {
  if (-not $d) { continue }
  $id = [string]$d.PNPDeviceID
  if (-not $id -or $seen.ContainsKey($id)) { continue }
  $seen[$id] = $true

  # The spooler records which USB00x port this device instance owns.
  $port = $null
  try {
    $key = "HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\$id\\Device Parameters"
    $port = (Get-ItemProperty -Path $key -Name PortName -ErrorAction Stop).PortName
  } catch { }
  # Fall back to the port encoded in the instance id (…&0&USB011).
  if (-not $port -and $id -match '(USB\\d{3,})\\s*$') { $port = $Matches[1] }

  $hw = ''
  try { if ($d.HardwareID) { $hw = [string]@($d.HardwareID)[0] } } catch { }
  if (-not $hw) {
    $parts = $id -split '\\\\'
    if ($parts.Length -ge 2) { $hw = $parts[1] }
  }

  Emit 'D' @((Txt $id), (Txt $d.Name), (Txt $port), (Txt $d.Status), (Txt $hw))
}

Write-Output ('Z' + $S + 'ok')
`;

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export class WindowsPrintSystem {
  private readonly logger: Logger;
  private snapshot: WindowsPrintSnapshot | null = null;
  private inFlight: Promise<WindowsPrintSnapshot> | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Get the current print-system state, refreshing only if the cached copy is
   * older than `maxAgeMs`. Concurrent callers share a single PowerShell run.
   */
  async getSnapshot(maxAgeMs: number = SNAPSHOT_TTL_MS): Promise<WindowsPrintSnapshot> {
    if (this.snapshot && Date.now() - this.snapshot.takenAt < maxAgeMs) {
      return this.snapshot;
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.buildSnapshot()
      .then((snap) => {
        this.snapshot = snap;
        return snap;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  /** Force a fresh read, bypassing the cache. */
  async refresh(): Promise<WindowsPrintSnapshot> {
    this.snapshot = null;
    return this.getSnapshot(0);
  }

  /** Drop the cache so the next read hits Windows (used after a repair). */
  invalidate(): void {
    this.snapshot = null;
  }

  private async buildSnapshot(): Promise<WindowsPrintSnapshot> {
    const empty = (): WindowsPrintSnapshot => ({
      takenAt: Date.now(),
      spoolerRunning: false,
      printers: [],
      ports: [],
      usbDevices: [],
      livePorts: [],
      warnings: [],
      host: { psVersion: 0, osCaption: '', hasPrintManagement: false, wmiHealthy: true, devicePresenceDegraded: false }
    });

    if (process.platform !== 'win32') {
      const snap = empty();
      snap.warnings.push('Printer discovery is only supported on Windows');
      return snap;
    }

    const result = await runPowerShell(SNAPSHOT_SCRIPT, {}, SNAPSHOT_TIMEOUT_MS);

    if (!result.stdout.trim()) {
      this.logger.warn(
        { code: result.code, stderr: result.stderr.slice(0, 500) },
        'Printer snapshot query returned nothing'
      );
      const snap = empty();
      snap.warnings.push(result.stderr.trim() || 'PowerShell returned no printer data');
      return snap;
    }

    const snapshot = parseSnapshot(result.stdout);

    // A truncated response means the script died part-way through; the data we
    // did get is still usable but the caller deserves to know it is partial.
    if (!snapshot.complete) {
      snapshot.value.warnings.push(
        'Printer information may be incomplete — the Windows query did not finish'
      );
      this.logger.warn(
        { code: result.code, stderr: result.stderr.slice(0, 300) },
        'Printer snapshot was truncated'
      );
    }

    return snapshot.value;
  }

  /** Look up a queue by exact name (case-insensitive). */
  async findPrinter(name: string): Promise<WindowsPrinterInfo | undefined> {
    const snap = await this.getSnapshot();
    return findByName(snap.printers, name);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Repair operations
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Clear the sticky "Use Printer Offline" flag.
   *
   * There is no WMI setter for WorkOffline, but printui.dll exposes it as a
   * queue attribute. Returns true only if the flag is actually gone afterwards.
   */
  async clearWorkOffline(printerName: string): Promise<boolean> {
    const script = `
      $ErrorActionPreference = 'SilentlyContinue'
      $name = $env:XP_PRINTER_NAME
      # printui is the only supported way to toggle the offline attribute.
      $proc = Start-Process -FilePath 'rundll32.exe' \`
        -ArgumentList @('printui.dll,PrintUIEntry', '/Xs', '/n', $name, 'attributes', '-workoffline') \`
        -Wait -PassThru -WindowStyle Hidden
      Start-Sleep -Milliseconds 400
      $p = Get-CimInstance -ClassName Win32_Printer -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -eq $name }
      if ($p -and -not $p.WorkOffline) { Write-Output 'CLEARED' } else { Write-Output 'STILL_OFFLINE' }
    `;

    const result = await runPowerShell(script, { XP_PRINTER_NAME: printerName }, CONTROL_TIMEOUT_MS);
    this.invalidate();

    const cleared = result.stdout.includes('CLEARED');
    this.logger.info(
      { printerName, cleared },
      cleared
        ? 'Cleared the "Use Printer Offline" flag'
        : 'Could not clear the "Use Printer Offline" flag'
    );
    return cleared;
  }

  /**
   * Repoint a print queue at a different port. This is the repair for a printer
   * that was moved to another physical USB socket.
   */
  async setPort(printerName: string, portName: string): Promise<boolean> {
    const script = `
      $ErrorActionPreference = 'SilentlyContinue'
      $name = $env:XP_PRINTER_NAME
      $port = $env:XP_PORT_NAME
      $done = $false
      # Set-Printer is Win8+ and the cleanest path.
      try {
        Set-Printer -Name $name -PortName $port -ErrorAction Stop
        $done = $true
      } catch {
        # WMI fallback for Win7 / restricted hosts.
        try {
          $p = Get-WmiObject -Class Win32_Printer -ErrorAction Stop | Where-Object { $_.Name -eq $name }
          if ($p) { $p.PortName = $port; [void]$p.Put(); $done = $true }
        } catch { }
      }
      Start-Sleep -Milliseconds 300
      $check = Get-CimInstance -ClassName Win32_Printer -ErrorAction SilentlyContinue |
               Where-Object { $_.Name -eq $name }
      if ($check -and $check.PortName -eq $port) { Write-Output 'OK' }
      else { Write-Output "FAILED:$($check.PortName)" }
    `;

    const result = await runPowerShell(
      script,
      { XP_PRINTER_NAME: printerName, XP_PORT_NAME: portName },
      CONTROL_TIMEOUT_MS
    );
    this.invalidate();

    const ok = result.stdout.includes('OK');
    this.logger.info(
      { printerName, portName, ok, detail: result.stdout.trim().slice(0, 200) },
      ok ? 'Repointed print queue to a new port' : 'Failed to repoint print queue'
    );
    return ok;
  }

  /** Resume a paused queue and clear any jam of stuck jobs blocking it. */
  async resumeQueue(printerName: string, purgeJobs = false): Promise<boolean> {
    const script = `
      $ErrorActionPreference = 'SilentlyContinue'
      $name = $env:XP_PRINTER_NAME
      $purge = $env:XP_PURGE -eq '1'
      $p = Get-WmiObject -Class Win32_Printer -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -eq $name }
      if (-not $p) { Write-Output 'NOT_FOUND'; exit 0 }
      if ($purge) { try { [void]$p.CancelAllJobs() } catch { } }
      try { [void]$p.Resume() } catch { }
      Write-Output 'OK'
    `;

    const result = await runPowerShell(
      script,
      { XP_PRINTER_NAME: printerName, XP_PURGE: purgeJobs ? '1' : '0' },
      CONTROL_TIMEOUT_MS
    );
    this.invalidate();
    return result.stdout.includes('OK');
  }

  /**
   * Restart the Print Spooler. Heavy-handed, so it is only reached as the last
   * escalation step, and it requires the service to run with admin rights
   * (it does, as LocalSystem).
   */
  async restartSpooler(): Promise<boolean> {
    const script = `
      $ErrorActionPreference = 'Stop'
      try {
        Restart-Service -Name Spooler -Force
        Start-Sleep -Seconds 2
        if ((Get-Service -Name Spooler).Status -eq 'Running') { Write-Output 'OK' }
        else { Write-Output 'NOT_RUNNING' }
      } catch { Write-Output "ERR:$($_.Exception.Message)" }
    `;

    const result = await runPowerShell(script, {}, CONTROL_TIMEOUT_MS);
    this.invalidate();

    const ok = result.stdout.includes('OK');
    this.logger.warn({ ok, detail: result.stdout.trim().slice(0, 200) }, 'Print Spooler restart attempted');
    return ok;
  }

  /** Count jobs sitting in a queue — a growing count means output is stalled. */
  async getQueuedJobCount(printerName: string): Promise<number> {
    const script = `
      $ErrorActionPreference = 'SilentlyContinue'
      $name = $env:XP_PRINTER_NAME
      $jobs = @(Get-CimInstance -ClassName Win32_PrintJob -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like "$name,*" })
      Write-Output $jobs.Count
    `;
    const result = await runPowerShell(script, { XP_PRINTER_NAME: printerName }, CONTROL_TIMEOUT_MS);
    const n = parseInt(result.stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let cachedPowerShellPath: string | null = null;

/**
 * Locate powershell.exe by absolute path.
 *
 * `spawn('powershell')` resolves through PATH, so a machine with a truncated or
 * damaged system PATH — which does happen, and is not rare across a fleet —
 * loses printer detection *and* printing at once, with an error
 * ("ENOENT spawn powershell") that points nowhere near the real cause.
 *
 * Verified: with an empty environment, `powershell` does not resolve at all,
 * while the absolute path under %SystemRoot% always does.
 */
export function resolvePowerShellPath(): string {
  if (cachedPowerShellPath) return cachedPowerShellPath;

  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const candidates = [
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    // A 32-bit process on 64-bit Windows reaches the native copy via SysNative.
    path.join(systemRoot, 'SysNative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        cachedPowerShellPath = candidate;
        return candidate;
      }
    } catch {
      // Unreadable path; try the next candidate.
    }
  }

  // Last resort: let the OS search PATH, which is the old behaviour.
  cachedPowerShellPath = 'powershell.exe';
  return cachedPowerShellPath;
}

/**
 * Run a PowerShell script with values passed through the environment.
 *
 * Nothing caller-supplied is ever interpolated into the script text, which
 * keeps printer names containing spaces, slashes and parentheses safe.
 */
export function runPowerShell(
  script: string,
  env: Record<string, string> = {},
  timeoutMs = CONTROL_TIMEOUT_MS
): Promise<PowerShellResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: PowerShellResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let ps: ReturnType<typeof spawn>;
    try {
      ps = spawn(
        resolvePowerShellPath(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { env: { ...process.env, ...env }, windowsHide: true }
      );
    } catch (error) {
      finish({ ok: false, stdout: '', stderr: (error as Error).message, code: null });
      return;
    }

    let stdout = '';
    let stderr = '';

    ps.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    ps.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    ps.on('close', (code) => {
      finish({ ok: code === 0, stdout, stderr, code });
    });

    ps.on('error', (error) => {
      finish({ ok: false, stdout, stderr: error.message, code: null });
    });

    timer = setTimeout(() => {
      try {
        ps.kill();
      } catch {
        // Process already gone.
      }
      finish({
        ok: false,
        stdout,
        stderr: stderr || `PowerShell timed out after ${timeoutMs}ms`,
        code: null
      });
    }, timeoutMs);
  });
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * Parse the line protocol emitted by SNAPSHOT_SCRIPT.
 *
 * Unknown record types and malformed lines are skipped rather than treated as
 * fatal, so a future field addition cannot break an older client, and one bad
 * printer entry cannot hide the others.
 */
export function parseSnapshot(stdout: string): {
  value: WindowsPrintSnapshot;
  complete: boolean;
} {
  const snapshot: WindowsPrintSnapshot = {
    takenAt: Date.now(),
    spoolerRunning: false,
    printers: [],
    ports: [],
    usbDevices: [],
    livePorts: [],
    warnings: [],
    host: { psVersion: 0, osCaption: '', hasPrintManagement: false, wmiHealthy: true, devicePresenceDegraded: false }
  };

  let complete = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;

    const parts = line.split(FS);
    const kind = parts[0];
    const f = (i: number): string => (parts[i] ?? '').trim();

    switch (kind) {
      case 'V':
        snapshot.host = {
          ...snapshot.host,
          psVersion: toInt(f(1)),
          osCaption: f(2),
          hasPrintManagement: f(3) === '1'
        };
        break;

      case 'S':
        snapshot.spoolerRunning = f(1) === '1';
        break;

      case 'P': {
        const name = f(1);
        if (!name) break;
        snapshot.printers.push({
          name,
          portName: f(2),
          driverName: f(3),
          shared: f(4) === '1',
          shareName: f(5),
          workOffline: f(6) === '1',
          printerStatus: toInt(f(7)),
          printerState: toInt(f(8)),
          detectedErrorState: toInt(f(9)),
          extendedPrinterStatus: toInt(f(10)),
          isDefault: f(11) === '1',
          isLocal: f(12) === '1',
          isNetwork: f(13) === '1'
        });
        break;
      }

      case 'O':
        if (f(1)) snapshot.ports.push(f(1));
        break;

      case 'D': {
        const instanceId = f(1);
        if (!instanceId) break;
        snapshot.usbDevices.push({
          instanceId,
          name: f(2),
          portName: f(3) || null,
          status: f(4) || 'Unknown',
          hardwareId: f(5)
        });
        break;
      }

      case 'W':
        if (f(1)) snapshot.warnings.push(f(1));
        break;

      // Degraded-mode markers: the data is still usable, but it came from a
      // fallback and some of it is weaker than usual.
      case 'X':
        if (f(1) === 'wmi-unavailable') {
          snapshot.host.wmiHealthy = false;
        } else if (f(1) === 'pnp-registry-fallback') {
          snapshot.host.devicePresenceDegraded = true;
        }
        break;

      case 'Z':
        complete = true;
        break;

      default:
        // Stray host output (a profile banner, a stderr echo). Ignore it.
        break;
    }
  }

  snapshot.ports = uniq(snapshot.ports);
  snapshot.livePorts = uniq(
    snapshot.usbDevices.map((d) => d.portName).filter((p): p is string => !!p)
  );

  return { value: snapshot, complete };
}

function toInt(value: string): number {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Turn a Win32 error code from the spooler API into something a restaurant
 * manager can act on. The raw number is kept in the message for support.
 */
export function describeWin32Error(code: number): string {
  const map: Record<number, string> = {
    2: 'The printer driver file is missing. Reinstall the printer driver.',
    5: 'Access denied. The service needs permission to use this printer — check that it is not set to "private" for another Windows user.',
    6: 'The printer handle became invalid. The printer was probably disconnected mid-job.',
    50: 'The printer does not support raw printing. Install a generic or ESC/POS driver for it.',
    63: 'The print queue is full. Clear the queued jobs and try again.',
    109: 'The connection to the printer was closed. Check the USB cable.',
    121: 'The printer did not respond in time. It may be busy, powered off, or asleep.',
    170: 'The printer is busy with another job.',
    1167: 'The printer is not connected.',
    1722: 'The Print Spooler service is not running.',
    1801: 'The printer name is not valid — the queue may have been renamed or removed.',
    1802: 'That printer already exists.',
    1804: 'The datatype is not supported by this driver. The printer needs a RAW-capable driver.',
    1930: 'The printer driver is not compatible with this version of Windows.'
  };

  const known = map[code];
  return known
    ? `${known} (Windows error ${code})`
    : `Windows reported error ${code} while sending data to the printer.`;
}

/** Case-insensitive, whitespace-tolerant queue lookup. */
export function findByName(
  printers: WindowsPrinterInfo[],
  name: string
): WindowsPrinterInfo | undefined {
  if (!name) return undefined;
  const target = name.trim().toLowerCase();
  return printers.find((p) => p.name.trim().toLowerCase() === target);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared instance
// ─────────────────────────────────────────────────────────────────────────────

// Every adapter and API handler must share one instance, otherwise the cache
// and single-flight guard are defeated and a health check across N printers
// spawns N PowerShell processes again.
let sharedSystem: WindowsPrintSystem | null = null;

/** Install the process-wide print system, bound to the service logger. */
export function initWindowsPrintSystem(logger: Logger): WindowsPrintSystem {
  sharedSystem = new WindowsPrintSystem(logger);
  return sharedSystem;
}

/**
 * Get the process-wide print system. Falls back to a silent logger for callers
 * that run outside the service (CLI helpers, discovery in tests).
 */
export function getWindowsPrintSystem(): WindowsPrintSystem {
  if (!sharedSystem) {
    sharedSystem = new WindowsPrintSystem(pino({ level: 'silent' }));
  }
  return sharedSystem;
}

export default WindowsPrintSystem;
