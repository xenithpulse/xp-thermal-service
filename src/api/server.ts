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
import type { BackupScheduler } from '../backup/backup-scheduler';
import { USBPrinterAdapter } from '../printers/usb-adapter';
import { PrinterDiscovery } from '../printers/discovery';
import { buildRoleConfig, isPrinterRole, listRoles } from '../printers/printer-roles';
import { findByName } from '../printers/windows-printers';
import { OriginPolicy } from './origin-policy';
import { cashDrawerPulse } from '../escpos/builder';
import { decideHealth } from './health-verdict';
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
  copies: z.number().min(1).max(10).optional(),
  metadata: z.record(z.unknown()).optional()
});

export interface ApiServerConfig {
  host: string;
  port: number;
  security: SecurityConfig;
  configManager: ConfigManager;
  /**
   * Perform a graceful restart. Supplied by the service so the API does not
   * have to know how to drain the queue; without it the endpoint falls back to
   * an immediate exit, which can truncate an in-flight receipt.
   */
  onRestartRequested?: (reason: string) => void;
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
  private backupScheduler: BackupScheduler | null = null;
  private originPolicy: OriginPolicy;
  private discovery: PrinterDiscovery;

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

    this.originPolicy = new OriginPolicy({
      allowedOrigins: config.security.allowedOrigins,
      allowPrivateNetwork: config.security.allowPrivateNetwork !== false
    });
    this.discovery = new PrinterDiscovery(logger, printerManager.getPrintSystem());

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

    // CORS. The policy is consulted per request, so config changes made through
    // the dashboard apply immediately, and loopback callers are trusted on every
    // port — which is what keeps the dashboard working when the service falls
    // back from its configured port to the next free one.
    this.app.use(cors({
      origin: (origin, callback) => {
        const decision = this.originPolicy.check(origin ?? undefined);

        if (decision.allowed) {
          // Reflect the caller's origin rather than "*", so credentialed
          // requests keep working.
          callback(null, origin ? [origin] : true);
          return;
        }

        // Never hand cors an Error: that turns into an opaque 500 from the
        // error handler and hides the real reason. Withholding the headers is
        // enough for the browser to block the response, and the guard below
        // turns it into an explanatory 403.
        this.logger.warn({ origin, reason: decision.reason }, 'CORS origin rejected');
        callback(null, false);
      },
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Idempotency-Key',
        'X-API-Key',
        'X-Requested-With'
      ],
      exposedHeaders: ['X-Service-Port', 'Retry-After'],
      credentials: true,
      preflightContinue: false,
      optionsSuccessStatus: 204
    }));

    // Advertise the port we actually ended up on, so a client that found us by
    // scanning can confirm it and cache the result.
    this.app.use((_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('X-Service-Port', String(this.activePort || this.config.port));
      next();
    });

    // Reject disallowed cross-origin requests explicitly, with a message that
    // says how to fix it. Without this the request would still execute and only
    // the response would be hidden from the caller.
    this.app.use(this.enforceOrigin.bind(this));

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

  /**
   * Block cross-origin requests the policy rejected, and explain why.
   *
   * The cors middleware only decides whether to *emit* the response headers; it
   * does not stop the handler running. Preflights are let through untouched so
   * the browser gets its (header-free) 204 and reports a clean CORS error
   * rather than a confusing 403.
   */
  private enforceOrigin(req: Request, res: Response, next: NextFunction): void {
    if (req.method === 'OPTIONS') {
      return next();
    }

    const origin = req.get('origin');
    if (!origin) {
      return next();
    }

    const decision = this.originPolicy.check(origin);
    if (decision.allowed) {
      return next();
    }

    res.status(403).json({
      error: 'Forbidden',
      message: decision.reason,
      origin
    });
  }

  private validateHost(req: Request, res: Response, next: NextFunction): void {
    const host = req.hostname || req.get('host')?.split(':')[0];

    const decision = this.originPolicy.checkHost(host, this.config.security.allowedHosts);

    if (!decision.allowed) {
      this.logger.warn({ host, reason: decision.reason }, 'Blocked request from unauthorized host');
      res.status(403).json({
        error: 'Forbidden',
        message: decision.reason
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
    // Skip timeout for streaming endpoints and long-running restore (mongorestore
    // of a full DB can exceed the default request timeout).
    // Streaming endpoints stay open by design, and a full database restore can
    // legitimately outlast the normal request budget.
    if (
      req.path === '/api/logs/stream' ||
      req.path === '/api/events' ||
      req.path === '/api/backup/restore'
    ) {
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

    // EventSource cannot set request headers, so the stream endpoint also
    // accepts the key as a query parameter. Same value, same check — it only
    // ever travels over loopback or the local network.
    const apiKey =
      req.get('X-API-Key') ||
      (req.path === '/api/events' && typeof req.query.key === 'string' ? req.query.key : undefined);

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
    // Skip rate limiting for health checks and the long-lived event stream,
    // which is one connection held open rather than repeated requests.
    if (req.path === '/health' || req.path === '/api/health' || req.path === '/api/events') {
      return next();
    }

    // Skip rate limiting for loopback (same-machine POS apps).
    // Restaurant POS terminals on the same Windows host can burst-print during
    // peak service; throttling them would queue tickets and slow table turn-over.
    // The host validation middleware already restricts non-loopback access.
    const remoteIp = req.ip || req.socket.remoteAddress || '';
    if (remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1') {
      return next();
    }

    const key = remoteIp || 'unknown';

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

    // Discovery and setup. These must be registered before the /:printerId
    // routes below, otherwise Express matches "discover" as a printer id.
    this.app.get('/api/printers/discover', this.handleDiscoverPrinters.bind(this));
    this.app.get('/api/printers/roles', this.handleListRoles.bind(this));
    this.app.post('/api/printers/setup', this.handleSetupPrinterByRole.bind(this));
    this.app.post('/api/printers/auto-setup', this.handleAutoSetupPrinters.bind(this));

    this.app.get('/api/printers/:printerId', this.handleGetPrinter.bind(this));
    this.app.get('/api/printers/:printerId/status', this.handleGetPrinterStatus.bind(this));
    this.app.post('/api/printers/:printerId/test', this.handleTestPrinter.bind(this));
    this.app.post('/api/printers/:printerId/reconnect', this.handleReconnectPrinter.bind(this));
    this.app.post('/api/printers/:printerId/cash-drawer', this.handleOpenCashDrawer.bind(this));

    // Diagnosis and self-repair
    this.app.get('/api/printers/:printerId/diagnose', this.handleDiagnosePrinter.bind(this));
    this.app.post('/api/printers/:printerId/repair', this.handleRepairPrinter.bind(this));
    this.app.get('/api/system/print-system', this.handlePrintSystemSnapshot.bind(this));

    // Live push channel so the dashboard reflects a plug or unplug immediately
    // instead of on its next poll.
    this.app.get('/api/events', this.handleEventStream.bind(this));

    // Queue management
    this.app.get('/api/queue/stats', this.handleQueueStats.bind(this));
    this.app.post('/api/queue/pause', this.handlePauseQueue.bind(this));
    this.app.post('/api/queue/resume', this.handleResumeQueue.bind(this));

    // Metrics and system info
    this.app.get('/api/metrics', this.handleMetrics.bind(this));
    this.app.get('/api/system/info', this.handleSystemInfo.bind(this));
    this.app.get('/api/system/connections', this.handleConnectionStats.bind(this));

    // Service control (loopback-only restart trigger for POS app)
    this.app.post('/api/service/restart', this.handleServiceRestart.bind(this));

    // Backup (policy is owned by the POS dashboard; these give on-box control
    // and inspection of the backup subsystem)
    this.app.get('/api/backup/status', this.handleBackupStatus.bind(this));
    this.app.get('/api/backup/list', this.handleBackupList.bind(this));
    this.app.post('/api/backup/run', this.handleBackupRun.bind(this));
    this.app.post('/api/backup/restore', this.handleBackupRestore.bind(this));

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
    try {
      const printerSummary = this.printerManager.getSummary();
      const queueStats = this.queue.getStats();
      const stall = this.queue.getStallSignal();

      /*
       * D31. The old rule was:
       *
       *     status = printerSummary.initializing ? 'initializing' : 'healthy'
       *
       * which is a LIVENESS check wearing the word "health". It answers "is
       * this process up", and the process was up for all fourteen of the hours
       * in which it printed nothing.
       *
       * decideHealth answers "can this service do its job" instead - a
       * different question with a different answer, and the only one worth
       * publishing. Every input it takes was already in this handler's hands;
       * nothing new had to be measured to stop lying.
       */
      const { status, reasons } = decideHealth({
        printers: printerSummary,
        queue: {
          deadLetter: stall.deadLetter,
          oldestPendingAgeMs: stall.oldestPendingAgeMs
        }
      });

      const response: HealthResponse = {
        status,
        reasons,
        uptime: Date.now() - this.startTime,
        version: '1.0.0',
        printers: printerSummary,
        queue: {
          pending: queueStats.pending,
          processing: queueStats.processing,
          failed: queueStats.failed,
          deadLetter: stall.deadLetter,
          oldestPendingAgeMs: stall.oldestPendingAgeMs
        }
      };

      // Identity and port, so a client scanning 9100–9109 can confirm it found
      // this service rather than something else listening on the same port.
      res.status(200).json({
        ...response,
        service: 'xp-thermal-service',
        port: this.activePort || this.config.port,
        configuredPort: this.config.port
      });
    } catch (error) {
      // Native module crash (e.g. the sql.js WASM going "memory access out of
      // bounds"). If the health check itself cannot complete, the queue store
      // underneath it is unusable and nothing sent here will be recorded, let
      // alone printed.
      //
      // This used to answer 'degraded'. Under the Layer 5 model that is the
      // wrong word: degraded means "accepting work it cannot yet complete",
      // and this service cannot accept work at all. 'unhealthy' is what tells
      // the watchdog to restart the process rather than wait for a printer to
      // come back on its own.
      const message = error instanceof Error ? error.message : 'Internal health check failure';
      this.logger.error({ error: message }, 'Health check internal error');
      res.status(503).json({
        status: 'unhealthy',
        reasons: [`The health check itself failed, so the job store is unusable: ${message}`],
        uptime: Date.now() - this.startTime,
        version: '1.0.0',
        error: message
      });
    }
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

      // Without this, an unknown printer reported "unknown" with HTTP 200,
      // which reads as a working printer in a bad mood rather than a typo.
      if (!this.printerManager.getPrinter(printerId)) {
        throw new PrintServiceError(
          `Printer not found: ${printerId}`,
          ErrorCodes.PRINTER_NOT_FOUND,
          404
        );
      }

      const status = await this.printerManager.getPrinterStatus(printerId);
      const adapter = this.printerManager.getPrinter(printerId);
      res.json({
        printerId,
        status,
        reason: adapter?.state.reason,
        healable: adapter?.state.healable === true
      });
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

  private async handleOpenCashDrawer(req: Request, res: Response): Promise<void> {
    try {
      let { printerId } = req.params;

      // Resolve 'default' to the actual default printer
      if (printerId === 'default') {
        const defaultPrinter = this.printerManager.getDefaultPrinter();
        if (!defaultPrinter) {
          throw new PrintServiceError(
            'No default printer configured',
            ErrorCodes.PRINTER_NOT_FOUND,
            404
          );
        }
        printerId = defaultPrinter.id;
      }

      const printer = this.printerManager.getPrinter(printerId);

      if (!printer) {
        throw new PrintServiceError(
          `Printer not found: ${printerId}`,
          ErrorCodes.PRINTER_NOT_FOUND,
          404
        );
      }

      const capabilities = printer.getCapabilities();
      const drawer = printer.config.cashDrawer;

      if (!capabilities.supportsCashDrawer || drawer?.enabled === false) {
        res.status(400).json({
          success: false,
          error: 'Cash drawer not enabled',
          message: `The cash drawer is turned off for printer "${printerId}". Enable it in the printer's settings.`
        });
        return;
      }

      // Explicit request values win, so the settings screen can test a pulse
      // before saving it; otherwise use what the printer is configured with.
      const pin = req.body?.pin === 5 ? 5 : req.body?.pin === 2 ? 2 : drawer?.pin ?? 2;
      const onTimeMs = numberOr(req.body?.onTimeMs, drawer?.onTimeMs ?? 50);
      const offTimeMs = numberOr(req.body?.offTimeMs, drawer?.offTimeMs ?? 200);

      const drawerCmd = Buffer.from(cashDrawerPulse(pin, onTimeMs, offTimeMs));
      const result = await this.printerManager.print(printerId, drawerCmd);

      res.status(result.success ? 200 : 502).json({
        success: result.success,
        pin,
        onTimeMs,
        offTimeMs,
        message: result.success
          ? `Cash drawer pulsed on ${printerId} (pin ${pin}, ${onTimeMs}ms). If it did not open, try pin ${pin === 2 ? 5 : 2} or a longer pulse.`
          : `Could not open the cash drawer: ${result.error}`
      });
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

  /**
   * Trigger a graceful process restart. Loopback-only.
   * The Windows service wrapper (node-windows) will auto-restart the process
   * on a non-zero exit code.
   *
   * Used by:
   *   - POS app (E:\xp-pos\pos_modules\orders\printing-facility) for forced recovery
   *   - External watchdog scripts (scripts\trigger-restart.ps1)
   */
  private handleServiceRestart(req: Request, res: Response): void {
    const remoteIp = req.ip || req.socket.remoteAddress || '';
    const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteIp);

    if (!isLoopback) {
      this.logger.warn({ remoteIp }, 'Blocked non-loopback request to /api/service/restart');
      res.status(403).json({ error: 'Forbidden', message: 'Only available from localhost' });
      return;
    }

    this.logger.warn({ remoteIp, ua: req.get('user-agent') }, 'Service restart requested via API');

    // Acknowledge immediately, then restart so node-windows respawns us.
    res.status(202).json({
      success: true,
      message: 'Service restart initiated. In-flight print jobs will finish first.',
      pid: process.pid
    });

    // Let the response flush, then hand over to the service, which pauses
    // intake, waits for receipts already printing, and flushes the job store
    // before exiting. Exiting here directly would drop those jobs.
    setTimeout(() => {
      if (this.config.onRestartRequested) {
        this.config.onRestartRequested('restart requested via API');
        return;
      }

      // No graceful handler wired up: still better than losing the queue.
      // eslint-disable-next-line no-console
      console.warn('[API] Restart requested — exiting process for wrapper respawn');
      process.exit(1);
    }, 500);
  }

  // ── Backup Handlers ──

  /** Attach the backup scheduler once it's constructed (see index.ts). */
  setBackupScheduler(scheduler: BackupScheduler): void {
    this.backupScheduler = scheduler;
  }

  private handleBackupStatus(_req: Request, res: Response): void {
    if (!this.backupScheduler) {
      res.status(503).json({ error: 'Backup subsystem is disabled' });
      return;
    }
    res.json(this.backupScheduler.getStatus());
  }

  private handleBackupRun(_req: Request, res: Response): void {
    if (!this.backupScheduler) {
      res.status(503).json({ error: 'Backup subsystem is disabled' });
      return;
    }
    // Fire-and-forget: a dump can exceed the HTTP request timeout, so we
    // acknowledge immediately and let the caller poll /api/backup/status.
    this.backupScheduler
      .triggerNow()
      .catch((err) =>
        this.logger.error(
          { error: err instanceof Error ? err.message : err },
          'Manual backup failed'
        )
      );
    res.status(202).json({ success: true, message: 'Backup started' });
  }

  private async handleBackupList(_req: Request, res: Response): Promise<void> {
    if (!this.backupScheduler) {
      res.status(503).json({ error: 'Backup subsystem is disabled' });
      return;
    }
    try {
      res.json({ paths: await this.backupScheduler.listBackups() });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async handleBackupRestore(req: Request, res: Response): Promise<void> {
    if (!this.backupScheduler) {
      res.status(503).json({ error: 'Backup subsystem is disabled' });
      return;
    }
    // Restore drops and reloads the database — restrict to on-box callers.
    const remoteIp = req.ip || req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteIp)) {
      res.status(403).json({ error: 'Forbidden', message: 'Restore is only available from localhost' });
      return;
    }

    const dir = typeof req.body?.path === 'string' ? req.body.path : '';
    const file = typeof req.body?.file === 'string' ? req.body.file : '';
    if (!dir || !file) {
      res.status(400).json({ error: 'path and file are required' });
      return;
    }

    const result = await this.backupScheduler.restore(path.join(dir, file));
    res.status(result.success ? 200 : 400).json(result);
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
        printers: printerSummary,
        // Whether Windows is pushing device/queue changes to us. When false the
        // service still works, but reacts on its polling interval instead of
        // within about a second.
        printerEvents: {
          watching: this.printerManager.isWatcherRunning(),
          mode: this.printerManager.isWatcherRunning() ? 'event-driven' : 'polling'
        }
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  // ── Configuration Management Handlers ──

  private handleGetConfig(_req: Request, res: Response): void {
    try {
      const cm = this.config.configManager;
      const server = cm.getServerConfig();
      res.json({
        // activePort can differ from the configured port when the configured
        // one was busy at startup; the dashboard shows both.
        server: { ...server, activePort: this.activePort || server.port },
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

      // Origin/host rules take effect on the very next request.
      this.originPolicy.update({
        allowedOrigins: newSecurity.allowedOrigins,
        allowPrivateNetwork: newSecurity.allowPrivateNetwork !== false
      });

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

  // ── Discovery, Diagnosis and Repair ──

  /**
   * List every printer the user could add, ranked so real receipt printers
   * come first, each with a ready-to-save configuration.
   */
  private async handleDiscoverPrinters(req: Request, res: Response): Promise<void> {
    try {
      const scanNetwork = req.query.network === 'true' || req.query.network === '1';
      const includeVirtual = req.query.all === 'true' || req.query.all === '1';

      const existing = this.config.configManager.getPrinters().map((p) => ({
        id: p.id,
        printerName: p.printerName
      }));

      const printers = await this.discovery.discoverAll({
        scanNetwork,
        includeVirtual,
        existing,
        timeout: 800
      });

      const snapshot = await this.printerManager.getPrintSystem().getSnapshot();
      // Printers that are physically plugged in but have no driver installed.
      // Surfacing these turns an empty discovery list on a freshly imaged
      // machine into a specific instruction instead of a dead end.
      const needsDriver = await this.discovery.findUninstalledDevices();

      res.json({
        printers,
        needsDriver,
        summary: {
          total: printers.length,
          recommended: printers.filter((p) => p.recommended).length,
          alreadyConfigured: printers.filter((p) => p.alreadyConfiguredAs).length,
          needsDriver: needsDriver.length
        },
        system: {
          spoolerRunning: snapshot.spoolerRunning,
          attachedUsbDevices: snapshot.usbDevices.length,
          livePorts: snapshot.livePorts,
          warnings: snapshot.warnings,
          host: snapshot.host
        }
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  /** The roles a printer can be assigned, for the setup UI. */
  private handleListRoles(_req: Request, res: Response): void {
    res.json({ roles: listRoles() });
  }

  /**
   * Assign a Windows printer to a role.
   *
   * This is the whole "add a printer" flow: the caller says which physical
   * printer and what it is for, and everything else — the id, the capability
   * profile, the paper width, the cash drawer defaults, the identity
   * breadcrumbs — is derived. Re-running it for a role that already exists
   * repoints that role at the new printer, which is what someone replacing a
   * broken unit actually wants.
   */
  private async handleSetupPrinterByRole(req: Request, res: Response): Promise<void> {
    try {
      const role = req.body?.role;
      const windowsName = typeof req.body?.windowsName === 'string' ? req.body.windowsName.trim() : '';
      const runTest = req.body?.test !== false;

      if (!isPrinterRole(role)) {
        throw new PrintServiceError(
          `Unknown printer role "${String(role)}". Expected one of: ${listRoles().map((r) => r.id).join(', ')}`,
          ErrorCodes.INVALID_REQUEST,
          400
        );
      }

      if (!windowsName) {
        throw new PrintServiceError(
          'windowsName is required — pick a printer from the discovery list',
          ErrorCodes.INVALID_REQUEST,
          400
        );
      }

      const snapshot = await this.printerManager.getPrintSystem().refresh();
      const windows = findByName(snapshot.printers, windowsName);

      if (!windows) {
        throw new PrintServiceError(
          `Windows has no printer called "${windowsName}". It may have been removed or renamed.`,
          ErrorCodes.PRINTER_NOT_FOUND,
          404
        );
      }

      const cm = this.config.configManager;
      const existing = cm.getPrinter(role);
      // The first printer configured should be the default, whatever its role.
      const makeDefault = cm.getPrinters().length === 0 ? true : undefined;
      const printerConfig = buildRoleConfig(role, windows, snapshot, {
        makeDefault,
        name: req.body?.name
      });

      if (existing) {
        cm.updatePrinter(role, printerConfig);
        await this.printerManager.unregisterPrinter(role).catch(() => undefined);
      } else {
        cm.addPrinter(printerConfig);
      }

      this.printerManager.registerPrinter(cm.getPrinter(role)!);
      await this.printerManager.connectPrinter(role).catch(() => undefined);

      const adapter = this.printerManager.getPrinter(role);
      const ready = adapter?.isConnected() === true;

      if (runTest && ready) {
        this.queue.createJob({
          idempotencyKey: `setup_${role}_${Date.now()}`,
          printerId: role,
          templateType: TemplateType.TEST,
          payload: { message: `${printerConfig.name} is ready` },
          priority: JobPriority.HIGH
        });
      }

      res.status(existing ? 200 : 201).json({
        success: true,
        replaced: !!existing,
        printer: cm.getPrinter(role),
        status: adapter?.state.status ?? 'unknown',
        ready,
        // Never claim success when the printer is not actually usable: say
        // exactly what is wrong so it can be fixed now rather than at service.
        reason: adapter?.state.reason,
        testPrinted: runTest && ready,
        message: ready
          ? `"${windows.name}" is now the ${role} printer.${runTest ? ' A test receipt has been sent.' : ''}`
          : `"${windows.name}" was saved as the ${role} printer, but it is not ready: ${adapter?.state.reason ?? 'unknown reason'}`
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  /**
   * One-click setup: configure every recommended thermal printer that is not
   * already known, connect it, and make the first one the default.
   */
  private async handleAutoSetupPrinters(req: Request, res: Response): Promise<void> {
    try {
      const cm = this.config.configManager;
      const existing = cm.getPrinters();
      const test = req.body?.test !== false;

      const candidates = await this.discovery.suggestAutoSetup(
        existing.map((p) => ({ id: p.id, printerName: p.printerName }))
      );

      if (candidates.length === 0) {
        res.json({
          success: true,
          added: [],
          message:
            existing.length > 0
              ? 'Every thermal printer found is already configured.'
              : 'No thermal printers were found. Check that the printer is installed in Windows, powered on, and connected.'
        });
        return;
      }

      const added: Array<{ id: string; name: string; status: string; tested: boolean }> = [];
      const failed: Array<{ name: string; error: string }> = [];
      const makeDefault = existing.length === 0;

      for (const [index, candidate] of candidates.entries()) {
        const printerConfig = {
          ...candidate.suggestedConfig,
          isDefault: makeDefault && index === 0
        } as Parameters<typeof cm.addPrinter>[0];

        try {
          cm.addPrinter(printerConfig);
          this.printerManager.registerPrinter(printerConfig);
          await this.printerManager.connectPrinter(printerConfig.id).catch(() => undefined);

          const adapter = this.printerManager.getPrinter(printerConfig.id);

          if (test && adapter?.isConnected()) {
            this.queue.createJob({
              idempotencyKey: `autosetup_${printerConfig.id}_${Date.now()}`,
              printerId: printerConfig.id,
              templateType: TemplateType.TEST,
              payload: { message: `${printerConfig.name} configured automatically` },
              priority: JobPriority.HIGH
            });
          }

          added.push({
            id: printerConfig.id,
            name: printerConfig.name ?? printerConfig.id,
            status: adapter?.state.status ?? 'unknown',
            tested: test && !!adapter?.isConnected()
          });
        } catch (err) {
          failed.push({ name: candidate.name, error: (err as Error).message });
        }
      }

      res.status(added.length > 0 ? 201 : 400).json({
        success: added.length > 0,
        added,
        failed,
        message:
          added.length > 0
            ? `Added ${added.length} printer(s).${test ? ' A test receipt was sent to each one that is ready.' : ''}`
            : 'No printers could be added.',
        printers: cm.getPrinters()
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  /**
   * Explain a printer's state: what Windows reports, what the service concluded
   * and why, and which repairs are available.
   */
  private async handleDiagnosePrinter(req: Request, res: Response): Promise<void> {
    try {
      const { printerId } = req.params;
      const report = await this.printerManager.diagnosePrinter(printerId);
      res.json(report);
    } catch (error) {
      this.handleError(error, res);
    }
  }

  /**
   * Run the repair plan: repoint a migrated USB port, clear a stale offline
   * flag, resume a paused queue, restart the spooler.
   */
  private async handleRepairPrinter(req: Request, res: Response): Promise<void> {
    try {
      const { printerId } = req.params;
      const result = await this.printerManager.healPrinter(printerId);
      const adapter = this.printerManager.getPrinter(printerId);

      res.json({
        success: result.statusAfter !== result.statusBefore || adapter?.isConnected() === true,
        printerId,
        statusBefore: result.statusBefore,
        statusAfter: result.statusAfter,
        attempted: result.attempted,
        succeeded: result.succeeded,
        reason: result.reason,
        manualHint: result.manualHint,
        message:
          result.attempted.length === 0
            ? result.manualHint || 'Nothing needed repairing.'
            : `Ran ${result.succeeded.length} of ${result.attempted.length} repair step(s). ${result.reason}`
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  /**
   * Server-sent events carrying printer state changes as they happen.
   *
   * The service already learns about a plug or unplug within about a second via
   * WMI; without this the dashboard would still sit on a 10-second poll and
   * feel broken by comparison. Each client gets the current state immediately on
   * connect, so there is no window where the page shows nothing.
   */
  private handleEventStream(req: Request, res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Proxies that buffer would defeat the point of streaming.
      'X-Accel-Buffering': 'no'
    });

    const send = (event: string, data: unknown): void => {
      if (res.writableEnded) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        // Client vanished mid-write; the close handler cleans up.
      }
    };

    const snapshot = () => ({
      printers: this.printerManager.getAllPrinters(),
      summary: this.printerManager.getSummary()
    });

    send('printers', snapshot());

    // One physical change raises several manager events (a status change per
    // printer, plus connect/disconnect). Coalesce them into a single push so
    // the client re-renders once rather than three times.
    let coalesce: NodeJS.Timeout | null = null;
    const onChange = (): void => {
      if (coalesce) return;
      coalesce = setTimeout(() => {
        coalesce = null;
        send('printers', snapshot());
      }, 150);
    };

    const events = [
      'printerStatusChange',
      'printerConnected',
      'printerDisconnected',
      'printerRebound',
      'printerHealed'
    ];
    for (const name of events) {
      this.printerManager.on(name, onChange);
    }

    // Keeps intermediaries from closing an idle connection, and lets the client
    // notice a dead link.
    const heartbeat = setInterval(() => {
      if (res.writableEnded) return;
      try {
        res.write(': keep-alive\n\n');
      } catch {
        // Ignore.
      }
    }, 25000);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      if (coalesce) clearTimeout(coalesce);
      for (const name of events) {
        this.printerManager.off(name, onChange);
      }
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  /** Raw view of the Windows print system, for support and troubleshooting. */
  private async handlePrintSystemSnapshot(_req: Request, res: Response): Promise<void> {
    try {
      const snapshot = await this.printerManager.getPrintSystem().refresh();
      res.json(snapshot);
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async handleAddPrinter(req: Request, res: Response): Promise<void> {
    try {
      const cm = this.config.configManager;

      // A clash of ids is a conflict the caller can resolve, not a server
      // fault, and it deserves an answer that says what to do about it.
      const requestedId = typeof req.body?.id === 'string' ? req.body.id : '';
      if (requestedId && cm.getPrinter(requestedId)) {
        throw new PrintServiceError(
          `A printer with the id "${requestedId}" already exists. Edit that printer, ` +
            `or choose a different id.`,
          ErrorCodes.INVALID_REQUEST,
          409
        );
      }

      cm.addPrinter(req.body);

      // Live-register the printer in the manager and connect it
      try {
        this.printerManager.registerPrinter(req.body);
        if (req.body.enabled !== false) {
          await this.printerManager.connectPrinter(req.body.id);
        }
      } catch (connectErr) {
        this.logger.warn(`Printer added but failed to connect: ${(connectErr as Error).message}`);
      }

      res.status(201).json({
        success: true,
        message: 'Printer added and activated.',
        printers: cm.getPrinters()
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async handleUpdatePrinterConfig(req: Request, res: Response): Promise<void> {
    try {
      const { printerId } = req.params;
      const cm = this.config.configManager;
      cm.updatePrinter(printerId, req.body);

      // Live-update: unregister old adapter, register with new config, reconnect
      try {
        await this.printerManager.unregisterPrinter(printerId);
        const updatedConfig = cm.getPrinter(printerId);
        if (updatedConfig) {
          this.printerManager.registerPrinter(updatedConfig);
          if (updatedConfig.enabled !== false) {
            await this.printerManager.connectPrinter(printerId);
          }
        }
      } catch (reconnErr) {
        this.logger.warn(`Printer config updated but reconnect failed: ${(reconnErr as Error).message}`);
      }

      res.json({
        success: true,
        message: 'Printer configuration updated and applied.',
        printer: cm.getPrinter(printerId)
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async handleDeletePrinterConfig(req: Request, res: Response): Promise<void> {
    try {
      const { printerId } = req.params;
      const cm = this.config.configManager;

      // Live-unregister: disconnect and remove from manager
      try {
        await this.printerManager.unregisterPrinter(printerId);
      } catch (disconnErr) {
        this.logger.warn(`Error unregistering printer: ${(disconnErr as Error).message}`);
      }

      cm.removePrinter(printerId);
      res.json({
        success: true,
        message: 'Printer removed.',
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

/** Coerce a request field to a finite number, falling back when absent. */
function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export default ApiServer;
