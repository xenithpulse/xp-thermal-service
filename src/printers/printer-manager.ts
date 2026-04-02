/**
 * Printer Manager
 * Manages multiple printers and provides unified access
 */

import { EventEmitter } from 'events';
import { PrinterAdapter, PrintResult } from './base-adapter';
import { USBPrinterAdapter } from './usb-adapter';
import { NetworkPrinterAdapter } from './network-adapter';
import {
  PrinterConfig,
  PrinterInfo,
  PrinterType,
  PrinterStatus,
  PrintServiceError,
  ErrorCodes
} from '../types';
import { Logger } from '../utils/logger';

export interface PrinterManagerConfig {
  printers: PrinterConfig[];
  autoConnect: boolean;
  healthCheckInterval: number;
}

export class PrinterManager extends EventEmitter {
  private printers: Map<string, PrinterAdapter> = new Map();
  private configs: Map<string, PrinterConfig> = new Map();
  private defaultPrinterId: string | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private readonly logger: Logger;
  private readonly healthCheckInterval: number;
  private _initializing = false;

  constructor(config: PrinterManagerConfig, logger: Logger) {
    super();
    this.logger = logger;
    this.healthCheckInterval = config.healthCheckInterval || 30000;

    // Register printers from config
    for (const printerConfig of config.printers) {
      this.registerPrinter(printerConfig);
    }

    // Auto-connect if enabled
    if (config.autoConnect) {
      this.connectAll().catch(err => {
        this.logger.error('Error during auto-connect:', err);
      });
    }
  }

  /**
   * Register a new printer
   */
  registerPrinter(config: PrinterConfig): void {
    this.configs.set(config.id, config);

    // Create adapter based on type
    let adapter: PrinterAdapter;
    
    switch (config.type) {
      case PrinterType.USB:
        adapter = new USBPrinterAdapter(config);
        break;
      case PrinterType.NETWORK:
        adapter = new NetworkPrinterAdapter(config);
        break;
      default:
        throw new Error(`Unsupported printer type: ${config.type}`);
    }

    // Set up event forwarding
    adapter.on('connected', (id) => {
      this.logger.info(`Printer connected: ${id}`);
      this.emit('printerConnected', id);
    });

    adapter.on('disconnected', (id) => {
      this.logger.warn(`Printer disconnected: ${id}`);
      this.emit('printerDisconnected', id);
    });

    adapter.on('error', (error) => {
      this.logger.error(`Printer error:`, error);
      this.emit('printerError', { printerId: adapter.id, error });
    });

    adapter.on('stateChange', (state) => {
      this.emit('printerStateChange', state);
    });

    adapter.on('reconnecting', (info) => {
      this.logger.info(`Printer reconnecting: ${info.id}, attempt ${info.attempt}`);
      this.emit('printerReconnecting', info);
    });

    this.printers.set(config.id, adapter);

    // Set as default if specified or if it's the first printer
    if (config.isDefault || this.defaultPrinterId === null) {
      this.defaultPrinterId = config.id;
    }

    this.logger.info(`Registered printer: ${config.id} (${config.type})`);
  }

  /**
   * Unregister a printer
   */
  async unregisterPrinter(printerId: string): Promise<void> {
    const adapter = this.printers.get(printerId);
    if (adapter) {
      await adapter.disconnect();
      adapter.removeAllListeners();
      this.printers.delete(printerId);
    }
    this.configs.delete(printerId);

    if (this.defaultPrinterId === printerId) {
      const firstPrinter = this.printers.keys().next().value;
      this.defaultPrinterId = firstPrinter ?? null;
    }

    this.logger.info(`Unregistered printer: ${printerId}`);
  }

  /**
   * Get a printer adapter by ID
   */
  getPrinter(printerId: string): PrinterAdapter | undefined {
    return this.printers.get(printerId);
  }

  /**
   * Get the default printer
   */
  getDefaultPrinter(): PrinterAdapter | undefined {
    if (!this.defaultPrinterId) return undefined;
    return this.printers.get(this.defaultPrinterId);
  }

  /**
   * Set the default printer
   */
  setDefaultPrinter(printerId: string): void {
    if (!this.printers.has(printerId)) {
      throw new PrintServiceError(
        `Printer not found: ${printerId}`,
        ErrorCodes.PRINTER_NOT_FOUND,
        404
      );
    }
    this.defaultPrinterId = printerId;
    
    // Update configs
    for (const [id, config] of this.configs) {
      config.isDefault = id === printerId;
    }
  }

  /**
   * Get all printer info
   */
  getAllPrinters(): PrinterInfo[] {
    const printers: PrinterInfo[] = [];

    for (const [id, adapter] of this.printers) {
      const config = this.configs.get(id)!;
      printers.push({
        ...config,
        state: adapter.state
      });
    }

    return printers;
  }

  /**
   * Get enabled printers
   */
  getEnabledPrinters(): PrinterInfo[] {
    return this.getAllPrinters().filter(p => p.enabled);
  }

  /**
   * Get online printers
   */
  getOnlinePrinters(): PrinterInfo[] {
    return this.getAllPrinters().filter(
      p => p.enabled && p.state.status === PrinterStatus.ONLINE
    );
  }

  /**
   * Connect to a specific printer
   */
  async connectPrinter(printerId: string): Promise<void> {
    const adapter = this.printers.get(printerId);
    if (!adapter) {
      throw new PrintServiceError(
        `Printer not found: ${printerId}`,
        ErrorCodes.PRINTER_NOT_FOUND,
        404
      );
    }

    const config = this.configs.get(printerId)!;
    if (!config.enabled) {
      throw new PrintServiceError(
        `Printer is disabled: ${printerId}`,
        ErrorCodes.PRINTER_OFFLINE,
        400
      );
    }

    await adapter.connect();
  }

  /**
   * Disconnect from a specific printer
   */
  async disconnectPrinter(printerId: string): Promise<void> {
    const adapter = this.printers.get(printerId);
    if (adapter) {
      await adapter.disconnect();
    }
  }

  /**
   * Connect to all enabled printers
   */
  async connectAll(): Promise<Map<string, Error | null>> {
    this._initializing = true;
    const results = new Map<string, Error | null>();
    
    try {
      const connectPromises = Array.from(this.printers.entries())
        .filter(([id]) => this.configs.get(id)?.enabled)
        .map(async ([id, adapter]) => {
          try {
            await adapter.connect();
            results.set(id, null);
            this.logger.info(`Connected to printer: ${id}`);
          } catch (error) {
            results.set(id, error as Error);
            this.logger.error(`Failed to connect to printer ${id}:`, error);
          }
        });

      await Promise.allSettled(connectPromises);
    } finally {
      this._initializing = false;
    }
    
    // Start health check after connecting
    this.startHealthCheck();
    
    return results;
  }

  /**
   * Disconnect from all printers
   */
  async disconnectAll(): Promise<void> {
    this.stopHealthCheck();
    
    const disconnectPromises = Array.from(this.printers.values())
      .map(adapter => adapter.disconnect().catch(() => {}));

    await Promise.allSettled(disconnectPromises);
  }

  /**
   * Print to a specific printer
   */
  async print(printerId: string, data: Buffer): Promise<PrintResult> {
    const adapter = this.printers.get(printerId);
    if (!adapter) {
      throw new PrintServiceError(
        `Printer not found: ${printerId}`,
        ErrorCodes.PRINTER_NOT_FOUND,
        404
      );
    }

    const config = this.configs.get(printerId)!;
    if (!config.enabled) {
      throw new PrintServiceError(
        `Printer is disabled: ${printerId}`,
        ErrorCodes.PRINTER_OFFLINE,
        400
      );
    }

    if (!adapter.isConnected()) {
      // Try to reconnect
      this.logger.info(`Printer ${printerId} not connected, attempting to reconnect...`);
      try {
        await adapter.connect();
      } catch (error) {
        throw new PrintServiceError(
          `Failed to connect to printer: ${(error as Error).message}`,
          ErrorCodes.PRINTER_CONNECTION_FAILED,
          503
        );
      }
    }

    return adapter.write(data);
  }

  /**
   * Print to the default printer (with fallback)
   */
  async printToDefault(data: Buffer): Promise<PrintResult> {
    // Try default printer first
    if (this.defaultPrinterId) {
      const defaultAdapter = this.printers.get(this.defaultPrinterId);
      if (defaultAdapter?.isConnected()) {
        return this.print(this.defaultPrinterId, data);
      }
    }

    // Try to find any online printer as fallback
    const onlinePrinters = this.getOnlinePrinters();
    if (onlinePrinters.length > 0) {
      this.logger.warn(`Default printer unavailable, falling back to ${onlinePrinters[0].id}`);
      return this.print(onlinePrinters[0].id, data);
    }

    throw new PrintServiceError(
      'No printers available',
      ErrorCodes.PRINTER_OFFLINE,
      503
    );
  }

  /**
   * Get printer status
   */
  async getPrinterStatus(printerId: string): Promise<PrinterStatus> {
    const adapter = this.printers.get(printerId);
    if (!adapter) {
      return PrinterStatus.UNKNOWN;
    }
    return adapter.getStatus();
  }

  /**
   * Health check for a specific printer
   */
  async healthCheck(printerId: string): Promise<boolean> {
    const adapter = this.printers.get(printerId);
    if (!adapter) {
      return false;
    }
    return adapter.healthCheck();
  }

  /**
   * Health check all printers
   */
  async healthCheckAll(): Promise<Map<string, PrinterStatus>> {
    const results = new Map<string, PrinterStatus>();

    const checkPromises = Array.from(this.printers.entries())
      .map(async ([id, adapter]) => {
        try {
          const status = await adapter.getStatus();
          results.set(id, status);
        } catch {
          results.set(id, PrinterStatus.ERROR);
        }
      });

    await Promise.allSettled(checkPromises);
    return results;
  }

  /**
   * Start periodic health check
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      return;
    }

    this.healthCheckTimer = setInterval(async () => {
      const statuses = await this.healthCheckAll();
      
      for (const [id, status] of statuses) {
        const adapter = this.printers.get(id);
        if (!adapter) continue;
        
        if (status !== adapter.state.status) {
          this.emit('printerStatusChange', { id, status });
        }

        // Auto-reconnect offline/error printers that are enabled
        const config = this.configs.get(id);
        if (config?.enabled && (status === PrinterStatus.OFFLINE || status === PrinterStatus.ERROR)) {
          this.logger.info(`Printer ${id} is ${status}, attempting auto-reconnect...`);
          try {
            await adapter.connect();
            this.logger.info(`Printer ${id} reconnected successfully`);
          } catch (err) {
            this.logger.warn(`Printer ${id} reconnect failed: ${(err as Error).message}`);
          }
        }
      }
    }, this.healthCheckInterval);
  }

  /**
   * Stop periodic health check
   */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Update printer configuration
   */
  updatePrinterConfig(printerId: string, updates: Partial<PrinterConfig>): void {
    const config = this.configs.get(printerId);
    if (!config) {
      throw new PrintServiceError(
        `Printer not found: ${printerId}`,
        ErrorCodes.PRINTER_NOT_FOUND,
        404
      );
    }

    // Update config
    Object.assign(config, updates);
    this.configs.set(printerId, config);

    this.logger.info(`Updated printer config: ${printerId}`);
  }

  /**
   * Enable a printer
   */
  async enablePrinter(printerId: string): Promise<void> {
    this.updatePrinterConfig(printerId, { enabled: true });
    await this.connectPrinter(printerId);
  }

  /**
   * Disable a printer
   */
  async disablePrinter(printerId: string): Promise<void> {
    await this.disconnectPrinter(printerId);
    this.updatePrinterConfig(printerId, { enabled: false });
  }

  /**
   * Get summary of printer states
   */
  get isInitializing(): boolean {
    return this._initializing;
  }

  getSummary(): {
    total: number;
    online: number;
    offline: number;
    error: number;
    initializing: boolean;
  } {
    let online = 0;
    let offline = 0;
    let error = 0;

    for (const adapter of this.printers.values()) {
      switch (adapter.state.status) {
        case PrinterStatus.ONLINE:
          online++;
          break;
        case PrinterStatus.OFFLINE:
        case PrinterStatus.UNKNOWN:
          offline++;
          break;
        default:
          error++;
      }
    }

    return {
      total: this.printers.size,
      online,
      offline,
      error,
      initializing: this._initializing
    };
  }

  /**
   * Reconnect to a specific printer
   */
  async reconnect(printerId: string): Promise<void> {
    const adapter = this.printers.get(printerId);
    if (!adapter) {
      throw new PrintServiceError(
        `Printer not found: ${printerId}`,
        ErrorCodes.PRINTER_NOT_FOUND,
        404
      );
    }

    const config = this.configs.get(printerId)!;
    if (!config.enabled) {
      throw new PrintServiceError(
        `Printer is disabled: ${printerId}`,
        ErrorCodes.PRINTER_OFFLINE,
        400
      );
    }

    this.logger.info(`Reconnecting printer: ${printerId}`);
    
    // Disconnect first if connected
    if (adapter.isConnected()) {
      await adapter.disconnect();
    }
    
    // Wait a bit before reconnecting
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Connect again
    await adapter.connect();
    this.logger.info(`Printer ${printerId} reconnected`);
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down printer manager...');
    await this.disconnectAll();
    this.removeAllListeners();
    this.logger.info('Printer manager shutdown complete');
  }
}

export default PrinterManager;
