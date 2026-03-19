/**
 * Metrics Collector
 * Collects and exposes service metrics
 */

import { EventEmitter } from 'events';
import { JobQueue } from '../queue/job-queue';
import { PrinterManager } from '../printers/printer-manager';
import { JobProcessor } from '../queue/processor';
import { ServiceEvent, PrinterStatus } from '../types';

export interface ServiceMetrics {
  uptime: number;
  startTime: number;
  
  // Job metrics
  jobs: {
    totalCreated: number;
    totalCompleted: number;
    totalFailed: number;
    totalRetried: number;
    avgProcessingTime: number;
    currentQueueDepth: number;
    activeJobs: number;
    successRate: number;
    jobsPerMinute: number;
  };
  
  // Printer metrics
  printers: {
    total: number;
    online: number;
    offline: number;
    error: number;
    byPrinter: Record<string, PrinterMetrics>;
  };
  
  // System metrics
  system: {
    memoryUsageMB: number;
    cpuUsagePercent: number;
    uptimeSeconds: number;
  };
}

export interface PrinterMetrics {
  id: string;
  name: string;
  status: PrinterStatus;
  jobsCompleted: number;
  jobsFailed: number;
  avgPrintTime: number;
  bytesWritten: number;
  lastPrintTime: number | null;
  consecutiveFailures: number;
  uptime: number;
}

interface TimeSeriesPoint {
  timestamp: number;
  value: number;
}

export class MetricsCollector extends EventEmitter {
  private startTime: number;
  private jobQueue: JobQueue;
  private printerManager: PrinterManager;
  private processor: JobProcessor;
  
  // Counters
  private totalJobsCreated = 0;
  private totalJobsCompleted = 0;
  private totalJobsFailed = 0;
  private totalJobsRetried = 0;
  private totalProcessingTime = 0;
  
  // Per-printer metrics
  private printerMetrics: Map<string, PrinterMetrics> = new Map();
  
  // Time series for rate calculations
  private completedJobsTimeSeries: TimeSeriesPoint[] = [];
  private readonly timeSeriesWindow = 60000; // 1 minute window
  
  // Snapshot interval
  private snapshotTimer: NodeJS.Timeout | null = null;
  private readonly snapshotIntervalMs: number;

  constructor(
    jobQueue: JobQueue,
    printerManager: PrinterManager,
    processor: JobProcessor,
    options: { snapshotIntervalMs?: number } = {}
  ) {
    super();
    this.startTime = Date.now();
    this.jobQueue = jobQueue;
    this.printerManager = printerManager;
    this.processor = processor;
    this.snapshotIntervalMs = options.snapshotIntervalMs || 60000;
    
    this.setupEventListeners();
    this.initializePrinterMetrics();
    this.startSnapshotTimer();
  }

  private setupEventListeners(): void {
    // Job events
    this.jobQueue.on(ServiceEvent.JOB_CREATED, () => {
      this.totalJobsCreated++;
    });

    this.processor.on('jobCompleted', (result: { jobId: string; duration?: number }) => {
      this.totalJobsCompleted++;
      if (result.duration) {
        this.totalProcessingTime += result.duration;
      }
      this.recordCompletion();
    });

    this.processor.on('jobFailed', () => {
      this.totalJobsFailed++;
    });

    this.jobQueue.on(ServiceEvent.JOB_RETRY, () => {
      this.totalJobsRetried++;
    });

    // Printer events
    this.printerManager.on('printerConnected', (id: string) => {
      this.updatePrinterStatus(id, PrinterStatus.ONLINE);
    });

    this.printerManager.on('printerDisconnected', (id: string) => {
      this.updatePrinterStatus(id, PrinterStatus.OFFLINE);
    });

    this.printerManager.on('printerError', (data: { printerId: string }) => {
      this.updatePrinterStatus(data.printerId, PrinterStatus.ERROR);
    });
  }

  private initializePrinterMetrics(): void {
    const printers = this.printerManager.getAllPrinters();
    
    for (const printer of printers) {
      this.printerMetrics.set(printer.id, {
        id: printer.id,
        name: printer.name,
        status: printer.state.status,
        jobsCompleted: printer.state.totalJobsPrinted,
        jobsFailed: 0,
        avgPrintTime: 0,
        bytesWritten: 0,
        lastPrintTime: null,
        consecutiveFailures: printer.state.consecutiveFailures,
        uptime: 0
      });
    }
  }

  private updatePrinterStatus(printerId: string, status: PrinterStatus): void {
    const metrics = this.printerMetrics.get(printerId);
    if (metrics) {
      metrics.status = status;
    }
  }

  private recordCompletion(): void {
    this.completedJobsTimeSeries.push({
      timestamp: Date.now(),
      value: 1
    });
    
    // Clean old entries
    const cutoff = Date.now() - this.timeSeriesWindow;
    this.completedJobsTimeSeries = this.completedJobsTimeSeries.filter(
      p => p.timestamp > cutoff
    );
  }

  private calculateJobsPerMinute(): number {
    const cutoff = Date.now() - this.timeSeriesWindow;
    const recentJobs = this.completedJobsTimeSeries.filter(
      p => p.timestamp > cutoff
    );
    return recentJobs.length;
  }

  private startSnapshotTimer(): void {
    this.snapshotTimer = setInterval(() => {
      const metrics = this.getMetrics();
      this.emit('snapshot', metrics);
    }, this.snapshotIntervalMs);
  }

  /**
   * Get current metrics
   */
  getMetrics(): ServiceMetrics {
    const queueStats = this.jobQueue.getStats();
    const processorMetrics = this.processor.getMetrics();
    const printerSummary = this.printerManager.getSummary();
    const printers = this.printerManager.getAllPrinters();
    
    // Update printer metrics from current state
    for (const printer of printers) {
      const metrics = this.printerMetrics.get(printer.id);
      if (metrics) {
        metrics.status = printer.state.status;
        metrics.jobsCompleted = printer.state.totalJobsPrinted;
        metrics.consecutiveFailures = printer.state.consecutiveFailures;
      }
    }

    const memUsage = process.memoryUsage();
    
    return {
      uptime: Date.now() - this.startTime,
      startTime: this.startTime,
      
      jobs: {
        totalCreated: this.totalJobsCreated,
        totalCompleted: this.totalJobsCompleted,
        totalFailed: this.totalJobsFailed,
        totalRetried: this.totalJobsRetried,
        avgProcessingTime: this.totalJobsCompleted > 0 
          ? this.totalProcessingTime / this.totalJobsCompleted 
          : 0,
        currentQueueDepth: queueStats.pending + queueStats.processing,
        activeJobs: processorMetrics.activeJobs,
        successRate: processorMetrics.successRate,
        jobsPerMinute: this.calculateJobsPerMinute()
      },
      
      printers: {
        ...printerSummary,
        byPrinter: Object.fromEntries(this.printerMetrics)
      },
      
      system: {
        memoryUsageMB: Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100,
        cpuUsagePercent: 0, // Would need additional tracking
        uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000)
      }
    };
  }

  /**
   * Get metrics for a specific printer
   */
  getPrinterMetrics(printerId: string): PrinterMetrics | undefined {
    return this.printerMetrics.get(printerId);
  }

  /**
   * Record a print job result for a specific printer
   */
  recordPrintResult(
    printerId: string, 
    success: boolean, 
    duration?: number, 
    bytesWritten?: number
  ): void {
    const metrics = this.printerMetrics.get(printerId);
    if (!metrics) return;

    if (success) {
      metrics.jobsCompleted++;
      metrics.consecutiveFailures = 0;
      metrics.lastPrintTime = Date.now();
      
      if (bytesWritten) {
        metrics.bytesWritten += bytesWritten;
      }
      
      if (duration) {
        // Running average
        metrics.avgPrintTime = metrics.jobsCompleted === 1
          ? duration
          : (metrics.avgPrintTime * (metrics.jobsCompleted - 1) + duration) / metrics.jobsCompleted;
      }
    } else {
      metrics.jobsFailed++;
      metrics.consecutiveFailures++;
    }
  }

  /**
   * Export metrics in Prometheus format
   */
  toPrometheusFormat(): string {
    const metrics = this.getMetrics();
    const lines: string[] = [];
    
    // Job metrics
    lines.push(`# HELP xp_thermal_jobs_total Total number of jobs by status`);
    lines.push(`# TYPE xp_thermal_jobs_total counter`);
    lines.push(`xp_thermal_jobs_total{status="created"} ${metrics.jobs.totalCreated}`);
    lines.push(`xp_thermal_jobs_total{status="completed"} ${metrics.jobs.totalCompleted}`);
    lines.push(`xp_thermal_jobs_total{status="failed"} ${metrics.jobs.totalFailed}`);
    lines.push(`xp_thermal_jobs_total{status="retried"} ${metrics.jobs.totalRetried}`);
    
    lines.push(`# HELP xp_thermal_queue_depth Current queue depth`);
    lines.push(`# TYPE xp_thermal_queue_depth gauge`);
    lines.push(`xp_thermal_queue_depth ${metrics.jobs.currentQueueDepth}`);
    
    lines.push(`# HELP xp_thermal_active_jobs Currently active jobs`);
    lines.push(`# TYPE xp_thermal_active_jobs gauge`);
    lines.push(`xp_thermal_active_jobs ${metrics.jobs.activeJobs}`);
    
    lines.push(`# HELP xp_thermal_processing_time_avg Average processing time in ms`);
    lines.push(`# TYPE xp_thermal_processing_time_avg gauge`);
    lines.push(`xp_thermal_processing_time_avg ${metrics.jobs.avgProcessingTime}`);
    
    // Printer metrics
    lines.push(`# HELP xp_thermal_printers_total Total number of printers by status`);
    lines.push(`# TYPE xp_thermal_printers_total gauge`);
    lines.push(`xp_thermal_printers_total{status="online"} ${metrics.printers.online}`);
    lines.push(`xp_thermal_printers_total{status="offline"} ${metrics.printers.offline}`);
    lines.push(`xp_thermal_printers_total{status="error"} ${metrics.printers.error}`);
    
    // Per-printer metrics
    for (const [id, printer] of Object.entries(metrics.printers.byPrinter)) {
      lines.push(`xp_thermal_printer_jobs_completed{printer="${id}"} ${printer.jobsCompleted}`);
      lines.push(`xp_thermal_printer_jobs_failed{printer="${id}"} ${printer.jobsFailed}`);
    }
    
    // System metrics
    lines.push(`# HELP xp_thermal_uptime_seconds Service uptime in seconds`);
    lines.push(`# TYPE xp_thermal_uptime_seconds counter`);
    lines.push(`xp_thermal_uptime_seconds ${metrics.system.uptimeSeconds}`);
    
    lines.push(`# HELP xp_thermal_memory_mb Memory usage in MB`);
    lines.push(`# TYPE xp_thermal_memory_mb gauge`);
    lines.push(`xp_thermal_memory_mb ${metrics.system.memoryUsageMB}`);
    
    return lines.join('\n');
  }

  /**
   * Stop the metrics collector
   */
  stop(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.removeAllListeners();
  }
}

export default MetricsCollector;
