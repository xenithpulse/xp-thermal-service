/**
 * Tests for the decision logic that decides whether a printer is usable, which
 * Windows queue a config refers to, and what to repair.
 *
 * The fixtures are real values captured from a working machine — in particular
 * the "Generic / Text Only" queue that reports WorkOffline=true while printing
 * perfectly, which is the case that used to break everything.
 */

import {
  classifyStatus,
  resolveQueue,
  planHealing,
  normalizeQueueName,
  thermalScore,
  isVirtualQueue,
  guessPaperWidth,
  buildHints,
  readHints
} from '../src/printers/printer-resolver';
import {
  WindowsPrinterInfo,
  WindowsPrintSnapshot,
  UsbPrintDevice
} from '../src/printers/windows-printers';
import { PrinterStatus } from '../src/types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function printer(overrides: Partial<WindowsPrinterInfo> = {}): WindowsPrinterInfo {
  return {
    name: 'Generic / Text Only',
    portName: 'USB011',
    driverName: 'Generic / Text Only',
    shared: false,
    shareName: '',
    workOffline: false,
    printerStatus: 3,
    printerState: 0,
    detectedErrorState: 0,
    extendedPrinterStatus: 2,
    isDefault: true,
    isLocal: true,
    isNetwork: false,
    ...overrides
  };
}

function device(port: string, overrides: Partial<UsbPrintDevice> = {}): UsbPrintDevice {
  return {
    instanceId: `USBPRINT\\UnknownPrinter\\7&1&0&${port}`,
    name: 'XP-80C',
    portName: port,
    status: 'OK',
    hardwareId: 'UnknownPrinter',
    ...overrides
  };
}

function snapshot(overrides: Partial<WindowsPrintSnapshot> = {}): WindowsPrintSnapshot {
  const usbDevices = overrides.usbDevices ?? [];
  return {
    takenAt: Date.now(),
    spoolerRunning: true,
    printers: overrides.printers ?? [printer()],
    ports: ['USB011', 'USB014'],
    usbDevices,
    livePorts:
      overrides.livePorts ??
      usbDevices.map((d) => d.portName).filter((p): p is string => !!p),
    warnings: [],
    host: { psVersion: 5, osCaption: 'Windows 11 Pro', hasPrintManagement: true },
    ...overrides
  };
}

// ─── classifyStatus ──────────────────────────────────────────────────────────

describe('classifyStatus', () => {
  it('reports ONLINE when WorkOffline is set but nothing corroborates it', () => {
    // The exact reading from the reference machine: the flag is stale and the
    // printer works. This is the regression that mattered most.
    const p = printer({ workOffline: true });
    const snap = snapshot({ printers: [p], usbDevices: [device('USB011')] });

    const verdict = classifyStatus(p, snap);

    expect(verdict.status).toBe(PrinterStatus.ONLINE);
    expect(verdict.printable).toBe(true);
    expect(verdict.healable).toBe(true);
    expect(verdict.reason).toMatch(/stale/i);
  });

  it('reports OFFLINE when WorkOffline agrees with the device being absent', () => {
    const p = printer({ workOffline: true });
    const verdict = classifyStatus(p, snapshot({ printers: [p], usbDevices: [] }));

    expect(verdict.status).toBe(PrinterStatus.OFFLINE);
    expect(verdict.printable).toBe(false);
    expect(verdict.signals.devicePresent).toBe(false);
  });

  it('stays ONLINE when the device is unseen but Windows reports no fault', () => {
    // A vendor driver that does not enumerate under USBPRINT must not be
    // declared dead purely because our probe cannot see it.
    const p = printer({ workOffline: false });
    const verdict = classifyStatus(p, snapshot({ printers: [p], usbDevices: [] }));

    expect(verdict.status).toBe(PrinterStatus.ONLINE);
    expect(verdict.printable).toBe(true);
  });

  it('detects a USB port migration and names the new port', () => {
    const p = printer({ portName: 'USB011', workOffline: true });
    const snap = snapshot({ printers: [p], usbDevices: [device('USB014')] });

    const verdict = classifyStatus(p, snap);

    expect(verdict.status).toBe(PrinterStatus.OFFLINE);
    expect(verdict.signals.portMigrated).toBe(true);
    expect(verdict.signals.suggestedPort).toBe('USB014');
    expect(verdict.healable).toBe(true);
  });

  it('uses the remembered hardware id to pick the right port on a hub', () => {
    const p = printer({ portName: 'USB011' });
    const snap = snapshot({
      printers: [p],
      usbDevices: [
        device('USB014', { hardwareId: 'OtherPrinter', name: 'Other' }),
        device('USB016', { hardwareId: 'MyPrinterHW', name: 'Mine' })
      ]
    });

    const verdict = classifyStatus(p, snap, { usbHardwareId: 'MyPrinterHW' });

    expect(verdict.signals.suggestedPort).toBe('USB016');
  });

  it('refuses to guess between identical printers it cannot tell apart', () => {
    const receipt = printer({ name: 'Receipt', portName: 'USB011' });
    const kitchen = printer({ name: 'Kitchen', portName: 'USB012' });
    const snap = snapshot({
      printers: [receipt, kitchen],
      usbDevices: [device('USB014', { name: 'X' }), device('USB015', { name: 'X' })]
    });

    const verdict = classifyStatus(receipt, snap);

    // Two candidates, nothing to distinguish them: sending order tickets to the
    // wrong station is worse than asking a human.
    expect(verdict.signals.suggestedPort).toBeUndefined();
    expect(verdict.healable).toBe(false);
  });

  it('reports real faults ahead of everything else', () => {
    const snap = snapshot({ usbDevices: [device('USB011')] });

    expect(
      classifyStatus(printer({ printerState: 16, detectedErrorState: 4 }), snap).status
    ).toBe(PrinterStatus.PAPER_OUT);

    expect(
      classifyStatus(printer({ printerState: 0x00400000 }), snap).status
    ).toBe(PrinterStatus.COVER_OPEN);

    expect(
      classifyStatus(printer({ printerState: 8, detectedErrorState: 8 }), snap).status
    ).toBe(PrinterStatus.ERROR);
  });

  it('treats a genuinely offline network queue as offline', () => {
    // The Canon WSD queue from the reference machine.
    const canon = printer({
      name: 'Canon G3020 series',
      portName: 'WSD-3655b894',
      driverName: 'Canon G3020 series',
      printerStatus: 1,
      printerState: 128,
      detectedErrorState: 9,
      extendedPrinterStatus: 7,
      isDefault: false
    });

    expect(classifyStatus(canon, snapshot({ printers: [canon] })).status).toBe(
      PrinterStatus.OFFLINE
    );
  });

  it('does not downgrade unknown status codes to an error', () => {
    // Cheap thermal units report PrinterStatus 1 ("Other") or 2 ("Unknown")
    // while working perfectly.
    const snap = snapshot({ usbDevices: [device('USB011')] });
    expect(classifyStatus(printer({ printerStatus: 1 }), snap).status).toBe(PrinterStatus.ONLINE);
    expect(classifyStatus(printer({ printerStatus: 2 }), snap).status).toBe(PrinterStatus.ONLINE);
  });

  it('flags a missing queue and a stopped spooler distinctly', () => {
    expect(classifyStatus(undefined, snapshot()).status).toBe(PrinterStatus.OFFLINE);
    expect(classifyStatus(printer(), snapshot({ spoolerRunning: false })).status).toBe(
      PrinterStatus.ERROR
    );
  });
});

// ─── resolveQueue ────────────────────────────────────────────────────────────

describe('resolveQueue', () => {
  it('matches an exact name without adopting anything', () => {
    const p = printer();
    const result = resolveQueue('Generic / Text Only', snapshot({ printers: [p] }));

    expect(result.exact).toBe(true);
    expect(result.match?.name).toBe('Generic / Text Only');
    expect(result.autoAdopt).toBe(false);
  });

  it('follows a queue that a driver reinstall renamed to "(Copy 1)"', () => {
    const renamed = printer({ name: 'Generic / Text Only (Copy 1)', portName: 'USB014' });
    const snap = snapshot({ printers: [renamed], usbDevices: [device('USB014')] });

    const result = resolveQueue('Generic / Text Only', snap, {
      windowsDriver: 'Generic / Text Only',
      windowsPort: 'USB011'
    });

    expect(result.autoAdopt).toBe(true);
    expect(result.match?.name).toBe('Generic / Text Only (Copy 1)');
  });

  it('never auto-adopts a queue another configured printer already owns', () => {
    const renamed = printer({ name: 'Generic / Text Only (Copy 1)', portName: 'USB014' });
    const snap = snapshot({ printers: [renamed], usbDevices: [device('USB014')] });

    const result = resolveQueue('Generic / Text Only', snap, {}, [
      'Generic / Text Only (Copy 1)'
    ]);

    expect(result.autoAdopt).toBe(false);
    expect(result.match?.name).toBe('Generic / Text Only (Copy 1)');
    expect(result.reason).toMatch(/another configured printer/i);
  });

  it('ignores virtual queues entirely', () => {
    const pdf = printer({
      name: 'Microsoft Print to PDF',
      driverName: 'Microsoft Print To PDF',
      portName: 'PORTPROMPT:'
    });

    const result = resolveQueue('XP-80C', snapshot({ printers: [pdf] }));
    expect(result.match).toBeNull();
  });

  it('does not adopt on a weak, ambiguous match', () => {
    const a = printer({ name: 'Star TSP100', driverName: 'Star TSP100' });
    const b = printer({ name: 'Star TSP143', driverName: 'Star TSP143' });
    const result = resolveQueue('Star TSP654', snapshot({ printers: [a, b] }));

    expect(result.autoAdopt).toBe(false);
  });
});

// ─── planHealing ─────────────────────────────────────────────────────────────

describe('planHealing', () => {
  it('repoints the port before touching anything else', () => {
    const p = printer({ portName: 'USB011', workOffline: true });
    const snap = snapshot({ printers: [p], usbDevices: [device('USB014')] });
    const plan = planHealing(p.name, p, classifyStatus(p, snap), snap);

    expect(plan.actions[0]).toMatchObject({ kind: 'setPort', portName: 'USB014' });
  });

  it('does not try to clear the offline flag on an unplugged printer', () => {
    // Windows re-sets the flag immediately, so retrying just churns the spooler.
    const p = printer({ workOffline: true });
    const snap = snapshot({ printers: [p], usbDevices: [] });
    const plan = planHealing(p.name, p, classifyStatus(p, snap), snap);

    expect(plan.actions).toHaveLength(0);
    expect(plan.manualHint).toMatch(/cable/i);
  });

  it('offers no automated repair for paper-out, only instructions', () => {
    const p = printer({ printerState: 16, detectedErrorState: 4 });
    const snap = snapshot({ printers: [p], usbDevices: [device('USB011')] });
    const plan = planHealing(p.name, p, classifyStatus(p, snap), snap);

    expect(plan.actions).toHaveLength(0);
    expect(plan.manualHint).toMatch(/paper/i);
  });

  it('restarts the spooler when it is not running', () => {
    const p = printer();
    const snap = snapshot({ printers: [p], spoolerRunning: false });
    const plan = planHealing(p.name, p, classifyStatus(p, snap), snap);

    expect(plan.actions).toEqual([expect.objectContaining({ kind: 'restartSpooler' })]);
  });

  it('searches for a replacement when the queue is gone', () => {
    const snap = snapshot({ printers: [] });
    const plan = planHealing('XP-80C', undefined, classifyStatus(undefined, snap), snap);

    expect(plan.actions).toEqual([expect.objectContaining({ kind: 'rebind' })]);
  });
});

// ─── Classification helpers ──────────────────────────────────────────────────

describe('printer identification', () => {
  it('strips duplicate suffixes when normalising names', () => {
    expect(normalizeQueueName('XP-80C (Copy 1)')).toBe(normalizeQueueName('XP-80C'));
    expect(normalizeQueueName('XP-80C (1)')).toBe(normalizeQueueName('XP-80C'));
    expect(normalizeQueueName('XP-80C - Copy')).toBe(normalizeQueueName('XP-80C'));
  });

  it('recognises thermal printers across vendors', () => {
    const thermalNames = [
      'XP-80C', 'POS-58', 'EPSON TM-T88V', 'Star TSP143', 'Bixolon SRP-350',
      'Rongta RP80', 'Gprinter GP-80250', 'Munbyn ITPP047', 'Generic / Text Only'
    ];

    for (const name of thermalNames) {
      const score = thermalScore(printer({ name, driverName: name, portName: 'USB001' }));
      expect({ name, score }).toMatchObject({ score: expect.any(Number) });
      expect(score).toBeGreaterThanOrEqual(50);
    }
  });

  it('scores office printers below the recommendation threshold', () => {
    const office = printer({
      name: 'HP LaserJet Pro M15w',
      driverName: 'HP LaserJet Pro M15w PCL-6',
      portName: 'WSD-abc'
    });
    expect(thermalScore(office)).toBeLessThan(50);
  });

  it('treats document writers as virtual, never as printers to configure', () => {
    for (const name of ['Microsoft Print to PDF', 'Microsoft XPS Document Writer', 'Fax', 'OneNote (Desktop)']) {
      expect(isVirtualQueue(printer({ name, driverName: name }))).toBe(true);
      expect(thermalScore(printer({ name, driverName: name }))).toBe(0);
    }
  });

  it('infers paper width from the model name', () => {
    expect(guessPaperWidth(printer({ name: 'XP-58IIH', driverName: 'XP-58' }))).toBe(32);
    expect(guessPaperWidth(printer({ name: 'XP-80C', driverName: 'XP-80' }))).toBe(48);
    expect(guessPaperWidth(printer({ name: 'Unknown Printer', driverName: 'x' }))).toBe(48);
  });

  it('round-trips identity hints through metadata', () => {
    const p = printer({ portName: 'USB014', driverName: 'XP Driver' });
    const hints = buildHints(p, [device('USB014', { hardwareId: 'VID_1234' })]);

    expect(hints).toMatchObject({
      windowsPort: 'USB014',
      windowsDriver: 'XP Driver',
      usbHardwareId: 'VID_1234'
    });
    expect(readHints({ ...hints })).toMatchObject(hints);
    expect(readHints(undefined)).toEqual({
      windowsPort: undefined,
      windowsDriver: undefined,
      usbHardwareId: undefined,
      lastKnownGoodAt: undefined
    });
  });
});
