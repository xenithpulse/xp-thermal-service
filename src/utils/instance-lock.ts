/**
 * Single-Instance Lock
 *
 * Two copies of this service running at once is not a harmless duplicate: the
 * second one takes the next free port via the startup fallback, so nothing
 * obviously fails, and then both hold independent in-memory copies of
 * config.json and overwrite each other. A printer configured in one instance
 * disappears when the other saves.
 *
 * That is not theoretical — it is exactly how a configured kitchen printer was
 * lost during development. The port fallback that makes the service resilient
 * to a busy port is also what hides a duplicate instance, so the duplicate has
 * to be caught explicitly.
 *
 * The lock is a file holding the owning PID.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE PID ALONE IS NOT ENOUGH
 *
 * A lock file that says "PID 5504 owns this" is only meaningful while PID 5504
 * is still the process that wrote it. Two things break that, and both happen on
 * a POS box:
 *
 *   1. The service is killed rather than stopped — a power cut, a taskkill, an
 *      out-of-memory abort — and the file survives with a PID in it.
 *
 *   2. Windows reuses process IDs aggressively. After the next boot that PID
 *      very plausibly belongs to some unrelated program.
 *
 * With a bare `process.kill(pid, 0)` check, the two together are permanent: the
 * service sees a live PID, concludes another copy is running, and exits with
 * code 4 a few seconds after every start. The wrapper respawns it, it exits
 * again, forever. From the outside it is a service that will not start and
 * reports nothing — and REINSTALLING DOES NOT FIX IT, because the lock lives in
 * the data directory the installer deliberately preserves.
 *
 * Measured on a client site: the print service would not start, the API never
 * answered, and a reinstall changed nothing.
 *
 * Three checks now have to agree before this process will stand down for
 * another one:
 *
 *   BOOT     a lock written before the machine last booted cannot belong to a
 *            running process. This is decisive and costs nothing.
 *   HEARTBEAT the owner rewrites the file every 30 seconds. A lock that has not
 *            been touched in 90 seconds has no live owner, whatever its PID
 *            says. This is what makes a crash self-healing within two minutes
 *            instead of never.
 *   PID      the original check, now the last word rather than the only one.
 *
 * The bias is still deliberately towards starting: a service that refuses to
 * run because of a file left behind by a power cut is far worse than the
 * duplicate it is guarding against.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface LockInfo {
  pid: number;
  startedAt: string;
  script: string;
  port?: number;
  /** Refreshed by the owner every HEARTBEAT_INTERVAL_MS while it runs. */
  heartbeatAt?: string;
}

export interface LockResult {
  acquired: boolean;
  /** Populated when another live instance owns the lock. */
  heldBy?: LockInfo;
  reason: string;
}

/** How often the owning process refreshes its heartbeat. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How old a heartbeat may be before the lock is considered abandoned.
 *
 * Three missed beats. Generous on purpose: this box is a POS terminal that can
 * be paging heavily during service, and a process that is merely slow must not
 * have its lock stolen by a second copy.
 */
const HEARTBEAT_STALE_MS = 90_000;

/** Tolerance for clock skew when comparing a timestamp against boot time. */
const BOOT_SKEW_MS = 60_000;

/** When did this machine last boot? */
function bootTimeMs(): number {
  return Date.now() - os.uptime() * 1000;
}

/** Is a process with this pid currently alive? */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;

  try {
    // Signal 0 performs the permission/existence check without delivering
    // anything. On Windows this maps to an OpenProcess check.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the process exists but belongs to another user — for our
    // purposes that still counts as "something is running".
    return code === 'EPERM';
  }
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export class InstanceLock {
  private readonly lockPath: string;
  private acquired = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private info: LockInfo | null = null;

  constructor(lockPath?: string) {
    this.lockPath = lockPath ?? InstanceLock.defaultPath();
  }

  static defaultPath(): string {
    return path.join(process.cwd(), 'data', 'service.lock');
  }

  get path(): string {
    return this.lockPath;
  }

  /**
   * Does this lock have a live owner, or is it debris?
   *
   * Returns the reason it is considered dead, or null if it looks alive. The
   * reason is returned rather than logged so the caller can put it in the one
   * message a technician will actually read.
   */
  private staleReason(holder: LockInfo): string | null {
    const started = parseTime(holder.startedAt);
    const boot = bootTimeMs();

    // 1. Written before this boot. Nothing that old is still running.
    if (started !== null && started < boot - BOOT_SKEW_MS) {
      return `it was written at ${holder.startedAt}, before this machine last booted`;
    }

    // 2. Heartbeat gone cold. Only applies to locks that carry one: a lock
    //    written by an older build has no heartbeat and falls through to the
    //    PID check, exactly as it did before.
    const beat = parseTime(holder.heartbeatAt);
    if (beat !== null) {
      const age = Date.now() - beat;
      if (age > HEARTBEAT_STALE_MS) {
        return `its owner (process ${holder.pid}) stopped updating it ${Math.round(age / 1000)}s ago`;
      }
    }

    // 3. The PID itself.
    if (!isProcessAlive(holder.pid)) {
      return `process ${holder.pid} no longer exists`;
    }

    return null;
  }

  /**
   * Try to become the single running instance, waiting out a handover.
   *
   * A restart is by far the most common lifecycle event here, and during one the
   * outgoing process still holds the lock while it drains in-flight receipts.
   * The service wrapper starts the replacement before that finishes, so a lock
   * that refuses immediately would turn every restart into a dead service.
   *
   * Waiting fixes that without weakening the guarantee much: a genuine second
   * copy simply fails a few seconds later instead of instantly.
   */
  async acquire(port?: number, waitForHandoverMs = 20000): Promise<LockResult> {
    const deadline = Date.now() + Math.max(0, waitForHandoverMs);
    let holder: LockInfo | null = null;
    let staleNote = '';
    let announced = false;

    for (;;) {
      holder = this.read();

      if (!holder) break;

      const dead = this.staleReason(holder);
      if (dead) {
        staleNote = ` Replaced a stale lock left by process ${holder.pid}: ${dead}.`;
        break;
      }

      // Say something once, so a person running this by hand is not staring at
      // a silent process wondering whether it has hung.
      if (!announced) {
        announced = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[LOCK] Process ${holder.pid} still holds the instance lock; ` +
            `waiting up to ${Math.round(waitForHandoverMs / 1000)}s for it to exit...`
        );
      }
      if (Date.now() >= deadline) {
        return {
          acquired: false,
          heldBy: holder,
          reason:
            `Another XP Thermal Service is already running (process ${holder.pid}, started ` +
            `${holder.startedAt}, last heartbeat ${holder.heartbeatAt ?? 'never'}), and it did not ` +
            `exit within ${Math.round(waitForHandoverMs / 1000)}s. Two instances would overwrite ` +
            `each other's configuration, so this one will not start. If nothing is really running, ` +
            `delete ${this.lockPath} — it will be treated as abandoned by itself within ` +
            `${Math.round(HEARTBEAT_STALE_MS / 1000)}s in any case.`
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    try {
      const dir = path.dirname(this.lockPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const now = new Date().toISOString();
      this.info = {
        pid: process.pid,
        startedAt: now,
        script: process.argv[1] ?? 'unknown',
        port,
        heartbeatAt: now
      };

      this.write(this.info);
      this.acquired = true;

      return { acquired: true, reason: `Instance lock acquired.${staleNote}` };
    } catch (error) {
      // An unwritable lock directory must not stop the service from printing.
      // Losing the duplicate check is a smaller problem than not starting.
      return {
        acquired: true,
        reason: `Could not write an instance lock (${(error as Error).message}); continuing without it.`
      };
    }
  }

  /**
   * Start refreshing the heartbeat.
   *
   * Called once the service is up. Unref'd, so it never keeps the process alive
   * on its own — a lock heartbeat must not be the reason a service that has
   * finished its work refuses to exit.
   */
  startHeartbeat(intervalMs = HEARTBEAT_INTERVAL_MS): void {
    if (!this.acquired || this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      if (!this.info) return;
      try {
        // Re-read first: if another process has taken the lock (which can only
        // happen if this one was considered abandoned), do not stamp our PID
        // back over theirs.
        const current = this.read();
        if (current && current.pid !== process.pid) {
          this.stopHeartbeat();
          return;
        }
        this.info.heartbeatAt = new Date().toISOString();
        this.write(this.info);
      } catch {
        // A filesystem hiccup is not worth failing a print run over. The next
        // tick tries again; three missed ticks make the lock look abandoned,
        // which is the safe direction to fail in.
      }
    }, intervalMs);

    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Record the port once the server has actually bound one. */
  updatePort(port: number): void {
    if (!this.acquired) return;
    try {
      const current = this.read();
      if (current && current.pid === process.pid) {
        this.info = { ...current, port, heartbeatAt: new Date().toISOString() };
        this.write(this.info);
      }
    } catch {
      // Informational only.
    }
  }

  /** Release the lock, but never remove one owned by a different process. */
  release(): void {
    this.stopHeartbeat();
    if (!this.acquired) return;
    this.acquired = false;

    try {
      const info = this.read();
      if (!info || info.pid === process.pid) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // A leftover lock is harmless: the next start detects the dead pid, the
      // cold heartbeat, or a boot in between.
    }
  }

  private write(info: LockInfo): void {
    fs.writeFileSync(this.lockPath, JSON.stringify(info, null, 2), 'utf8');
  }

  private read(): LockInfo | null {
    try {
      const raw = fs.readFileSync(this.lockPath, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw) as LockInfo;
      return Number.isInteger(parsed?.pid) ? parsed : null;
    } catch {
      // Missing, empty, or corrupt — treat as no lock at all.
      return null;
    }
  }
}

export default InstanceLock;
