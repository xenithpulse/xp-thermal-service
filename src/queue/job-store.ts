/**
 * Job Store - SQLite-based persistence for print jobs
 * Uses sql.js (pure JavaScript SQLite) for no native dependencies
 */

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';
import {
  PrintJob,
  JobStatus,
  JobPriority,
  TemplateType
} from '../types';
import { Logger } from '../utils/logger';

export interface JobStoreConfig {
  dbPath: string;
  maxJobAgeMs: number;
  cleanupIntervalMs: number;
}

export class JobStore {
  private db: SqlJsDatabase | null = null;
  private SQL: any = null;
  private logger: Logger;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly maxJobAgeMs: number;
  private readonly dbPath: string;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private dirty = false;
  private recovering = false;

  constructor(config: JobStoreConfig, logger: Logger) {
    this.logger = logger;
    this.maxJobAgeMs = config.maxJobAgeMs;
    this.dbPath = config.dbPath;

    // Ensure directory exists
    const dbDir = path.dirname(config.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Start initialization
    this.initPromise = this.initialize(config.cleanupIntervalMs);
  }

  private async initialize(cleanupIntervalMs: number): Promise<void> {
    try {
      this.SQL = await initSqlJs();

      // Load existing database or create new one
      if (fs.existsSync(this.dbPath)) {
        try {
          const buffer = fs.readFileSync(this.dbPath);
          this.db = new this.SQL.Database(buffer);
          
          // Validate database integrity
          const integrityCheck = this.db!.exec("PRAGMA integrity_check");
          if (integrityCheck.length > 0 && integrityCheck[0].values[0][0] !== 'ok') {
            throw new Error(`Database integrity check failed: ${integrityCheck[0].values[0][0]}`);
          }
          
          this.logger.info(`Loaded existing database: ${this.dbPath}`);
        } catch (loadError) {
          // Database corrupted - backup and recreate
          this.logger.error(`Database corrupted, creating fresh database: ${loadError}`);
          await this.handleCorruptDatabase(this.SQL);
        }
      } else {
        this.db = new this.SQL.Database();
        this.logger.info(`Created new database: ${this.dbPath}`);
      }

      this.initSchema();
      this.recoverStaleJobs();

      // Start cleanup timer
      if (cleanupIntervalMs > 0) {
        this.startCleanupTimer(cleanupIntervalMs);
      }

      // Start periodic save timer (every 5 seconds if dirty)
      this.saveTimer = setInterval(() => {
        if (this.dirty) {
          this.saveToFile();
        }
      }, 5000);

      this.initialized = true;
      this.logger.info(`Job store initialized: ${this.dbPath}`);
    } catch (error) {
      this.logger.error('Failed to initialize job store:', error);
      throw error;
    }
  }

  /**
   * Handle corrupted database by backing up and creating fresh one
   */
  private async handleCorruptDatabase(SQL: any): Promise<void> {
    // Backup corrupted database
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = this.dbPath.replace('.db', `.corrupted.${timestamp}.db`);
    
    try {
      fs.copyFileSync(this.dbPath, backupPath);
      this.logger.warn(`Corrupted database backed up to: ${backupPath}`);
    } catch (backupError) {
      this.logger.warn(`Could not backup corrupted database: ${backupError}`);
    }
    
    // Remove corrupted database
    try {
      fs.unlinkSync(this.dbPath);
    } catch {
      // Ignore
    }
    
    // Create fresh database
    this.db = new SQL.Database();
    this.logger.info('Created fresh database after corruption recovery');
  }

  /**
   * Safely execute a database operation. If the WASM memory is corrupted
   * (e.g. after long idle / Windows sleep), automatically rebuild the
   * in-memory database from the last saved file and retry once.
   */
  private safeDbOp<T>(op: () => T): T {
    try {
      return op();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Detect WASM / native corruption errors
      if (msg.includes('memory access out of bounds') ||
          msg.includes('null function') ||
          msg.includes('unreachable') ||
          msg.includes('table index is out of bounds')) {
        this.logger.warn(`WASM crash detected ("${msg}"), rebuilding database...`);
        this.rebuildDatabase();
        // Retry operation once after rebuild
        return op();
      }
      throw err;
    }
  }

  /**
   * Rebuild the in-memory database from the last saved file on disk.
   */
  private rebuildDatabase(): void {
    if (this.recovering) return;
    this.recovering = true;

    try {
      // Close the broken handle
      try { this.db?.close(); } catch { /* already broken */ }
      this.db = null;

      if (fs.existsSync(this.dbPath) && this.SQL) {
        const buffer = fs.readFileSync(this.dbPath);
        this.db = new this.SQL.Database(buffer);
        this.logger.info('Database rebuilt from disk successfully');
      } else if (this.SQL) {
        this.db = new this.SQL.Database();
        this.initSchema();
        this.logger.warn('Database rebuilt as empty (no file on disk)');
      } else {
        throw new Error('sql.js not available for rebuild');
      }
    } catch (rebuildErr) {
      this.logger.error(`Database rebuild failed: ${rebuildErr}`);
      throw rebuildErr;
    } finally {
      this.recovering = false;
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized && this.initPromise) {
      await this.initPromise;
    }
    if (!this.db) {
      throw new Error('Database not initialized');
    }
  }

  private initSchema(): void {
    if (!this.db) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE NOT NULL,
        printer_id TEXT NOT NULL,
        template_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        priority INTEGER DEFAULT 1,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        scheduled_at INTEGER,
        started_at INTEGER,
        completed_at INTEGER,
        error TEXT,
        raw_commands BLOB,
        metadata TEXT
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_printer ON jobs(printer_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_priority_created ON jobs(priority DESC, created_at ASC)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs(idempotency_key)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_scheduled ON jobs(scheduled_at)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS job_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        status TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        details TEXT
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_history_job ON job_history(job_id)`);

    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private saveToFile(): void {
    if (!this.db || !this.dirty) return;

    try {
      this.safeDbOp(() => {
        const data = this.db!.export();
        const buffer = Buffer.from(data);
        // Atomic write: write to temp file then rename
        const tempPath = this.dbPath + '.tmp';
        fs.writeFileSync(tempPath, buffer);
        fs.renameSync(tempPath, this.dbPath);
        this.dirty = false;
      });
    } catch (error) {
      this.logger.error('Failed to save database:', error);
    }
  }

  /**
   * Recover jobs that were in-progress when service crashed
   */
  private recoverStaleJobs(): void {
    if (!this.db) return;

    const now = Date.now();
    const cutoff = now - 60000; // Jobs not updated in last minute

    const staleJobs = this.db.exec(`
      SELECT id FROM jobs 
      WHERE status IN ('processing', 'printing')
        AND updated_at < ?
    `, [cutoff]);

    if (staleJobs.length > 0 && staleJobs[0].values.length > 0) {
      const count = staleJobs[0].values.length;
      this.logger.warn(`Found ${count} stale jobs, resetting to retry`);

      for (const row of staleJobs[0].values) {
        const id = row[0] as string;
        this.db.run(`
          UPDATE jobs SET
            status = 'retry_scheduled',
            scheduled_at = ${now + 5000},
            updated_at = ${now}
          WHERE id = ?
        `, [id]);
        this.addHistorySync(id, 'retry_scheduled', 'Recovered after service restart');
      }
      this.markDirty();
    }
  }

  /**
   * Wait for initialization to complete
   */
  async waitForInit(): Promise<void> {
    await this.ensureInitialized();
  }

  /**
   * Create a new job (insert if not duplicate)
   */
  create(job: PrintJob): { created: boolean; job: PrintJob } {
    if (!this.db) throw new Error('Database not initialized');

    // Check for existing job with same idempotency key
    const existing = this.getByIdempotencyKey(job.idempotencyKey);
    if (existing) {
      return { created: false, job: existing };
    }

    return this.safeDbOp(() => {
      try {
        this.db!.run(`
          INSERT INTO jobs (
            id, idempotency_key, printer_id, template_type, payload, priority,
            status, attempts, max_attempts, created_at, updated_at, scheduled_at,
            started_at, completed_at, error, raw_commands, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          job.id,
          job.idempotencyKey,
          job.printerId,
          job.templateType,
          JSON.stringify(job.payload),
          job.priority,
          job.status,
          job.attempts,
          job.maxAttempts,
          job.createdAt,
          job.updatedAt,
          job.scheduledAt || null,
          job.startedAt || null,
          job.completedAt || null,
          job.error || null,
          job.rawCommands || null,
          job.metadata ? JSON.stringify(job.metadata) : null
        ]);

        this.addHistorySync(job.id, job.status, 'Job created');
        this.markDirty();
        return { created: true, job };
      } catch (error) {
        // Handle race condition with unique constraint
        if ((error as Error).message.includes('UNIQUE constraint failed')) {
          const existingJob = this.getByIdempotencyKey(job.idempotencyKey);
          if (existingJob) {
            return { created: false, job: existingJob };
          }
        }
        throw error;
      }
    });
  }

  /**
   * Update a job
   */
  update(job: PrintJob): void {
    if (!this.db) throw new Error('Database not initialized');

    this.safeDbOp(() => {
      this.db!.run(`
        UPDATE jobs SET
          status = ?,
          attempts = ?,
          updated_at = ?,
          scheduled_at = ?,
          started_at = ?,
          completed_at = ?,
          error = ?,
          raw_commands = ?,
          metadata = ?
        WHERE id = ?
      `, [
        job.status,
        job.attempts,
        job.updatedAt,
        job.scheduledAt || null,
        job.startedAt || null,
        job.completedAt || null,
        job.error || null,
        job.rawCommands || null,
        job.metadata ? JSON.stringify(job.metadata) : null,
        job.id
      ]);

      this.addHistorySync(job.id, job.status, job.error || undefined);
      this.markDirty();
    });
  }

  /**
   * Get job by ID
   */
  getById(id: string): PrintJob | null {
    if (!this.db) return null;

    return this.safeDbOp(() => {
      const result = this.db!.exec('SELECT * FROM jobs WHERE id = ?', [id]);
      if (result.length === 0 || result[0].values.length === 0) {
        return null;
      }

      return this.rowToJob(result[0].columns, result[0].values[0]);
    });
  }

  /**
   * Get job by idempotency key
   */
  getByIdempotencyKey(key: string): PrintJob | null {
    if (!this.db) return null;

    return this.safeDbOp(() => {
      const result = this.db!.exec('SELECT * FROM jobs WHERE idempotency_key = ?', [key]);
      if (result.length === 0 || result[0].values.length === 0) {
        return null;
      }

      return this.rowToJob(result[0].columns, result[0].values[0]);
    });
  }

  /**
   * Get pending jobs ready to be processed
   */
  getPending(limit = 100): PrintJob[] {
    if (!this.db) return [];

    return this.safeDbOp(() => {
      const now = Date.now();
      const result = this.db!.exec(`
        SELECT * FROM jobs 
        WHERE status IN ('pending', 'queued', 'retry_scheduled')
          AND (scheduled_at IS NULL OR scheduled_at <= ?)
        ORDER BY priority DESC, created_at ASC
        LIMIT ?
      `, [now, limit]);

      if (result.length === 0) return [];
      return result[0].values.map(row => this.rowToJob(result[0].columns, row));
    });
  }

  /**
   * Get jobs by status
   */
  getByStatus(status: JobStatus, limit = 100): PrintJob[] {
    if (!this.db) return [];

    return this.safeDbOp(() => {
      const result = this.db!.exec(`
        SELECT * FROM jobs WHERE status = ?
        ORDER BY created_at DESC
        LIMIT ?
      `, [status, limit]);

      if (result.length === 0) return [];
      return result[0].values.map(row => this.rowToJob(result[0].columns, row));
    });
  }

  /**
   * Get jobs by printer
   */
  getByPrinter(printerId: string, limit = 100): PrintJob[] {
    if (!this.db) return [];

    return this.safeDbOp(() => {
      const result = this.db!.exec(`
        SELECT * FROM jobs WHERE printer_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `, [printerId, limit]);

      if (result.length === 0) return [];
      return result[0].values.map(row => this.rowToJob(result[0].columns, row));
    });
  }

  /**
   * Delete a job
   */
  delete(id: string): void {
    if (!this.db) return;

    this.safeDbOp(() => {
      this.db!.run('DELETE FROM jobs WHERE id = ?', [id]);
      this.db!.run('DELETE FROM job_history WHERE job_id = ?', [id]);
      this.markDirty();
    });
  }

  /**
   * Get job counts by status
   */
  getCounts(): {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  } {
    if (!this.db) {
      return { total: 0, pending: 0, processing: 0, completed: 0, failed: 0 };
    }

    return this.safeDbOp(() => {
      const result = this.db!.exec(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM jobs
      `);

      if (result.length === 0) {
        return { total: 0, pending: 0, processing: 0, completed: 0, failed: 0 };
      }

      const row = result[0].values[0];
      return {
        total: (row[0] as number) || 0,
        pending: (row[1] as number) || 0,
        processing: (row[2] as number) || 0,
        completed: (row[3] as number) || 0,
        failed: (row[4] as number) || 0
      };
    });
  }

  /**
   * Mark job as started
   */
  markStarted(id: string): void {
    if (!this.db) return;

    this.safeDbOp(() => {
      const now = Date.now();
      this.db!.run(`
        UPDATE jobs SET
          status = 'processing',
          started_at = ?,
          updated_at = ?
        WHERE id = ?
      `, [now, now, id]);
      this.addHistorySync(id, 'processing', 'Job started processing');
      this.markDirty();
    });
  }

  /**
   * Mark job as printing
   */
  markPrinting(id: string): void {
    if (!this.db) return;

    this.safeDbOp(() => {
      const now = Date.now();
      this.db!.run(`
        UPDATE jobs SET
          status = 'printing',
          updated_at = ?
        WHERE id = ?
      `, [now, id]);
      this.addHistorySync(id, 'printing', 'Sending to printer');
      this.markDirty();
    });
  }

  /**
   * Mark job as completed
   */
  markCompleted(id: string): void {
    if (!this.db) return;

    this.safeDbOp(() => {
      const now = Date.now();
      this.db!.run(`
        UPDATE jobs SET
          status = 'completed',
          completed_at = ?,
          updated_at = ?,
          error = NULL
        WHERE id = ?
      `, [now, now, id]);
      this.addHistorySync(id, 'completed', 'Job completed successfully');
      this.markDirty();
    });
  }

  /**
   * Mark job as failed
   */
  markFailed(id: string, error: string, willRetry: boolean): void {
    if (!this.db) return;

    this.safeDbOp(() => {
      const now = Date.now();
      const status = willRetry ? 'retry_scheduled' : 'failed';

      this.db!.run(`
        UPDATE jobs SET
          status = ?,
          attempts = attempts + 1,
          updated_at = ?,
          error = ?
        WHERE id = ?
      `, [status, now, error, id]);

      this.addHistorySync(id, status, error);
      this.markDirty();
    });
  }

  /**
   * Schedule retry for a job
   */
  scheduleRetry(id: string, delayMs: number): void {
    if (!this.db) return;

    this.safeDbOp(() => {
      const now = Date.now();
      this.db!.run(`
        UPDATE jobs SET
          status = 'retry_scheduled',
          scheduled_at = ?,
          updated_at = ?
        WHERE id = ?
      `, [now + delayMs, now, id]);
      this.addHistorySync(id, 'retry_scheduled', `Retry scheduled in ${delayMs}ms`);
      this.markDirty();
    });
  }

  /**
   * Move job to dead letter queue
   */
  moveToDeadLetter(id: string): void {
    if (!this.db) return;

    this.safeDbOp(() => {
      const now = Date.now();
      this.db!.run(`
        UPDATE jobs SET
          status = 'dead_letter',
          updated_at = ?
        WHERE id = ?
      `, [now, id]);
      this.addHistorySync(id, 'dead_letter', 'Moved to dead letter queue after max retries');
      this.markDirty();
    });
  }

  /**
   * Get job history
   */
  getHistory(jobId: string): Array<{
    status: string;
    timestamp: number;
    details?: string;
  }> {
    if (!this.db) return [];

    return this.safeDbOp(() => {
      const result = this.db!.exec(`
        SELECT status, timestamp, details 
        FROM job_history 
        WHERE job_id = ? 
        ORDER BY timestamp ASC
      `, [jobId]);

      if (result.length === 0) return [];

      return result[0].values.map(row => ({
        status: row[0] as string,
        timestamp: row[1] as number,
        details: row[2] as string | undefined
      }));
    });
  }

  /**
   * Add history entry (sync version)
   */
  private addHistorySync(jobId: string, status: string, details?: string): void {
    if (!this.db) return;

    try {
      this.db.run(`
        INSERT INTO job_history (job_id, status, timestamp, details)
        VALUES (?, ?, ?, ?)
      `, [jobId, status, Date.now(), details || null]);
    } catch {
      // History is non-critical — don't let it break the calling operation
    }
  }

  /**
   * Cleanup old completed jobs
   */
  cleanup(): number {
    if (!this.db) return 0;

    return this.safeDbOp(() => {
      const cutoff = Date.now() - this.maxJobAgeMs;

      const countResult = this.db!.exec(`
        SELECT COUNT(*) FROM jobs 
        WHERE status IN ('completed', 'dead_letter', 'cancelled')
          AND updated_at < ?
      `, [cutoff]);

      const count = countResult.length > 0 ? (countResult[0].values[0][0] as number) : 0;

      if (count > 0) {
        this.db!.run(`
          DELETE FROM jobs 
          WHERE status IN ('completed', 'dead_letter', 'cancelled')
            AND updated_at < ?
        `, [cutoff]);

        this.db!.run(`
          DELETE FROM job_history 
          WHERE job_id NOT IN (SELECT id FROM jobs)
        `);

        this.markDirty();
        this.logger.info(`Cleaned up ${count} old jobs`);
      }

      return count;
    });
  }

  /**
   * Start cleanup timer
   */
  private startCleanupTimer(intervalMs: number): void {
    this.cleanupTimer = setInterval(() => {
      try {
        this.cleanup();
      } catch (error) {
        this.logger.error('Cleanup error:', error);
      }
    }, intervalMs);
  }

  /**
   * Convert database row to PrintJob
   */
  private rowToJob(columns: string[], values: any[]): PrintJob {
    const row: Record<string, any> = {};
    columns.forEach((col, i) => {
      row[col] = values[i];
    });

    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      printerId: row.printer_id,
      templateType: row.template_type as TemplateType,
      payload: this.safeJsonParse(row.payload, {}),
      priority: row.priority as JobPriority,
      status: row.status as JobStatus,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      scheduledAt: row.scheduled_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      error: row.error,
      rawCommands: row.raw_commands ? Buffer.from(row.raw_commands) : undefined,
      metadata: row.metadata ? this.safeJsonParse(row.metadata, undefined) : undefined
    };
  }

  private safeJsonParse(data: string, fallback: any): any {
    try {
      return JSON.parse(data);
    } catch {
      this.logger.warn(`Corrupted JSON in job store: ${String(data).slice(0, 100)}`);
      return fallback;
    }
  }

  /**
   * Force save to file
   */
  flush(): void {
    this.saveToFile();
  }

  /**
   * Close the database
   */
  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }

    // Final save
    this.saveToFile();

    if (this.db) {
      this.db.close();
      this.db = null;
    }

    this.logger.info('Job store closed');
  }
}

export default JobStore;
