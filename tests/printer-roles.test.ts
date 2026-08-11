/**
 * Tests for role-based setup and the cash drawer pulse encoding.
 *
 * The point of roles is that choosing "Receipt" or "Kitchen" is the only
 * decision anyone has to make, and the id is predictable so the POS can address
 * printers without a lookup.
 */

import { buildRoleConfig, isPrinterRole, listRoles, PRINTER_ROLES } from '../src/printers/printer-roles';
import { cashDrawerPulse } from '../src/escpos/builder';
import { WindowsPrinterInfo, WindowsPrintSnapshot } from '../src/printers/windows-printers';
import { PrinterType } from '../src/types';

const windows: WindowsPrinterInfo = {
  name: 'XP-80C',
  portName: 'USB014',
  driverName: 'Generic / Text Only',
  shared: false,
  shareName: '',
  workOffline: false,
  printerStatus: 3,
  printerState: 0,
  detectedErrorState: 0,
  extendedPrinterStatus: 2,
  isDefault: false,
  isLocal: true,
  isNetwork: false
};

const snapshot: WindowsPrintSnapshot = {
  takenAt: Date.now(),
  spoolerRunning: true,
  printers: [windows],
  ports: ['USB014'],
  usbDevices: [
    {
      instanceId: 'USBPRINT\\XP\\7&1&0&USB014',
      name: 'XP-80C',
      portName: 'USB014',
      status: 'OK',
      hardwareId: 'VID_0483'
    }
  ],
  livePorts: ['USB014'],
  warnings: [],
  host: { psVersion: 5, osCaption: 'Windows 11', hasPrintManagement: true }
};

describe('printer roles', () => {
  it('uses the role as the printer id, so the POS can address it directly', () => {
    expect(buildRoleConfig('receipt', windows, snapshot).id).toBe('receipt');
    expect(buildRoleConfig('kitchen', windows, snapshot).id).toBe('kitchen');
    expect(buildRoleConfig('bar', windows, snapshot).id).toBe('bar');
  });

  it('makes a receipt printer the default and enables its cash drawer', () => {
    const cfg = buildRoleConfig('receipt', windows, snapshot);

    expect(cfg.isDefault).toBe(true);
    expect(cfg.capabilities.supportsCashDrawer).toBe(true);
    expect(cfg.cashDrawer).toMatchObject({ enabled: true, pin: 2, openOnPrint: true });
  });

  it('keeps kitchen tickets lean and drawer-free', () => {
    const cfg = buildRoleConfig('kitchen', windows, snapshot);

    expect(cfg.isDefault).toBe(false);
    expect(cfg.cashDrawer?.enabled).toBe(false);
    expect(cfg.capabilities.supportsCashDrawer).toBe(false);
    // Graphics slow a ticket down for no benefit on a kitchen rail.
    expect(cfg.capabilities.supportsImage).toBe(false);
  });

  it('derives everything else from the hardware, asking the user for nothing', () => {
    const cfg = buildRoleConfig('receipt', windows, snapshot);

    expect(cfg.type).toBe(PrinterType.USB);
    expect(cfg.printerName).toBe('XP-80C');
    expect(cfg.enabled).toBe(true);
    expect(cfg.capabilities.maxWidth).toBe(48);
    expect(cfg.timeout).toBeGreaterThan(0);
    // Breadcrumbs so the printer can be found again after it moves.
    expect(cfg.metadata).toMatchObject({
      role: 'receipt',
      windowsPort: 'USB014',
      usbHardwareId: 'VID_0483'
    });
  });

  it('reads the paper width from a 58mm model name', () => {
    const narrow = { ...windows, name: 'XP-58IIH', driverName: 'XP-58' };
    expect(buildRoleConfig('receipt', narrow, snapshot).capabilities.maxWidth).toBe(32);
  });

  it('allows the default to be forced for the first printer configured', () => {
    expect(buildRoleConfig('kitchen', windows, snapshot, { makeDefault: true }).isDefault).toBe(true);
  });

  it('produces ids that satisfy the config schema', () => {
    for (const role of listRoles()) {
      expect(role.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  it('validates role names', () => {
    expect(isPrinterRole('receipt')).toBe(true);
    expect(isPrinterRole('kitchen')).toBe(true);
    expect(isPrinterRole('nonsense')).toBe(false);
    expect(isPrinterRole(undefined)).toBe(false);
  });

  it('exposes a label and description for every role', () => {
    for (const role of Object.values(PRINTER_ROLES)) {
      expect(role.label.length).toBeGreaterThan(0);
      expect(role.description.length).toBeGreaterThan(0);
    }
  });
});

describe('cashDrawerPulse', () => {
  it('encodes ESC p m t1 t2 with 2ms units', () => {
    // 50ms -> 25 units, 200ms -> 100 units
    expect(cashDrawerPulse(2, 50, 200)).toEqual([0x1b, 0x70, 0x00, 25, 100]);
  });

  it('selects the alternate connector for pin 5', () => {
    expect(cashDrawerPulse(5, 50, 200)[2]).toBe(0x01);
  });

  it('clamps rather than wrapping past the single-byte range', () => {
    // 2000ms would be 1000 units; wrapping would produce a uselessly short
    // pulse instead of the longest one available.
    const long = cashDrawerPulse(2, 2000, 2000);
    expect(long[3]).toBe(255);
    expect(long[4]).toBe(255);

    const short = cashDrawerPulse(2, 0, 0);
    expect(short[3]).toBeGreaterThanOrEqual(1);
    expect(short[4]).toBeGreaterThanOrEqual(1);
  });

  it('falls back to a sane pulse for nonsense input', () => {
    const pulse = cashDrawerPulse(2, NaN as unknown as number, undefined);
    expect(pulse).toHaveLength(5);
    expect(pulse[3]).toBeGreaterThan(0);
  });
});
