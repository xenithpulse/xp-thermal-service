/**
 * XP Thermal Service - Main Entry Point
 * Production-grade thermal printing service for restaurant POS
 */

import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';

import { ConfigManager } from './utils/config';
import { createLogger, Logger } from './utils/logger';
import { PrinterManager } from './printers/printer-manager';
import { JobStore } from './queue/job-store';
import { JobQueue } from './queue/job-queue';
import { JobProcessor } from './queue/processor';
import { TemplateEngine } from './templates/engine';
import { ApiServer } from './api/server';
import { ServiceEvent } from './types';

export class ThermalPrintService extends EventEmitter {
  private config: ConfigManager;
  private logger: Logger;
  private printerManager!: PrinterManager;
  private jobStore!: JobStore;
  private jobQueue!: JobQueue;
  private processor!: JobProcessor;
  private templateEngine!: TemplateEngine;
  private apiServer!: ApiServer;
  private isRunning = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(configPath?: string) {
    super();
    
    // Load configuration
    this.config = new ConfigManager(configPath);
    
    // Initialize logger
    this.logger = createLogger(this.config.getLoggingConfig());
    
    this.logger.info('XP Thermal Service initializing...');
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

    // Initialize printer manager
    this.printerManager = new PrinterManager(
      {
        printers: config.printers,
        autoConnect: true,
        healthCheckInterval: 30000
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
        configManager: this.config
      },
      this.logger
    );
    this.logger.info('API server initialized');
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
      this.logger.info('Starting XP Thermal Service...');
      
      // Initialize components
      this.initialize();

      // Ensure job store is fully initialized before accepting requests
      await this.jobStore.waitForInit();

      // Start the API server (smart port handling)
      await this.apiServer.start();

      // Start the job processor
      this.processor.start();

      this.isRunning = true;
      this.emit(ServiceEvent.SERVICE_STARTED, { timestamp: Date.now() });
      
      // Log startup summary
      const activePort = this.apiServer.getActivePort();
      const printerSummary = this.printerManager.getSummary();
      this.logger.info({
        printers: printerSummary,
        configuredPort: this.config.getServerConfig().port,
        activePort
      }, 'XP Thermal Service started successfully');

      // Write active port to file for external discovery
      this.writeActivePortFile(activePort);

      console.log(`\n  XP Thermal Service is running on http://${this.config.getServerConfig().host}:${activePort}\n`);

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
    this.logger.info('Stopping XP Thermal Service...');

    try {
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
      this.logger.info('XP Thermal Service stopped');

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
    try {
      const cwd = process.cwd();
      const portStr = port.toString();

      // Write to data/ subdirectory
      const dataPortFile = path.join(cwd, 'data', 'active_port.txt');
      const portDir = path.dirname(dataPortFile);
      if (!fs.existsSync(portDir)) {
        fs.mkdirSync(portDir, { recursive: true });
      }
      fs.writeFileSync(dataPortFile, portStr, 'utf8');

      // Also write to root of install directory for easy external discovery
      const rootPortFile = path.join(cwd, 'active_port.txt');
      fs.writeFileSync(rootPortFile, portStr, 'utf8');
      
      this.logger.debug({ dataPortFile, rootPortFile, port }, 'Active port files written');
    } catch (error) {
      this.logger.warn({ error }, 'Failed to write active port file');
    }
  }

  /**
   * Remove active port files on shutdown to prevent stale port references.
   */
  private cleanActivePortFile(): void {
    try {
      const cwd = process.cwd();
      const files = [
        path.join(cwd, 'data', 'active_port.txt'),
        path.join(cwd, 'active_port.txt'),
      ];
      for (const file of files) {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
      this.logger.debug('Active port files cleaned up');
    } catch (error) {
      this.logger.warn({ error }, 'Failed to clean active port files');
    }
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
};

/**
 * Main entry point
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
XP Thermal Print Service
========================

A production-grade thermal printing service for restaurant POS systems.

Usage:
  node index.js [options]

Options:
  --config <path>   Path to configuration file
  --help, -h        Show this help message

Service Management (Windows):
  node dist/service/installer.js install    Install as Windows service
  node dist/service/installer.js uninstall  Uninstall Windows service
  node dist/service/installer.js start      Start the service
  node dist/service/installer.js stop       Stop the service

Environment Variables:
  XP_CONFIG_PATH    Path to configuration file
  XP_LOG_LEVEL      Log level (trace, debug, info, warn, error)
  XP_PORT           API server port

For more information, see the documentation.
`);
    process.exit(0);
  }

  // When running as Windows service, add startup delay to let system stabilize
  const isService = process.env.NODE_ENV === 'production' || 
                    process.cwd().includes('ProgramData');
  
  if (isService) {
    console.log(`Service startup delay (${PRODUCTION_CONFIG.serviceStartupDelayMs}ms)...`);
    await new Promise(resolve => setTimeout(resolve, PRODUCTION_CONFIG.serviceStartupDelayMs));
  }

  // Get config path from args or environment
  let configPath: string | undefined;
  const configIndex = args.indexOf('--config');
  if (configIndex !== -1 && args[configIndex + 1]) {
    configPath = args[configIndex + 1];
  } else if (process.env.XP_CONFIG_PATH) {
    configPath = process.env.XP_CONFIG_PATH;
  }

  // Create and start service
  const service = new ThermalPrintService(configPath);
  let isShuttingDown = false;

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

  // Handle uncaught errors — log and exit, let service manager restart
  process.on('uncaughtException', (error) => {
    console.error('FATAL: Uncaught exception:', error);
    // Give time for logs to flush
    setTimeout(() => process.exit(1), 1000);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('FATAL: Unhandled rejection at:', promise, 'reason:', reason);
    // Give time for logs to flush
    setTimeout(() => process.exit(1), 1000);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Memory Monitoring (production only)
  // ─────────────────────────────────────────────────────────────────────────
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let gcHintTimer: NodeJS.Timeout | null = null;
  let healthWatchdogTimer: NodeJS.Timeout | null = null;
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
        console.warn(`[WAKE] System appears to have slept for ~${sleepDurationSec}s. Triggering proactive recovery...`);

        // Reconnect all printers (they may have lost connection during sleep)
        if (service.getPrinterManager()) {
          service.getPrinterManager().connectAll().catch(err => {
            console.error(`[WAKE] Printer reconnect failed: ${err}`);
          });
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
        // Exit with code 1 — node-windows will auto-restart the service
        process.exit(1);
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
  };

  try {
    await service.start();
    
    // Start health monitoring in production
    if (isService || process.env.NODE_ENV === 'production') {
      startHealthMonitoring();
    }
    
    // If running interactively, show startup message
    if (!isService) {
      console.log('\nXP Thermal Service is running.');
      console.log('Press Ctrl+C to stop.\n');
    }
  } catch (error) {
    console.error('FATAL: Failed to start service:', error);
    stopHealthMonitoring();
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export default ThermalPrintService;
