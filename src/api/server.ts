/**
 * HTTP API Server
 * Secure local API for print job submission
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import cors from 'cors';
import helmet from 'helmet';
import { z } from 'zod';
import { RateLimiterMemory } from 'rate-limiter-flexible';
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

export class ApiServer {
  private app: Express;
  private server: import('http').Server | null = null;
  private queue: JobQueue;
  private printerManager: PrinterManager;
  private processor: JobProcessor;
  private logger: Logger;
  private config: ApiServerConfig;
  private rateLimiter: RateLimiterMemory;
  private startTime: number = Date.now();

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

    // Initialize rate limiter
    this.rateLimiter = new RateLimiterMemory({
      points: config.security.rateLimitPerMinute,
      duration: 60
    });

    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandler();
  }

  private setupMiddleware(): void {
    // Security headers
    this.app.use(helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false
    }));

    // CORS configuration
    const hasWildcard = this.config.security.allowedOrigins.includes('*');
    this.app.use(cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (e.g., server-to-server)
        if (!origin) {
          callback(null, true);
          return;
        }

        if (hasWildcard) {
          // Wildcard: allow all origins but without reflecting the specific origin
          callback(null, '*');
        } else if (this.config.security.allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key', 'X-API-Key'],
      // Only send credentials when origins are explicitly listed (not wildcard)
      credentials: !hasWildcard
    }));

    // Body parsing with size limit
    this.app.use(express.json({ 
      limit: this.config.security.maxPayloadSize 
    }));

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

  private validateApiKey(req: Request, res: Response, next: NextFunction): void {
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

  private async rateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const key = req.ip || 'unknown';
      await this.rateLimiter.consume(key);
      next();
    } catch {
      this.logger.warn({ ip: req.ip }, 'Rate limit exceeded');
      res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.'
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

    // Printer endpoints
    this.app.get('/api/printers', this.handleListPrinters.bind(this));
    this.app.get('/api/printers/:printerId', this.handleGetPrinter.bind(this));
    this.app.get('/api/printers/:printerId/status', this.handleGetPrinterStatus.bind(this));
    this.app.post('/api/printers/:printerId/test', this.handleTestPrinter.bind(this));

    // Queue management
    this.app.get('/api/queue/stats', this.handleQueueStats.bind(this));
    this.app.post('/api/queue/pause', this.handlePauseQueue.bind(this));
    this.app.post('/api/queue/resume', this.handleResumeQueue.bind(this));

    // Metrics
    this.app.get('/api/metrics', this.handleMetrics.bind(this));

    // Configuration management
    this.app.get('/api/config', this.handleGetConfig.bind(this));
    this.app.put('/api/config/server', this.handleUpdateServerConfig.bind(this));
    this.app.put('/api/config/security', this.handleUpdateSecurityConfig.bind(this));
    this.app.get('/api/system/printers', this.handleListSystemPrinters.bind(this));
    this.app.post('/api/config/printers', this.handleAddPrinter.bind(this));
    this.app.put('/api/config/printers/:printerId', this.handleUpdatePrinterConfig.bind(this));
    this.app.delete('/api/config/printers/:printerId', this.handleDeletePrinterConfig.bind(this));

    // Dashboard (serves static HTML)
    this.app.get('/dashboard', this.handleDashboard.bind(this));
    this.app.get('/', (_req: Request, res: Response) => res.redirect('/dashboard'));
  }

  private handleHealth(_req: Request, res: Response): void {
    const printerSummary = this.printerManager.getSummary();
    const queueStats = this.queue.getStats();

    const status: 'healthy' | 'degraded' | 'unhealthy' = 
      printerSummary.online === 0 ? 'unhealthy' :
      printerSummary.online < printerSummary.total ? 'degraded' :
      'healthy';

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

    res.status(status === 'healthy' ? 200 : 503).json(response);
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
      res.json({ success: true, server: cm.getServerConfig() });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleUpdateSecurityConfig(req: Request, res: Response): void {
    try {
      const cm = this.config.configManager;
      cm.updateSecurityConfig(req.body);
      res.json({ success: true, security: cm.getSecurityConfig() });
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
      res.status(201).json({ success: true, printers: cm.getPrinters() });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleUpdatePrinterConfig(req: Request, res: Response): void {
    try {
      const { printerId } = req.params;
      const cm = this.config.configManager;
      cm.updatePrinter(printerId, req.body);
      res.json({ success: true, printer: cm.getPrinter(printerId) });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleDeletePrinterConfig(req: Request, res: Response): void {
    try {
      const { printerId } = req.params;
      const cm = this.config.configManager;
      cm.removePrinter(printerId);
      res.json({ success: true, printers: cm.getPrinters() });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private handleDashboard(_req: Request, res: Response): void {
    const dashboardPath = path.join(__dirname, '..', '..', 'public', 'dashboard.html');
    if (fs.existsSync(dashboardPath)) {
      res.sendFile(dashboardPath);
    } else {
      res.status(404).send('Dashboard not found. Ensure public/dashboard.html exists.');
    }
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

    this.logger.error({ error }, 'Unexpected error');
    
    res.status(500).json({
      error: ErrorCodes.INTERNAL_ERROR,
      message: 'An internal error occurred'
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
      this.logger.error({ error }, 'Unhandled error');
      
      res.status(500).json({
        error: ErrorCodes.INTERNAL_ERROR,
        message: 'An internal error occurred'
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
        resolve();
      });
      server.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Stop the API server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => {
        this.logger.info('API server stopped');
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Get Express app instance (for testing)
   */
  getApp(): Express {
    return this.app;
  }
}

export default ApiServer;
