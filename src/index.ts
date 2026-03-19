/**
 * XP Thermal Service - Main Entry Point
 * Production-grade thermal printing service for restaurant POS
 */

import * as path from 'path';
import { EventEmitter } from 'events';

import { ConfigManager } from './utils/config';
import { createLogger, Logger } from './utils/logger';
import { PrinterManager } from './printers/printer-manager';
import { JobStore } from './queue/job-store';
import { JobQueue } from './queue/job-queue';
import { JobProcessor } from './queue/processor';
import { TemplateEngine } from './templates/engine';
import { ApiServer } from './api/server';
import { WindowsServiceManager } from './service/installer';
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

      // Start the API server
      await this.apiServer.start();

      // Start the job processor
      this.processor.start();

      this.isRunning = true;
      this.emit(ServiceEvent.SERVICE_STARTED, { timestamp: Date.now() });
      
      // Log startup summary
      const printerSummary = this.printerManager.getSummary();
      this.logger.info({
        printers: printerSummary,
        port: this.config.getServerConfig().port
      }, 'XP Thermal Service started successfully');

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
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
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

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await service.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Handle uncaught errors — exit immediately, let service manager restart
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    process.exit(1);
  });

  try {
    await service.start();
    
    // If running as Windows service, don't log to console
    if (!WindowsServiceManager.isRunningAsService()) {
      console.log('\nXP Thermal Service is running.');
      console.log('Press Ctrl+C to stop.\n');
    }
  } catch (error) {
    console.error('Failed to start service:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export default ThermalPrintService;
