/**
 * Thermal Bridge - print server
 *
 * The service itself: queue, printers, API, watchdogs. It runs two ways:
 *
 *   node dist/index.js        legacy mode, as Pulsar POS's WinSW wrapper and
 *                             `npm run dev` start it. Unchanged behaviour.
 *   ThermalBridge.exe         the exe's supervisor starts this as a child
 *     (child process)         process in 'user' or 'service' mode, with its
 *                             data directory as the working directory.
 */

import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';

import { ConfigManager } from './utils/config';
import { createLogger, Logger } from './utils/logger';
import { PrinterManager } from './printers/printer-manager';
import { USBPrinterAdapter } from './printers/usb-adapter';
import { JobStore } from './queue/job-store';
import { JobQueue } from './queue/job-queue';
import { JobProcessor } from './queue/processor';
import { TemplateEngine } from './templates/engine';
import { ApiServer } from './api/server';
import { BackupManager } from './backup/backup-manager';
import { BackupScheduler } from './backup/backup-scheduler';
import { HealthMonitor } from './health/health-monitor';
import { InstanceLock } from './utils/instance-lock';
import { ServiceEvent, TemplateType, JobPriority } from './types';
import { AppMode, legacyDataDir } from './app/paths';
import { PRODUCT_NAME, SERVICE_ID, VERSION } from './app/identity';

export class ThermalPrintService extends EventEmitter {
  private config: ConfigManager;
  private logger: Logger;
  private printerManager!: PrinterManager;
  private jobStore!: JobStore;
  private jobQueue!: JobQueue;
  private processor!: JobProcessor;
  private templateEngine!: TemplateEngine;
  private apiServer!: ApiServer;
  private backupManager!: BackupManager;
  private backupScheduler!: BackupScheduler;
  private healthMonitor!: HealthMonitor;
  private isRunning = false;
  private shutdownPromise: Promise<void> | null = null;
  private readonly mode: AppMode;
  /** Invoked as soon as shutdown begins, before any draining. */
  onStopping?: () => void;

  constructor(configPath?: string, options: { mode?: AppMode } = {}) {
    super();
    this.mode = options.mode ?? 'legacy';

    // Load configuration. Pulsar's origins are only merged in when running
    // for Pulsar; the per-user app pairs origins from the dashboard instead.
    this.config = new ConfigManager(configPath, { mergePosOrigins: this.mode !== 'user' });

    // Initialize logger. Under the exe there is no console: the supervisor
    // captures stdout into logs\console.log, so pretty-printing a copy of every
    // line there would only double the disk writes. A file is always kept.
    const logging = this.config.getLoggingConfig();
    this.logger = createLogger(
      this.mode === 'legacy'
        ? logging
        : { ...logging, console: false, file: logging.file || './logs/service.log' }
    );

    this.logger.info(`${PRODUCT_NAME} ${VERSION} initializing (${this.mode} mode)...`);
  }

  /**
   * Initialize all service components
   */
  private initialize(): void {
    const config = this.config.getConfig();

    // Initialize template engine
    this.templateEngine = new TemplateEngine();
    this.logger.info('Template engine initialized');

    // Initialize job store (SQLite persistence)
    const queueConfig = this.config.getQueueConfig();
    const dbPath = path.isAbsolute(queueConfig.persistPath)
      ? queueConfig.persistPath
      : path.join(process.cwd(), queueConfig.persistPath);

    this.jobStore = new JobStore(
      {
        dbPath,
        maxJobAgeMs: queueConfig.maxJobAgeMs,
        cleanupIntervalMs: queueConfig.cleanupIntervalMs
      },
      this.logger
    );
    this.logger.info('Job store initialized');

    // Initialize job queue
    this.jobQueue = new JobQueue(this.jobStore, queueConfig, this.logger);
    this.logger.info('Job queue initialized');

    // Initialize printer manager. Runtime discoveries (a printer that moved to
    // another USB port, a queue that was renamed) are written straight back to
    // config.json so the service does not have to re-learn them after a restart.
    this.printerManager = new PrinterManager(
      {
        printers: config.printers,
        autoConnect: true,
        healthCheckInterval: 30000,
        autoHeal: true,
        persistPrinterUpdate: (printerId, updates) => {
          this.config.updatePrinter(printerId, updates);
        }
      },
      this.logger
    );

    // Forward printer events
    this.printerManager.on('printerConnected', (id) => {
      this.emit(ServiceEvent.PRINTER_CONNECTED, { printerId: id });
    });
    this.printerManager.on('printerDisconnected', (id) => {
      this.emit(ServiceEvent.PRINTER_DISCONNECTED, { printerId: id });
    });
    this.printerManager.on('printerError', (data) => {
      this.emit(ServiceEvent.PRINTER_ERROR, data);
    });

    this.logger.info('Printer manager initialized');

    // Initialize job processor
    this.processor = new JobProcessor(
      this.jobQueue,
      this.printerManager,
      this.templateEngine,
      {
        maxConcurrentJobs: queueConfig.maxConcurrentJobs,
        jobTimeoutMs: queueConfig.jobTimeoutMs,
        pollIntervalMs: 100
      },
      this.logger
    );

    // Forward job events
    this.processor.on('jobCompleted', (result) => {
      this.emit(ServiceEvent.JOB_COMPLETED, result);
    });
    this.processor.on('jobFailed', (result) => {
      this.emit(ServiceEvent.JOB_FAILED, result);
    });

    this.logger.info('Job processor initialized');

    // Initialize API server
    const serverConfig = this.config.getServerConfig();
    const securityConfig = this.config.getSecurityConfig();

    this.apiServer = new ApiServer(
      this.jobQueue,
      this.printerManager,
      this.processor,
      {
        host: serverConfig.host,
        port: serverConfig.port,
        security: securityConfig,
        configManager: this.config,
        mode: this.mode,
        onRestartRequested: (reason) => {
          void this.restart(reason);
        }
      },
      this.logger
    );
    this.logger.info('API server initialized');

    // Initialize backup subsystem (policy comes from the POS dashboard). It
    // dumps Pulsar POS's MongoDB, so the per-user app never runs it.
    const backupConfig =
      this.mode === 'user'
        ? { ...this.config.getBackupConfig(), enabled: false }
        : this.config.getBackupConfig();
    this.backupManager = new BackupManager(backupConfig, this.logger);
    this.backupScheduler = new BackupScheduler(backupConfig, this.backupManager, this.logger);

    /*
     * Health alerting reads exactly the inputs /health reads, and runs them
     * through the same decideHealth — so an alert and the API can never
     * disagree about whether the service is working.
     */
    const alerts = this.config.getAlertsConfig();
    this.healthMonitor = new HealthMonitor(
      alerts,
      () => ({
        printers: this.printerManager.getSummary(),
        queue: this.jobQueue.getStallSignal()
      }),
      this.logger
    );
    this.apiServer.setBackupScheduler(this.backupScheduler);
    this.logger.info('Backup subsystem initialized');
  }

  /**
   * Start the service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Service is already running');
      return;
    }

    try {
      this.logger.info(`Starting ${PRODUCT_NAME}...`);
      
      // Initialize components
      this.initialize();

      // Ensure job store is fully initialized before accepting requests
      await this.jobStore.waitForInit();

      // Build the raw-printing helper once now, rather than paying ~600ms of
      // C# compilation on every receipt. Best-effort: printing falls back to
      // compiling inline if this cannot run here.
      await USBPrinterAdapter.prepareHelperAssembly(this.logger).catch(() => null);

      // Start the API server (smart port handling)
      await this.apiServer.start();

      // Start the job processor
      this.processor.start();

      // Start the backup scheduler (polls the POS for policy + run requests)
      this.backupScheduler.start();

      // Watch health so a degraded service is reported rather than discovered.
      this.healthMonitor.start();

      this.isRunning = true;
      this.emit(ServiceEvent.SERVICE_STARTED, { timestamp: Date.now() });
      
      // Log startup summary
      const activePort = this.apiServer.getActivePort();
      const printerSummary = this.printerManager.getSummary();
      this.logger.info({
        printers: printerSummary,
        configuredPort: this.config.getServerConfig().port,
        activePort
      }, `${PRODUCT_NAME} started successfully`);

      // Write active port to file for external discovery
      this.writeActivePortFile(activePort);

      console.log(`\n  ${PRODUCT_NAME} ${VERSION} is running on http://${this.config.getServerConfig().host}:${activePort}\n`);

    } catch (error) {
      this.logger.error({ error }, 'Failed to start service');
      this.emit(ServiceEvent.SERVICE_ERROR, { error });
      throw error;
    }
  }

  /**
   * Stop the service gracefully
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Prevent multiple shutdown calls
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.doStop();
    return this.shutdownPromise;
  }

  private async doStop(): Promise<void> {
    this.logger.info(`Stopping ${PRODUCT_NAME}...`);

    // Hand the instance lock over immediately. We are leaving regardless, and
    // draining can take tens of seconds; holding the lock through that would
    // make our own replacement wait, or fail, on every restart.
    this.onStopping?.();

    try {
      // Stop the backup scheduler
      this.backupScheduler?.stop();
      this.healthMonitor?.stop();

      // Stop accepting new jobs
      this.processor.pause();

      // Wait for active jobs to complete (with timeout)
      const shutdownTimeout = 10000;
      const startTime = Date.now();
      
      while (this.processor.getActiveJobCount() > 0) {
        if (Date.now() - startTime > shutdownTimeout) {
          this.logger.warn('Shutdown timeout - forcing stop');
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Stop components
      await this.processor.stop();
      await this.apiServer.stop();
      await this.printerManager.shutdown();
      this.jobQueue.close();

      // Clean up active port files so stale ports aren't read
      this.cleanActivePortFile();

      this.isRunning = false;
      this.emit(ServiceEvent.SERVICE_STOPPED, { timestamp: Date.now() });
      this.logger.info(`${PRODUCT_NAME} stopped`);

    } catch (error) {
      this.logger.error({ error }, 'Error during shutdown');
      throw error;
    } finally {
      this.shutdownPromise = null;
    }
  }

  /**
   * Write the active port to a file for external discovery.
   * This allows other applications to find the service even if it's running on a non-default port.
   */
  private writeActivePortFile(port: number): void {
    const portStr = port.toString();
    const written: string[] = [];

    // A machine-readable descriptor, so a client that finds the file knows what
    // it is looking at and can sanity-check it against the running service.
    const descriptor = JSON.stringify(
      {
        service: SERVICE_ID,
        name: PRODUCT_NAME,
        version: VERSION,
        mode: this.mode,
        port,
        host: this.config.getServerConfig().host,
        baseUrl: `http://127.0.0.1:${port}`,
        configuredPort: this.config.getServerConfig().port,
        pid: process.pid,
        startedAt: new Date().toISOString()
      },
      null,
      2
    );

    for (const target of this.getPortFileTargets()) {
      try {
        const dir = path.dirname(target);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(target, target.endsWith('.json') ? descriptor : portStr, 'utf8');
        written.push(target);
      } catch {
        // A single unwritable location must not stop the others.
      }
    }

    if (written.length === 0) {
      this.logger.warn('Failed to write any active port file');
    } else {
      this.logger.debug({ written, port }, 'Active port files written');
    }
  }

  /**
   * Where to publish the active port.
   *
   * The working directory is the data directory in every mode, so it always
   * gets a copy. Pulsar POS, though, looks only under
   * %ProgramData%\XPThermalService, a fixed machine-wide path it can read
   * without configuration. Legacy and service mode both write there so the POS
   * needs no changes. The per-user app does not: that folder belongs to the
   * machine-wide install, and a standard user cannot write to it.
   */
  private getPortFileTargets(): string[] {
    const cwd = process.cwd();
    const targets = [
      path.join(cwd, 'data', 'active_port.txt'),
      path.join(cwd, 'active_port.txt'),
      path.join(cwd, 'data', 'service-endpoint.json')
    ];

    if (this.mode !== 'user') {
      const legacy = legacyDataDir();
      if (path.resolve(legacy).toLowerCase() !== path.resolve(cwd).toLowerCase()) {
        targets.push(
          path.join(legacy, 'active_port.txt'),
          path.join(legacy, 'service-endpoint.json')
        );
      }
    }

    return targets;
  }

  /**
   * Remove active port files on shutdown to prevent stale port references.
   */
  private cleanActivePortFile(): void {
    for (const file of this.getPortFileTargets()) {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch {
        // Best effort — a leftover file is harmless because clients verify
        // against /health before trusting it.
      }
    }
    this.logger.debug('Active port files cleaned up');
  }

  /**
   * Write anything held only in memory to disk, right now.
   *
   * The job store batches saves on a 5-second timer, so a job that was accepted
   * and acknowledged to the POS can still be memory-only when the process dies.
   * This is synchronous and deliberately cheap so it can be called from an
   * uncaught-exception handler, where the process may have seconds to live and
   * async work may never complete.
   */
  flushPersistence(): void {
    try {
      this.jobQueue?.flush();
    } catch (error) {
      // Last-ditch path: never throw on the way out.
      console.error('[FLUSH] Could not flush the job store:', error);
    }
  }

  /**
   * Queue a test page on a printer (the default one when none is named).
   * Backs the tray's "Print test page"; the dashboard uses the API route.
   */
  printTestPage(printerId?: string): { jobId: string; printerId: string } {
    const target =
      printerId ||
      this.printerManager.getDefaultPrinter()?.id ||
      this.printerManager.getAllPrinters().find((p) => p.enabled)?.id;
    if (!target) {
      throw new Error('No printer is set up yet. Open the dashboard and click "Detect printers".');
    }
    const { job } = this.jobQueue.createJob({
      idempotencyKey: `test_${target}_${Date.now()}`,
      printerId: target,
      templateType: TemplateType.TEST,
      payload: { message: `Test page from ${PRODUCT_NAME}` },
      priority: JobPriority.HIGH
    });
    return { jobId: job.id, printerId: target };
  }

  /** Name and online state of each printer, for the tray menu. */
  getPrinterBrief(): Array<{ id: string; name: string; online: boolean }> {
    return (this.printerManager?.getAllPrinters() ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      online: p.state.isConnected
    }));
  }

  /**
   * Stop cleanly and exit so the service wrapper restarts us.
   *
   * Used by the restart API and the health watchdog. Goes through the full
   * shutdown — pause intake, let in-flight receipts finish, flush, close — so a
   * restart never truncates a print that is already on its way to the printer.
   */
  async restart(reason: string): Promise<void> {
    this.logger.warn({ reason }, 'Restarting service');
    console.warn(`[RESTART] ${reason} — draining work before exit`);

    // A restart must be quick. The service wrapper does not start the
    // replacement until this process has actually exited, so every second spent
    // shutting down is a second the till cannot print — and a slow shutdown
    // repeated a few times can exhaust the wrapper's restart budget and leave
    // the service down entirely.
    //
    // A receipt takes about a second to finish, so this window drains the
    // realistic cases and abandons the rest rather than hanging on a wedged
    // socket or an unresponsive spooler.
    const RESTART_DRAIN_MS = 8000;

    const drained = await Promise.race([
      this.stop().then(
        () => true,
        (error) => {
          this.logger.error({ error }, 'Shutdown failed during restart');
          return false;
        }
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), RESTART_DRAIN_MS))
    ]);

    if (!drained) {
      console.warn('[RESTART] Drain did not finish in time — flushing and exiting now');
      this.flushPersistence();
    }

    // Non-zero so the supervisor (or Pulsar's WinSW wrapper) treats it as a
    // crash and respawns.
    process.exit(1);
  }

  /**
   * Get service status
   */
  getStatus(): {
    running: boolean;
    uptime: number;
    printers: ReturnType<PrinterManager['getSummary']>;
    queue: ReturnType<JobQueue['getStats']>;
    processor: ReturnType<JobProcessor['getMetrics']>;
  } {
    return {
      running: this.isRunning,
      uptime: process.uptime(),
      printers: this.printerManager?.getSummary() || { total: 0, online: 0, offline: 0, error: 0 },
      queue: this.jobQueue?.getStats() || { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, activeWorkers: 0 },
      processor: this.processor?.getMetrics() || { totalProcessed: 0, totalSuccess: 0, totalFailed: 0, avgDuration: 0, activeJobs: 0, successRate: 0 }
    };
  }

  /**
   * Get configuration manager
   */
  getConfigManager(): ConfigManager {
    return this.config;
  }

  /**
   * Get printer manager
   */
  getPrinterManager(): PrinterManager {
    return this.printerManager;
  }

  /**
   * Get job queue
   */
  getJobQueue(): JobQueue {
    return this.jobQueue;
  }

  /**
   * Get the port the API server is actually listening on
   */
  getActivePort(): number {
    return this.apiServer?.getActivePort() ?? this.config.getServerConfig().port;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Production Hardening Constants
// ─────────────────────────────────────────────────────────────────────────────
const PRODUCTION_CONFIG = {
  // Startup delay when running as Windows service (allows system to stabilize)
  serviceStartupDelayMs: 3000,
  // Memory threshold for warning (512MB)
  memoryWarningThresholdMB: 512,
  // Memory threshold for restart suggestion (1GB)
  memoryRestartThresholdMB: 1024,
  // Heartbeat interval for logging service health
  heartbeatIntervalMs: 60000, // 1 minute
  // GC interval hint (V8 will decide)
  gcHintIntervalMs: 300000, // 5 minutes
  // Self-health check interval
  selfHealthCheckIntervalMs: 30000, // 30 seconds
  // Number of consecutive health failures before auto-restart
  maxHealthFailures: 3,
  // Proactive auto-recycle interval (prevents native-module rot over multi-day idle)
  // After this uptime, the process exits cleanly so the wrapper respawns it.
  autoRecycleIntervalMs: 24 * 60 * 60 * 1000, // 24 hours
  // Folder polled for restart trigger files (POS app or admin scripts can drop a file here)
  triggerFolderName: 'triggers',
  triggerFileName: 'restart.trigger',
  triggerPollIntervalMs: 15000, // 15 seconds
};

/**
 * Main entry point for `node dist/index.js` (legacy mode).
 */
async function main(): Promise<void> {
  // When running as a Windows service, CWD may not be the project directory.
  // Detect project root: if dist files are copied flat into the install dir
  // (e.g. C:\ProgramData\XPThermalService\index.js), use __dirname.
  // If running from dist/ subfolder during development, go up one level.
  const projectRoot = fs.existsSync(path.join(__dirname, 'package.json'))
    ? __dirname
    : path.resolve(__dirname, '..');
  process.chdir(projectRoot);

  // Check for CLI arguments
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
${PRODUCT_NAME} ${VERSION} (print server)
==============================

Runs the print server in the foreground, from the current folder.
Most people want ThermalBridge.exe instead, which needs no Node.js.

Usage:
  node dist/index.js [options]

Options:
  --config <path>   Path to configuration file
  --help, -h        Show this help message

Windows service (for POS and fleet installs, run as Administrator):
  ThermalBridge.exe --install-service
  ThermalBridge.exe --uninstall-service

Environment Variables:
  XP_CONFIG_PATH    Path to configuration file
`);
    process.exit(0);
  }

  // Get config path from args or environment
  let configPath: string | undefined;
  const configIndex = args.indexOf('--config');
  if (configIndex !== -1 && args[configIndex + 1]) {
    configPath = args[configIndex + 1];
  } else if (process.env.XP_CONFIG_PATH) {
    configPath = process.env.XP_CONFIG_PATH;
  }

  await runServer({ mode: 'legacy', configPath });
}

export interface RunServerOptions {
  mode: AppMode;
  configPath?: string;
}

/**
 * Start the print server in this process and keep it healthy: the instance
 * lock, signal handling, crash-time flushing, and the watchdogs that exit so
 * the supervisor (or Pulsar's WinSW wrapper) respawns a fresh process.
 *
 * Expects the working directory to be the data directory already.
 */
export async function runServer(options: RunServerOptions): Promise<ThermalPrintService> {
  const { mode, configPath } = options;

  // Legacy mode keeps its old heuristic for "am I the installed service?".
  // Under the exe a supervisor is always there to respawn us, so the
  // watchdogs always run.
  const legacyService =
    mode === 'legacy' &&
    (process.env.NODE_ENV === 'production' || process.cwd().includes('ProgramData'));
  const isService = mode === 'service' || legacyService;
  const monitored = mode !== 'legacy' || legacyService;

  // When running as Windows service, add startup delay to let system stabilize
  if (isService) {
    console.log(`Service startup delay (${PRODUCTION_CONFIG.serviceStartupDelayMs}ms)...`);
    await new Promise(resolve => setTimeout(resolve, PRODUCTION_CONFIG.serviceStartupDelayMs));
  }

  // Refuse to run alongside another instance. The port fallback means a second
  // copy would start "successfully" on the next free port and then fight the
  // first over config.json, silently dropping printers.
  const lock = new InstanceLock();
  const lockResult = await lock.acquire();

  if (!lockResult.acquired) {
    console.error(`\nFATAL: ${lockResult.reason}\n`);
    process.exit(4);
  }
  if (lockResult.reason && !lockResult.reason.startsWith('Instance lock acquired.')) {
    console.warn(`[LOCK] ${lockResult.reason}`);
  }

  // Create and start service
  const service = new ThermalPrintService(configPath, { mode });
  let isShuttingDown = false;

  // Release as soon as we start going down, so the replacement process can
  // claim the lock while this one drains. The exit hook is the backstop for
  // routes that never reach shutdown().
  service.onStopping = () => lock.release();
  process.on('exit', () => lock.release());

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      console.log('Shutdown already in progress...');
      return;
    }
    isShuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    
    // Set a deadline for graceful shutdown
    const forceExitTimer = setTimeout(() => {
      console.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 15000);
    
    try {
      await service.stop();
      clearTimeout(forceExitTimer);
      console.log('Shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  };

  // Register signal handlers (works on all platforms)
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  
  // Windows-specific: handle Ctrl+C and process termination
  if (process.platform === 'win32') {
    process.on('SIGHUP', () => shutdown('SIGHUP'));
    // Windows service stop signal
    process.on('message', (msg) => {
      if (msg === 'shutdown') {
        shutdown('SERVICE_STOP');
      }
    });
  }

  // Under the exe, losing the supervisor means nobody can stop or restart us
  // any more. Leave cleanly rather than linger as an orphan holding the port.
  if (mode !== 'legacy') {
    process.on('disconnect', () => shutdown('SUPERVISOR_GONE'));
  }

  // Handle uncaught errors — log and exit, let service manager restart.
  // The process may be in an unreliable state, so persistence is flushed
  // synchronously and immediately rather than via the async shutdown path,
  // which might never complete. Losing an acknowledged receipt is worse than
  // an inelegant exit.
  process.on('uncaughtException', (error) => {
    console.error('FATAL: Uncaught exception:', error);
    service.flushPersistence();
    setTimeout(() => process.exit(1), 1000);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('FATAL: Unhandled rejection at:', promise, 'reason:', reason);
    service.flushPersistence();
    setTimeout(() => process.exit(1), 1000);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Memory Monitoring (production only)
  // ─────────────────────────────────────────────────────────────────────────
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let gcHintTimer: NodeJS.Timeout | null = null;
  let healthWatchdogTimer: NodeJS.Timeout | null = null;
  let autoRecycleTimer: NodeJS.Timeout | null = null;
  let triggerWatchTimer: NodeJS.Timeout | null = null;
  let consecutiveHealthFailures = 0;
  let lastHeartbeatTime = Date.now();

  const startHealthMonitoring = () => {
    // Heartbeat logging + sleep/wake detection
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastHeartbeatTime;
      lastHeartbeatTime = now;

      // Sleep/wake detection: if elapsed >> expected interval, system likely slept
      if (elapsed > PRODUCTION_CONFIG.heartbeatIntervalMs * 3) {
        const sleepDurationSec = Math.round(elapsed / 1000);
        const sleepDurationMin = Math.round(elapsed / 60000);
        console.warn(`[WAKE] System appears to have slept for ~${sleepDurationSec}s. Triggering proactive recovery...`);

        // Reconnect all printers (they may have lost connection during sleep)
        if (service.getPrinterManager()) {
          service.getPrinterManager().connectAll().catch(err => {
            console.error(`[WAKE] Printer reconnect failed: ${err}`);
          });
        }

        // Long sleep (>1h) — in-process state (TCP sockets, sql.js, USB temp dir
        // handles) is likely stale. Recycle the process so the wrapper gives us
        // a fresh slate. This is the single biggest cause of "service shows
        // running but doesn't print" after multi-day restaurant closures.
        if (elapsed > 60 * 60 * 1000) {
          console.warn(`[WAKE] Long sleep detected (${sleepDurationMin} min) — initiating recycle for clean state`);
          shutdown('LONG_SLEEP_RECOVERY');
          return;
        }
      }

      const mem = process.memoryUsage();
      const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
      const rssMB = Math.round(mem.rss / 1024 / 1024);
      
      // Check memory thresholds
      if (rssMB > PRODUCTION_CONFIG.memoryRestartThresholdMB) {
        console.warn(`MEMORY CRITICAL: RSS ${rssMB}MB exceeds restart threshold. Initiating graceful restart...`);
        shutdown('MEMORY_LIMIT');
        return;
      } else if (rssMB > PRODUCTION_CONFIG.memoryWarningThresholdMB) {
        console.warn(`MEMORY WARNING: RSS ${rssMB}MB exceeds warning threshold.`);
      }
      
      // Log heartbeat with service status
      const status = service.getStatus();
      console.log(`[HEARTBEAT] Uptime: ${Math.round(status.uptime)}s | Heap: ${heapUsedMB}MB | RSS: ${rssMB}MB | Printers: ${status.printers.online}/${status.printers.total} | Queue: ${status.queue.pending} pending`);
    }, PRODUCTION_CONFIG.heartbeatIntervalMs);

    // Self-health watchdog: hit own /health endpoint to detect native module crashes
    const activePort = service.getActivePort();
    healthWatchdogTimer = setInterval(async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`http://127.0.0.1:${activePort}/health`, {
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (res.ok) {
          if (consecutiveHealthFailures > 0) {
            console.log(`[WATCHDOG] Health recovered after ${consecutiveHealthFailures} failure(s)`);
          }
          consecutiveHealthFailures = 0;
        } else {
          const body = await res.text().catch(() => '');
          consecutiveHealthFailures++;
          console.error(`[WATCHDOG] Health check failed (${consecutiveHealthFailures}/${PRODUCTION_CONFIG.maxHealthFailures}): HTTP ${res.status} - ${body}`);
        }
      } catch (err) {
        consecutiveHealthFailures++;
        console.error(`[WATCHDOG] Health check error (${consecutiveHealthFailures}/${PRODUCTION_CONFIG.maxHealthFailures}): ${err instanceof Error ? err.message : err}`);
      }

      if (consecutiveHealthFailures >= PRODUCTION_CONFIG.maxHealthFailures) {
        console.error(`[WATCHDOG] ${consecutiveHealthFailures} consecutive health failures. Restarting process to recover...`);
        stopHealthMonitoring();
        // Drain and flush on the way out; the wrapper respawns on exit code 1.
        void service.restart(`${consecutiveHealthFailures} consecutive health check failures`);
      }
    }, PRODUCTION_CONFIG.selfHealthCheckIntervalMs);

    // GC hints (if manual GC is exposed via --expose-gc)
    if (typeof global.gc === 'function') {
      gcHintTimer = setInterval(() => {
        try {
          (global.gc as () => void)();
        } catch {
          // GC not exposed or failed
        }
      }, PRODUCTION_CONFIG.gcHintIntervalMs);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Layer A — Proactive auto-recycle.
    // After 24h of uptime, exit cleanly so the wrapper respawns the process.
    // Prevents native-module rot (better-sqlite3, helmet, etc.) and event-loop
    // degradation that can manifest after multi-day idle periods.
    //
    // IDLE-AWARE: a restaurant POS may print mid-recycle. We defer the
    // recycle for up to 5 min while there are pending or active jobs, then
    // force it. This avoids cutting off a print mid-batch.
    // ─────────────────────────────────────────────────────────────────────
    let recycleDeferralStart = 0;
    const MAX_RECYCLE_DEFERRAL_MS = 5 * 60 * 1000;
    autoRecycleTimer = setInterval(() => {
      const uptimeHours = process.uptime() / 3600;
      let busy = false;
      try {
        const s = service.getStatus();
        busy = (s.queue.pending + s.queue.processing + s.processor.activeJobs) > 0;
      } catch {
        // If we can't read status, the process is degraded — recycle anyway
      }

      if (busy) {
        if (recycleDeferralStart === 0) {
          recycleDeferralStart = Date.now();
          console.warn(`[AUTO-RECYCLE] Uptime ${uptimeHours.toFixed(1)}h reached threshold but jobs are active — deferring`);
          return;
        }
        if (Date.now() - recycleDeferralStart < MAX_RECYCLE_DEFERRAL_MS) {
          return; // keep deferring
        }
        console.warn(`[AUTO-RECYCLE] Deferral window exceeded — forcing recycle despite ${uptimeHours.toFixed(1)}h uptime`);
      } else {
        console.warn(`[AUTO-RECYCLE] Uptime ${uptimeHours.toFixed(1)}h reached recycle threshold — exiting for wrapper respawn`);
      }
      shutdown('AUTO_RECYCLE');
    }, PRODUCTION_CONFIG.autoRecycleIntervalMs);
    // Allow the timer to keep the event loop alive (default), but don't let
    // it block shutdown if we're already exiting.
    autoRecycleTimer.unref?.();

    // ─────────────────────────────────────────────────────────────────────
    // Layer B — Trigger-file watcher.
    // External callers (POS app at E:\xp-pos\pos_modules\orders\printing-facility,
    // admin scripts, watchdog tasks) can drop a file at:
    //     <cwd>/triggers/restart.trigger
    // to force a graceful restart, even when the HTTP API is unresponsive.
    // The file's contents are logged (for traceability) and then the file is
    // removed so the next restart isn't triggered on respawn.
    // ─────────────────────────────────────────────────────────────────────
    const triggerDir = path.join(process.cwd(), PRODUCTION_CONFIG.triggerFolderName);
    const triggerFile = path.join(triggerDir, PRODUCTION_CONFIG.triggerFileName);
    try {
      if (!fs.existsSync(triggerDir)) {
        fs.mkdirSync(triggerDir, { recursive: true });
      }
      // Clean any stale trigger left from a previous crash so we don't loop.
      if (fs.existsSync(triggerFile)) {
        try { fs.unlinkSync(triggerFile); } catch { /* ignore */ }
      }
    } catch (err) {
      console.warn(`[TRIGGER] Could not prepare trigger folder: ${err instanceof Error ? err.message : err}`);
    }

    triggerWatchTimer = setInterval(() => {
      try {
        if (fs.existsSync(triggerFile)) {
          let payload = '';
          try { payload = fs.readFileSync(triggerFile, 'utf8').trim().slice(0, 500); } catch { /* ignore */ }
          try { fs.unlinkSync(triggerFile); } catch { /* ignore */ }
          console.warn(`[TRIGGER] Restart trigger file detected (payload="${payload}") — exiting for wrapper respawn`);
          shutdown('TRIGGER_FILE');
        }
      } catch {
        // Filesystem hiccup — try again next tick
      }
    }, PRODUCTION_CONFIG.triggerPollIntervalMs);
    triggerWatchTimer.unref?.();
  };

  const stopHealthMonitoring = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (gcHintTimer) {
      clearInterval(gcHintTimer);
      gcHintTimer = null;
    }
    if (healthWatchdogTimer) {
      clearInterval(healthWatchdogTimer);
      healthWatchdogTimer = null;
    }
    if (autoRecycleTimer) {
      clearInterval(autoRecycleTimer);
      autoRecycleTimer = null;
    }
    if (triggerWatchTimer) {
      clearInterval(triggerWatchTimer);
      triggerWatchTimer = null;
    }
  };

  try {
    await service.start();
    lock.updatePort(service.getActivePort());

    // Start proving we are alive. Until this runs, the lock is just a PID, and
    // a PID outlives the process that owned it: Windows hands the number out
    // again, and the next start reads it as "another copy is already running"
    // and stands down. Forever, and through a reinstall, because the lock file
    // lives in the data directory the installer preserves. The heartbeat is
    // what makes an abandoned lock expire on its own. See utils/instance-lock.
    lock.startHeartbeat();

    // Start health monitoring in production
    if (monitored) {
      startHealthMonitoring();
    }

    // If running interactively, show startup message
    if (mode === 'legacy' && !isService) {
      console.log(`\n${PRODUCT_NAME} is running.`);
      console.log('Press Ctrl+C to stop.\n');
    }
    return service;
  } catch (error) {
    console.error('FATAL: Failed to start service:', error);
    stopHealthMonitoring();
    process.exit(1);
  }
}

/** Defined as true by the exe bundle, whose entry point is src/app/main.ts. */
declare const __THERMAL_BRIDGE_EXE__: boolean | undefined;

// Run if executed directly
if (require.main === module && typeof __THERMAL_BRIDGE_EXE__ === 'undefined') {
  main();
}

export default ThermalPrintService;
