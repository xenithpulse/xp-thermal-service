/**
 * HTTP API Server
 * Secure local API for print job submission
 * Production-grade with connection handling, rate limiting, and error recovery
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import cors from 'cors';
import helmet from 'helmet';
import { z } from 'zod';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { JobQueue } from '../queue/job-queue';
import { PrinterManager } from '../printers/printer-manager';
import { JobProcessor } from '../queue/processor';
import { ConfigManager } from '../utils/config';
import { USBPrinterAdapter } from '../printers/usb-adapter';
import {
  PrintRequest,
  PrintResponse,
  HealthResponse,
  PrinterListResponse,
  TemplateType,
  JobPriority,
  JobStatus,
  SecurityConfig,
  PrintServiceError,
  ErrorCodes
} from '../types';
import { Logger } from '../utils/logger';

// Request validation schemas
const PrintRequestSchema = z.object({
  idempotencyKey: z.string().min(1).max(255),
  printerId: z.string().optional(),
  templateType: z.nativeEnum(TemplateType),
  payload: z.record(z.unknown()),
  priority: z.nativeEnum(JobPriority).optional(),
  copies: z.number().min(1).max(10).optional()
});

export interface ApiServerConfig {
  host: string;
  port: number;
  security: SecurityConfig;
  configManager: ConfigManager;
}

// Production server configuration
const SERVER_CONFIG = {
  // Connection handling
  keepAliveTimeout: 65000,        // Slightly higher than typical LB timeout (60s)
  headersTimeout: 66000,          // Must be higher than keepAliveTimeout
  requestTimeout: 30000,          // Max time for request processing
  maxConnections: 100,            // Max concurrent connections
  
  // Shutdown handling
  gracefulShutdownTimeout: 10000, // Max wait time during shutdown
};

export class ApiServer {
  private app: Express;
  private server: http.Server | null = null;
  private queue: JobQueue;
  private printerManager: PrinterManager;
  private processor: JobProcessor;
  private logger: Logger;
  private config: ApiServerConfig;
  private rateLimiter!: RateLimiterMemory;
  private burstLimiter!: RateLimiterMemory;
  private startTime: number = Date.now();
  private activeConnections: Set<import('net').Socket> = new Set();
  private isShuttingDown: boolean = false;

  constructor(
    queue: JobQueue,
    printerManager: PrinterManager,
    processor: JobProcessor,
    config: ApiServerConfig,
    logger: Logger
  ) {
    this.queue = queue;
    this.printerManager = printerManager;
    this.processor = processor;
    this.config = config;
    this.logger = logger;

    // Initialize rate limiter with burst support
    this.rateLimiter = new RateLimiterMemory({
      points: config.security.rateLimitPerMinute,
      duration: 60,
      blockDuration: 60,           // Block for 60s when limit exceeded
    });
    
    // Burst limiter for short-term spikes (e.g., 20 requests in 1 second)
    this.burstLimiter = new RateLimiterMemory({
      points: 20,
      duration: 1,
    });

    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandler();
  }

  private setupMiddleware(): void {
    // Security headers
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
          scriptSrcAttr: ["'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
          connectSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
        }
      },
      crossOriginEmbedderPolicy: false
    }));

    // Private Network Access (PNA) support for Chrome
    // This allows public websites (like Vercel) to access localhost services
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      // Handle preflight requests with Private Network Access
      if (req.headers['access-control-request-private-network']) {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      next();
    });

    // CORS configuration — checks are dynamic so config updates apply immediately
    this.app.use(cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (e.g., server-to-server, same-origin fetch)
        if (!origin) {
          callback(null, true);
          return;
        }

        // Always allow the service's own origin (dashboard served from same host)
        const selfOrigin = `http://${this.config.host}:${this.config.port}`;
        const selfOrigins = [
          selfOrigin,
          `http://127.0.0.1:${this.config.port}`,
          `http://localhost:${this.config.port}`,
        ];
        if (selfOrigins.includes(origin)) {
          callback(null, true);
          return;
        }

        const origins = this.config.security.allowedOrigins;
        if (origins.includes('*')) {
          // Wildcard: allow all origins but without reflecting the specific origin
          callback(null, '*');
        } else if (origins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key', 'X-API-Key'],
      // Only send credentials when origins are explicitly listed (not wildcard)
      credentials: !this.config.security.allowedOrigins.includes('*'),
      // Ensure preflight is handled properly
      preflightContinue: false,
      optionsSuccessStatus: 204
    }));

    // Body parsing with size limit
    this.app.use(express.json({ 
      limit: this.config.security.maxPayloadSize 
    }));

    // Shutdown awareness - reject new requests during shutdown
    this.app.use(this.checkShutdown.bind(this));

    // Request timeout middleware
    this.app.use(this.requestTimeout.bind(this));

    // Request logging
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      this.logger.debug({ 
        method: req.method, 
        path: req.path,
        origin: req.get('origin')
      }, 'Incoming request');
      next();
    });

    // Host validation (localhost only by default)
    this.app.use(this.validateHost.bind(this));

    // API key validation (if enabled)
    if (this.config.security.enableApiKey) {
      this.app.use(this.validateApiKey.bind(this));
    }

    // Rate limiting
    this.app.use(this.rateLimit.bind(this));
  }

  private validateHost(req: Request, res: Response, next: NextFunction): void {
    const host = req.hostname || req.get('host')?.split(':')[0];
    
    if (!host || !this.config.security.allowedHosts.includes(host)) {
      this.logger.warn({ host }, 'Blocked request from unauthorized host');
      res.status(403).json({
        error: 'Forbidden',
        message: 'Access denied from this host'
      });
      return;
    }

    next();
  }

  /**
   * Reject requests when shutting down
   */
  private checkShutdown(_req: Request, res: Response, next: NextFunction): void {
    if (this.isShuttingDown) {
      res.status(503).json({
        error: 'Service Unavailable',
        message: 'Service is shutting down'
      });
      return;
    }
    next();
  }

  /**
   * Request timeout middleware
   */
  private requestTimeout(req: Request, res: Response, next: NextFunction): void {
    // Skip timeout for streaming endpoints
    if (req.path === '/api/logs/stream') {
      return next();
    }

    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        this.logger.warn({ path: req.path, method: req.method }, 'Request timeout');
        res.status(408).json({
          error: 'Request Timeout',
          message: 'Request took too long to process'
        });
      }
    }, SERVER_CONFIG.requestTimeout);

    res.on('finish', () => clearTimeout(timeout));
    res.on('close', () => clearTimeout(timeout));
    next();
  }

  private validateApiKey(req: Request, res: Response, next: NextFunction): void {
    // Skip API key validation for health checks, dashboard, and local-token
    if (
      req.path === '/health' || req.path === '/api/health' ||
      req.path === '/dashboard' || req.path === '/' ||
      req.path === '/api/auth/local-token'
    ) {
      return next();
    }

    const apiKey = req.get('X-API-Key');
    
    if (!apiKey || apiKey !== this.config.security.apiKey) {
      this.logger.warn('Invalid or missing API key');
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or missing API key'
      });
      return;
    }

    next();
  }

  /**
   * Rate limiting with burst protection
   */
  private async rateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Skip rate limiting for health checks
    if (req.path === '/health' || req.path === '/api/health') {
      return next();
    }

    const key = req.ip || 'unknown';

    try {
      // Check burst limit first (prevents rapid-fire requests)
      await this.burstLimiter.consume(key);
      // Then check the per-minute limit
      await this.rateLimiter.consume(key);
      next();
    } catch (rateLimiterRes) {
      const retryAfter = rateLimiterRes instanceof RateLimiterRes
        ? Math.ceil(rateLimiterRes.msBeforeNext / 1000)
        : 60;
      
      this.logger.warn({ ip: key, retryAfter }, 'Rate limit exceeded');
      
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.',
        retryAfter
      });
    }
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', this.handleHealth.bind(this));
    this.app.get('/api/health', this.handleHealth.bind(this));

    // Print endpoints
    this.app.post('/api/print', this.handlePrint.bind(this));
    this.app.post('/api/print/:printerId', this.handlePrintToPrinter.bind(this));

    // Job endpoints
    this.app.get('/api/jobs/:jobId', this.handleGetJob.bind(this));
    this.app.get('/api/jobs/:jobId/status', this.handleGetJobStatus.bind(this));
    this.app.delete('/api/jobs/:jobId', this.handleCancelJob.bind(this));
    this.app.get('/api/jobs', this.handleListJobs.bind(this));
    this.app.post('/api/jobs/:jobId/retry', this.handleRetryJob.bind(this));
    this.app.post('/api/jobs/clear-failed', this.handleClearFailedJobs.bind(this));

    // Printer endpoints
    this.app.get('/api/printers', this.handleListPrinters.bind(this));
    this.app.get('/api/printers/:printerId', this.handleGetPrinter.bind(this));
    this.app.get('/api/printers/:printerId/status', this.handleGetPrinterStatus.bind(this));
    this.app.post('/api/printers/:printerId/test', this.handleTestPrinter.bind(this));
    this.app.post('/api/printers/:printerId/reconnect', this.handleReconnectPrinter.bind(this));

    // Queue management
    this.app.get('/api/queue/stats', this.handleQueueStats.bind(this));
    this.app.post('/api/queue/pause', this.handlePauseQueue.bind(this));
    this.app.post('/api/queue/resume', this.handleResumeQueue.bind(this));

    // Metrics and system info
    this.app.get('/api/metrics', this.handleMetrics.bind(this));
    this.app.get('/api/system/info', this.handleSystemInfo.bind(this));
    this.app.get('/api/system/connections', this.handleConnectionStats.bind(this));

    // Configuration management
    this.app.get('/api/config', this.handleGetConfig.bind(this));
    this.app.put('/api/config/server', this.handleUpdateServerConfig.bind(this));
    this.app.put('/api/config/security', this.handleUpdateSecurityConfig.bind(this));
    this.app.get('/api/system/printers', this.handleListSystemPrinters.bind(this));
    this.app.post('/api/config/printers', this.handleAddPrinter.bind(this));
    this.app.put('/api/config/printers/:printerId', this.handleUpdatePrinterConfig.bind(this));
    this.app.delete('/api/config/printers/:printerId', this.handleDeletePrinterConfig.bind(this));

    // Local-only auth token (exempt from API key, restricted to loopback IP)
    this.app.get('/api/auth/local-token', this.handleLocalToken.bind(this));

    // Dashboard (serves static HTML)
    this.app.get('/dashboard', this.handleDashboard.bind(this));
    this.app.get('/', (_req: Request, res: Response) => res.redirect('/dashboard'));
  }

  private handleHealth(_req: Request, res: Response): void {
    const printerSummary = this.printerManager.getSummary();
    const queueStats = this.queue.getStats();

    // Service is always healthy once it's listening.
    // Only report 'initializing' while actively scanning USB ports for printers.
    // Printers being offline is normal and does NOT make the service unhealthy.
    const status: 'healthy' | 'initializing' =
      printerSummary.initializing ? 'initializing' : 'healthy';

    const response: HealthResponse = {
      status,
      uptime: Date.now() - this.startTime,
      version: '1.0.0',
      printers: printerSummary,
      queue: {
        pending: queueStats.pending,
        processing: queueStats.processing,
        failed: queueStats.failed
      }
    };

    res.status(200).json(response);
  }

  /**
   * Returns the API key to callers on the loopback interface only.
   * This allows localhost POS apps to auto-authenticate without manual config.
   * Security: only reachable from 127.0.0.1 / ::1 (enforced by host validation
   * middleware + explicit IP check here).
   */
  private handleLocalToken(req: Request, res: Response): void {
    const remoteIp = req.ip || req.socket.remoteAddress || '';
    const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteIp);

    if (!isLoopback) {
      this.logger.warn({ remoteIp }, 'Blocked non-loopback request to /api/auth/local-token');
      res.status(403).json({ error: 'Forbidden', message: 'Only available from localhost' });
      return;
    }

    if (!this.config.security.enableApiKey || !this.config.security.apiKey) {
      // API key auth is disabled — return empty token (no key needed)
      res.status(200).json({ apiKey: '', authRequired: false });
      return;
    }

    res.status(200).json({ apiKey: this.config.security.apiKey, authRequired: true });
  }

  private async handlePrint(req: Request, res: Response): Promise<void> {
    try {
      // Validate request body
      const parsed = PrintRequestSchema.safeParse(req.body);
      
      if (!parsed.success) {
        throw new PrintServiceError(
          `Invalid request: ${parsed.error.message}`,
          ErrorCodes.INVALID_REQUEST,
          400
        );
      }

      const printRequest: PrintRequest = parsed.data as PrintRequest;

      // Determine target printer
      let targetPrinterId = printRequest.printerId;
      
      if (!targetPrinterId) {
        const defaultPrinter = this.printerManager.getDefaultPrinter();
        if (!defaultPrinter) {
          throw new PrintServiceError(
            'No default printer available',
            ErrorCodes.PRINTER_NOT_FOUND,
            503
          );
        }
        targetPrinterId = defaultPrinter.id;
      }

      // Verify printer exists
      const printer = this.printerManager.getPrinter(targetPrinterId);
      if (!printer) {
        throw new PrintServiceError(
          `Printer not found: ${targetPrinterId}`,
          ErrorCodes.PRINTER_NOT_FOUND,
          404
        );
      }

      // Create job(s)
      const copies = printRequest.copies || 1;
      const jobs: PrintResponse[] = [];

      for (let i = 0; i < copies; i++) {
        const idempotencyKey = copies > 1 
          ? `${printRequest.idempotencyKey}_copy_${i + 1}`
          : printRequest.idempotencyKey;

        const result = this.queue.enqueue(
          { ...printRequest, idempotencyKey },
          targetPrinterId
        );

        jobs.push({
          success: true,
          jobId: result.job.id,
          status: result.job.status,
          message: result.created ? 'Job created' : 'Duplicate job (idempotent)'
        });
      }

      // Return first job (or array if multiple copies)
      if (copies === 1) {
        res.status(jobs[0].status === JobStatus.PENDING ? 201 : 200).json(jobs[0]);
      } else {
        res.status(201).json({ jobs });
      }

    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async handlePrintToPrinter(req: Request, res: Response): Promise<void> {
    const { printerId } = req.params;
    req.body.printerId = printerId;
    return this.handlePrint(req, res);
  }

  private handleGetJob(req: Request, res: Response): void {
    try {
      const { jobId } = req.params;
      const job = this.queue.getJob(jobId);

      if (!job) {
        throw new PrintServiceError(
          `Job not found: ${jobId}`,
          ErrorCodes.JOB_NOT_FOUND,
          404
        );
      }

      res.json({ job, found: true });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleGetJobStatus(req: Request, res: Response): void {
    try {
      const { jobId } = req.params;
      const job = this.queue.getJob(jobId);

      if (!job) {
        res.json({ found: false, job: null });
        return;
      }

      const history = this.queue.getJobHistory(jobId);
      res.json({ 
        found: true, 
        job,
        history 
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleCancelJob(req: Request, res: Response): void {
    try {
      const { jobId } = req.params;
      const cancelled = this.queue.cancel(jobId);

      if (!cancelled) {
        throw new PrintServiceError(
          `Cannot cancel job: ${jobId}`,
          ErrorCodes.JOB_CANCELLED,
          400
        );
      }

      res.json({ success: true, message: 'Job cancelled' });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleListJobs(req: Request, res: Response): void {
    try {
      const status = req.query.status as string | undefined;
      const printerId = req.query.printerId as string | undefined;
      const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 50, 100));

      // Validate status against known values
      const validStatuses: string[] = Object.values(JobStatus);
      if (status && !validStatuses.includes(status)) {
        res.status(400).json({ error: 'Invalid status value' });
        return;
      }

      let jobs;
      if (status) {
        jobs = this.queue.getJobsByStatus(status as JobStatus, limit);
      } else if (printerId) {
        jobs = this.queue.getJobsByPrinter(printerId, limit);
      } else {
        jobs = this.queue.getJobsByStatus(JobStatus.PENDING, limit);
      }

      res.json({ jobs, total: jobs.length });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleListPrinters(_req: Request, res: Response): void {
    try {
      const printers = this.printerManager.getAllPrinters();
      const response: PrinterListResponse = { printers };
      res.json(response);
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleGetPrinter(req: Request, res: Response): void {
    try {
      const { printerId } = req.params;
      const printers = this.printerManager.getAllPrinters();
      const printer = printers.find(p => p.id === printerId);

      if (!printer) {
        throw new PrintServiceError(
          `Printer not found: ${printerId}`,
          ErrorCodes.PRINTER_NOT_FOUND,
          404
        );
      }

      res.json({ printer });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async handleGetPrinterStatus(req: Request, res: Response): Promise<void> {
    try {
      const { printerId } = req.params;
      const status = await this.printerManager.getPrinterStatus(printerId);
      res.json({ printerId, status });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async handleTestPrinter(req: Request, res: Response): Promise<void> {
    try {
      const { printerId } = req.params;
      
      // Create a test print job
      const result = this.queue.createJob({
        idempotencyKey: `test_${printerId}_${Date.now()}`,
        printerId,
        templateType: TemplateType.TEST,
        payload: {
          message: req.body.message || 'Test print from XP Thermal Service',
          includeBarcode: req.body.includeBarcode ?? true,
          includeQR: req.body.includeQR ?? true,
          includeAllFonts: req.body.includeAllFonts ?? true
        },
        priority: JobPriority.HIGH
      });

      res.json({
        success: true,
        jobId: result.job.id,
        message: 'Test print job created'
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleQueueStats(_req: Request, res: Response): void {
    try {
      const stats = this.queue.getStats();
      const processorMetrics = this.processor.getMetrics();

      res.json({
        queue: stats,
        processor: processorMetrics,
        isPaused: this.queue.isPaused()
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handlePauseQueue(_req: Request, res: Response): void {
    this.processor.pause();
    res.json({ success: true, message: 'Queue paused' });
  }

  private handleResumeQueue(_req: Request, res: Response): void {
    this.processor.resume();
    res.json({ success: true, message: 'Queue resumed' });
  }

  // ── New Job Management Handlers ──

  private handleRetryJob(req: Request, res: Response): void {
    try {
      const { jobId } = req.params;
      const result = this.queue.retryJob(jobId);
      
      if (result) {
        res.json({ success: true, message: 'Job scheduled for retry', jobId });
      } else {
        res.status(404).json({
          error: 'Not Found',
          message: `Job not found or not in a retryable state: ${jobId}`
        });
      }
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleClearFailedJobs(_req: Request, res: Response): void {
    try {
      const count = this.queue.clearFailedJobs();
      res.json({ success: true, message: `Cleared ${count} failed jobs`, count });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async handleReconnectPrinter(req: Request, res: Response): Promise<void> {
    try {
      const { printerId } = req.params;
      const printer = this.printerManager.getPrinter(printerId);
      
      if (!printer) {
        res.status(404).json({
          error: 'Not Found',
          message: `Printer not found: ${printerId}`
        });
        return;
      }

      await this.printerManager.reconnect(printerId);
      res.json({ success: true, message: `Reconnecting printer: ${printerId}` });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  // ── System Info Handlers ──

  private handleSystemInfo(_req: Request, res: Response): void {
    try {
      const memUsage = process.memoryUsage();
      const cpuUsage = process.cpuUsage();
      
      res.json({
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        pid: process.pid,
        uptime: process.uptime(),
        memory: {
          heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
          external: Math.round(memUsage.external / 1024 / 1024),
          rss: Math.round(memUsage.rss / 1024 / 1024)
        },
        cpu: {
          user: Math.round(cpuUsage.user / 1000),
          system: Math.round(cpuUsage.system / 1000)
        },
        cwd: process.cwd()
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleConnectionStats(_req: Request, res: Response): void {
    try {
      res.json({
        activeConnections: this.activeConnections.size,
        maxConnections: SERVER_CONFIG.maxConnections,
        isShuttingDown: this.isShuttingDown
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleMetrics(_req: Request, res: Response): void {
    try {
      const queueStats = this.queue.getStats();
      const processorMetrics = this.processor.getMetrics();
      const printerSummary = this.printerManager.getSummary();
      
      res.json({
        uptime: Date.now() - this.startTime,
        queue: queueStats,
        processor: processorMetrics,
        printers: printerSummary
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  // ── Configuration Management Handlers ──

  private handleGetConfig(_req: Request, res: Response): void {
    try {
      const cm = this.config.configManager;
      res.json({
        server: cm.getServerConfig(),
        security: cm.getSecurityConfig(),
        queue: cm.getQueueConfig(),
        logging: cm.getLoggingConfig(),
        printers: cm.getPrinters()
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleUpdateServerConfig(req: Request, res: Response): void {
    try {
      const cm = this.config.configManager;
      cm.updateServerConfig(req.body);
      res.json({
        success: true,
        message: 'Server configuration saved. Restart the service for host/port changes to take effect.',
        server: cm.getServerConfig()
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleUpdateSecurityConfig(req: Request, res: Response): void {
    try {
      const cm = this.config.configManager;

      // Validate before saving
      cm.updateSecurityConfig(req.body);

      // Apply new security settings to the running server
      const newSecurity = cm.getSecurityConfig();
      this.config.security = newSecurity;

      // Recreate rate limiter with updated limits
      try {
        this.rateLimiter = new RateLimiterMemory({
          points: newSecurity.rateLimitPerMinute,
          duration: 60,
          blockDuration: 60,
        });
      } catch (rlErr) {
        this.logger.warn({ error: rlErr }, 'Failed to recreate rate limiter, keeping previous');
      }

      res.json({
        success: true,
        message: 'Security configuration updated and applied immediately.',
        security: newSecurity
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async handleListSystemPrinters(_req: Request, res: Response): Promise<void> {
    try {
      const printers = await USBPrinterAdapter.listPrinters();
      res.json({ printers });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleAddPrinter(req: Request, res: Response): void {
    try {
      const cm = this.config.configManager;
      cm.addPrinter(req.body);
      res.status(201).json({
        success: true,
        message: 'Printer added successfully. Restart the service to activate the new printer.',
        printers: cm.getPrinters()
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleUpdatePrinterConfig(req: Request, res: Response): void {
    try {
      const { printerId } = req.params;
      const cm = this.config.configManager;
      cm.updatePrinter(printerId, req.body);
      res.json({
        success: true,
        message: 'Printer configuration updated. Restart the service for changes to take effect.',
        printer: cm.getPrinter(printerId)
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleDeletePrinterConfig(req: Request, res: Response): void {
    try {
      const { printerId } = req.params;
      const cm = this.config.configManager;
      cm.removePrinter(printerId);
      res.json({
        success: true,
        message: 'Printer removed successfully.',
        printers: cm.getPrinters()
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleDashboard(_req: Request, res: Response): void {
    // Try multiple locations: flat install (cwd/public/), dev dist/ (../../public/)
    const candidates = [
      path.join(process.cwd(), 'public', 'dashboard.html'),
      path.join(__dirname, '..', 'public', 'dashboard.html'),
      path.join(__dirname, '..', '..', 'public', 'dashboard.html'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        // Inject API key into dashboard HTML so it can authenticate API calls
        try {
          let html = fs.readFileSync(candidate, 'utf8');
          const apiKey = this.config.security.enableApiKey ? (this.config.security.apiKey || '') : '';
          const injection = `<script>window.__XP_API_KEY__=${JSON.stringify(apiKey)};</script>`;
          html = html.replace('</head>', `${injection}\n</head>`);
          res.type('html').send(html);
        } catch {
          res.sendFile(candidate);
        }
        return;
      }
    }

    res.status(404).send('Dashboard not found. Ensure public/dashboard.html exists.');
  }

  private handleError(error: unknown, res: Response): void {
    if (error instanceof PrintServiceError) {
      this.logger.warn({ 
        code: error.code, 
        message: error.message 
      }, 'Request error');
      
      res.status(error.statusCode).json({
        error: error.code,
        message: error.message,
        details: error.details
      });
      return;
    }

    // Surface validation / config errors with their real message
    if (error instanceof Error) {
      const isValidation = error.message.startsWith('Invalid ');
      if (isValidation) {
        this.logger.warn({ message: error.message }, 'Validation error');
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: error.message
        });
        return;
      }

      this.logger.error({ error: error.message, stack: error.stack }, 'Unexpected error');
    } else {
      this.logger.error({ error }, 'Unexpected error');
    }
    
    res.status(500).json({
      error: ErrorCodes.INTERNAL_ERROR,
      message: error instanceof Error ? error.message : 'An internal error occurred'
    });
  }

  private setupErrorHandler(): void {
    // 404 handler
    this.app.use((_req: Request, res: Response) => {
      res.status(404).json({
        error: 'Not Found',
        message: 'The requested endpoint does not exist'
      });
    });

    // Global error handler
    this.app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
      this.logger.error({ error: error?.message, stack: error?.stack }, 'Unhandled error');
      
      res.status(500).json({
        error: ErrorCodes.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : 'An internal error occurred'
      });
    });
  }

  private activePort: number = 0;
  private static readonly MAX_PORT_ATTEMPTS = 10;

  /**
   * Get the port the server is actually listening on
   */
  getActivePort(): number {
    return this.activePort;
  }

  /**
   * Start the API server with smart port handling.
   * If the configured port is in use, automatically tries subsequent ports.
   */
  async start(): Promise<void> {
    const basePort = this.config.port;

    for (let attempt = 0; attempt < ApiServer.MAX_PORT_ATTEMPTS; attempt++) {
      const port = basePort + attempt;
      try {
        await this.tryListen(this.config.host, port);
        this.activePort = port;
        if (attempt > 0) {
          this.logger.warn(
            `Configured port ${basePort} was in use — switched to port ${port}`
          );
        }
        this.logger.info(
          `API server listening on http://${this.config.host}:${port}`
        );
        return;
      } catch (error: any) {
        if (error.code === 'EADDRINUSE') {
          this.logger.warn(`Port ${port} is in use, trying next…`);
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      `All ports ${basePort}–${basePort + ApiServer.MAX_PORT_ATTEMPTS - 1} are in use`
    );
  }

  private tryListen(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = this.app.listen(port, host, () => {
        this.server = server;
        
        // Configure server timeouts for production
        server.keepAliveTimeout = SERVER_CONFIG.keepAliveTimeout;
        server.headersTimeout = SERVER_CONFIG.headersTimeout;
        server.maxConnections = SERVER_CONFIG.maxConnections;
        
        // Track connections for graceful shutdown
        server.on('connection', (socket) => {
          this.activeConnections.add(socket);
          socket.on('close', () => {
            this.activeConnections.delete(socket);
          });
        });
        
        resolve();
      });
      server.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Stop the API server gracefully
   * - Stops accepting new connections
   * - Waits for active connections to complete
   * - Forces close after timeout
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    this.isShuttingDown = true;
    this.logger.info('Initiating graceful shutdown...');

    return new Promise((resolve) => {
      // Stop accepting new connections
      this.server!.close(() => {
        this.logger.info('API server stopped');
        this.server = null;
        resolve();
      });

      // Set deadline for graceful shutdown
      const deadline = Date.now() + SERVER_CONFIG.gracefulShutdownTimeout;
      
      const checkConnections = () => {
        if (this.activeConnections.size === 0 || Date.now() > deadline) {
          // Force close remaining connections
          if (this.activeConnections.size > 0) {
            this.logger.warn(`Forcing close of ${this.activeConnections.size} connections`);
            for (const socket of this.activeConnections) {
              socket.destroy();
            }
            this.activeConnections.clear();
          }
          return;
        }
        
        this.logger.debug(`Waiting for ${this.activeConnections.size} connections to close...`);
        setTimeout(checkConnections, 100);
      };
      
      checkConnections();
    });
  }

  /**
   * Check if server is shutting down
   */
  isShuttingDownNow(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Get active connection count
   */
  getConnectionCount(): number {
    return this.activeConnections.size;
  }

  /**
   * Get Express app instance (for testing)
   */
  getApp(): Express {
    return this.app;
  }
}

export default ApiServer;
