/**
 * Base Printer Adapter Interface
 * Defines the contract for all printer implementations
 */

import { EventEmitter } from 'events';
import {
  PrinterConfig,
  PrinterState,
  PrinterStatus,
  PrinterCapabilities,
  PrinterError
} from '../types';

export interface PrintResult {
  success: boolean;
  bytesWritten: number;
  error?: string;
  duration?: number;
}

export interface PrinterAdapter extends EventEmitter {
  readonly id: string;
  readonly config: PrinterConfig;
  readonly state: PrinterState;
  
  /**
   * Connect to the printer
   */
  connect(): Promise<void>;
  
  /**
   * Disconnect from the printer
   */
  disconnect(): Promise<void>;
  
  /**
   * Check if printer is connected
   */
  isConnected(): boolean;
  
  /**
   * Write data to the printer
   */
  write(data: Buffer): Promise<PrintResult>;
  
  /**
   * Get current printer status
   */
  getStatus(): Promise<PrinterStatus>;
  
  /**
   * Check printer health
   */
  healthCheck(): Promise<boolean>;
  
  /**
   * Get printer capabilities
   */
  getCapabilities(): PrinterCapabilities;
}

/**
 * Base class for printer adapters with common functionality
 */
export abstract class BasePrinterAdapter extends EventEmitter implements PrinterAdapter {
  readonly id: string;
  readonly config: PrinterConfig;
  protected _state: PrinterState;
  protected connectionTimeout: number;
  protected writeTimeout: number;
  protected reconnectAttempts: number = 0;
  protected maxReconnectAttempts: number = 5;
  protected reconnectDelay: number = 1000;
  protected reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: PrinterConfig) {
    super();
    this.id = config.id;
    this.config = config;
    this.connectionTimeout = config.timeout || 5000;
    this.writeTimeout = config.timeout || 10000;
    
    this._state = {
      id: config.id,
      status: PrinterStatus.UNKNOWN,
      lastSeen: 0,
      consecutiveFailures: 0,
      totalJobsPrinted: 0,
      isConnected: false
    };
  }

  get state(): PrinterState {
    return { ...this._state };
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract write(data: Buffer): Promise<PrintResult>;
  abstract getStatus(): Promise<PrinterStatus>;

  isConnected(): boolean {
    return this._state.isConnected;
  }

  async healthCheck(): Promise<boolean> {
    try {
      if (!this.isConnected()) {
        return false;
      }
      const status = await this.getStatus();
      return status === PrinterStatus.ONLINE;
    } catch {
      return false;
    }
  }

  getCapabilities(): PrinterCapabilities {
    return this.config.capabilities;
  }

  protected updateState(updates: Partial<PrinterState>): void {
    this._state = { ...this._state, ...updates };
    this.emit('stateChange', this._state);
  }

  protected handleConnectionError(error: Error): void {
    this._state.consecutiveFailures++;
    this._state.lastError = error.message;
    this._state.status = PrinterStatus.ERROR;
    this._state.isConnected = false;
    this.emit('error', error);
    this.emit('disconnected', this.id);
  }

  protected handleConnectionSuccess(): void {
    this._state.consecutiveFailures = 0;
    this._state.status = PrinterStatus.ONLINE;
    this._state.isConnected = true;
    this._state.lastSeen = Date.now();
    this._state.lastError = undefined;
    this.reconnectAttempts = 0;
    this.emit('connected', this.id);
  }

  protected async scheduleReconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this._state.status = PrinterStatus.OFFLINE;
      this.emit('reconnectFailed', this.id);
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  protected createError(message: string, code: string): PrinterError {
    return new PrinterError(message, this.id, code);
  }
}

export default BasePrinterAdapter;
