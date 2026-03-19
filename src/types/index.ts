/**
 * XP Thermal Service - Core Type Definitions
 * Production-grade thermal printing service for restaurant POS
 */

// ============================================================================
// Job & Queue Types
// ============================================================================

export enum JobStatus {
  PENDING = 'pending',
  QUEUED = 'queued',
  PROCESSING = 'processing',
  PRINTING = 'printing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  RETRY_SCHEDULED = 'retry_scheduled',
  CANCELLED = 'cancelled',
  DEAD_LETTER = 'dead_letter'
}

export enum JobPriority {
  LOW = 0,
  NORMAL = 1,
  HIGH = 2,
  CRITICAL = 3
}

export interface PrintJob {
  id: string;
  idempotencyKey: string;
  printerId: string;
  templateType: TemplateType;
  payload: Record<string, unknown>;
  priority: JobPriority;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  scheduledAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  rawCommands?: Buffer;
  metadata?: Record<string, unknown>;
}

export interface JobResult {
  success: boolean;
  jobId: string;
  status: JobStatus;
  bytesWritten?: number;
  error?: string;
  duration?: number;
}

// ============================================================================
// Printer Types
// ============================================================================

export enum PrinterType {
  USB = 'usb',
  NETWORK = 'network',
  SERIAL = 'serial'
}

export enum PrinterStatus {
  ONLINE = 'online',
  OFFLINE = 'offline',
  ERROR = 'error',
  PAPER_OUT = 'paper_out',
  COVER_OPEN = 'cover_open',
  BUSY = 'busy',
  UNKNOWN = 'unknown'
}

export interface PrinterCapabilities {
  maxWidth: number; // characters per line
  supportsBold: boolean;
  supportsUnderline: boolean;
  supportsBarcode: boolean;
  supportsQRCode: boolean;
  supportsImage: boolean;
  supportsCut: boolean;
  supportsPartialCut: boolean;
  supportsCashDrawer: boolean;
  supportsDensity: boolean;
  codepage: number;
}

export interface PrinterConfig {
  id: string;
  name: string;
  type: PrinterType;
  enabled: boolean;
  isDefault: boolean;
  // USB-specific (Windows)
  printerName?: string; // Windows shared printer name
  vendorId?: number;
  productId?: number;
  // Network-specific
  host?: string;
  port?: number;
  // Common settings
  timeout: number;
  maxRetries: number;
  capabilities: PrinterCapabilities;
  metadata?: Record<string, unknown>;
}

export interface PrinterState {
  id: string;
  status: PrinterStatus;
  lastSeen: number;
  lastError?: string;
  consecutiveFailures: number;
  totalJobsPrinted: number;
  isConnected: boolean;
}

export interface PrinterInfo extends PrinterConfig {
  state: PrinterState;
}

// ============================================================================
// Template Types
// ============================================================================

export enum TemplateType {
  RECEIPT = 'receipt',
  KOT = 'kot',
  INVOICE = 'invoice',
  TEST = 'test',
  RAW = 'raw',
  LABEL = 'label'
}

export interface ReceiptPayload {
  orderNumber: string;
  orderDate: string;
  orderTime?: string;
  items: ReceiptItem[];
  subtotal: number;
  tax?: number;
  taxRate?: number;
  discount?: number;
  discountName?: string;
  total: number;
  paymentMethod?: string;
  amountPaid?: number;
  change?: number;
  customerName?: string;
  tableName?: string;
  serverName?: string;
  header?: ReceiptHeader;
  footer?: ReceiptFooter;
  barcode?: string;
  qrCode?: string;
}

export interface ReceiptItem {
  name: string;
  quantity: number;
  price: number;
  total: number;
  modifiers?: string[];
  notes?: string;
}

export interface ReceiptHeader {
  storeName: string;
  storeAddress?: string[];
  storePhone?: string;
  storeEmail?: string;
  taxId?: string;
  logo?: Buffer;
}

export interface ReceiptFooter {
  message?: string[];
  thankYouMessage?: string;
}

export interface KOTPayload {
  orderNumber: string;
  tableName?: string;
  serverName?: string;
  orderTime: string;
  items: KOTItem[];
  notes?: string;
  isVoid?: boolean;
  isReprint?: boolean;
  category?: string;
}

export interface KOTItem {
  name: string;
  quantity: number;
  modifiers?: string[];
  notes?: string;
  isVoid?: boolean;
}

export interface InvoicePayload {
  invoiceNumber: string;
  invoiceDate: string;
  dueDate?: string;
  customer: InvoiceCustomer;
  items: InvoiceItem[];
  subtotal: number;
  tax?: number;
  taxRate?: number;
  discount?: number;
  total: number;
  notes?: string;
  terms?: string;
  header?: ReceiptHeader;
}

export interface InvoiceCustomer {
  name: string;
  address?: string[];
  phone?: string;
  email?: string;
  taxId?: string;
}

export interface InvoiceItem {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
  sku?: string;
}

export interface TestPayload {
  message?: string;
  includeBarcode?: boolean;
  includeQR?: boolean;
  includeAllFonts?: boolean;
}

export interface RawPayload {
  commands: number[] | Buffer | string;
  encoding?: 'hex' | 'base64' | 'raw';
}

// ============================================================================
// ESC/POS Command Types
// ============================================================================

export enum TextAlign {
  LEFT = 0,
  CENTER = 1,
  RIGHT = 2
}

export enum FontSize {
  NORMAL = 0,
  DOUBLE_WIDTH = 1,
  DOUBLE_HEIGHT = 2,
  DOUBLE_BOTH = 3
}

export enum BarcodeType {
  UPC_A = 65,
  UPC_E = 66,
  EAN13 = 67,
  EAN8 = 68,
  CODE39 = 69,
  ITF = 70,
  CODABAR = 71,
  CODE93 = 72,
  CODE128 = 73
}

export enum QRErrorCorrection {
  L = 48, // 7%
  M = 49, // 15%
  Q = 50, // 25%
  H = 51  // 30%
}

export interface TextStyle {
  bold?: boolean;
  underline?: boolean;
  inverse?: boolean;
  fontSize?: FontSize;
  align?: TextAlign;
}

export interface BarcodeOptions {
  type: BarcodeType;
  width?: number;
  height?: number;
  position?: 'none' | 'above' | 'below' | 'both';
}

export interface QRCodeOptions {
  errorCorrection?: QRErrorCorrection;
  moduleSize?: number;
}

// ============================================================================
// API Types
// ============================================================================

export interface PrintRequest {
  idempotencyKey: string;
  printerId?: string;
  templateType: TemplateType;
  payload: Record<string, unknown>;
  priority?: JobPriority;
  copies?: number;
}

export interface PrintResponse {
  success: boolean;
  jobId: string;
  status: JobStatus;
  message?: string;
}

export interface JobStatusResponse {
  job: PrintJob | null;
  found: boolean;
}

export interface PrinterListResponse {
  printers: PrinterInfo[];
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  version: string;
  printers: {
    total: number;
    online: number;
    offline: number;
  };
  queue: {
    pending: number;
    processing: number;
    failed: number;
  };
}

export interface MetricsResponse {
  uptime: number;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  avgJobDuration: number;
  jobsPerMinute: number;
  queueDepth: number;
  printerMetrics: Record<string, PrinterMetrics>;
}

export interface PrinterMetrics {
  printerId: string;
  jobsCompleted: number;
  jobsFailed: number;
  avgPrintTime: number;
  bytesWritten: number;
  lastPrintTime: number | null;
  consecutiveFailures: number;
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface ServiceConfig {
  server: ServerConfig;
  security: SecurityConfig;
  queue: QueueConfig;
  logging: LoggingConfig;
  printers: PrinterConfig[];
}

export interface ServerConfig {
  host: string;
  port: number;
  enableHttps: boolean;
  certPath?: string;
  keyPath?: string;
}

export interface SecurityConfig {
  allowedOrigins: string[];
  allowedHosts: string[];
  rateLimitPerMinute: number;
  enableApiKey: boolean;
  apiKey?: string;
  maxPayloadSize: number;
}

export interface QueueConfig {
  maxConcurrentJobs: number;
  maxRetries: number;
  retryDelayMs: number;
  retryBackoffMultiplier: number;
  maxRetryDelayMs: number;
  jobTimeoutMs: number;
  cleanupIntervalMs: number;
  maxJobAgeMs: number;
  persistPath: string;
}

export interface LoggingConfig {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  file?: string;
  maxFiles?: number;
  maxSize?: string;
  console: boolean;
}

// ============================================================================
// Event Types
// ============================================================================

export enum ServiceEvent {
  JOB_CREATED = 'job:created',
  JOB_QUEUED = 'job:queued',
  JOB_STARTED = 'job:started',
  JOB_COMPLETED = 'job:completed',
  JOB_FAILED = 'job:failed',
  JOB_RETRY = 'job:retry',
  JOB_CANCELLED = 'job:cancelled',
  
  PRINTER_CONNECTED = 'printer:connected',
  PRINTER_DISCONNECTED = 'printer:disconnected',
  PRINTER_ERROR = 'printer:error',
  PRINTER_STATUS_CHANGED = 'printer:status_changed',
  
  SERVICE_STARTED = 'service:started',
  SERVICE_STOPPED = 'service:stopped',
  SERVICE_ERROR = 'service:error'
}

export interface ServiceEventData {
  event: ServiceEvent;
  timestamp: number;
  data: Record<string, unknown>;
}

// ============================================================================
// Error Types
// ============================================================================

export class PrintServiceError extends Error {
  code: string;
  statusCode: number;
  details?: Record<string, unknown>;

  constructor(message: string, code: string, statusCode = 500, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PrintServiceError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class PrinterError extends PrintServiceError {
  printerId: string;

  constructor(message: string, printerId: string, code: string, details?: Record<string, unknown>) {
    super(message, code, 500, details);
    this.name = 'PrinterError';
    this.printerId = printerId;
  }
}

export class JobError extends PrintServiceError {
  jobId: string;

  constructor(message: string, jobId: string, code: string, details?: Record<string, unknown>) {
    super(message, code, 500, details);
    this.name = 'JobError';
    this.jobId = jobId;
  }
}

// Error codes
export const ErrorCodes = {
  // Printer errors
  PRINTER_NOT_FOUND: 'PRINTER_NOT_FOUND',
  PRINTER_OFFLINE: 'PRINTER_OFFLINE',
  PRINTER_BUSY: 'PRINTER_BUSY',
  PRINTER_ERROR: 'PRINTER_ERROR',
  PRINTER_PAPER_OUT: 'PRINTER_PAPER_OUT',
  PRINTER_TIMEOUT: 'PRINTER_TIMEOUT',
  PRINTER_CONNECTION_FAILED: 'PRINTER_CONNECTION_FAILED',
  
  // Job errors
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  JOB_DUPLICATE: 'JOB_DUPLICATE',
  JOB_CANCELLED: 'JOB_CANCELLED',
  JOB_TIMEOUT: 'JOB_TIMEOUT',
  JOB_INVALID_PAYLOAD: 'JOB_INVALID_PAYLOAD',
  
  // Queue errors
  QUEUE_FULL: 'QUEUE_FULL',
  QUEUE_ERROR: 'QUEUE_ERROR',
  
  // API errors
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
} as const;
