/**
 * USB Printer Adapter
 *
 * Talks to a locally installed Windows print queue by pushing raw ESC/POS bytes
 * through the spooler (winspool WritePrinter with the RAW datatype). No native
 * USB dependency, so it works with whatever driver the printer shipped with.
 *
 * Beyond writing bytes, this adapter keeps itself attached to the right queue:
 *
 *   - It never trusts the WorkOffline flag on its own (see printer-resolver),
 *     which is what previously made healthy printers report as offline.
 *   - When the printer is moved to a different USB socket it detects the port
 *     migration and repoints the queue.
 *   - When the queue is renamed or duplicated by a driver re-install, it finds
 *     the replacement and rebinds to it.
 *   - A failed write triggers a repair pass and one retry before it is reported
 *     as a failure.
 */

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BasePrinterAdapter, PrintResult } from './base-adapter';
import {
  WindowsPrintSystem,
  WindowsPrinterInfo,
  getWindowsPrintSystem,
  resolvePowerShellPath,
  runPowerShell,
  describeWin32Error
} from './windows-printers';
import {
  classifyStatus,
  resolveQueue,
  planHealing,
  readHints,
  buildHints,
  StatusVerdict,
  HealAction,
  PrinterIdentityHints
} from './printer-resolver';
import { PrinterConfig, PrinterStatus } from '../types';
import { WINSPOOL_SOURCE } from './winspool';
import { Logger } from '../utils/logger';

// Max items in write queue to prevent unbounded memory growth
const MAX_WRITE_QUEUE_SIZE = 100;

// Don't run repairs more often than this. Repairs shell out to printui and
// Set-Printer, so a tight loop would hammer the spooler during an outage.
const HEAL_COOLDOWN_MS = 15000;

// A spooler write should never take this long; beyond it we assume a wedge.
const WRITE_TIMEOUT_MS = 30000;

/**
 * The winspool P/Invoke shim, shared with the enumeration fallback so one
 * pre-compiled assembly serves both printing and printer discovery.
 */
const RAW_PRINTER_SOURCE = WINSPOOL_SOURCE;

/**
 * Printer names come from Windows and are only ever passed to PowerShell
 * through environment variables, never interpolated into script text, so the
 * old character allow-list is unnecessary and rejected legitimate names such as
 * "XP-80C @ Kitchen" or "HP LaserJet Pro M15w+". We reject only control
 * characters, which cannot appear in a real queue name.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface PrinterRebindEvent {
  printerId: string;
  from: string;
  to: string;
  reason: string;
}

export interface HealResult {
  attempted: HealAction[];
  succeeded: HealAction[];
  statusBefore: PrinterStatus;
  statusAfter: PrinterStatus;
  reason: string;
  manualHint?: string;
}

export class USBPrinterAdapter extends BasePrinterAdapter {
  /** The Windows queue we are currently bound to. Changes when we rebind. */
  private printerName: string;
  private readonly tempDir: string;
  private readonly printSystem: WindowsPrintSystem;
  private writeQueue: Array<{
    data: Buffer;
    resolve: (result: PrintResult) => void;
    reject: (error: Error) => void;
  }> = [];
  private isWriting = false;
  private lastHealAt = 0;
  private lastVerdict: StatusVerdict | null = null;
  /** Other queue names already claimed by sibling printers, to avoid stealing. */
  private siblingQueueNames: string[] = [];

  constructor(config: PrinterConfig, printSystem?: WindowsPrintSystem) {
    super(config);

    if (!config.printerName) {
      throw new Error('USB printer requires printerName (the Windows printer name)');
    }

    if (CONTROL_CHARS.test(config.printerName)) {
      throw new Error('Invalid printer name: contains control characters');
    }

    this.printerName = config.printerName;
    this.printSystem = printSystem ?? getWindowsPrintSystem();
    this.tempDir = path.join(os.tmpdir(), 'xp-thermal');

    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    // Clean up stale temp files from previous crashes
    this.cleanStaleTempFiles();
  }

  /**
   * Path to the pre-compiled winspool helper, shared by every adapter.
   * Null until prepareHelperAssembly() succeeds; printing falls back to
   * compiling inline, so this is an optimisation, never a requirement.
   */
  private static helperAssemblyPath: string | null = null;

  /**
   * Build the raw-printing helper once, at startup, instead of on every job.
   *
   * Measured on the reference machine: compiling inline costs ~600ms per print,
   * on top of ~500ms to spawn PowerShell. A receipt plus a kitchen ticket paid
   * that twice. Pre-building also means a machine that cannot run the C#
   * compiler at print time — locked-down TEMP, or PowerShell in Constrained
   * Language Mode — still prints, as long as the DLL was built once.
   */
  static async prepareHelperAssembly(logger?: Logger): Promise<string | null> {
    if (USBPrinterAdapter.helperAssemblyPath) {
      return USBPrinterAdapter.helperAssemblyPath;
    }
    if (process.platform !== 'win32') return null;

    const outDir = path.join(process.cwd(), 'data');
    const outPath = path.join(outDir, 'RawPrinterHelper.dll');

    try {
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }

      if (fs.existsSync(outPath)) {
        USBPrinterAdapter.helperAssemblyPath = outPath;
        logger?.debug({ outPath }, 'Using cached raw-printing helper');
        return outPath;
      }

      const script = `
        $ErrorActionPreference = 'Stop'
        $out = $env:XP_HELPER_OUT
        if (Test-Path $out) { Remove-Item $out -Force -ErrorAction SilentlyContinue }
        Add-Type -TypeDefinition @"
${RAW_PRINTER_SOURCE}
"@ -Language CSharp -OutputAssembly $out -ErrorAction Stop
        if (Test-Path $out) { Write-Output 'OK' } else { Write-Output 'MISSING' }
      `;

      const result = await runPowerShell(script, { XP_HELPER_OUT: outPath }, 60000);

      if (result.stdout.includes('OK') && fs.existsSync(outPath)) {
        USBPrinterAdapter.helperAssemblyPath = outPath;
        logger?.info({ outPath }, 'Pre-built the raw-printing helper — print jobs skip compilation');
        return outPath;
      }

      logger?.warn(
        { detail: (result.stderr || result.stdout).slice(0, 300) },
        'Could not pre-build the raw-printing helper; jobs will compile it inline'
      );
    } catch (error) {
      logger?.warn(
        { error: (error as Error).message },
        'Could not pre-build the raw-printing helper; jobs will compile it inline'
      );
    }

    return null;
  }

  /** The Windows queue this adapter currently writes to. */
  get targetPrinterName(): string {
    return this.printerName;
  }

  /** Most recent status assessment, including why we reached it. */
  get verdict(): StatusVerdict | null {
    return this.lastVerdict;
  }

  /**
   * Tell the adapter which queues its siblings own, so a rebind never steals
   * the kitchen printer's queue for the receipt printer.
   */
  setSiblingQueueNames(names: string[]): void {
    this.siblingQueueNames = names.filter((n) => n !== this.printerName);
  }

  /**
   * Remove stale .bin temp files left behind by previous process crashes.
   */
  private cleanStaleTempFiles(): void {
    try {
      const files = fs.readdirSync(this.tempDir);
      for (const file of files) {
        if (file.startsWith('print_') && file.endsWith('.bin')) {
          try {
            fs.unlinkSync(path.join(this.tempDir, file));
          } catch {
            // Ignore individual file cleanup errors
          }
        }
      }
    } catch {
      // Ignore if directory doesn't exist or can't be read
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Connection lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Attach to the printer.
   *
   * This resolves the queue (rebinding if it moved), assesses the real status,
   * and repairs what it can. It only throws when there is no plausible queue at
   * all — a printer that is merely out of paper stays registered so it can
   * recover on its own.
   */
  async connect(): Promise<void> {
    try {
      const resolved = await this.resolveTarget();

      if (!resolved) {
        const message = `No Windows print queue found for "${this.printerName}"`;
        this.updateState({
          isConnected: false,
          status: PrinterStatus.OFFLINE,
          lastError: message
        });
        this.emit('disconnected', this.id);
        throw new Error(message);
      }

      const snapshot = await this.printSystem.getSnapshot();
      let verdict = classifyStatus(resolved, snapshot, readHints(this.config.metadata));

      // Try to repair anything that stands between us and a working printer.
      if (!verdict.printable && verdict.healable) {
        await this.heal();
        const refreshed = await this.printSystem.getSnapshot(0);
        const again = refreshed.printers.find((p) => p.name === this.printerName);
        verdict = classifyStatus(again, refreshed, readHints(this.config.metadata));
      } else if (verdict.printable && verdict.healable) {
        // Printable but carrying a stale flag (the classic WorkOffline case).
        // Clear it in the background so Windows' own UI agrees with us too.
        void this.heal().catch(() => undefined);
      }

      this.applyVerdict(verdict);

      if (verdict.printable) {
        this.rememberIdentity(resolved, snapshot.usbDevices);
        this.handleConnectionSuccess();
      } else {
        // Known, reportable condition (no paper, unplugged). Stay registered
        // and let the health check bring it back when the user fixes it.
        this.reconnectAttempts = 0;
        this.emit('disconnected', this.id);
      }
    } catch (error) {
      this.handleConnectionError(error as Error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    // Clear any pending writes
    this.writeQueue = [];
    this.isWriting = false;

    this.updateState({
      status: PrinterStatus.OFFLINE,
      isConnected: false
    });

    this.emit('disconnected', this.id);
  }

  /**
   * Find the live Windows queue backing this printer, rebinding if the queue
   * was renamed, duplicated, or replaced.
   */
  private async resolveTarget(): Promise<WindowsPrinterInfo | undefined> {
    const snapshot = await this.printSystem.getSnapshot();
    const hints = readHints(this.config.metadata);

    const resolution = resolveQueue(
      this.printerName,
      snapshot,
      hints,
      this.siblingQueueNames
    );

    if (resolution.exact && resolution.match) {
      return resolution.match;
    }

    if (resolution.match && resolution.autoAdopt) {
      const from = this.printerName;
      this.printerName = resolution.match.name;

      const event: PrinterRebindEvent = {
        printerId: this.id,
        from,
        to: resolution.match.name,
        reason: resolution.reason
      };
      // The manager persists this so the rebind survives a restart.
      this.emit('rebound', event);

      return resolution.match;
    }

    return undefined;
  }

  private applyVerdict(verdict: StatusVerdict): void {
    this.lastVerdict = verdict;
    this.updateState({
      status: verdict.status,
      isConnected: verdict.printable,
      lastSeen: verdict.printable ? Date.now() : this._state.lastSeen,
      lastError: verdict.printable ? undefined : verdict.reason,
      reason: verdict.reason,
      healable: verdict.healable,
      boundPrinterName: this.printerName
    });
  }

  /** Publish the breadcrumbs that let us re-find this queue after a change. */
  private rememberIdentity(
    printer: WindowsPrinterInfo,
    usbDevices: Parameters<typeof buildHints>[1]
  ): void {
    const hints: PrinterIdentityHints = buildHints(printer, usbDevices);
    const existing = readHints(this.config.metadata);

    // Only emit when something actually changed, to avoid rewriting config.json
    // on every health check.
    if (
      existing.windowsPort === hints.windowsPort &&
      existing.windowsDriver === hints.windowsDriver &&
      existing.usbHardwareId === hints.usbHardwareId
    ) {
      return;
    }

    this.emit('identityLearned', { printerId: this.id, hints });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Self-repair
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Run the repair plan for the current state: repoint a migrated USB port,
   * clear a stale offline flag, resume a paused queue, restart the spooler.
   *
   * Rate-limited, and safe to call speculatively.
   */
  async heal(force = false): Promise<HealResult> {
    const statusBefore = this._state.status;

    if (!force && Date.now() - this.lastHealAt < HEAL_COOLDOWN_MS) {
      return {
        attempted: [],
        succeeded: [],
        statusBefore,
        statusAfter: statusBefore,
        reason: 'Skipped: a repair ran moments ago'
      };
    }
    this.lastHealAt = Date.now();

    const snapshot = await this.printSystem.getSnapshot(0);
    const printer = snapshot.printers.find((p) => p.name === this.printerName);
    const verdict = classifyStatus(printer, snapshot, readHints(this.config.metadata));
    const plan = planHealing(this.printerName, printer, verdict, snapshot);

    const succeeded: HealAction[] = [];

    for (const action of plan.actions) {
      const ok = await this.runHealAction(action);
      if (ok) succeeded.push(action);
    }

    const after = await this.printSystem.getSnapshot(0);
    const afterPrinter = after.printers.find((p) => p.name === this.printerName);
    const afterVerdict = classifyStatus(afterPrinter, after, readHints(this.config.metadata));
    this.applyVerdict(afterVerdict);

    if (afterVerdict.printable && afterPrinter) {
      this.rememberIdentity(afterPrinter, after.usbDevices);
    }

    return {
      attempted: plan.actions,
      succeeded,
      statusBefore,
      statusAfter: afterVerdict.status,
      reason: afterVerdict.reason,
      manualHint: plan.manualHint
    };
  }

  private async runHealAction(action: HealAction): Promise<boolean> {
    switch (action.kind) {
      case 'clearWorkOffline':
        return this.printSystem.clearWorkOffline(action.printerName);

      case 'setPort':
        return this.printSystem.setPort(action.printerName, action.portName);

      case 'resumeQueue':
        return this.printSystem.resumeQueue(action.printerName, action.purge);

      case 'restartSpooler':
        return this.printSystem.restartSpooler();

      case 'rebind': {
        const found = await this.resolveTarget();
        return !!found;
      }

      default:
        return false;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Writing
  // ───────────────────────────────────────────────────────────────────────────

  async write(data: Buffer): Promise<PrintResult> {
    if (this.writeQueue.length >= MAX_WRITE_QUEUE_SIZE) {
      return {
        success: false,
        bytesWritten: 0,
        error: 'Write queue full — printer may be offline'
      };
    }
    return new Promise((resolve, reject) => {
      this.writeQueue.push({ data, resolve, reject });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isWriting || this.writeQueue.length === 0) {
      return;
    }

    this.isWriting = true;
    const item = this.writeQueue.shift()!;

    try {
      const result = await this.sendToPrinter(item.data);
      item.resolve(result);
    } catch (error) {
      item.reject(error as Error);
    } finally {
      this.isWriting = false;
      // Process next item
      if (this.writeQueue.length > 0) {
        setImmediate(() => this.processQueue());
      }
    }
  }

  private async sendToPrinter(data: Buffer): Promise<PrintResult> {
    const startTime = Date.now();
    const tempFile = path.join(
      this.tempDir,
      `print_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.bin`
    );

    try {
      fs.writeFileSync(tempFile, data);

      let lastError: Error | null = null;

      // Two passes: if the first write fails, repair and try once more. Most
      // transient failures (queue moved to a new USB port while idle, stale
      // offline flag, wedged job) clear on the retry.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          await this.heal(true);
        }

        try {
          await this.sendRawToPrinter(tempFile);

          const duration = Date.now() - startTime;

          // A completed write is the strongest possible evidence that the
          // printer is reachable — it outranks anything WMI claims.
          this.updateState({
            totalJobsPrinted: this._state.totalJobsPrinted + 1,
            lastSeen: Date.now(),
            consecutiveFailures: 0,
            status: PrinterStatus.ONLINE,
            isConnected: true,
            lastError: undefined
          });

          return { success: true, bytesWritten: data.length, duration };
        } catch (error) {
          lastError = error as Error;
        }
      }

      throw lastError ?? new Error('Print failed for an unknown reason');
    } catch (error) {
      const failures = this._state.consecutiveFailures + 1;
      this.updateState({
        consecutiveFailures: failures,
        lastError: (error as Error).message,
        ...(failures >= 3 ? { status: PrinterStatus.ERROR, isConnected: false } : {})
      });

      return {
        success: false,
        bytesWritten: 0,
        error: (error as Error).message
      };
    } finally {
      // Clean up temp file
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Push the raw bytes at the spooler with the RAW datatype, which bypasses
   * driver rendering entirely so ESC/POS commands reach the printer intact.
   *
   * The printer name and file path travel via environment variables, so a name
   * containing quotes or backticks cannot break out into the script.
   */
  private sendRawToPrinter(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ps = spawn(
        resolvePowerShellPath(),
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `
        $ErrorActionPreference = 'Stop'
        $printerName = $env:XP_PRINTER_NAME
        $filePath = $env:XP_PRINT_FILE

        $content = [System.IO.File]::ReadAllBytes($filePath)

        # Use RawPrinterHelper for raw ESC/POS data
        $rawPrinter = @"
${RAW_PRINTER_SOURCE}
"@

        # Loading a pre-built assembly avoids ~600ms of C# compilation on every
        # single receipt, and keeps printing working on machines where runtime
        # compilation is unavailable (no writable TEMP, or PowerShell held in
        # Constrained Language Mode by AppLocker/WDAC). Compiling inline is kept
        # as the fallback so a missing or stale cache is never fatal.
        $cached = $env:XP_HELPER_DLL
        $loaded = $false
        if ($cached -and (Test-Path $cached)) {
          try { Add-Type -Path $cached -ErrorAction Stop; $loaded = $true } catch { }
        }
        if (-not $loaded) {
          Add-Type -TypeDefinition $rawPrinter -Language CSharp -ErrorAction Stop
        }

        $failure = [RawPrinterHelper]::SendBytesToPrinter($printerName, $content)
        if ($failure) {
          throw $failure
        }
        `
        ],
        {
          env: {
            ...process.env,
            XP_PRINTER_NAME: this.printerName,
            XP_PRINT_FILE: filePath,
            XP_HELPER_DLL: USBPrinterAdapter.helperAssemblyPath ?? ''
          },
          windowsHide: true
        }
      );

      let stderr = '';
      let stdout = '';
      let timeout: NodeJS.Timeout;

      ps.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      ps.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ps.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(cleanPowerShellError(stderr || stdout) || `PowerShell exited with code ${code}`));
        }
      });

      ps.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      timeout = setTimeout(() => {
        ps.kill();
        reject(new Error('Print operation timed out'));
      }, WRITE_TIMEOUT_MS);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Status
  // ───────────────────────────────────────────────────────────────────────────

  async getStatus(): Promise<PrinterStatus> {
    try {
      const snapshot = await this.printSystem.getSnapshot();
      let printer = snapshot.printers.find((p) => p.name === this.printerName);

      // Queue vanished — it may have been renamed or reinstalled.
      if (!printer) {
        printer = await this.resolveTarget();
      }

      const verdict = classifyStatus(printer, snapshot, readHints(this.config.metadata));
      this.applyVerdict(verdict);

      if (verdict.printable && printer) {
        this.rememberIdentity(printer, snapshot.usbDevices);
      }

      return verdict.status;
    } catch (error) {
      this.updateState({
        status: PrinterStatus.ERROR,
        isConnected: false,
        lastError: (error as Error).message
      });
      return PrinterStatus.ERROR;
    }
  }

  /**
   * Full diagnostic report: what Windows says, what we concluded, and what can
   * be done about it. Backs the dashboard's Diagnose action.
   */
  async diagnose(): Promise<{
    printerId: string;
    configuredName: string;
    boundName: string;
    found: boolean;
    windows: WindowsPrinterInfo | null;
    verdict: StatusVerdict;
    plan: ReturnType<typeof planHealing>;
    livePorts: string[];
    attachedDevices: number;
    spoolerRunning: boolean;
  }> {
    const snapshot = await this.printSystem.getSnapshot(0);
    let printer = snapshot.printers.find((p) => p.name === this.printerName);

    if (!printer) {
      const resolution = resolveQueue(
        this.printerName,
        snapshot,
        readHints(this.config.metadata),
        this.siblingQueueNames
      );
      printer = resolution.match ?? undefined;
    }

    const verdict = classifyStatus(printer, snapshot, readHints(this.config.metadata));
    const plan = planHealing(this.printerName, printer, verdict, snapshot);

    return {
      printerId: this.id,
      configuredName: this.config.printerName ?? '',
      boundName: this.printerName,
      found: !!printer,
      windows: printer ?? null,
      verdict,
      plan,
      livePorts: snapshot.livePorts,
      attachedDevices: snapshot.usbDevices.length,
      spoolerRunning: snapshot.spoolerRunning
    };
  }

  /**
   * Get list of available Windows printers.
   * Retained for callers that only need names; prefer the print system
   * snapshot when richer detail is useful.
   */
  static async listPrinters(): Promise<Array<{ name: string; status: string; port: string }>> {
    const snapshot = await getWindowsPrintSystem().getSnapshot();
    return snapshot.printers.map((p) => ({
      name: p.name,
      status: String(p.printerStatus),
      port: p.portName
    }));
  }
}

/**
 * Make a spooler failure readable.
 *
 * PowerShell wraps thrown strings in several lines of positional noise, and the
 * useful part is a bare Win32 error number. "WritePrinter failed (win32 error
 * 1801)" tells nobody anything; "The printer name is not valid — the queue may
 * have been renamed or removed" tells them what to do.
 */
function cleanPowerShellError(raw: string): string {
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('+') && !/^At line:/i.test(l));

  const message = (line ?? raw.trim()).slice(0, 300);

  const win32 = message.match(/win32 error (\d+)/i);
  if (win32) {
    const code = parseInt(win32[1], 10);
    const step = message.split('(')[0].trim();
    return `${describeWin32Error(code)}${step ? ` [${step}]` : ''}`;
  }

  return message;
}

export default USBPrinterAdapter;
