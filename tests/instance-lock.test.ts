/**
 * Tests for the single-instance guard.
 *
 * The failure it prevents: a second service starts, the port fallback hides the
 * duplicate, and both instances then overwrite each other's config.json until a
 * configured printer disappears.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InstanceLock } from '../src/utils/instance-lock';

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-lock-test-'));
  lockPath = path.join(dir, 'service.lock');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A pid that is almost certainly not in use. */
const DEAD_PID = 999999;

function writeLock(pid: number): void {
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid, startedAt: new Date().toISOString(), script: 'x' }),
    'utf8'
  );
}

describe('InstanceLock', () => {
  it('acquires a lock when none exists', async () => {
    const lock = new InstanceLock(lockPath);
    const result = await lock.acquire(undefined, 0);

    expect(result.acquired).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
  });

  it('refuses to start when a live process holds the lock', async () => {
    // This process is unquestionably alive.
    writeLock(process.pid);

    const result = await new InstanceLock(lockPath).acquire(undefined, 0);

    expect(result.acquired).toBe(false);
    expect(result.heldBy?.pid).toBe(process.pid);
    // The message has to be usable by whoever is reading the service log.
    expect(result.reason).toMatch(/already running/i);
    expect(result.reason).toMatch(/configuration/i);
  });

  it('takes over a stale lock left by a killed process', async () => {
    // A hard reset or a taskkill leaves the file behind. Refusing to start in
    // that situation would be worse than the duplicate it guards against.
    writeLock(DEAD_PID);

    const result = await new InstanceLock(lockPath).acquire(undefined, 0);

    expect(result.acquired).toBe(true);
    expect(result.reason).toMatch(/stale/i);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
  });

  it('treats a corrupt lock file as no lock', async () => {
    fs.writeFileSync(lockPath, 'not json at all', 'utf8');
    expect((await new InstanceLock(lockPath).acquire(undefined, 0)).acquired).toBe(true);
  });

  it('treats an empty lock file as no lock', async () => {
    fs.writeFileSync(lockPath, '', 'utf8');
    expect((await new InstanceLock(lockPath).acquire(undefined, 0)).acquired).toBe(true);
  });

  it('records the bound port once the server is listening', async () => {
    const lock = new InstanceLock(lockPath);
    await lock.acquire(undefined, 0);
    lock.updatePort(9101);

    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).port).toBe(9101);
  });

  it('releases its own lock', async () => {
    const lock = new InstanceLock(lockPath);
    await lock.acquire(undefined, 0);
    lock.release();

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('never deletes a lock owned by another process', async () => {
    const lock = new InstanceLock(lockPath);
    await lock.acquire(undefined, 0);

    // Another instance took over in the meantime.
    writeLock(DEAD_PID);
    lock.release();

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(DEAD_PID);
  });

  it('starts anyway when the lock cannot be written', async () => {
    // An unwritable location must not stop a till from printing; losing the
    // duplicate check is the lesser problem.
    const unwritable = path.join(dir, 'nope.txt', 'service.lock');
    fs.writeFileSync(path.join(dir, 'nope.txt'), 'x', 'utf8');

    const result = await new InstanceLock(unwritable).acquire(undefined, 0);

    expect(result.acquired).toBe(true);
    expect(result.reason).toMatch(/continuing without it/i);
  });

  it('release is a no-op when the lock was never acquired', async () => {
    expect(() => new InstanceLock(lockPath).release()).not.toThrow();
  });

  it('waits out a restart handover instead of refusing', async () => {
    // The regression this exists for: during a restart the outgoing process
    // still holds the lock while it drains, and the wrapper has already started
    // the replacement. Refusing immediately left the service permanently down.
    writeLock(process.pid);

    setTimeout(() => {
      // The outgoing process finishes draining and releases.
      fs.rmSync(lockPath, { force: true });
    }, 1200);

    const started = Date.now();
    const result = await new InstanceLock(lockPath).acquire(undefined, 15000);
    const waited = Date.now() - started;

    expect(result.acquired).toBe(true);
    expect(waited).toBeGreaterThanOrEqual(900);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
  });

  it('gives up once the handover window expires', async () => {
    // A genuine duplicate still fails — just later, not instantly.
    writeLock(process.pid);

    const result = await new InstanceLock(lockPath).acquire(undefined, 2000);

    expect(result.acquired).toBe(false);
    expect(result.reason).toMatch(/did not exit within/i);
  });

  /**
   * The client-site failure this guard caused rather than prevented.
   *
   * The service is killed hard, the lock survives with a PID in it, the box
   * reboots, and Windows hands that same PID to something else. A PID-only
   * check then reads "another copy is running" and the service exits four
   * seconds after every start - through a reinstall, because the lock lives in
   * the data directory the installer preserves.
   */
  describe('a lock that outlived its owner', () => {
    /** A pid that IS alive, standing in for the unrelated process that inherited it. */
    const REUSED_PID = process.pid;

    function writeLockAt(pid: number, startedAt: Date, heartbeatAt?: Date): void {
      const info: Record<string, unknown> = {
        pid,
        startedAt: startedAt.toISOString(),
        script: 'x'
      };
      if (heartbeatAt) info.heartbeatAt = heartbeatAt.toISOString();
      fs.writeFileSync(lockPath, JSON.stringify(info), 'utf8');
    }

    it('takes over a lock written before the machine booted, live pid or not', async () => {
      // Older than uptime, so it cannot belong to anything running now.
      const beforeBoot = new Date(Date.now() - (os.uptime() * 1000 + 10 * 60_000));
      writeLockAt(REUSED_PID, beforeBoot);

      const result = await new InstanceLock(lockPath).acquire(undefined, 0);

      expect(result.acquired).toBe(true);
      expect(result.reason).toMatch(/before this machine last booted/i);
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
    });

    it('takes over a lock whose heartbeat has gone cold', async () => {
      // Same boot, live pid, but the owner stopped updating it three minutes
      // ago - so the owner is gone and the pid belongs to someone else.
      writeLockAt(REUSED_PID, new Date(Date.now() - 5 * 60_000), new Date(Date.now() - 3 * 60_000));

      const result = await new InstanceLock(lockPath).acquire(undefined, 0);

      expect(result.acquired).toBe(true);
      expect(result.reason).toMatch(/stopped updating it/i);
    });

    it('still stands down for an owner that is beating', async () => {
      // The guarantee this class exists for has to survive the fix.
      writeLockAt(REUSED_PID, new Date(Date.now() - 5 * 60_000), new Date());

      const result = await new InstanceLock(lockPath).acquire(undefined, 0);

      expect(result.acquired).toBe(false);
      expect(result.reason).toMatch(/already running/i);
    });

    it('refreshes its own heartbeat so the next start can tell it is alive', async () => {
      const lock = new InstanceLock(lockPath);
      await lock.acquire(undefined, 0);

      const first = JSON.parse(fs.readFileSync(lockPath, 'utf8')).heartbeatAt;
      expect(first).toBeTruthy();

      lock.startHeartbeat(50);
      await new Promise((resolve) => setTimeout(resolve, 160));
      const second = JSON.parse(fs.readFileSync(lockPath, 'utf8')).heartbeatAt;
      lock.release();

      expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
    });

    it('stops beating rather than stamping over a lock another process took', async () => {
      const lock = new InstanceLock(lockPath);
      await lock.acquire(undefined, 0);
      lock.startHeartbeat(50);

      // A replacement decided this one was abandoned and claimed the lock.
      writeLockAt(DEAD_PID, new Date(), new Date());
      await new Promise((resolve) => setTimeout(resolve, 160));

      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(DEAD_PID);
      lock.release();
    });
  });
});
