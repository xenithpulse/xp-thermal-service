/**
 * Network Printer Adapter
 * Handles communication with network/LAN thermal printers
 */

import * as net from 'net';
import { BasePrinterAdapter, PrintResult } from './base-adapter';
import {
  PrinterConfig,
  PrinterStatus,
  ErrorCodes
} from '../types';

interface WriteQueueItem {
  data: Buffer;
  resolve: (result: PrintResult) => void;
  reject: (error: Error) => void;
}

export class NetworkPrinterAdapter extends BasePrinterAdapter {
  private socket: net.Socket | null = null;
  private readonly host: string;
  private readonly port: number;
  private writeQueue: WriteQueueItem[] = [];
  private isWriting = false;
  private reconnecting = false;
  private connectionPromise: Promise<void> | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(config: PrinterConfig) {
    super(config);
    
    if (!config.host || !config.port) {
      throw new Error('Network printer requires host and port');
    }

    // Validate port range — block well-known non-printer ports to prevent SSRF
    if (config.port < 1024 || config.port > 65535) {
      throw new Error(`Invalid printer port: ${config.port}. Must be 1024-65535.`);
    }
    
    this.host = config.host;
    this.port = config.port;
  }

  async connect(): Promise<void> {
    // If already connecting, wait for that to complete
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    // If already connected, return immediately
    if (this.socket && !this.socket.destroyed) {
      return;
    }

    this.connectionPromise = this.doConnect();
    
    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      
      // Set socket options
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 10000);

      // Connection timeout
      const timeoutId = setTimeout(() => {
        socket.destroy();
        reject(this.createError(
          `Connection timeout to ${this.host}:${this.port}`,
          ErrorCodes.PRINTER_TIMEOUT
        ));
      }, this.connectionTimeout);

      socket.once('connect', () => {
        clearTimeout(timeoutId);
        this.socket = socket;
        this.setupSocketListeners();
        this.handleConnectionSuccess();
        this.startHealthCheck();
        resolve();
      });

      socket.once('error', (error) => {
        clearTimeout(timeoutId);
        this.handleConnectionError(error);
        reject(error);
      });

      socket.connect(this.port, this.host);
    });
  }

  private setupSocketListeners(): void {
    if (!this.socket) return;

    this.socket.on('error', (error) => {
      this._state.lastError = error.message;
      this._state.consecutiveFailures++;
      this.emit('error', error);
      
      if (!this.reconnecting) {
        this.handleDisconnect();
      }
    });

    this.socket.on('close', () => {
      if (!this.reconnecting) {
        this.handleDisconnect();
      }
    });

    this.socket.on('timeout', () => {
      this._state.lastError = 'Socket timeout';
      this.emit('error', new Error('Socket timeout'));
    });

    // Set socket timeout for idle connections
    this.socket.setTimeout(60000); // 60 seconds idle timeout
  }

  async disconnect(): Promise<void> {
    this.stopHealthCheck();
    this.reconnecting = false; // Prevent reconnection
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (!this.socket) {
      return;
    }

    return new Promise((resolve) => {
      if (!this.socket) {
        resolve();
        return;
      }

      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        this.socket = null;
        this.updateState({
          isConnected: false,
          status: PrinterStatus.OFFLINE
        });
        resolve();
      };

      this.socket.once('close', done);
      this.socket.end();
      
      // Force close after timeout
      setTimeout(() => {
        if (this.socket) {
          this.socket.destroy();
        }
        done();
      }, 2000);
    });
  }

  async write(data: Buffer): Promise<PrintResult> {
    return new Promise((resolve, reject) => {
      this.writeQueue.push({ data, resolve, reject });
      this.processWriteQueue();
    });
  }

  private async processWriteQueue(): Promise<void> {
    if (this.isWriting || this.writeQueue.length === 0) {
      return;
    }

    this.isWriting = true;
    const item = this.writeQueue.shift()!;
    const startTime = Date.now();

    try {
      // Ensure we're connected
      if (!this.socket || this.socket.destroyed) {
        await this.connect();
      }

      const bytesWritten = await this.writeToSocket(item.data);
      const duration = Date.now() - startTime;

      this._state.totalJobsPrinted++;
      this._state.lastSeen = Date.now();
      this._state.consecutiveFailures = 0;

      item.resolve({
        success: true,
        bytesWritten,
        duration
      });
    } catch (error) {
      this._state.consecutiveFailures++;
      this._state.lastError = (error as Error).message;
      item.reject(error as Error);
    } finally {
      this.isWriting = false;
      
      // Process next item in queue
      if (this.writeQueue.length > 0) {
        setImmediate(() => this.processWriteQueue());
      }
    }
  }

  private writeToSocket(data: Buffer): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(this.createError('Socket not connected', ErrorCodes.PRINTER_OFFLINE));
        return;
      }

      const timeout = this.writeTimeout;
      let timeoutId: NodeJS.Timeout;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
      };

      timeoutId = setTimeout(() => {
        cleanup();
        // Destroy the socket to prevent inconsistent state after timeout
        if (this.socket && !this.socket.destroyed) {
          this.socket.destroy();
        }
        reject(this.createError('Write timeout', ErrorCodes.PRINTER_TIMEOUT));
      }, timeout);

      const success = this.socket.write(data, (error) => {
        cleanup();
        
        if (error) {
          reject(this.createError(
            `Write error: ${error.message}`,
            ErrorCodes.PRINTER_ERROR
          ));
          return;
        }

        resolve(data.length);
      });

      // Handle backpressure
      if (!success) {
        this.socket.once('drain', () => {
          // Data has been flushed
        });
      }
    });
  }

  async getStatus(): Promise<PrinterStatus> {
    if (!this.socket || this.socket.destroyed) {
      return PrinterStatus.OFFLINE;
    }

    try {
      // Send DLE EOT status request (standard ESC/POS)
      const statusCommand = Buffer.from([0x10, 0x04, 0x01]);
      
      // Create a promise that times out quickly for status check
      const response = await Promise.race([
        this.sendStatusRequest(statusCommand),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000))
      ]);

      if (response === null) {
        // Timeout - assume online if socket is connected
        return PrinterStatus.ONLINE;
      }

      // Parse status response if we got one
      if (response instanceof Buffer && response.length > 0) {
        const status = response[0];
        
        if (status & 0x08) {
          this.updateState({ status: PrinterStatus.PAPER_OUT });
          return PrinterStatus.PAPER_OUT;
        }
        if (status & 0x04) {
          this.updateState({ status: PrinterStatus.COVER_OPEN });
          return PrinterStatus.COVER_OPEN;
        }
        if (status & 0x20) {
          this.updateState({ status: PrinterStatus.ERROR });
          return PrinterStatus.ERROR;
        }
      }

      this.updateState({ status: PrinterStatus.ONLINE, lastSeen: Date.now() });
      return PrinterStatus.ONLINE;
      
    } catch {
      // If we can't get status but socket is connected, assume online
      return this.socket && !this.socket.destroyed 
        ? PrinterStatus.ONLINE 
        : PrinterStatus.OFFLINE;
    }
  }

  private sendStatusRequest(command: Buffer): Promise<Buffer | null> {
    return new Promise((resolve) => {
      if (!this.socket || this.socket.destroyed) {
        resolve(null);
        return;
      }

      const onData = (data: Buffer) => {
        this.socket?.removeListener('data', onData);
        resolve(data);
      };

      this.socket.once('data', onData);
      this.socket.write(command);

      // Timeout for status response
      setTimeout(() => {
        this.socket?.removeListener('data', onData);
        resolve(null);
      }, 1000);
    });
  }

  private handleDisconnect(): void {
    this.socket = null;
    this.updateState({
      isConnected: false,
      status: PrinterStatus.OFFLINE
    });
    this.emit('disconnected', this.id);

    // Don't reconnect if we're intentionally disconnecting
    if (!this.reconnecting && this.config.enabled) {
      this.reconnecting = true;
      this.scheduleReconnect();
    }
  }

  protected override async scheduleReconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this._state.status = PrinterStatus.OFFLINE;
      this.reconnecting = false;
      this.emit('reconnectFailed', this.id);
      return;
    }

    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
      30000 // Max 30 second delay
    );
    this.reconnectAttempts++;

    this.emit('reconnecting', { id: this.id, attempt: this.reconnectAttempts, delay });

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        this.reconnecting = false;
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private startHealthCheck(): void {
    if (this.healthCheckInterval) {
      return;
    }

    // Check connection health every 30 seconds
    this.healthCheckInterval = setInterval(async () => {
      if (!this.socket || this.socket.destroyed) {
        this.handleDisconnect();
        return;
      }

      try {
        // Try a quick status check
        await this.getStatus();
        this._state.lastSeen = Date.now();
      } catch {
        // Status check failed - might be a problem
        this._state.consecutiveFailures++;
        if (this._state.consecutiveFailures > 3) {
          this.handleDisconnect();
        }
      }
    }, 30000);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Ping the printer to check if it's reachable
   */
  async ping(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 3000);

      socket.once('connect', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });

      socket.once('error', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(false);
      });

      socket.connect(this.port, this.host);
    });
  }

  /**
   * Static method to discover network printers using common ports
   */
  static async discoverPrinters(
    subnet: string,
    ports: number[] = [9100, 9101, 9102],
    timeout = 1000
  ): Promise<Array<{ host: string; port: number }>> {
    const printers: Array<{ host: string; port: number }> = [];
    
    // Parse subnet (e.g., "192.168.1")
    const baseIp = subnet.split('.').slice(0, 3).join('.');
    
    const scanPromises: Promise<void>[] = [];
    
    for (let i = 1; i <= 254; i++) {
      const host = `${baseIp}.${i}`;
      
      for (const port of ports) {
        scanPromises.push(
          new Promise((resolve) => {
            const socket = new net.Socket();
            
            const timeoutId = setTimeout(() => {
              socket.destroy();
              resolve(void 0);
            }, timeout);

            socket.once('connect', () => {
              clearTimeout(timeoutId);
              printers.push({ host, port });
              socket.destroy();
              resolve(void 0);
            });

            socket.once('error', () => {
              clearTimeout(timeoutId);
              socket.destroy();
              resolve(void 0);
            });

            socket.connect(port, host);
          })
        );
      }
    }

    // Scan in batches to avoid too many concurrent connections
    const batchSize = 50;
    for (let i = 0; i < scanPromises.length; i += batchSize) {
      await Promise.all(scanPromises.slice(i, i + batchSize));
    }

    return printers;
  }
}

export default NetworkPrinterAdapter;
