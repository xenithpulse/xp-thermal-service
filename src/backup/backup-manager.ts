/**
 * Backup Manager
 *
 * Produces a MongoDB dump of the POS database and copies it to one or more
 * destination paths (local folder, external/USB drive, or network share),
 * enforcing per-path retention.
 *
 * The dump runs the bundled `mongodump.exe` directly against the POS database
 * on loopback. This service, running natively on Windows, is the component that
 * can write those dumps to real Windows drives / USB / UNC shares — which is
 * why backups live here.
 *
 * ── Migrated from Docker ────────────────────────────────────────────────────
 * This previously ran `docker exec <container> mongodump`, locating the
 * container by its compose service label, because MongoDB lived in a container
 * whose port was never published to the host. The POS is now a set of native
 * Windows services: mongod listens on 127.0.0.1:27017 and there is no container
 * to exec into. The streaming, timeout, retention and multi-destination logic
 * below is unchanged — only the process being spawned is different.
 *
 * mongodump.exe and mongorestore.exe are shipped by the XP POS installer under
 * <install dir>\mongodb\bin (see installer/deps.json in the POS repo). They are
 * a separate download from the MongoDB server archive and are easy to forget.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { BackupConfig, BackupPathResult, BackupRunResult, BackupOutcome } from '../types';

export interface BackupTarget {
  path: string;
  retentionDays: number;
}

export class BackupManager {
  private config: BackupConfig;
  private logger: Logger;
  private running = false;

  constructor(config: BackupConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  setConfig(config: BackupConfig): void {
    this.config = config;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** File extension the dump archive uses, given the gzip setting. */
  private archiveExt(): string {
    return this.config.mongo.gzip ? '.archive.gz' : '.archive';
  }

  private timestamp(d = new Date()): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    );
  }

  private matchesBackup(file: string): boolean {
    return file.startsWith(`${this.config.filenamePrefix}-`) && file.endsWith(this.archiveExt());
  }

  /**
   * Absolute path to one of the bundled MongoDB tools.
   *
   * Resolved and existence-checked up front so a missing or mis-pathed install
   * fails with something a technician can act on, rather than Windows' bare
   * ENOENT from spawn(). Replaces the old container-discovery step.
   */
  private toolPath(tool: 'mongodump' | 'mongorestore'): string {
    const exe = process.platform === 'win32' ? `${tool}.exe` : tool;
    const full = path.join(this.config.mongo.binDir, exe);
    if (!fs.existsSync(full)) {
      throw new Error(
        `${exe} not found at ${full}. ` +
          `Check backup.mongo.binDir in config.json - it should point at the ` +
          `mongodb\\bin folder inside the XP POS install directory.`
      );
    }
    return full;
  }

  /** Connection arguments shared by mongodump and mongorestore. */
  private connectionArgs(): string[] {
    return [
      '--host',
      this.config.mongo.host,
      '--port',
      String(this.config.mongo.port),
    ];
  }

  /**
   * Stream `mongodump --archive` into a local temp file. Returns the temp path.
   *
   * `--archive` with no value makes mongodump write the archive to stdout,
   * which is what lets us pipe straight to disk. That is the same contract the
   * Docker version relied on, so the streaming below is unchanged.
   */
  private dumpToTempFile(): Promise<string> {
    const tmpFile = path.join(
      os.tmpdir(),
      `${this.config.filenamePrefix}-${this.timestamp()}${this.archiveExt()}`
    );

    const exe = this.toolPath('mongodump');
    const args = [
      ...this.connectionArgs(),
      '--archive',
      `--db=${this.config.mongo.database}`,
    ];
    if (this.config.mongo.gzip) args.push('--gzip');

    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmpFile);
      const child = spawn(exe, args, { windowsHide: true });
      let err = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        out.destroy();
        fs.promises.rm(tmpFile, { force: true }).catch(() => undefined);
        reject(new Error(`mongodump timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);

      child.stdout.pipe(out);
      child.stderr.on('data', (d) => (err += d.toString()));
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Failed to run mongodump: ${e.message}`));
      });
      child.on('close', (code) => {
        if (settled) return;
        clearTimeout(timer);
        out.end(() => {
          if (code === 0) {
            resolve(tmpFile);
          } else {
            settled = true;
            fs.promises.rm(tmpFile, { force: true }).catch(() => undefined);
            reject(new Error(err.trim() || `mongodump exited with code ${code}`));
          }
        });
      });
    });
  }

  private async prune(dir: string, retentionDays: number): Promise<void> {
    if (!retentionDays || retentionDays <= 0) return;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let entries: string[] = [];
    try {
      entries = await fs.promises.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!this.matchesBackup(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = await fs.promises.stat(full);
        if (st.mtimeMs < cutoff) {
          await fs.promises.rm(full, { force: true });
          this.logger.info({ file: full }, 'Pruned expired backup');
        }
      } catch {
        // skip files we can't stat/remove
      }
    }
  }

  private async pathUsage(dir: string): Promise<number> {
    let total = 0;
    let entries: string[] = [];
    try {
      entries = await fs.promises.readdir(dir);
    } catch {
      return 0;
    }
    for (const name of entries) {
      if (!this.matchesBackup(name)) continue;
      try {
        const st = await fs.promises.stat(path.join(dir, name));
        total += st.size;
      } catch {
        // ignore
      }
    }
    return total;
  }

  /** Whether a file path sits inside one of the given directories. */
  isWithin(file: string, dirs: string[]): boolean {
    const resolved = path.resolve(file);
    return dirs.some((d) => {
      const base = path.resolve(d);
      return resolved === base || resolved.startsWith(base + path.sep);
    });
  }

  /** List the backup archives present in each directory, newest first. */
  async listBackups(
    dirs: string[]
  ): Promise<{ path: string; files: { name: string; sizeBytes: number; mtime: string }[] }[]> {
    const out: { path: string; files: { name: string; sizeBytes: number; mtime: string }[] }[] = [];
    for (const dir of dirs) {
      const files: { name: string; sizeBytes: number; mtime: string }[] = [];
      let entries: string[] = [];
      try {
        entries = await fs.promises.readdir(dir);
      } catch {
        out.push({ path: dir, files });
        continue;
      }
      for (const name of entries) {
        if (!this.matchesBackup(name)) continue;
        try {
          const st = await fs.promises.stat(path.join(dir, name));
          files.push({ name, sizeBytes: st.size, mtime: new Date(st.mtimeMs).toISOString() });
        } catch {
          // ignore
        }
      }
      files.sort((a, b) => b.mtime.localeCompare(a.mtime));
      out.push({ path: dir, files });
    }
    return out;
  }

  /**
   * Restore the POS database from a backup archive. DESTRUCTIVE: drops the
   * target collections first. Streams the archive into mongorestore's stdin.
   */
  async restore(archiveFile: string): Promise<{ success: boolean; message: string }> {
    if (this.running) {
      return { success: false, message: 'A backup/restore is already in progress' };
    }
    if (!fs.existsSync(archiveFile)) {
      return { success: false, message: `Backup file not found: ${archiveFile}` };
    }

    this.running = true;
    try {
      const exe = this.toolPath('mongorestore');
      const db = this.config.mongo.database;
      // `--archive` with no value makes mongorestore read from stdin, which the
      // pipe below feeds. Same contract as the previous `docker exec -i` form.
      const args = [
        ...this.connectionArgs(),
        '--archive',
        '--drop',
        `--nsInclude=${db}.*`,
      ];
      if (this.config.mongo.gzip) args.push('--gzip');

      this.logger.warn(
        { archiveFile, host: this.config.mongo.host, port: this.config.mongo.port },
        'Starting DB restore (destructive)'
      );

      await new Promise<void>((resolve, reject) => {
        const child = spawn(exe, args, { windowsHide: true });
        let err = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`mongorestore timed out after ${this.config.timeoutMs}ms`));
        }, this.config.timeoutMs);
        child.stderr.on('data', (d) => (err += d.toString()));
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(new Error(`Failed to run mongorestore: ${e.message}`));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(err.trim() || `mongorestore exited with code ${code}`));
        });
        fs.createReadStream(archiveFile).pipe(child.stdin);
      });

      this.logger.warn({ archiveFile }, 'DB restore completed');
      return { success: true, message: 'Database restored successfully' };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ error: message }, 'DB restore failed');
      return { success: false, message };
    } finally {
      this.running = false;
    }
  }

  /**
   * Produce one dump and fan it out to every target path. A path that fails
   * (offline USB, unreachable share) is reported as an error without aborting
   * the others — the overall run is 'partial' in that case.
   */
  async run(targets: BackupTarget[], requestId?: string): Promise<BackupRunResult> {
    const startedAt = new Date().toISOString();

    if (this.running) {
      return {
        requestId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: 'error',
        message: 'A backup is already in progress',
        totalBytes: 0,
        paths: [],
      };
    }

    if (!targets.length) {
      return {
        requestId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: 'error',
        message: 'No backup paths are configured',
        totalBytes: 0,
        paths: [],
      };
    }

    this.running = true;
    let tmpFile: string | null = null;
    const filename = `${this.config.filenamePrefix}-${this.timestamp()}${this.archiveExt()}`;
    const pathResults: BackupPathResult[] = [];
    let totalBytes = 0;

    try {
      this.logger.info(
        {
          host: this.config.mongo.host,
          port: this.config.mongo.port,
          database: this.config.mongo.database,
          targets: targets.length,
        },
        'Starting backup'
      );
      tmpFile = await this.dumpToTempFile();
      totalBytes = (await fs.promises.stat(tmpFile)).size;

      for (const target of targets) {
        const nowIso = new Date().toISOString();
        try {
          await fs.promises.mkdir(target.path, { recursive: true });
          await fs.promises.copyFile(tmpFile, path.join(target.path, filename));
          await this.prune(target.path, target.retentionDays);
          pathResults.push({
            path: target.path,
            status: 'active',
            sizeBytes: await this.pathUsage(target.path),
            lastBackupTime: nowIso,
          });
          this.logger.info({ path: target.path }, 'Backup written');
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          pathResults.push({
            path: target.path,
            status: 'error',
            sizeBytes: 0,
            lastBackupTime: nowIso,
            error: message,
          });
          this.logger.error({ path: target.path, error: message }, 'Backup to path failed');
        }
      }

      const okCount = pathResults.filter((p) => p.status === 'active').length;
      const status: BackupOutcome =
        okCount === 0 ? 'error' : okCount < targets.length ? 'partial' : 'success';

      return {
        requestId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status,
        message:
          status === 'success'
            ? `Backup written to ${okCount} path(s)`
            : status === 'partial'
            ? `Backup written to ${okCount}/${targets.length} path(s); some failed`
            : 'Backup failed for all configured paths',
        totalBytes,
        paths: pathResults,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ error: message }, 'Backup run failed');
      return {
        requestId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: 'error',
        message,
        totalBytes,
        paths: pathResults,
      };
    } finally {
      if (tmpFile) {
        await fs.promises.rm(tmpFile, { force: true }).catch(() => undefined);
      }
      this.running = false;
    }
  }
}

export default BackupManager;
