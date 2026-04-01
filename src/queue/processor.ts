/**
 * Print Job Processor
 * Processes jobs from the queue and sends them to printers
 */

import { EventEmitter } from 'events';
import { JobQueue } from './job-queue';
import { PrinterManager } from '../printers/printer-manager';
import { TemplateEngine } from '../templates/engine';
import {
  PrintJob,
  JobStatus,
  JobResult,
  ServiceEvent,
  PrinterStatus
} from '../types';
import { Logger } from '../utils/logger';

export interface ProcessorConfig {
  maxConcurrentJobs: number;
  jobTimeoutMs: number;
  pollIntervalMs: number;
}

export class JobProcessor extends EventEmitter {
  private queue: JobQueue;
  private printerManager: PrinterManager;
  private templateEngine: TemplateEngine;
  private logger: Logger;
  private config: ProcessorConfig;
  
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private activeJobs: Map<string, AbortController> = new Map();
  private metrics = {
    totalProcessed: 0,
    totalSuccess: 0,
    totalFailed: 0,
    totalDuration: 0
  };

  constructor(
    queue: JobQueue,
    printerManager: PrinterManager,
    templateEngine: TemplateEngine,
    config: ProcessorConfig,
    logger: Logger
  ) {
    super();
    this.queue = queue;
    this.printerManager = printerManager;
    this.templateEngine = templateEngine;
    this.config = config;
    this.logger = logger;

    // Listen for job events
    this.queue.on(ServiceEvent.JOB_CREATED, () => this.triggerPoll());
  }

  /**
   * Start the processor
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.logger.info('Job processor started');
    this.emit(ServiceEvent.SERVICE_STARTED, { component: 'processor' });
    
    // Start polling
    this.poll();
  }

  /**
   * Stop the processor
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Cancel all active jobs
    for (const [jobId, controller] of this.activeJobs) {
      controller.abort();
      this.queue.release(jobId);
    }
    this.activeJobs.clear();

    this.logger.info('Job processor stopped');
    this.emit(ServiceEvent.SERVICE_STOPPED, { component: 'processor' });
  }

  /**
   * Trigger immediate poll (for new jobs)
   */
  private triggerPoll(): void {
    if (this.running && !this.pollTimer) {
      setImmediate(() => this.poll());
    }
  }

  /**
   * Poll for jobs
   */
  private async poll(): Promise<void> {
    if (!this.running) {
      return;
    }

    try {
      // Check how many slots we have available
      const availableSlots = this.config.maxConcurrentJobs - this.activeJobs.size;
      
      if (availableSlots > 0 && !this.queue.isPaused()) {
        // Get jobs up to available slots
        const jobs = this.queue.dequeueBatch(availableSlots);
        
        // Process jobs concurrently
        for (const job of jobs) {
          this.processJob(job).catch(error => {
            this.logger.error(`Error processing job ${job.id}:`, error);
          });
        }
      }
    } catch (error) {
      this.logger.error('Error during poll:', error);
    }

    // Schedule next poll
    if (this.running) {
      this.pollTimer = setTimeout(
        () => {
          this.pollTimer = null;
          this.poll();
        },
        this.activeJobs.size >= this.config.maxConcurrentJobs
          ? 100 // Quick poll when at capacity
          : this.config.pollIntervalMs
      );
    }
  }

  /**
   * Process a single job
   */
  private async processJob(job: PrintJob): Promise<JobResult> {
    const startTime = Date.now();
    const abortController = new AbortController();
    this.activeJobs.set(job.id, abortController);

    this.logger.info(`Processing job ${job.id} for printer ${job.printerId}`);

    // Set timeout
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, this.config.jobTimeoutMs);

    try {
      // Check if aborted
      if (abortController.signal.aborted) {
        throw new Error('Job aborted');
      }

      // Check printer availability
      const printer = this.printerManager.getPrinter(job.printerId);
      if (!printer) {
        throw new Error(`Printer not found: ${job.printerId}`);
      }

      const printerStatus = await this.printerManager.getPrinterStatus(job.printerId);
      if (printerStatus === PrinterStatus.OFFLINE) {
        throw new Error(`Printer offline: ${job.printerId}`);
      }

      // Build print commands from template
      let rawCommands: Buffer;
      
      if (job.rawCommands) {
        // Use cached commands if available
        rawCommands = job.rawCommands;
      } else {
        // Render template
        rawCommands = this.templateEngine.render(
          job.templateType,
          job.payload,
          printer.getCapabilities()
        );
        
        // Cache commands for potential retry
        this.queue.setRawCommands(job.id, rawCommands);
      }

      // Check if aborted before printing
      if (abortController.signal.aborted) {
        throw new Error('Job aborted');
      }

      // Send to printer
      this.logger.debug(`Sending ${rawCommands.length} bytes to printer ${job.printerId}`);
      const printResult = await this.printerManager.print(job.printerId, rawCommands);

      if (!printResult.success) {
        throw new Error(printResult.error || 'Print failed');
      }

      // Mark as completed
      this.queue.complete(job.id);

      const duration = Date.now() - startTime;
      this.metrics.totalProcessed++;
      this.metrics.totalSuccess++;
      this.metrics.totalDuration += duration;

      const result: JobResult = {
        success: true,
        jobId: job.id,
        status: JobStatus.COMPLETED,
        bytesWritten: printResult.bytesWritten,
        duration
      };

      this.emit('jobCompleted', result);
      return result;

    } catch (error) {
      const errorMessage = (error as Error).message;
      const duration = Date.now() - startTime;
      
      this.metrics.totalProcessed++;
      this.metrics.totalFailed++;
      this.metrics.totalDuration += duration;

      // Determine if this is a retryable error
      const isRetryable = this.isRetryableError(error as Error);
      
      this.queue.fail(job.id, errorMessage, isRetryable);

      const result: JobResult = {
        success: false,
        jobId: job.id,
        status: JobStatus.FAILED,
        error: errorMessage,
        duration
      };

      this.emit('jobFailed', result);
      return result;

    } finally {
      clearTimeout(timeoutId);
      this.activeJobs.delete(job.id);
    }
  }

  /**
   * Determine if an error is retryable
   */
  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    
    // Non-retryable errors
    const nonRetryable = [
      'printer not found',
      'invalid template',
      'invalid payload',
      'unsupported',
      'configuration error'
    ];

    for (const keyword of nonRetryable) {
      if (message.includes(keyword)) {
        return false;
      }
    }

    // Retryable errors (network issues, temporary failures, etc.)
    const retryable = [
      'timeout',
      'connection',
      'busy',
      'paper',
      'offline',
      'network',
      'econnrefused',
      'econnreset',
      'etimedout'
    ];

    for (const keyword of retryable) {
      if (message.includes(keyword)) {
        return true;
      }
    }

    // Default to retryable for unknown errors
    return true;
  }

  /**
   * Get processor metrics
   */
  getMetrics(): {
    totalProcessed: number;
    totalSuccess: number;
    totalFailed: number;
    avgDuration: number;
    activeJobs: number;
    successRate: number;
  } {
    return {
      ...this.metrics,
      avgDuration: this.metrics.totalProcessed > 0 
        ? this.metrics.totalDuration / this.metrics.totalProcessed 
        : 0,
      activeJobs: this.activeJobs.size,
      successRate: this.metrics.totalProcessed > 0
        ? (this.metrics.totalSuccess / this.metrics.totalProcessed) * 100
        : 0
    };
  }

  /**
   * Get active job count
   */
  getActiveJobCount(): number {
    return this.activeJobs.size;
  }

  /**
   * Check if processor is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Pause processing
   */
  pause(): void {
    this.queue.pause();
    this.logger.info('Job processor paused');
  }

  /**
   * Resume processing
   */
  resume(): void {
    this.queue.resume();
    this.triggerPoll();
    this.logger.info('Job processor resumed');
  }
}

export default JobProcessor;
