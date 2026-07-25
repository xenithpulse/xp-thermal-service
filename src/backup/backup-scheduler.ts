/**
 * Backup Scheduler
 *
 * The POS "Server Management" dashboard is the single source of truth for
 * backup *policy* (which paths, retention, daily hour, enable/disable) and for
 * manual "Run Backup Now" requests. This scheduler polls the POS for that
 * policy, decides whether a run is due, executes it via {@link BackupManager},
 * and reports the outcome back so the dashboard shows real status.
 *
 * Polling (rather than the POS calling us) is deliberate: an admin may open the
 * dashboard from any device on the LAN, but the backup engine only runs on the
 * box. Going through the POS server means "Run Now" works from anywhere.
 */

import { Logger } from '../utils/logger';
import { BackupConfig, BackupRunResult } from '../types';
import { BackupManager, BackupTarget } from './backup-manager';

interface PosBackupPath {
  path: string;
  status?: string;
  backupRetention?: number;
}

interface PosConfig {
  backupEnabled?: boolean;
  backupHour?: number;
  backupPaths?: PosBackupPath[];
  backupRunRequestedAt?: string | null;
  backupRunRequestId?: string | null;
  lastBackupAt?: string | null;
  serverUrl?: string | null;
}

export interface BackupSchedulerStatus {
  enabled: boolean;
  running: boolean;
  lastPollAt: string | null;
  lastPollOk: boolean;
  lastError: string | null;
  lastRun: BackupRunResult | null;
  posBaseUrl: string;
  posLanUrl: string | null;
}

export class BackupScheduler {
  private config: BackupConfig;
  private manager: BackupManager;
  private logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  private lastHandledRequestKey: string | null = null;
  private lastScheduledYmd: string | null = null;

  private status: BackupSchedulerStatus = {
    enabled: false,
    running: false,
    lastPollAt: null,
    lastPollOk: false,
    lastError: null,
    lastRun: null,
    posBaseUrl: '',
    posLanUrl: null,
  };

  constructor(config: BackupConfig, manager: BackupManager, logger: Logger) {
    this.config = config;
    this.manager = manager;
    this.logger = logger;
    this.status.enabled = config.enabled;
    this.status.posBaseUrl = config.posBaseUrl;
  }

  start(): void {
    if (this.timer) return;
    if (!this.config.enabled) {
      this.logger.info('Backup scheduler disabled by config');
      return;
    }
    this.logger.info(
      { posBaseUrl: this.config.posBaseUrl, pollIntervalMs: this.config.pollIntervalMs },
      'Backup scheduler started'
    );
    // Poll once shortly after boot, then on the configured interval.
    this.timer = setInterval(() => void this.poll(), this.config.pollIntervalMs);
    this.timer.unref?.();
    setTimeout(() => void this.poll(), 5000).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus(): BackupSchedulerStatus {
    return { ...this.status, running: this.manager.isRunning() };
  }

  private ymd(d: Date): string {
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  private async fetchJson(url: string, init?: RequestInit): Promise<any> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json().catch(() => ({}));
    } finally {
      clearTimeout(t);
    }
  }

  private targetsFrom(cfg: PosConfig): BackupTarget[] {
    return (cfg.backupPaths ?? [])
      .filter((p) => p.path && p.status !== 'inactive')
      .map((p) => ({ path: p.path, retentionDays: Number(p.backupRetention) || 14 }));
  }

  /** One poll cycle: read POS policy, decide, maybe run, report. */
  private async poll(): Promise<void> {
    if (this.polling || this.manager.isRunning()) return;
    this.polling = true;
    try {
      const cfg: PosConfig = await this.fetchJson(
        `${this.config.posBaseUrl}/api/admin/server-config`
      );
      this.status.lastPollAt = new Date().toISOString();
      this.status.lastPollOk = true;
      this.status.lastError = null;
      // The POS reports the LAN address it was reached at — surface it so the
      // on-box dashboard can show "POS reachable at http://<ip>:8080".
      this.status.posLanUrl = cfg.serverUrl || this.status.posLanUrl;

      // 1) Manual "Run Backup Now" request from the dashboard.
      const requestKey = cfg.backupRunRequestedAt || null;
      if (requestKey && requestKey !== this.lastHandledRequestKey) {
        this.lastHandledRequestKey = requestKey;
        this.logger.info({ requestKey }, 'Manual backup requested from POS');
        await this.execute(cfg, cfg.backupRunRequestId || requestKey);
        return;
      }

      // 2) Scheduled daily run at the configured hour.
      if (cfg.backupEnabled) {
        const now = new Date();
        const today = this.ymd(now);
        const posRanToday = cfg.lastBackupAt
          ? this.ymd(new Date(cfg.lastBackupAt)) === today
          : false;
        const dueByHour = now.getHours() === Math.max(0, Math.min(23, cfg.backupHour ?? 2));
        if (dueByHour && this.lastScheduledYmd !== today && !posRanToday) {
          this.lastScheduledYmd = today;
          this.logger.info({ hour: cfg.backupHour }, 'Scheduled backup due');
          await this.execute(cfg);
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.status.lastPollAt = new Date().toISOString();
      this.status.lastPollOk = false;
      this.status.lastError = message;
      this.logger.debug({ error: message }, 'Backup poll failed (will retry)');
    } finally {
      this.polling = false;
    }
  }

  /** Force a run immediately using current POS policy (used by the local API). */
  async triggerNow(): Promise<BackupRunResult> {
    const cfg: PosConfig = await this.fetchJson(
      `${this.config.posBaseUrl}/api/admin/server-config`
    );
    return this.execute(cfg);
  }

  /** The configured backup directories, per current POS policy. */
  private async configuredDirs(): Promise<string[]> {
    const cfg: PosConfig = await this.fetchJson(
      `${this.config.posBaseUrl}/api/admin/server-config`
    );
    return (cfg.backupPaths ?? []).map((p) => p.path).filter(Boolean);
  }

  /** List available backup archives across all configured paths. */
  async listBackups() {
    const dirs = await this.configuredDirs();
    return this.manager.listBackups(dirs);
  }

  /**
   * Restore from a specific archive. Guards that the file lives inside a
   * configured backup path before touching the database.
   */
  async restore(file: string): Promise<{ success: boolean; message: string }> {
    const dirs = await this.configuredDirs();
    if (!this.manager.isWithin(file, dirs)) {
      return { success: false, message: 'Refused: file is outside the configured backup paths' };
    }
    return this.manager.restore(file);
  }

  private async execute(cfg: PosConfig, requestId?: string): Promise<BackupRunResult> {
    const targets = this.targetsFrom(cfg);
    const result = await this.manager.run(targets, requestId);
    this.status.lastRun = result;
    if (result.status === 'error') {
      this.logger.error({ message: result.message }, 'Backup finished with errors');
    } else {
      this.logger.info(
        { status: result.status, bytes: result.totalBytes },
        'Backup finished'
      );
    }
    await this.report(result);
    return result;
  }

  /** Push the outcome back to the POS so the dashboard reflects reality. */
  private async report(result: BackupRunResult): Promise<void> {
    try {
      await this.fetchJson(
        `${this.config.posBaseUrl}/api/admin/server-config/backups/report`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result),
        }
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn({ error: message }, 'Failed to report backup result to POS');
    }
  }
}

export default BackupScheduler;
