/**
 * Device Watcher
 *
 * Turns printer state changes from something the service *polls for* into
 * something Windows *tells it about*.
 *
 * A 30-second health poll means a printer that is unplugged and moved to
 * another USB socket can look broken for half a minute, and the dashboard shows
 * stale state for just as long. That is the difference between "the service is
 * resilient" and "the service feels resilient".
 *
 * Two WMI subscriptions cover everything that matters:
 *
 *   Win32_DeviceChangeEvent          extrinsic — fires the instant any device
 *                                    arrives or is removed, with no polling
 *                                    cost at all. Catches plug/unplug, hubs,
 *                                    Type-C dock connect/disconnect.
 *
 *   __InstanceModificationEvent      intrinsic, on Win32_Printer only. That is
 *   ... ISA 'Win32_Printer'          a small class, so a 5-second WITHIN clause
 *                                    is cheap. Catches WorkOffline flips, queue
 *                                    pauses, paper-out, and driver changes that
 *                                    do not involve a device arriving.
 *
 * The watcher is a supervised child process: if PowerShell dies, is blocked by
 * policy, or WMI refuses the subscription, it backs off and retries, and the
 * manager falls back to faster polling so behaviour degrades rather than breaks.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { resolvePowerShellPath } from './windows-printers';
import { Logger } from '../utils/logger';

const FS = String.fromCharCode(31);

/** Collapse the burst of events a single plug-in produces into one reaction. */
const DEBOUNCE_MS = 700;

/** Restart backoff bounds for a watcher that keeps dying. */
const RESTART_DELAY_MIN_MS = 2000;
const RESTART_DELAY_MAX_MS = 60000;

/**
 * If no event *and* no heartbeat arrives in this long, the subscription is
 * considered dead even though the process is still running — WMI can silently
 * stop delivering after a spooler crash or a session change.
 */
const SILENCE_TIMEOUT_MS = 150000;

const WATCHER_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$S = [string][char]31

# Write straight to the console stream and flush, so Node sees each line the
# moment it happens instead of when a pipe buffer fills.
function Say($text) {
  try { [Console]::Out.WriteLine($text); [Console]::Out.Flush() } catch { }
}

$registered = 0

# Extrinsic event: instant, no polling. Device arrival/removal of any kind.
try {
  Register-WmiEvent -Query "SELECT * FROM Win32_DeviceChangeEvent" \`
    -SourceIdentifier XpDeviceChange -ErrorAction Stop
  $registered = $registered + 1
  Say ("R" + $S + "device")
} catch {
  Say ("E" + $S + "device" + $S + $_.Exception.Message)
}

# Intrinsic event on a small class: queue flag changes the extrinsic feed misses.
try {
  Register-WmiEvent -Query "SELECT * FROM __InstanceModificationEvent WITHIN 2 WHERE TargetInstance ISA 'Win32_Printer'" \`
    -SourceIdentifier XpPrinterChange -ErrorAction Stop
  $registered = $registered + 1
  Say ("R" + $S + "printer")
} catch {
  Say ("E" + $S + "printer" + $S + $_.Exception.Message)
}

if ($registered -eq 0) {
  Say ("F" + $S + "no WMI event subscription could be created")
  exit 1
}

Say ("READY" + $S + $registered)

while ($true) {
  $evt = Wait-Event -Timeout 30
  if ($evt) {
    Say ("EVT" + $S + $evt.SourceIdentifier)
    Remove-Event -EventIdentifier $evt.EventIdentifier -ErrorAction SilentlyContinue
  } else {
    # Proves the subscription is still alive during quiet periods.
    Say ("HB" + $S + "1")
  }
}
`;

export interface DeviceWatcherEvents {
  /** Something changed; the caller should refresh and reconcile. */
  change: (info: { source: string }) => void;
  /** Watcher is live and delivering events. */
  ready: (info: { subscriptions: number }) => void;
  /** Watcher could not run; caller should fall back to polling. */
  unavailable: (info: { reason: string }) => void;
}

export class DeviceWatcher extends EventEmitter {
  private readonly logger: Logger;
  private child: ChildProcess | null = null;
  private stopped = false;
  private running = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private pendingSources = new Set<string>();
  private stdoutBuffer = '';
  private lastEventAt = 0;

  constructor(logger: Logger) {
    super();
    this.logger = logger;
  }

  /** True while the subscription is live and delivering. */
  get isRunning(): boolean {
    return this.running;
  }

  get lastActivityAt(): number {
    return this.lastEventAt;
  }

  start(): void {
    if (process.platform !== 'win32') {
      this.emit('unavailable', { reason: 'Device watching is only supported on Windows' });
      return;
    }
    this.stopped = false;
    this.spawnWatcher();
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    this.clearTimers();

    if (this.child) {
      const child = this.child;
      this.child = null;
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }
  }

  private clearTimers(): void {
    for (const timer of [this.restartTimer, this.debounceTimer, this.silenceTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.restartTimer = null;
    this.debounceTimer = null;
    this.silenceTimer = null;
  }

  private spawnWatcher(): void {
    if (this.stopped) return;

    let child: ChildProcess;
    try {
      child = spawn(
        resolvePowerShellPath(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WATCHER_SCRIPT],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (error) {
      this.handleExit(`could not start PowerShell: ${(error as Error).message}`);
      return;
    }

    this.child = child;
    this.stdoutBuffer = '';

    child.stdout?.on('data', (chunk) => this.consume(chunk.toString()));

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        this.logger.debug({ stderr: text.slice(0, 300) }, 'Device watcher stderr');
      }
    });

    child.on('error', (error) => this.handleExit(error.message));
    child.on('close', (code) => this.handleExit(`watcher exited with code ${code}`));

    this.armSilenceTimer();
  }

  private consume(text: string): void {
    this.stdoutBuffer += text;

    const lines = this.stdoutBuffer.split(/\r?\n/);
    // Keep the trailing partial line for the next chunk.
    this.stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const [kind, ...rest] = trimmed.split(FS);

      switch (kind) {
        case 'READY': {
          const subscriptions = parseInt(rest[0] ?? '0', 10) || 0;
          this.running = true;
          this.restartAttempts = 0;
          this.lastEventAt = Date.now();
          this.logger.info({ subscriptions }, 'Device watcher active — printer changes are now detected immediately');
          this.emit('ready', { subscriptions });
          break;
        }

        case 'EVT':
          this.lastEventAt = Date.now();
          this.armSilenceTimer();
          this.queueChange(rest[0] ?? 'unknown');
          break;

        case 'HB':
          this.lastEventAt = Date.now();
          this.armSilenceTimer();
          break;

        case 'R':
          this.logger.debug({ subscription: rest[0] }, 'Device watcher subscription registered');
          break;

        case 'E':
          this.logger.warn(
            { subscription: rest[0], error: rest[1] },
            'A device watcher subscription could not be registered'
          );
          break;

        case 'F':
          this.logger.warn({ reason: rest[0] }, 'Device watcher could not subscribe to WMI events');
          break;

        default:
          break;
      }
    }
  }

  /**
   * Plugging in one printer produces a flurry of device events (hub, composite
   * device, interface, then the printer itself). Coalesce them so the service
   * reconciles once, after things have settled.
   */
  private queueChange(source: string): void {
    this.pendingSources.add(source);

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const sources = Array.from(this.pendingSources).join(',');
      this.pendingSources.clear();
      this.debounceTimer = null;
      this.emit('change', { source: sources });
    }, DEBOUNCE_MS);
  }

  private armSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.logger.warn('Device watcher went silent — restarting the subscription');
      this.restartNow();
    }, SILENCE_TIMEOUT_MS);
  }

  private restartNow(): void {
    if (this.child) {
      const child = this.child;
      this.child = null;
      try {
        child.kill();
      } catch {
        // Ignore.
      }
    }
    // The close handler drives the restart.
  }

  private handleExit(reason: string): void {
    this.child = null;
    this.running = false;
    this.clearTimers();

    if (this.stopped) return;

    this.restartAttempts += 1;

    // Exponential backoff, capped. The watcher is an optimisation, not a
    // requirement, so a permanently failing one must never spin.
    const delay = Math.min(
      RESTART_DELAY_MIN_MS * Math.pow(2, Math.min(this.restartAttempts - 1, 5)),
      RESTART_DELAY_MAX_MS
    );

    if (this.restartAttempts === 3) {
      this.logger.warn(
        { reason },
        'Device watcher keeps failing — falling back to polling for printer changes'
      );
      this.emit('unavailable', { reason });
    } else {
      this.logger.debug({ reason, delay }, 'Device watcher stopped; scheduling restart');
    }

    this.restartTimer = setTimeout(() => this.spawnWatcher(), delay);
  }
}

export default DeviceWatcher;
