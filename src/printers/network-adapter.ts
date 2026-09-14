/**
 * Network Printer Adapter
 * Handles communication with network/LAN thermal printers
 */

import * as net from 'net';
import { BasePrinterAdapter, PrintResult } from './base-adapter';
import {
  diagnoseNetworkError,
  validateNetworkTarget,
  RAW_PRINT_PORT
} from './network-diagnosis';
import { readStatus, statusRequest, DLE_EOT } from './escpos-status';
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

    // Say what is wrong and how to fix it. The old message was
    // "Network printer requires host and port", which is true and useless:
    // it does not say where to find the printer's IP, and it reached the
    // operator as a raw exception string.
    const invalid = validateNetworkTarget(config.host, config.port);
    if (invalid) {
      throw new Error(invalid);
    }

    // Validate port range — block well-known non-printer ports to prevent SSRF.
    // validateNetworkTarget has already ruled out non-integers and 0/65535+.
    if (config.port! < 1024) {
      throw new Error(
        `Port ${config.port} is below 1024 and cannot be used. Raw ESC/POS printing ` +
        `is almost always on ${RAW_PRINT_PORT}.`
      );
    }

    this.host = config.host!;
    this.port = config.port!;
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
        // Nothing answered, so the printer is offline. Without this the state
        // stayed at its initial UNKNOWN, which reads as "not checked yet"
        // rather than "checked, and it is not there".
        this.updateState({ status: PrinterStatus.OFFLINE, isConnected: false });
        this.applyDiagnosis({ code: 'ETIMEDOUT' });
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
        // Clear any previous failure sentence, otherwise a printer that has
        // recovered keeps showing the reason it was broken an hour ago.
        this.updateState({
          reason: `Connected to ${this.host}:${this.port}`,
          healable: false
        });
        this.startHealthCheck();
        resolve();
      });

      socket.once('error', (error) => {
        clearTimeout(timeoutId);
        this.handleConnectionError(error);
        // handleConnectionError stores the raw errno in lastError; replace the
        // operator-facing half with a sentence that names the cause and the fix.
        this.applyDiagnosis(error);
        reject(error);
      });

      socket.connect(this.port, this.host);
    });
  }

  /**
   * Translate a socket failure into the state the dashboard reads.
   *
   * `reason` is the sentence shown under the printer name, and it carries the
   * fix as well as the cause: the operator is usually not the person who set
   * the printer up, so a reason without a next step just relocates the problem.
   *
   * `healable` stays false for every network fault. The USB repair path fixes
   * things this service owns — a stale offline flag, a queue bound to the wrong
   * port. Nothing here is ours to repair: a wrong IP needs the right IP typed
   * in, and offering a Repair button that cannot work is worse than none.
   */
  private applyDiagnosis(error: { code?: string; message?: string }): void {
    const d = diagnoseNetworkError(error, this.host, this.port);
    this.updateState({
      reason: `${d.reason} ${d.fix}`,
      healable: false
    });
  }

  private setupSocketListeners(): void {
    if (!this.socket) return;

    this.socket.on('error', (error) => {
      this._state.lastError = error.message;
      this._state.consecutiveFailures++;
      this.applyDiagnosis(error as NodeJS.ErrnoException);
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

  /**
   * Ask the printer how it is, and record the answer.
   *
   * Two bugs lived here. The first was silent: every early return handed a
   * status back to the caller without writing it to state, and the reconcile
   * loop reads `adapter.state`, not this return value — so a network printer
   * sat on whatever state it happened to have, usually the initial UNKNOWN.
   *
   * The second was a misread. It sent `DLE EOT 1` and interpreted bit 3 as
   * paper-out and bit 2 as cover-open; under n=1 those are *offline* and *the
   * cash drawer pin*. See escpos-status.ts for the bit tables.
   *
   * Everything now goes through `settle`, so there is one place where state is
   * written and no path can skip it.
   */
  async getStatus(): Promise<PrinterStatus> {
    const settle = (status: PrinterStatus, reason: string | null): PrinterStatus => {
      this.updateState({
        status,
        isConnected: status !== PrinterStatus.OFFLINE && this.socket !== null && !this.socket.destroyed,
        ...(reason !== null ? { reason } : {}),
        ...(status === PrinterStatus.ONLINE ? { lastSeen: Date.now() } : {})
      });
      return status;
    };

    if (!this.socket || this.socket.destroyed) {
      return settle(
        PrinterStatus.OFFLINE,
        `Not connected to ${this.host}:${this.port}`
      );
    }

    try {
      const printer = await this.queryStatus(DLE_EOT.PRINTER);

      if (printer === null) {
        /*
         * No reply. The socket is open, so bytes are reaching something — but
         * plenty of cheap units simply do not implement real-time status over
         * a raw socket, and calling those faulty would take working printers
         * offline.
         *
         * So: online, and say the claim is weaker than it looks. This is the
         * one place a network printer is less trustworthy than a USB one,
         * which reads the Windows spooler rather than asking the device.
         */
        return settle(
          PrinterStatus.ONLINE,
          `Connected to ${this.host}:${this.port}. The printer does not report ` +
            `its status, so paper and cover faults cannot be detected remotely.`
        );
      }

      // Only ask why when the printer says something is wrong. Two extra round
      // trips on every poll of a healthy printer would be pure waste.
      const verdict = readStatus({ printer });
      if (verdict.status === PrinterStatus.ONLINE || verdict.status === PrinterStatus.UNKNOWN) {
        const paper = await this.queryStatus(DLE_EOT.PAPER);
        const full = readStatus({ printer, paper: paper ?? undefined });
        return settle(full.status, full.reason ?? `Ready at ${this.host}:${this.port}`);
      }

      const [offlineCause, paper] = await Promise.all([
        this.queryStatus(DLE_EOT.OFFLINE_CAUSE),
        this.queryStatus(DLE_EOT.PAPER)
      ]);

      const full = readStatus({
        printer,
        offlineCause: offlineCause ?? undefined,
        paper: paper ?? undefined
      });
      return settle(full.status, full.reason);
    } catch {
      // The socket broke mid-query, which is itself the answer.
      const alive = this.socket !== null && !this.socket.destroyed;
      return alive
        ? settle(PrinterStatus.ONLINE, null)
        : settle(PrinterStatus.OFFLINE, `Lost the connection to ${this.host}:${this.port}`);
    }
  }

  /** One `DLE EOT n` round trip, or null if the printer does not answer. */
  private async queryStatus(n: number): Promise<number | null> {
    const response = await Promise.race([
      this.sendStatusRequest(statusRequest(n)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000))
    ]);

    if (!(response instanceof Buffer) || response.length === 0) return null;
    return response[0];
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
