/**
 * Printer Discovery
 * Discovers USB and network thermal printers
 */

import { USBPrinterAdapter } from './usb-adapter';
import { NetworkPrinterAdapter } from './network-adapter';
import { PrinterType, PrinterConfig, PrinterCapabilities } from '../types';
import { Logger } from '../utils/logger';

export interface DiscoveredPrinter {
  type: PrinterType;
  name: string;
  connection: {
    vendorId?: number;
    productId?: number;
    host?: string;
    port?: number;
  };
  suggestedConfig: Partial<PrinterConfig>;
}

// Default capabilities for common printer models
const PRINTER_CAPABILITIES: Record<string, Partial<PrinterCapabilities>> = {
  'Epson': {
    maxWidth: 48,
    supportsBold: true,
    supportsUnderline: true,
    supportsBarcode: true,
    supportsQRCode: true,
    supportsImage: true,
    supportsCut: true,
    supportsPartialCut: true,
    supportsCashDrawer: true,
  },
  'Star Micronics': {
    maxWidth: 48,
    supportsBold: true,
    supportsUnderline: true,
    supportsBarcode: true,
    supportsQRCode: true,
    supportsImage: true,
    supportsCut: true,
    supportsPartialCut: true,
    supportsCashDrawer: true,
  },
  'Generic': {
    maxWidth: 48,
    supportsBold: true,
    supportsUnderline: true,
    supportsBarcode: true,
    supportsQRCode: false,
    supportsImage: false,
    supportsCut: true,
    supportsPartialCut: false,
    supportsCashDrawer: true,
  }
};

export class PrinterDiscovery {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Discover all available printers (USB and network)
   */
  async discoverAll(options?: {
    scanNetwork?: boolean;
    networkSubnet?: string;
    networkPorts?: number[];
    timeout?: number;
  }): Promise<DiscoveredPrinter[]> {
    const printers: DiscoveredPrinter[] = [];

    // Discover USB/local printers
    const usbPrinters = await this.discoverUSB();
    printers.push(...usbPrinters);

    // Discover network printers if requested
    if (options?.scanNetwork) {
      const networkPrinters = await this.discoverNetwork(
        options.networkSubnet || this.detectSubnet(),
        options.networkPorts || [9100, 9101, 9102],
        options.timeout || 1000
      );
      printers.push(...networkPrinters);
    }

    return printers;
  }

  /**
   * Discover USB/local printers (Windows shared printers)
   */
  async discoverUSB(): Promise<DiscoveredPrinter[]> {
    const printers: DiscoveredPrinter[] = [];

    try {
      const windowsPrinters = await USBPrinterAdapter.listPrinters();

      for (const printer of windowsPrinters) {
        // Try to identify manufacturer from name
        let vendor = 'Generic';
        const nameLower = printer.name.toLowerCase();
        if (nameLower.includes('epson')) vendor = 'Epson';
        else if (nameLower.includes('star')) vendor = 'Star Micronics';
        else if (nameLower.includes('citizen')) vendor = 'Citizen';
        else if (nameLower.includes('bixolon')) vendor = 'Bixolon';
        else if (nameLower.includes('zebra')) vendor = 'Zebra';
        else if (nameLower.includes('xprinter') || nameLower.includes('xp-')) vendor = 'XPrinter';

        const capabilities = PRINTER_CAPABILITIES[vendor] || PRINTER_CAPABILITIES['Generic'];

        printers.push({
          type: PrinterType.USB,
          name: printer.name,
          connection: {},
          suggestedConfig: {
            id: `usb_${printer.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`,
            name: printer.name,
            type: PrinterType.USB,
            printerName: printer.name,
            timeout: 10000,
            maxRetries: 3,
            capabilities: {
              ...capabilities,
              codepage: 0,
              supportsDensity: true
            } as PrinterCapabilities
          }
        });
      }

      this.logger.info(`Discovered ${printers.length} local printer(s)`);
    } catch (error) {
      this.logger.warn({ error }, 'Error discovering local printers');
    }

    return printers;
  }

  /**
   * Discover network printers
   */
  async discoverNetwork(
    subnet: string,
    ports: number[] = [9100],
    timeout = 1000
  ): Promise<DiscoveredPrinter[]> {
    const printers: DiscoveredPrinter[] = [];

    try {
      this.logger.info(`Scanning network ${subnet}.* for printers...`);
      
      const networkPrinters = await NetworkPrinterAdapter.discoverPrinters(
        subnet,
        ports,
        timeout
      );

      for (const printer of networkPrinters) {
        printers.push({
          type: PrinterType.NETWORK,
          name: `Network Printer at ${printer.host}:${printer.port}`,
          connection: {
            host: printer.host,
            port: printer.port
          },
          suggestedConfig: {
            id: `net_${printer.host.replace(/\./g, '_')}_${printer.port}`,
            name: `Network Printer (${printer.host})`,
            type: PrinterType.NETWORK,
            host: printer.host,
            port: printer.port,
            timeout: 10000,
            maxRetries: 3,
            capabilities: {
              ...PRINTER_CAPABILITIES['Generic'],
              codepage: 0,
              supportsDensity: true
            } as PrinterCapabilities
          }
        });
      }

      this.logger.info(`Discovered ${printers.length} network printer(s)`);
    } catch (error) {
      this.logger.warn({ error }, 'Error discovering network printers');
    }

    return printers;
  }

  /**
   * Test printer connectivity
   */
  async testPrinter(config: PrinterConfig): Promise<{
    success: boolean;
    latency?: number;
    error?: string;
  }> {
    const startTime = Date.now();

    try {
      if (config.type === PrinterType.USB) {
        const adapter = new USBPrinterAdapter(config);
        await adapter.connect();
        const latency = Date.now() - startTime;
        await adapter.disconnect();
        return { success: true, latency };
      } else if (config.type === PrinterType.NETWORK) {
        const adapter = new NetworkPrinterAdapter(config);
        const reachable = await adapter.ping();
        const latency = Date.now() - startTime;
        
        if (!reachable) {
          return { success: false, error: 'Printer not reachable' };
        }
        
        await adapter.connect();
        await adapter.disconnect();
        return { success: true, latency };
      }

      return { success: false, error: 'Unknown printer type' };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * Detect local subnet
   */
  private detectSubnet(): string {
    // Try to detect the local subnet from network interfaces
    const os = require('os');
    const interfaces = os.networkInterfaces();

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        // Skip internal and non-IPv4 addresses
        if (iface.internal || iface.family !== 'IPv4') {
          continue;
        }

        // Return the first three octets
        const parts = iface.address.split('.');
        if (parts.length === 4) {
          return parts.slice(0, 3).join('.');
        }
      }
    }

    // Default to common local network
    return '192.168.1';
  }
}

export default PrinterDiscovery;
