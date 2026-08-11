/**
 * Printer Roles
 *
 * A till operator setting up a new printer knows one thing: what the printer is
 * for. They should not be asked to invent an id, pick a codepage, or decide
 * whether partial cut is supported.
 *
 * Choosing a role fixes all of that. The role *is* the id, so the POS can
 * always address the receipt printer as "receipt" and the kitchen printer as
 * "kitchen" without looking anything up, and the capability profile that suits
 * that job is applied automatically.
 */

import { WindowsPrinterInfo, WindowsPrintSnapshot } from './windows-printers';
import { guessPaperWidth, buildHints } from './printer-resolver';
import {
  PrinterConfig,
  PrinterType,
  PrinterCapabilities,
  CashDrawerConfig
} from '../types';

export type PrinterRoleId = 'receipt' | 'kitchen' | 'bar' | 'label';

export interface PrinterRole {
  id: PrinterRoleId;
  /** Shown on the button the user presses. */
  label: string;
  /** One line explaining what this printer will be used for. */
  description: string;
  /** Receipt printers become the service default when nothing else is set. */
  preferDefault: boolean;
  cashDrawer: CashDrawerConfig;
  /** Capability overrides layered on top of the detected hardware profile. */
  capabilities: Partial<PrinterCapabilities>;
}

export const PRINTER_ROLES: Record<PrinterRoleId, PrinterRole> = {
  receipt: {
    id: 'receipt',
    label: 'Receipt',
    description: 'Customer bills and receipts. Drives the cash drawer.',
    preferDefault: true,
    // A receipt printer is the one wired to the till, so the drawer is on by
    // default and fires automatically when a bill is printed.
    cashDrawer: { enabled: true, pin: 2, onTimeMs: 50, offTimeMs: 200, openOnPrint: true },
    capabilities: {
      supportsImage: true,
      supportsQRCode: true,
      supportsBarcode: true,
      supportsCashDrawer: true,
      supportsCut: true,
      supportsPartialCut: true
    }
  },

  kitchen: {
    id: 'kitchen',
    label: 'Kitchen (KOT)',
    description: 'Order tickets for the kitchen. Fast, text only, no drawer.',
    preferDefault: false,
    cashDrawer: { enabled: false, pin: 2, onTimeMs: 50, offTimeMs: 200, openOnPrint: false },
    capabilities: {
      // Kitchen tickets are printed under time pressure and are read from a
      // rail, so graphics are dead weight: skipping them keeps tickets fast.
      supportsImage: false,
      supportsQRCode: false,
      supportsBarcode: false,
      supportsCashDrawer: false,
      supportsCut: true,
      supportsPartialCut: true
    }
  },

  bar: {
    id: 'bar',
    label: 'Bar',
    description: 'Drink orders for the bar station.',
    preferDefault: false,
    cashDrawer: { enabled: false, pin: 2, onTimeMs: 50, offTimeMs: 200, openOnPrint: false },
    capabilities: {
      supportsImage: false,
      supportsQRCode: false,
      supportsBarcode: false,
      supportsCashDrawer: false,
      supportsCut: true,
      supportsPartialCut: true
    }
  },

  label: {
    id: 'label',
    label: 'Labels',
    description: 'Item or packaging labels.',
    preferDefault: false,
    cashDrawer: { enabled: false, pin: 2, onTimeMs: 50, offTimeMs: 200, openOnPrint: false },
    capabilities: {
      supportsImage: true,
      supportsQRCode: true,
      supportsBarcode: true,
      supportsCashDrawer: false,
      supportsCut: true,
      supportsPartialCut: false
    }
  }
};

export function isPrinterRole(value: unknown): value is PrinterRoleId {
  return typeof value === 'string' && value in PRINTER_ROLES;
}

/** The roles offered in the UI, in the order they should be shown. */
export function listRoles(): PrinterRole[] {
  return [
    PRINTER_ROLES.receipt,
    PRINTER_ROLES.kitchen,
    PRINTER_ROLES.bar,
    PRINTER_ROLES.label
  ];
}

/**
 * Build a complete, ready-to-save printer configuration from a role and a live
 * Windows queue. Everything the user was previously asked to type is derived:
 * the id comes from the role, the paper width from the model name, and the
 * identity breadcrumbs from the device currently attached.
 */
export function buildRoleConfig(
  role: PrinterRoleId,
  windows: WindowsPrinterInfo,
  snapshot: WindowsPrintSnapshot,
  options: { makeDefault?: boolean; name?: string } = {}
): PrinterConfig {
  const profile = PRINTER_ROLES[role];
  const width = guessPaperWidth(windows);

  const capabilities: PrinterCapabilities = {
    maxWidth: width,
    supportsBold: true,
    supportsUnderline: true,
    supportsBarcode: true,
    supportsQRCode: true,
    supportsImage: false,
    supportsCut: true,
    supportsPartialCut: true,
    supportsCashDrawer: false,
    supportsDensity: true,
    codepage: 0,
    ...profile.capabilities
  };

  return {
    id: profile.id,
    name: options.name?.trim() || `${profile.label} — ${windows.name}`,
    type: PrinterType.USB,
    enabled: true,
    isDefault: options.makeDefault ?? profile.preferDefault,
    printerName: windows.name,
    timeout: 10000,
    maxRetries: 3,
    capabilities,
    cashDrawer: { ...profile.cashDrawer },
    metadata: {
      role,
      ...buildHints(windows, snapshot.usbDevices)
    }
  };
}
