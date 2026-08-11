/**
 * Printer Discovery
 *
 * Finds printers the user could add, ranks them by how likely they are to be
 * an ESC/POS receipt printer, and hands back a ready-to-save configuration so
 * adding one is a single click rather than a form full of guesses.
 */

import { USBPrinterAdapter } from './usb-adapter';
import { NetworkPrinterAdapter } from './network-adapter';
import { getWindowsPrintSystem, WindowsPrintSystem } from './windows-printers';
import {
  thermalScore,
  isVirtualQueue,
  guessPaperWidth,
  classifyStatus,
  buildHints
} from './printer-resolver';
import { PrinterType, PrinterConfig, PrinterCapabilities, PrinterStatus } from '../types';
import { Logger } from '../utils/logger';

/**
 * A USB printing device that Windows can see but has no print queue for.
 *
 * This is the most common "the service doesn't detect my printer" report on a
 * fresh machine: the printer is plugged in and enumerated, but its driver was
 * never installed, so there is nothing to print to. Without surfacing it, the
 * discovery list is simply empty and the cause is invisible.
 */
export interface UninstalledPrinterDevice {
  deviceName: string;
  portName: string | null;
  hardwareId: string;
  problem: string;
  suggestion: string;
}

export interface DiscoveredPrinter {
  type: PrinterType;
  name: string;
  connection: {
    vendorId?: number;
    productId?: number;
    host?: string;
    port?: number;
    portName?: string;
    driverName?: string;
  };
  /** 0–100: how confident we are this is a thermal receipt printer. */
  thermalScore: number;
  /** True when we would put this at the top of the list. */
  recommended: boolean;
  /** Live status, so the user can see it works before adding it. */
  status: PrinterStatus;
  statusReason: string;
  /** Set when this printer is already in the service configuration. */
  alreadyConfiguredAs?: string;
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
  'XPrinter': {
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
    supportsQRCode: true,
    supportsImage: true,
    supportsCut: true,
    supportsPartialCut: false,
    supportsCashDrawer: true,
  }
};

/** Identify the manufacturer from a queue or driver name. */
function detectVendor(haystack: string): string {
  const s = haystack.toLowerCase();
  if (s.includes('epson')) return 'Epson';
  if (s.includes('star')) return 'Star Micronics';
  if (s.includes('citizen')) return 'Citizen';
  if (s.includes('bixolon') || s.includes('srp-')) return 'Bixolon';
  if (s.includes('zebra')) return 'Zebra';
  if (s.includes('xprinter') || /\bxp-?\d/.test(s)) return 'XPrinter';
  if (s.includes('rongta') || /\brp-?\d{2}/.test(s)) return 'Rongta';
  if (s.includes('gprinter') || /\bgp-?\d{2}/.test(s)) return 'Gprinter';
  if (s.includes('munbyn')) return 'Munbyn';
  return 'Generic';
}

/** Build a stable, schema-valid printer id from a Windows queue name. */
function makePrinterId(name: string, taken: Set<string>): string {
  const base =
    name
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase()
      .slice(0, 40) || 'printer';

  if (!taken.has(base)) return base;

  for (let i = 2; i < 100; i++) {
    const candidate = `${base}_${i}`.slice(0, 50);
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`.slice(0, 50);
}

export class PrinterDiscovery {
  private logger: Logger;
  private printSystem: WindowsPrintSystem;

  constructor(logger: Logger, printSystem?: WindowsPrintSystem) {
    this.logger = logger;
    this.printSystem = printSystem ?? getWindowsPrintSystem();
  }

  /**
   * Discover all available printers (USB and network)
   */
  async discoverAll(options?: {
    scanNetwork?: boolean;
    networkSubnet?: string;
    networkPorts?: number[];
    timeout?: number;
    /** Ids/queue names already configured, so they can be flagged. */
    existing?: Array<{ id: string; printerName?: string }>;
    /** Include virtual queues such as Microsoft Print to PDF. */
    includeVirtual?: boolean;
  }): Promise<DiscoveredPrinter[]> {
    const printers: DiscoveredPrinter[] = [];

    // Discover USB/local printers
    const usbPrinters = await this.discoverUSB(options);
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

    // Best candidates first: recommended, then by confidence, then by name.
    printers.sort((a, b) => {
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      if (b.thermalScore !== a.thermalScore) return b.thermalScore - a.thermalScore;
      return a.name.localeCompare(b.name);
    });

    return printers;
  }

  /**
   * Discover locally installed Windows print queues.
   */
  async discoverUSB(options?: {
    existing?: Array<{ id: string; printerName?: string }>;
    includeVirtual?: boolean;
  }): Promise<DiscoveredPrinter[]> {
    const printers: DiscoveredPrinter[] = [];

    try {
      const snapshot = await this.printSystem.getSnapshot();

      // One Windows queue can legitimately back several configured printers
      // (a receipt and a kitchen entry sharing one device), so collect them all
      // rather than letting the last one win.
      const configuredByName = new Map<string, string[]>();
      for (const entry of options?.existing ?? []) {
        if (!entry.printerName) continue;
        const key = entry.printerName.trim().toLowerCase();
        configuredByName.set(key, [...(configuredByName.get(key) ?? []), entry.id]);
      }
      const takenIds = new Set((options?.existing ?? []).map((e) => e.id));

      for (const windows of snapshot.printers) {
        if (!options?.includeVirtual && isVirtualQueue(windows)) {
          continue;
        }

        const score = thermalScore(windows);
        const verdict = classifyStatus(windows, snapshot);
        const vendor = detectVendor(`${windows.name} ${windows.driverName}`);
        const capabilities = PRINTER_CAPABILITIES[vendor] || PRINTER_CAPABILITIES['Generic'];
        const id = makePrinterId(windows.name, takenIds);
        takenIds.add(id);

        printers.push({
          type: PrinterType.USB,
          name: windows.name,
          connection: {
            portName: windows.portName,
            driverName: windows.driverName
          },
          thermalScore: score,
          recommended: score >= 50,
          status: verdict.status,
          statusReason: verdict.reason,
          alreadyConfiguredAs: configuredByName.get(windows.name.trim().toLowerCase())?.join(', '),
          suggestedConfig: {
            id,
            name: windows.name,
            type: PrinterType.USB,
            enabled: true,
            printerName: windows.name,
            timeout: 10000,
            maxRetries: 3,
            capabilities: {
              ...capabilities,
              maxWidth: guessPaperWidth(windows),
              codepage: 0,
              supportsDensity: true
            } as PrinterCapabilities,
            // Breadcrumbs so the service can follow this printer if it is later
            // moved to a different USB port or the queue is renamed.
            metadata: { ...buildHints(windows, snapshot.usbDevices) }
          }
        });
      }

      this.logger.info(
        {
          total: printers.length,
          recommended: printers.filter((p) => p.recommended).length,
          attachedUsbDevices: snapshot.usbDevices.length
        },
        `Discovered ${printers.length} local printer(s)`
      );
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

      const taken = new Set<string>();

      for (const printer of networkPrinters) {
        const id = makePrinterId(`net_${printer.host}_${printer.port}`, taken);
        taken.add(id);

        printers.push({
          type: PrinterType.NETWORK,
          name: `Network Printer at ${printer.host}:${printer.port}`,
          connection: {
            host: printer.host,
            port: printer.port
          },
          // A device answering on the raw-print port is almost certainly a
          // receipt printer, but we cannot inspect the model over TCP.
          thermalScore: 65,
          recommended: true,
          status: PrinterStatus.ONLINE,
          statusReason: `Responding on ${printer.host}:${printer.port}`,
          suggestedConfig: {
            id,
            name: `Network Printer (${printer.host})`,
            type: PrinterType.NETWORK,
            enabled: true,
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
        const adapter = new USBPrinterAdapter(config, this.printSystem);
        await adapter.connect();
        const latency = Date.now() - startTime;
        const connected = adapter.isConnected();
        const reason = adapter.verdict?.reason;
        await adapter.disconnect();

        return connected
          ? { success: true, latency }
          : { success: false, error: reason || 'Printer is not ready' };
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
   * Pick the printers a first-time setup should configure automatically:
   * every recommended thermal queue that is not already configured.
   */
  async suggestAutoSetup(
    existing: Array<{ id: string; printerName?: string }>
  ): Promise<DiscoveredPrinter[]> {
    const discovered = await this.discoverUSB({ existing });
    return discovered.filter((p) => p.recommended && !p.alreadyConfiguredAs);
  }

  /**
   * Find USB printing devices that are attached but have no Windows print queue.
   *
   * A device shows up here when the cable is in and Windows enumerated it, but
   * no driver was installed — so nothing can be printed to it and it is absent
   * from every printer list. Reporting it turns a baffling empty discovery
   * result into a specific, fixable instruction.
   */
  async findUninstalledDevices(): Promise<UninstalledPrinterDevice[]> {
    try {
      const snapshot = await this.printSystem.getSnapshot();

      // Ports already backed by a configured queue are, by definition, installed.
      const portsWithQueue = new Set(
        snapshot.printers.map((p) => p.portName).filter(Boolean)
      );

      return snapshot.usbDevices
        .filter((device) => !device.portName || !portsWithQueue.has(device.portName))
        .map((device) => ({
          deviceName: device.name || 'USB printer',
          portName: device.portName,
          hardwareId: device.hardwareId,
          problem: device.portName
            ? `A USB printer is connected on ${device.portName}, but Windows has no print queue using that port.`
            : 'A USB printer is connected, but Windows has not assigned it a printer port.',
          suggestion:
            'Install the printer driver in Windows (Settings > Bluetooth & devices > Printers & scanners > ' +
            'Add device). Most ESC/POS receipt printers also work with the built-in "Generic / Text Only" driver. ' +
            'Once a queue exists it will appear here automatically.'
        }));
    } catch (error) {
      this.logger.warn({ error }, 'Could not check for uninstalled printer devices');
      return [];
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
