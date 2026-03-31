/**
 * Configuration Manager
 * Loads and validates service configuration
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import {
  ServiceConfig,
  PrinterConfig,
  PrinterType,
  PrinterCapabilities
} from '../types';

// Default printer capabilities
const DEFAULT_CAPABILITIES: PrinterCapabilities = {
  maxWidth: 48,
  supportsBold: true,
  supportsUnderline: true,
  supportsBarcode: true,
  supportsQRCode: true,
  supportsImage: false,
  supportsCut: true,
  supportsPartialCut: true,
  supportsCashDrawer: true,
  supportsDensity: true,
  codepage: 0
};

// Zod schemas for validation
const PrinterCapabilitiesSchema = z.object({
  maxWidth: z.number().min(20).max(80).default(48),
  supportsBold: z.boolean().default(true),
  supportsUnderline: z.boolean().default(true),
  supportsBarcode: z.boolean().default(true),
  supportsQRCode: z.boolean().default(true),
  supportsImage: z.boolean().default(false),
  supportsCut: z.boolean().default(true),
  supportsPartialCut: z.boolean().default(true),
  supportsCashDrawer: z.boolean().default(true),
  supportsDensity: z.boolean().default(true),
  codepage: z.number().default(0)
});

const PrinterConfigSchema = z.object({
  id: z.string().min(1).max(50).regex(/^[a-zA-Z0-9_-]+$/, 'Printer ID must be alphanumeric with hyphens/underscores'),
  name: z.string().min(1).max(100),
  type: z.nativeEnum(PrinterType),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  // USB-specific (Windows) — validated to prevent command injection
  printerName: z.string().max(200).regex(/^[a-zA-Z0-9 ()\-._\\/#:]+$/, 'Printer name contains disallowed characters').optional(),
  vendorId: z.number().optional(),
  productId: z.number().optional(),
  // Network-specific
  host: z.string().optional(),
  port: z.number().optional(),
  timeout: z.number().min(1000).default(10000),
  maxRetries: z.number().min(0).default(3),
  capabilities: PrinterCapabilitiesSchema.default(DEFAULT_CAPABILITIES),
  metadata: z.record(z.unknown()).optional()
});

const ServerConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().min(1).max(65535).default(9100),
  enableHttps: z.boolean().default(false),
  certPath: z.string().optional(),
  keyPath: z.string().optional()
});

const SecurityConfigSchema = z.object({
  allowedOrigins: z.array(z.string()).default(['http://localhost:3000', 'http://127.0.0.1:3000']),
  allowedHosts: z.array(z.string()).default(['localhost', '127.0.0.1']),
  rateLimitPerMinute: z.number().min(1).max(1000).default(60),
  enableApiKey: z.boolean().default(false),
  apiKey: z.string().optional(),
  maxPayloadSize: z.number().min(1024).max(10 * 1024 * 1024).default(1024 * 1024) // 1MB default, 10MB max
});

const QueueConfigSchema = z.object({
  maxConcurrentJobs: z.number().min(1).default(3),
  maxRetries: z.number().min(0).default(5),
  retryDelayMs: z.number().min(100).default(1000),
  retryBackoffMultiplier: z.number().min(1).default(2),
  maxRetryDelayMs: z.number().min(1000).default(60000),
  jobTimeoutMs: z.number().min(1000).default(30000),
  cleanupIntervalMs: z.number().min(0).default(3600000), // 1 hour
  maxJobAgeMs: z.number().min(0).default(86400000 * 7), // 7 days
  persistPath: z.string().default('./data/jobs.db')
});

const LoggingConfigSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  file: z.string().optional(),
  maxFiles: z.number().min(1).optional(),
  maxSize: z.string().optional(),
  console: z.boolean().default(true)
});

const ServiceConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  security: SecurityConfigSchema.default({}),
  queue: QueueConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  printers: z.array(PrinterConfigSchema).default([])
});

export class ConfigManager {
  private config: ServiceConfig;
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath || this.getDefaultConfigPath();
    this.config = this.loadConfig();
  }

  private getDefaultConfigPath(): string {
    // Look for config in multiple locations
    const candidates = [
      './config.json',
      './config/config.json',
      path.join(process.env.APPDATA || '', 'xp-thermal-service', 'config.json'),
      path.join(__dirname, '..', '..', 'config.json')
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    // Return default path (will be created)
    return './config.json';
  }

  private loadConfig(): ServiceConfig {
    let rawConfig: unknown = {};

    if (fs.existsSync(this.configPath)) {
      try {
        const content = fs.readFileSync(this.configPath, 'utf8');
        rawConfig = JSON.parse(content);
      } catch (error) {
        console.error(`Error loading config from ${this.configPath}:`, error);
        
        // Backup corrupt config
        try {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const backupPath = this.configPath.replace('.json', `.corrupt.${timestamp}.json`);
          fs.copyFileSync(this.configPath, backupPath);
          console.warn(`Corrupt config backed up to: ${backupPath}`);
        } catch {
          // Ignore backup errors
        }
        
        // Try to load from example config
        const examplePath = this.configPath.replace('config.json', 'config.example.json');
        if (fs.existsSync(examplePath)) {
          try {
            const exampleContent = fs.readFileSync(examplePath, 'utf8');
            rawConfig = JSON.parse(exampleContent);
            console.log('Loaded configuration from example file');
          } catch {
            // Use defaults
          }
        }
      }
    } else {
      // Config doesn't exist - try to copy from example
      const examplePath = this.configPath.replace('config.json', 'config.example.json');
      if (fs.existsSync(examplePath)) {
        try {
          fs.copyFileSync(examplePath, this.configPath);
          const content = fs.readFileSync(this.configPath, 'utf8');
          rawConfig = JSON.parse(content);
          console.log(`Created config.json from example template`);
        } catch {
          // Use defaults
        }
      }
    }

    // Parse and validate with defaults
    const result = ServiceConfigSchema.safeParse(rawConfig);
    
    if (!result.success) {
      console.error('Configuration validation errors:', result.error.issues);
      // Return default config
      return ServiceConfigSchema.parse({});
    }

    return result.data as ServiceConfig;
  }

  /**
   * Get the full configuration
   */
  getConfig(): ServiceConfig {
    return this.config;
  }

  /**
   * Get server configuration
   */
  getServerConfig() {
    return this.config.server;
  }

  /**
   * Get security configuration
   */
  getSecurityConfig() {
    return this.config.security;
  }

  /**
   * Get queue configuration
   */
  getQueueConfig() {
    return this.config.queue;
  }

  /**
   * Get logging configuration
   */
  getLoggingConfig() {
    return this.config.logging;
  }

  /**
   * Get printer configurations
   */
  getPrinters(): PrinterConfig[] {
    return this.config.printers;
  }

  /**
   * Get a specific printer configuration
   */
  getPrinter(id: string): PrinterConfig | undefined {
    return this.config.printers.find(p => p.id === id);
  }

  /**
   * Update server config with validation
   */
  updateServerConfig(updates: Record<string, unknown>): void {
    const merged = { ...this.config.server, ...updates };
    const result = ServerConfigSchema.safeParse(merged);
    if (!result.success) {
      throw new Error(`Invalid server config: ${result.error.message}`);
    }
    this.config.server = result.data as typeof this.config.server;
    this.saveConfig();
  }

  /**
   * Update security config with validation
   */
  updateSecurityConfig(updates: Record<string, unknown>): void {
    const merged = { ...this.config.security, ...updates };
    const result = SecurityConfigSchema.safeParse(merged);
    if (!result.success) {
      throw new Error(`Invalid security config: ${result.error.message}`);
    }
    this.config.security = result.data as typeof this.config.security;
    this.saveConfig();
  }

  /**
   * Add a printer configuration
   */
  addPrinter(printer: PrinterConfig): void {
    // Validate printer config
    const result = PrinterConfigSchema.safeParse(printer);
    if (!result.success) {
      throw new Error(`Invalid printer config: ${result.error.message}`);
    }

    // Check for duplicate ID
    if (this.config.printers.some(p => p.id === printer.id)) {
      throw new Error(`Printer with ID ${printer.id} already exists`);
    }

    this.config.printers.push(result.data as PrinterConfig);
    this.saveConfig();
  }

  /**
   * Update a printer configuration
   */
  updatePrinter(id: string, updates: Partial<PrinterConfig>): void {
    const index = this.config.printers.findIndex(p => p.id === id);
    if (index === -1) {
      throw new Error(`Printer with ID ${id} not found`);
    }

    const updated = { ...this.config.printers[index], ...updates };
    
    // Validate updated config
    const result = PrinterConfigSchema.safeParse(updated);
    if (!result.success) {
      throw new Error(`Invalid printer config: ${result.error.message}`);
    }

    this.config.printers[index] = result.data as PrinterConfig;
    this.saveConfig();
  }

  /**
   * Remove a printer configuration
   */
  removePrinter(id: string): void {
    const index = this.config.printers.findIndex(p => p.id === id);
    if (index === -1) {
      throw new Error(`Printer with ID ${id} not found`);
    }

    this.config.printers.splice(index, 1);
    this.saveConfig();
  }

  /**
   * Save configuration to file (atomic write via temp file + rename)
   */
  saveConfig(): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = this.configPath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(this.config, null, 2), 'utf8');
    fs.renameSync(tempPath, this.configPath);
  }

  /**
   * Reload configuration from file
   */
  reload(): void {
    this.config = this.loadConfig();
  }

  /**
   * Create default configuration file
   */
  static createDefaultConfig(configPath: string): void {
    const defaultConfig = ServiceConfigSchema.parse({
      server: {
        host: '127.0.0.1',
        port: 9100
      },
      printers: [
        {
          id: 'default',
          name: 'Default Printer',
          type: PrinterType.NETWORK,
          enabled: true,
          isDefault: true,
          host: '192.168.1.100',
          port: 9100,
          timeout: 10000,
          maxRetries: 3,
          capabilities: DEFAULT_CAPABILITIES
        }
      ]
    });

    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(
      configPath,
      JSON.stringify(defaultConfig, null, 2),
      'utf8'
    );
  }
}

export default ConfigManager;
