/**
 * Printer Manager
 * Manages multiple printers and provides unified access
 */

import { EventEmitter } from 'events';
import { PrinterAdapter, PrintResult } from './base-adapter';
import { USBPrinterAdapter, PrinterRebindEvent, HealResult } from './usb-adapter';
import { NetworkPrinterAdapter } from './network-adapter';
import { initWindowsPrintSystem, WindowsPrintSystem } from './windows-printers';
import { DeviceWatcher } from './device-watcher';
import { PrinterIdentityHints } from './printer-resolver';
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
  /**
   * Persist a config change discovered at runtime — a rebind to a renamed
   * queue, or freshly learned identity breadcrumbs. Without this the service
   * re-learns the same thing after every restart.
   */
  persistPrinterUpdate?: (printerId: string, updates: Partial<PrinterConfig>) => void;
  /** Attempt automated repairs when a printer goes offline. Default: true. */
  autoHeal?: boolean;
}

export class PrinterManager extends EventEmitter {
  private printers: Map<string, PrinterAdapter> = new Map();
  private configs: Map<string, PrinterConfig> = new Map();
  private defaultPrinterId: string | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private readonly logger: Logger;
  private readonly healthCheckInterval: number;
  private readonly persistPrinterUpdate?: (
    printerId: string,
    updates: Partial<PrinterConfig>
  ) => void;
  private readonly autoHeal: boolean;
  private readonly printSystem: WindowsPrintSystem;
  private readonly watcher: DeviceWatcher;
  private _initializing = false;
  /** Health-check cadence in use; tightened when the watcher is unavailable. */
  private activeHealthInterval: number;
  private reconciling = false;
  private reconcileQueued = false;

  constructor(config: PrinterManagerConfig, logger: Logger) {
    super();
    this.logger = logger;
    this.healthCheckInterval = config.healthCheckInterval || 30000;
    this.persistPrinterUpdate = config.persistPrinterUpdate;
    this.autoHeal = config.autoHeal !== false;

    // One shared view of the Windows print system for every adapter, so a
    // health check across all printers costs a single PowerShell process.
    this.printSystem = initWindowsPrintSystem(logger);
    this.activeHealthInterval = this.healthCheckInterval;

    // Windows tells us when devices and queues change, so a printer that is
    // unplugged, replugged, or moved to another socket is picked up in about a
    // second instead of on the next poll.
    this.watcher = new DeviceWatcher(logger);
    this.watcher.on('change', ({ source }) => {
      this.logger.debug({ source }, 'Printer or device change detected');
      void this.reconcile('device change');
    });
    this.watcher.on('unavailable', () => {
      // No event feed: poll harder so responsiveness degrades gracefully
      // instead of dropping to the slow safety interval.
      this.setHealthInterval(Math.min(this.healthCheckInterval, 8000));
    });

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

    this.watcher.start();
  }

  /**
   * React to a device or queue change: re-read Windows, then bring every
   * enabled printer to the best state it can reach.
   *
   * Serialised, because a single plug-in can produce several triggers and
   * running two reconciliations concurrently would fight over the same repairs.
   */
  private async reconcile(trigger: string): Promise<void> {
    if (this.reconciling) {
      this.reconcileQueued = true;
      return;
    }
    this.reconciling = true;

    try {
      // The world just changed, so the cached snapshot is worthless.
      this.printSystem.invalidate();

      for (const [id, adapter] of this.printers) {
        const config = this.configs.get(id);
        if (!config?.enabled) continue;

        const before = adapter.state.status;

        try {
          const status = await adapter.getStatus();

          if (status === PrinterStatus.ONLINE && !adapter.isConnected()) {
            await adapter.connect().catch(() => undefined);
          } else if (
            this.autoHeal &&
            adapter.state.healable &&
            adapter instanceof USBPrinterAdapter &&
            (status === PrinterStatus.OFFLINE || status === PrinterStatus.ERROR)
          ) {
            await adapter.heal();
            if (adapter.state.status === PrinterStatus.ONLINE && !adapter.isConnected()) {
              await adapter.connect().catch(() => undefined);
            }
          }
        } catch (error) {
          this.logger.debug(
            { printerId: id, error: (error as Error).message },
            'Reconcile step failed'
          );
        }

        const after = adapter.state.status;
        if (after !== before) {
          this.logger.info(
            { printerId: id, from: before, to: after, trigger },
            `Printer ${id} changed from ${before} to ${after}`
          );
          this.emit('printerStatusChange', { id, status: after, reason: adapter.state.reason });
        }
      }
    } finally {
      this.reconciling = false;

      if (this.reconcileQueued) {
        this.reconcileQueued = false;
        void this.reconcile('coalesced change');
      }
    }
  }

  /** Change the health-check cadence, restarting the timer if it is running. */
  private setHealthInterval(ms: number): void {
    if (this.activeHealthInterval === ms) return;
    this.activeHealthInterval = ms;

    if (this.healthCheckTimer) {
      this.stopHealthCheck();
      this.startHealthCheck();
    }
  }

  /** Force an immediate reconcile (used after config changes). */
  async refreshAll(reason = 'manual refresh'): Promise<void> {
    await this.reconcile(reason);
  }

  /** Whether change events are being delivered, for diagnostics. */
  isWatcherRunning(): boolean {
    return this.watcher.isRunning;
  }

  /** The shared Windows print system view (discovery, diagnostics, repairs). */
  getPrintSystem(): WindowsPrintSystem {
    return this.printSystem;
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

    // The adapter found its queue under a different name (renamed printer, or
    // a driver re-install that created "XP-80C (Copy 1)"). Persist the new name
    // so the rebind survives a service restart.
    adapter.on('rebound', (event: PrinterRebindEvent) => {
      this.logger.warn(
        { printerId: event.printerId, from: event.from, to: event.to },
        `Printer "${event.printerId}" rebound to Windows queue "${event.to}": ${event.reason}`
      );

      const cfg = this.configs.get(event.printerId);
      if (cfg) {
        cfg.printerName = event.to;
      }
      this.savePrinterUpdate(event.printerId, { printerName: event.to });
      this.refreshSiblingNames();
      this.emit('printerRebound', event);
    });

    // Identity breadcrumbs (port, driver, USB hardware id) that let us re-find
    // this printer after it moves or is reinstalled.
    adapter.on(
      'identityLearned',
      ({ printerId, hints }: { printerId: string; hints: PrinterIdentityHints }) => {
        const cfg = this.configs.get(printerId);
        if (!cfg) return;

        const metadata = { ...(cfg.metadata ?? {}), ...hints };
        cfg.metadata = metadata;
        this.savePrinterUpdate(printerId, { metadata });
      }
    );

    this.printers.set(config.id, adapter);
    this.refreshSiblingNames();

    // Set as default if specified or if it's the first printer
    if (config.isDefault || this.defaultPrinterId === null) {
      this.defaultPrinterId = config.id;
    }

    this.logger.info(`Registered printer: ${config.id} (${config.type})`);
  }

  /**
   * Write a runtime-discovered config change back to config.json, without
   * letting a persistence failure take the printer down.
   */
  private savePrinterUpdate(printerId: string, updates: Partial<PrinterConfig>): void {
    if (!this.persistPrinterUpdate) return;
    try {
      this.persistPrinterUpdate(printerId, updates);
    } catch (error) {
      this.logger.warn(
        { printerId, error: (error as Error).message },
        'Could not persist printer configuration change'
      );
    }
  }

  /**
   * Tell each USB adapter which Windows queues its siblings own, so an
   * automatic rebind can never steal the kitchen printer's queue.
   */
  private refreshSiblingNames(): void {
    const usbAdapters = Array.from(this.printers.values()).filter(
      (a): a is USBPrinterAdapter => a instanceof USBPrinterAdapter
    );

    for (const adapter of usbAdapters) {
      const others = usbAdapters
        .filter((other) => other.id !== adapter.id)
        .map((other) => other.targetPrinterName)
        .filter(Boolean);
      adapter.setSiblingQueueNames(others);
    }
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

    this.refreshSiblingNames();
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
      // Try to reconnect. connect() repairs what it can (stale offline flag,
      // migrated USB port, renamed queue) before giving up.
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

      // connect() resolves without throwing for conditions the user must fix
      // (no paper, cover open, cable unplugged). Refuse the write so the job
      // stays in our queue and retries, rather than spooling into Windows
      // where it would surface hours later.
      if (!adapter.isConnected()) {
        throw new PrintServiceError(
          adapter.state.reason || `Printer ${printerId} is not ready`,
          ErrorCodes.PRINTER_OFFLINE,
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
      // All adapters share one cached snapshot, so this is a single query to
      // Windows regardless of how many printers are configured.
      const previous = new Map(
        Array.from(this.printers.entries()).map(([id, a]) => [id, a.state.status])
      );
      const statuses = await this.healthCheckAll();

      for (const [id, status] of statuses) {
        const adapter = this.printers.get(id);
        if (!adapter) continue;

        if (status !== previous.get(id)) {
          this.emit('printerStatusChange', { id, status, reason: adapter.state.reason });
        }

        const config = this.configs.get(id);
        if (!config?.enabled) continue;
        if (status !== PrinterStatus.OFFLINE && status !== PrinterStatus.ERROR) continue;

        // Try an automated repair first — a migrated USB port or a stale
        // offline flag is fixed here without anyone noticing.
        if (this.autoHeal && adapter.state.healable && adapter instanceof USBPrinterAdapter) {
          try {
            const result = await adapter.heal();
            if (result.attempted.length > 0) {
              this.logger.info(
                {
                  printerId: id,
                  attempted: result.attempted.map((a) => a.kind),
                  succeeded: result.succeeded.map((a) => a.kind),
                  statusAfter: result.statusAfter
                },
                `Auto-repair ran for printer ${id}: ${result.reason}`
              );
            }
            if (result.statusAfter === PrinterStatus.ONLINE) {
              this.emit('printerHealed', { printerId: id, result });
              continue;
            }
          } catch (err) {
            this.logger.warn(`Printer ${id} auto-repair failed: ${(err as Error).message}`);
          }
        }

        this.logger.info(`Printer ${id} is ${status}, attempting auto-reconnect...`);
        try {
          await adapter.connect();
          if (adapter.isConnected()) {
            this.logger.info(`Printer ${id} reconnected successfully`);
          }
        } catch (err) {
          this.logger.warn(`Printer ${id} reconnect failed: ${(err as Error).message}`);
        }
      }
    }, this.activeHealthInterval);
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
   * Run the repair plan for a printer on demand (dashboard "Repair" action).
   */
  async healPrinter(printerId: string): Promise<HealResult> {
    const adapter = this.printers.get(printerId);
    if (!adapter) {
      throw new PrintServiceError(
        `Printer not found: ${printerId}`,
        ErrorCodes.PRINTER_NOT_FOUND,
        404
      );
    }

    if (!(adapter instanceof USBPrinterAdapter)) {
      throw new PrintServiceError(
        'Automated repair is only available for local (USB) printers',
        ErrorCodes.INVALID_REQUEST,
        400
      );
    }

    const result = await adapter.heal(true);

    // A repair often makes the printer usable again; reflect that immediately
    // instead of waiting for the next health check.
    if (result.statusAfter === PrinterStatus.ONLINE && !adapter.isConnected()) {
      await adapter.connect().catch(() => undefined);
    }

    return result;
  }

  /**
   * Full diagnostic report for a printer: what Windows reports, what the
   * service concluded, and which repairs are available.
   */
  async diagnosePrinter(printerId: string): Promise<ReturnType<USBPrinterAdapter['diagnose']>> {
    const adapter = this.printers.get(printerId);
    if (!adapter) {
      throw new PrintServiceError(
        `Printer not found: ${printerId}`,
        ErrorCodes.PRINTER_NOT_FOUND,
        404
      );
    }

    if (!(adapter instanceof USBPrinterAdapter)) {
      throw new PrintServiceError(
        'Diagnostics are only available for local (USB) printers',
        ErrorCodes.INVALID_REQUEST,
        400
      );
    }

    return adapter.diagnose();
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
    this.watcher.stop();
    await this.disconnectAll();
    this.removeAllListeners();
    this.logger.info('Printer manager shutdown complete');
  }
}

export default PrinterManager;
