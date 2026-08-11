/**
 * Configuration Manager
 * Loads and validates service configuration
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
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

const CashDrawerConfigSchema = z.object({
  enabled: z.boolean().default(false),
  // Pin 2 is the standard drawer connector; pin 5 is used by a minority of
  // printers and by the second drawer on twin-drawer setups.
  pin: z.union([z.literal(2), z.literal(5)]).default(2),
  // Bounded because the pulse is encoded in 2ms units in a single ESC/POS byte,
  // giving a 0-510ms range. Too long a pulse can burn out a drawer solenoid.
  onTimeMs: z.number().int().min(10).max(510).default(50),
  offTimeMs: z.number().int().min(10).max(510).default(200),
  openOnPrint: z.boolean().default(false)
});

const PrinterConfigSchema = z.object({
  id: z.string().min(1).max(50).regex(/^[a-zA-Z0-9_-]+$/, 'Printer ID must be alphanumeric with hyphens/underscores'),
  name: z.string().min(1).max(100),
  type: z.nativeEnum(PrinterType),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  // USB-specific (Windows). Printer names are only ever handed to PowerShell
  // through environment variables, never interpolated into script text, so
  // there is no injection surface to defend here. The previous character
  // allow-list rejected legitimate Windows queue names such as
  // "XP-80C @ Kitchen" or "HP LaserJet M15w+", which made those printers
  // impossible to add. Only control characters are refused.
  printerName: z
    .string()
    .max(220)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\u0000-\u001f\u007f]+$/, 'Printer name contains control characters')
    .optional(),
  vendorId: z.number().optional(),
  productId: z.number().optional(),
  // Network-specific
  host: z.string().optional(),
  port: z.number().optional(),
  timeout: z.number().min(1000).default(10000),
  maxRetries: z.number().min(0).default(3),
  capabilities: PrinterCapabilitiesSchema.default(DEFAULT_CAPABILITIES),
  cashDrawer: CashDrawerConfigSchema.optional(),
  metadata: z.record(z.unknown()).optional()
});

const ServerConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().min(1).max(65535).default(9100),
  enableHttps: z.boolean().default(false),
  certPath: z.string().optional(),
  keyPath: z.string().optional()
});

/**
 * Origins the POS front-end is served from.
 *
 * These are merged into every configuration on load, so a freshly imaged till
 * can talk to the service without anyone editing config.json. Loopback is
 * already trusted on any port; these cover the named host and the LAN address
 * the POS is published on.
 */
export const POS_DEFAULT_ORIGINS = [
  'http://pos.xenithpulse.local:8090',
  'http://pos.xenithpulse.local:8080',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8090'
];

const SecurityConfigSchema = z.object({
  // Extra origins beyond the ones always permitted. Entries may contain `*`
  // wildcards, e.g. "https://*.pos.example.com". Loopback origins are accepted
  // on any port without being listed here, so a service that falls back from
  // port 9100 to 9101 keeps working.
  allowedOrigins: z
    .array(z.string())
    .default([...POS_DEFAULT_ORIGINS, 'http://localhost:3000', 'http://127.0.0.1:3000']),
  allowedHosts: z.array(z.string()).default(['localhost', '127.0.0.1']),
  rateLimitPerMinute: z.number().min(1).max(1000).default(60),
  enableApiKey: z.boolean().default(true),
  apiKey: z.string().optional(),
  maxPayloadSize: z.number().min(1024).max(10 * 1024 * 1024).default(1024 * 1024), // 1MB default, 10MB max
  allowPrivateNetwork: z.boolean().default(true)
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

const BackupConfigSchema = z.object({
  enabled: z.boolean().default(true),
  // Loopback works regardless of the box's LAN IP because Caddy publishes the
  // POS on the host's port 8080.
  posBaseUrl: z.string().default('http://127.0.0.1:8080'),
  pollIntervalMs: z.number().min(5000).default(30000),
  timeoutMs: z.number().min(10000).default(300000),
  filenamePrefix: z.string().default('pos-backup'),
  // Native MongoDB tooling. The POS installer bundles mongodump/mongorestore
  // under its install directory; there is no container to exec into any more.
  //
  // NOTE on upgrades: an existing config.json still carrying the old
  // dockerComposeService/containerName keys parses fine - zod strips unknown
  // keys and applies the defaults below - so a site upgrading from the Docker
  // build keeps working without a hand-edited config.
  mongo: z.object({
    binDir: z.string().default('C:\\Program Files\\XP POS\\mongodb\\bin'),
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(27017),
    database: z.string().default('POS_PROD'),
    gzip: z.boolean().default(true)
  }).default({})
});

const ServiceConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  security: SecurityConfigSchema.default({}),
  queue: QueueConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  printers: z.array(PrinterConfigSchema).default([]),
  backup: BackupConfigSchema.default({})
});

export class ConfigManager {
  private config: ServiceConfig;
  private configPath: string;
  /**
   * Set when the file existed but could not be read or validated. While this
   * is true the in-memory config is a set of defaults, NOT the user's settings,
   * so writing it back would destroy their printers. Saves are refused instead.
   */
  private loadFailed = false;
  /** Size and mtime of the file as we last read or wrote it, for conflict detection. */
  private lastSeenStamp: string | null = null;
  /** Printers deleted in this process, so a merge never resurrects them. */
  private readonly deletedPrinterIds = new Set<string>();

  /** Set during load when POS origins had to be merged in. */
  private pendingPosOriginSave = false;

  constructor(configPath?: string) {
    this.configPath = configPath || this.getDefaultConfigPath();
    this.config = this.loadConfig();

    // Persist the merged POS origins once, after load has finished, so the
    // file reflects what the service is actually enforcing.
    if (this.pendingPosOriginSave && !this.loadFailed) {
      this.pendingPosOriginSave = false;
      try {
        this.saveConfig();
      } catch (error) {
        console.warn('Could not persist POS origins:', (error as Error).message);
      }
    }
  }

  /** A cheap fingerprint of the config file, used to spot outside changes. */
  private stampFile(): string | null {
    try {
      const stat = fs.statSync(this.configPath);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return null;
    }
  }

  /**
   * Read and parse config.json.
   *
   * Strips a UTF-8 BOM first: editing the file in Notepad, or writing it with
   * PowerShell's Out-File, prepends one, and JSON.parse rejects it outright.
   * Without this a single edit in the wrong editor makes the service fall back
   * to defaults and lose every configured printer.
   */
  private readRawConfig(): unknown {
    const content = fs.readFileSync(this.configPath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(content);
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
    this.loadFailed = false;

    if (fs.existsSync(this.configPath)) {
      try {
        rawConfig = this.readRawConfig();
      } catch (error) {
        console.error(`Error loading config from ${this.configPath}:`, error);
        this.loadFailed = true;

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
      // Running on defaults is survivable; overwriting the user's printers with
      // those defaults is not. Flag the failure so saveConfig refuses to write.
      this.loadFailed = true;
      return ServiceConfigSchema.parse({});
    }

    this.lastSeenStamp = this.stampFile();
    const config = result.data as ServiceConfig;

    // Guarantee the POS can reach the service on every machine, including ones
    // upgraded from a config written before these hosts existed.
    const missingPosOrigins = POS_DEFAULT_ORIGINS.filter(
      (origin) => !config.security.allowedOrigins.includes(origin)
    );
    if (missingPosOrigins.length > 0) {
      config.security.allowedOrigins = [
        ...config.security.allowedOrigins,
        ...missingPosOrigins
      ];
      console.log(`Added ${missingPosOrigins.length} POS origin(s) to the allow-list`);
      // Write them through so they show up in the Settings screen and survive
      // as a visible part of the configuration, rather than being invisibly
      // re-applied on every start.
      this.pendingPosOriginSave = true;
    }

    // Auto-generate API key if auth is enabled but no key is set
    if (config.security.enableApiKey && !config.security.apiKey) {
      config.security.apiKey = crypto.randomBytes(32).toString('hex');
      console.log('Generated new API key (no key was configured)');
      // Persist the generated key back to config.json
      try {
        const raw = fs.existsSync(this.configPath)
          ? JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
          : {};
        if (!raw.security) raw.security = {};
        raw.security.apiKey = config.security.apiKey;
        raw.security.enableApiKey = true;
        const tmpPath = this.configPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(raw, null, 2), 'utf8');
        fs.renameSync(tmpPath, this.configPath);
        console.log(`API key saved to ${this.configPath}`);
      } catch (err) {
        console.error('Failed to persist generated API key:', err);
      }
    }

    return config;
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
   * Get backup configuration
   */
  getBackupConfig() {
    return this.config.backup;
  }

  /**
   * Update backup config with validation
   */
  updateBackupConfig(updates: Record<string, unknown>): void {
    const merged = { ...this.config.backup, ...updates };
    const result = BackupConfigSchema.safeParse(merged);
    if (!result.success) {
      throw new Error(`Invalid backup config: ${result.error.message}`);
    }
    this.config.backup = result.data as typeof this.config.backup;
    this.saveConfig();
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
    this.deletedPrinterIds.add(id);
    this.saveConfig();
  }

  /**
   * Save configuration to file (atomic write via temp file + rename)
   */
  saveConfig(): void {
    // The in-memory config is defaults, not the user's settings. Writing it
    // would silently delete every printer they configured.
    if (this.loadFailed) {
      throw new Error(
        `Refusing to overwrite ${this.configPath}: it could not be read or validated at startup. ` +
          `Fix or remove the file and restart the service.`
      );
    }

    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // If something else changed the file since we last read it — a second
    // service instance, or someone editing by hand — a blind write would throw
    // their change away. Fold any printers we do not know about back in.
    const currentStamp = this.stampFile();
    if (this.lastSeenStamp && currentStamp && currentStamp !== this.lastSeenStamp) {
      this.mergeExternalChanges();
    }

    const tempPath = this.configPath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(this.config, null, 2), 'utf8');
    fs.renameSync(tempPath, this.configPath);
    this.lastSeenStamp = this.stampFile();
  }

  /**
   * Re-read the file and adopt printers that exist on disk but not in memory.
   *
   * Deliberately conservative: it only *adds* entries back. Our own view wins
   * for anything we already know about, so an edit made here is never undone by
   * a stale copy on disk.
   */
  private mergeExternalChanges(): void {
    try {
      const parsed = ServiceConfigSchema.safeParse(this.readRawConfig());
      if (!parsed.success) return;

      const onDisk = (parsed.data as ServiceConfig).printers ?? [];
      const known = new Set(this.config.printers.map((p) => p.id));
      const recovered = onDisk.filter(
        (p) => !known.has(p.id) && !this.deletedPrinterIds.has(p.id)
      );

      if (recovered.length > 0) {
        console.warn(
          `Config file changed outside this process; preserving ${recovered.length} printer(s) ` +
            `that would otherwise have been lost: ${recovered.map((p) => p.id).join(', ')}`
        );
        this.config.printers.push(...recovered);
      }
    } catch {
      // Unreadable on disk — keep what we have rather than failing the save.
    }
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
