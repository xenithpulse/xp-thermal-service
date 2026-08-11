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
 * The lock is a file holding the owning PID. It is deliberately forgiving about
 * stale locks: a service that was killed leaves the file behind, and refusing
 * to start after a hard reset would be far worse than the problem being solved.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface LockInfo {
  pid: number;
  startedAt: string;
  script: string;
  port?: number;
}

export interface LockResult {
  acquired: boolean;
  /** Populated when another live instance owns the lock. */
  heldBy?: LockInfo;
  reason: string;
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

export class InstanceLock {
  private readonly lockPath: string;
  private acquired = false;

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
    let announced = false;

    for (;;) {
      holder = this.read();

      if (!holder || !isProcessAlive(holder.pid)) break;

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
            `${holder.startedAt}), and it did not exit within ` +
            `${Math.round(waitForHandoverMs / 1000)}s. Two instances would overwrite each ` +
            `other's configuration, so this one will not start. Stop the other instance ` +
            `first, or use the Windows service rather than launching it by hand.`
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const existing = holder;

    const staleNote = existing
      ? ` Replaced a stale lock left by process ${existing.pid}.`
      : '';

    try {
      const dir = path.dirname(this.lockPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const info: LockInfo = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        script: process.argv[1] ?? 'unknown',
        port
      };

      fs.writeFileSync(this.lockPath, JSON.stringify(info, null, 2), 'utf8');
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

  /** Record the port once the server has actually bound one. */
  updatePort(port: number): void {
    if (!this.acquired) return;
    try {
      const info = this.read();
      if (info && info.pid === process.pid) {
        fs.writeFileSync(this.lockPath, JSON.stringify({ ...info, port }, null, 2), 'utf8');
      }
    } catch {
      // Informational only.
    }
  }

  /** Release the lock, but never remove one owned by a different process. */
  release(): void {
    if (!this.acquired) return;
    this.acquired = false;

    try {
      const info = this.read();
      if (!info || info.pid === process.pid) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // A leftover lock is harmless: the next start detects the dead pid.
    }
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
