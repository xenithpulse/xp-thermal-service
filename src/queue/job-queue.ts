/**
 * Job Queue Manager
 * Handles job queuing, prioritization, and retry logic
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { JobStore } from './job-store';
import {
  PrintJob,
  JobStatus,
  JobPriority,
  TemplateType,
  PrintRequest,
  QueueConfig,
  ServiceEvent
} from '../types';
import { Logger } from '../utils/logger';

export interface CreateJobOptions {
  idempotencyKey: string;
  printerId: string;
  templateType: TemplateType;
  payload: Record<string, unknown>;
  priority?: JobPriority;
  maxAttempts?: number;
  scheduledAt?: number;
  metadata?: Record<string, unknown>;
}

export class JobQueue extends EventEmitter {
  private store: JobStore;
  private logger: Logger;
  private config: QueueConfig;
  private processingJobs: Set<string> = new Set();
  private paused = false;

  constructor(store: JobStore, config: QueueConfig, logger: Logger) {
    super();
    this.store = store;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Create a new print job (with idempotency check)
   */
  createJob(options: CreateJobOptions): { created: boolean; job: PrintJob } {
    const now = Date.now();
    
    const job: PrintJob = {
      id: uuidv4(),
      idempotencyKey: options.idempotencyKey,
      printerId: options.printerId,
      templateType: options.templateType,
      payload: options.payload,
      priority: options.priority ?? JobPriority.NORMAL,
      status: JobStatus.PENDING,
      attempts: 0,
      maxAttempts: options.maxAttempts ?? this.config.maxRetries,
      createdAt: now,
      updatedAt: now,
      scheduledAt: options.scheduledAt ?? null,
      startedAt: null,
      completedAt: null,
      error: null,
      metadata: options.metadata
    };

    const result = this.store.create(job);
    
    if (result.created) {
      this.logger.info(`Created job ${job.id} for printer ${job.printerId}`);
      this.emit(ServiceEvent.JOB_CREATED, job);
    } else {
      this.logger.debug(`Duplicate job detected for idempotency key: ${options.idempotencyKey}`);
    }

    return result;
  }

  /**
   * Enqueue a job from a print request
   */
  enqueue(request: PrintRequest, printerId: string): { created: boolean; job: PrintJob } {
    return this.createJob({
      idempotencyKey: request.idempotencyKey,
      printerId: printerId,
      templateType: request.templateType,
      payload: request.payload,
      priority: request.priority,
      maxAttempts: this.config.maxRetries
    });
  }

  /**
   * Get the next job to process
   */
  dequeue(): PrintJob | null {
    if (this.paused) {
      return null;
    }

    const pending = this.store.getPending(10);
    
    for (const job of pending) {
      // Skip jobs already being processed
      if (this.processingJobs.has(job.id)) {
        continue;
      }

      // Mark as processing
      this.processingJobs.add(job.id);
      this.store.markStarted(job.id);
      
      const updatedJob = this.store.getById(job.id);
      if (updatedJob) {
        this.emit(ServiceEvent.JOB_STARTED, updatedJob);
        return updatedJob;
      }
    }

    return null;
  }

  /**
   * Get multiple jobs for batch processing
   */
  dequeueBatch(count: number): PrintJob[] {
    if (this.paused) {
      return [];
    }

    const jobs: PrintJob[] = [];
    
    for (let i = 0; i < count; i++) {
      const job = this.dequeue();
      if (job) {
        jobs.push(job);
      } else {
        break;
      }
    }

    return jobs;
  }

  /**
   * Mark job as completed
   */
  complete(jobId: string): void {
    this.store.markCompleted(jobId);
    this.processingJobs.delete(jobId);
    
    const job = this.store.getById(jobId);
    this.logger.info(`Job completed: ${jobId}`);
    this.emit(ServiceEvent.JOB_COMPLETED, job);
  }

  /**
   * Mark job as failed (with potential retry)
   */
  fail(jobId: string, error: string, isRetryable: boolean = true): void {
    const job = this.store.getById(jobId);
    if (!job) {
      this.processingJobs.delete(jobId);
      return;
    }

    const attempts = job.attempts + 1;
    const shouldRetry = isRetryable && attempts < job.maxAttempts;
    
    this.store.markFailed(jobId, error, shouldRetry);
    this.processingJobs.delete(jobId);

    if (shouldRetry) {
      // Calculate retry delay with exponential backoff
      const delay = this.calculateRetryDelay(attempts);
      this.store.scheduleRetry(jobId, delay);
      
      this.logger.warn(`Job ${jobId} failed (attempt ${attempts}/${job.maxAttempts}), retry in ${delay}ms: ${error}`);
      this.emit(ServiceEvent.JOB_RETRY, { jobId, attempt: attempts, delay, error });
    } else {
      // Move to dead letter queue
      this.store.moveToDeadLetter(jobId);
      this.logger.error(`Job ${jobId} failed permanently after ${attempts} attempts: ${error}`);
      this.emit(ServiceEvent.JOB_FAILED, { jobId, error });
    }
  }

  /**
   * Cancel a job
   */
  cancel(jobId: string): boolean {
    const job = this.store.getById(jobId);
    if (!job) {
      return false;
    }

    // Can only cancel pending/queued jobs
    if (job.status === JobStatus.PENDING || job.status === JobStatus.QUEUED || job.status === JobStatus.RETRY_SCHEDULED) {
      this.store.update({
        ...job,
        status: JobStatus.CANCELLED,
        updatedAt: Date.now()
      });
      this.emit(ServiceEvent.JOB_CANCELLED, job);
      return true;
    }

    return false;
  }

  /**
   * Get a job by ID
   */
  getJob(jobId: string): PrintJob | null {
    return this.store.getById(jobId);
  }

  /**
   * Get a job by idempotency key
   */
  getJobByIdempotencyKey(key: string): PrintJob | null {
    return this.store.getByIdempotencyKey(key);
  }

  /**
   * Get jobs by status
   */
  getJobsByStatus(status: JobStatus, limit = 100): PrintJob[] {
    return this.store.getByStatus(status, limit);
  }

  /**
   * Get jobs by printer
   */
  getJobsByPrinter(printerId: string, limit = 100): PrintJob[] {
    return this.store.getByPrinter(printerId, limit);
  }

  /**
   * Get job history
   */
  getJobHistory(jobId: string): Array<{
    status: string;
    timestamp: number;
    details?: string;
  }> {
    return this.store.getHistory(jobId);
  }

  /**
   * Get queue statistics
   */
  getStats(): {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    activeWorkers: number;
  } {
    const counts = this.store.getCounts();
    return {
      ...counts,
      activeWorkers: this.processingJobs.size
    };
  }

  /**
   * Pause queue processing
   */
  pause(): void {
    this.paused = true;
    this.logger.info('Queue paused');
  }

  /**
   * Resume queue processing
   */
  resume(): void {
    this.paused = false;
    this.logger.info('Queue resumed');
  }

  /**
   * Check if queue is paused
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Check if there are pending jobs
   */
  hasPending(): boolean {
    const stats = this.getStats();
    return stats.pending > 0;
  }

  /**
   * Release a job back to the queue (without incrementing attempts)
   */
  release(jobId: string): void {
    const job = this.store.getById(jobId);
    if (job) {
      this.store.update({
        ...job,
        status: JobStatus.PENDING,
        updatedAt: Date.now()
      });
    }
    this.processingJobs.delete(jobId);
  }

  /**
   * Store raw commands for a job
   */
  setRawCommands(jobId: string, commands: Buffer): void {
    const job = this.store.getById(jobId);
    if (job) {
      this.store.update({
        ...job,
        rawCommands: commands,
        updatedAt: Date.now()
      });
    }
  }

  /**
   * Calculate retry delay with exponential backoff
   */
  private calculateRetryDelay(attempt: number): number {
    const baseDelay = this.config.retryDelayMs;
    const multiplier = this.config.retryBackoffMultiplier;
    const maxDelay = this.config.maxRetryDelayMs;
    
    // Exponential backoff: delay = base * multiplier^(attempt-1)
    const delay = baseDelay * Math.pow(multiplier, attempt - 1);
    
    // Add jitter (±10%) to prevent thundering herd
    const jitter = delay * 0.1 * (Math.random() * 2 - 1);
    
    return Math.min(delay + jitter, maxDelay);
  }

  /**
   * Clean up old jobs
   */
  cleanup(): number {
    return this.store.cleanup();
  }

  /**
   * Retry a failed or dead-letter job
   */
  retryJob(jobId: string): boolean {
    const job = this.store.getById(jobId);
    if (!job) {
      return false;
    }

    // Can only retry failed or dead-letter jobs
    if (job.status !== JobStatus.FAILED && job.status !== JobStatus.DEAD_LETTER) {
      return false;
    }

    // Reset the job to pending state
    this.store.update({
      ...job,
      status: JobStatus.PENDING,
      attempts: 0,
      error: null,
      scheduledAt: null,
      updatedAt: Date.now()
    });

    this.logger.info(`Job ${jobId} scheduled for retry`);
    this.emit(ServiceEvent.JOB_RETRY, { jobId, attempt: 0, delay: 0 });
    return true;
  }

  /**
   * Clear all failed and dead-letter jobs
   */
  clearFailedJobs(): number {
    const failed = this.store.getByStatus(JobStatus.FAILED, 1000);
    const deadLetter = this.store.getByStatus(JobStatus.DEAD_LETTER, 1000);
    
    const allFailed = [...failed, ...deadLetter];
    let count = 0;

    for (const job of allFailed) {
      this.store.delete(job.id);
      count++;
    }

    this.logger.info(`Cleared ${count} failed jobs`);
    return count;
  }

  /**
   * Close the queue
   */
  close(): void {
    this.store.close();
    this.removeAllListeners();
  }
}

export default JobQueue;
