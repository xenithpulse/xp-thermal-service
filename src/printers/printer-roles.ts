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

  return {
    ...baseRoleConfig(role, options),
    name: options.name?.trim() || `${profile.label} — ${windows.name}`,
    type: PrinterType.USB,
    printerName: windows.name,
    capabilities: roleCapabilities(role, guessPaperWidth(windows)),
    metadata: {
      role,
      ...buildHints(windows, snapshot.usbDevices)
    }
  };
}

/**
 * The same thing for a printer reached over the network.
 *
 * This did not exist, so the whole role-based flow — the one that makes the id
 * match the role, derives the capability profile, and means the operator never
 * types anything the POS depends on — was USB-only. A LAN printer had to be
 * added through the manual form, which is exactly where a mistyped id silently
 * dead-letters every ticket.
 *
 * Two things cannot be derived the way they are for USB, and both are given
 * honest defaults rather than guesses dressed up as detection:
 *
 *   - Paper width. USB reads it from the Windows model name; a network printer
 *     offers no model over a raw socket, so this takes 48 (80mm) — the common
 *     case — and lets the caller override it.
 *   - Identity breadcrumbs. There is no USB device to fingerprint, so the
 *     address is the identity. Recorded in metadata for the same purpose.
 */
export function buildNetworkRoleConfig(
  role: PrinterRoleId,
  host: string,
  port: number,
  options: { makeDefault?: boolean; name?: string; maxWidth?: number } = {}
): PrinterConfig {
  const profile = PRINTER_ROLES[role];

  return {
    ...baseRoleConfig(role, options),
    name: options.name?.trim() || `${profile.label} — ${host}`,
    type: PrinterType.NETWORK,
    host,
    port,
    capabilities: roleCapabilities(role, options.maxWidth ?? 48),
    metadata: {
      role,
      networkHost: host,
      networkPort: port
    }
  };
}

/** Fields every role config shares, whatever the transport. */
function baseRoleConfig(
  role: PrinterRoleId,
  options: { makeDefault?: boolean }
): Omit<PrinterConfig, 'type' | 'name' | 'capabilities'> {
  const profile = PRINTER_ROLES[role];
  return {
    // The role IS the id. This is the whole point of roles: the POS addresses
    // "kitchen" and never has to look anything up.
    id: profile.id,
    enabled: true,
    isDefault: options.makeDefault ?? profile.preferDefault,
    timeout: 10000,
    maxRetries: 3,
    cashDrawer: { ...profile.cashDrawer }
  };
}

/** The detected hardware profile with the role's overrides layered on top. */
function roleCapabilities(role: PrinterRoleId, maxWidth: number): PrinterCapabilities {
  return {
    maxWidth,
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
    ...PRINTER_ROLES[role].capabilities
  };
}
