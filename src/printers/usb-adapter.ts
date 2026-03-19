/**
 * USB Printer Adapter
 * Handles communication with USB thermal printers on Windows
 * Uses Windows shared printer names (no native USB dependency)
 */

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BasePrinterAdapter, PrintResult } from './base-adapter';
import {
  PrinterConfig,
  PrinterStatus
} from '../types';

// Max items in write queue to prevent unbounded memory growth
const MAX_WRITE_QUEUE_SIZE = 100;

// Validate printer name: allow alphanumeric, spaces, parens, hyphens, dots, slashes, hash, underscores
const SAFE_PRINTER_NAME = /^[a-zA-Z0-9 ()\-._\\/:#]+$/;

export class USBPrinterAdapter extends BasePrinterAdapter {
  private readonly printerName: string;
  private readonly tempDir: string;
  private writeQueue: Array<{
    data: Buffer;
    resolve: (result: PrintResult) => void;
    reject: (error: Error) => void;
  }> = [];
  private isWriting = false;

  constructor(config: PrinterConfig) {
    super(config);

    if (!config.printerName) {
      throw new Error('USB printer requires printerName (Windows shared printer name)');
    }

    // Validate printer name to prevent command injection
    if (!SAFE_PRINTER_NAME.test(config.printerName)) {
      throw new Error('Invalid printer name: contains disallowed characters');
    }

    this.printerName = config.printerName;
    this.tempDir = path.join(os.tmpdir(), 'xp-thermal');

    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async connect(): Promise<void> {
    try {
      // Verify printer exists
      const exists = await this.printerExists();
      if (!exists) {
        throw new Error(`Printer not found: ${this.printerName}`);
      }

      this.handleConnectionSuccess();
    } catch (error) {
      this.handleConnectionError(error as Error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    // Clear any pending writes
    this.writeQueue = [];
    this.isWriting = false;

    this.updateState({
      status: PrinterStatus.OFFLINE,
      isConnected: false
    });

    this.emit('disconnected', this.id);
  }

  async write(data: Buffer): Promise<PrintResult> {
    if (this.writeQueue.length >= MAX_WRITE_QUEUE_SIZE) {
      return { success: false, bytesWritten: 0, error: 'Write queue full — printer may be offline' };
    }
    return new Promise((resolve, reject) => {
      this.writeQueue.push({ data, resolve, reject });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isWriting || this.writeQueue.length === 0) {
      return;
    }

    this.isWriting = true;
    const item = this.writeQueue.shift()!;

    try {
      const result = await this.sendToPrinter(item.data);
      item.resolve(result);
    } catch (error) {
      item.reject(error as Error);
    } finally {
      this.isWriting = false;
      // Process next item
      if (this.writeQueue.length > 0) {
        setImmediate(() => this.processQueue());
      }
    }
  }

  private async sendToPrinter(data: Buffer): Promise<PrintResult> {
    const startTime = Date.now();

    // Write data to temp file
    const tempFile = path.join(this.tempDir, `print_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.bin`);

    try {
      fs.writeFileSync(tempFile, data);

      // Use PowerShell to send raw data to printer
      await this.sendRawToPrinter(tempFile);

      const duration = Date.now() - startTime;

      this.updateState({
        totalJobsPrinted: this.state.totalJobsPrinted + 1,
        lastSeen: Date.now(),
        consecutiveFailures: 0
      });

      return {
        success: true,
        bytesWritten: data.length,
        duration
      };
    } catch (error) {
      this.updateState({
        consecutiveFailures: this.state.consecutiveFailures + 1,
        lastError: (error as Error).message
      });

      // Check if printer went offline
      if (this.state.consecutiveFailures >= 3) {
        this.updateState({ status: PrinterStatus.ERROR });
      }

      return {
        success: false,
        bytesWritten: 0,
        error: (error as Error).message
      };
    } finally {
      // Clean up temp file
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  private sendRawToPrinter(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Pass printer name and file path via environment variables to avoid injection
      const ps = spawn('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        `
        $ErrorActionPreference = 'Stop'
        $printerName = $env:XP_PRINTER_NAME
        $filePath = $env:XP_PRINT_FILE
        
        $content = [System.IO.File]::ReadAllBytes($filePath)
        
        # Use RawPrinterHelper for raw ESC/POS data
        $rawPrinter = @"
using System;
using System.Runtime.InteropServices;

public class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential)]
    public struct DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDatatype;
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi)]
    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFOA di);

    [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);

    public static bool SendBytesToPrinter(string printerName, byte[] bytes)
    {
        IntPtr hPrinter;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "XP Thermal Document";
        di.pDatatype = "RAW";

        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            return false;

        try
        {
            if (!StartDocPrinter(hPrinter, 1, ref di))
                return false;

            if (!StartPagePrinter(hPrinter))
                return false;

            int written;
            bool success = WritePrinter(hPrinter, bytes, bytes.Length, out written);

            EndPagePrinter(hPrinter);
            EndDocPrinter(hPrinter);
            
            return success && written == bytes.Length;
        }
        finally
        {
            ClosePrinter(hPrinter);
        }
    }
}
"@
        
        Add-Type -TypeDefinition $rawPrinter -Language CSharp -ErrorAction Stop
        
        $success = [RawPrinterHelper]::SendBytesToPrinter($printerName, $content)
        if (-not $success) {
          throw "Failed to send data to printer"
        }
        `
      ], {
        env: {
          ...process.env,
          XP_PRINTER_NAME: this.printerName,
          XP_PRINT_FILE: filePath
        }
      });

      let stderr = '';
      let stdout = '';
      let timeout: NodeJS.Timeout;

      ps.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      ps.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ps.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr || stdout || `PowerShell exited with code ${code}`));
        }
      });

      ps.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      // Timeout after 30 seconds
      timeout = setTimeout(() => {
        ps.kill();
        reject(new Error('Print operation timed out'));
      }, 30000);
    });
  }

  private async printerExists(): Promise<boolean> {
    return new Promise((resolve) => {
      // Use WMI-based query for Windows 7+ compatibility (Get-Printer requires Win8+)
      const ps = spawn('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        `
        $name = $env:XP_PRINTER_NAME
        # Try Get-Printer first (Win8+), fall back to WMI (Win7)
        try {
          $p = Get-Printer -Name $name -ErrorAction Stop
          Write-Output 'FOUND'
        } catch {
          try {
            $p = Get-WmiObject -Class Win32_Printer | Where-Object { $_.Name -eq $name }
            if ($p) { Write-Output 'FOUND' } else { Write-Output 'NOT_FOUND' }
          } catch {
            Write-Output 'NOT_FOUND'
          }
        }
        `
      ], {
        env: { ...process.env, XP_PRINTER_NAME: this.printerName }
      });

      let output = '';

      ps.stdout.on('data', (data) => {
        output += data.toString();
      });

      ps.on('close', () => {
        resolve(output.trim().includes('FOUND'));
      });

      ps.on('error', () => {
        resolve(false);
      });
    });
  }

  async getStatus(): Promise<PrinterStatus> {
    try {
      const exists = await this.printerExists();
      if (!exists) {
        return PrinterStatus.OFFLINE;
      }

      // Check printer status via PowerShell
      return await this.getPrinterStatus();
    } catch {
      return PrinterStatus.ERROR;
    }
  }

  private getPrinterStatus(): Promise<PrinterStatus> {
    return new Promise((resolve) => {
      const ps = spawn('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        `
        $name = $env:XP_PRINTER_NAME
        try {
          $printer = Get-Printer -Name $name -ErrorAction Stop
          Write-Output $printer.PrinterStatus
        } catch {
          try {
            $p = Get-WmiObject -Class Win32_Printer | Where-Object { $_.Name -eq $name }
            if ($p) { Write-Output $p.PrinterStatus } else { Write-Output 'NotFound' }
          } catch {
            Write-Output 'Error'
          }
        }
        `
      ], {
        env: { ...process.env, XP_PRINTER_NAME: this.printerName }
      });

      let output = '';

      ps.stdout.on('data', (data) => {
        output += data.toString();
      });

      ps.on('close', () => {
        const status = output.trim().toLowerCase();

        if (status === 'notfound') {
          resolve(PrinterStatus.OFFLINE);
        } else if (status === 'normal' || status === '0') {
          resolve(PrinterStatus.ONLINE);
        } else if (status.includes('error') || status.includes('offline')) {
          resolve(PrinterStatus.ERROR);
        } else if (status.includes('busy') || status.includes('printing')) {
          resolve(PrinterStatus.BUSY);
        } else {
          resolve(PrinterStatus.ONLINE);
        }
      });

      ps.on('error', () => {
        resolve(PrinterStatus.ERROR);
      });
    });
  }

  /**
   * Get list of available Windows printers
   */
  static async listPrinters(): Promise<Array<{ name: string; status: string; port: string }>> {
    return new Promise((resolve) => {
      // Try Get-Printer (Win8+), fall back to WMI (Win7)
      const ps = spawn('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        `
        try {
          Get-Printer | Select-Object Name, PrinterStatus, PortName | ConvertTo-Json
        } catch {
          Get-WmiObject -Class Win32_Printer | Select-Object Name, PrinterStatus, PortName | ConvertTo-Json
        }
        `
      ]);

      let output = '';

      ps.stdout.on('data', (data) => {
        output += data.toString();
      });

      ps.on('close', () => {
        try {
          if (!output.trim()) {
            resolve([]);
            return;
          }
          const printers = JSON.parse(output);
          const list = Array.isArray(printers) ? printers : [printers];
          resolve(list.filter(p => p).map(p => ({
            name: p.Name || '',
            status: String(p.PrinterStatus || ''),
            port: p.PortName || ''
          })));
        } catch {
          resolve([]);
        }
      });

      ps.on('error', () => {
        resolve([]);
      });
    });
  }
}

export default USBPrinterAdapter;
